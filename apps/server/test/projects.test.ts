import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from './db';
import { bearer, cookieHeader, gate, makeApp, newProject, setCookies, signUp } from './helpers';
import { withTx } from '../src/db';
import { recordChange } from '../src/services/history';
import { deriveKeys } from '../src/crypto';
import { SECRET } from './helpers';

describe('projects', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.drop(); });

  describe('create and list', () => {
    it('needs a signed-in user', async () => {
      const { app } = makeApp(t);
      expect((await request(app).post('/api/projects').send({ name: 'x' })).status).toBe(401);
      expect((await request(app).get('/api/projects')).status).toBe(401);
    });

    it('creates a project with a uuidv7 id, readme.md and a first change', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const res = await request(app).post('/api/projects').set('Cookie', u.cookie).send({ name: '  My Notes  ' });
      expect(res.status).toBe(201);
      expect(res.body.project).toMatchObject({ name: 'My Notes', rollbackPolicy: 'author_and_write' });
      const id = res.body.project.id as string;
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);

      const nodes = await t.db.query('SELECT path, kind, content, version FROM nodes WHERE project_id = $1', [id]);
      expect(nodes.rows).toEqual([{ path: 'readme.md', kind: 'file', content: expect.stringContaining('# My Notes'), version: 1 }]);

      const changes = await t.db.query('SELECT seq, actor_type, actor_name, kind, summary FROM changes WHERE project_id = $1', [id]);
      expect(changes.rows).toEqual([{ seq: 1, actor_type: 'user', actor_name: u.username, kind: 'create', summary: 'created readme.md' }]);
      const files = await t.db.query('SELECT path, action, before, after FROM change_files cf JOIN changes c ON c.id = cf.change_id WHERE c.project_id = $1', [id]);
      expect(files.rows).toEqual([{ path: 'readme.md', action: 'created', before: null, after: nodes.rows[0].content }]);
      expect((await t.db.query('SELECT last_seq FROM projects WHERE id = $1', [id])).rows[0].last_seq).toBe(1);
    });

    it.each([['empty', ''], ['spaces', '   '], ['too long', 'x'.repeat(101)], ['a number', 5], ['missing', undefined], ['null', null]])('refuses a name that is %s', async (_n, name) => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const res = await request(app).post('/api/projects').set('Cookie', u.cookie).send({ name } as object);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_input');
    });

    it('accepts exactly 100 characters and any language', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      expect((await request(app).post('/api/projects').set('Cookie', u.cookie).send({ name: 'x'.repeat(100) })).status).toBe(201);
      const tr = await request(app).post('/api/projects').set('Cookie', u.cookie).send({ name: 'Türkçe proje çğıöşü' });
      expect(tr.body.project.name).toBe('Türkçe proje çğıöşü');
    });

    it('takes the rollback policy from the owner\'s profile', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      await request(app).patch('/api/auth/me').set('Cookie', u.cookie).send({ defaultRollbackPolicy: 'author_only' });
      const res = await request(app).post('/api/projects').set('Cookie', u.cookie).send({ name: 'strict' });
      expect(res.body.project.rollbackPolicy).toBe('author_only');
    });

    it('lists only my projects, newest activity first', async () => {
      const { app, clock } = makeApp(t);
      const [a, b] = [await signUp(app), await signUp(app)];
      const first = await newProject(app, a.cookie, 'First');
      clock.advance(1000);
      const second = await newProject(app, a.cookie, 'Second');
      await newProject(app, b.cookie, 'Not mine');
      const list = await request(app).get('/api/projects').set('Cookie', a.cookie);
      expect(list.body.projects.map((p: { id: string }) => p.id)).toEqual([second.id, first.id]);
      expect(list.body.projects[0]).toEqual({ id: second.id, name: 'Second', rollbackPolicy: 'author_and_write', updatedAt: expect.any(String) });
      expect(JSON.stringify(list.body)).not.toMatch(/ro_|rw_|enc|hash/);
    });

    it('lists an empty array for a user without projects', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      expect((await request(app).get('/api/projects').set('Cookie', u.cookie)).body).toEqual({ projects: [] });
    });
  });

  describe('passwords', () => {
    it('are random, have the right prefix and differ between projects', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const [p1, p2] = [await newProject(app, u.cookie), await newProject(app, u.cookie)];
      for (const p of [p1, p2]) { expect(p.ro).toMatch(/^ro_[A-Za-z0-9]{24}$/); expect(p.rw).toMatch(/^rw_[A-Za-z0-9]{24}$/); }
      expect(new Set([p1.ro, p1.rw, p2.ro, p2.rw]).size).toBe(4);
    });

    it('are stored encrypted, with a lookup hash, never in clear text', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const p = await newProject(app, u.cookie);
      const row = (await t.db.query('SELECT ro_enc, rw_enc, ro_hash, rw_hash FROM projects WHERE id = $1', [p.id])).rows[0];
      for (const col of ['ro_enc', 'rw_enc']) { expect(row[col]).toMatch(/^v1\./); expect(row[col]).not.toContain(p.rw.slice(3)); expect(row[col]).not.toContain(p.ro.slice(3)); }
      expect(row.ro_hash).toHaveLength(32);
      expect(row.rw_hash).toHaveLength(32);
      const dump = JSON.stringify((await t.db.query('SELECT * FROM projects WHERE id = $1', [p.id])).rows);
      expect(dump).not.toContain(p.rw);
      expect(dump).not.toContain(p.ro);
    });

    it('the owner can read them again at any time and they keep working', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const p = await newProject(app, u.cookie);
      const again = await request(app).get(`/api/projects/${p.id}/passwords`).set('Cookie', u.cookie);
      expect(again.body).toEqual({ ro: p.ro, rw: p.rw });
      expect((await request(app).get(`/api/projects/${p.id}`).set(bearer(p.rw))).status).toBe(200);
    });

    it('a ciphertext copied to another project cannot be decrypted there', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const [p1, p2] = [await newProject(app, u.cookie), await newProject(app, u.cookie)];
      await t.db.query('UPDATE projects SET rw_enc = (SELECT rw_enc FROM projects WHERE id = $1) WHERE id = $2', [p1.id, p2.id]);
      const res = await request(app).get(`/api/projects/${p2.id}/passwords`).set('Cookie', u.cookie);
      expect(res.status).toBe(500); // refused loudly instead of showing another project's password
      expect(JSON.stringify(res.body)).not.toContain(p1.rw);
    });

    describe('refresh', () => {
      it('gives a new password and kills the old one at once, but only for that mode', async () => {
        const { app } = makeApp(t);
        const u = await signUp(app);
        const p = await newProject(app, u.cookie);
        const res = await request(app).post(`/api/projects/${p.id}/passwords/rw/refresh`).set('Cookie', u.cookie);
        expect(res.status).toBe(200);
        const fresh = res.body.password as string;
        expect(fresh).toMatch(/^rw_/);
        expect(fresh).not.toBe(p.rw);
        const old = await request(app).get(`/api/projects/${p.id}`).set(bearer(p.rw));
        expect(old.status).toBe(401);
        expect(old.body.error.code).toBe('invalid_token');
        expect((await request(app).get(`/api/projects/${p.id}`).set(bearer(fresh))).status).toBe(200);
        expect((await request(app).get(`/api/projects/${p.id}`).set(bearer(p.ro))).status).toBe(200); // ro untouched
        expect((await request(app).get(`/api/projects/${p.id}/passwords`).set('Cookie', u.cookie)).body).toEqual({ ro: p.ro, rw: fresh });
      });

      it('also logs out everyone who got in through the gate with the old password', async () => {
        const { app } = makeApp(t);
        const u = await signUp(app);
        const p = await newProject(app, u.cookie);
        const rwCookie = await gate(app, p.id, p.rw, 'Sam');
        const roCookie = await gate(app, p.id, p.ro, 'Kim');
        expect((await request(app).get(`/api/projects/${p.id}`).set('Cookie', rwCookie)).status).toBe(200);
        await request(app).post(`/api/projects/${p.id}/passwords/rw/refresh`).set('Cookie', u.cookie);
        const res = await request(app).get(`/api/projects/${p.id}`).set('Cookie', rwCookie);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('password_required');
        expect((await request(app).get(`/api/projects/${p.id}`).set('Cookie', roCookie)).status).toBe(200);
      });

      it('can be repeated, and the generation counts up', async () => {
        const { app } = makeApp(t);
        const u = await signUp(app);
        const p = await newProject(app, u.cookie);
        const seen = new Set([p.ro]);
        for (let i = 0; i < 3; i++) seen.add((await request(app).post(`/api/projects/${p.id}/passwords/ro/refresh`).set('Cookie', u.cookie)).body.password);
        expect(seen.size).toBe(4);
        expect((await t.db.query('SELECT ro_gen, rw_gen FROM projects WHERE id = $1', [p.id])).rows[0]).toEqual({ ro_gen: 4, rw_gen: 1 });
      });

      it('refuses an unknown mode and keeps the project as it was', async () => {
        const { app } = makeApp(t);
        const u = await signUp(app);
        const p = await newProject(app, u.cookie);
        expect((await request(app).post(`/api/projects/${p.id}/passwords/admin/refresh`).set('Cookie', u.cookie)).status).toBe(404);
        expect((await request(app).get(`/api/projects/${p.id}/passwords`).set('Cookie', u.cookie)).body).toEqual({ ro: p.ro, rw: p.rw });
      });
    });
  });

  describe('gate', () => {
    it('opens with the right password and tells which level it gives', async () => {
      const { app } = makeApp(t);
      const p = await newProject(app, (await signUp(app)).cookie);
      const rw = await request(app).post(`/api/projects/${p.id}/access`).send({ password: p.rw, name: 'Sam' });
      expect(rw.status).toBe(200);
      expect(rw.body.access).toEqual({ level: 'rw', name: 'Sam' });
      const ro = await request(app).post(`/api/projects/${p.id}/access`).send({ password: p.ro });
      expect(ro.body.access).toEqual({ level: 'ro', name: '' });
    });

    it('sets an HttpOnly, SameSite=Lax cookie that works for read and carries the name', async () => {
      const { app } = makeApp(t);
      const p = await newProject(app, (await signUp(app)).cookie);
      const res = await request(app).post(`/api/projects/${p.id}/access`).send({ password: p.rw, name: 'Sam' });
      expect(setCookies(res)[0]).toMatch(/HttpOnly.*SameSite=Lax|SameSite=Lax.*HttpOnly/);
      const got = await request(app).get(`/api/projects/${p.id}`).set('Cookie', cookieHeader(res));
      expect(got.body.access).toEqual({ level: 'rw', name: 'Sam' });
    });

    it('cleans the name: trims, collapses spaces, drops control characters, caps at 50', async () => {
      const { app } = makeApp(t);
      const p = await newProject(app, (await signUp(app)).cookie);
      const name = async (raw: string) => (await request(app).post(`/api/projects/${p.id}/access`).send({ password: p.ro, name: raw })).body.access.name;
      expect(await name('  Sam   Lee  ')).toBe('Sam Lee');
      expect(await name('a\u0000b\nc\td')).toBe('a b c d');
      expect(await name('x'.repeat(80))).toBe('x'.repeat(50));
      expect(await name('   ')).toBe('');
      expect(await name('Ayşe Çelik 🙂')).toBe('Ayşe Çelik 🙂');
    });

    it('refuses a wrong password, a password of another project and an unknown project the same way', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const [p, q] = [await newProject(app, u.cookie), await newProject(app, u.cookie)];
      const tries = [
        request(app).post(`/api/projects/${p.id}/access`).send({ password: 'nope' }),
        request(app).post(`/api/projects/${p.id}/access`).send({ password: q.rw }),
        request(app).post(`/api/projects/00000000-0000-7000-8000-000000000000/access`).send({ password: p.rw }),
        request(app).post(`/api/projects/not-a-uuid/access`).send({ password: p.rw }),
      ];
      for (const r of await Promise.all(tries)) {
        expect(r.status).toBe(401);
        expect(r.body.error.code).toBe('wrong_password');
        expect(setCookies(r)).toEqual([]);
      }
    });

    it('does not accept a password with a different case or extra characters', async () => {
      const { app } = makeApp(t);
      const p = await newProject(app, (await signUp(app)).cookie);
      for (const pw of [p.rw.toUpperCase(), p.rw + 'x', p.rw.slice(0, -1), ' ' + p.rw]) {
        expect((await request(app).post(`/api/projects/${p.id}/access`).send({ password: pw })).status, pw).toBe(401);
      }
      expect((await request(app).post(`/api/projects/${p.id}/access`).send({ password: p.rw })).status).toBe(200);
    });

    it('a cookie only opens its own project', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const [p, q] = [await newProject(app, u.cookie, 'P'), await newProject(app, u.cookie, 'Q')];
      const cookie = await gate(app, p.id, p.rw);
      expect((await request(app).get(`/api/projects/${p.id}`).set('Cookie', cookie)).status).toBe(200);
      expect((await request(app).get(`/api/projects/${q.id}`).set('Cookie', cookie)).status).toBe(401);
    });

    it('a cookie value copied onto another project\'s cookie name is refused', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const [p, q] = [await newProject(app, u.cookie, 'P'), await newProject(app, u.cookie, 'Q')];
      const [name, value] = (await gate(app, p.id, p.rw)).split('=') as [string, string];
      const swapped = `mdh_a_${q.id.replaceAll('-', '')}=${value}`;
      expect(name).toBe('mdh_a_' + p.id.replaceAll('-', ''));
      expect((await request(app).get(`/api/projects/${q.id}`).set('Cookie', swapped)).status).toBe(401);
    });

    it('stops working after 30 days', async () => {
      const { app, clock } = makeApp(t);
      const p = await newProject(app, (await signUp(app)).cookie);
      const cookie = await gate(app, p.id, p.ro);
      clock.advanceSeconds(30 * 24 * 3600 - 1);
      expect((await request(app).get(`/api/projects/${p.id}`).set('Cookie', cookie)).status).toBe(200);
      clock.advanceSeconds(2);
      expect((await request(app).get(`/api/projects/${p.id}`).set('Cookie', cookie)).status).toBe(401);
    });

    it('a session cookie cannot be used as an access cookie', async () => {
      const { app } = makeApp(t);
      const owner = await signUp(app);
      const stranger = await signUp(app);
      const p = await newProject(app, owner.cookie);
      const sessionValue = stranger.cookie.split('=')[1]!;
      expect((await request(app).get(`/api/projects/${p.id}`).set('Cookie', `mdh_a_${p.id.replaceAll('-', '')}=${sessionValue}`)).status).toBe(401);
    });

    it('limits wrong guesses per IP: 30 allowed, then 429, then recovers', async () => {
      const { app, clock } = makeApp(t);
      const p = await newProject(app, (await signUp(app)).cookie);
      for (let i = 0; i < 30; i++) expect((await request(app).post(`/api/projects/${p.id}/access`).send({ password: 'guess' + i })).status).toBe(401);
      const locked = await request(app).post(`/api/projects/${p.id}/access`).send({ password: p.rw });
      expect(locked.status).toBe(429);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      clock.advance(15 * 60_000 + 1000);
      expect((await request(app).post(`/api/projects/${p.id}/access`).send({ password: p.rw })).status).toBe(200);
    });

    it.each([['missing password', {}], ['password not a string', { password: 5 }], ['name not a string', { password: 'x', name: 5 }], ['huge password', { password: 'x'.repeat(101) }]])('answers 400 for %s', async (_n, body) => {
      const { app } = makeApp(t);
      const p = await newProject(app, (await signUp(app)).cookie);
      expect((await request(app).post(`/api/projects/${p.id}/access`).send(body)).status).toBe(400);
    });
  });

  describe('Bearer', () => {
    it('identifies the project by the password alone and reports the level', async () => {
      const { app } = makeApp(t);
      const p = await newProject(app, (await signUp(app)).cookie, 'Alpha');
      const rw = await request(app).get('/api/access').set(bearer(p.rw));
      expect(rw.status).toBe(200);
      expect(rw.body).toEqual({ project: { id: p.id, name: 'Alpha' }, level: 'rw', actorName: '' });
      expect((await request(app).get('/api/access').set(bearer(p.ro))).body.level).toBe('ro');
    });

    it('records the optional X-Actor-Name, cleaned', async () => {
      const { app } = makeApp(t);
      const p = await newProject(app, (await signUp(app)).cookie);
      const res = await request(app).get('/api/access').set(bearer(p.rw)).set('X-Actor-Name', '  claude   code ');
      expect(res.body.actorName).toBe('claude code');
      expect((await request(app).get(`/api/projects/${p.id}`).set(bearer(p.rw)).set('X-Actor-Name', 'bot')).body.access).toEqual({ level: 'rw', name: 'bot' });
    });

    it('is the only way /api/access answers (no cookie, no header)', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const p = await newProject(app, u.cookie);
      for (const r of [request(app).get('/api/access'), request(app).get('/api/access').set('Cookie', u.cookie), request(app).get('/api/access').set('Cookie', await gate(app, p.id, p.rw))]) {
        const res = await r;
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('invalid_token');
      }
    });

    it('refuses wrong, empty and differently-schemed credentials', async () => {
      const { app } = makeApp(t);
      const p = await newProject(app, (await signUp(app)).cookie);
      for (const h of ['Bearer nope', 'Bearer ' + p.rw + 'x', 'Bearer', 'Bearer   ', `Basic ${p.rw}`, p.rw]) {
        const res = await request(app).get(`/api/projects/${p.id}`).set('Authorization', h);
        expect(res.status, h).toBe(401);
      }
    });

    it('a valid password does not open a different project', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const [p, q] = [await newProject(app, u.cookie), await newProject(app, u.cookie)];
      const res = await request(app).get(`/api/projects/${q.id}`).set(bearer(p.rw));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('password_required');
    });

    it('a wrong Bearer is not rescued by a valid cookie (no silent fallback)', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const p = await newProject(app, u.cookie);
      const res = await request(app).get(`/api/projects/${p.id}`).set('Cookie', u.cookie).set(bearer('wrong'));
      expect(res.status).toBe(401);
    });

    it('limits wrong tokens per IP, shared with the gate', async () => {
      const { app } = makeApp(t);
      const p = await newProject(app, (await signUp(app)).cookie);
      for (let i = 0; i < 30; i++) await request(app).get('/api/access').set(bearer('bad' + i));
      const res = await request(app).get('/api/access').set(bearer(p.rw));
      expect(res.status).toBe(429);
    });

    it('treats an over-long token as wrong without hashing it', async () => {
      const { app } = makeApp(t);
      expect((await request(app).get('/api/access').set(bearer('x'.repeat(5000)))).status).toBe(401);
    });
  });

  describe('settings', () => {
    it('the owner changes the rollback policy and reads it back', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const p = await newProject(app, u.cookie);
      const res = await request(app).patch(`/api/projects/${p.id}`).set('Cookie', u.cookie).send({ rollbackPolicy: 'author_only' });
      expect(res.body.project.rollbackPolicy).toBe('author_only');
      expect((await request(app).get(`/api/projects/${p.id}`).set(bearer(p.ro))).body.project.rollbackPolicy).toBe('author_only');
    });
    it('refuses unknown values and unknown fields (like renaming or taking over)', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const p = await newProject(app, u.cookie);
      for (const body of [{ rollbackPolicy: 'anyone' }, { name: 'Hacked' }, { ownerId: u.id }, { rollbackPolicy: 5 }]) {
        expect((await request(app).patch(`/api/projects/${p.id}`).set('Cookie', u.cookie).send(body)).status, JSON.stringify(body)).toBe(400);
      }
      expect((await request(app).get(`/api/projects/${p.id}`).set('Cookie', u.cookie)).body.project.name).toBe('Project');
    });
  });

  describe('delete', () => {
    it('removes the project with its files and history, and nothing of any other project', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const [gone, kept] = [await newProject(app, u.cookie, 'Gone'), await newProject(app, u.cookie, 'Kept')];
      const res = await request(app).delete(`/api/projects/${gone.id}`).set('Cookie', u.cookie);
      expect(res.status).toBe(200);
      for (const table of ['nodes', 'changes']) {
        expect((await t.db.query(`SELECT 1 FROM ${table} WHERE project_id = $1`, [gone.id])).rowCount, table).toBe(0);
        expect((await t.db.query(`SELECT 1 FROM ${table} WHERE project_id = $1`, [kept.id])).rowCount, table).toBe(1);
      }
      expect((await t.db.query('SELECT 1 FROM change_files cf LEFT JOIN changes c ON c.id = cf.change_id WHERE c.id IS NULL')).rowCount).toBe(0);
      expect((await request(app).get('/api/projects').set('Cookie', u.cookie)).body.projects.map((p: { id: string }) => p.id)).toEqual([kept.id]);
    });

    it('afterwards the passwords and gate cookies stop working', async () => {
      const { app } = makeApp(t);
      const u = await signUp(app);
      const p = await newProject(app, u.cookie);
      const cookie = await gate(app, p.id, p.rw);
      await request(app).delete(`/api/projects/${p.id}`).set('Cookie', u.cookie);
      expect((await request(app).get(`/api/projects/${p.id}`).set(bearer(p.rw))).status).toBe(401);
      expect((await request(app).get(`/api/projects/${p.id}`).set('Cookie', cookie)).status).toBe(401);
      expect((await request(app).post(`/api/projects/${p.id}/access`).send({ password: p.rw })).status).toBe(401);
      expect((await request(app).delete(`/api/projects/${p.id}`).set('Cookie', u.cookie)).status).toBe(401); // already gone
    });

    it('someone with the read-write password cannot delete', async () => {
      const { app } = makeApp(t);
      const p = await newProject(app, (await signUp(app)).cookie);
      expect((await request(app).delete(`/api/projects/${p.id}`).set(bearer(p.rw))).status).toBe(403);
      expect((await request(app).get(`/api/projects/${p.id}`).set(bearer(p.rw))).status).toBe(200);
    });
  });

  describe('history numbering', () => {
    it('stays 1..N with no gaps and no duplicates when many changes arrive at once', async () => {
      const { app, clock } = makeApp(t);
      const u = await signUp(app);
      const p = await newProject(app, u.cookie);
      const ctx = { db: t.db, keys: deriveKeys(SECRET), now: clock.now } as never;
      await Promise.all(Array.from({ length: 25 }, (_, i) =>
        withTx(t.db, (tx) => recordChange(ctx, tx, p.id, { type: 'password', mode: 'rw', name: 'bot' }, {
          kind: 'edit', summary: 'edit ' + i, files: [{ path: `f${i}.md`, kind: 'file', action: 'created', before: null, after: String(i) }],
        })),
      ));
      const seqs = (await t.db.query('SELECT seq FROM changes WHERE project_id = $1 ORDER BY seq', [p.id])).rows.map((r) => r.seq);
      expect(seqs).toEqual(Array.from({ length: 26 }, (_, i) => i + 1)); // 1 is the readme
      expect((await t.db.query('SELECT last_seq FROM projects WHERE id = $1', [p.id])).rows[0].last_seq).toBe(26);
    });

    it('a failed transaction leaves no half-written change and does not use up a number', async () => {
      const { app, clock } = makeApp(t);
      const p = await newProject(app, (await signUp(app)).cookie);
      const ctx = { db: t.db, keys: deriveKeys(SECRET), now: clock.now } as never;
      const bad = withTx(t.db, async (tx) => {
        await recordChange(ctx, tx, p.id, { type: 'password', mode: 'rw', name: '' }, { kind: 'edit', summary: 'x', files: [{ path: 'a.md', kind: 'file', action: 'created', before: 'oops', after: 'x' }] });
      });
      await expect(bad).rejects.toThrow(/change_files_action_shape/);
      expect((await t.db.query('SELECT count(*)::int AS n FROM changes WHERE project_id = $1', [p.id])).rows[0].n).toBe(1);
      expect((await t.db.query('SELECT last_seq FROM projects WHERE id = $1', [p.id])).rows[0].last_seq).toBe(1);
    });
  });
});
