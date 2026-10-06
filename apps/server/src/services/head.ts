/** The <head> tags that make a shared link look good in chat apps (Open Graph + Twitter card). Pure functions. */
export const MARKER = '<meta name="mdh-head">';

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A host name (with an optional port) that is safe to put into a URL. Anything else is not trusted. */
export const SAFE_HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;
export const SAFE_HOST_V6 = /^\[[0-9a-f:]+\](:\d{1,5})?$/i;

export type Page = { title: string; description: string; url: string; image: string; imageAlt: string; noindex?: boolean };

export function headTags(p: Page): string {
  const t = escapeHtml(p.title), d = escapeHtml(p.description), u = escapeHtml(p.url), i = escapeHtml(p.image), a = escapeHtml(p.imageAlt);
  return [
    `<meta name="description" content="${d}">`,
    ...(p.noindex ? ['<meta name="robots" content="noindex, nofollow">'] : []),
    '<meta property="og:site_name" content="mdh-mdh">',
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${u}">`,
    `<meta property="og:image" content="${i}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${a}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${i}">`,
  ].join('\n    ');
}

/** Puts the tags into a built page (replacing the marker) and, when given, a new <title>. */
export function fillPage(html: string, tags: string, title?: string): string {
  let out = html.replace(MARKER, () => tags);
  if (title !== undefined) out = out.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escapeHtml(title)}</title>`);
  return out;
}
