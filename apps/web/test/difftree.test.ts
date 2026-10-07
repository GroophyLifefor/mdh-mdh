import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildRows, orderedPaths, parentsOf, summarize, type ChangedFile } from '../src/lib/difftree';

const f = (path: string, action: ChangedFile['action'] = 'created'): ChangedFile => ({ path, action });
const show = (rows: ReturnType<typeof buildRows>) => rows.map((r) => `${'  '.repeat(r.depth)}${r.type === 'dir' ? r.label + '/' : r.name}`);

describe('buildRows', () => {
  it('puts a chain of single folders on ONE row, folders before files, sorted', () => {
    const files = [
      f('README.md'),
      f('svc/openspec/changes/pipeline/design.md'),
      f('svc/openspec/changes/pipeline/proposal.md'),
      f('svc/openspec/changes/pipeline/specs/a/spec.md'),
      f('svc/openspec/changes/pipeline/specs/b/spec.md'),
    ];
    expect(show(buildRows(files, new Set()))).toEqual([
      'svc/openspec/changes/pipeline/',
      '  specs/',
      '    a/',
      '      spec.md',
      '    b/',
      '      spec.md',
      '  design.md',
      '  proposal.md',
      'README.md',
    ]);
  });
  it('a folder with files AND a folder is not merged into its child; counts files below', () => {
    const rows = buildRows([f('a/x.md'), f('a/b/c/y.md')], new Set());
    expect(show(rows)).toEqual(['a/', '  b/c/', '    y.md', '  x.md']);
    expect(rows.filter((r) => r.type === 'dir').map((r) => r.type === 'dir' && r.count)).toEqual([2, 1]);
  });
  it('a closed folder hides everything inside; the key is the last folder of the chain', () => {
    const files = [f('a/b/c/x.md'), f('a/b/c/y.md'), f('z.md')];
    const rows = buildRows(files, new Set(['a/b/c']));
    expect(show(rows)).toEqual(['a/b/c/', 'z.md']);
    expect(rows[0]).toMatchObject({ type: 'dir', closed: true, count: 2 });
  });
  it('keeps the action of each file', () => {
    const rows = buildRows([f('a.md', 'updated'), f('b.md', 'deleted')], new Set());
    expect(rows.map((r) => r.type === 'file' && r.action)).toEqual(['updated', 'deleted']);
  });
  it('PROPERTY: every file appears exactly once when nothing is closed, and rows never skip a depth', () => {
    const seg = fc.constantFrom('a', 'b', 'c', 'dd', 'e.f');
    const path = fc.array(seg, { minLength: 1, maxLength: 5 }).map((p) => p.join('/') + '.md');
    fc.assert(fc.property(fc.uniqueArray(path, { maxLength: 25 }), (paths) => {
      // a path cannot be both a folder and a file: drop files that are folders of others
      const files = paths.filter((p) => !paths.some((q) => q.startsWith(p.replace(/\.md$/, '') + '/'))).map((p) => f(p));
      const rows = buildRows(files, new Set());
      expect(rows.filter((r) => r.type === 'file').map((r) => r.path).sort()).toEqual(files.map((x) => x.path).sort());
      let prev = -1;
      for (const r of rows) { expect(r.depth).toBeLessThanOrEqual(prev + 1); prev = r.depth; }
      expect(orderedPaths(files).sort()).toEqual(files.map((x) => x.path).sort());
    }));
  });
});

describe('orderedPaths', () => {
  it('follows the order of the tree, also through closed folders', () => {
    expect(orderedPaths([f('z.md'), f('a/b.md'), f('a/c/d.md'), f('a/a.md')])).toEqual(['a/c/d.md', 'a/a.md', 'a/b.md', 'z.md']);
  });
});

describe('summarize', () => {
  it('says how many files and of which kind', () => {
    expect(summarize([f('a.md')])).toBe('1 file');
    expect(summarize([f('a.md'), f('b.md')])).toBe('2 files: 2 new');
    expect(summarize([f('a.md', 'updated'), f('b.md', 'updated'), f('c.md'), f('d.md', 'deleted')])).toBe('4 files: 2 changed, 1 new, 1 deleted');
  });
});

describe('parentsOf', () => {
  it('lists every folder above a path', () => {
    expect(parentsOf('a/b/c/d.md')).toEqual(['a', 'a/b', 'a/b/c']);
    expect(parentsOf('d.md')).toEqual([]);
  });
});
