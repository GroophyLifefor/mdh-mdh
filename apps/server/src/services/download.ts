import { zipSync, type Zippable } from 'fflate';
import type { Ctx } from '../context';
import { notFound } from '../errors';
import { baseOf, dirRange, normalizePath } from '../paths';

export type Download = { filename: string; mime: string; data: Buffer };

/** A name that is safe in a download dialog on any system. Never empty. */
export function safeFileName(name: string, fallback = 'project'): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').replace(/\p{Cf}/gu, '').trim().replace(/^\.+/, '').slice(0, 100).trim();
  return cleaned || fallback;
}

/** `Content-Disposition` for a download: an ASCII fallback plus the real UTF-8 name (RFC 5987). */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

const mimeOf = (path: string) => (/\.md$/i.test(path) ? 'text/markdown; charset=utf-8' : 'text/yaml; charset=utf-8');

type Row = { path: string; kind: 'dir' | 'file'; content: string; updated_at: Date };

function zip(rows: Row[], prefix: (path: string) => string): Buffer {
  const files: Zippable = {};
  for (const r of rows) {
    const mtime = r.updated_at;
    files[r.kind === 'dir' ? prefix(r.path) + '/' : prefix(r.path)] = [r.kind === 'dir' ? new Uint8Array(0) : new TextEncoder().encode(r.content), { mtime, level: r.kind === 'dir' ? 0 : 6 }];
  }
  return Buffer.from(zipSync(files));
}

/**
 * What the download button gives: a single file as it is, a folder as a zip (with the folder's own name inside),
 * or, with no path, the whole project as a zip.
 */
export async function download(ctx: Ctx, project: { id: string; name: string }, rawPath?: string): Promise<Download> {
  if (rawPath === undefined) {
    const { rows } = await ctx.db.query<Row>('SELECT path, kind, content, updated_at FROM nodes WHERE project_id = $1 ORDER BY path', [project.id]);
    return { filename: `${safeFileName(project.name)}.zip`, mime: 'application/zip', data: zip(rows, (p) => p) };
  }
  const path = normalizePath(rawPath);
  const { rows: [node] } = await ctx.db.query<Row>('SELECT path, kind, content, updated_at FROM nodes WHERE project_id = $1 AND path = $2', [project.id, path]);
  if (!node) throw notFound(`"${path}" not found`);
  if (node.kind === 'file') return { filename: safeFileName(baseOf(path), 'file'), mime: mimeOf(path), data: Buffer.from(node.content, 'utf8') };

  const { from, to } = dirRange(path);
  const { rows } = await ctx.db.query<Row>(
    'SELECT path, kind, content, updated_at FROM nodes WHERE project_id = $1 AND (path = $2 OR (path >= $3 AND path < $4)) ORDER BY path',
    [project.id, path, from, to],
  );
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  return { filename: `${safeFileName(baseOf(path), 'folder')}.zip`, mime: 'application/zip', data: zip(rows, (p) => p.slice(parent.length)) };
}
