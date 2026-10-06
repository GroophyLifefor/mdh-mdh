import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mergeHistory, type HistoryList } from '../src/lib/history';
import type { ChangeInfo } from '../src/lib/types';

const change = (seq: number, updatedAt = 't'): ChangeInfo => ({
  seq, kind: 'edit', summary: `s${seq}`, targetSeq: null, createdAt: 't', updatedAt, actor: { type: 'user', name: 'a', label: 'a' },
});
/** What the server would send: seqs `from` down to `to` (inclusive), and where the next page starts. */
const page = (from: number, to: number, min = 1): HistoryList => ({
  changes: Array.from({ length: from - to + 1 }, (_, i) => change(from - i)),
  nextBefore: to > min ? to : null,
});
const seqs = (l: HistoryList) => l.changes.map((c) => c.seq);

describe('mergeHistory', () => {
  it('shows the fresh page when nothing was loaded before', () => {
    expect(mergeHistory({ changes: [], nextBefore: null }, page(10, 6))).toEqual(page(10, 6));
  });
  it('a new change on top of a list that was already complete stays complete', () => {
    const merged = mergeHistory(page(5, 1), page(6, 1));
    expect(seqs(merged)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(merged.nextBefore).toBeNull();
  });
  it('keeps older pages the person loaded when they join the fresh page', () => {
    const existing: HistoryList = { changes: [...page(60, 41).changes, ...page(40, 21).changes], nextBefore: 21 };   // two pages loaded
    const merged = mergeHistory(existing, page(61, 52));                                                              // one new change, fresh page of 10
    expect(seqs(merged)).toEqual([...Array.from({ length: 61 - 21 + 1 }, (_, i) => 61 - i)]);
    expect(merged.nextBefore).toBe(21);
  });
  it('drops older entries that would leave a gap, and continues from the end of the fresh page', () => {
    const existing = page(11, 1);                       // had everything up to 11
    const merged = mergeHistory(existing, page(71, 22)); // 60 new changes arrived, the fresh page reaches back to 22 only
    expect(seqs(merged)).toEqual(Array.from({ length: 50 }, (_, i) => 71 - i));
    expect(merged.nextBefore).toBe(22);                  // "load older" starts at 22: seq 12..21 are not skipped
  });
  it('takes the fresh version of an entry that changed (an edit that was merged keeps its seq)', () => {
    const existing: HistoryList = { changes: [change(3, 'old'), change(2), change(1)], nextBefore: null };
    const fresh: HistoryList = { changes: [change(3, 'new'), change(2), change(1)], nextBefore: null };
    expect(mergeHistory(existing, fresh).changes[0]!.updatedAt).toBe('new');
  });
  it('an empty fresh page replaces everything (every change is gone, e.g. the project restarted)', () => {
    expect(mergeHistory(page(5, 1), { changes: [], nextBefore: null })).toEqual({ changes: [], nextBefore: null });
  });
  it('property: the result is newest first, has no duplicates and no gaps, and nextBefore points right below the last entry', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 200 }),                  // how many changes the project has now
      fc.integer({ min: 0, max: 200 }),                  // how many it had when we last loaded
      fc.integer({ min: 1, max: 4 }),                    // how many pages we had loaded
      fc.integer({ min: 1, max: 60 }),                   // page size
      (total, before, pages, size) => {
        const had = Math.min(before, total);
        const loadedTo = Math.max(1, had - pages * size + 1);
        const existing: HistoryList = had === 0 ? { changes: [], nextBefore: null } : page(had, loadedTo);
        const freshTo = Math.max(1, total - size + 1);
        const merged = mergeHistory(existing, page(total, freshTo));
        const s = seqs(merged);
        expect(s[0]).toBe(total);
        for (let i = 1; i < s.length; i++) expect(s[i]).toBe(s[i - 1]! - 1);   // sorted, unique, contiguous
        const last = s.at(-1)!;
        expect(merged.nextBefore).toBe(last > 1 ? last : null);
      },
    ), { numRuns: 500 });
  });
});
