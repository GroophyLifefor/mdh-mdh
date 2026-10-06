// The history logic, with no database: given the current tree and the recorded changes, rebuild an older tree,
// and work out what it takes to get from one tree to another. Pure functions, easy to test hard.
import type { FileDelta } from './services/history';

export type NodeState = { kind: 'dir' | 'file'; content: string };
export type State = Map<string, NodeState>;
export type Delta = FileDelta;

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Applies one change forward. */
export function applyDeltas(state: State, deltas: Delta[]): void {
  for (const d of deltas) {
    if (d.action === 'deleted') state.delete(d.path);
    else state.set(d.path, { kind: d.kind, content: d.after ?? '' });
  }
}

/** Takes one change back. */
export function revertDeltas(state: State, deltas: Delta[]): void {
  for (const d of deltas) {
    if (d.action === 'created') state.delete(d.path);
    else state.set(d.path, { kind: d.kind, content: d.before ?? '' });
  }
}

/** The tree as it was right after the change that comes before `changesNewestFirst`. Does not modify `current`. */
export function rewind(current: State, changesNewestFirst: Delta[][]): State {
  const state: State = new Map([...current].map(([p, n]) => [p, { ...n }]));
  for (const deltas of changesNewestFirst) revertDeltas(state, deltas);
  return state;
}

/** What to do to turn `from` into `to`, sorted by path. Applying the result to `from` gives `to`. */
export function diff(from: State, to: State): Delta[] {
  const out: Delta[] = [];
  for (const [path, node] of to) {
    const old = from.get(path);
    if (!old) out.push({ path, kind: node.kind, action: 'created', before: null, after: node.content });
    else if (old.kind !== node.kind) throw new Error(`diff: ${path} is a ${old.kind} in one tree and a ${node.kind} in the other`); // cannot happen: see nodes_dir_not_file_name
    else if (old.content !== node.content) out.push({ path, kind: node.kind, action: 'updated', before: old.content, after: node.content });
  }
  for (const [path, node] of from) if (!to.has(path)) out.push({ path, kind: node.kind, action: 'deleted', before: node.content, after: null });
  return out.sort(byPath);
}

export const sameState = (a: State, b: State) => diff(a, b).length === 0;
