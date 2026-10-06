import type { Db } from './db';
import type { Keys, ScryptCost } from './crypto';
import type { RateLimiter } from './rate-limit';

/** Everything the services need. Built once in createApp; tests can swap the clock and the scrypt cost. */
export type Ctx = {
  db: Db;
  keys: Keys;
  now: () => Date;
  cookieSecure: boolean;
  scryptCost: ScryptCost;
  /** A real scrypt hash of nothing in particular. Checked when a username does not exist, so that case takes as long as a wrong password. */
  dummyHash: Promise<string>;
  limits: { login: RateLimiter; register: RateLimiter; passwords: RateLimiter };
};
