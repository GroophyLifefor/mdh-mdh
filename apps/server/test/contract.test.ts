// llm.txt is what agents read. It must describe the API that really exists, and the documented workflow must really work.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createTestDb, type TestDb } from './db';
import { bearer, makeApp, newProject, signUp } from './helpers';

const LLM = readFileSync(fileURLToPath(new URL('../../web/public/llm.txt', import.meta.url)), 'utf8');

/** The routes listed in the "Endpoints an agent can use" block, e.g. "GET /api/projects/:id/tree". */
const ENDPOINT_BLOCK = LLM.split('## 3. Endpoints an agent can use')[1]!.split('### ')[0]!;
const documented = [...ENDPOINT_BLOCK.matchAll(/^ {4}(GET|PUT|POST|PATCH|DELETE)\s+(\/api\/\S+)$/gm)].map((m) => `${m[1]} ${m[2]}`);

/** Routes that a password (Bearer) can never use, or that are for the website only. They are not in llm.txt on purpose. */
const NOT_FOR_AGENTS = new Set([
  'GET /api/health', 'GET /api/config', 'GET /api/projects/:id/public',                                                                              // for the website
  'POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/auth/me', 'PATCH /api/auth/me', // accounts
  'GET /api/projects', 'POST /api/projects',                                                                          // need an account
  'PATCH /api/projects/:id', 'DELETE /api/projects/:id', 'GET /api/projects/:id/passwords', 'POST /api/projects/:id/passwords/:mode/refresh', // owner only
  'POST /api/projects/:id/access',                                                                                    // the website's password gate (sets a cookie)
]);

describe('llm.txt matches the API', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.drop(); });

  it('documents every route an agent can use, and only routes that exist', () => {
    const { app } = makeApp(t);
    const routes = app.locals.routeTable as string[];
    const forAgents = routes.filter((r) => !NOT_FOR_AGENTS.has(r)).sort();
    expect([...documented].sort(), 'llm.txt vs the routes the app really has').toEqual(forAgents);
  });

  it('lists no route twice', () => {
    expect(new Set(documented).size).toBe(documented.length);
  });

  it('every error code it names is a code the API really uses', () => {
    const section = LLM.split('## 5. Errors')[1]!.split('## 6.')[0]!;
    const named = [...section.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)].map((m) => m[1]!);
    const src = ['errors.ts', 'http.ts', 'paths.ts', 'app.ts', 'services/access.ts', 'services/files.ts', 'services/auth.ts', 'services/projects.ts', 'routes/files.ts']
      .map((f) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8')).join('\n');
    for (const code of new Set(named)) expect(src, `error code "${code}" is in llm.txt but nowhere in the code`).toContain(`'${code}'`);
  });

  it('the limits it states are the limits in the code', () => {
    const src = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8');
    expect(LLM).toContain('Max 1 MB per file');
    expect(src('paths.ts')).toContain('MAX_FILE_BYTES = 1_000_000');
    expect(LLM).toContain('Max 200 files per upload');
    expect(src('services/files.ts')).toContain('MAX_UPLOAD_FILES = 200');
    expect(LLM).toContain('Max 2000 files and folders and 50 MB');
    expect(src('services/files.ts')).toContain('MAX_NODES = 2000');
    expect(src('services/files.ts')).toContain('MAX_PROJECT_BYTES = 50_000_000');
    expect(LLM).toContain('at most 20 levels');
    expect(src('paths.ts')).toContain('MAX_DEPTH = 20');
    expect(LLM).toContain('within 10 minutes');
    expect(src('services/files.ts')).toContain('MERGE_WINDOW_MS = 10 * 60_000');
    expect(LLM).toContain('(max 50 characters)');
    expect(src('services/access.ts')).toContain('.slice(0, 50)');
  });

  it('the workflow it describes works from start to finish with only a password', async () => {
    const { app } = makeApp(t);
    const p = await newProject(app, (await signUp(app)).cookie, 'Agent playground');
    const h = { ...bearer(p.rw), 'X-Actor-Name': 'claude' };
    const call = (method: 'get' | 'put' | 'post' | 'delete', url: string) => request(app)[method](url).set(h);

    // 1. who am I
    const who = await call('get', '/api/access');
    expect(who.body).toEqual({ project: { id: p.id, name: 'Agent playground' }, level: 'rw', actorName: 'claude' });
    const base = `/api/projects/${who.body.project.id}`;

    // 2. tree and read
    const tree = await call('get', `${base}/tree`);
    expect(tree.body.nodes[0]).toEqual({ path: 'readme.md', kind: 'file', version: 1, size: expect.any(Number) });
    const file = await call('get', `${base}/file?path=readme.md`);
    expect(Object.keys(file.body.file).sort()).toEqual(['content', 'path', 'updatedAt', 'version']);

    // 3. change one file; a stale version is a 409
    const saved = await call('put', `${base}/file`).send({ path: 'readme.md', content: 'by agent', baseVersion: file.body.file.version });
    expect(saved.body).toEqual({ unchanged: false, version: 2, seq: 2, merged: false });
    const stale = await call('put', `${base}/file`).send({ path: 'readme.md', content: 'again', baseVersion: 1 });
    expect([stale.status, stale.body.error.code]).toEqual([409, 'version_conflict']);

    // 4. create, upload a directory, conflict then overwrite
    expect((await call('post', `${base}/files`).send({ path: 'notes/new.md', kind: 'file', content: 'n' })).status).toBe(201);
    const up = { files: [{ path: 'my-dir/sub/a.md', content: 'A' }, { path: 'notes/new.md', content: 'changed' }], folders: ['my-dir/empty'] };
    const conflict = await call('post', `${base}/upload`).send(up);
    expect([conflict.status, conflict.body.error.code, conflict.body.error.details]).toEqual([409, 'conflicts', { paths: ['notes/new.md'] }]);
    const done = await call('post', `${base}/upload`).send({ ...up, overwrite: true });
    expect(done.body).toMatchObject({ created: 1, updated: 1, unchanged: 0, newFolders: 3 });

    // 5. rename a folder, delete a file
    expect((await call('post', `${base}/move`).send({ from: 'my-dir', to: 'docs' })).status).toBe(200);
    expect((await call('delete', `${base}/file?path=notes/new.md`)).status).toBe(200);

    // 6. history shows "pw: claude" and a rollback undoes it all
    const hist = await call('get', `${base}/history`);
    expect(hist.body.changes[0].actor.label).toBe('pw: claude');
    expect(hist.body.changes.map((c: { kind: string }) => c.kind).reverse()).toEqual(['create', 'edit', 'create', 'upload', 'rename', 'delete']); // the refused upload left no entry
    expect(Object.keys(hist.body.changes[0]).sort()).toEqual(['actor', 'createdAt', 'kind', 'seq', 'summary', 'targetSeq', 'updatedAt']);
    const back = await call('post', `${base}/history/1/rollback`);
    expect(back.status).toBe(200);
    expect((await call('get', `${base}/tree`)).body.nodes.map((n: { path: string }) => n.path)).toEqual(['readme.md']);
    const one = await call('get', `${base}/history/${back.body.change.seq}`);
    expect(one.body.change).toMatchObject({ kind: 'rollback', targetSeq: 1 });
    expect(one.body.change.files[0]).toEqual({ path: expect.any(String), kind: expect.any(String), action: expect.any(String) });
  });

  it('a read-only password can read everything it is told it can, and nothing more', async () => {
    const { app } = makeApp(t);
    const p = await newProject(app, (await signUp(app)).cookie);
    const h = bearer(p.ro);
    expect((await request(app).get('/api/access').set(h)).body.level).toBe('ro');
    for (const url of [`/api/projects/${p.id}`, `/api/projects/${p.id}/tree`, `/api/projects/${p.id}/file?path=readme.md`, `/api/projects/${p.id}/history`, `/api/projects/${p.id}/history/1`]) {
      expect((await request(app).get(url).set(h)).status, url).toBe(200);
    }
    const w = await request(app).post(`/api/projects/${p.id}/files`).set(h).send({ path: 'x.md', kind: 'file' });
    expect([w.status, w.body.error.code]).toEqual([403, 'read_only']);
  });
});
