import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, auth, files, projects } from '../src/lib/api';

type Call = { url: string; init: RequestInit };
const calls: Call[] = [];

function respond(status: number, body?: unknown, headers: Record<string, string> = {}) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(text || null, { status, headers });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

describe('request basics', () => {
  it('returns the parsed JSON of a success', async () => {
    respond(200, { user: { id: '1', username: 'sam', defaultRollbackPolicy: 'author_and_write' } });
    expect(await auth.me()).toEqual({ id: '1', username: 'sam', defaultRollbackPolicy: 'author_and_write' });
  });
  it('sends JSON with a content type only when there is a body, and always the cookie', async () => {
    respond(200, { user: null });
    await auth.me();
    expect(calls[0]!.init.headers).toBeUndefined();
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls[0]!.init.credentials).toBe('same-origin');
    calls.length = 0;
    respond(200, { user: { id: '1' } });
    await auth.login('sam', 'pw');
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ username: 'sam', password: 'pw' });
  });
  it('turns a JSON error into an ApiError with status, code, message and details', async () => {
    respond(409, { error: { code: 'conflicts', message: 'Some files exist', details: { paths: ['a.md'] } } });
    const err = await files.upload('p', { files: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'conflicts', message: 'Some files exist', details: { paths: ['a.md'] } });
  });
  it('reads Retry-After', async () => {
    respond(429, { error: { code: 'too_many_requests', message: 'Try later' } }, { 'retry-after': '42' });
    expect(await auth.login('a', 'b').catch((e) => e)).toMatchObject({ status: 429, retryAfter: 42 });
  });
  it('still makes an ApiError when the error page is not JSON (a proxy, a crash)', async () => {
    respond(502, '<html>Bad gateway</html>');
    const err = await auth.me().catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: 'http_502', message: 'The server answered 502' });
  });
  it('an error JSON with no error field is handled too', async () => {
    respond(500, { oops: true });
    expect(await auth.me().catch((e) => e)).toMatchObject({ status: 500, code: 'http_500' });
  });
  it('reports a network failure as status 0, not as a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = await auth.me().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'network' });
  });
  it('an empty 200 body gives null instead of crashing', async () => {
    respond(200);
    expect(await auth.logout()).toBeNull();
  });
});

describe('each call hits the right endpoint', () => {
  const ID = '0197abcd-1234-7000-8000-000000000000';
  const cases: [string, () => Promise<unknown>, string, string, unknown?][] = [
    ['auth.me', () => auth.me(), 'GET', '/api/auth/me'],
    ['auth.login', () => auth.login('a', 'b'), 'POST', '/api/auth/login', { username: 'a', password: 'b' }],
    ['auth.register', () => auth.register('a', 'b'), 'POST', '/api/auth/register', { username: 'a', password: 'b' }],
    ['auth.logout', () => auth.logout(), 'POST', '/api/auth/logout', {}],
    ['auth.setDefaultPolicy', () => auth.setDefaultPolicy('author_only'), 'PATCH', '/api/auth/me', { defaultRollbackPolicy: 'author_only' }],
    ['projects.list', () => projects.list(), 'GET', '/api/projects'],
    ['projects.create', () => projects.create('N'), 'POST', '/api/projects', { name: 'N' }],
    ['projects.get', () => projects.get(ID), 'GET', `/api/projects/${ID}`],
    ['projects.setPolicy', () => projects.setPolicy(ID, 'author_only'), 'PATCH', `/api/projects/${ID}`, { rollbackPolicy: 'author_only' }],
    ['projects.remove', () => projects.remove(ID), 'DELETE', `/api/projects/${ID}`],
    ['projects.passwords', () => projects.passwords(ID), 'GET', `/api/projects/${ID}/passwords`],
    ['projects.refreshPassword', () => projects.refreshPassword(ID, 'rw'), 'POST', `/api/projects/${ID}/passwords/rw/refresh`, {}],
    ['projects.publicName', () => projects.publicName(ID), 'GET', `/api/projects/${ID}/public`],
    ['projects.openGate', () => projects.openGate(ID, 'pw', 'Sam'), 'POST', `/api/projects/${ID}/access`, { password: 'pw', name: 'Sam' }],
    ['files.tree', () => files.tree(ID), 'GET', `/api/projects/${ID}/tree`],
    ['files.read', () => files.read(ID, 'a b/ü.md'), 'GET', `/api/projects/${ID}/file?path=a+b%2F%C3%BC.md`],
    ['files.save', () => files.save(ID, 'a.md', 'x', 3), 'PUT', `/api/projects/${ID}/file`, { path: 'a.md', content: 'x', baseVersion: 3 }],
    ['files.create', () => files.create(ID, 'a.md', 'file', 'hi'), 'POST', `/api/projects/${ID}/files`, { path: 'a.md', kind: 'file', content: 'hi' }],
    ['files.move', () => files.move(ID, 'a.md', 'b.md'), 'POST', `/api/projects/${ID}/move`, { from: 'a.md', to: 'b.md' }],
    ['files.remove', () => files.remove(ID, 'a&b=c.md'), 'DELETE', `/api/projects/${ID}/file?path=a%26b%3Dc.md`],
    ['files.upload', () => files.upload(ID, { files: [{ path: 'a.md', content: 'x' }], overwrite: true }), 'POST', `/api/projects/${ID}/upload`, { files: [{ path: 'a.md', content: 'x' }], overwrite: true }],
    ['files.history', () => files.history(ID, { limit: 5, before: 9 }), 'GET', `/api/projects/${ID}/history?limit=5&before=9`],
    ['files.history (defaults)', () => files.history(ID), 'GET', `/api/projects/${ID}/history`],
    ['files.change', () => files.change(ID, 7), 'GET', `/api/projects/${ID}/history/7`],
    ['files.rollback', () => files.rollback(ID, 7), 'POST', `/api/projects/${ID}/history/7/rollback`, {}],
  ];
  it.each(cases)('%s', async (_name, call, method, url, body) => {
    respond(200, {});
    await call();
    expect([calls[0]!.init.method, calls[0]!.url]).toEqual([method, url]);
    if (body !== undefined) expect(JSON.parse(calls[0]!.init.body as string)).toEqual(body);
  });

  it('puts a hostile project id in the path safely', async () => {
    respond(200, {});
    await projects.get('../../etc?x=1#y');
    expect(calls[0]!.url).toBe('/api/projects/..%2F..%2Fetc%3Fx%3D1%23y');
  });
  it('leaves undefined fields out of the JSON body', async () => {
    respond(200, {});
    await projects.openGate(ID, 'pw');
    expect(calls[0]!.init.body).toBe(JSON.stringify({ password: 'pw' }));
  });
  it('unwraps the field the page needs', async () => {
    respond(200, { projects: [{ id: 'a' }] });
    expect(await projects.list()).toEqual([{ id: 'a' }]);
    respond(200, { nodes: [{ path: 'a.md' }] });
    expect(await files.tree('x')).toEqual([{ path: 'a.md' }]);
    respond(200, { file: { content: 'c' } });
    expect(await files.read('x', 'a.md')).toEqual({ content: 'c' });
    respond(200, { password: 'rw_new' });
    expect(await projects.refreshPassword('x', 'rw')).toBe('rw_new');
  });
});
