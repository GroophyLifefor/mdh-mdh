import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express, { type Express } from 'express';

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

/**
 * Serves the built website. /p/<anything> is one page (the page reads the project id from the path), and
 * /llm.txt is the agent guide. Dot files are never served.
 */
export function mountStatic(app: Express, dirInput: string) {
  const dir = resolve(dirInput);
  const csp = contentSecurityPolicy(dir);
  const page = (file: string) => (_req: express.Request, res: express.Response) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(dir, file));
  };

  app.use('/_astro', express.static(join(dir, '_astro'), { immutable: true, maxAge: '1y', dotfiles: 'ignore', index: false }));
  app.get('/llm.txt', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('text/plain; charset=utf-8').sendFile(join(dir, 'llm.txt'));
  });
  app.get('/', page('index.html'));
  app.get(/^\/p(?:\/[^/]*)?\/?$/, page('p/index.html'));
  app.use(express.static(dir, {
    dotfiles: 'ignore', index: false, extensions: false,
    setHeaders: (res, path) => { if (path.endsWith('.html')) res.setHeader('Content-Security-Policy', csp); res.setHeader('Cache-Control', 'no-cache'); },
  }));
  app.use((_req, res) => { res.status(404).type('text/plain').send('Not found'); });
}
