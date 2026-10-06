import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyDeltas, diff, revertDeltas, rewind, sameState, type State } from '../src/rewind';

const file = (content: string) => ({ kind: 'file' as const, content });
const dir = () => ({ kind: 'dir' as const, content: '' });
const state = (o: Record<string, { kind: 'file' | 'dir'; content: string }>): State => new Map(Object.entries(o));

describe('diff', () => {
  it('finds created, updated and deleted paths, sorted by path', () => {
    const from = state({ 'a.md': file('1'), 'b.md': file('2'), 'gone.md': file('x') });
    const to = state({ 'a.md': file('1'), 'b.md': file('changed'), 'new.md': file('n') });
    expect(diff(from, to)).toEqual([
      { path: 'b.md', kind: 'file', action: 'updated', before: '2', after: 'changed' },
      { path: 'gone.md', kind: 'file', action: 'deleted', before: 'x', after: null },
      { path: 'new.md', kind: 'file', action: 'created', before: null, after: 'n' },
    ]);
  });
  it('is empty for equal states (also for two empty files)', () => {
    expect(diff(state({ 'a.md': file('') }), state({ 'a.md': file('') }))).toEqual([]);
    expect(diff(new Map(), new Map())).toEqual([]);
  });
  it('tells an empty file from a missing one', () => {
    expect(diff(new Map(), state({ 'a.md': file('') }))).toEqual([{ path: 'a.md', kind: 'file', action: 'created', before: null, after: '' }]);
    expect(diff(state({ 'a.md': file('') }), new Map())).toEqual([{ path: 'a.md', kind: 'file', action: 'deleted', before: '', after: null }]);
  });
  it('handles folders like files with empty content', () => {
    expect(diff(new Map(), state({ d: dir() }))).toEqual([{ path: 'd', kind: 'dir', action: 'created', before: null, after: '' }]);
  });
  it('refuses to describe a path that is a file in one tree and a folder in the other (cannot happen in real data)', () => {
    expect(() => diff(state({ x: file('') }), state({ x: dir() }))).toThrow(/file in one tree/);
  });
  it('sorts in byte order, not locale order', () => {
    const out = diff(new Map(), state({ 'b.md': file(''), 'B.md': file(''), 'a.md': file('') })).map((d) => d.path);
    expect(out).toEqual(['B.md', 'a.md', 'b.md']);
  });
});

describe('rewind', () => {
  it('undoes changes newest first and leaves the input untouched', () => {
    const s0 = state({ 'a.md': file('v0') });
    const s1 = state({ 'a.md': file('v1'), 'b.md': file('b') });
    const s2 = state({ 'b.md': file('b') });
    const c1 = diff(s0, s1), c2 = diff(s1, s2);
    const snapshot = JSON.stringify([...s2]);
    expect(rewind(s2, [c2])).toEqual(s1);
    expect(rewind(s2, [c2, c1])).toEqual(s0);
    expect(JSON.stringify([...s2])).toBe(snapshot);
  });
  it('with no changes returns an equal copy, not the same object', () => {
    const s = state({ 'a.md': file('x') });
    const r = rewind(s, []);
    expect(r).toEqual(s);
    expect(r).not.toBe(s);
    expect(r.get('a.md')).not.toBe(s.get('a.md'));
  });
  it('restores deleted folders with their files', () => {
    const before = state({ d: dir(), 'd/a.md': file('A'), 'd/b.md': file('B') });
    const after: State = new Map();
    expect(rewind(after, [diff(before, after)])).toEqual(before);
  });
});

describe('applyDeltas / revertDeltas', () => {
  it('are inverses', () => {
    const a = state({ 'a.md': file('1'), 'x.md': file('keep') });
    const b = state({ 'a.md': file('2'), 'n.md': file('new'), 'x.md': file('keep') });
    const d = diff(a, b);
    const forward = new Map(a); applyDeltas(forward, d);
    expect(forward).toEqual(b);
    revertDeltas(forward, d);
    expect(forward).toEqual(a);
  });
});

// ---- property tests: random trees ----
const segment = fc.constantFrom('a', 'b', 'c');
const filePath = fc.tuple(fc.array(segment, { maxLength: 2 }), fc.constantFrom('x.md', 'y.yml', 'z.yaml')).map(([d, f]) => [...d, f].join('/'));
const content = fc.string({ maxLength: 12 });
/** A consistent tree: every file's folders exist as folder entries. */
const tree = fc.array(fc.tuple(filePath, content), { maxLength: 8 }).map((entries) => {
  const s: State = new Map();
  for (const [p, c] of entries) {
    s.set(p, file(c));
    const parts = p.split('/'); parts.pop();
    for (let i = 1; i <= parts.length; i++) s.set(parts.slice(0, i).join('/'), dir());
  }
  return s;
});

describe('properties', () => {
  it('apply(diff(a, b)) on a gives b, and revert gives a back', () => {
    fc.assert(fc.property(tree, tree, (a, b) => {
      const s = new Map([...a].map(([k, v]) => [k, { ...v }]));
      const d = diff(a, b);
      applyDeltas(s, d);
      expect(sameState(s, b)).toBe(true);
      revertDeltas(s, d);
      expect(sameState(s, a)).toBe(true);
    }), { numRuns: 500 });
  });
  it('diff(a, a) is empty and diff only mentions paths that differ', () => {
    fc.assert(fc.property(tree, tree, (a, b) => {
      expect(diff(a, a)).toEqual([]);
      for (const d of diff(a, b)) {
        if (d.action === 'created') expect(a.has(d.path)).toBe(false);
        if (d.action === 'deleted') expect(b.has(d.path)).toBe(false);
        if (d.action === 'updated') expect(a.get(d.path)!.content).not.toBe(b.get(d.path)!.content);
      }
    }), { numRuns: 500 });
  });
  it('rewinding the recorded diffs of a random sequence of trees gives back every earlier tree', () => {
    fc.assert(fc.property(fc.array(tree, { minLength: 2, maxLength: 7 }), (states) => {
      const deltas = states.slice(1).map((s, i) => diff(states[i]!, s));
      const final = states[states.length - 1]!;
      for (let k = 0; k < states.length; k++) {
        const newestFirst = deltas.slice(k).reverse(); // changes k+1.. undone, newest first
        expect(sameState(rewind(final, newestFirst), states[k]!), `step ${k}`).toBe(true);
      }
    }), { numRuns: 300 });
  });
});
