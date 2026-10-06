import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  decrypt, deriveKeys, encrypt, generateProjectPassword, hashPassword, lookupHash, verifyPassword,
} from '../src/crypto';
import { signToken, verifyToken } from '../src/session';
import { FAST_SCRYPT } from './helpers';

const keys = deriveKeys('a'.repeat(40));
const otherKeys = deriveKeys('b'.repeat(40));

describe('deriveKeys', () => {
  it('gives every purpose its own key', () => {
    const all = Object.values(keys).map((k) => k.toString('hex'));
    expect(new Set(all).size).toBe(4);
    for (const k of Object.values(keys)) expect(k).toHaveLength(32);
  });
  it('is deterministic per secret and different between secrets', () => {
    expect(deriveKeys('a'.repeat(40)).aes.equals(keys.aes)).toBe(true);
    expect(otherKeys.aes.equals(keys.aes)).toBe(false);
  });
});

describe('account passwords (scrypt)', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const h = await hashPassword('correct horse', FAST_SCRYPT);
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('correct horsf', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });
  it('uses a new salt every time and never stores the password', async () => {
    const [a, b] = [await hashPassword('same', FAST_SCRYPT), await hashPassword('same', FAST_SCRYPT)];
    expect(a).not.toBe(b);
    expect(a).not.toContain('same');
    expect(a.startsWith('scrypt$1024$8$1$')).toBe(true);
  });
  it('stores its own cost, so old hashes keep working when the cost changes', async () => {
    const h = await hashPassword('pw-pw-pw', { N: 2048, r: 8, p: 1 });
    expect(await verifyPassword('pw-pw-pw', h)).toBe(true);
  });
  it('treats unicode-equivalent passwords as equal (NFKC)', async () => {
    const h = await hashPassword('éclair-1', FAST_SCRYPT); // é as one character
    expect(await verifyPassword('éclair-1', h)).toBe(true); // e + combining accent
  });
  it('returns false (never throws) for malformed stored values', async () => {
    for (const bad of ['', 'x', 'scrypt$', 'scrypt$1$1$1$a$b', 'bcrypt$1024$8$1$aaaa$bbbb', 'scrypt$-1$8$1$aa$bb', 'scrypt$1048577$8$1$aa$bb', 'scrypt$abc$8$1$aa$bb']) {
      expect(await verifyPassword('pw', bad), bad).toBe(false);
    }
  });
  it('a stored hash with an absurd cost is refused instead of exhausting memory', async () => {
    expect(await verifyPassword('pw', `scrypt$${2 ** 22}$8$1$${'a'.repeat(22)}$${'b'.repeat(43)}`)).toBe(false);
  });
});

describe('project passwords', () => {
  it('has the mode prefix, 24 characters and no look-alike characters', () => {
    for (const mode of ['ro', 'rw'] as const) {
      const p = generateProjectPassword(mode);
      expect(p).toMatch(new RegExp(`^${mode}_[abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789]{24}$`));
    }
  });
  it('does not repeat in 5000 draws', () => {
    expect(new Set(Array.from({ length: 5000 }, () => generateProjectPassword('rw'))).size).toBe(5000);
  });
  it('uses every character of the alphabet (no stuck position or bias to a few characters)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) for (const c of generateProjectPassword('ro').slice(3)) seen.add(c);
    expect(seen.size).toBe(56);
  });
});

describe('lookupHash', () => {
  it('is stable, 32 bytes, and depends on both password and secret', () => {
    const a = lookupHash(keys, 'rw_x');
    expect(a).toHaveLength(32);
    expect(lookupHash(keys, 'rw_x').equals(a)).toBe(true);
    expect(lookupHash(keys, 'rw_y').equals(a)).toBe(false);
    expect(lookupHash(otherKeys, 'rw_x').equals(a)).toBe(false);
  });
});

describe('AES-256-GCM', () => {
  it('round-trips, including empty and unicode text', () => {
    for (const text of ['', 'rw_abc', 'türkçe ğüşiöç 🔑', 'x'.repeat(10_000)]) {
      expect(decrypt(keys, encrypt(keys, text, 'ctx'), 'ctx')).toBe(text);
    }
  });
  it('gives different output for the same input (random IV)', () => {
    expect(encrypt(keys, 'same', 'ctx')).not.toBe(encrypt(keys, 'same', 'ctx'));
  });
  it('does not contain the plaintext', () => {
    expect(encrypt(keys, 'rw_SECRETSECRET', 'ctx')).not.toContain('SECRETSECRET');
  });
  it('refuses a changed ciphertext, IV or tag', () => {
    const [v, iv, tag, ct] = encrypt(keys, 'hello world', 'ctx').split('.') as [string, string, string, string];
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect(() => decrypt(keys, [v, iv, tag, flip(ct)].join('.'), 'ctx')).toThrow();
    expect(() => decrypt(keys, [v, flip(iv), tag, ct].join('.'), 'ctx')).toThrow();
    expect(() => decrypt(keys, [v, iv, flip(tag), ct].join('.'), 'ctx')).toThrow();
  });
  it('refuses a value moved to another row (different aad) or made with another key', () => {
    const c = encrypt(keys, 'rw_x', 'project:1:rw');
    expect(() => decrypt(keys, c, 'project:2:rw')).toThrow();
    expect(() => decrypt(keys, c, 'project:1:ro')).toThrow();
    expect(() => decrypt(otherKeys, c, 'project:1:rw')).toThrow();
  });
  it('refuses garbage', () => {
    for (const bad of ['', 'v1', 'v1.a.b', 'v2.a.b.c', 'hello']) expect(() => decrypt(keys, bad, 'ctx'), bad).toThrow();
  });
  it('property: any text round-trips', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), fc.string(), (text, aad) => decrypt(keys, encrypt(keys, text, aad), aad) === text), { numRuns: 300 });
  });
});

describe('signed tokens', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const at = (s: number) => new Date(now.getTime() + s * 1000);

  it('round-trips a payload until it expires', () => {
    const t = signToken(keys.session, { uid: 'u1' }, now, 60);
    expect(verifyToken(keys.session, t, at(0))).toMatchObject({ uid: 'u1' });
    expect(verifyToken(keys.session, t, at(59))).toMatchObject({ uid: 'u1' });
  });
  it('expires exactly at the deadline', () => {
    const t = signToken(keys.session, { uid: 'u1' }, now, 60);
    expect(verifyToken(keys.session, t, at(60))).toBeNull();
    expect(verifyToken(keys.session, t, at(61))).toBeNull();
  });
  it('refuses a changed payload or signature', () => {
    const [body, mac] = signToken(keys.session, { uid: 'u1' }, now, 60).split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ uid: 'admin', exp: 9_999_999_999 })).toString('base64url');
    expect(verifyToken(keys.session, `${forged}.${mac}`, now)).toBeNull();
    expect(verifyToken(keys.session, `${body}.${mac.slice(0, -2)}AA`, now)).toBeNull();
    expect(verifyToken(keys.session, `${body}.`, now)).toBeNull();
  });
  it('refuses a token made with another key (also another purpose)', () => {
    const t = signToken(keys.session, { uid: 'u1' }, now, 60);
    expect(verifyToken(otherKeys.session, t, now)).toBeNull();
    expect(verifyToken(keys.access, t, now)).toBeNull();
  });
  it('returns null for undefined and malformed input', () => {
    for (const bad of [undefined, '', '.', 'a.b.c', 'no-dot', '%%%.%%%']) expect(verifyToken(keys.session, bad, now), String(bad)).toBeNull();
  });
  it('a correctly signed token without a numeric exp is refused', async () => {
    const { createHmac } = await import('node:crypto');
    const body = Buffer.from(JSON.stringify({ uid: 'u1' })).toString('base64url');
    const mac = createHmac('sha256', keys.session).update(body).digest('base64url');
    expect(verifyToken(keys.session, `${body}.${mac}`, now)).toBeNull();
  });
  it('property: verify never throws on arbitrary input', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), (s) => { verifyToken(keys.session, s, now); return true; }), { numRuns: 500 });
  });
  it('property: a signed payload comes back unchanged', () => {
    fc.assert(
      fc.property(fc.record({ uid: fc.string(), n: fc.integer() }), (p) => {
        const out = verifyToken<{ uid: string; n: number }>(keys.session, signToken(keys.session, p, now, 60), now);
        return out?.uid === p.uid && out.n === p.n;
      }),
      { numRuns: 300 },
    );
  });
});
