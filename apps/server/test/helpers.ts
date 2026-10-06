import request from 'supertest';
import { createApp, type Deps } from '../src/app';
import type { TestDb } from './db';

export const SECRET = 'test-secret-'.padEnd(40, 'x');
export const FAST_SCRYPT = { N: 1024, r: 8, p: 1 }; // production uses a much higher cost; tests only need the logic

/** A clock tests can move. */
export function makeClock(start = '2026-01-01T00:00:00.000Z') {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; }, advanceSeconds: (s: number) => { t += s * 1000; } };
}

export function makeApp(t: TestDb, extra: Partial<Deps> = {}) {
  const clock = makeClock();
  const app = createApp({ db: t.db, secret: SECRET, scryptCost: FAST_SCRYPT, now: clock.now, ...extra });
  return { app, clock };
}

/** "name=value" pairs from Set-Cookie headers, ready to send back as a Cookie header. */
export const cookieHeader = (res: request.Response): string =>
  ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).map((c) => c.split(';')[0]).join('; ');

export const setCookies = (res: request.Response): string[] => (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

type App = ReturnType<typeof makeApp>['app'];
let counter = 0;

/** Registers a user through the API. Returns the session cookie to send back. */
export async function signUp(app: App, name = `user${++counter}`) {
  const res = await request(app).post('/api/auth/register').send({ username: name, password: 'longenough' });
  if (res.status !== 201) throw new Error('signUp failed: ' + JSON.stringify(res.body));
  return { cookie: cookieHeader(res), id: res.body.user.id as string, username: res.body.user.username as string };
}

/** Creates a project as that user and reads its passwords back through the API. */
export async function newProject(app: App, cookie: string, name = 'Project') {
  const res = await request(app).post('/api/projects').set('Cookie', cookie).send({ name });
  if (res.status !== 201) throw new Error('newProject failed: ' + JSON.stringify(res.body));
  const id = res.body.project.id as string;
  const pw = await request(app).get(`/api/projects/${id}/passwords`).set('Cookie', cookie);
  return { id, ro: pw.body.ro as string, rw: pw.body.rw as string };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Opens the gate for a project and returns the access cookie. */
export async function gate(app: App, projectId: string, password: string, name?: string) {
  const res = await request(app).post(`/api/projects/${projectId}/access`).send({ password, name });
  if (res.status !== 200) throw new Error('gate failed: ' + JSON.stringify(res.body));
  return cookieHeader(res);
}
