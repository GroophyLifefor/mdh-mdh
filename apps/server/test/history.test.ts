import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from './db';
import { api, world } from './api';
import { bearer, gate, signUp } from './helpers';

describe('history', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.drop(); });

  describe('listing', () => {
    it('lists newest first with a readable author label and timestamps', async () => {
      const w = await world(t);
      w.clock.advance(1000);
      await w.asRw('Sam').create('a.md');
      w.clock.advance(1000);
      await w.asRw().create('b.md');
      const res = await w.asRo.history();
      expect(res.status).toBe(200);
      expect(res.body.changes.map((c: { seq: number }) => c.seq)).toEqual([3, 2, 1]);
      expect(res.body.changes.map((c: { actor: { label: string } }) => c.actor.label)).toEqual(['pw', 'pw: Sam', (await w.owner).username]);
      expect(res.body.changes[0]).toEqual({
        seq: 3, kind: 'create', summary: 'created b.md', targetSeq: null, createdAt: expect.any(String), updatedAt: expect.any(String),
        actor: { type: 'password', name: '', label: 'pw' },
      });
      expect(res.body.nextBefore).toBeNull();
    });

    it('pages with limit and before; nextBefore is the last seq on the page and null at the end', async () => {
      const w = await world(t);
      for (let i = 0; i < 6; i++) await w.asOwner.create(`f${i}.md`);
      const p1 = await w.asOwner.history({ limit: 3 });
      expect(p1.body.changes.map((c: { seq: number }) => c.seq)).toEqual([7, 6, 5]);
      expect(p1.body.nextBefore).toBe(5);
      const p2 = await w.asOwner.history({ limit: 3, before: p1.body.nextBefore });
      expect(p2.body.changes.map((c: { seq: number }) => c.seq)).toEqual([4, 3, 2]);
      const p3 = await w.asOwner.history({ limit: 3, before: p2.body.nextBefore });
      expect(p3.body.changes.map((c: { seq: number }) => c.seq)).toEqual([1]);
      expect(p3.body.nextBefore).toBeNull();
    });

    it('a page that ends exactly at the beginning has no next page', async () => {
      const w = await world(t);
      await w.asOwner.create('a.md');
      expect((await w.asOwner.history({ limit: 2 })).body.nextBefore).toBeNull();
    });

    it('caps limit at 500 and rejects nonsense', async () => {
      const w = await world(t);
      expect((await w.asOwner.history({ limit: 100000 })).status).toBe(200);
      for (const q of [{ limit: 0 }, { limit: -1 }, { limit: 'abc' }, { before: 0 }, { before: 'x' }, { limit: '1.5' }] as Record<string, string | number>[]) {
        expect((await w.asOwner.history(q)).status, JSON.stringify(q)).toBe(400);
      }
    });

    it('shows the name given at the gate and the X-Actor-Name of an agent', async () => {
      const w = await world(t);
      const cookie = await gate(w.app, w.p.id, w.p.rw, 'Kim');
      await api(w.app, w.p.id, { cookie }).create('k.md');
      await w.asRw('claude').create('c.md');
      const labels = (await w.asOwner.history()).body.changes.map((c: { actor: { label: string } }) => c.actor.label);
      expect(labels.slice(0, 2)).toEqual(['pw: claude', 'pw: Kim']);
    });

    it('does not show another project\'s history', async () => {
      const w = await world(t);
      const other = await world(t);
      await other.asOwner.create('secret.md');
      expect(JSON.stringify((await w.asOwner.history()).body)).not.toContain('secret');
      expect((await w.asOwner.history()).body.changes).toHaveLength(1);
    });
  });

  describe('one change', () => {
    it('gives the paths and what happened to each, without file contents', async () => {
      const w = await world(t);
      await w.asOwner.upload([{ path: 'x/a.md', content: 'SECRET-BODY' }]);
      const res = await w.asRo.change(2);
      expect(res.status).toBe(200);
      expect(res.body.change).toMatchObject({ seq: 2, kind: 'upload', summary: 'uploaded x/a.md' });
      expect(res.body.change.files).toEqual([{ path: 'x', kind: 'dir', action: 'created' }, { path: 'x/a.md', kind: 'file', action: 'created' }]);
      expect(JSON.stringify(res.body)).not.toContain('SECRET-BODY');
    });
    it('404 for a seq that does not exist; 400 for a bad one', async () => {
      const w = await world(t);
      expect((await w.asOwner.change(99)).status).toBe(404);
      for (const bad of ['0', '-1', 'abc', '1.5', '1e3', '99999999999']) {
        expect((await w.asOwner.change(bad)).status, bad).toBeGreaterThanOrEqual(400);
      }
    });
  });

  describe('access', () => {
    it('is readable with any access and with nothing else', async () => {
      const w = await world(t);
      const stranger = await signUp(w.app);
      expect((await request(w.app).get(`/api/projects/${w.p.id}/history`)).status).toBe(401);
      expect((await request(w.app).get(`/api/projects/${w.p.id}/history`).set('Cookie', stranger.cookie)).status).toBe(401);
      expect((await request(w.app).get(`/api/projects/${w.p.id}/history`).set(bearer(w.p.ro))).status).toBe(200);
    });
  });
});

describe('rollback', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.drop(); });

  it('restores an edited file and records the rollback as a new change', async () => {
    const w = await world(t);
    const original = (await w.asOwner.read('readme.md')).body.file.content;
    await w.asOwner.save('readme.md', 'changed', 1);
    const res = await w.asOwner.rollback(1);
    expect(res.status).toBe(200);
    expect(res.body.change.seq).toBe(3);
    expect((await w.asOwner.read('readme.md')).body.file).toMatchObject({ content: original, version: 3 });
    expect((await w.changes()).map((c) => [c.seq, c.kind, c.summary, c.target_seq])).toEqual([
      [1, 'create', 'created readme.md', null], [2, 'edit', 'edited readme.md', null], [3, 'rollback', 'rolled back to #1', 1],
    ]);
    expect(await w.changeFiles(3)).toEqual([{ path: 'readme.md', kind: 'file', action: 'updated', before: 'changed', after: original }]);
  });

  it('brings back deleted files and folders with all their content', async () => {
    const w = await world(t);
    await w.asOwner.create('d/a.md', 'file', 'A'); await w.asOwner.create('d/sub/b.yml', 'file', 'b: 1');
    const full = await w.state();
    await w.asOwner.del('d');
    expect(await w.state()).not.toEqual(full);
    expect((await w.asOwner.rollback(3)).status).toBe(200); // seq 3 = after the second create
    expect(await w.state()).toEqual(full);
  });

  it('removes files created later and undoes renames', async () => {
    const w = await world(t);
    await w.asOwner.create('a.md', 'file', 'A'); // 2
    const at2 = await w.state();
    await w.asOwner.move('a.md', 'b/c.md'); // 3
    await w.asOwner.create('late.md'); // 4
    await w.asOwner.rollback(2);
    expect(await w.state()).toEqual(at2);
  });

  it('can restore the very first state, even an empty project', async () => {
    const w = await world(t);
    const first = await w.state();
    await w.asOwner.del('readme.md');
    await w.asOwner.create('x/y.md');
    await w.asOwner.rollback(1);
    expect(await w.state()).toEqual(first);
  });

  it('a rollback can be rolled back (history is never destroyed)', async () => {
    const w = await world(t);
    await w.asOwner.save('readme.md', 'v2', 1); // 2
    const at2 = await w.state();
    await w.asOwner.rollback(1); // 3
    const at3 = await w.state();
    expect(at3).not.toEqual(at2);
    await w.asOwner.rollback(2); // 4: back to v2
    expect(await w.state()).toEqual(at2);
    await w.asOwner.rollback(3); // 5: back to v1 again
    expect(await w.state()).toEqual(at3);
    expect((await w.changes()).length).toBe(5);
  });

  it('rolling back to a rollback entry restores the state right after it', async () => {
    const w = await world(t);
    await w.asOwner.save('readme.md', 'v2', 1);
    await w.asOwner.rollback(1); // 3
    const at3 = await w.state();
    await w.asOwner.create('later.md');
    await w.asOwner.rollback(3);
    expect(await w.state()).toEqual(at3);
  });

  it('tells you when there is nothing to do, and changes nothing', async () => {
    const w = await world(t);
    const res = await w.asOwner.rollback(1);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('already_at_state');
    expect((await w.changes()).length).toBe(1);
    await w.asOwner.save('readme.md', 'x', 1);
    await w.asOwner.rollback(1);
    expect((await w.asOwner.rollback(1)).body.error.code).toBe('already_at_state');
    expect((await w.asOwner.rollback(3)).body.error.code).toBe('already_at_state'); // #3 is the current state
  });

  it('404 for an unknown change, 400 for a bad number', async () => {
    const w = await world(t);
    expect((await w.asOwner.rollback(42)).status).toBe(404);
    for (const bad of ['0', '-3', 'abc', '2.5']) expect((await w.asOwner.rollback(bad)).status, bad).toBe(400);
  });

  it('a read-only caller cannot roll back', async () => {
    const w = await world(t);
    await w.asOwner.save('readme.md', 'x', 1);
    const res = await w.asRo.rollback(1);
    expect(res.status).toBe(403);
    expect((await w.asOwner.read('readme.md')).body.file.content).toBe('x');
  });

  it('records who rolled back; a read-write caller may under the default policy', async () => {
    const w = await world(t);
    await w.asOwner.save('readme.md', 'x', 1);
    expect((await w.asRw('Sam').rollback(1)).status).toBe(200);
    expect((await w.changes()).at(-1)).toMatchObject({ kind: 'rollback', actor_type: 'password', actor_name: 'Sam' });
  });

  describe('policy author_only (only the project owner)', () => {
    const setup = async () => {
      const w = await world(t);
      await request(w.app).patch(`/api/projects/${w.p.id}`).set('Cookie', w.owner.cookie).send({ rollbackPolicy: 'author_only' });
      await w.asOwner.save('readme.md', 'by owner', 1); // 2: the owner
      await w.asRw('Sam').create('sam.md', 'file', 'by sam'); // 3: a password user
      return w;
    };

    it('lets the owner roll back to ANY change, whoever made it', async () => {
      const w = await setup();
      expect((await w.asOwner.rollback(2)).status).toBe(200); // the owner's own change
      expect((await w.asOwner.rollback(3)).status).toBe(200); // Sam's change: the owner may still go back to it
      expect((await w.asOwner.rollback(1)).status).toBe(200);
    });

    it('never lets a read-write password roll back, not even to its own change', async () => {
      const w = await setup();
      for (const name of ['Sam', 'Kim', undefined]) {
        for (const seq of [1, 2, 3]) {
          const res = await w.asRw(name).rollback(seq);
          expect([res.status, res.body.error.code], `${name} -> #${seq}`).toEqual([403, 'rollback_not_allowed']);
        }
      }
      expect((await w.changes()).length).toBe(3); // nothing changed
    });

    it('a read-write caller who came through the gate is refused too', async () => {
      const w = await setup();
      const cookie = await gate(w.app, w.p.id, w.p.rw, 'Sam');
      const res = await api(w.app, w.p.id, { cookie }).rollback(1);
      expect([res.status, res.body.error.code]).toEqual([403, 'rollback_not_allowed']);
    });

    it('read-only is still refused as read_only, and an unknown change is still 404 for the owner', async () => {
      const w = await setup();
      expect((await w.asRo.rollback(1)).body.error.code).toBe('read_only');
      expect((await w.asOwner.rollback(99)).status).toBe(404);
    });

    it('a refusal tells nothing about which changes exist (same answer for a real and a missing change)', async () => {
      const w = await setup();
      const real = await w.asRw('Sam').rollback(1);
      const missing = await w.asRw('Sam').rollback(99);
      expect(real.status).toBe(403);
      expect(missing.body).toEqual(real.body);
    });

    it('a signed-in user who is not the owner has no access at all (needs the gate first)', async () => {
      const w = await setup();
      const stranger = await signUp(w.app, 'someoneelse');
      expect((await api(w.app, w.p.id, { cookie: stranger.cookie }).rollback(1)).status).toBe(401);
    });

    it('switching back to the open policy lets read-write passwords roll back again', async () => {
      const w = await setup();
      await request(w.app).patch(`/api/projects/${w.p.id}`).set('Cookie', w.owner.cookie).send({ rollbackPolicy: 'author_and_write' });
      expect((await w.asRw('Kim').rollback(2)).status).toBe(200);
    });
  });

  describe('policy author_and_write (the default)', () => {
    it('lets the owner and any read-write password roll back; read-only never', async () => {
      const w = await world(t);
      await w.asOwner.save('readme.md', 'v2', 1);
      await w.asRw('Sam').create('a.md');
      expect((await w.asRo.rollback(1)).status).toBe(403);
      expect((await w.asRw('Kim').rollback(2)).status).toBe(200);
      expect((await w.asOwner.rollback(1)).status).toBe(200);
    });
  });

  it('two rollbacks at the same moment: both succeed or one is a no-op, history stays consistent', async () => {
    const w = await world(t);
    await w.asOwner.save('readme.md', 'v2', 1);
    await w.asOwner.create('b.md');
    const res = await Promise.all([w.asRw('a').rollback(1), w.asRw('b').rollback(1)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(Object.keys(await w.state())).toEqual(['readme.md']);
    const seqs = (await w.changes()).map((c) => c.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it('bumps the version of restored files so an old editor tab cannot overwrite them silently', async () => {
    const w = await world(t);
    await w.asOwner.save('readme.md', 'v2', 1); // version 2
    await w.asOwner.rollback(1); // version 3
    const stale = await w.asOwner.save('readme.md', 'from an old tab', 2);
    expect(stale.status).toBe(409);
  });
});
