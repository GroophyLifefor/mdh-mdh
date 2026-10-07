import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { countChanges, diffLines, withContext, type Row } from '../src/lib/diff';

const lines = (t: string) => { if (t === '') return []; const l = t.replace(/\r\n/g, '\n').split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };
const before = (rows: Row[]) => rows.filter((r) => r.type !== 'add').map((r) => r.text);
const after = (rows: Row[]) => rows.filter((r) => r.type !== 'del').map((r) => r.text);

describe('diffLines', () => {
  it('shows exactly what was added, removed and kept', () => {
    const { rows, exact } = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(exact).toBe(true);
    expect(rows.map((r) => `${r.type}:${r.text}`)).toEqual(['ctx:a', 'del:b', 'add:B', 'ctx:c', 'add:d']);
  });
  it('handles empty sides (a created or deleted file)', () => {
    expect(diffLines('', 'x\ny').rows.map((r) => r.type)).toEqual(['add', 'add']);
    expect(diffLines('x\ny', '').rows.map((r) => r.type)).toEqual(['del', 'del']);
    expect(diffLines('', '').rows).toEqual([]);
    expect(diffLines('same', 'same').rows.map((r) => r.type)).toEqual(['ctx']);
    expect(diffLines('a\n', 'a\n').rows).toHaveLength(1);                     // a final line break does not make an extra empty line
  });
  it('numbers the lines of each side', () => {
    const { rows } = diffLines('a\nb', 'a\nx\nb');
    expect(rows).toEqual([
      { type: 'ctx', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'add', text: 'x', oldNo: null, newNo: 2 },
      { type: 'ctx', text: 'b', oldNo: 2, newNo: 3 },
    ]);
  });
  it('treats Windows line ends like Unix ones', () => {
    expect(diffLines('a\r\nb', 'a\nb').rows.every((r) => r.type === 'ctx')).toBe(true);
  });
  it('PROPERTY: the rows rebuild both texts, and the diff is minimal-ish (never more changes than lines)', () => {
    const text = fc.array(fc.constantFrom('a', 'b', 'c', 'd', '', 'line with spaces'), { maxLength: 40 }).map((l) => l.join('\n'));
    fc.assert(fc.property(text, text, (x, y) => {
      const { rows } = diffLines(x, y);
      expect(before(rows)).toEqual(lines(x));
      expect(after(rows)).toEqual(lines(y));
      const { added, removed } = countChanges(rows);
      expect(added).toBeLessThanOrEqual(lines(y).length);
      expect(removed).toBeLessThanOrEqual(lines(x).length);
    }), { numRuns: 300 });
  });
  it('a single changed line in a long file is found exactly (not "everything changed")', () => {
    const x = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    const y = [...x]; y[1000] = 'CHANGED';
    const { rows, exact } = diffLines(x.join('\n'), y.join('\n'));
    expect(exact).toBe(true);
    expect(countChanges(rows)).toEqual({ added: 1, removed: 1 });
  });
  it('two completely different big files fall back to remove-all / add-all, still correct, and quickly', () => {
    const x = Array.from({ length: 5000 }, (_, i) => `old ${i}`).join('\n');
    const y = Array.from({ length: 5000 }, (_, i) => `new ${i}`).join('\n');
    const t0 = Date.now();
    const { rows, exact } = diffLines(x, y);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(exact).toBe(false);
    expect(before(rows)).toEqual(lines(x));
    expect(after(rows)).toEqual(lines(y));
  });
});

describe('withContext', () => {
  it('keeps 3 lines around changes and folds the rest into a gap with its size', () => {
    const x = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const y = [...x]; y[15] = 'X';
    const shown = withContext(diffLines(x.join('\n'), y.join('\n')).rows);
    expect(shown.map((r) => ('hidden' in r ? `gap ${r.hidden}` : `${r.type}:${r.text}`))).toEqual([
      'gap 12', 'ctx:l12', 'ctx:l13', 'ctx:l14', 'del:l15', 'add:X', 'ctx:l16', 'ctx:l17', 'ctx:l18', 'gap 11',
    ]);
  });
  it('shows everything when nothing is far from a change, and nothing for an identical text', () => {
    expect(withContext(diffLines('a\nb', 'a\nc').rows).some((r) => r.type === 'gap')).toBe(false);
    expect(withContext(diffLines('a\nb\nc\nd\ne\nf\ng\nh\ni', 'a\nb\nc\nd\ne\nf\ng\nh\ni').rows)).toEqual([{ type: 'gap', hidden: 9 }]);
  });
});
