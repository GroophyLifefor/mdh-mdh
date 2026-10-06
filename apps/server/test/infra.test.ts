import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createTestDb, type TestDb } from './db';
import { migrate } from '../src/migrate';
import { withTx } from '../src/db';
import { createApp } from '../src/app';
import { loadConfig, parsePublicDomain } from '../src/config';

describe('test infrastructure', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.drop(); });

  it('runs PostgreSQL 18 with a working uuidv7()', async () => {
    const { rows: [v] } = await t.db.query<{ v: string }>("SELECT current_setting('server_version') AS v");
    expect(Number(v!.v.split('.')[0])).toBeGreaterThanOrEqual(18);
    const { rows: [u] } = await t.db.query<{ id: string; ver: number }>('SELECT uuidv7() AS id, uuid_extract_version(uuidv7()) AS ver');
    expect(u!.ver).toBe(7);
    expect(u!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('uuidv7 values generated one after another sort in creation order', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) ids.push((await t.db.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(50);
  });

  it('gives every test its own database', async () => {
    const other = await createTestDb();
    await t.db.query('CREATE TABLE only_here (x int)');
    const { rows } = await other.db.query("SELECT to_regclass('only_here') AS r");
    expect(rows[0]!.r).toBeNull();
    await other.drop();
  });

  it('migrate() applies new files once and is repeatable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'));
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE mig_a (id int);');
    await writeFile(join(dir, '0002_b.sql'), 'CREATE TABLE mig_b (id int);');
    expect(await migrate(t.db, dir)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(await migrate(t.db, dir)).toEqual([]);
    await writeFile(join(dir, '0003_c.sql'), 'CREATE TABLE mig_c (id int);');
    expect(await migrate(t.db, dir)).toEqual(['0003_c.sql']);
  });

  it('a failing migration changes nothing and names the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'));
    await writeFile(join(dir, '0001_bad.sql'), 'CREATE TABLE half_done (id int); SELECT nope;');
    await expect(migrate(t.db, dir)).rejects.toThrow(/0001_bad\.sql/);
    const { rows } = await t.db.query("SELECT to_regclass('half_done') AS r");
    expect(rows[0]!.r).toBeNull();
  });

  it('withTx rolls back on error and commits on success', async () => {
    await t.db.query('CREATE TABLE tx_probe (n int)');
    await expect(withTx(t.db, async (tx) => { await tx.query('INSERT INTO tx_probe VALUES (1)'); throw new Error('boom'); })).rejects.toThrow('boom');
    await withTx(t.db, (tx) => tx.query('INSERT INTO tx_probe VALUES (2)'));
    const { rows } = await t.db.query<{ n: number }>('SELECT n FROM tx_probe');
    expect(rows).toEqual([{ n: 2 }]);
  });

  it('serves /api/health and JSON 404s for unknown api paths', async () => {
    const app = createApp({ db: t.db, secret: "s".repeat(32) });
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('turns malformed JSON into a 400, not a crash', async () => {
    const app = createApp({ db: t.db, secret: "s".repeat(32) });
    const res = await request(app).post('/api/anything').set('content-type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_json');
  });
});

describe('PUBLIC_DOMAIN', () => {
  it.each([
    ['mdh.example.com', 'https://mdh.example.com'],
    ['  MDH.Example.com  ', 'https://mdh.example.com'],
    ['https://mdh.example.com', 'https://mdh.example.com'],
    ['https://mdh.example.com/', 'https://mdh.example.com'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['localhost:3000', 'https://localhost:3000'],
    ['192.168.1.20:8080', 'https://192.168.1.20:8080'],
    ['https://mdh.example.com:443', 'https://mdh.example.com'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
    ['xn--tkce-2ya.example', 'https://xn--tkce-2ya.example'],
  ])('accepts %s as %s', (raw, origin) => {
    expect(parsePublicDomain(raw)).toBe(origin);
  });

  it.each(['', '   ', 'ftp://example.com', 'https://example.com/app', 'https://example.com?x=1', 'https://example.com#top', 'https://user:pw@example.com', 'not a domain', 'https://', '//example.com', 'javascript:alert(1)', 'mdh.example.com/path'])('refuses %j with an explanation', (raw) => {
    expect(() => parsePublicDomain(raw)).toThrow(/PUBLIC_DOMAIN .* is not valid\. Use a domain like mdh\.example\.com/);
  });

  const ok = { DATABASE_URL: 'postgres://x', APP_SECRET: 'x'.repeat(32) };
  it('is optional: without it nothing is set and cookies are not forced to Secure', () => {
    const c = loadConfig(ok);
    expect(c.PUBLIC_URL).toBeUndefined();
    expect(c.COOKIE_SECURE).toBe(false);
  });
  it('an empty value counts as not set', () => {
    expect(loadConfig({ ...ok, PUBLIC_DOMAIN: '  ' }).PUBLIC_URL).toBeUndefined();
  });
  it('an https address turns Secure cookies on by itself; an http address does not', () => {
    expect(loadConfig({ ...ok, PUBLIC_DOMAIN: 'mdh.example.com' })).toMatchObject({ PUBLIC_URL: 'https://mdh.example.com', COOKIE_SECURE: true });
    expect(loadConfig({ ...ok, PUBLIC_DOMAIN: 'http://localhost:3000' })).toMatchObject({ PUBLIC_URL: 'http://localhost:3000', COOKIE_SECURE: false });
  });
  it('there is no separate COOKIE_SECURE setting: a value in the environment changes nothing', () => {
    expect(loadConfig({ ...ok, PUBLIC_DOMAIN: 'mdh.example.com', COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(true);
  });
  it('a bad value stops the server with a readable message that also lists the other problems', () => {
    expect(() => loadConfig({ PUBLIC_DOMAIN: 'https://x.com/app' })).toThrow(/DATABASE_URL[\s\S]*PUBLIC_DOMAIN/);
    expect(() => loadConfig({ ...ok, PUBLIC_DOMAIN: 'ftp://x.com' })).toThrow(/Invalid configuration[\s\S]*PUBLIC_DOMAIN "ftp:\/\/x\.com" is not valid/);
  });
});

describe('loadConfig', () => {
  const ok = { DATABASE_URL: 'postgres://x', APP_SECRET: 'x'.repeat(32) };
  it('accepts a valid environment and applies defaults', () => {
    expect(loadConfig(ok)).toEqual({ ...ok, PORT: 3000, COOKIE_SECURE: false, TRUST_PROXY: false, PUBLIC_URL: undefined });
  });
  it('refuses a short APP_SECRET', () => {
    expect(() => loadConfig({ ...ok, APP_SECRET: 'short' })).toThrow(/APP_SECRET/);
  });
  it('lists every problem at once', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*APP_SECRET/);
  });
  it('parses PORT', () => {
    expect(loadConfig({ ...ok, PORT: '8080' })).toMatchObject({ PORT: 8080 });
    expect(() => loadConfig({ ...ok, PORT: '99999' })).toThrow(/PORT/);
  });
});
