import { loadConfig } from './config';
import { createPool } from './db';
import { migrate } from './migrate';
import { createApp } from './app';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const applied = await migrate(db);
if (applied.length) console.log('Applied migrations:', applied.join(', '));

createApp({ db, secret: config.APP_SECRET, cookieSecure: config.COOKIE_SECURE, trustProxy: config.TRUST_PROXY, staticDir: config.STATIC_DIR, publicUrl: config.PUBLIC_URL }).listen(config.PORT, () =>
  console.log(`mdh-mdh listening on :${config.PORT}`),
);
