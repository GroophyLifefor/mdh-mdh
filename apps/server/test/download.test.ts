import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { unzipSync, strFromU8 } from 'fflate';
import { createTestDb, type TestDb } from './db';
import { world } from './api';
import { contentDisposition, safeFileName } from '../src/services/download';
import { bearer, gate, makeApp, newProject, signUp } from './helpers';

/** GET and read the body as bytes. */
async function get(app: ReturnType<typeof makeApp>['app'], url: string, set: Record<string, string> = {}) {
  const r = request(app).get(url).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
  for (const [k, v] of Object.entries(set)) r.set(k, v);
  const res = await r;
  return { status: res.status, headers: res.headers, body: res.body as Buffer };
}
const unzip = (b: Buffer) => unzipSync(new Uint8Array(b));
const texts = (b: Buffer) => Object.fromEntries(Object.entries(unzip(b)).map(([k, v]) => [k, strFromU8(v)]));

describe('download', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.drop(); });
  const owner = (w: Awaited<ReturnType<typeof world>>) => ({ Cookie: w.owner.cookie });

  describe('one file', () => {
    it('comes exactly as stored, as an attachment named after the file', async () => {
      const w = await world(t);
      const text = '\ufeff# Title\r\nline two\r\n  trailing  \n\nTürkçe 🙂';
      await w.asOwner.create('notes/spec.md', 'file', text);
      const res = await get(w.app, `/api/projects/${w.p.id}/download?path=notes/spec.md`, owner(w));
      expect(res.status).toBe(200);
      expect(res.body.toString('utf8')).toBe(text);
      expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="spec.md"; filename*=UTF-8''spec.md`);
      expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(text));
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
    it('yaml gets a yaml type', async () => {
      const w = await world(t);
      await w.asOwner.create('c.YAML', 'file', 'a: 1');
      expect((await get(w.app, `/api/projects/${w.p.id}/download?path=c.YAML`, owner(w))).headers['content-type']).toBe('text/yaml; charset=utf-8');
    });
    it('an empty file downloads as an empty file', async () => {
      const w = await world(t);
      await w.asOwner.create('empty.md');
      const res = await get(w.app, `/api/projects/${w.p.id}/download?path=empty.md`, owner(w));
      expect([res.status, res.body.length]).toEqual([200, 0]);
    });
    it('a name with non-ASCII characters keeps its real name for the browser and a safe fallback', async () => {
      const w = await world(t);
      await w.asOwner.create('Türkçe ğ (1).md', 'file', 'x');
      const res = await get(w.app, `/api/projects/${w.p.id}/download?path=${encodeURIComponent('Türkçe ğ (1).md')}`, owner(w));
      expect(res.headers['content-disposition']).toBe(`attachment; filename="T_rk_e _ (1).md"; filename*=UTF-8''T%C3%BCrk%C3%A7e%20%C4%9F%20%281%29.md`);
    });
    it('404 for a missing file, 400 for a bad or empty path', async () => {
      const w = await world(t);
      expect((await get(w.app, `/api/projects/${w.p.id}/download?path=nope.md`, owner(w))).status).toBe(404);
      for (const q of ['path=../etc/passwd', 'path=a/../readme.md', 'path=', 'path=%2Freadme.md']) expect((await get(w.app, `/api/projects/${w.p.id}/download?${q}`, owner(w))).status, q).toBe(400);
    });
  });

  describe('the whole project as a zip', () => {
    it('contains every file with its exact text, and empty folders', async () => {
      const w = await world(t);
      await w.asOwner.upload([
        { path: 'docs/a.md', content: '# A\r\n' }, { path: 'docs/sub/b.yml', content: 'k: v\n' }, { path: 'Türkçe/ğüş.md', content: 'ünï 🙂' }, { path: 'empty-file.md', content: '' },
      ], { folders: ['empty-folder/inner'] });
      const res = await get(w.app, `/api/projects/${w.p.id}/download`, owner(w));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toContain('filename="World.zip"');
      const files = texts(res.body);
      expect(files['docs/a.md']).toBe('# A\r\n');
      expect(files['docs/sub/b.yml']).toBe('k: v\n');
      expect(files['Türkçe/ğüş.md']).toBe('ünï 🙂');
      expect(files['empty-file.md']).toBe('');
      expect(files['readme.md']).toContain('# World');
      expect(Object.keys(files).filter((k) => k.endsWith('/')).sort()).toEqual(['Türkçe/', 'docs/', 'docs/sub/', 'empty-folder/', 'empty-folder/inner/']);
      expect(Number(res.headers['content-length'])).toBe(res.body.length);
    });
    it('is a valid zip also for a project with nothing in it', async () => {
      const w = await world(t);
      await w.asOwner.del('readme.md');
      const res = await get(w.app, `/api/projects/${w.p.id}/download`, owner(w));
      expect(res.status).toBe(200);
      expect(unzip(res.body)).toEqual({});
    });
    it('handles a project of 200 files', async () => {
      const w = await world(t);
      const many = Array.from({ length: 200 }, (_, i) => ({ path: `bulk/f${i}.md`, content: `file ${i}\n`.repeat(50) }));
      await w.asOwner.upload(many);
      const files = texts((await get(w.app, `/api/projects/${w.p.id}/download`, owner(w))).body);
      for (const f of many) expect(files[f.path]).toBe(f.content);
    });
    it('only contains this project', async () => {
      const w = await world(t);
      const other = await world(t);
      await other.asOwner.create('secret.md', 'file', 'TOP SECRET');
      const zipText = JSON.stringify(texts((await get(w.app, `/api/projects/${w.p.id}/download`, owner(w))).body));
      expect(zipText).not.toContain('TOP SECRET');
    });
    it('the zip name is safe whatever the project is called', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const names: [string, string][] = [
        ['a/b\\c:d*e?f"g<h>i|j', 'a_b_c_d_e_f_g_h_i_j.zip'], ['..', 'project.zip'], ['...hidden', 'hidden.zip'], ['  spaced  ', 'spaced.zip'],
        ['x'.repeat(100), 'x'.repeat(100) + '.zip'], ['Türkçe proje', 'Türkçe proje.zip'], ['a\u202eb', 'ab.zip'],
      ];
      for (const [name, expected] of names) {
        const p = await newProject(app, u.cookie, name.slice(0, 100));
        const res = await get(app, `/api/projects/${p.id}/download`, { Cookie: u.cookie });
        const cd = res.headers['content-disposition'] as string;
        expect(cd, name).toContain(`filename*=UTF-8''${encodeURIComponent(expected).replace(/[\'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`);
        expect(cd.includes('\n') || cd.includes('\r'), name).toBe(false);
      }
    });
  });

  describe('a folder as a zip', () => {
    it('has the folder itself inside, with everything below it', async () => {
      const w = await world(t);
      await w.asOwner.upload([{ path: 'docs/a.md', content: 'A' }, { path: 'docs/sub/b.md', content: 'B' }, { path: 'docs2/x.md', content: 'X' }], { folders: ['docs/empty'] });
      const res = await get(w.app, `/api/projects/${w.p.id}/download?path=docs`, owner(w));
      expect(res.headers['content-disposition']).toContain('filename="docs.zip"');
      const files = texts(res.body);
      expect(Object.keys(files).sort()).toEqual(['docs/', 'docs/a.md', 'docs/empty/', 'docs/sub/', 'docs/sub/b.md']);   // not docs2
      expect(files['docs/sub/b.md']).toBe('B');
    });
    it('a nested folder is named by its own name, not its whole path', async () => {
      const w = await world(t);
      await w.asOwner.upload([{ path: 'a/b/c/deep.md', content: 'D' }]);
      const res = await get(w.app, `/api/projects/${w.p.id}/download?path=a/b`, owner(w));
      expect(res.headers['content-disposition']).toContain('filename="b.zip"');
      expect(Object.keys(texts(res.body)).sort()).toEqual(['b/', 'b/c/', 'b/c/deep.md']);
    });
  });

  describe('who may download', () => {
    it('anyone with read access: owner, either password, a gate cookie; nobody else', async () => {
      const w = await world(t);
      const base = `/api/projects/${w.p.id}/download`;
      expect((await get(w.app, base, bearer(w.p.ro))).status).toBe(200);
      expect((await get(w.app, base, bearer(w.p.rw))).status).toBe(200);
      expect((await get(w.app, base, { Cookie: await gate(w.app, w.p.id, w.p.ro, 'Kim') })).status).toBe(200);
      expect((await get(w.app, base)).status).toBe(401);
      expect((await get(w.app, base, bearer('ro_wrongwrongwrongwrongwr'))).status).toBe(401);
      const stranger = await signUp(w.app);
      expect((await get(w.app, base, { Cookie: stranger.cookie })).status).toBe(401);
    });
    it('is not a way around the access rules: another project\'s password gets nothing', async () => {
      const w = await world(t);
      const other = await world(t);
      expect((await get(w.app, `/api/projects/${w.p.id}/download`, bearer(other.p.rw))).status).toBe(401);
    });
    it('a download changes nothing (no history entry)', async () => {
      const w = await world(t);
      const before = (await w.changes()).length;
      await get(w.app, `/api/projects/${w.p.id}/download`, owner(w));
      await get(w.app, `/api/projects/${w.p.id}/download?path=readme.md`, owner(w));
      expect((await w.changes()).length).toBe(before);
    });
  });
});

describe('download names', () => {
  it('safeFileName', () => {
    expect(safeFileName('plain.md')).toBe('plain.md');
    expect(safeFileName('a/b\\c')).toBe('a_b_c');
    expect(safeFileName('')).toBe('project');
    expect(safeFileName('   ', 'file')).toBe('file');
    expect(safeFileName('..', 'folder')).toBe('folder');
    expect(safeFileName('line\nbreak\rhere')).toBe('line_break_here');
    expect(safeFileName('x'.repeat(300))).toHaveLength(100);
  });
  it('contentDisposition quotes, escapes and encodes', () => {
    expect(contentDisposition('a.md')).toBe(`attachment; filename="a.md"; filename*=UTF-8''a.md`);
    expect(contentDisposition('say "hi".md')).toContain('filename="say _hi_.md"');
    expect(contentDisposition("it's (x)*.md")).toContain("filename*=UTF-8''it%27s%20%28x%29%2A.md");
    expect(contentDisposition('日本語.md')).toContain(`filename="___.md"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.md`);
  });
});
