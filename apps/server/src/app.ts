import express from 'express';
import type { Db } from './db';
import { AppError } from './errors';
import { DEFAULT_SCRYPT, deriveKeys, hashPassword, type ScryptCost } from './crypto';
import { RateLimiter } from './rate-limit';
import { originCheck } from './http';
import type { Ctx } from './context';
import { authRoutes } from './routes/auth';
import { accessRoutes, projectRoutes } from './routes/projects';
import { fileRoutes } from './routes/files';
import { configRoutes } from './routes/config';
import { mountStatic } from './static';

export type Deps = {
  db: Db;
  secret: string;
  now?: () => Date;
  cookieSecure?: boolean;
  trustProxy?: boolean;
  scryptCost?: ScryptCost;
  /** Folder with the built website (apps/web/dist). Without it only the API is served. */
  staticDir?: string;
  /** Origin people use to reach the site (from PUBLIC_DOMAIN), e.g. "https://mdh.example.com". */
  publicUrl?: string;
};

export function createApp(deps: Deps) {
  const now = deps.now ?? (() => new Date());
  const scryptCost = deps.scryptCost ?? DEFAULT_SCRYPT;
  const ctx: Ctx = {
    db: deps.db,
    keys: deriveKeys(deps.secret),
    now,
    cookieSecure: deps.cookieSecure ?? false,
    scryptCost,
    dummyHash: hashPassword('not-a-real-password', scryptCost),
    limits: {
      login: new RateLimiter(10, 15 * 60_000, now),    // failed logins per IP
      register: new RateLimiter(20, 60 * 60_000, now), // sign-ups per IP
      passwords: new RateLimiter(30, 15 * 60_000, now), // wrong project passwords (gate or Bearer) per IP
    },
  };

  const app = express();
  app.disable('x-powered-by');
  if (deps.trustProxy) app.set('trust proxy', true);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer'); // project ids are in the URL: never send them to other sites
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '10mb' }));

  app.use('/api', originCheck(deps.publicUrl));
  const routeTable: string[] = [];
  const mount = (base: string, router: express.Router) => {
    app.use(base, router);
    for (const layer of router.stack) {
      const route = (layer as { route?: { path: string; methods: Record<string, boolean> } }).route;
      if (!route) continue;
      for (const m of Object.keys(route.methods)) routeTable.push(`${m.toUpperCase()} ${base}${route.path === '/' ? '' : route.path}`);
    }
  };
  app.get('/api/health', async (_req, res) => {
    await ctx.db.query('SELECT 1');
    res.json({ ok: true });
  });
  routeTable.push('GET /api/health');
  mount('/api/auth', authRoutes(ctx));
  mount('/api/projects', projectRoutes(ctx));
  mount('/api/projects/:id', fileRoutes(ctx));
  mount('/api/access', accessRoutes(ctx));
  mount('/api/config', configRoutes(deps.publicUrl));
  app.locals.routeTable = routeTable;

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint' } });
  });
  if (deps.staticDir) mountStatic(app, deps.staticDir);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      if (err.status === 429) res.setHeader('Retry-After', String((err.details as { retryAfterSeconds: number }).retryAfterSeconds));
      res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details !== undefined && err.status !== 429 ? { details: err.details } : {}) } });
      return;
    }
    // body-parser errors carry their own status (bad JSON, too large)
    const status = (err as { status?: number }).status;
    if (status === 400 || status === 413) {
      res.status(status).json({ error: { code: status === 413 ? 'too_large' : 'bad_json', message: 'Invalid request body' } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  return app;
}
