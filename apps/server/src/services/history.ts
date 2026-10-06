import type { Ctx } from '../context';
import type { Tx } from '../db';

export type Actor =
  | { type: 'user'; userId: string; name: string }
  | { type: 'password'; mode: 'ro' | 'rw'; name: string };

export type ChangeKind = 'edit' | 'create' | 'rename' | 'delete' | 'upload' | 'rollback';

/** One file's before/after. Directories use '' as their content. */
export type FileDelta = {
  path: string;
  kind: 'dir' | 'file';
  action: 'created' | 'updated' | 'deleted';
  before: string | null;
  after: string | null;
};

/**
 * Adds one entry to a project's history. Must run inside the same transaction as the change to `nodes`.
 * Bumping `last_seq` locks the project row until commit, so changes are numbered 1, 2, 3... with no gaps,
 * even when many requests arrive at once.
 */
export async function recordChange(
  ctx: Ctx,
  tx: Tx,
  projectId: string,
  actor: Actor,
  entry: { kind: ChangeKind; summary: string; targetSeq?: number; files: FileDelta[] },
): Promise<{ id: string; seq: number }> {
  const now = ctx.now();
  const { rows: [p] } = await tx.query<{ last_seq: number }>(
    'UPDATE projects SET last_seq = last_seq + 1, updated_at = $2 WHERE id = $1 RETURNING last_seq',
    [projectId, now],
  );
  if (!p) throw new Error('recordChange: project does not exist');
  const { rows: [c] } = await tx.query<{ id: string }>(
    `INSERT INTO changes (project_id, seq, actor_type, actor_user_id, actor_name, kind, summary, target_seq, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
    [projectId, p.last_seq, actor.type, actor.type === 'user' ? actor.userId : null, actor.name, entry.kind, entry.summary, entry.targetSeq ?? null, now],
  );
  if (entry.files.length) {
    await tx.query(
      `INSERT INTO change_files (change_id, path, kind, action, before, after)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])`,
      [c!.id, entry.files.map((f) => f.path), entry.files.map((f) => f.kind), entry.files.map((f) => f.action), entry.files.map((f) => f.before), entry.files.map((f) => f.after)],
    );
  }
  return { id: c!.id, seq: p.last_seq };
}
