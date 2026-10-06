import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ancestorsOf, assertContent, baseOf, dirRange, isAllowedFile, isInside, normalizeDirPath, normalizeFilePath, normalizePath, parentOf } from '../src/paths';
import { AppError } from '../src/errors';

const bad = (fn: () => unknown) => { try { fn(); } catch (e) { return e as AppError; } throw new Error('expected a failure'); };

describe('normalizePath', () => {
  it.each(['a.md', 'a/b.md', 'notes/deep/er/file.yml', 'Türkçe/ğüş.md', 'a b/c d.md', 'a-b_c.d/e.md', '日本語/ファイル.md'])('accepts %s', (p) => {
    expect(normalizePath(p)).toBe(p.normalize('NFC'));
  });

  it.each([
    ['empty', ''], ['leading slash', '/a.md'], ['trailing slash', 'a/'], ['double slash', 'a//b.md'], ['dot', './a.md'], ['dotdot', '../a.md'],
    ['dotdot inside', 'a/../b.md'], ['dotdot at end', 'a/..'], ['backslash', 'a\\b.md'], ['NUL', 'a\u0000.md'], ['newline', 'a\n.md'], ['tab', 'a\t.md'],
    ['DEL', 'a\u007f.md'], ['zero-width space', 'a​.md'], ['right-to-left override', 'a‮.md'], ['leading space in a name', ' a.md'],
    ['trailing space in a name', 'a /b.md'], ['space-only name', 'a/ /b.md'], ['broken surrogate', 'a\ud800.md'],
  ])('refuses %s', (_n, p) => {
    expect(bad(() => normalizePath(p)).code).toBe('invalid_path');
  });

  it.each([[5], [null], [undefined], [{}], [['a']]])('refuses a non-string (%j)', (v) => {
    expect(bad(() => normalizePath(v)).code).toBe('invalid_path');
  });

  it('a single name may be at most 255 characters', () => {
    expect(() => normalizePath('a'.repeat(255))).not.toThrow();
    expect(bad(() => normalizePath('a'.repeat(256))).code).toBe('invalid_path');
  });
  it('allows 20 levels, refuses 21', () => {
    expect(() => normalizePath(Array(20).fill('d').join('/'))).not.toThrow();
    expect(bad(() => normalizePath(Array(21).fill('d').join('/'))).code).toBe('invalid_path');
  });
  it('allows 1024 characters in total, refuses 1025', () => {
    const seg = 'x'.repeat(100);
    const ok = Array(10).fill(seg).join('/') + '/' + 'y'.repeat(1024 - 10 * 101); // total length 1024
    expect(ok).toHaveLength(1024);
    expect(() => normalizePath(ok)).not.toThrow();
    expect(bad(() => normalizePath(ok + 'z')).code).toBe('invalid_path');
  });

  it('stores Unicode in its composed form (NFC), so é typed two ways is one name', () => {
    expect(normalizePath('é.md')).toBe('é.md');
  });

  it('property: normalising twice changes nothing, and results never contain dot segments or control characters', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 60 }), (s) => {
      let out: string;
      try { out = normalizePath(s); } catch { return true; }
      expect(normalizePath(out)).toBe(out);
      expect(out.split('/').some((p) => p === '' || p === '.' || p === '..')).toBe(false);
      expect(/[\u0000-\u001f\u007f\\]/.test(out)).toBe(false);
      return true;
    }), { numRuns: 1000 });
  });
});

describe('file and folder names', () => {
  it('files must end in .md, .yml or .yaml in any case', () => {
    for (const ok of ['a.md', 'a.MD', 'a.Yml', 'a.YAML', 'x/y.yaml']) expect(normalizeFilePath(ok)).toBe(ok);
    for (const no of ['a.txt', 'a', 'a.md.exe', 'a.mdx', 'a.yml.bak', 'md', 'a.markdown']) expect(bad(() => normalizeFilePath(no)).message, no).toMatch(/\.md, \.yml or \.yaml/);
    expect(isAllowedFile('.md')).toBe(true); // just an extension is still a valid (odd) name
  });
  it('folders must NOT look like files', () => {
    expect(normalizeDirPath('notes')).toBe('notes');
    expect(normalizeDirPath('v1.0')).toBe('v1.0');
    for (const no of ['notes.md', 'a/b.yml', 'x.YAML']) expect(bad(() => normalizeDirPath(no)).message, no).toMatch(/Folder names/);
  });
});

describe('folder names inside a path', () => {
  it('a file path may not go through a folder that looks like a file', () => {
    for (const p of ['v1.md/a.md', 'a/v2.yml/b.md', 'x.YAML/y/z.md']) {
      expect(bad(() => normalizeFilePath(p)).message, p).toMatch(/Folder names cannot end in/);
    }
    expect(normalizeFilePath('v1/a.md')).toBe('v1/a.md');
    expect(normalizeFilePath('notes.d/a.md')).toBe('notes.d/a.md');
  });
  it('a folder path may not contain such a folder at any level, and the message names the culprit', () => {
    expect(bad(() => normalizeDirPath('x/v4.md/deep')).message).toContain('"v4.md"');
    expect(bad(() => normalizeDirPath('a.md')).code).toBe('invalid_path');
    expect(normalizeDirPath('x/y/z')).toBe('x/y/z');
  });
});

describe('assertContent', () => {
  it('accepts text, empty text, unicode and line endings as they are', () => {
    for (const c of ['', 'hello', 'türkçe 🙂\r\nline two\r\n', '﻿bom', ' '.repeat(10)]) expect(assertContent(c)).toBe(c);
  });
  it('refuses NUL, broken surrogates and non-strings', () => {
    expect(bad(() => assertContent('a\u0000b')).code).toBe('invalid_content');
    expect(bad(() => assertContent('a\ud800b')).code).toBe('invalid_content');
    for (const v of [5, null, undefined, {}]) expect(bad(() => assertContent(v)).code).toBe('invalid_content');
  });
  it('allows exactly 1 000 000 bytes (not characters), refuses one more', () => {
    expect(() => assertContent('a'.repeat(1_000_000))).not.toThrow();
    expect(bad(() => assertContent('a'.repeat(1_000_001))).code).toBe('too_large');
    expect(() => assertContent('ü'.repeat(500_000))).not.toThrow(); // 2 bytes each = 1 000 000
    expect(bad(() => assertContent('ü'.repeat(500_001))).code).toBe('too_large');
  });
});

describe('path helpers', () => {
  it('parentOf, baseOf, ancestorsOf, isInside', () => {
    expect(parentOf('a/b/c.md')).toBe('a/b');
    expect(parentOf('c.md')).toBe('');
    expect(baseOf('a/b/c.md')).toBe('c.md');
    expect(baseOf('c.md')).toBe('c.md');
    expect(ancestorsOf('a/b/c.md')).toEqual(['a', 'a/b']);
    expect(ancestorsOf('c.md')).toEqual([]);
    expect(isInside('a/b', 'a')).toBe(true);
    expect(isInside('ab/c', 'a')).toBe(false); // a prefix is not a parent
    expect(isInside('a', 'a')).toBe(false);
  });
  it('dirRange covers exactly the paths inside a folder in byte order', () => {
    const { from, to } = dirRange('a');
    const inRange = (p: string) => p >= from && p < to;
    for (const p of ['a/x.md', 'a/b/c.md', 'a/', 'a/￿']) expect(inRange(p), p).toBe(true);
    for (const p of ['a', 'a.md', 'ab/x.md', 'a0', 'b/x.md', 'A/x.md']) expect(inRange(p), p).toBe(false);
  });
});
