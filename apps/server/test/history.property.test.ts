// Random sequences of real operations against a real database. After every step the tree is photographed; at the end,
// rewinding the recorded history from the final tree must reproduce EVERY photograph, and every rollback must land exactly on
// the photograph of the change it names.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createTestDb, type TestDb } from './db';
import { makeApp, signUp, newProject } from './helpers';
import { api } from './api';
import { rewind, type State } from '../src/rewind';
import { normalizePath, ancestorsOf } from '../src/paths';

type Op =
  | { t: 'create'; path: string; kind: 'file' | 'dir'; content: string }
  | { t: 'save'; path: string; content: string }
  | { t: 'move'; from: string; to: string }
  | { t: 'del'; path: string }
  | { t: 'upload'; files: { path: string; content: string }[]; overwrite: boolean }
  | { t: 'rollback'; seq: number }
  | { t: 'wait'; ms: number };

const dirName = fc.constantFrom('a', 'b', 'c');
const fileName = fc.constantFrom('x.md', 'y.yml', 'z.yaml');
const dirPath = fc.array(dirName, { minLength: 1, maxLength: 2 }).map((p) => p.join('/'));
const filePath = fc.tuple(fc.array(dirName, { maxLength: 2 }), fileName).map(([d, f]) => [...d, f].join('/'));
const anyPath = fc.oneof(dirPath, filePath);
const content = fc.oneof(fc.constant(''), fc.string({ maxLength: 10 }), fc.constantFrom('same', 'text', 'ünï 🙂'));

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('create' as const), path: fc.oneof(dirPath, filePath), kind: fc.constantFrom('file' as const, 'dir' as const), content }).map((o) => ({ ...o, path: o.kind === 'dir' ? (o.path.match(/\.(md|ya?ml)$/) ? o.path.replace(/\./g, '_') : o.path) : o.path })) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('save' as const), path: filePath, content }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('move' as const), from: anyPath, to: anyPath }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('del' as const), path: anyPath }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('upload' as const), files: fc.array(fc.record({ path: filePath, content }), { maxLength: 3 }), overwrite: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('rollback' as const), seq: fc.integer({ min: 1, max: 12 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('wait' as const), ms: fc.constantFrom(1000, 400_000, 700_000) }) },
);

describe('history (random operations, real database)', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.drop(); });

  it('every rollback lands exactly on the tree after the change it names, and rewinding reproduces every past tree', async () => {
    const { app, clock } = makeApp(t);
    const owner = await signUp(app);

    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 22 }), async (ops) => {
        const p = await newProject(app, owner.cookie, 'prop');
        const asOwner = api(app, p.id, { cookie: owner.cookie });
        const asBot = api(app, p.id, { token: p.rw, name: 'bot' });
        const readState = async (): Promise<State> => {
          const { rows } = await t.db.query('SELECT path, kind, content FROM nodes WHERE project_id = $1', [p.id]);
          return new Map(rows.map((r) => [r.path as string, { kind: r.kind as 'dir' | 'file', content: r.content as string }]));
        };
        const lastSeq = async () => (await t.db.query('SELECT last_seq FROM projects WHERE id = $1', [p.id])).rows[0].last_seq as number;
        const photos = new Map<number, State>([[1, await readState()]]);

        let i = 0;
        for (const o of ops) {
          const who = i++ % 3 === 0 ? asBot : asOwner; // two kinds of author
          let res;
          switch (o.t) {
            case 'create': res = await who.create(o.path, o.kind, o.kind === 'file' ? o.content : undefined); break;
            case 'save': {
              const cur = await who.read(o.path);
              if (cur.status !== 200) { res = cur; break; }
              res = await who.save(o.path, o.content, cur.body.file.version); break;
            }
            case 'move': res = await who.move(o.from, o.to); break;
            case 'del': res = await who.del(o.path); break;
            case 'upload': res = await who.upload(o.files, { overwrite: o.overwrite }); break;
            case 'rollback': {
              const before = await readState();
              res = await who.rollback(o.seq);
              if (res.status === 200) {
                const target = photos.get(o.seq);
                // the tree must now equal the photograph taken right after change #seq
                expect(target, `no photo for #${o.seq}`).toBeDefined();
                expect(await readState(), `rollback to #${o.seq}`).toEqual(target);
              } else if (res.status === 409) expect(await readState()).toEqual(before);
              break;
            }
            case 'wait': clock.advance(o.ms); continue;
          }
          expect(res.status, `${JSON.stringify(o)} -> ${JSON.stringify(res.body)}`).toBeLessThan(500); // never a crash
          photos.set(await lastSeq(), await readState()); // a merged edit changes the photo of the last change
        }

        // 1. numbering: 1..N, no gaps, each change has at least one file row
        const seqs = (await t.db.query('SELECT seq FROM changes WHERE project_id = $1 ORDER BY seq', [p.id])).rows.map((r) => r.seq);
        expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, k) => k + 1));
        expect((await t.db.query('SELECT count(*)::int AS n FROM changes c WHERE project_id = $1 AND NOT EXISTS (SELECT 1 FROM change_files WHERE change_id = c.id)', [p.id])).rows[0].n).toBe(0);

        // 2. rewinding from the final tree reproduces every photo
        const final = await readState();
        const { rows } = await t.db.query('SELECT c.seq, cf.path, cf.kind, cf.action, cf.before, cf.after FROM changes c JOIN change_files cf ON cf.change_id = c.id WHERE c.project_id = $1 ORDER BY c.seq DESC', [p.id]);
        for (const [seq, photo] of photos) {
          const later = new Map<number, typeof rows>();
          for (const r of rows) if (r.seq > seq) later.set(r.seq, [...(later.get(r.seq) ?? []), r]);
          const groups = [...later.entries()].sort((a, b) => b[0] - a[0]).map(([, rs]) => rs.map((r) => ({ path: r.path, kind: r.kind, action: r.action, before: r.before, after: r.after })));
          expect(rewind(final, groups), `rewind to #${seq}`).toEqual(photo);
        }

        // 3. the tree itself is sound: valid paths, every folder above a node exists and is a folder, nothing is both
        for (const [path, node] of final) {
          expect(normalizePath(path)).toBe(path);
          for (const a of ancestorsOf(path)) expect(final.get(a)?.kind, `${a} above ${path}`).toBe('dir');
          if (node.kind === 'dir') expect(node.content).toBe('');
        }
      }),
      { numRuns: 60, endOnFailure: true },
    );
  }, 180_000);
});
