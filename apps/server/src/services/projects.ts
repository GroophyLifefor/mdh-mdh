import type { Ctx } from '../context';
import { decrypt, encrypt, generateProjectPassword, lookupHash, type Mode } from '../crypto';
import { withTx } from '../db';
import { notFound, tooManyRequests } from '../errors';
import { recordChange } from './history';
import { UUID_RE, type Policy, type ProjectRow } from './access';
import type { User } from './auth';

export type ProjectInfo = { id: string; name: string; rollbackPolicy: Policy; updatedAt: string };

export const toInfo = (p: Pick<ProjectRow, 'id' | 'name' | 'rollback_policy' | 'updated_at'>): ProjectInfo => ({
  id: p.id, name: p.name, rollbackPolicy: p.rollback_policy, updatedAt: p.updated_at.toISOString(),
});

const aad = (projectId: string, mode: Mode) => `project:${projectId}:${mode}`;

export async function listProjects(ctx: Ctx, user: User): Promise<ProjectInfo[]> {
  const { rows } = await ctx.db.query<ProjectRow>(
    'SELECT id, name, rollback_policy, updated_at FROM projects WHERE owner_id = $1 ORDER BY updated_at DESC, id DESC',
    [user.id],
  );
  return rows.map(toInfo);
}

/** New project: random passwords, the owner's default rollback policy, and a first change that creates readme.md. */
export async function createProject(ctx: Ctx, user: User, name: string): Promise<ProjectInfo> {
  return withTx(ctx.db, async (tx) => {
    const id = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
    const pw = { ro: generateProjectPassword('ro'), rw: generateProjectPassword('rw') };
    const { rows: [p] } = await tx.query<ProjectRow>(
      `INSERT INTO projects (id, owner_id, name, ro_enc, rw_enc, ro_hash, rw_hash, rollback_policy, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING id, name, rollback_policy, updated_at`,
      [id, user.id, name, encrypt(ctx.keys, pw.ro, aad(id, 'ro')), encrypt(ctx.keys, pw.rw, aad(id, 'rw')),
        lookupHash(ctx.keys, pw.ro), lookupHash(ctx.keys, pw.rw), user.defaultRollbackPolicy, ctx.now()],
    );
    const readme = `# ${name}\n\nWelcome! Create files on the left, or drop .md and .yml files into the tree.\n`;
    await tx.query("INSERT INTO nodes (project_id, path, kind, content, updated_at) VALUES ($1, 'readme.md', 'file', $2, $3)", [id, readme, ctx.now()]);
    await recordChange(ctx, tx, id, { type: 'user', userId: user.id, name: user.username }, {
      kind: 'create', summary: 'created readme.md',
      files: [{ path: 'readme.md', kind: 'file', action: 'created', before: null, after: readme }],
    });
    const { rows: [fresh] } = await tx.query<ProjectRow>('SELECT id, name, rollback_policy, updated_at FROM projects WHERE id = $1', [p!.id]);
    return toInfo(fresh!);
  });
}

export async function updateSettings(ctx: Ctx, projectId: string, patch: { rollbackPolicy?: Policy }): Promise<ProjectInfo> {
  const { rows } = await ctx.db.query<ProjectRow>(
    `UPDATE projects SET rollback_policy = COALESCE($2, rollback_policy) WHERE id = $1
     RETURNING id, name, rollback_policy, updated_at`,
    [projectId, patch.rollbackPolicy ?? null],
  );
  if (!rows[0]) throw notFound('Project not found');
  return toInfo(rows[0]);
}

/** Deletes the project and, through the foreign keys, its files, history and history files. */
export async function deleteProject(ctx: Ctx, projectId: string): Promise<void> {
  await ctx.db.query('DELETE FROM projects WHERE id = $1', [projectId]);
}

export function readPasswords(ctx: Ctx, p: ProjectRow): { ro: string; rw: string } {
  return { ro: decrypt(ctx.keys, p.ro_enc, aad(p.id, 'ro')), rw: decrypt(ctx.keys, p.rw_enc, aad(p.id, 'rw')) };
}

/** New password for one mode. The old one stops working at once: its hash is gone and gate cookies carry the old generation. */
export async function refreshPassword(ctx: Ctx, projectId: string, mode: Mode): Promise<string> {
  const pw = generateProjectPassword(mode);
  const enc = encrypt(ctx.keys, pw, aad(projectId, mode));
  const hash = lookupHash(ctx.keys, pw);
  const sql = mode === 'ro'
    ? 'UPDATE projects SET ro_enc = $2, ro_hash = $3, ro_gen = ro_gen + 1 WHERE id = $1'
    : 'UPDATE projects SET rw_enc = $2, rw_hash = $3, rw_gen = rw_gen + 1 WHERE id = $1';
  const r = await ctx.db.query(sql, [projectId, enc, hash]);
  if (!r.rowCount) throw notFound('Project not found');
  return pw;
}

/** The name of a project, for anyone who knows its id (the id is the secret; the name is not). Null when there is no such project. */
export async function publicName(ctx: Ctx, id: string): Promise<string | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await ctx.db.query<{ name: string }>('SELECT name FROM projects WHERE id = $1', [id]);
  return rows[0]?.name ?? null;
}

/** Counts one name lookup for this IP; throws 429 when it asks too often. */
export function countLookup(ctx: Ctx, ip: string): void {
  if (ctx.limits.lookups.isLimited(ip)) throw tooManyRequests(ctx.limits.lookups.retryAfterSeconds(ip));
  ctx.limits.lookups.hit(ip);
}
