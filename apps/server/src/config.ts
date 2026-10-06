import { z } from 'zod';

/**
 * PUBLIC_DOMAIN: where people reach the site. "mdh.example.com" means https://mdh.example.com;
 * "http://localhost:3000" is taken as written. Returns the origin ("https://host[:port]") or throws a readable message.
 */
export function parsePublicDomain(raw: string): string {
  const text = raw.trim();
  const fail = () => new Error(`PUBLIC_DOMAIN "${raw}" is not valid. Use a domain like mdh.example.com, or an address like http://localhost:3000 (no path).`);
  if (text.startsWith('/')) throw fail();
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { throw fail(); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) throw fail();
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw fail();
  return url.origin;
}

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_DOMAIN: z.string().optional(),   // optional: the address people use. Without it the site uses the address of the browser tab.
  STATIC_DIR: z.string().optional(), // the built website, e.g. ../web/dist
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'), // true behind a reverse proxy, so client IPs are real
});

export type Config = Omit<z.infer<typeof schema>, 'PUBLIC_DOMAIN'> & {
  /** Normalised origin of PUBLIC_DOMAIN, e.g. "https://mdh.example.com". Undefined when not set. */
  PUBLIC_URL?: string;
  /** Derived: true when PUBLIC_DOMAIN is https. There is no separate setting. */
  COOKIE_SECURE: boolean;
};

/** Reads and checks the environment. Throws one readable message listing every problem. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  const problems: string[] = [];
  if (!parsed.success) for (const i of parsed.error.issues) problems.push(`  - ${i.path.join('.')}: ${i.message}`);
  let publicUrl: string | undefined;
  const raw = env.PUBLIC_DOMAIN?.trim();
  if (raw) {
    try { publicUrl = parsePublicDomain(raw); } catch (e) { problems.push(`  - PUBLIC_DOMAIN: ${(e as Error).message}`); }
  }
  if (!parsed.success || problems.length) throw new Error('Invalid configuration:\n' + problems.join('\n'));
  const { PUBLIC_DOMAIN: _domain, ...rest } = parsed.data;
  void _domain;
  return { ...rest, PUBLIC_URL: publicUrl, COOKIE_SECURE: publicUrl?.startsWith('https:') ?? false };
}
