import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

describe('schema', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.drop(); });

  const q = (sql: string, params: unknown[] = []) => t.db.query(sql, params);
  const user = async (name = 'alice') =>
    (await q('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id', [name, 'h'])).rows[0].id as string;
  let n = 0;
  const project = async (owner: string) => {
    n++;
    return (await q(
      'INSERT INTO projects (owner_id, name, ro_enc, rw_enc, ro_hash, rw_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [owner, 'P' + n, 'e', 'e', Buffer.from('ro' + n), Buffer.from('rw' + n)],
    )).rows[0].id as string;
  };
  const change = async (pid: string, seq: number, extra: Record<string, unknown> = {}) =>
    (await q(
      `INSERT INTO changes (project_id, seq, actor_type, actor_name, kind, summary, target_seq)
       VALUES ($1, $2, 'password', '', $3, 's', $4) RETURNING id`,
      [pid, seq, extra.kind ?? 'edit', extra.target ?? null],
    )).rows[0].id as string;

  it('matches the committed schema snapshot', async () => {
    const { rows } = await q(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
      ORDER BY table_name, ordinal_position`);
    const text = rows
      .map((r) => `${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable === 'NO' ? 'not null' : 'null'}${r.column_default ? ' default ' + r.column_default : ''}`)
      .join('\n') + '\n';
    await expect(text).toMatchFileSnapshot('./__snapshots__/schema.txt');
  });

  it('generates uuidv7 ids for every table that has one', async () => {
    const u = await user();
    const p = await project(u);
    const c = await change(p, 1);
    for (const id of [u, p, c]) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  describe('users', () => {
    it('rejects bad usernames (uppercase, too short, bad characters)', async () => {
      for (const bad of ['Alice', 'ab', 'a b c', 'x'.repeat(33), 'name@mail']) {
        await expect(user(bad), bad).rejects.toThrow(/users_username_format/);
      }
    });
    it('rejects a duplicate username', async () => {
      await user('dupe');
      await expect(user('dupe')).rejects.toThrow(/users_username_key/);
    });
    it('rejects an unknown rollback policy', async () => {
      await expect(q("INSERT INTO users (username, password_hash, default_rollback_policy) VALUES ('polu', 'h', 'anyone')")).rejects.toThrow(/users_policy_valid/);
    });
  });

  describe('projects', () => {
    it('rejects an empty or whitespace name and an over-long name', async () => {
      const u = await user('pj1');
      for (const bad of ['', '   ', 'x'.repeat(101)]) {
        await expect(q('INSERT INTO projects (owner_id, name, ro_enc, rw_enc, ro_hash, rw_hash) VALUES ($1, $2, $3, $3, $4, $5)', [u, bad, 'e', Buffer.from('a' + bad.length), Buffer.from('b' + bad.length)])).rejects.toThrow(/projects_name_valid/);
      }
    });
    it('keeps password hashes unique', async () => {
      const u = await user('pj2');
      await project(u);
      await expect(q('INSERT INTO projects (owner_id, name, ro_enc, rw_enc, ro_hash, rw_hash) VALUES ($1, $2, $3, $3, $4, $5)', [u, 'x', 'e', Buffer.from('ro' + n), Buffer.from('other')])).rejects.toThrow(/projects_ro_hash_key/);
    });
    it('cannot exist without an owner', async () => {
      await expect(q("INSERT INTO projects (owner_id, name, ro_enc, rw_enc, ro_hash, rw_hash) VALUES (uuidv7(), 'x', 'e', 'e', 'a', 'b')")).rejects.toThrow(/foreign key/);
    });
  });

  describe('nodes', () => {
    it('accepts .md, .yml, .yaml files (any case) and dirs', async () => {
      const p = await project(await user('nd1'));
      for (const path of ['a.md', 'b/c.YML', 'd.yaml', 'Notes.MD']) await q("INSERT INTO nodes (project_id, path, kind, content) VALUES ($1, $2, 'file', 'x')", [p, path]);
      await q("INSERT INTO nodes (project_id, path, kind) VALUES ($1, 'folder', 'dir')", [p]);
    });
    it('rejects other file types', async () => {
      const p = await project(await user('nd2'));
      for (const path of ['a.txt', 'b.md.exe', 'c', 'd.mdx']) await expect(q("INSERT INTO nodes (project_id, path, kind) VALUES ($1, $2, 'file')", [p, path]), path).rejects.toThrow(/nodes_file_extension/);
    });
    it('rejects a folder named like a file', async () => {
      const p = await project(await user('nd2b'));
      for (const path of ['notes.md', 'a/b.YML', 'x.yaml']) await expect(q("INSERT INTO nodes (project_id, path, kind) VALUES ($1, $2, 'dir')", [p, path]), path).rejects.toThrow(/nodes_dir_not_file_name/);
      await q("INSERT INTO nodes (project_id, path, kind) VALUES ($1, 'notes.d', 'dir')", [p]);
    });
    it('rejects a directory with content', async () => {
      const p = await project(await user('nd3'));
      await expect(q("INSERT INTO nodes (project_id, path, kind, content) VALUES ($1, 'd', 'dir', 'x')", [p])).rejects.toThrow(/nodes_dir_has_no_content/);
    });
    it('keeps paths unique per project but allows the same path in another project', async () => {
      const u = await user('nd4');
      const [p1, p2] = [await project(u), await project(u)];
      await q("INSERT INTO nodes (project_id, path, kind) VALUES ($1, 'x.md', 'file')", [p1]);
      await expect(q("INSERT INTO nodes (project_id, path, kind) VALUES ($1, 'x.md', 'file')", [p1])).rejects.toThrow(/nodes_pkey/);
      await q("INSERT INTO nodes (project_id, path, kind) VALUES ($1, 'x.md', 'file')", [p2]);
    });
    it('sorts paths by byte order (uppercase first)', async () => {
      const p = await project(await user('nd5'));
      for (const path of ['b.md', 'B.md', 'a.md']) await q("INSERT INTO nodes (project_id, path, kind) VALUES ($1, $2, 'file')", [p, path]);
      const { rows } = await q('SELECT path FROM nodes WHERE project_id = $1 ORDER BY path', [p]);
      expect(rows.map((r) => r.path)).toEqual(['B.md', 'a.md', 'b.md']);
    });
  });

  describe('changes', () => {
    it('keeps seq unique per project and positive', async () => {
      const p = await project(await user('ch1'));
      await change(p, 1);
      await expect(change(p, 1)).rejects.toThrow(/changes_project_id_seq_key/);
      await expect(change(p, 0)).rejects.toThrow(/changes_seq_positive/);
    });
    it('requires target_seq exactly for rollbacks', async () => {
      const p = await project(await user('ch2'));
      await expect(change(p, 1, { kind: 'rollback' })).rejects.toThrow(/changes_target_only_for_rollback/);
      await expect(change(p, 2, { kind: 'edit', target: 1 })).rejects.toThrow(/changes_target_only_for_rollback/);
      await change(p, 3, { kind: 'rollback', target: 1 });
    });
    it('rejects an unknown kind or actor type', async () => {
      const p = await project(await user('ch3'));
      await expect(change(p, 1, { kind: 'hack' })).rejects.toThrow(/changes_kind_valid/);
      await expect(q("INSERT INTO changes (project_id, seq, actor_type, kind, summary) VALUES ($1, 1, 'robot', 'edit', 's')", [p])).rejects.toThrow(/changes_actor_type_valid/);
    });
  });

  describe('change_files', () => {
    const file = (c: string, action: string, before: string | null, after: string | null) =>
      q("INSERT INTO change_files (change_id, path, kind, action, before, after) VALUES ($1, 'a.md', 'file', $2, $3, $4)", [c, action, before, after]);

    it('accepts the three valid shapes', async () => {
      const p = await project(await user('cf1'));
      await file(await change(p, 1), 'created', null, 'new');
      await file(await change(p, 2), 'updated', 'old', 'new');
      await file(await change(p, 3), 'deleted', 'old', null);
    });
    it('rejects shapes that contradict the action', async () => {
      const p = await project(await user('cf2'));
      const c = await change(p, 1);
      await expect(file(c, 'created', 'old', 'new')).rejects.toThrow(/change_files_action_shape/);
      await expect(file(c, 'deleted', null, null)).rejects.toThrow(/change_files_action_shape/);
      await expect(file(c, 'updated', null, 'new')).rejects.toThrow(/change_files_action_shape/);
      await expect(file(c, 'moved', 'a', 'b')).rejects.toThrow(/change_files_action_shape/);
    });
    it('keeps an empty-string file distinct from "no content" (NULL)', async () => {
      const p = await project(await user('cf3'));
      await file(await change(p, 1), 'created', null, ''); // creating an empty file is valid
    });
  });

  describe('deleting a project', () => {
    it('removes its nodes, changes and change files, and nothing of other projects', async () => {
      const u = await user('del1');
      const [gone, kept] = [await project(u), await project(u)];
      for (const p of [gone, kept]) {
        await q("INSERT INTO nodes (project_id, path, kind) VALUES ($1, 'a.md', 'file')", [p]);
        const c = await change(p, 1);
        await q("INSERT INTO change_files (change_id, path, kind, action, before, after) VALUES ($1, 'a.md', 'file', 'created', NULL, '')", [c]);
      }
      await q('DELETE FROM projects WHERE id = $1', [gone]);
      const count = async (table: string) => Number((await q(`SELECT count(*) FROM ${table}`)).rows[0].count);
      expect(await q('SELECT 1 FROM nodes WHERE project_id = $1', [gone])).toMatchObject({ rowCount: 0 });
      expect(await q('SELECT 1 FROM changes WHERE project_id = $1', [gone])).toMatchObject({ rowCount: 0 });
      expect(await q('SELECT 1 FROM nodes WHERE project_id = $1', [kept])).toMatchObject({ rowCount: 1 });
      expect(await q('SELECT 1 FROM changes WHERE project_id = $1', [kept])).toMatchObject({ rowCount: 1 });
      // change_files of the deleted project are gone too: every remaining row belongs to a surviving change
      const orphans = await q('SELECT 1 FROM change_files cf LEFT JOIN changes c ON c.id = cf.change_id WHERE c.id IS NULL');
      expect(orphans.rowCount).toBe(0);
      expect(await count('change_files')).toBeGreaterThanOrEqual(1);
    });
  });
});
