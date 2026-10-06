import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context';
import { parse } from '../http';
import * as auth from '../services/auth';

const credentials = z.object({ username: auth.usernameSchema, password: z.string({ error: 'Enter a password' }).max(200) });
const registration = z.object({ username: auth.usernameSchema, password: auth.passwordSchema });
const profilePatch = z.object({ defaultRollbackPolicy: auth.policySchema.optional() }).strict();

export function authRoutes(ctx: Ctx) {
  const r = Router();

  r.post('/register', async (req, res) => {
    const user = await auth.register(ctx, req.ip ?? '', parse(registration, req.body));
    auth.startSession(ctx, res, user);
    res.status(201).json({ user });
  });

  r.post('/login', async (req, res) => {
    const user = await auth.login(ctx, req.ip ?? '', parse(credentials, req.body));
    auth.startSession(ctx, res, user);
    res.json({ user });
  });

  r.post('/logout', (_req, res) => {
    auth.endSession(ctx, res);
    res.json({ ok: true });
  });

  // 200 with user: null when signed out, so the page can ask without raising an error
  r.get('/me', async (req, res) => {
    res.json({ user: await auth.sessionUser(ctx, req) });
  });

  r.patch('/me', async (req, res) => {
    const user = await auth.requireUser(ctx, req);
    res.json({ user: await auth.updateUser(ctx, user.id, parse(profilePatch, req.body)) });
  });

  return r;
}
