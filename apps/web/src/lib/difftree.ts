// The file list of the diff view: a tree like the Files panel, with chains of single folders written on one line
// ("compact folders"), so a long path such as a/b/c/d/file.md costs one folder row, not four.
export type ChangedFile = { path: string; action: 'created' | 'updated' | 'deleted' };
export type DiffRow =
  | { type: 'dir'; path: string; label: string; depth: number; count: number; closed: boolean }
  | { type: 'file'; path: string; name: string; depth: number; action: ChangedFile['action'] };

type Dir = { dirs: Map<string, Dir>; files: ChangedFile[] };
const byByteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function build(files: ChangedFile[]): Dir {
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let at = root;
    for (const p of parts.slice(0, -1)) {
      if (!at.dirs.has(p)) at.dirs.set(p, { dirs: new Map(), files: [] });
      at = at.dirs.get(p)!;
    }
    at.files.push(f);
  }
  return root;
}

const countFiles = (d: Dir): number => d.files.length + [...d.dirs.values()].reduce((n, c) => n + countFiles(c), 0);
const sortedDirs = (d: Dir) => [...d.dirs.entries()].sort((a, b) => byByteOrder(a[0], b[0]));
const sortedFiles = (d: Dir) => [...d.files].sort((a, b) => byByteOrder(a.path, b.path));

/** The rows to draw: folders before files at every level, nothing inside a closed folder. `closed` holds folder paths (the last folder of a chain). */
export function buildRows(files: ChangedFile[], closed: ReadonlySet<string>): DiffRow[] {
  const rows: DiffRow[] = [];
  const walk = (dir: Dir, prefix: string, depth: number) => {
    for (const [name, child] of sortedDirs(dir)) {
      let label = name, path = prefix ? `${prefix}/${name}` : name, cur = child;
      while (cur.files.length === 0 && cur.dirs.size === 1) {                // a chain of single folders: one row
        const [n, next] = [...cur.dirs.entries()][0]!;
        label += `/${n}`; path += `/${n}`; cur = next;
      }
      const isClosed = closed.has(path);
      rows.push({ type: 'dir', path, label, depth, count: countFiles(cur), closed: isClosed });
      if (!isClosed) walk(cur, path, depth + 1);
    }
    for (const f of sortedFiles(dir)) rows.push({ type: 'file', path: f.path, name: f.path.slice(f.path.lastIndexOf('/') + 1), depth, action: f.action });
  };
  walk(build(files), '', 0);
  return rows;
}

/** Every file in the order the tree shows them (also those inside closed folders): for previous / next. */
export function orderedPaths(files: ChangedFile[]): string[] {
  const out: string[] = [];
  const walk = (dir: Dir) => { for (const [, child] of sortedDirs(dir)) walk(child); for (const f of sortedFiles(dir)) out.push(f.path); };
  walk(build(files));
  return out;
}

/** "27 files: 27 new", "5 files: 3 changed, 2 new" */
export function summarize(files: ChangedFile[]): string {
  const n = files.length;
  const count = (a: ChangedFile['action']) => files.filter((f) => f.action === a).length;
  const parts = ([['updated', 'changed'], ['created', 'new'], ['deleted', 'deleted']] as const)
    .map(([a, w]) => [count(a), w] as const).filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}`);
  return `${n} file${n === 1 ? '' : 's'}${n > 1 ? ': ' + parts.join(', ') : ''}`;
}

/** The folders that must be open to see `path`: all its parents (a chain row is closed by its last folder). */
export function parentsOf(path: string): string[] {
  const out: string[] = [];
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) out.push(path.slice(0, i));
  return out;
}
