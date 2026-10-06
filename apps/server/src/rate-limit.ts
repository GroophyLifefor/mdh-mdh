/** Counts events per key inside a sliding window. In memory, so it is per process. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => Date,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now().getTime() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  isLimited(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  hit(key: string): void {
    const list = this.recent(key);
    list.push(this.now().getTime());
    this.hits.set(key, list);
    if (this.hits.size > 10_000) for (const k of this.hits.keys()) this.recent(k); // drop stale keys
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  /** Seconds until the oldest counted event leaves the window. */
  retryAfterSeconds(key: string): number {
    const list = this.recent(key);
    if (!list.length) return 0;
    return Math.max(1, Math.ceil((list[0]! + this.windowMs - this.now().getTime()) / 1000));
  }
}
