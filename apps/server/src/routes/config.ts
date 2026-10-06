import { Router } from 'express';

/** What the website needs to know about the server. Nothing secret. `publicUrl` is null when PUBLIC_DOMAIN is not set. */
export function configRoutes(publicUrl: string | undefined) {
  const r = Router();
  r.get('/', (_req, res) => { res.json({ publicUrl: publicUrl ?? null }); });
  return r;
}
