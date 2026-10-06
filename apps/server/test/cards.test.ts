// Link cards: the public project name, the <head> tags, and the picture drawn for each project.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createTestDb, type TestDb } from './db';
import { makeApp, newProject, signUp } from './helpers';
import { CARD_HEIGHT, CARD_WIDTH, CardCache, cardSvg, canDraw, layoutTitle, projectCard, renderCard, wrap } from '../src/services/og';
import { MARKER, escapeHtml, fillPage, headTags } from '../src/services/head';

const png = (b: Buffer) => ({ signature: b.subarray(0, 8).toString('hex'), width: b.readUInt32BE(16), height: b.readUInt32BE(20) });
const PNG_SIGNATURE = '89504e470d0a1a0a';
const UNKNOWN = '0197abcd-1234-7000-8000-000000000000';

describe('card text layout', () => {
  it('wraps on words, never makes a line longer than the limit, and loses no characters', () => {
    fc.assert(fc.property(fc.string({ maxLength: 120 }), fc.integer({ min: 5, max: 40 }), (text, max) => {
      const lines = wrap(text, max);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(max);
      expect(lines.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
    }));
  });
  it('a short title gets the big size, a long one shrinks, a huge one is cut with an ellipsis in three lines', () => {
    expect(layoutTitle('Notes')).toMatchObject({ size: 84, lines: ['Notes'] });
    expect(layoutTitle('Quarterly planning notes for the whole team').size).toBeLessThan(84);
    const huge = layoutTitle('word '.repeat(100));
    expect(huge.lines).toHaveLength(3);
    expect(huge.lines[2]!.endsWith('…')).toBe(true);
    const oneWord = layoutTitle('x'.repeat(500));
    expect(oneWord.lines).toHaveLength(3);
  });
  it('draws Latin names (Turkish too) and punctuation; other scripts and emoji get the plain card', () => {
    for (const ok of ['Notes', 'Şirket Ürün Planı', 'v1.2 — draft (final)', "Murat's wiki", 'Q4 / 2026']) expect(canDraw(ok), ok).toBe(true);
    for (const no of ['日本語', 'مشروع', 'Notes 🚀', 'a\u0000b']) expect(canDraw(no), no).toBe(false);
    expect(projectCard('日本語').title).toBe('A shared workspace');
    expect(projectCard('Notes').title).toBe('Notes');
  });
  it('the picture is XML-safe whatever the name contains', () => {
    const svg = cardSvg({ title: '</text><script>alert(1)</script> & "x"', subtitle: 's' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;/text&gt;');
    expect(svg).toContain('&amp;');
  });
});

describe('card picture', () => {
  it('is a real 1200 x 630 PNG', () => {
    expect(png(renderCard(projectCard('Shared notes')))).toEqual({ signature: PNG_SIGNATURE, width: CARD_WIDTH, height: CARD_HEIGHT });
  });
  it('different names give different pictures', () => {
    expect(renderCard(projectCard('Alpha')).equals(renderCard(projectCard('Beta')))).toBe(false);
  });
  it('the cache returns the same bytes, makes each one once and forgets the oldest first', () => {
    const cache = new CardCache(2);
    let made = 0;
    const make = (s: string) => () => { made++; return Buffer.from(s); };
    expect(cache.get('a', make('a')).toString()).toBe('a');
    cache.get('a', make('a2')); expect(made).toBe(1);
    cache.get('b', make('b')); cache.get('a', make('a3')); cache.get('c', make('c'));   // b is the oldest now: evicted
    expect(made).toBe(3);
    cache.get('b', make('b2')); expect(made).toBe(4);
  });
});

describe('head tags', () => {
  const page = { title: 'T', description: 'D', url: 'https://x.test/p/1', image: 'https://x.test/og/1.png', imageAlt: 'A' };
  it('has the Open Graph and Twitter tags with absolute urls', () => {
    const tags = headTags(page);
    for (const needle of ['property="og:title" content="T"', 'property="og:image" content="https://x.test/og/1.png"', 'og:image:width" content="1200"', 'name="twitter:card" content="summary_large_image"', 'property="og:url" content="https://x.test/p/1"']) expect(tags).toContain(needle);
    expect(tags).not.toContain('noindex');
    expect(headTags({ ...page, noindex: true })).toContain('name="robots" content="noindex, nofollow"');
  });
  it('escapes everything: a hostile value cannot leave its attribute', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      const tags = headTags({ ...page, title: s, imageAlt: s });
      expect(tags).not.toMatch(/content="[^"]*"[^>\s]/);                               // no attribute ever ends early
      expect(tags.match(/<meta/g)!.length).toBe(tags.match(/>/g)!.length);              // every tag has exactly one ">" (the one it closes with)
    }));
    expect(escapeHtml(`"><script>&'`)).toBe('&quot;&gt;&lt;script&gt;&amp;&#39;');
  });
  it('fillPage swaps the marker and the title, and treats "$&" in a name as plain text', () => {
    const html = `<head><title>old</title>${MARKER}</head>`;
    expect(fillPage(html, 'TAGS', 'a $& b')).toBe('<head><title>a $&amp; b</title>TAGS</head>');
    expect(fillPage(html, '$&$1')).toBe('<head><title>old</title>$&$1</head>');
    expect(fillPage('<head></head>', 'X')).toBe('<head></head>');
  });
});

describe('over HTTP', () => {
  let t: TestDb;
  let dir: string;
  let owner: Awaited<ReturnType<typeof signUp>>;
  const pages = async (publicUrl?: string, extra = {}) => {
    const { app } = makeApp(t, { staticDir: dir, publicUrl, ...extra });
    owner ??= await signUp(app);
    return app;
  };

  beforeAll(async () => {
    t = await createTestDb();
    dir = await mkdtemp(join(tmpdir(), 'web-'));
    await mkdir(join(dir, 'p'));
    const shell = (body: string) => `<html><head><title>shell</title>${MARKER}</head><body>${body}</body></html>`;
    await writeFile(join(dir, 'index.html'), shell('HOME'));
    await writeFile(join(dir, 'p', 'index.html'), shell('PROJECT'));
  });
  afterAll(async () => { await t.drop(); });

  it('the public endpoint gives the name and nothing else; unknown and malformed ids are 404', async () => {
    const app = await pages();
    const p = await newProject(app, owner.cookie, 'Roadmap 2026');
    const ok = await request(app).get(`/api/projects/${p.id}/public`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ name: 'Roadmap 2026' });
    expect((await request(app).get(`/api/projects/${UNKNOWN}/public`)).status).toBe(404);
    expect((await request(app).get('/api/projects/not-an-id/public')).status).toBe(404);
    expect((await request(app).get(`/api/projects/${p.id}/public`).set('Authorization', 'Bearer rw_garbagegarbagegarbage1')).status).toBe(200);   // credentials are irrelevant
  });

  it('asking too often is limited (429 with Retry-After), per IP', async () => {
    const app = await pages();
    const p = await newProject(app, owner.cookie, 'Busy');
    let last = 200;
    for (let i = 0; i < 121; i++) last = (await request(app).get(`/api/projects/${p.id}/public`)).status;
    expect(last).toBe(429);
    expect((await request(app).get(`/api/projects/${p.id}/public`)).headers['retry-after']).toBeDefined();
  });

  it('a project page carries the name, an absolute card url, noindex, and the escaped name only', async () => {
    const app = await pages('https://mdh.example.com');
    const p = await newProject(app, owner.cookie, '"><script>alert(1)</script> $&');
    const html = (await request(app).get(`/p/${p.id}`)).text;
    expect(html).toContain('PROJECT');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; $&amp;');
    expect(html).toContain(`<meta property="og:image" content="https://mdh.example.com/og/${p.id}.png">`);
    expect(html).toContain(`<meta property="og:url" content="https://mdh.example.com/p/${p.id}">`);
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).not.toContain(MARKER);
    expect(html).not.toMatch(/\bro_|\brw_/);                                           // no password material
  });

  it('without PUBLIC_DOMAIN the address of the request is used; a strange Host header is not trusted', async () => {
    const app = await pages();
    const p = await newProject(app, owner.cookie, 'Hostly');
    const ok = (await request(app).get(`/p/${p.id}`).set('Host', 'wiki.example.org:8080')).text;
    expect(ok).toContain(`content="http://wiki.example.org:8080/og/${p.id}.png"`);
    const bad = (await request(app).get(`/p/${p.id}`).set('Host', 'evil.test"><x')).text;
    expect(bad).not.toContain('evil.test');
    expect(bad).toContain(`content="/og/${p.id}.png"`);
  });

  it('an unknown id, a non-id and the home page get the plain card and never a name', async () => {
    const app = await pages('https://mdh.example.com');
    for (const path of [`/p/${UNKNOWN}`, '/p/whatever', '/p']) {
      const html = (await request(app).get(path)).text;
      expect(html, path).toContain('<title>shell</title>');
      expect(html, path).toContain('content="https://mdh.example.com/og/default.png"');
    }
    const home = (await request(app).get('/')).text;
    expect(home).toContain('content="https://mdh.example.com/og/default.png"');
    expect(home).not.toContain('noindex');
  });

  it('the card picture: PNG for a known project, the default one, 404 for the rest, cached for a few minutes', async () => {
    const app = await pages();
    const p = await newProject(app, owner.cookie, 'Picture me');
    const card = await request(app).get(`/og/${p.id}.png`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(card.status).toBe(200);
    expect(card.headers['content-type']).toBe('image/png');
    expect(card.headers['cache-control']).toBe('public, max-age=300');
    expect(png(card.body as Buffer)).toEqual({ signature: PNG_SIGNATURE, width: 1200, height: 630 });
    expect((await request(app).get('/og/default.png')).status).toBe(200);
    expect((await request(app).get(`/og/${UNKNOWN}.png`)).status).toBe(404);
    expect((await request(app).get('/og/not-an-id.png')).status).toBe(404);
    expect((await request(app).get(`/og/${p.id}.jpg`)).status).toBe(404);
  });

  it('after a rename the page and the picture use the new name', async () => {
    const app = await pages('https://mdh.example.com');
    const p = await newProject(app, owner.cookie, 'Before');
    const first = await request(app).get(`/og/${p.id}.png`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    await t.db.query('UPDATE projects SET name = $1 WHERE id = $2', ['After', p.id]);
    expect((await request(app).get(`/p/${p.id}`)).text).toContain('<title>After · mdh-mdh</title>');
    const second = await request(app).get(`/og/${p.id}.png`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect((first.body as Buffer).equals(second.body as Buffer)).toBe(false);
  });

  it('too many lookups: the page still loads, just without the name; the picture says 429', async () => {
    const app = await pages();
    const p = await newProject(app, owner.cookie, 'Limited');
    for (let i = 0; i < 125; i++) await request(app).get(`/api/projects/${p.id}/public`);
    expect((await request(app).get(`/p/${p.id}`)).text).toContain('<title>shell</title>');
    expect((await request(app).get(`/og/${p.id}.png`)).status).toBe(429);
    expect((await request(app).get('/og/default.png')).status).toBe(200);
  });
});
