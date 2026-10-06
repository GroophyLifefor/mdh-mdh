import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createPool, type Db } from '../src/db';

export type TestDb = { db: Db; url: string; drop: () => Promise<void> };

/** A private, fully migrated database cloned from the template. Call drop() when done. */
export async function createTestDb(): Promise<TestDb> {
  const adminUrl = inject('adminUrl');
  const name = 't_' + randomBytes(6).toString('hex');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE mdh_template`);
  await admin.end();

  const u = new URL(adminUrl);
  u.pathname = '/' + name;
  const url = u.toString();
  const db = createPool(url);

  return {
    db,
    url,
    drop: async () => {
      await db.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
