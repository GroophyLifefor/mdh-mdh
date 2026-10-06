import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { badRequest, forbidden } from './errors';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue; // first one wins
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore a cookie we cannot decode */
    }
  }
  return out;
}

export function setCookie(res: Response, name: string, value: string, opts: { maxAgeSeconds: number; secure: boolean }) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${opts.maxAgeSeconds}; HttpOnly; SameSite=Lax${opts.secure ? '; Secure' : ''}`);
}

export function clearCookie(res: Response, name: string, secure: boolean) {
  setCookie(res, name, '', { maxAgeSeconds: 0, secure });
}

export const hasBearer = (req: Request) => /^Bearer\s/i.test(req.headers.authorization ?? '');
export const bearerToken = (req: Request): string | null => /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;

/**
 * CSRF guard for cookie-authenticated writes. Browsers always send Origin on cross-site POST/PUT/PATCH/DELETE,
 * so a foreign Origin is refused. Bearer requests carry no cookie and are exempt.
 */
export const originCheck = (publicUrl?: string) => (req: Request, _res: Response, next: NextFunction) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || hasBearer(req)) return next();
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let host: string;
    try { host = new URL(origin).host; } catch { return next(forbidden('Bad Origin header')); }
    if (publicUrl && origin === publicUrl) return next();   // the configured public address always counts, whatever Host a proxy sends
    // req.host follows X-Forwarded-Host only when TRUST_PROXY is on, so a forged header cannot pass the check
    if (host !== req.host) return next(forbidden('Cross-site request refused'));
  } else if (origin === 'null') {
    return next(forbidden('Cross-site request refused'));
  }
  next();
};

/** Parses req.body with a zod schema; failures become a 400 listing which fields are wrong. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const issue of r.error.issues) fields[issue.path.join('.') || '_'] ??= issue.message;
  throw badRequest('invalid_input', Object.values(fields)[0] ?? 'Invalid input', { fields });
}
