import type { Ctx } from '../context';
import { withTx, type Tx } from '../db';
import { AppError, badRequest, conflict, notFound } from '../errors';
import {
  ancestorsOf, assertContent, dirRange, isInside, normalizeDirPath, normalizeFilePath, normalizePath,
} from '../paths';
import { diff, rewind, type State } from '../rewind';
import { recordChange, type Actor, type ChangeKind, type FileDelta } from './history';

// ---------- limits ----------
export const MERGE_WINDOW_MS = 10 * 60_000; // keep editing the same history entry for this long
export const MAX_NODES = 2000;
export const MAX_PROJECT_BYTES = 50_000_000;
export const MAX_UPLOAD_FILES = 200;

type Node = { kind: 'dir' | 'file'; content: string; version: number };

// ---------- helpers (all run inside a transaction) ----------

/** Serialises writers of one project. Everything that changes files starts here. */
async function lockProject(tx: Tx, projectId: string): Promise<void> {
  const r = await tx.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
  if (!r.rowCount) throw notFound('Project not found');
}

async function nodeAt(tx: Tx, projectId: string, path: string): Promise<Node | undefined> {
  const { rows } = await tx.query<Node>('SELECT kind, content, version FROM nodes WHERE project_id = $1 AND path = $2', [projectId, path]);
  return rows[0];
}

/** The node and everything inside it, in path order. */
async function subtree(tx: Tx, projectId: string, path: string): Promise<{ path: string; kind: 'dir' | 'file'; content: string }[]> {
  const { from, to } = dirRange(path);
  const { rows } = await tx.query(
    'SELECT path, kind, content FROM nodes WHERE project_id = $1 AND (path = $2 OR (path >= $3 AND path < $4)) ORDER BY path',
    [projectId, path, from, to],
  );
  return rows;
}

async function assertRoom(tx: Tx, projectId: string, addNodes: number, addBytes: number) {
  const { rows: [u] } = await tx.query<{ n: string; bytes: string }>(
    'SELECT count(*) AS n, COALESCE(sum(octet_length(content)), 0) AS bytes FROM nodes WHERE project_id = $1',
    [projectId],
  );
  if (Number(u!.n) + addNodes > MAX_NODES) throw new AppError(413, 'project_full', `A project can hold at most ${MAX_NODES} files and folders`);
  if (Number(u!.bytes) + addBytes > MAX_PROJECT_BYTES) throw new AppError(413, 'project_full', 'A project can hold at most 50 MB of text');
}

/** Makes sure every folder above `path` exists (creating the missing ones). Adds them to `deltas`. */
async function ensureParents(tx: Tx, ctx: Ctx, projectId: string, path: string, deltas: FileDelta[]): Promise<number> {
  const wanted = ancestorsOf(path);
  if (!wanted.length) return 0;
  const { rows } = await tx.query<{ path: string; kind: string }>('SELECT path, kind FROM nodes WHERE project_id = $1 AND path = ANY($2)', [projectId, wanted]);
  const have = new Map(rows.map((r) => [r.path, r.kind]));
  let created = 0;
  for (const dir of wanted) {
    const kind = have.get(dir);
    if (kind === 'file') throw conflict('parent_is_file', `"${dir}" is a file, not a folder`);
    if (kind === 'dir') continue;
    await tx.query("INSERT INTO nodes (project_id, path, kind, content, updated_at) VALUES ($1, $2, 'dir', '', $3)", [projectId, dir, ctx.now()]);
    deltas.push({ path: dir, kind: 'dir', action: 'created', before: null, after: '' });
    created++;
  }
  return created;
}

const sameActor = (row: { actor_type: string; actor_user_id: string | null; actor_name: string }, a: Actor) =>
  a.type === 'user' ? row.actor_type === 'user' && row.actor_user_id === a.userId : row.actor_type === 'password' && row.actor_name === a.name;

// ---------- reading ----------

export async function getTree(ctx: Ctx, projectId: string) {
  const { rows } = await ctx.db.query<{ path: string; kind: string; version: number; size: number }>(
    'SELECT path, kind, version, octet_length(content) AS size FROM nodes WHERE project_id = $1 ORDER BY path',
    [projectId],
  );
  return rows;
}

export async function readFile(ctx: Ctx, projectId: string, rawPath: unknown) {
  const path = normalizePath(rawPath);
  const { rows } = await ctx.db.query<{ content: string; version: number; updated_at: Date }>(
    "SELECT content, version, updated_at FROM nodes WHERE project_id = $1 AND path = $2 AND kind = 'file'",
    [projectId, path],
  );
  if (!rows[0]) throw notFound('File not found');
  return { path, content: rows[0].content, version: rows[0].version, updatedAt: rows[0].updated_at.toISOString() };
}

// ---------- saving (autosave) ----------

/**
 * Saves new content for an existing file. `baseVersion` is the version the caller started from; if somebody saved
 * in between, nothing is written and the caller gets a 409 with the current version.
 * Repeated saves by the same person on the same file within 10 minutes update one history entry instead of
 * adding a new one each time (autosave would otherwise fill the history).
 */
export async function saveFile(ctx: Ctx, projectId: string, actor: Actor, input: { path: unknown; content: unknown; baseVersion: number }) {
  const path = normalizeFilePath(input.path);
  const content = assertContent(input.content);
  return withTx(ctx.db, async (tx) => {
    await lockProject(tx, projectId);
    const node = await nodeAt(tx, projectId, path);
    if (!node || node.kind !== 'file') throw notFound('File not found');
    if (node.version !== input.baseVersion) throw conflict('version_conflict', 'Someone else changed this file. Reload it to see their version.');
    if (node.content === content) return { unchanged: true as const, version: node.version };

    const delta = Buffer.byteLength(content) - Buffer.byteLength(node.content);
    if (delta > 0) await assertRoom(tx, projectId, 0, delta);

    const now = ctx.now();
    const { rows: [saved] } = await tx.query<{ version: number }>(
      'UPDATE nodes SET content = $3, version = version + 1, updated_at = $4 WHERE project_id = $1 AND path = $2 RETURNING version',
      [projectId, path, content, now],
    );

    const { rows: [last] } = await tx.query<{
      id: string; seq: number; kind: string; actor_type: string; actor_user_id: string | null; actor_name: string; updated_at: Date; nfiles: string; path: string | null;
    }>(
      `SELECT c.id, c.seq, c.kind, c.actor_type, c.actor_user_id, c.actor_name, c.updated_at,
              (SELECT count(*) FROM change_files WHERE change_id = c.id) AS nfiles,
              (SELECT path FROM change_files WHERE change_id = c.id LIMIT 1) AS path
       FROM changes c WHERE c.project_id = $1 ORDER BY c.seq DESC LIMIT 1`,
      [projectId],
    );
    const merge = last && last.kind === 'edit' && Number(last.nfiles) === 1 && last.path === path && sameActor(last, actor)
      && now.getTime() - last.updated_at.getTime() < MERGE_WINDOW_MS;
    if (merge) {
      await tx.query('UPDATE change_files SET after = $2 WHERE change_id = $1 AND path = $3', [last.id, content, path]);
      await tx.query('UPDATE changes SET updated_at = $2 WHERE id = $1', [last.id, now]);
      await tx.query('UPDATE projects SET updated_at = $2 WHERE id = $1', [projectId, now]);
      return { unchanged: false as const, version: saved!.version, seq: last.seq, merged: true };
    }
    const { seq } = await recordChange(ctx, tx, projectId, actor, {
      kind: 'edit', summary: `edited ${path}`,
      files: [{ path, kind: 'file', action: 'updated', before: node.content, after: content }],
    });
    return { unchanged: false as const, version: saved!.version, seq, merged: false };
  });
}

// ---------- create ----------

export async function createNode(ctx: Ctx, projectId: string, actor: Actor, input: { path: unknown; kind: 'file' | 'dir'; content?: unknown }) {
  const isFile = input.kind === 'file';
  const path = isFile ? normalizeFilePath(input.path) : normalizeDirPath(input.path);
  const content = isFile ? assertContent(input.content ?? '') : '';
  return withTx(ctx.db, async (tx) => {
    await lockProject(tx, projectId);
    if (await nodeAt(tx, projectId, path)) throw conflict('already_exists', `"${path}" already exists`);
    const deltas: FileDelta[] = [];
    const parents = await ensureParents(tx, ctx, projectId, path, deltas);
    await assertRoom(tx, projectId, parents + 1, Buffer.byteLength(content));
    await tx.query('INSERT INTO nodes (project_id, path, kind, content, updated_at) VALUES ($1, $2, $3, $4, $5)', [projectId, path, input.kind, content, ctx.now()]);
    deltas.push({ path, kind: input.kind, action: 'created', before: null, after: content });
    return recordChange(ctx, tx, projectId, actor, { kind: 'create', summary: isFile ? `created ${path}` : `created folder ${path}`, files: deltas });
  });
}

// ---------- move / rename ----------

export async function moveNode(ctx: Ctx, projectId: string, actor: Actor, input: { from: unknown; to: unknown }) {
  const from = normalizePath(input.from);
  const toRaw = normalizePath(input.to);
  return withTx(ctx.db, async (tx) => {
    await lockProject(tx, projectId);
    const src = await nodeAt(tx, projectId, from);
    if (!src) throw notFound(`"${from}" not found`);
    const to = src.kind === 'file' ? normalizeFilePath(toRaw) : normalizeDirPath(toRaw);
    if (to === from) throw badRequest('same_path', 'The new path is the same as the old one');
    if (src.kind === 'dir' && isInside(to, from)) throw badRequest('move_into_itself', 'A folder cannot be moved into itself');
    if (await nodeAt(tx, projectId, to)) throw conflict('already_exists', `"${to}" already exists`);

    const moving = await subtree(tx, projectId, from);
    const deltas: FileDelta[] = [];
    const parents = await ensureParents(tx, ctx, projectId, to, deltas);
    await assertRoom(tx, projectId, parents, 0);
    const { from: lo, to: hi } = dirRange(from);
    await tx.query(
      `UPDATE nodes SET path = $5 || substr(path, $6), updated_at = $7
       WHERE project_id = $1 AND (path = $2 OR (path >= $3 AND path < $4))`,
      [projectId, from, lo, hi, to, from.length + 1, ctx.now()],
    );
    for (const n of moving) {
      const np = to + n.path.slice(from.length);
      deltas.push({ path: n.path, kind: n.kind, action: 'deleted', before: n.content, after: null });
      deltas.push({ path: np, kind: n.kind, action: 'created', before: null, after: n.content });
    }
    return recordChange(ctx, tx, projectId, actor, { kind: 'rename', summary: `renamed ${from} → ${to}`, files: deltas });
  });
}

// ---------- delete ----------

export async function deleteNode(ctx: Ctx, projectId: string, actor: Actor, rawPath: unknown) {
  const path = normalizePath(rawPath);
  return withTx(ctx.db, async (tx) => {
    await lockProject(tx, projectId);
    const gone = await subtree(tx, projectId, path);
    if (!gone.length) throw notFound(`"${path}" not found`);
    const { from, to } = dirRange(path);
    await tx.query('DELETE FROM nodes WHERE project_id = $1 AND (path = $2 OR (path >= $3 AND path < $4))', [projectId, path, from, to]);
    const deltas: FileDelta[] = gone.map((n) => ({ path: n.path, kind: n.kind, action: 'deleted', before: n.content, after: null }));
    return recordChange(ctx, tx, projectId, actor, { kind: 'delete', summary: `deleted ${path}`, files: deltas });
  });
}

// ---------- upload (many files and folders at once) ----------

export type UploadInput = { files: { path: unknown; content: unknown }[]; folders?: unknown[]; overwrite?: boolean };

/**
 * All or nothing. Identical files are skipped, different ones are replaced only with `overwrite: true`
 * (otherwise the whole upload is refused and the conflicting paths are listed). One history entry for the lot.
 */
export async function upload(ctx: Ctx, projectId: string, actor: Actor, input: UploadInput) {
  if (input.files.length > MAX_UPLOAD_FILES) throw badRequest('too_many_files', `At most ${MAX_UPLOAD_FILES} files per upload`);
  const files = new Map<string, string>();
  for (const f of input.files) {
    const path = normalizeFilePath(f.path);
    if (files.has(path)) throw badRequest('duplicate_path', `"${path}" appears twice in this upload`);
    files.set(path, assertContent(f.content));
  }
  const folders = new Set<string>();
  for (const d of input.folders ?? []) folders.add(normalizeDirPath(d));
  if (!files.size && !folders.size) throw badRequest('nothing_to_upload', 'Nothing to upload');

  return withTx(ctx.db, async (tx) => {
    await lockProject(tx, projectId);
    const wantedPaths = [...files.keys(), ...folders];
    const wantedAncestors = new Set(wantedPaths.flatMap(ancestorsOf));
    const { rows: existing } = await tx.query<{ path: string; kind: string; content: string }>(
      'SELECT path, kind, content FROM nodes WHERE project_id = $1 AND path = ANY($2)',
      [projectId, [...wantedPaths, ...wantedAncestors]],
    );
    const have = new Map(existing.map((r) => [r.path, r]));

    // a file cannot be put where a folder is, and a folder cannot be created under a file
    for (const path of files.keys()) if (have.get(path)?.kind === 'dir') throw conflict('already_exists', `"${path}" is a folder`);
    for (const a of wantedAncestors) if (have.get(a)?.kind === 'file') throw conflict('parent_is_file', `"${a}" is a file, not a folder`);
    for (const d of folders) if (have.get(d)?.kind === 'file') throw conflict('already_exists', `"${d}" is a file`);

    const changed: string[] = [];
    const different = [...files].filter(([p, c]) => have.has(p) && have.get(p)!.content !== c).map(([p]) => p);
    if (different.length && !input.overwrite) throw conflict('conflicts', 'Some files already exist with other content', { paths: different });

    const deltas: FileDelta[] = [];
    let addBytes = 0, addNodes = 0;
    const newDirs = new Set<string>();
    for (const p of wantedPaths.flatMap((x) => [...ancestorsOf(x), ...(folders.has(x) ? [x] : [])])) if (!have.has(p)) newDirs.add(p);
    for (const [path, content] of files) {
      const old = have.get(path);
      if (!old) { addNodes++; addBytes += Buffer.byteLength(content); }
      else if (old.content !== content) addBytes += Math.max(0, Buffer.byteLength(content) - Buffer.byteLength(old.content));
    }
    await assertRoom(tx, projectId, addNodes + newDirs.size, addBytes);

    for (const dir of [...newDirs].sort()) {
      await tx.query("INSERT INTO nodes (project_id, path, kind, content, updated_at) VALUES ($1, $2, 'dir', '', $3)", [projectId, dir, ctx.now()]);
      deltas.push({ path: dir, kind: 'dir', action: 'created', before: null, after: '' });
    }
    for (const [path, content] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const old = have.get(path);
      if (!old) {
        await tx.query("INSERT INTO nodes (project_id, path, kind, content, updated_at) VALUES ($1, $2, 'file', $3, $4)", [projectId, path, content, ctx.now()]);
        deltas.push({ path, kind: 'file', action: 'created', before: null, after: content });
        changed.push(path);
      } else if (old.content !== content) {
        await tx.query('UPDATE nodes SET content = $3, version = version + 1, updated_at = $4 WHERE project_id = $1 AND path = $2', [projectId, path, content, ctx.now()]);
        deltas.push({ path, kind: 'file', action: 'updated', before: old.content, after: content });
        changed.push(path);
      }
    }
    const result = { created: deltas.filter((d) => d.kind === 'file' && d.action === 'created').length, updated: deltas.filter((d) => d.action === 'updated').length,
      unchanged: files.size - changed.length, newFolders: newDirs.size };
    if (!deltas.length) return { ...result, seq: null };

    const summary = changed.length === 1 ? `uploaded ${changed[0]}`
      : changed.length ? `uploaded ${changed.length} files`
      : newDirs.size === 1 ? `created folder ${[...newDirs][0]}` : `created ${newDirs.size} folders`;
    const { seq } = await recordChange(ctx, tx, projectId, actor, { kind: 'upload', summary, files: deltas });
    return { ...result, seq };
  });
}

// ---------- history ----------

export type ChangeInfo = {
  seq: number; kind: ChangeKind; summary: string; targetSeq: number | null; createdAt: string; updatedAt: string;
  actor: { type: 'user' | 'password'; name: string; label: string };
};
type ChangeRow = {
  seq: number; kind: ChangeKind; summary: string; target_seq: number | null; created_at: Date; updated_at: Date;
  actor_type: 'user' | 'password'; actor_name: string; actor_user_id: string | null;
};
const toChange = (r: ChangeRow): ChangeInfo => ({
  seq: r.seq, kind: r.kind, summary: r.summary, targetSeq: r.target_seq, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  // what the history list shows: the user's name, or "pw: name" / "pw"
  actor: { type: r.actor_type, name: r.actor_name, label: r.actor_type === 'user' ? r.actor_name : r.actor_name ? `pw: ${r.actor_name}` : 'pw' },
});

/** Newest first. Pass the last `seq` you got as `before` to fetch the next page. */
export async function listHistory(ctx: Ctx, projectId: string, opts: { limit: number; before?: number }) {
  const { rows } = await ctx.db.query<ChangeRow>(
    `SELECT seq, kind, summary, target_seq, created_at, updated_at, actor_type, actor_name, actor_user_id
     FROM changes WHERE project_id = $1 AND ($2::int IS NULL OR seq < $2) ORDER BY seq DESC LIMIT $3`,
    [projectId, opts.before ?? null, opts.limit + 1],
  );
  const page = rows.slice(0, opts.limit).map(toChange);
  return { changes: page, nextBefore: rows.length > opts.limit ? page[page.length - 1]!.seq : null };
}

export async function getChange(ctx: Ctx, projectId: string, seq: number) {
  const { rows: [row] } = await ctx.db.query<ChangeRow & { id: string }>(
    `SELECT id, seq, kind, summary, target_seq, created_at, updated_at, actor_type, actor_name, actor_user_id
     FROM changes WHERE project_id = $1 AND seq = $2`,
    [projectId, seq],
  );
  if (!row) throw notFound('No such change');
  const { rows: files } = await ctx.db.query<{ path: string; kind: string; action: string }>(
    'SELECT path, kind, action FROM change_files WHERE change_id = $1 ORDER BY path', [row.id],
  );
  return { ...toChange(row), files };
}

/** One file as it was before and after change #seq (null on the side where it did not exist). Folders have no content. */
export async function getChangeFile(ctx: Ctx, projectId: string, seq: number, path: string) {
  const { rows: [row] } = await ctx.db.query<{ action: 'created' | 'updated' | 'deleted'; before: string | null; after: string | null }>(
    `SELECT cf.action, cf.before, cf.after FROM changes c JOIN change_files cf ON cf.change_id = c.id
     WHERE c.project_id = $1 AND c.seq = $2 AND cf.path = $3 AND cf.kind = 'file'`,
    [projectId, seq, normalizePath(path)],
  );
  if (!row) throw notFound('That change did not touch this file');
  return { path: normalizePath(path), action: row.action, before: row.before, after: row.after };
}

/**
 * Restores the project to how it was right after change #seq. History is never rewritten: the difference between
 * now and then is recorded as a NEW change (kind "rollback"), so a rollback can itself be rolled back.
 * Policy: `author_and_write` = the owner and anyone with a read-write password; `author_only` = the project owner only.
 */
export async function rollback(ctx: Ctx, projectId: string, actor: Actor, level: 'owner' | 'rw' | 'ro', seq: number, policy: 'author_only' | 'author_and_write') {
  if (policy === 'author_only' && level !== 'owner') {
    throw new AppError(403, 'rollback_not_allowed', 'Only the project owner can roll back in this project');
  }
  return withTx(ctx.db, async (tx) => {
    await lockProject(tx, projectId);
    const { rowCount } = await tx.query('SELECT 1 FROM changes WHERE project_id = $1 AND seq = $2', [projectId, seq]);
    if (!rowCount) throw notFound('No such change');

    const { rows: nodes } = await tx.query<{ path: string; kind: 'dir' | 'file'; content: string }>(
      'SELECT path, kind, content FROM nodes WHERE project_id = $1', [projectId],
    );
    const current: State = new Map(nodes.map((n) => [n.path, { kind: n.kind, content: n.content }]));
    const { rows: later } = await tx.query<{ seq: number; path: string; kind: 'dir' | 'file'; action: 'created' | 'updated' | 'deleted'; before: string | null; after: string | null }>(
      `SELECT c.seq, cf.path, cf.kind, cf.action, cf.before, cf.after
       FROM changes c JOIN change_files cf ON cf.change_id = c.id
       WHERE c.project_id = $1 AND c.seq > $2 ORDER BY c.seq DESC`,
      [projectId, seq],
    );
    const groups: FileDelta[][] = [];
    let lastSeq = -1;
    for (const r of later) {
      if (r.seq !== lastSeq) { groups.push([]); lastSeq = r.seq; }
      groups[groups.length - 1]!.push({ path: r.path, kind: r.kind, action: r.action, before: r.before, after: r.after });
    }
    const wanted = rewind(current, groups);
    const deltas = diff(current, wanted);
    if (!deltas.length) throw conflict('already_at_state', `The project already looks like it did after #${seq}`);

    const del = deltas.filter((d) => d.action === 'deleted').map((d) => d.path);
    if (del.length) await tx.query('DELETE FROM nodes WHERE project_id = $1 AND path = ANY($2)', [projectId, del]);
    const now = ctx.now();
    for (const d of deltas) {
      if (d.action === 'created') await tx.query('INSERT INTO nodes (project_id, path, kind, content, updated_at) VALUES ($1, $2, $3, $4, $5)', [projectId, d.path, d.kind, d.after, now]);
      else if (d.action === 'updated') await tx.query('UPDATE nodes SET content = $3, version = version + 1, updated_at = $4 WHERE project_id = $1 AND path = $2', [projectId, d.path, d.after, now]);
    }
    return recordChange(ctx, tx, projectId, actor, { kind: 'rollback', summary: `rolled back to #${seq}`, targetSeq: seq, files: deltas });
  });
}

