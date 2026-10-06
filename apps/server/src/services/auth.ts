import { z } from 'zod';
import type { Request, Response } from 'express';
import type { Ctx } from '../context';
import { hashPassword, verifyPassword } from '../crypto';
import { signToken, verifyToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../session';
import { conflict, tooManyRequests, unauthorized } from '../errors';
import { clearCookie, parseCookies, setCookie } from '../http';

export type Policy = 'author_only' | 'author_and_write';
export type User = { id: string; username: string; defaultRollbackPolicy: Policy };

export const usernameSchema = z
  .string({ error: 'Enter a username' })
  .trim()
  .transform((s) => s.toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_.-]{3,32}$/, 'Username: 3-32 letters, numbers, dot, dash or underscore'));

export const passwordSchema = z
  .string({ error: 'Enter a password' })
  .min(8, 'Password needs at least 8 characters')
  .max(200, 'Password is too long');

export const policySchema = z.enum(['author_only', 'author_and_write']);

type Row = { id: string; username: string; default_rollback_policy: Policy; password_hash: string };
const toUser = (r: Row): User => ({ id: r.id, username: r.username, defaultRollbackPolicy: r.default_rollback_policy });

export async function register(ctx: Ctx, ip: string, input: { username: string; password: string }): Promise<User> {
  if (ctx.limits.register.isLimited(ip)) throw tooManyRequests(ctx.limits.register.retryAfterSeconds(ip));
  ctx.limits.register.hit(ip);
  const hash = await hashPassword(input.password, ctx.scryptCost);
  const { rows } = await ctx.db.query<Row>(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2)
     ON CONFLICT (username) DO NOTHING
     RETURNING id, username, default_rollback_policy, password_hash`,
    [input.username, hash],
  );
  if (!rows[0]) throw conflict('username_taken', 'That username is taken');
  return toUser(rows[0]);
}

export async function login(ctx: Ctx, ip: string, input: { username: string; password: string }): Promise<User> {
  if (ctx.limits.login.isLimited(ip)) throw tooManyRequests(ctx.limits.login.retryAfterSeconds(ip));
  const { rows } = await ctx.db.query<Row>(
    'SELECT id, username, default_rollback_policy, password_hash FROM users WHERE username = $1',
    [input.username],
  );
  const row = rows[0];
  const ok = await verifyPassword(input.password, row ? row.password_hash : await ctx.dummyHash);
  if (!row || !ok) {
    ctx.limits.login.hit(ip);
    throw unauthorized('Wrong username or password');
  }
  ctx.limits.login.clear(ip);
  return toUser(row);
}

export async function getUser(ctx: Ctx, id: string): Promise<User | null> {
  const { rows } = await ctx.db.query<Row>('SELECT id, username, default_rollback_policy, password_hash FROM users WHERE id = $1', [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function updateUser(ctx: Ctx, id: string, patch: { defaultRollbackPolicy?: Policy }): Promise<User> {
  const { rows } = await ctx.db.query<Row>(
    `UPDATE users SET default_rollback_policy = COALESCE($2, default_rollback_policy) WHERE id = $1
     RETURNING id, username, default_rollback_policy, password_hash`,
    [id, patch.defaultRollbackPolicy ?? null],
  );
  if (!rows[0]) throw unauthorized();
  return toUser(rows[0]);
}

// ---------- session cookie ----------

export function startSession(ctx: Ctx, res: Response, user: User) {
  const token = signToken(ctx.keys.session, { t: 's', uid: user.id }, ctx.now(), SESSION_TTL_SECONDS);
  setCookie(res, SESSION_COOKIE, token, { maxAgeSeconds: SESSION_TTL_SECONDS, secure: ctx.cookieSecure });
}

export function endSession(ctx: Ctx, res: Response) {
  clearCookie(res, SESSION_COOKIE, ctx.cookieSecure);
}

/** The signed-in user for this request, or null. Checks the signature, the expiry and that the user still exists. */
export async function sessionUser(ctx: Ctx, req: Request): Promise<User | null> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const payload = verifyToken<{ t: string; uid: string }>(ctx.keys.session, token, ctx.now());
  if (!payload || payload.t !== 's' || typeof payload.uid !== 'string') return null;
  if (!/^[0-9a-f-]{36}$/.test(payload.uid)) return null;
  return getUser(ctx, payload.uid);
}

export async function requireUser(ctx: Ctx, req: Request): Promise<User> {
  const user = await sessionUser(ctx, req);
  if (!user) throw unauthorized();
  return user;
}
