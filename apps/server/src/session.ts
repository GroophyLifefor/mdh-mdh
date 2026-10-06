import { createHmac, timingSafeEqual } from 'node:crypto';

/** Signed, expiring token: `base64url(json).base64url(hmac)`. Stateless, so it cannot be revoked before it expires. */
export function signToken(key: Buffer, payload: Record<string, unknown>, now: Date, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(now.getTime() / 1000) + ttlSeconds })).toString('base64url');
  const mac = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** Returns the payload, or null for anything wrong: bad shape, bad signature, expired. Never throws. */
export function verifyToken<T extends Record<string, unknown>>(key: Buffer, token: string | undefined, now: Date): T | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  const expected = createHmac('sha256', key).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: unknown };
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now.getTime()) return null;
    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = 'mdh_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;
