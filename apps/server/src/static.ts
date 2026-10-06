import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express, { type Express } from 'express';
import type { Ctx } from './context';
import { publicName, countLookup as projectsCount } from './services/projects';
import { CardCache, DEFAULT_CARD, projectCard, renderCard, type Card } from './services/og';
import { SAFE_HOST, SAFE_HOST_V6, fillPage, headTags } from './services/head';

/** sha256 of every inline <script> in the built pages, so the CSP can allow exactly those and no other inline script. */
export function inlineScriptHashes(dir: string): string[] {
  const hashes = new Set<string>();
  for (const file of ['index.html', 'p/index.html']) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const html = readFileSync(path, 'utf8');
    for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      if (m[1]!.trim()) hashes.add(`'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`);
    }
  }
  return [...hashes];
}

export function contentSecurityPolicy(dir: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(dir).join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'", // the page sets sizes with style attributes
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PROJECT_PAGE = new RegExp(`^/p(?:/(${UUID}|[^/]*))?/?$`);
const CARD_PATH = new RegExp(`^/og/(default|${UUID})\\.png$`);
const TAGLINE = 'Markdown and YAML workspaces. Share with a password. Roll back anything.';
const PROJECT_DESCRIPTION = 'Shared workspace on mdh-mdh. Open the link and enter the password.';

/** The address people use: PUBLIC_DOMAIN when set, else the one in this request (a plausible host name only). */
function originOf(req: express.Request, publicUrl?: string): string {
  if (publicUrl) return publicUrl;
  const host = req.host;
  return host && (SAFE_HOST.test(host) || SAFE_HOST_V6.test(host)) ? `${req.protocol}://${host}` : '';
}

/**
 * Serves the built website. /p/<anything> is one page (the page reads the project id from the path), and
 * /llm.txt is the agent guide. Dot files are never served. The pages get their link-card tags here, because they
 * need the address of the site and, for a project, its name (the name is public to whoever knows the id).
 */
export function mountStatic(app: Express, dirInput: string, opts: { ctx: Ctx; publicUrl?: string }) {
  const dir = resolve(dirInput);
  const csp = contentSecurityPolicy(dir);
  const { ctx, publicUrl } = opts;
  const cards = new CardCache();
  const html = (file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : '');
  const pages = { home: html('index.html'), project: html('p/index.html') };

  const send = (res: express.Response, body: string) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(body);
  };

  app.use('/_astro', express.static(join(dir, '_astro'), { immutable: true, maxAge: '1y', dotfiles: 'ignore', index: false }));
  app.get('/llm.txt', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('text/plain; charset=utf-8').sendFile(join(dir, 'llm.txt'));
  });

  app.get('/', (req, res) => {
    const origin = originOf(req, publicUrl);
    send(res, fillPage(pages.home, headTags({
      title: 'mdh-mdh', description: TAGLINE, url: `${origin}/`, image: `${origin}/og/default.png`, imageAlt: 'mdh-mdh',
    })));
  });

  app.get(PROJECT_PAGE, async (req, res, next) => {
    try {
      const origin = originOf(req, publicUrl);
      const id = PROJECT_PAGE.exec(req.path)?.[1];
      let name: string | null = null;
      if (id && new RegExp(`^${UUID}$`).test(id) && !ctx.limits.lookups.isLimited(req.ip ?? '')) {
        ctx.limits.lookups.hit(req.ip ?? '');
        name = await publicName(ctx, id);
      }
      send(res, fillPage(pages.project, headTags({
        title: name !== null ? `${name} · mdh-mdh` : 'Project · mdh-mdh',
        description: PROJECT_DESCRIPTION,
        url: name !== null ? `${origin}/p/${id}` : `${origin}/p`,
        image: name !== null ? `${origin}/og/${id}.png` : `${origin}/og/default.png`,
        imageAlt: name ?? 'mdh-mdh',
        noindex: true,
      }), name !== null ? `${name} · mdh-mdh` : undefined));
    } catch (e) { next(e); }
  });

  // the link-card picture: drawn on request, kept in memory; an unknown project id never costs a render
  app.get(CARD_PATH, async (req, res, next) => {
    try {
      const id = CARD_PATH.exec(req.path)![1]!;
      let key = 'default', card: Card = DEFAULT_CARD;
      if (id !== 'default') {
        projectsCount(ctx, req.ip ?? '');
        const name = await publicName(ctx, id);
        if (name === null) { res.status(404).type('text/plain').send('Not found'); return; }
        card = projectCard(name);
        key = `${id}\n${name}`;
      }
      const png = cards.get(key, () => renderCard(card));
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.type('png').send(png);
    } catch (e) { next(e); }
  });

  app.use(express.static(dir, {
    dotfiles: 'ignore', index: false, extensions: false,
    setHeaders: (res, path) => { if (path.endsWith('.html')) res.setHeader('Content-Security-Policy', csp); res.setHeader('Cache-Control', 'no-cache'); },
  }));
  app.use((_req, res) => { res.status(404).type('text/plain').send('Not found'); });
}
