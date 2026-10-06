// The shapes the API sends. See apps/web/public/llm.txt for the full description.
export type Policy = 'author_only' | 'author_and_write';
export type Level = 'owner' | 'rw' | 'ro';
export type Mode = 'rw' | 'ro';

export type User = { id: string; username: string; defaultRollbackPolicy: Policy };
export type ProjectInfo = { id: string; name: string; rollbackPolicy: Policy; updatedAt: string };
export type Access = { level: Level; name: string };
export type TreeNode = { path: string; kind: 'dir' | 'file'; version: number; size: number };

export type ChangeKind = 'edit' | 'create' | 'rename' | 'delete' | 'upload' | 'rollback';
export type ChangeInfo = {
  seq: number; kind: ChangeKind; summary: string; targetSeq: number | null; createdAt: string; updatedAt: string;
  actor: { type: 'user' | 'password'; name: string; label: string };
};
export type ChangeDetail = ChangeInfo & { files: { path: string; kind: 'dir' | 'file'; action: 'created' | 'updated' | 'deleted' }[] };

export type SaveResult = { unchanged: true; version: number } | { unchanged: false; version: number; seq: number; merged: boolean };
export type UploadResult = { created: number; updated: number; unchanged: number; newFolders: number; seq: number | null };
