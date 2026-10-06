// The permission matrix: every endpoint x every kind of caller, with the expected status written down.
// If a route is added to the app and not listed here (or exempted with a reason), the coverage test fails.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from './db';
import { bearer, gate, makeApp, newProject, signUp } from './helpers';

const ACTORS = ['anonymous', 'owner', 'otherUser', 'rwBearer', 'roBearer', 'rwGate', 'roGate', 'foreignBearer', 'garbageBearer'] as const;
type Actor = (typeof ACTORS)[number];
type Fixture = Awaited<ReturnType<typeof buildFixture>>;

async function buildFixture(t: TestDb) {
  const { app } = makeApp(t);
  const [owner, other] = [await signUp(app), await signUp(app)];
  const p = await newProject(app, owner.cookie, 'Mine');
  const q = await newProject(app, other.cookie, 'Theirs');
  const cookies = { rwGate: await gate(app, p.id, p.rw, 'Sam'), roGate: await gate(app, p.id, p.ro) };
  return { app, owner, other, p, q, cookies };
}

/** Adds the credentials of one kind of caller to a request. */
function as(actor: Actor, fx: Fixture, req: request.Test): request.Test {
  switch (actor) {
    case 'anonymous': return req;
    case 'owner': return req.set('Cookie', fx.owner.cookie);
    case 'otherUser': return req.set('Cookie', fx.other.cookie);
    case 'rwBearer': return req.set(bearer(fx.p.rw));
    case 'roBearer': return req.set(bearer(fx.p.ro));
    case 'rwGate': return req.set('Cookie', fx.cookies.rwGate);
    case 'roGate': return req.set('Cookie', fx.cookies.roGate);
    case 'foreignBearer': return req.set(bearer(fx.q.rw));
    case 'garbageBearer': return req.set(bearer('rw_definitelyNotAPassword1'));
  }
}

type Row = {
  route: string; // the route pattern, as the app registers it
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  url: (fx: Fixture) => string;
  body?: (fx: Fixture) => object;
  expect: Record<Actor, number>;
  /** Rows that change data run every caller against its own fresh project, so one caller cannot affect the next. */
  fresh?: boolean;
  /** Runs before the request, as the owner (e.g. to make a change that can be rolled back). */
  setup?: (fx: Fixture) => Promise<void>;
};

const everyone = (n: number): Record<Actor, number> => Object.fromEntries(ACTORS.map((a) => [a, n])) as Record<Actor, number>;
/** Only the owner (session) may; people with a project password get 403; everyone else is asked for a password. */
const ownerOnly = (ok: number): Record<Actor, number> => ({
  anonymous: 401, owner: ok, otherUser: 401, rwBearer: 403, roBearer: 403, rwGate: 403, roGate: 403, foreignBearer: 401, garbageBearer: 401,
});
/** Anyone with access to the project: the owner or either password. */
const readers = (ok: number): Record<Actor, number> => ({
  anonymous: 401, owner: ok, otherUser: 401, rwBearer: ok, roBearer: ok, rwGate: ok, roGate: ok, foreignBearer: 401, garbageBearer: 401,
});
/** Owner and read-write may; read-only gets 403. */
const writers = (ok: number): Record<Actor, number> => ({ ...readers(ok), roBearer: 403, roGate: 403 });
const signedIn = (ok: number): Record<Actor, number> => ({ ...everyone(401), owner: ok, otherUser: ok });

/** An edit by the owner, so the project has a change #2 to roll back to / from. */
const makeEdit = async (fx: Fixture) => {
  await request(fx.app).put(`/api/projects/${fx.p.id}/file`).set('Cookie', fx.owner.cookie).send({ path: 'readme.md', content: 'edited', baseVersion: 1 });
};

export const ROWS: Row[] = [
  { route: 'GET /api/projects', method: 'get', url: () => '/api/projects', expect: signedIn(200) },
  { route: 'POST /api/projects', method: 'post', url: () => '/api/projects', body: () => ({ name: 'New' }), expect: signedIn(201) },
  { route: 'GET /api/projects/:id', method: 'get', url: (f) => `/api/projects/${f.p.id}`, expect: readers(200) },
  { route: 'PATCH /api/projects/:id', method: 'patch', url: (f) => `/api/projects/${f.p.id}`, body: () => ({ rollbackPolicy: 'author_only' }), expect: ownerOnly(200) },
  { route: 'DELETE /api/projects/:id', method: 'delete', url: (f) => `/api/projects/${f.p.id}`, expect: ownerOnly(200) },
  { route: 'GET /api/projects/:id/passwords', method: 'get', url: (f) => `/api/projects/${f.p.id}/passwords`, expect: ownerOnly(200) },
  { route: 'POST /api/projects/:id/passwords/:mode/refresh', method: 'post', url: (f) => `/api/projects/${f.p.id}/passwords/rw/refresh`, expect: ownerOnly(200) },
  { route: 'POST /api/projects/:id/passwords/:mode/refresh', method: 'post', url: (f) => `/api/projects/${f.p.id}/passwords/ro/refresh`, expect: ownerOnly(200) },
  // the gate is for people without access: it asks only for the password in the body
  { route: 'POST /api/projects/:id/access', method: 'post', url: (f) => `/api/projects/${f.p.id}/access`, body: (f) => ({ password: f.p.ro }), expect: everyone(200) },
  // "who am I" for agents: Bearer only. A valid password of any project works for itself.
  // ---- files and history: read = any access, write = owner or read-write, never read-only ----
  { route: 'GET /api/projects/:id/tree', method: 'get', url: (f) => `/api/projects/${f.p.id}/tree`, expect: readers(200) },
  { route: 'GET /api/projects/:id/file', method: 'get', url: (f) => `/api/projects/${f.p.id}/file?path=readme.md`, expect: readers(200) },
  { route: 'PUT /api/projects/:id/file', method: 'put', url: (f) => `/api/projects/${f.p.id}/file`, body: () => ({ path: 'readme.md', content: 'new text', baseVersion: 1 }), expect: writers(200), fresh: true },
  { route: 'POST /api/projects/:id/files', method: 'post', url: (f) => `/api/projects/${f.p.id}/files`, body: () => ({ path: 'new.md', kind: 'file' }), expect: writers(201), fresh: true },
  { route: 'POST /api/projects/:id/move', method: 'post', url: (f) => `/api/projects/${f.p.id}/move`, body: () => ({ from: 'readme.md', to: 'moved.md' }), expect: writers(200), fresh: true },
  { route: 'DELETE /api/projects/:id/file', method: 'delete', url: (f) => `/api/projects/${f.p.id}/file?path=readme.md`, expect: writers(200), fresh: true },
  { route: 'POST /api/projects/:id/upload', method: 'post', url: (f) => `/api/projects/${f.p.id}/upload`, body: () => ({ files: [{ path: 'u.md', content: 'x' }] }), expect: writers(200), fresh: true },
  { route: 'GET /api/projects/:id/download', method: 'get', url: (f) => `/api/projects/${f.p.id}/download`, expect: readers(200) },
  { route: 'GET /api/projects/:id/download', method: 'get', url: (f) => `/api/projects/${f.p.id}/download?path=readme.md`, expect: readers(200) },
  { route: 'GET /api/projects/:id/history', method: 'get', url: (f) => `/api/projects/${f.p.id}/history`, expect: readers(200) },
  { route: 'GET /api/projects/:id/history/:seq', method: 'get', url: (f) => `/api/projects/${f.p.id}/history/1`, expect: readers(200) },
  { route: 'POST /api/projects/:id/history/:seq/rollback', method: 'post', url: (f) => `/api/projects/${f.p.id}/history/1/rollback`, expect: writers(200), fresh: true, setup: makeEdit },
  { route: 'GET /api/access', method: 'get', url: () => '/api/access', expect: { ...everyone(401), rwBearer: 200, roBearer: 200, foreignBearer: 200 } },
  { route: 'PATCH /api/auth/me', method: 'patch', url: () => '/api/auth/me', body: () => ({ defaultRollbackPolicy: 'author_only' }), expect: signedIn(200) },
  { route: 'GET /api/auth/me', method: 'get', url: () => '/api/auth/me', expect: everyone(200) },
  { route: 'GET /api/config', method: 'get', url: () => '/api/config', expect: everyone(200) },
  { route: 'GET /api/health', method: 'get', url: () => '/api/health', expect: everyone(200) },
];

/** Routes deliberately outside the matrix, and where they are tested instead. */
const EXEMPT: Record<string, string> = {
  'POST /api/auth/register': 'public by design; covered in auth.test.ts',
  'POST /api/auth/login': 'public by design; covered in auth.test.ts',
  'POST /api/auth/logout': 'public by design; covered in auth.test.ts',
};

describe('permission matrix', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.drop(); });

  it('lists every route of the app (a new route must be added to the matrix or exempted)', async () => {
    const { app } = makeApp(t);
    const routes = app.locals.routeTable as string[];
    const covered = new Set([...ROWS.map((r) => r.route), ...Object.keys(EXEMPT)]);
    expect(routes.filter((r) => !covered.has(r)), 'routes missing from the permission matrix').toEqual([]);
    expect([...covered].filter((r) => !routes.includes(r)), 'matrix rows for routes that no longer exist').toEqual([]);
  });

  it('has an expectation for every actor in every row', () => {
    for (const row of ROWS) expect(Object.keys(row.expect).sort(), row.route).toEqual([...ACTORS].sort());
  });

  describe.each(ROWS.map((r) => [`${r.route} ${r.url({ p: { id: ':id' }, q: { id: ':q' } } as never)}`, r] as const))('%s', (_label, row) => {
    it('gives each kind of caller the expected status', async () => {
      const got: Record<string, number> = {};
      let shared: Fixture | undefined;
      // the owner goes last: on shared fixtures DELETE and refresh would otherwise change what the others see
      for (const actor of [...ACTORS.filter((a) => a !== 'owner'), 'owner' as const]) {
        const fx = row.fresh ? await buildFixture(t) : (shared ??= await buildFixture(t));
        if (row.fresh) await row.setup?.(fx);
        const req = request(fx.app)[row.method](row.url(fx));
        const res = await as(actor, fx, req).send(row.body ? row.body(fx) : undefined);
        got[actor] = res.status;
      }
      expect(got).toEqual(row.expect);
    });
  });

  it('a refused request changes nothing', async () => {
    const fx = await buildFixture(t);
    const before = (await t.db.query('SELECT * FROM projects WHERE id = $1', [fx.p.id])).rows[0];
    for (const actor of ['anonymous', 'otherUser', 'rwBearer', 'roBearer', 'foreignBearer', 'garbageBearer'] as const) {
      await as(actor, fx, request(fx.app).delete(`/api/projects/${fx.p.id}`));
      await as(actor, fx, request(fx.app).patch(`/api/projects/${fx.p.id}`)).send({ rollbackPolicy: 'author_only' });
      await as(actor, fx, request(fx.app).post(`/api/projects/${fx.p.id}/passwords/rw/refresh`));
    }
    expect((await t.db.query('SELECT * FROM projects WHERE id = $1', [fx.p.id])).rows[0]).toEqual(before);
  });

  it('answers a missing project and a project you cannot see identically (no way to probe which ids exist)', async () => {
    const fx = await buildFixture(t);
    const missing = await as('otherUser', fx, request(fx.app).get('/api/projects/00000000-0000-7000-8000-000000000000'));
    const hidden = await as('otherUser', fx, request(fx.app).get(`/api/projects/${fx.p.id}`));
    const garbage = await as('otherUser', fx, request(fx.app).get('/api/projects/not-a-uuid'));
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual(hidden.body);
    expect(garbage.body).toEqual(hidden.body);
  });
});
