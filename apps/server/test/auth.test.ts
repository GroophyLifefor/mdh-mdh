import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from './db';
import { cookieHeader, makeApp, setCookies } from './helpers';
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from '../src/session';
import { DEFAULT_SCRYPT } from '../src/crypto';

describe('auth', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.drop(); });

  const post = (app: ReturnType<typeof makeApp>['app'], path: string, body: unknown, cookie = '') =>
    request(app).post(path).set('Cookie', cookie).send(body as object);

  describe('register', () => {
    it('creates the account, signs in and returns the user without any secret', async () => {
      const { app } = makeApp(t);
      const res = await post(app, '/api/auth/register', { username: 'alice', password: 'longenough' });
      expect(res.status).toBe(201);
      expect(res.body.user).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), username: 'alice', defaultRollbackPolicy: 'author_and_write' });
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash|scrypt/i);
      const me = await request(app).get('/api/auth/me').set('Cookie', cookieHeader(res));
      expect(me.body.user.username).toBe('alice');
    });

    it('sets a session cookie that is HttpOnly, SameSite=Lax, site-wide and expires in 30 days', async () => {
      const { app } = makeApp(t);
      const res = await post(app, '/api/auth/register', { username: 'cookie1', password: 'longenough' });
      const c = setCookies(res).find((x) => x.startsWith(SESSION_COOKIE + '='))!;
      expect(c).toContain('HttpOnly');
      expect(c).toContain('SameSite=Lax');
      expect(c).toContain('Path=/');
      expect(c).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
      expect(c).not.toContain('Secure');
    });

    it('adds Secure when configured', async () => {
      const { app } = makeApp(t, { cookieSecure: true });
      const res = await post(app, '/api/auth/register', { username: 'cookie2', password: 'longenough' });
      expect(setCookies(res)[0]).toContain('Secure');
    });

    it('stores a scrypt hash, never the password', async () => {
      const { app } = makeApp(t);
      await post(app, '/api/auth/register', { username: 'stored', password: 'my-secret-pw' });
      const { rows } = await t.db.query('SELECT password_hash FROM users WHERE username = $1', ['stored']);
      expect(rows[0].password_hash).toMatch(/^scrypt\$/);
      expect(rows[0].password_hash).not.toContain('my-secret-pw');
    });

    it('lowercases and trims the username', async () => {
      const { app } = makeApp(t);
      const res = await post(app, '/api/auth/register', { username: '  MixedCase  ', password: 'longenough' });
      expect(res.body.user.username).toBe('mixedcase');
    });

    it('treats a different capitalisation as the same (taken) username', async () => {
      const { app } = makeApp(t);
      await post(app, '/api/auth/register', { username: 'taken1', password: 'longenough' });
      const res = await post(app, '/api/auth/register', { username: 'TAKEN1', password: 'otherpassword' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('username_taken');
    });

    it('requires at least 8 characters: 7 fails, 8 works', async () => {
      const { app } = makeApp(t);
      const short = await post(app, '/api/auth/register', { username: 'pwlen', password: '1234567' });
      expect(short.status).toBe(400);
      expect(short.body.error.details.fields.password).toMatch(/8 characters/);
      expect((await post(app, '/api/auth/register', { username: 'pwlen', password: '12345678' })).status).toBe(201);
    });

    it('refuses an over-long password (cheap protection against huge hashing work)', async () => {
      const { app } = makeApp(t);
      expect((await post(app, '/api/auth/register', { username: 'pwmax', password: 'x'.repeat(201) })).status).toBe(400);
    });

    it.each([
      ['too short', 'ab'], ['too long', 'x'.repeat(33)], ['space inside', 'a b c'], ['at sign', 'a@b.com'], ['slash', 'a/b/c'], ['empty', ''],
    ])('refuses a username that is %s', async (_n, username) => {
      const { app } = makeApp(t);
      const res = await post(app, '/api/auth/register', { username, password: 'longenough' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_input');
      expect(res.body.error.details.fields.username).toBeTruthy();
    });

    it.each([
      ['no body', undefined], ['array', []], ['numbers', { username: 5, password: 5 }], ['null fields', { username: null, password: null }], ['missing password', { username: 'validname' }],
    ])('answers 400, not 500, for %s', async (_n, body) => {
      const { app } = makeApp(t);
      const res = await request(app).post('/api/auth/register').send(body as object);
      expect(res.status).toBe(400);
    });

    it('creates exactly one account when the same username races', async () => {
      const { app } = makeApp(t);
      const results = await Promise.all(Array.from({ length: 5 }, () => post(app, '/api/auth/register', { username: 'racer1', password: 'longenough' })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
      expect(Number((await t.db.query("SELECT count(*) FROM users WHERE username = 'racer1'")).rows[0].count)).toBe(1);
    });

    it('limits sign-ups per IP: 20 allowed, the 21st gets 429 with Retry-After', async () => {
      const { app } = makeApp(t);
      for (let i = 0; i < 20; i++) expect((await post(app, '/api/auth/register', { username: `bulk${i}`.padEnd(5, '0'), password: 'longenough' })).status).toBe(201);
      const res = await post(app, '/api/auth/register', { username: 'bulk-over', password: 'longenough' });
      expect(res.status).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(res.body.error.code).toBe('too_many_requests');
    });
  });

  describe('login', () => {
    const setup = async () => {
      const ctx = makeApp(t);
      await post(ctx.app, '/api/auth/register', { username: 'bob' + Math.random().toString(36).slice(2, 8), password: 'bobs-password' }).then((r) => (ctx as { user?: string }).user = r.body.user.username);
      return ctx as ReturnType<typeof makeApp> & { user: string };
    };

    it('signs in with the right password (username is case-insensitive)', async () => {
      const { app, user } = await setup();
      const res = await post(app, '/api/auth/login', { username: user.toUpperCase(), password: 'bobs-password' });
      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe(user);
      expect(setCookies(res)[0]).toContain(SESSION_COOKIE);
    });

    it('gives the same answer for a wrong password and an unknown user', async () => {
      const { app, user } = await setup();
      const wrong = await post(app, '/api/auth/login', { username: user, password: 'nope-nope' });
      const unknown = await post(app, '/api/auth/login', { username: 'ghost-user', password: 'nope-nope' });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);
      expect(setCookies(wrong)).toEqual([]);
    });

    it('takes about as long for an unknown user as for a wrong password (no username probing by timing)', async () => {
      const { app } = makeApp(t, { scryptCost: DEFAULT_SCRYPT }); // real cost, so the difference is large
      await post(app, '/api/auth/register', { username: 'timing1', password: 'bobs-password' });
      const time = async (username: string) => {
        const t0 = performance.now();
        await post(app, '/api/auth/login', { username, password: 'wrong-wrong' });
        return performance.now() - t0;
      };
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      const known: number[] = [], unknown: number[] = [];
      for (let i = 0; i < 5; i++) { known.push(await time('timing1')); unknown.push(await time('ghost-user')); }
      expect(median(unknown)).toBeGreaterThan(median(known) * 0.5);
    });

    it('does not accept a password that only starts like the real one', async () => {
      const { app, user } = await setup();
      expect((await post(app, '/api/auth/login', { username: user, password: 'bobs-passwor' })).status).toBe(401);
      expect((await post(app, '/api/auth/login', { username: user, password: 'bobs-password ' })).status).toBe(401);
    });

    it('locks an IP out after 10 failures, even for the right password, then recovers', async () => {
      const { app, clock, user } = await setup();
      for (let i = 0; i < 10; i++) expect((await post(app, '/api/auth/login', { username: user, password: 'wrong-pw-' + i })).status).toBe(401);
      const locked = await post(app, '/api/auth/login', { username: user, password: 'bobs-password' });
      expect(locked.status).toBe(429);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      clock.advance(15 * 60_000 + 1000);
      expect((await post(app, '/api/auth/login', { username: user, password: 'bobs-password' })).status).toBe(200);
    });

    it('a successful login resets the failure count', async () => {
      const { app, user } = await setup();
      for (let i = 0; i < 9; i++) await post(app, '/api/auth/login', { username: user, password: 'wrong-pw-' + i });
      expect((await post(app, '/api/auth/login', { username: user, password: 'bobs-password' })).status).toBe(200);
      for (let i = 0; i < 9; i++) expect((await post(app, '/api/auth/login', { username: user, password: 'wrong-pw-' + i })).status).toBe(401);
    });
  });

  describe('session', () => {
    it('/me is 200 with user null when nobody is signed in', async () => {
      const { app } = makeApp(t);
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ user: null });
    });

    it('rejects a tampered cookie', async () => {
      const { app } = makeApp(t);
      const reg = await post(app, '/api/auth/register', { username: 'tamper1', password: 'longenough' });
      const value = decodeURIComponent(cookieHeader(reg).split('=')[1]!);
      const [body, mac] = value.split('.') as [string, string];
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), uid: '019a0000-0000-7000-8000-000000000000' })).toString('base64url');
      for (const bad of [`${forged}.${mac}`, `${body}.${mac.slice(0, -2)}xx`, 'garbage', '']) {
        const res = await request(app).get('/api/auth/me').set('Cookie', `${SESSION_COOKIE}=${encodeURIComponent(bad)}`);
        expect(res.body.user, bad).toBeNull();
      }
    });

    it('stops working after 30 days', async () => {
      const { app, clock } = makeApp(t);
      const reg = await post(app, '/api/auth/register', { username: 'expire1', password: 'longenough' });
      const c = cookieHeader(reg);
      clock.advanceSeconds(SESSION_TTL_SECONDS - 1);
      expect((await request(app).get('/api/auth/me').set('Cookie', c)).body.user).not.toBeNull();
      clock.advanceSeconds(2);
      expect((await request(app).get('/api/auth/me').set('Cookie', c)).body.user).toBeNull();
    });

    it('stops working when the user no longer exists', async () => {
      const { app } = makeApp(t);
      const reg = await post(app, '/api/auth/register', { username: 'gone1', password: 'longenough' });
      await t.db.query("DELETE FROM users WHERE username = 'gone1'");
      expect((await request(app).get('/api/auth/me').set('Cookie', cookieHeader(reg))).body.user).toBeNull();
    });

    it('a cookie made with another APP_SECRET is refused', async () => {
      const a = makeApp(t);
      const reg = await post(a.app, '/api/auth/register', { username: 'secret1', password: 'longenough' });
      const b = makeApp(t, { secret: 'a-completely-different-secret-value!!' });
      expect((await request(b.app).get('/api/auth/me').set('Cookie', cookieHeader(reg))).body.user).toBeNull();
    });

    it('logout clears the cookie', async () => {
      const { app } = makeApp(t);
      const res = await post(app, '/api/auth/logout', {});
      expect(res.status).toBe(200);
      expect(setCookies(res)[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`));
    });
  });

  describe('profile', () => {
    it('updates the default rollback policy and keeps it', async () => {
      const { app } = makeApp(t);
      const reg = await post(app, '/api/auth/register', { username: 'prof1', password: 'longenough' });
      const c = cookieHeader(reg);
      const res = await request(app).patch('/api/auth/me').set('Cookie', c).send({ defaultRollbackPolicy: 'author_only' });
      expect(res.status).toBe(200);
      expect(res.body.user.defaultRollbackPolicy).toBe('author_only');
      expect((await request(app).get('/api/auth/me').set('Cookie', c)).body.user.defaultRollbackPolicy).toBe('author_only');
    });
    it('refuses an unknown policy, unknown fields and an empty patch is harmless', async () => {
      const { app } = makeApp(t);
      const c = cookieHeader(await post(app, '/api/auth/register', { username: 'prof2', password: 'longenough' }));
      expect((await request(app).patch('/api/auth/me').set('Cookie', c).send({ defaultRollbackPolicy: 'anyone' })).status).toBe(400);
      expect((await request(app).patch('/api/auth/me').set('Cookie', c).send({ username: 'hacker' })).status).toBe(400);
      expect((await request(app).patch('/api/auth/me').set('Cookie', c).send({})).status).toBe(200);
    });
    it('needs a signed-in user', async () => {
      const { app } = makeApp(t);
      expect((await request(app).patch('/api/auth/me').send({ defaultRollbackPolicy: 'author_only' })).status).toBe(401);
    });
  });

  describe('request safety', () => {
    it('refuses a write from another site (Origin does not match Host)', async () => {
      const { app } = makeApp(t);
      const res = await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ username: 'x', password: 'y' });
      expect(res.status).toBe(403);
    });
    it('refuses Origin: null and a malformed Origin', async () => {
      const { app } = makeApp(t);
      expect((await request(app).post('/api/auth/logout').set('Origin', 'null').send({})).status).toBe(403);
      expect((await request(app).post('/api/auth/logout').set('Origin', '::not a url::').send({})).status).toBe(403);
    });
    it('accepts a write whose Origin matches Host, and one with no Origin (curl)', async () => {
      const { app } = makeApp(t);
      expect((await request(app).post('/api/auth/logout').set('Host', 'mdh.test').set('Origin', 'http://mdh.test').send({})).status).toBe(200);
      expect((await request(app).post('/api/auth/logout').send({})).status).toBe(200);
    });
    it('behind a trusted proxy the forwarded host counts (the proxy changed Host)', async () => {
      const { app } = makeApp(t, { trustProxy: true });
      const res = await request(app).post('/api/auth/logout').set('Host', 'app.internal:3000').set('X-Forwarded-Host', 'mdh.example.com').set('Origin', 'https://mdh.example.com').send({});
      expect(res.status).toBe(200);
      const wrong = await request(app).post('/api/auth/logout').set('Host', 'mdh.example.com').set('X-Forwarded-Host', 'app.internal:3000').set('Origin', 'https://mdh.example.com').send({});
      expect(wrong.status).toBe(403);
    });
    it('without a trusted proxy a forged X-Forwarded-Host changes nothing', async () => {
      const { app } = makeApp(t); // trustProxy off
      const forged = await request(app).post('/api/auth/logout').set('Host', 'mdh.test').set('X-Forwarded-Host', 'evil.example').set('Origin', 'https://evil.example').send({});
      expect(forged.status).toBe(403);
      const normal = await request(app).post('/api/auth/logout').set('Host', 'mdh.test').set('X-Forwarded-Host', 'evil.example').set('Origin', 'http://mdh.test').send({});
      expect(normal.status).toBe(200);
    });
    it('the configured public address is accepted even when a proxy changed Host, and only that address', async () => {
      const { app } = makeApp(t, { publicUrl: 'https://mdh.example.com' });
      const viaProxy = await request(app).post('/api/auth/logout').set('Host', 'app.internal:3000').set('Origin', 'https://mdh.example.com').send({});
      expect(viaProxy.status).toBe(200);
      for (const origin of ['https://evil.example', 'http://mdh.example.com', 'https://mdh.example.com.evil.example', 'https://sub.mdh.example.com', 'https://mdh.example.com:8443']) {
        const res = await request(app).post('/api/auth/logout').set('Host', 'app.internal:3000').set('Origin', origin).send({});
        expect(res.status, origin).toBe(403);
      }
    });
    it('without a public address a proxy-changed Host is still refused (nothing is trusted by default)', async () => {
      const { app } = makeApp(t);
      const res = await request(app).post('/api/auth/logout').set('Host', 'app.internal:3000').set('Origin', 'https://mdh.example.com').send({});
      expect(res.status).toBe(403);
    });
    it('still allows GET from anywhere', async () => {
      const { app } = makeApp(t);
      expect((await request(app).get('/api/auth/me').set('Origin', 'https://evil.example')).status).toBe(200);
    });
    it('answers 400 for broken JSON and 413 for a body over 10 MB', async () => {
      const { app } = makeApp(t);
      expect((await request(app).post('/api/auth/login').set('content-type', 'application/json').send('{"a":')).status).toBe(400);
      const big = await request(app).post('/api/auth/login').set('content-type', 'application/json').send(JSON.stringify({ username: 'x', password: 'x'.repeat(11 * 1024 * 1024) }));
      expect(big.status).toBe(413);
    });
    it('ignores a form-encoded body (JSON only)', async () => {
      const { app } = makeApp(t);
      const res = await request(app).post('/api/auth/login').type('form').send({ username: 'x', password: 'y' });
      expect(res.status).toBe(400);
    });
    it('never leaks internals in an error body', async () => {
      const { app } = makeApp(t);
      const res = await request(app).post('/api/auth/register').send({ username: "x'; DROP TABLE users;--", password: 'longenough' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toMatch(/stack|node_modules|pg_|SELECT|at \w+ \(/);
      expect(Number((await t.db.query('SELECT count(*) FROM users')).rows[0].count)).toBeGreaterThan(0);
    });
  });
});
