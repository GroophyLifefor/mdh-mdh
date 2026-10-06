import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';
import { world } from './api';
import { MERGE_WINDOW_MS, MAX_NODES } from '../src/services/files';

describe('files', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.drop(); });

  describe('reading', () => {
    it('lists the tree with kind, version and size, in byte order, without content', async () => {
      const w = await world(t);
      await w.asOwner.create('b/x.md', 'file', 'hello');
      await w.asOwner.create('B.md', 'file', 'é');
      const res = await w.asOwner.tree();
      expect(res.body.nodes.map((n: { path: string }) => n.path)).toEqual(['B.md', 'b', 'b/x.md', 'readme.md']);
      expect(res.body.nodes.find((n: { path: string }) => n.path === 'b/x.md')).toEqual({ path: 'b/x.md', kind: 'file', version: 1, size: 5 });
      expect(res.body.nodes.find((n: { path: string }) => n.path === 'B.md').size).toBe(2); // bytes, not characters
      expect(JSON.stringify(res.body)).not.toContain('hello');
    });
    it('reads a file with its version', async () => {
      const w = await world(t);
      const res = await w.asRo.read('readme.md');
      expect(res.status).toBe(200);
      expect(res.body.file).toMatchObject({ path: 'readme.md', version: 1, content: expect.stringContaining('# World') });
    });
    it('404 for a missing file or a folder; 400 for no path or a bad path', async () => {
      const w = await world(t);
      await w.asOwner.create('d', 'dir');
      expect((await w.asOwner.read('nope.md')).status).toBe(404);
      expect((await w.asOwner.read('d')).status).toBe(404);
      expect((await w.asOwner.read('../etc/passwd')).status).toBe(400);
      expect((await w.asOwner.read('a/../readme.md')).status).toBe(400);
      expect((await w.asOwner.read('')).status).toBe(400);
    });
    it('treats a path with different capitalisation as another file', async () => {
      const w = await world(t);
      expect((await w.asOwner.read('README.md')).status).toBe(404);
    });
    it('never shows one project\'s files through another project\'s URL', async () => {
      const w = await world(t);
      const other = await world(t);
      await other.asOwner.create('secret.md', 'file', 'TOP SECRET');
      const res = await w.asOwner.read('secret.md');
      expect(res.status).toBe(404);
      expect(JSON.stringify((await w.asOwner.tree()).body)).not.toContain('secret');
    });
  });

  describe('saving', () => {
    it('writes the content, raises the version and records one "edited" change with before and after', async () => {
      const w = await world(t);
      const original = (await w.asOwner.read('readme.md')).body.file.content;
      const res = await w.asOwner.save('readme.md', 'new text', 1);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ unchanged: false, version: 2, seq: 2, merged: false });
      expect((await w.asOwner.read('readme.md')).body.file).toMatchObject({ content: 'new text', version: 2 });
      expect((await w.changes()).map((c) => [c.seq, c.kind, c.summary])).toEqual([[1, 'create', 'created readme.md'], [2, 'edit', 'edited readme.md']]);
      expect(await w.changeFiles(2)).toEqual([{ path: 'readme.md', kind: 'file', action: 'updated', before: original, after: 'new text' }]);
    });

    it('does nothing and records nothing when the content did not change', async () => {
      const w = await world(t);
      const same = (await w.asOwner.read('readme.md')).body.file.content;
      const res = await w.asOwner.save('readme.md', same, 1);
      expect(res.body).toEqual({ unchanged: true, version: 1 });
      expect((await w.changes()).length).toBe(1);
    });

    it('keeps text exactly: unicode, CRLF, trailing spaces, empty and a leading BOM', async () => {
      const w = await world(t);
      let v = 1;
      for (const text of ['türkçe ğüşiöç 🙂 日本語', 'a\r\nb\r\n', 'trailing   \n\n\n', '', '﻿# bom']) {
        const r = await w.asOwner.save('readme.md', text, v);
        expect(r.status, JSON.stringify(text)).toBe(200);
        v = r.body.version;
        expect((await w.asOwner.read('readme.md')).body.file.content).toBe(text);
      }
    });

    it('refuses a stale base version with 409 and changes nothing', async () => {
      const w = await world(t);
      await w.asOwner.save('readme.md', 'first', 1);
      const stale = await w.asRw().save('readme.md', 'mine', 1);
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('version_conflict');
      expect((await w.asOwner.read('readme.md')).body.file.content).toBe('first');
      expect((await w.changes()).length).toBe(2);
    });

    it('also refuses a base version from the future', async () => {
      const w = await world(t);
      expect((await w.asOwner.save('readme.md', 'x', 5)).status).toBe(409);
    });

    it.each([['missing', undefined], ['zero', 0], ['negative', -1], ['fraction', 1.5], ['string', '1']])('refuses baseVersion %s', async (_n, v) => {
      const w = await world(t);
      const res = await w.asOwner.save('readme.md', 'x', v as never);
      expect(res.status).toBe(400);
    });

    it('404 for a file that does not exist (saving never creates files)', async () => {
      const w = await world(t);
      expect((await w.asOwner.save('new.md', 'x', 1)).status).toBe(404);
      expect(Object.keys(await w.state())).toEqual(['readme.md']);
    });

    it('refuses bad content: NUL, broken Unicode, over 1 MB', async () => {
      const w = await world(t);
      expect((await w.asOwner.save('readme.md', 'a\u0000b', 1)).status).toBe(400);
      expect((await w.asOwner.save('readme.md', 'a\ud800b', 1)).status).toBe(400);
      const big = await w.asOwner.save('readme.md', 'x'.repeat(1_000_001), 1);
      expect(big.status).toBe(400);
      expect(big.body.error.code).toBe('too_large');
      expect((await w.asOwner.save('readme.md', 'x'.repeat(1_000_000), 1)).status).toBe(200);
    });

    it('a read-only password cannot save, and nothing changes', async () => {
      const w = await world(t);
      const res = await w.asRo.save('readme.md', 'hacked', 1);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('read_only');
      expect((await w.asOwner.read('readme.md')).body.file.version).toBe(1);
    });

    it('parallel saves from the same version: exactly one wins, the others get 409', async () => {
      const w = await world(t);
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => w.asRw(`bot${i}`).save('readme.md', `from ${i}`, 1)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
      const winner = results.findIndex((r) => r.status === 200);
      expect((await w.asOwner.read('readme.md')).body.file.content).toBe(`from ${winner}`);
      expect((await w.changes()).length).toBe(2);
    });

    describe('merging autosaves into one history entry', () => {
      it('same person, same file, within 10 minutes: one entry, before from the first save, after from the last', async () => {
        const w = await world(t);
        const original = (await w.asOwner.read('readme.md')).body.file.content;
        const a = await w.asOwner.save('readme.md', 'v1', 1);
        w.clock.advance(5_000);
        const b = await w.asOwner.save('readme.md', 'v2', a.body.version);
        w.clock.advance(60_000);
        const c = await w.asOwner.save('readme.md', 'v3', b.body.version);
        expect([a.body.merged, b.body.merged, c.body.merged]).toEqual([false, true, true]);
        expect([a.body.seq, b.body.seq, c.body.seq]).toEqual([2, 2, 2]);
        expect((await w.changes()).length).toBe(2);
        expect(await w.changeFiles(2)).toEqual([{ path: 'readme.md', kind: 'file', action: 'updated', before: original, after: 'v3' }]);
        expect((await w.asOwner.read('readme.md')).body.file.version).toBe(4); // the file still counts every save
      });

      it('the window is measured from the LAST save, so steady typing keeps merging', async () => {
        const w = await world(t);
        let v = 1;
        for (let i = 0; i < 8; i++) { v = (await w.asOwner.save('readme.md', 'text ' + i, v)).body.version; w.clock.advance(MERGE_WINDOW_MS - 1000); }
        expect((await w.changes()).length).toBe(2);
      });

      it('starts a new entry at exactly 10 minutes, merges at 10 minutes minus 1 ms', async () => {
        const w = await world(t);
        const a = await w.asOwner.save('readme.md', 'v1', 1);
        w.clock.advance(MERGE_WINDOW_MS - 1);
        const b = await w.asOwner.save('readme.md', 'v2', a.body.version);
        expect(b.body.merged).toBe(true);
        w.clock.advance(MERGE_WINDOW_MS);
        const c = await w.asOwner.save('readme.md', 'v3', b.body.version);
        expect(c.body.merged).toBe(false);
        expect(c.body.seq).toBe(3);
      });

      it('another person starts a new entry', async () => {
        const w = await world(t);
        const a = await w.asOwner.save('readme.md', 'v1', 1);
        const b = await w.asRw('bot').save('readme.md', 'v2', a.body.version);
        expect(b.body).toMatchObject({ merged: false, seq: 3 });
        const c = await w.asOwner.save('readme.md', 'v3', b.body.version); // back to the owner: the last entry is the bot's
        expect(c.body).toMatchObject({ merged: false, seq: 4 });
      });

      it('two password users with different names do not merge; the same name does', async () => {
        const w = await world(t);
        const a = await w.asRw('Sam').save('readme.md', 'v1', 1);
        const b = await w.asRw('Kim').save('readme.md', 'v2', a.body.version);
        const c = await w.asRw('Kim').save('readme.md', 'v3', b.body.version);
        expect([a.body.seq, b.body.seq, c.body.seq]).toEqual([2, 3, 3]);
      });

      it('a different file starts a new entry', async () => {
        const w = await world(t);
        await w.asOwner.create('b.md', 'file');
        const a = await w.asOwner.save('readme.md', 'v1', 1);
        const b = await w.asOwner.save('b.md', 'v2', 1);
        expect([a.body.seq, b.body.seq]).toEqual([3, 4]);
      });

      it('an entry that is not an edit (create, rename, delete, upload) is never merged into', async () => {
        const w = await world(t);
        const created = await w.asOwner.create('b.md', 'file', 'x');
        const s1 = await w.asOwner.save('b.md', 'y', 1);
        expect(s1.body).toMatchObject({ merged: false, seq: created.body.change.seq + 1 });
        await w.asOwner.move('b.md', 'c.md');
        const s2 = await w.asOwner.save('c.md', 'z', 2);
        expect(s2.body.merged).toBe(false);
      });

      it('after a rollback the next edit starts a new entry', async () => {
        const w = await world(t);
        await w.asOwner.save('readme.md', 'v1', 1);
        await w.asOwner.rollback(1);
        const res = await w.asOwner.save('readme.md', 'v2', 3);
        expect(res.body).toMatchObject({ merged: false, seq: 4 });
      });

      it('an edit that gets typed back to the original text stays as an entry with identical before and after', async () => {
        const w = await world(t);
        const original = (await w.asOwner.read('readme.md')).body.file.content;
        const a = await w.asOwner.save('readme.md', 'oops', 1);
        await w.asOwner.save('readme.md', original, a.body.version);
        const [row] = await w.changeFiles(2);
        expect(row).toMatchObject({ before: original, after: original });
        expect((await w.changes()).length).toBe(2); // history never shrinks
      });

      it('the history timestamps move with the merged entry', async () => {
        const w = await world(t);
        const a = await w.asOwner.save('readme.md', 'v1', 1);
        w.clock.advance(120_000);
        await w.asOwner.save('readme.md', 'v2', a.body.version);
        const c = (await w.asOwner.change(2)).body.change;
        expect(new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime()).toBe(120_000);
      });
    });
  });

  describe('creating', () => {
    it('creates a file (empty by default, or with content) and a folder, each as one change', async () => {
      const w = await world(t);
      expect((await w.asOwner.create('empty.md')).status).toBe(201);
      expect((await w.asOwner.create('full.yml', 'file', 'a: 1')).status).toBe(201);
      expect((await w.asOwner.create('docs', 'dir')).status).toBe(201);
      expect(await w.state()).toMatchObject({ 'empty.md': '', 'full.yml': 'a: 1', docs: null });
      expect((await w.changes()).slice(1).map((c) => [c.kind, c.summary])).toEqual([['create', 'created empty.md'], ['create', 'created full.yml'], ['create', 'created folder docs']]);
    });

    it('creates missing folders on the way, and records them in the same change', async () => {
      const w = await world(t);
      const res = await w.asOwner.create('a/b/c/note.md', 'file', 'deep');
      expect(res.status).toBe(201);
      expect(await w.state()).toMatchObject({ a: null, 'a/b': null, 'a/b/c': null, 'a/b/c/note.md': 'deep' });
      expect((await w.changeFiles(res.body.change.seq)).map((f) => [f.path, f.action])).toEqual([['a', 'created'], ['a/b', 'created'], ['a/b/c', 'created'], ['a/b/c/note.md', 'created']]);
    });

    it('only creates the folders that are missing', async () => {
      const w = await world(t);
      await w.asOwner.create('a', 'dir');
      const res = await w.asOwner.create('a/b/x.md');
      expect((await w.changeFiles(res.body.change.seq)).map((f) => f.path)).toEqual(['a/b', 'a/b/x.md']);
    });

    it('409 when the name is taken (file or folder); a file can never be a parent, so that path is simply invalid', async () => {
      const w = await world(t);
      await w.asOwner.create('d', 'dir');
      expect((await w.asOwner.create('readme.md')).body.error.code).toBe('already_exists');
      expect((await w.asOwner.create('d', 'dir')).body.error.code).toBe('already_exists');
      expect((await w.asOwner.create('readme.md/inner.md')).body.error.code).toBe('invalid_path'); // "readme.md" cannot be a folder
      expect((await w.changes()).length).toBe(2); // only the d folder
    });

    it('refuses to go through a folder that is named like a file (no 500, nothing written)', async () => {
      const w = await world(t);
      const before = await w.state();
      const results = [
        await w.asOwner.create('v2.yml/b.md'),
        await w.asOwner.move('readme.md', 'v3.md/readme.md'),
        await w.asOwner.upload([{ path: 'v1.md/a.md', content: 'x' }]),
        await w.asOwner.upload([], { folders: ['x/v4.md/deep'] }),
      ];
      for (const r of results) expect([r.status, r.body.error.code]).toEqual([400, 'invalid_path']);
      expect(await w.state()).toEqual(before);
    });

    it('refuses wrong extensions for files, file-like names for folders, bad paths and unknown kinds', async () => {
      const w = await world(t);
      expect((await w.asOwner.create('a.txt')).status).toBe(400);
      expect((await w.asOwner.create('a.md', 'dir')).status).toBe(400);
      expect((await w.asOwner.create('../x.md')).status).toBe(400);
      expect((await w.asOwner.create('x.md', 'link' as never)).status).toBe(400);
      expect((await w.asOwner.create(Array(21).fill('d').join('/') + '/x.md')).status).toBe(400);
      expect(Object.keys(await w.state())).toEqual(['readme.md']);
    });

    it('is atomic: when the project turns out to be full AFTER the folders were made, no folders are left behind', async () => {
      const w = await world(t);
      await t.db.query(`INSERT INTO nodes (project_id, path, kind) SELECT $1, 'bulk/' || g || '.md', 'file' FROM generate_series(1, $2) g`, [w.p.id, MAX_NODES - 3]); // readme + bulk = MAX_NODES - 2
      const before = (await t.db.query('SELECT count(*)::int AS n FROM nodes WHERE project_id = $1', [w.p.id])).rows[0].n;
      const res = await w.asOwner.create('new1/new2/new3/file.md'); // needs 4 new nodes, only 2 fit
      expect([res.status, res.body.error.code]).toEqual([413, 'project_full']);
      expect((await t.db.query('SELECT count(*)::int AS n FROM nodes WHERE project_id = $1', [w.p.id])).rows[0].n).toBe(before);
      expect((await t.db.query("SELECT 1 FROM nodes WHERE project_id = $1 AND path LIKE 'new1%'", [w.p.id])).rowCount).toBe(0);
    });

    it('two simultaneous creates of the same path: one 201, one 409', async () => {
      const w = await world(t);
      const res = await Promise.all([w.asRw('a').create('same.md'), w.asRw('b').create('same.md'), w.asRw('c').create('same.md')]);
      expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    });

    it('stops at the node limit and the byte limit', async () => {
      const w = await world(t);
      await t.db.query(`INSERT INTO nodes (project_id, path, kind) SELECT $1, 'bulk/' || g || '.md', 'file' FROM generate_series(1, $2) g`, [w.p.id, MAX_NODES - 1]); // + readme.md = MAX_NODES
      const full = await w.asOwner.create('one-too-many.md');
      expect(full.status).toBe(413);
      expect(full.body.error.code).toBe('project_full');
      const w2 = await world(t);
      await t.db.query(`INSERT INTO nodes (project_id, path, kind, content) SELECT $1, 'big' || g || '.md', 'file', repeat('x', 1000000) FROM generate_series(1, 50) g`, [w2.p.id]);
      expect((await w2.asOwner.create('more.md', 'file', 'x')).status).toBe(413);
      expect((await w2.asOwner.save('big1.md', 'y'.repeat(1000), 1)).status).toBe(200); // shrinking is always allowed
    });
  });

  describe('moving and renaming', () => {
    it('renames a file, keeping its content and version', async () => {
      const w = await world(t);
      const text = (await w.asOwner.read('readme.md')).body.file.content;
      const res = await w.asOwner.move('readme.md', 'intro.md');
      expect(res.status).toBe(200);
      expect(await w.state()).toEqual({ 'intro.md': text });
      expect((await w.asOwner.read('intro.md')).body.file.version).toBe(1);
      expect((await w.asOwner.read('readme.md')).status).toBe(404);
      const [c] = (await w.changes()).slice(-1);
      expect(c).toMatchObject({ kind: 'rename', summary: 'renamed readme.md → intro.md' });
      expect(await w.changeFiles(c!.seq)).toEqual([
        { path: 'intro.md', kind: 'file', action: 'created', before: null, after: text },
        { path: 'readme.md', kind: 'file', action: 'deleted', before: text, after: null },
      ]);
    });

    it('moves a file into a folder that does not exist yet', async () => {
      const w = await world(t);
      await w.asOwner.move('readme.md', 'new/place/readme.md');
      expect(Object.keys(await w.state())).toEqual(['new', 'new/place', 'new/place/readme.md']);
    });

    it('renames a folder with everything inside it', async () => {
      const w = await world(t);
      await w.asOwner.create('old/sub/deep.md', 'file', 'D');
      await w.asOwner.create('old/top.yml', 'file', 'T');
      await w.asOwner.create('older/keep.md', 'file', 'K'); // starts with the same letters but is another folder
      const res = await w.asOwner.move('old', 'fresh');
      expect(res.status).toBe(200);
      expect(await w.state()).toEqual({
        'readme.md': expect.any(String), fresh: null, 'fresh/sub': null, 'fresh/sub/deep.md': 'D', 'fresh/top.yml': 'T', older: null, 'older/keep.md': 'K',
      });
      const files = await w.changeFiles(res.body.change.seq);
      expect(files.filter((f) => f.action === 'deleted').map((f) => f.path)).toEqual(['old', 'old/sub', 'old/sub/deep.md', 'old/top.yml']);
      expect(files.filter((f) => f.action === 'created').map((f) => f.path)).toEqual(['fresh', 'fresh/sub', 'fresh/sub/deep.md', 'fresh/top.yml']);
    });

    it.each([
      ['onto an existing file', 'readme.md', 'other.md', 409, 'already_exists'],
      ['onto an existing folder name', 'readme.md', 'docs', 400, 'invalid_path'],
      ['to the same path', 'readme.md', 'readme.md', 400, 'same_path'],
      ['to a wrong extension', 'readme.md', 'readme.txt', 400, 'invalid_path'],
      ['to a bad path', 'readme.md', '../x.md', 400, 'invalid_path'],
      ['a missing file', 'ghost.md', 'x.md', 404, 'not_found'],
    ])('refuses moving %s', async (_n, from, to, status, code) => {
      const w = await world(t);
      await w.asOwner.create('other.md'); await w.asOwner.create('docs', 'dir');
      const before = await w.state();
      const res = await w.asOwner.move(from, to);
      expect([res.status, res.body.error.code]).toEqual([status, code]);
      expect(await w.state()).toEqual(before);
    });

    it('refuses to move a folder into itself or onto a name that exists', async () => {
      const w = await world(t);
      await w.asOwner.create('a/b/x.md'); await w.asOwner.create('z', 'dir');
      expect((await w.asOwner.move('a', 'a/b/a')).body.error.code).toBe('move_into_itself');
      expect((await w.asOwner.move('a', 'z')).body.error.code).toBe('already_exists');
      expect((await w.asOwner.move('a', 'a.md')).status).toBe(400); // a folder cannot get a file name
    });

    it('refuses to put something under a file (a file name cannot be a folder name)', async () => {
      const w = await world(t);
      await w.asOwner.create('b.md');
      expect((await w.asOwner.move('b.md', 'readme.md/b.md')).body.error.code).toBe('invalid_path');
    });

    it('moving a folder up and down keeps working (a/b -> b, then b -> a/b)', async () => {
      const w = await world(t);
      await w.asOwner.create('a/b/x.md', 'file', 'X');
      expect((await w.asOwner.move('a/b', 'b')).status).toBe(200);
      expect(await w.state()).toMatchObject({ a: null, b: null, 'b/x.md': 'X' });
      expect((await w.asOwner.move('b', 'a/b')).status).toBe(200);
      expect(await w.state()).toMatchObject({ a: null, 'a/b': null, 'a/b/x.md': 'X' });
    });
  });

  describe('deleting', () => {
    it('deletes a file and records its content so it can be restored', async () => {
      const w = await world(t);
      await w.asOwner.create('b.md', 'file', 'bye');
      const res = await w.asOwner.del('b.md');
      expect(res.status).toBe(200);
      expect(await w.state()).not.toHaveProperty(['b.md']);
      expect(await w.changeFiles(res.body.change.seq)).toEqual([{ path: 'b.md', kind: 'file', action: 'deleted', before: 'bye', after: null }]);
      expect((await w.changes()).at(-1)).toMatchObject({ kind: 'delete', summary: 'deleted b.md' });
    });

    it('deletes a folder with everything in it, but not a folder with a similar name', async () => {
      const w = await world(t);
      await w.asOwner.create('d/a.md'); await w.asOwner.create('d/e/b.md'); await w.asOwner.create('d2/c.md'); await w.asOwner.create('d.md');
      const res = await w.asOwner.del('d');
      expect(res.status).toBe(200);
      expect(Object.keys(await w.state()).sort()).toEqual(['d.md', 'd2', 'd2/c.md', 'readme.md']);
      expect((await w.changeFiles(res.body.change.seq)).map((f) => f.path)).toEqual(['d', 'd/a.md', 'd/e', 'd/e/b.md']);
    });

    it('can delete the last file, and an empty project still works', async () => {
      const w = await world(t);
      expect((await w.asOwner.del('readme.md')).status).toBe(200);
      expect((await w.asOwner.tree()).body.nodes).toEqual([]);
      expect((await w.asOwner.create('again.md')).status).toBe(201);
    });

    it('404 for something that is not there, 400 for a bad path, and deleting twice fails the second time', async () => {
      const w = await world(t);
      expect((await w.asOwner.del('nope.md')).status).toBe(404);
      expect((await w.asOwner.del('../x')).status).toBe(400);
      expect((await w.asOwner.del('readme.md')).status).toBe(200);
      expect((await w.asOwner.del('readme.md')).status).toBe(404);
    });
  });

  describe('upload', () => {
    it('creates files and folders in one change, creating the folders in between', async () => {
      const w = await world(t);
      const res = await w.asRw('bot').upload([{ path: 'docs/a.md', content: 'A' }, { path: 'docs/sub/b.yml', content: 'b: 1' }], { folders: ['empty/dir'] });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ created: 2, updated: 0, unchanged: 0, newFolders: 4, seq: 2 });
      expect(await w.state()).toMatchObject({ docs: null, 'docs/a.md': 'A', 'docs/sub': null, 'docs/sub/b.yml': 'b: 1', empty: null, 'empty/dir': null });
      expect((await w.changes()).at(-1)).toMatchObject({ kind: 'upload', summary: 'uploaded 2 files', actor_type: 'password', actor_name: 'bot' });
    });

    it('uses the same summary texts as the page: one file, many files, only folders', async () => {
      const w = await world(t);
      await w.asOwner.upload([{ path: 'one.md', content: '1' }]);
      await w.asOwner.upload([{ path: 'new-folder/two.md', content: '2' }]); // one file, plus a folder made on the way
      await w.asOwner.upload([{ path: 'a.md', content: '1' }, { path: 'b.md', content: '2' }]);
      await w.asOwner.upload([], { folders: ['f1'] });
      await w.asOwner.upload([], { folders: ['f2', 'f3'] });
      expect((await w.changes()).slice(1).map((c) => c.summary)).toEqual(['uploaded one.md', 'uploaded new-folder/two.md', 'uploaded 2 files', 'created folder f1', 'created 2 folders']);
    });

    it('skips identical files without making a change', async () => {
      const w = await world(t);
      const readme = (await w.asOwner.read('readme.md')).body.file.content;
      const res = await w.asOwner.upload([{ path: 'readme.md', content: readme }]);
      expect(res.body).toEqual({ created: 0, updated: 0, unchanged: 1, newFolders: 0, seq: null });
      expect((await w.changes()).length).toBe(1);
    });

    it('refuses different content for an existing file unless overwrite is set, and then writes nothing at all', async () => {
      const w = await world(t);
      const before = await w.state();
      const res = await w.asOwner.upload([{ path: 'new.md', content: 'N' }, { path: 'readme.md', content: 'replaced' }]);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'conflicts', details: { paths: ['readme.md'] } });
      expect(await w.state()).toEqual(before);
      expect((await w.changes()).length).toBe(1);
    });

    it('with overwrite replaces the file, bumps its version and records old and new content', async () => {
      const w = await world(t);
      const old = (await w.asOwner.read('readme.md')).body.file.content;
      const res = await w.asOwner.upload([{ path: 'readme.md', content: 'replaced' }, { path: 'new.md', content: 'N' }], { overwrite: true });
      expect(res.body).toMatchObject({ created: 1, updated: 1 });
      expect((await w.asOwner.read('readme.md')).body.file).toMatchObject({ content: 'replaced', version: 2 });
      expect(await w.changeFiles(res.body.seq)).toEqual([
        { path: 'new.md', kind: 'file', action: 'created', before: null, after: 'N' },
        { path: 'readme.md', kind: 'file', action: 'updated', before: old, after: 'replaced' },
      ]);
    });

    it('is all or nothing: one bad path, one bad file or one clash cancels everything', async () => {
      const w = await world(t);
      await w.asOwner.create('d', 'dir');
      const before = await w.state();
      const bad: [string, { path: string; content: string }[], object][] = [
        ['a path with ..', [{ path: 'ok.md', content: '1' }, { path: '../x.md', content: '2' }], {}],
        ['a wrong extension', [{ path: 'ok.md', content: '1' }, { path: 'x.txt', content: '2' }], {}],
        ['a NUL byte', [{ path: 'ok.md', content: '1' }, { path: 'y.md', content: 'a\u0000' }], {}],
        ['a file over 1 MB', [{ path: 'ok.md', content: '1' }, { path: 'big.md', content: 'x'.repeat(1_000_001) }], {}],
        ['the same path twice', [{ path: 'ok.md', content: '1' }, { path: 'ok.md', content: '2' }], {}],
        ['a file where a folder is', [{ path: 'ok.md', content: '1' }, { path: 'd', content: '2' }], {}],
        ['a folder under a file', [{ path: 'ok.md', content: '1' }, { path: 'readme.md/x.md', content: '2' }], {}],
        ['a folder named like a file', [{ path: 'ok.md', content: '1' }], { folders: ['v.md'] }],
      ];
      for (const [label, files, opts] of bad) {
        const res = await w.asOwner.upload(files, opts);
        expect(res.status, label).toBeGreaterThanOrEqual(400);
        expect(res.status, label).toBeLessThan(500);
        expect(await w.state(), label).toEqual(before);
      }
      expect((await w.changes()).length).toBe(2); // readme + d only
    });

    it('allows 200 files and refuses 201; refuses an empty upload', async () => {
      const w = await world(t);
      const many = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `bulk/f${i}.md`, content: String(i) }));
      expect((await w.asOwner.upload(many(200))).status).toBe(200);
      expect((await w.asOwner.upload(many(201))).status).toBe(400);
      expect((await w.asOwner.upload([])).body.error.code).toBe('nothing_to_upload');
    });

    it('refuses unknown fields and wrong types', async () => {
      const w = await world(t);
      const { default: request } = await import('supertest');
      const post = (body: unknown) => request(w.app).post(`/api/projects/${w.p.id}/upload`).set('Cookie', w.owner.cookie).send(body as object);
      for (const body of [{ files: 'x' }, { files: [{ path: 'a.md' }] }, { files: [], folders: 'x' }, { files: [{ path: 'a.md', content: 'x', mode: 1 }] }, { files: [{ path: 'a.md', content: 'x' }], overwrite: 'yes' }, { files: [{ path: 'a.md', content: 'x' }], extra: 1 }, {}]) {
        expect((await post(body)).status, JSON.stringify(body)).toBe(400);
      }
      expect(Object.keys(await w.state())).toEqual(['readme.md']);
    });

    it('two uploads of the same new file at once: one wins, the other is a conflict or a no-op, never a crash', async () => {
      const w = await world(t);
      const res = await Promise.all([w.asRw('a').upload([{ path: 'same.md', content: 'A' }]), w.asRw('b').upload([{ path: 'same.md', content: 'B' }])]);
      for (const r of res) expect([200, 409]).toContain(r.status);
      expect(res.some((r) => r.status === 200)).toBe(true);
      expect(['A', 'B']).toContain((await w.state())['same.md']);
    });
  });
});
