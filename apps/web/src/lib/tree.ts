import { baseOf, parentOf } from './paths';

export type NodeLike = { path: string; kind: 'dir' | 'file' };
export type Row = { path: string; name: string; depth: number; kind: 'dir' | 'file' };

const byByteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The rows to draw, folders before files at every level, skipping everything inside a collapsed folder. */
export function visibleRows(nodes: NodeLike[], closed: ReadonlySet<string>): Row[] {
  const kids = new Map<string, NodeLike[]>();
  for (const n of nodes) {
    const parent = parentOf(n.path);
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent)!.push(n);
  }
  const rows: Row[] = [];
  const walk = (parent: string, depth: number) => {
    const list = (kids.get(parent) ?? []).sort((a, b) => (a.kind === b.kind ? byByteOrder(a.path, b.path) : a.kind === 'dir' ? -1 : 1));
    for (const n of list) {
      rows.push({ path: n.path, name: baseOf(n.path), depth, kind: n.kind });
      if (n.kind === 'dir' && !closed.has(n.path)) walk(n.path, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}

export const dirPaths = (nodes: NodeLike[]) => new Set(nodes.filter((n) => n.kind === 'dir').map((n) => n.path));

/** After a rename: every entry at or below `from` moves to `to`. Works for sets of paths (open folders, selection...). */
export function remapPaths(paths: Iterable<string>, from: string, to: string): Set<string> {
  return new Set([...paths].map((p) => (p === from || p.startsWith(from + '/') ? to + p.slice(from.length) : p)));
}
export function remapPath(p: string, from: string, to: string): string {
  return p === from || p.startsWith(from + '/') ? to + p.slice(from.length) : p;
}

/** After a delete: drop `path` and everything below it. */
export function dropPaths(paths: Iterable<string>, path: string): Set<string> {
  return new Set([...paths].filter((p) => p !== path && !p.startsWith(path + '/')));
}
