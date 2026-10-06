let cached: Promise<string> | undefined;

/**
 * The address people use to reach this site. The server knows it from PUBLIC_DOMAIN (a static page cannot read
 * server settings, so it asks); without it, the address of the browser tab is the best answer there is.
 * Asked once per page.
 */
export function siteUrl(): Promise<string> {
  cached ??= fetch('/api/config', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { publicUrl?: unknown } | null) => (typeof j?.publicUrl === 'string' && j.publicUrl ? j.publicUrl : location.origin))
    .catch(() => location.origin);
  return cached;
}

/** For tests: forget the answer. */
export function forgetSiteUrl() { cached = undefined; }
