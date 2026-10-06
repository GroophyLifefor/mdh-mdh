import { badRequest } from './errors';

export const MAX_PATH_LENGTH = 1024;
export const MAX_SEGMENT_LENGTH = 255;
export const MAX_DEPTH = 20;
export const MAX_FILE_BYTES = 1_000_000;

export const isAllowedFile = (path: string) => /\.(md|yml|yaml)$/i.test(path);
export const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const isInside = (path: string, dir: string) => path.startsWith(dir + '/');

/** 'a/b/c.md' -> ['a', 'a/b'] */
export function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  for (let d = parentOf(path); d; d = parentOf(d)) out.unshift(d);
  return out;
}

/** The smallest string above every path inside `dir` ('/' + 1 = '0'), for a byte-order range query. */
export const dirRange = (dir: string) => ({ from: dir + '/', to: dir + '0' });

/**
 * Returns the path in its stored form (Unicode NFC) or throws a 400 that says what is wrong.
 * Rejects: empty, leading/trailing slash, empty or "."/".." parts, backslashes, control or invisible formatting
 * characters, broken Unicode, parts with leading/trailing spaces, and anything too long or too deep.
 */
export function normalizePath(raw: unknown): string {
  const fail = (msg: string) => badRequest('invalid_path', msg);
  if (typeof raw !== 'string') throw fail('Path must be text');
  if (!raw.isWellFormed()) throw fail('Path contains broken Unicode');
  const path = raw.normalize('NFC');
  if (!path) throw fail('Path is empty');
  if (path.length > MAX_PATH_LENGTH) throw fail(`Path is too long (max ${MAX_PATH_LENGTH})`);
  if (path.startsWith('/') || path.endsWith('/')) throw fail('Path cannot start or end with a slash');
  if (path.includes('\\')) throw fail('Use / between folders, not \\');
  if (/[\u0000-\u001f\u007f]/.test(path)) throw fail('Path contains control characters');
  if (/\p{Cf}/u.test(path)) throw fail('Path contains invisible formatting characters');
  const parts = path.split('/');
  if (parts.length > MAX_DEPTH) throw fail(`Too many nested folders (max ${MAX_DEPTH})`);
  for (const part of parts) {
    if (!part) throw fail('Path has an empty folder name');
    if (part === '.' || part === '..') throw fail('"." and ".." are not allowed in paths');
    if (part.length > MAX_SEGMENT_LENGTH) throw fail(`A name is too long (max ${MAX_SEGMENT_LENGTH})`);
    if (part !== part.trim()) throw fail('Names cannot start or end with a space');
  }
  return path;
}

/** Every folder in the path (and the path itself, for a folder) must not look like a file name. */
function assertFolderNames(folders: string[]) {
  for (const folder of folders) {
    if (isAllowedFile(baseOf(folder))) throw badRequest('invalid_path', `Folder names cannot end in .md, .yml or .yaml ("${baseOf(folder)}")`);
  }
}

export function normalizeDirPath(raw: unknown): string {
  const path = normalizePath(raw);
  assertFolderNames([...ancestorsOf(path), path]);
  return path;
}

export function normalizeFilePath(raw: unknown): string {
  const path = normalizePath(raw);
  if (!isAllowedFile(path)) throw badRequest('invalid_path', 'Files must end in .md, .yml or .yaml');
  assertFolderNames(ancestorsOf(path));
  return path;
}

/** File content: well-formed text, no NUL (PostgreSQL cannot store it), at most 1 MB. */
export function assertContent(content: unknown): string {
  if (typeof content !== 'string') throw badRequest('invalid_content', 'Content must be text');
  if (!content.isWellFormed()) throw badRequest('invalid_content', 'Content contains broken Unicode');
  if (content.includes('\u0000')) throw badRequest('invalid_content', 'Content contains a NUL character (binary file?)');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw badRequest('too_large', 'File is larger than 1 MB');
  return content;
}
