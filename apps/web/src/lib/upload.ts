import { ancestorsOf, baseOf, join, OK_EXT } from './paths';

export const MAX_FILE_BYTES = 1_000_000;
export const MAX_UPLOAD_FILES = 200;
const MAX_SCANNED = 2000;   // stop walking a dropped folder after this many files
const MAX_DEPTH = 20;

export type UploadItem = { path: string; file: File };
/** What a drop contained, copied out while the browser still lets us read it (it is gone after the event). */
export type DropSnapshot = { entries: (FileSystemEntry | null)[]; files: File[] };

export function snapshotDrop(dt: DataTransfer): DropSnapshot {
  return {
    entries: [...(dt.items ?? [])].map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null)),
    files: [...dt.files],
  };
}

const readAll = async (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> => {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (!batch.length) return all;
    all.push(...batch);
  }
};

async function walk(entry: FileSystemEntry, parent: string, depth: number, out: { items: UploadItem[]; folders: string[]; hidden: number }) {
  if (entry.name.startsWith('.')) { out.hidden++; return; }       // .git, .DS_Store ...
  if (out.items.length >= MAX_SCANNED || depth > MAX_DEPTH) return;
  const path = join(parent, entry.name);
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => (entry as FileSystemFileEntry).file(resolve, () => resolve(null)));
    if (file) out.items.push({ path, file });
    return;
  }
  out.folders.push(path);
  for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader())) await walk(child, path, depth + 1, out);
}

/** Turns a drop into relative paths below `target` (a folder path, '' for the top). Folders are walked, hidden entries skipped. */
export async function collectDrop(snap: DropSnapshot, target: string): Promise<{ items: UploadItem[]; folders: string[]; hidden: number }> {
  const out = { items: [] as UploadItem[], folders: [] as string[], hidden: 0 };
  if (snap.entries.some(Boolean)) {
    for (const entry of snap.entries) if (entry) await walk(entry, target, 0, out);
  } else {
    for (const file of snap.files) out.items.push({ path: join(target, file.name), file });
  }
  return out;
}

export type Skipped = { type: number; folderName: number; big: number; binary: number; limit: number };

/**
 * Reads the dropped files and keeps what the server will accept: .md/.yml/.yaml text files up to 1 MB, at most
 * 200 of them, none inside a folder named like a file. Everything else is counted so the page can say what was left out.
 */
export async function prepareUpload(items: UploadItem[], folders: string[]) {
  const skipped: Skipped = { type: 0, folderName: 0, big: 0, binary: 0, limit: 0 };
  const looksLikeFile = (folder: string) => OK_EXT.test(baseOf(folder));
  const inBadFolder = (filePath: string) => ancestorsOf(filePath).some(looksLikeFile);          // the folders ABOVE a file
  const isBadFolder = (folderPath: string) => [...ancestorsOf(folderPath), folderPath].some(looksLikeFile); // the folder itself and above
  const files: { path: string; content: string }[] = [];
  for (const it of items) {
    if (!OK_EXT.test(it.path)) { skipped.type++; continue; }
    if (inBadFolder(it.path)) { skipped.folderName++; continue; }
    if (files.length >= MAX_UPLOAD_FILES) { skipped.limit++; continue; }
    if (it.file.size > MAX_FILE_BYTES) { skipped.big++; continue; }
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await it.file.arrayBuffer());
      if (text.includes('\u0000')) throw new Error('binary');
      files.push({ path: it.path, content: text });
    } catch { skipped.binary++; }
  }
  return { files, folders: folders.filter((f) => !isBadFolder(f)), skipped };
}

/** "3 not .md/.yml/.yaml, 1 over 1 MB" or '' when nothing was skipped. */
export function describeSkipped(s: Skipped): string {
  const parts: string[] = [];
  if (s.type) parts.push(`${s.type} not .md/.yml/.yaml`);
  if (s.folderName) parts.push(`${s.folderName} inside a folder named like a file`);
  if (s.big) parts.push(`${s.big} over 1 MB`);
  if (s.binary) parts.push(`${s.binary} not text`);
  if (s.limit) parts.push(`${s.limit} over the ${MAX_UPLOAD_FILES} file limit`);
  return parts.join(', ');
}
