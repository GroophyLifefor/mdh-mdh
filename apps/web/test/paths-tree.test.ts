import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ancestorsOf, baseOf, isInside, join, nameError, parentOf } from '../src/lib/paths';
import { dirPaths, dropPaths, remapPath, remapPaths, visibleRows } from '../src/lib/tree';

describe('path helpers', () => {
  it('split and join', () => {
    expect([parentOf('a/b/c.md'), parentOf('c.md'), baseOf('a/b/c.md'), baseOf('c.md')]).toEqual(['a/b', '', 'c.md', 'c.md']);
    expect([join('', 'x.md'), join('a/b', 'x.md')]).toEqual(['x.md', 'a/b/x.md']);
    expect(ancestorsOf('a/b/c.md')).toEqual(['a', 'a/b']);
    expect(ancestorsOf('c.md')).toEqual([]);
    expect([isInside('a/b', 'a'), isInside('ab', 'a'), isInside('a', 'a')]).toEqual([true, false, false]);
  });
  it('join then split gives back the parts', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom('a', 'b', 'c'), { maxLength: 3 }).map((x) => x.join('/')), fc.constantFrom('x.md', 'y.yml'), (parent, name) => {
      const p = join(parent, name);
      return parentOf(p) === parent && baseOf(p) === name;
    }));
  });
});

describe('nameError', () => {
  it.each([
    ['empty', '', true, 'Enter a name.'],
    ['a slash', 'a/b.md', true, 'No slashes in names.'],
    ['a backslash', 'a\\b.md', true, 'No slashes in names.'],
    ['leading space', ' a.md', true, 'Names cannot start or end with a space.'],
    ['dot', '.', false, 'That name is not allowed.'],
    ['dotdot', '..', false, 'That name is not allowed.'],
    ['too long', 'a'.repeat(256), false, 'That name is too long.'],
    ['file without extension', 'notes', true, 'Files must end in .md, .yml or .yaml'],
    ['txt file', 'notes.txt', true, 'Files must end in .md, .yml or .yaml'],
    ['folder like a file', 'notes.md', false, "Folder names can't end in .md, .yml or .yaml"],
    ['folder like a yaml', 'x.YAML', false, "Folder names can't end in .md, .yml or .yaml"],
  ])('%s', (_n, name, isFile, message) => {
    expect(nameError(name, isFile)).toBe(message);
  });
  it.each([['a.md', true], ['A.YML', true], ['x.yaml', true], ['notes', false], ['v1.0', false], ['Türkçe klasör', false], ['a'.repeat(255), false]])('accepts %s', (name, isFile) => {
    expect(nameError(name, isFile)).toBe('');
  });
});

const nodes = [
  { path: 'z.md', kind: 'file' as const }, { path: 'b', kind: 'dir' as const }, { path: 'b/y.md', kind: 'file' as const },
  { path: 'b/sub', kind: 'dir' as const }, { path: 'b/sub/deep.md', kind: 'file' as const }, { path: 'a', kind: 'dir' as const }, { path: 'A.md', kind: 'file' as const },
];

describe('visibleRows', () => {
  it('lists folders before files at every level, in byte order, with depth', () => {
    expect(visibleRows(nodes, new Set()).map((r) => `${r.depth}:${r.path}`)).toEqual([
      '0:a', '0:b', '1:b/sub', '2:b/sub/deep.md', '1:b/y.md', '0:A.md', '0:z.md',
    ]);
  });
  it('hides everything inside a collapsed folder but keeps the folder itself', () => {
    expect(visibleRows(nodes, new Set(['b'])).map((r) => r.path)).toEqual(['a', 'b', 'A.md', 'z.md']);
    expect(visibleRows(nodes, new Set(['b/sub'])).map((r) => r.path)).toEqual(['a', 'b', 'b/sub', 'b/y.md', 'A.md', 'z.md']);
  });
  it('gives the base name and handles an empty tree', () => {
    expect(visibleRows(nodes, new Set()).find((r) => r.path === 'b/sub/deep.md')!.name).toBe('deep.md');
    expect(visibleRows([], new Set())).toEqual([]);
  });
  it('does not change its input', () => {
    const copy = JSON.stringify(nodes);
    visibleRows(nodes, new Set());
    expect(JSON.stringify(nodes)).toBe(copy);
  });
  it('property: every row is shown exactly once unless an ancestor is collapsed', () => {
    const tree = fc.array(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 3 });
    fc.assert(fc.property(fc.array(tree, { maxLength: 8 }), fc.array(fc.constantFrom('a', 'a/b', 'b', 'c'), { maxLength: 3 }), (paths, closedList) => {
      const set = new Map<string, 'dir' | 'file'>();
      for (const parts of paths) {
        for (let i = 1; i < parts.length; i++) set.set(parts.slice(0, i).join('/'), 'dir');
        set.set(parts.join('/') + (parts.length ? '.md' : ''), 'file');
      }
      const list = [...set].map(([path, kind]) => ({ path, kind }));
      const closed = new Set(closedList);
      const rows = visibleRows(list, closed);
      expect(new Set(rows.map((r) => r.path)).size).toBe(rows.length);
      for (const n of list) {
        const hidden = [...closed].some((c) => n.path.startsWith(c + '/'));
        expect(rows.some((r) => r.path === n.path), n.path).toBe(!hidden);
      }
    }), { numRuns: 200 });
  });
});

describe('remap and drop', () => {
  it('remapPaths moves a folder and everything below it, and nothing similar', () => {
    expect([...remapPaths(['a', 'a/b', 'a/b/c.md', 'ab', 'b/a'], 'a', 'z')].sort()).toEqual(['ab', 'b/a', 'z', 'z/b', 'z/b/c.md']);
    expect(remapPath('a/b.md', 'a', 'x/y')).toBe('x/y/b.md');
    expect(remapPath('ab/b.md', 'a', 'x')).toBe('ab/b.md');
  });
  it('dropPaths removes a folder and everything below it, and nothing similar', () => {
    expect([...dropPaths(['a', 'a/b', 'ab', 'b'], 'a')].sort()).toEqual(['ab', 'b']);
  });
  it('dirPaths only takes folders', () => {
    expect([...dirPaths(nodes)].sort()).toEqual(['a', 'b', 'b/sub']);
  });
});
