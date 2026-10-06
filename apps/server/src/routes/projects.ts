import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context';
import { notFound } from '../errors';
import { parse } from '../http';
import { authorize, openGate, whoAmI } from '../services/access';
import { policySchema, requireUser } from '../services/auth';
import * as projects from '../services/projects';

const nameSchema = z.string({ error: 'Give the project a name' }).trim().min(1, 'Give the project a name').max(100, 'Name is too long (max 100)');
const createBody = z.object({ name: nameSchema });
const settingsBody = z.object({ rollbackPolicy: policySchema.optional() }).strict();
const gateBody = z.object({ password: z.string({ error: 'Enter the password' }).max(100), name: z.string().max(200).optional() });

export function projectRoutes(ctx: Ctx) {
  const r = Router();

  r.get('/', async (req, res) => {
    const user = await requireUser(ctx, req);
    res.json({ projects: await projects.listProjects(ctx, user) });
  });

  r.post('/', async (req, res) => {
    const user = await requireUser(ctx, req);
    res.status(201).json({ project: await projects.createProject(ctx, user, parse(createBody, req.body).name) });
  });

  r.get('/:id', async (req, res) => {
    const { project, access } = await authorize(ctx, req, req.params.id!, 'read');
    res.json({ project: projects.toInfo(project), access: { level: access.level, name: access.actor.name } });
  });

  // The name of a project is public to anyone who knows its id; nothing else is. Used by link cards and the password gate.
  r.get('/:id/public', async (req, res) => {
    projects.countLookup(ctx, req.ip ?? '');
    const name = await projects.publicName(ctx, req.params.id!);
    if (name === null) throw notFound('No such project');
    res.json({ name });
  });

  r.patch('/:id', async (req, res) => {
    const { project } = await authorize(ctx, req, req.params.id!, 'owner');
    res.json({ project: await projects.updateSettings(ctx, project.id, parse(settingsBody, req.body)) });
  });

  r.delete('/:id', async (req, res) => {
    const { project } = await authorize(ctx, req, req.params.id!, 'owner');
    await projects.deleteProject(ctx, project.id);
    res.json({ ok: true });
  });

  r.get('/:id/passwords', async (req, res) => {
    const { project } = await authorize(ctx, req, req.params.id!, 'owner');
    res.json(projects.readPasswords(ctx, project));
  });

  r.post('/:id/passwords/:mode/refresh', async (req, res) => {
    const mode = req.params.mode;
    if (mode !== 'ro' && mode !== 'rw') throw notFound('Unknown password type');
    const { project } = await authorize(ctx, req, req.params.id!, 'owner');
    res.json({ password: await projects.refreshPassword(ctx, project.id, mode) });
  });

  r.post('/:id/access', async (req, res) => {
    const body = parse(gateBody, req.body);
    const out = await openGate(ctx, req, res, req.params.id!, body.password, body.name);
    res.json({ access: out });
  });

  return r;
}

export function accessRoutes(ctx: Ctx) {
  const r = Router();
  r.get('/', async (req, res) => {
    res.json(await whoAmI(ctx, req));
  });
  return r;
}
