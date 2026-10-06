import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import pg from 'pg';

const here = (p: string) => resolve(import.meta.dirname, p);
const sh = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });

async function waitFor(check: () => Promise<boolean>, what: string, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check().catch(() => false)) return; await new Promise((r) => setTimeout(r, 400)); }
  throw new Error(`Timed out waiting for ${what}`);
}

export default async function globalSetup() {
  const server = here('../server/dist/index.js');
  const site = here('../web/dist/index.html');
  if (!existsSync(server) || !existsSync(site)) throw new Error('Build first: pnpm build (the tests run against apps/server/dist and apps/web/dist)');

  // 1. a disposable PostgreSQL 18
  const container = `mdh-e2e-pg-${process.pid}`;
  sh('docker', ['run', '-d', '--rm', '--name', container, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=e2e', '--tmpfs', '/var/lib/postgresql', 'postgres:18', '-c', 'fsync=off']);
  const mapped = sh('docker', ['port', container, '5432/tcp']).split('\n')[0]!;
  const databaseUrl = `postgres://postgres:e2e@127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}/postgres`;
  await waitFor(async () => { const c = new pg.Client({ connectionString: databaseUrl }); await c.connect(); await c.query('SELECT 1'); await c.end(); return true; }, 'postgres');

  // 2. the real server, serving the built site, the way it runs in production
  const port = await freePort();
  const app: ChildProcess = spawn('node', [server], {
    env: { ...process.env, DATABASE_URL: databaseUrl, APP_SECRET: 'e2e-secret-e2e-secret-e2e-secret-1234', PORT: String(port), TRUST_PROXY: 'true', PUBLIC_DOMAIN: `http://localhost:${port}`, STATIC_DIR: here('../web/dist') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  app.stdout?.on('data', (d) => (log += d)); app.stderr?.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 'the server');
  } catch (e) {
    app.kill(); sh('docker', ['stop', container]);
    throw new Error(`${(e as Error).message}\n--- server log ---\n${log}`);
  }
  process.env.E2E_BASE_URL = base;
  process.env.E2E_PUBLIC_URL = `http://localhost:${port}`;   // what PUBLIC_DOMAIN says; differs from `base` on purpose

  return () => { app.kill('SIGTERM'); spawnSync('docker', ['stop', container]); };
}
