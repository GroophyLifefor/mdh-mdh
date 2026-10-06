import type { Request } from 'express';
import type { Ctx } from '../context';
import { lookupHash, type Mode } from '../crypto';
import { bearerToken, hasBearer, parseCookies, setCookie } from '../http';
import { AppError, forbidden, passwordRequired, tooManyRequests } from '../errors';
import { signToken, verifyToken } from '../session';
import { timingSafeEqual } from 'node:crypto';
import { sessionUser } from './auth';
import type { Actor } from './history';
import type { Response } from 'express';

export type Level = 'owner' | 'rw' | 'ro';
export type Need = 'read' | 'write' | 'owner';
export type Policy = 'author_only' | 'author_and_write';

export type ProjectRow = {
  id: string; owner_id: string; name: string; rollback_policy: Policy;
  ro_gen: number; rw_gen: number; ro_hash: Buffer; rw_hash: Buffer; ro_enc: string; rw_enc: string; updated_at: Date;
};
export type Access = { level: Level; actor: Actor };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCESS_TTL_SECONDS = 30 * 24 * 3600;
const accessCookieName = (projectId: string) => 'mdh_a_' + projectId.replaceAll('-', '');

/** A name typed by a person or an agent: trimmed, single spaces, no control characters, at most 50 characters. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
}

export async function loadProject(ctx: Ctx, id: string): Promise<ProjectRow | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await ctx.db.query<ProjectRow>(
    'SELECT id, owner_id, name, rollback_policy, ro_gen, rw_gen, ro_hash, rw_hash, ro_enc, rw_enc, updated_at FROM projects WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** Finds the project a Bearer password belongs to. Wrong passwords count against the IP's limit. */
async function bearerLookup(ctx: Ctx, req: Request): Promise<{ projectId: string; mode: Mode }> {
  const ip = req.ip ?? '';
  if (ctx.limits.passwords.isLimited(ip)) throw tooManyRequests(ctx.limits.passwords.retryAfterSeconds(ip));
  const token = bearerToken(req);
  if (token && token.length <= 100) {
    const { rows } = await ctx.db.query<{ id: string; is_ro: boolean }>(
      'SELECT id, (ro_hash = $1) AS is_ro FROM projects WHERE ro_hash = $1 OR rw_hash = $1',
      [lookupHash(ctx.keys, token)],
    );
    if (rows[0]) return { projectId: rows[0].id, mode: rows[0].is_ro ? 'ro' : 'rw' };
  }
  ctx.limits.passwords.hit(ip);
  throw new AppError(401, 'invalid_token', 'That password is not valid (it may have been refreshed)');
}

/** Who is this request, for this project? Throws 401 `password_required` when nobody. */
export async function resolveAccess(ctx: Ctx, req: Request, project: ProjectRow | null): Promise<Access> {
  if (hasBearer(req)) {
    const hit = await bearerLookup(ctx, req);
    if (!project || hit.projectId !== project.id) throw passwordRequired(); // a valid password for a different project
    return { level: hit.mode, actor: { type: 'password', mode: hit.mode, name: cleanName(req.headers['x-actor-name']) } };
  }
  if (!project) throw passwordRequired();

  const user = await sessionUser(ctx, req);
  if (user && user.id === project.owner_id) return { level: 'owner', actor: { type: 'user', userId: user.id, name: user.username } };

  const cookie = parseCookies(req.headers.cookie)[accessCookieName(project.id)];
  const p = verifyToken<{ t: string; pid: string; mode: Mode; gen: number; name: string }>(ctx.keys.access, cookie, ctx.now());
  if (p && p.t === 'a' && p.pid === project.id && (p.mode === 'ro' || p.mode === 'rw') && p.gen === (p.mode === 'ro' ? project.ro_gen : project.rw_gen)) {
    return { level: p.mode, actor: { type: 'password', mode: p.mode, name: cleanName(p.name) } };
  }
  throw passwordRequired();
}

/** Loads the project and checks the caller may do `need` on it. */
export async function authorize(ctx: Ctx, req: Request, projectId: string, need: Need): Promise<{ project: ProjectRow; access: Access }> {
  const project = UUID_RE.test(projectId) ? await loadProject(ctx, projectId) : null;
  const access = await resolveAccess(ctx, req, project); // throws password_required when project is null
  if (!project) throw passwordRequired(); // unreachable; it only narrows the type
  if (need === 'owner' && access.level !== 'owner') throw forbidden('Only the project owner can do this');
  if (need === 'write' && access.level === 'ro') throw new AppError(403, 'read_only', 'This password is read only');
  return { project, access };
}

/** The gate: password (+ optional name) in, signed cookie out. */
export async function openGate(ctx: Ctx, req: Request, res: Response, projectId: string, password: string, name: unknown): Promise<{ level: Mode; name: string }> {
  const ip = req.ip ?? '';
  if (ctx.limits.passwords.isLimited(ip)) throw tooManyRequests(ctx.limits.passwords.retryAfterSeconds(ip));
  const project = await loadProject(ctx, projectId);
  const given = lookupHash(ctx.keys, password);
  const match = (h: Buffer | undefined) => !!h && timingSafeEqual(given, h);
  const mode: Mode | null = project && match(project.rw_hash) ? 'rw' : project && match(project.ro_hash) ? 'ro' : null;
  if (!project || !mode) {
    ctx.limits.passwords.hit(ip);
    throw new AppError(401, 'wrong_password', 'Wrong password');
  }
  const cleaned = cleanName(name);
  const gen = mode === 'ro' ? project.ro_gen : project.rw_gen;
  setCookie(res, accessCookieName(project.id), signToken(ctx.keys.access, { t: 'a', pid: project.id, mode, gen, name: cleaned }, ctx.now(), ACCESS_TTL_SECONDS), {
    maxAgeSeconds: ACCESS_TTL_SECONDS, secure: ctx.cookieSecure,
  });
  return { level: mode, name: cleaned };
}

/** Bearer-only "who am I": which project this password opens, and what it may do. */
export async function whoAmI(ctx: Ctx, req: Request): Promise<{ project: { id: string; name: string }; level: Mode; actorName: string }> {
  if (!hasBearer(req)) throw new AppError(401, 'invalid_token', 'Send the project password as: Authorization: Bearer <password>');
  const hit = await bearerLookup(ctx, req);
  const project = await loadProject(ctx, hit.projectId);
  if (!project) throw passwordRequired();
  return { project: { id: project.id, name: project.name }, level: hit.mode, actorName: cleanName(req.headers['x-actor-name']) };
}
