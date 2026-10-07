import request from 'supertest';
import { bearer, makeApp, newProject, signUp } from './helpers';
import type { TestDb } from './db';

type App = ReturnType<typeof makeApp>['app'];
type Auth = { cookie?: string; token?: string; name?: string };

/** Short calls for the project endpoints. Every method returns the supertest response. */
export function api(app: App, projectId: string, auth: Auth) {
  const h = (r: request.Test) => {
    if (auth.token) r.set(bearer(auth.token));
    else if (auth.cookie) r.set('Cookie', auth.cookie);
    if (auth.name) r.set('X-Actor-Name', auth.name);
    return r;
  };
  const base = `/api/projects/${projectId}`;
  return {
    tree: () => h(request(app).get(`${base}/tree`)),
    read: (path: string) => h(request(app).get(`${base}/file`).query({ path })),
    save: (path: string, content: string, baseVersion: number) => h(request(app).put(`${base}/file`).send({ path, content, baseVersion })),
    create: (path: string, kind: 'file' | 'dir' = 'file', content?: string) => h(request(app).post(`${base}/files`).send({ path, kind, content })),
    move: (from: string, to: string) => h(request(app).post(`${base}/move`).send({ from, to })),
    del: (path: string) => h(request(app).delete(`${base}/file`).query({ path })),
    upload: (files: { path: string; content: string }[], opts: { folders?: string[]; overwrite?: boolean } = {}) => h(request(app).post(`${base}/upload`).send({ files, ...opts })),
    history: (query: Record<string, string | number> = {}) => h(request(app).get(`${base}/history`).query(query)),
    change: (seq: number | string) => h(request(app).get(`${base}/history/${seq}`)),
    changeFile: (seq: number | string, path: string) => h(request(app).get(`${base}/history/${seq}/file`).query({ path })),
    rollback: (seq: number | string) => h(request(app).post(`${base}/history/${seq}/rollback`)),
  };
}

/** An app with an owner and one project, and the same project seen as the owner, a read-write and a read-only caller. */
export async function world(t: TestDb) {
  const { app, clock } = makeApp(t);
  const owner = await signUp(app);
  const p = await newProject(app, owner.cookie, 'World');
  return {
    app, clock, owner, p, t,
    asOwner: api(app, p.id, { cookie: owner.cookie }),
    asRw: (name?: string) => api(app, p.id, { token: p.rw, name }),
    asRo: api(app, p.id, { token: p.ro }),
    /** The tree as { path: content-or-null-for-folders } straight from the database. */
    async state() {
      const { rows } = await t.db.query('SELECT path, kind, content FROM nodes WHERE project_id = $1 ORDER BY path', [p.id]);
      return Object.fromEntries(rows.map((r) => [r.path, r.kind === 'dir' ? null : (r.content as string)]));
    },
    async changes() {
      const { rows } = await t.db.query('SELECT seq, kind, summary, actor_type, actor_name, target_seq FROM changes WHERE project_id = $1 ORDER BY seq', [p.id]);
      return rows as { seq: number; kind: string; summary: string; actor_type: string; actor_name: string; target_seq: number | null }[];
    },
    async changeFiles(seq: number) {
      const { rows } = await t.db.query(
        'SELECT cf.path, cf.kind, cf.action, cf.before, cf.after FROM change_files cf JOIN changes c ON c.id = cf.change_id WHERE c.project_id = $1 AND c.seq = $2 ORDER BY cf.path',
        [p.id, seq],
      );
      return rows as { path: string; kind: string; action: string; before: string | null; after: string | null }[];
    },
  };
}
