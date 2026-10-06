// Starts one throw-away PostgreSQL 18 container for the whole run (or uses DATABASE_URL_TEST),
// migrates a template database once, and hands the admin URL to the tests.
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { createPool } from '../src/db';
import { migrate } from '../src/migrate';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
  }
}

const IMAGE = 'postgres:18';

function docker(...args: string[]) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

async function waitForPostgres(url: string) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const c = new pg.Client({ connectionString: url });
    try {
      await c.connect();
      await c.query('SELECT 1');
      await c.end();
      return;
    } catch (err) {
      await c.end().catch(() => {});
      if (Date.now() > deadline) throw new Error('Postgres did not become ready: ' + (err as Error).message);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export default async function setup({ provide }: TestProject) {
  let adminUrl = process.env.DATABASE_URL_TEST;
  let container: string | undefined;

  if (!adminUrl) {
    container = `mdh-test-pg-${process.pid}`;
    // tmpfs + fsync off: this database is disposable, speed matters more than durability.
    docker(
      'run', '-d', '--rm', '--name', container,
      '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_PASSWORD=test',
      '--tmpfs', '/var/lib/postgresql',
      IMAGE, '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=300',
    );
    const mapped = docker('port', container, '5432/tcp').split('\n')[0]!; // 127.0.0.1:49153
    const port = mapped.slice(mapped.lastIndexOf(':') + 1);
    adminUrl = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  }

  try {
    await waitForPostgres(adminUrl);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS mdh_template');
    await admin.query('CREATE DATABASE mdh_template');
    await admin.end();

    const templateUrl = new URL(adminUrl);
    templateUrl.pathname = '/mdh_template';
    const pool = createPool(templateUrl.toString());
    await migrate(pool);
    await pool.end(); // a template must have no open connections when it is cloned
  } catch (err) {
    if (container) spawnSync('docker', ['stop', container]);
    throw err;
  }

  provide('adminUrl', adminUrl);

  return () => {
    if (container) spawnSync('docker', ['stop', container]);
  };
}
