// A line diff for the "what changed" view. No dependency: common start and end are cut off first, the middle goes
// through Myers' algorithm. A middle that is too different (very large) is shown as "all removed, all added", which is
// still a correct diff, only not the smallest one.
export type Row = { type: 'ctx' | 'add' | 'del'; text: string; oldNo: number | null; newNo: number | null };
export type Gap = { type: 'gap'; hidden: number };

const MAX_EDIT_DISTANCE = 3000;

/** Lines of a text. A final line break ends the last line (it does not start an empty one). */
const splitLines = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** Shortest edit script between two line lists, as a list of 'ctx' | 'add' | 'del' steps (Myers). null when it is too long. */
function myers(a: string[], b: string[]): ('ctx' | 'add' | 'del')[] | null {
  const n = a.length, m = b.length, max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, d, offset, a, b);
    }
    v = v.slice();
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number, dEnd: number, offset: number, a: string[], b: string[]): ('ctx' | 'add' | 'del')[] {
  const steps: ('ctx' | 'add' | 'del')[] = [];
  let x = n, y = m;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!, prevY = prevX - prevK;
    while (x > prevX && y > prevY) { steps.push('ctx'); x--; y--; }
    steps.push(down ? 'add' : 'del');
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { steps.push('ctx'); x--; y--; }
  void a; void b;
  return steps.reverse();
}

export type Op = { type: 'ctx' | 'add' | 'del'; a: number; b: number };   // a: index in the old list (-1 for an addition), b: index in the new list (-1 for a removal)

/** Aligns two lists of strings: which items stay, which are removed from the old list, which are added in the new one. */
export function align(a: string[], b: string[]): { ops: Op[]; exact: boolean } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);

  let steps = midA.length === 0 || midB.length === 0 ? null : myers(midA, midB);
  let exact = true;
  if (!steps) {
    if (midA.length && midB.length) exact = false;                          // too different: remove all, add all
    steps = [...midA.map(() => 'del' as const), ...midB.map(() => 'add' as const)];
  }

  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'ctx', a: i, b: i });
  let ia = start, ib = start;
  for (const s of steps) {
    if (s === 'ctx') ops.push({ type: 'ctx', a: ia++, b: ib++ });
    else if (s === 'del') ops.push({ type: 'del', a: ia++, b: -1 });
    else ops.push({ type: 'add', a: -1, b: ib++ });
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ type: 'ctx', a: endA + k, b: endB + k });
  return { ops, exact };
}

/** The rows of a line diff between two texts. */
export function diffLines(before: string, after: string): { rows: Row[]; exact: boolean } {
  const a = splitLines(before), b = splitLines(after);
  const { ops, exact } = align(a, b);
  const rows: Row[] = ops.map((op) => op.type === 'ctx' ? { type: 'ctx', text: a[op.a]!, oldNo: op.a + 1, newNo: op.b + 1 }
    : op.type === 'del' ? { type: 'del', text: a[op.a]!, oldNo: op.a + 1, newNo: null }
    : { type: 'add', text: b[op.b]!, oldNo: null, newNo: op.b + 1 });
  return { rows, exact };
}

/** Keeps `context` unchanged lines around each change and replaces longer unchanged stretches with a gap marker. */
export function withContext(rows: Row[], context = 3): (Row | Gap)[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.type === 'ctx') return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true;
  });
  const out: (Row | Gap)[] = [];
  let hidden = 0;
  rows.forEach((r, i) => {
    if (keep[i]) { if (hidden) { out.push({ type: 'gap', hidden }); hidden = 0; } out.push(r); }
    else hidden++;
  });
  if (hidden) out.push({ type: 'gap', hidden });
  return out;
}

export const countChanges = (rows: Row[]) => ({ added: rows.filter((r) => r.type === 'add').length, removed: rows.filter((r) => r.type === 'del').length });
