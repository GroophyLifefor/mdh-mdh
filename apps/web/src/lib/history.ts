import type { ChangeInfo } from './types';

export type HistoryList = { changes: ChangeInfo[]; nextBefore: number | null };

/**
 * Combines the list we already show (newest first, possibly several pages long) with a freshly fetched first page.
 * Entries from earlier pages are kept only when they join the fresh page without a gap; otherwise they are dropped and
 * "load older" continues from the end of the fresh page, so the list never skips a change.
 */
export function mergeHistory(existing: HistoryList, fresh: HistoryList): HistoryList {
  const oldestFresh = fresh.changes.at(-1)?.seq;
  if (oldestFresh === undefined) return fresh;
  const older = existing.changes.filter((c) => c.seq < oldestFresh);
  const joins = older.length > 0 && older[0]!.seq === oldestFresh - 1;
  return joins ? { changes: [...fresh.changes, ...older], nextBefore: existing.nextBefore } : fresh;
}
