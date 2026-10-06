import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createTestDb, type TestDb } from './db';
import { makeApp } from './helpers';
import { inlineScriptHashes } from '../src/static';

const INLINE = "try { document.documentElement.dataset.theme = 'light'; } catch {}";
const hash = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

describe('website and headers', () => {
  let t: TestDb;
  let dir: string;
  let app: ReturnType<typeof makeApp>['app'];

  beforeAll(async () => {
    t = await createTestDb();
    dir = await mkdtemp(join(tmpdir(), 'web-'));
    await mkdir(join(dir, 'p')); await mkdir(join(dir, '_astro'));
    await writeFile(join(dir, 'index.html'), `<html><head><script>${INLINE}</script></head><body>HOME</body></html>`);
    await writeFile(join(dir, 'p', 'index.html'), `<html><head><script>${INLINE}</script><script type="module" src="/_astro/app.js"></script></head><body>PROJECT PAGE</body></html>`);
    await writeFile(join(dir, 'llm.txt'), 'guide for agents');
    await writeFile(join(dir, '_astro', 'app.js'), 'console.log(1)');
    await writeFile(join(dir, '.env'), 'SECRET=1');
    await writeFile(join(dir, '.hidden.html'), 'hidden');
    app = makeApp(t, { staticDir: dir }).app;
  });
  afterAll(async () => { await t.drop(); });

  it('serves the home page and the agent guide', async () => {
    expect((await request(app).get('/')).text).toContain('HOME');
    const llm = await request(app).get('/llm.txt');
    expect(llm.status).toBe(200);
    expect(llm.headers['content-type']).toMatch(/^text\/plain/);
    expect(llm.text).toBe('guide for agents');
  });

  it.each(['/p', '/p/', '/p/0197abcd-1234-7000-8000-000000000000', '/p/0197abcd-1234-7000-8000-000000000000/', '/p/anything-at-all'])('serves the project page for %s', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.text).toContain('PROJECT PAGE');
  });

  it('does not invent deeper project paths', async () => {
    expect((await request(app).get('/p/abc/def')).status).toBe(404);
    expect((await request(app).get('/p/abc/def/ghi')).status).toBe(404);
  });

  it('keeps /api answering JSON, never the website', async () => {
    const res = await request(app).get('/api/nothing-here');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
  });

  it('serves built assets with long cache, pages and the guide without', async () => {
    expect((await request(app).get('/_astro/app.js')).headers['cache-control']).toMatch(/max-age=31536000.*immutable|immutable.*max-age=31536000/);
    expect((await request(app).get('/')).headers['cache-control']).toBe('no-cache');
    expect((await request(app).get('/llm.txt')).headers['cache-control']).toBe('no-cache');
    expect((await request(app).get('/api/health')).headers['cache-control']).toBe('no-store');
  });

  it('never serves dot files or paths outside the folder', async () => {
    for (const path of ['/.env', '/.hidden.html', '/_astro/../.env', '/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd', '/_astro/%2e%2e/.env', '/p/..%2f..%2f.env']) {
      const res = await request(app).get(path);
      // either refused, or it is just the project page (/p/<anything> is always the page): never the file
      if (res.status < 400) expect(res.text, path).toContain('PROJECT PAGE');
      expect(res.text, path).not.toContain('SECRET=1');
      expect(res.text, path).not.toContain('root:');
    }
  });

  it('answers 404 for unknown paths (plain text)', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  describe('Content-Security-Policy', () => {
    it('allows exactly the inline script that is in the pages, and no other inline script', async () => {
      const csp = (await request(app).get('/')).headers['content-security-policy']!;
      expect(csp).toContain(`script-src 'self' ${hash(INLINE)}`);
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(csp).not.toMatch(/script-src[^;]*unsafe-eval/);
    });
    it('forbids framing, plugins, base tag tricks and other origins', async () => {
      const csp = (await request(app).get('/p/x')).headers['content-security-policy']!;
      for (const part of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "connect-src 'self'"]) expect(csp).toContain(part);
      expect(csp).not.toMatch(/https?:\/\//);
      expect(csp).not.toContain('*');
    });
    it('is sent with the pages (also when asked as a file)', async () => {
      expect((await request(app).get('/p/index.html')).headers['content-security-policy']).toBeTruthy();
    });
    it('a changed inline script changes the policy', async () => {
      const other = await mkdtemp(join(tmpdir(), 'web-'));
      await writeFile(join(other, 'index.html'), '<script>alert(1)</script>');
      expect(inlineScriptHashes(other)).toEqual([hash('alert(1)')]);
      expect(inlineScriptHashes(other)).not.toContain(hash(INLINE));
    });
    it('ignores empty inline scripts and scripts with a src', async () => {
      const other = await mkdtemp(join(tmpdir(), 'web-'));
      await writeFile(join(other, 'index.html'), '<script src="/a.js"></script><script>  </script><script type="module" src="/b.js"></script>');
      expect(inlineScriptHashes(other)).toEqual([]);
    });
  });

  describe('security headers on every response', () => {
    it.each(['/', '/api/health', '/api/nothing', '/llm.txt', '/nope'])('%s', async (path) => {
      const h = (await request(app).get(path)).headers;
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['x-frame-options']).toBe('DENY');
      expect(h['referrer-policy']).toBe('no-referrer');
      expect(h['permissions-policy']).toContain('camera=()');
      expect(h['x-powered-by']).toBeUndefined();
    });
  });

  it('without a website folder the app serves only the API', async () => {
    const { app: apiOnly } = makeApp(t);
    expect((await request(apiOnly).get('/')).status).toBe(404);
    expect((await request(apiOnly).get('/api/health')).status).toBe(200);
  });

  describe('GET /api/config', () => {
    it('says null when no public address is set, and the address when it is', async () => {
      expect((await request(makeApp(t).app).get('/api/config')).body).toEqual({ publicUrl: null });
      expect((await request(makeApp(t, { publicUrl: 'https://mdh.example.com' }).app).get('/api/config')).body).toEqual({ publicUrl: 'https://mdh.example.com' });
    });
    it('needs no login and tells nothing else', async () => {
      const res = await request(makeApp(t, { publicUrl: 'https://mdh.example.com' }).app).get('/api/config');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['publicUrl']);
    });
  });
});
