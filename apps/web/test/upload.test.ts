import { describe, expect, it } from 'vitest';
import { File as NodeFile } from 'node:buffer'; // jsdom's File has no arrayBuffer(); real browsers and Node do
import { collectDrop, describeSkipped, prepareUpload, snapshotDrop, type DropSnapshot, type UploadItem } from '../src/lib/upload';

// ---- fake file system entries, shaped like the browser's ----
const file = (name: string, content = 'x'): FileSystemEntry =>
  ({ name, isFile: true, isDirectory: false, file: (ok: (f: File) => void) => ok(new File([content], name)) }) as unknown as FileSystemEntry;
const brokenFile = (name: string): FileSystemEntry =>
  ({ name, isFile: true, isDirectory: false, file: (_ok: unknown, fail: () => void) => fail() }) as unknown as FileSystemEntry;
/** readEntries returns `batch` entries at a time, like Chrome does (100 at a time in real life). */
const dir = (name: string, children: FileSystemEntry[], batch = 2): FileSystemEntry =>
  ({
    name, isFile: false, isDirectory: true,
    createReader: () => { let i = 0; return { readEntries: (ok: (e: FileSystemEntry[]) => void) => { ok(children.slice(i, i + batch)); i += batch; } }; },
  }) as unknown as FileSystemEntry;

const snap = (...entries: FileSystemEntry[]): DropSnapshot => ({ entries, files: [] });
const paths = (items: UploadItem[]) => items.map((i) => i.path).sort();

describe('collectDrop', () => {
  it('walks a dropped folder, keeps its name, and lists the folders', async () => {
    const tree = dir('proj', [file('a.md'), dir('sub', [file('b.yml'), dir('deep', [file('c.md')])]), file('d.md')]);
    const out = await collectDrop(snap(tree), '');
    expect(paths(out.items)).toEqual(['proj/a.md', 'proj/d.md', 'proj/sub/b.yml', 'proj/sub/deep/c.md']);
    expect(out.folders.sort()).toEqual(['proj', 'proj/sub', 'proj/sub/deep']);
  });
  it('puts everything below the folder it was dropped on', async () => {
    const out = await collectDrop(snap(file('a.md'), dir('d', [file('b.md')])), 'notes/2026');
    expect(paths(out.items)).toEqual(['notes/2026/a.md', 'notes/2026/d/b.md']);
    expect(out.folders).toEqual(['notes/2026/d']);
  });
  it('reads folders that need several readEntries rounds', async () => {
    const many = Array.from({ length: 7 }, (_, i) => file(`f${i}.md`));
    const out = await collectDrop(snap(dir('big', many, 3)), '');
    expect(out.items).toHaveLength(7);
  });
  it('skips hidden files and folders (.git, .DS_Store) and counts them', async () => {
    const out = await collectDrop(snap(dir('p', [file('.DS_Store'), dir('.git', [file('config')]), file('keep.md')])), '');
    expect(paths(out.items)).toEqual(['p/keep.md']);
    expect(out.folders).toEqual(['p']);
    expect(out.hidden).toBe(2);
  });
  it('skips a file the browser cannot read instead of failing the whole drop', async () => {
    const out = await collectDrop(snap(dir('p', [brokenFile('bad.md'), file('ok.md')])), '');
    expect(paths(out.items)).toEqual(['p/ok.md']);
  });
  it('handles an empty folder', async () => {
    const out = await collectDrop(snap(dir('empty', [])), '');
    expect(out).toMatchObject({ items: [], folders: ['empty'] });
  });
  it('falls back to plain files when the browser has no entry API', async () => {
    const out = await collectDrop({ entries: [null, null], files: [new File(['a'], 'a.md'), new File(['b'], 'b.yml')] }, 'x');
    expect(paths(out.items)).toEqual(['x/a.md', 'x/b.yml']);
    expect(out.folders).toEqual([]);
  });
  it('stops walking a folder tree that is absurdly deep', async () => {
    let node: FileSystemEntry = file('deepest.md');
    for (let i = 0; i < 40; i++) node = dir(`d${i}`, [node]);
    const out = await collectDrop(snap(node), '');
    expect(out.items).toEqual([]);
  });
  it('stops after 2000 files', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => file(`f${i}.md`));
    const out = await collectDrop(snap(dir('big', many, 500)), '');
    expect(out.items.length).toBeLessThan(2600);
    expect(out.items.length).toBeGreaterThanOrEqual(2000);
  });
});

describe('snapshotDrop', () => {
  it('copies entries and files out of the DataTransfer', () => {
    const f = new File(['x'], 'a.md');
    const dt = { items: [{ webkitGetAsEntry: () => file('a.md') }, { webkitGetAsEntry: undefined }], files: [f] } as unknown as DataTransfer;
    const s = snapshotDrop(dt);
    expect(s.entries[0]!.name).toBe('a.md');
    expect(s.entries[1]).toBeNull();
    expect(s.files).toEqual([f]);
  });
  it('works with a DataTransfer that has no items', () => {
    expect(snapshotDrop({ files: [] } as unknown as DataTransfer)).toEqual({ entries: [], files: [] });
  });
});

const item = (path: string, content: string | Uint8Array = 'text', size?: number): UploadItem => {
  const f = new NodeFile([content as never], path.split('/').pop()!) as unknown as File;
  if (size !== undefined) Object.defineProperty(f, 'size', { value: size });
  return { path, file: f };
};

describe('prepareUpload', () => {
  it('keeps .md, .yml and .yaml text files (any case) and reads their content', async () => {
    const r = await prepareUpload([item('a.md', 'A'), item('b/c.YML', 'C'), item('d.yaml', 'D')], []);
    expect(r.files).toEqual([{ path: 'a.md', content: 'A' }, { path: 'b/c.YML', content: 'C' }, { path: 'd.yaml', content: 'D' }]);
    expect(describeSkipped(r.skipped)).toBe('');
  });
  it('counts each reason for leaving a file out', async () => {
    const r = await prepareUpload([
      item('a.txt'), item('b.png'), item('big.md', 'x', 1_000_001), item('bin.md', new Uint8Array([104, 0, 105])),
      item('latin1.md', new Uint8Array([0xff, 0xfe, 0xfd])), item('v1.md/inner.md'), item('fine.md'),
    ], []);
    expect(r.files.map((f) => f.path)).toEqual(['fine.md']);
    expect(r.skipped).toEqual({ type: 2, folderName: 1, big: 1, binary: 2, limit: 0 });
  });
  it('allows exactly 1 MB and 200 files', async () => {
    expect((await prepareUpload([item('ok.md', 'x', 1_000_000)], [])).files).toHaveLength(1);
    const many = Array.from({ length: 205 }, (_, i) => item(`f${i}.md`));
    const r = await prepareUpload(many, []);
    expect(r.files).toHaveLength(200);
    expect(r.skipped.limit).toBe(5);
  });
  it('drops folders named like files, and keeps the others', async () => {
    const r = await prepareUpload([], ['docs', 'v1.md', 'a/b.yml/c', 'a/b']);
    expect(r.folders).toEqual(['docs', 'a/b']);
  });
  it('accepts valid UTF-8 (Turkish, emoji, BOM) and refuses broken bytes', async () => {
    const r = await prepareUpload([item('tr.md', 'türkçe ğüşiöç 🙂'), item('bom.md', '﻿# x')], []);
    expect(r.files.map((f) => f.content)).toEqual(['türkçe ğüşiöç 🙂', '﻿# x']);
  });
});

describe('describeSkipped', () => {
  it('names every reason with its number', () => {
    expect(describeSkipped({ type: 3, folderName: 1, big: 2, binary: 1, limit: 4 })).toBe(
      '3 not .md/.yml/.yaml, 1 inside a folder named like a file, 2 over 1 MB, 1 not text, 4 over the 200 file limit',
    );
    expect(describeSkipped({ type: 0, folderName: 0, big: 0, binary: 0, limit: 0 })).toBe('');
  });
});
