/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then a date. For history and project lists. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Case-insensitive "contains" for the project search. An empty query matches everything. */
export function matches(name: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return !q || name.toLocaleLowerCase().includes(q);
}
