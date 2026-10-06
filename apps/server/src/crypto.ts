import {
  createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, scrypt, timingSafeEqual,
} from 'node:crypto';

/** Separate keys for separate jobs, all derived from APP_SECRET. A leak of one use never exposes another. */
export type Keys = { session: Buffer; access: Buffer; aes: Buffer; hash: Buffer };

export function deriveKeys(secret: string): Keys {
  const k = (info: string) => Buffer.from(hkdfSync('sha256', secret, 'mdh-mdh', info, 32));
  return { session: k('session-cookie'), access: k('access-cookie'), aes: k('aes-256-gcm'), hash: k('password-lookup') };
}

// ---------- account passwords: scrypt ----------

export type ScryptCost = { N: number; r: number; p: number };
export const DEFAULT_SCRYPT: ScryptCost = { N: 2 ** 15, r: 8, p: 1 };
const KEYLEN = 32;

const b64 = (b: Buffer) => b.toString('base64url');
const scryptAsync = (pw: string, salt: Buffer, c: ScryptCost) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(pw.normalize('NFKC'), salt, KEYLEN, { N: c.N, r: c.r, p: c.p, maxmem: 256 * c.N * c.r }, (e, k) => (e ? reject(e) : resolve(k))),
  );

/** Returns `scrypt$N$r$p$salt$hash`. The cost is stored, so it can be raised later without breaking old hashes. */
export async function hashPassword(password: string, cost: ScryptCost = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, cost);
  return ['scrypt', cost.N, cost.r, cost.p, b64(salt), b64(hash)].join('$');
}

/** False for a wrong password AND for any malformed stored value. Never throws. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, N, r, p, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt' || !N || !r || !p || !salt || !hash) return false;
    const cost = { N: Number(N), r: Number(r), p: Number(p) };
    if (![cost.N, cost.r, cost.p].every((n) => Number.isInteger(n) && n > 0) || cost.N > 2 ** 20) return false;
    const expected = Buffer.from(hash, 'base64url');
    if (expected.length !== KEYLEN) return false;
    const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), cost);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------- project passwords ----------

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes (0 O 1 l I)
export type Mode = 'ro' | 'rw';

/** `ro_` / `rw_` + 24 random characters (~139 bits). randomInt avoids modulo bias. */
export function generateProjectPassword(mode: Mode): string {
  let s = '';
  for (let i = 0; i < 24; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${mode}_${s}`;
}

/** Deterministic lookup value. Safe because the input is 139 random bits, not a human-chosen secret. */
export const lookupHash = (keys: Keys, password: string): Buffer => createHmac('sha256', keys.hash).update(password).digest();

// ---------- AES-256-GCM (so the owner can copy a project password again) ----------

/** `aad` ties the ciphertext to where it is stored (e.g. `project:<id>:rw`), so it cannot be moved to another row. */
export function encrypt(keys: Keys, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keys.aes, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
}

/** Throws when the value was changed, belongs to another aad, or was made with another key. */
export function decrypt(keys: Keys, value: string, aad: string): string {
  const [v, iv, tag, ct] = value.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Invalid ciphertext');
  const d = createDecipheriv('aes-256-gcm', keys.aes, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
