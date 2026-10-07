import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context';
import { badRequest } from '../errors';
import { parse } from '../http';
import { authorize } from '../services/access';
import * as files from '../services/files';
import { contentDisposition, download } from '../services/download';

const saveBody = z.object({ path: z.string(), content: z.string(), baseVersion: z.number().int().min(1) }).strict();
const createBody = z.object({ path: z.string(), kind: z.enum(['file', 'dir']), content: z.string().optional() }).strict();
const moveBody = z.object({ from: z.string(), to: z.string() }).strict();
const uploadBody = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() }).strict()).max(files.MAX_UPLOAD_FILES, `At most ${files.MAX_UPLOAD_FILES} files per upload`),
  folders: z.array(z.string()).max(files.MAX_NODES).optional(),
  overwrite: z.boolean().optional(),
}).strict();

const queryPath = (v: unknown) => {
  if (typeof v !== 'string' || !v) throw badRequest('invalid_path', 'Give the path as ?path=...');
  return v;
};
const seqParam = (v: unknown) => {
  const n = Number(v);
  if (!/^\d{1,9}$/.test(String(v)) || n < 1) throw badRequest('invalid_seq', 'Change number must be a positive integer');
  return n;
};

export function fileRoutes(ctx: Ctx) {
  const r = Router({ mergeParams: true });
  const id = (req: { params: Record<string, string | undefined> }) => req.params.id!;

  r.get('/tree', async (req, res) => {
    const { project } = await authorize(ctx, req, id(req), 'read');
    res.json({ nodes: await files.getTree(ctx, project.id) });
  });

  r.get('/file', async (req, res) => {
    const { project } = await authorize(ctx, req, id(req), 'read');
    res.json({ file: await files.readFile(ctx, project.id, queryPath(req.query.path)) });
  });

  // one file as it is, a folder as a zip, or (no path) the whole project as a zip
  r.get('/download', async (req, res) => {
    const { project } = await authorize(ctx, req, id(req), 'read');
    const path = req.query.path === undefined ? undefined : queryPath(req.query.path);
    const d = await download(ctx, project, path);
    res.setHeader('Content-Type', d.mime);
    res.setHeader('Content-Disposition', contentDisposition(d.filename));
    res.setHeader('Content-Length', String(d.data.length));
    res.end(d.data);
  });

  r.put('/file', async (req, res) => {
    const { project, access } = await authorize(ctx, req, id(req), 'write');
    const b = parse(saveBody, req.body);
    res.json(await files.saveFile(ctx, project.id, access.actor, { path: b.path, content: b.content, baseVersion: b.baseVersion }));
  });

  r.post('/files', async (req, res) => {
    const { project, access } = await authorize(ctx, req, id(req), 'write');
    const b = parse(createBody, req.body);
    res.status(201).json({ change: await files.createNode(ctx, project.id, access.actor, b) });
  });

  r.post('/move', async (req, res) => {
    const { project, access } = await authorize(ctx, req, id(req), 'write');
    res.json({ change: await files.moveNode(ctx, project.id, access.actor, parse(moveBody, req.body)) });
  });

  r.delete('/file', async (req, res) => {
    const { project, access } = await authorize(ctx, req, id(req), 'write');
    res.json({ change: await files.deleteNode(ctx, project.id, access.actor, queryPath(req.query.path)) });
  });

  r.post('/upload', async (req, res) => {
    const { project, access } = await authorize(ctx, req, id(req), 'write');
    res.json(await files.upload(ctx, project.id, access.actor, parse(uploadBody, req.body)));
  });

  r.get('/history', async (req, res) => {
    const { project } = await authorize(ctx, req, id(req), 'read');
    const limit = req.query.limit === undefined ? 100 : Math.min(500, seqParam(req.query.limit));
    const before = req.query.before === undefined ? undefined : seqParam(req.query.before);
    res.json(await files.listHistory(ctx, project.id, { limit, before }));
  });

  r.get('/history/:seq', async (req, res) => {
    const { project } = await authorize(ctx, req, id(req), 'read');
    res.json({ change: await files.getChange(ctx, project.id, seqParam(req.params.seq)) });
  });

  // a file before and after one change (for the diff view); one file at a time keeps the answer small
  r.get('/history/:seq/file', async (req, res) => {
    const { project } = await authorize(ctx, req, id(req), 'read');
    res.json({ file: await files.getChangeFile(ctx, project.id, seqParam(req.params.seq), queryPath(req.query.path)) });
  });

  r.post('/history/:seq/rollback', async (req, res) => {
    const { project, access } = await authorize(ctx, req, id(req), 'write');
    res.json({ change: await files.rollback(ctx, project.id, access.actor, access.level, seqParam(req.params.seq), project.rollback_policy) });
  });

  return r;
}
