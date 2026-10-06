import { ApiError } from './api';

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'conflict' | 'toobig' | 'error';

type Options = {
  /** Wait this long after the last keystroke. */
  delayMs: number;
  /** Writes one version of the text. Throws ApiError when the server refuses. */
  save: (content: string) => Promise<void>;
  onState: (state: SaveState, error?: ApiError) => void;
  /** First wait after a network failure; doubles each time up to 30 s. */
  retryMs?: number;
};

/**
 * Saves the latest text a moment after typing stops, one request at a time, never losing text:
 * if the text changes while a save is running, the newest text is saved right after.
 *
 * Stops (keeps the text, tells the page) on a version conflict until `resume()`, and never hammers the
 * server: network errors are retried with a growing wait.
 */
export class Autosave {
  state: SaveState = 'idle';
  private latest: string | null = null;     // text that still has to be saved
  private inFlight: string | null = null;   // text of the save that is running right now
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private blocked = false;                  // conflict or fatal error: wait for resume()
  private disposed = false;
  private retryDelay: number;

  constructor(private readonly opts: Options) {
    this.retryDelay = opts.retryMs ?? 3000;
  }

  private set(state: SaveState, error?: ApiError) {
    this.state = state;
    this.opts.onState(state, error);
  }

  /** True while there is text the server does not have (also after a conflict or a failed save). */
  get hasUnsaved(): boolean {
    return this.latest !== null || this.running !== null;
  }

  /** The newest text the server may not have yet: waiting to be saved, or being saved right now. */
  get unsavedText(): string | null {
    return this.latest ?? this.inFlight;
  }

  /** Call on every edit with the full current text. */
  change(content: string) {
    if (this.disposed) return;
    this.latest = content;
    if (this.blocked) return;
    this.set('pending');
    this.schedule(this.opts.delayMs);
  }

  /** Save now (before leaving the file, renaming, rolling back...). Resolves when nothing is left to save or saving is blocked. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    await this.run();
  }

  /** After the page dealt with a conflict (loaded the new version number): continue saving what is waiting. */
  resume() {
    this.blocked = false;
    this.retryDelay = this.opts.retryMs ?? 3000;
    if (this.latest !== null) this.schedule(0);
  }

  /**
   * The page is going away and the unsaved text was sent by other means (a keepalive request): stop waiting for it,
   * but stay usable in case the browser brings the page back (back/forward cache).
   */
  handOver() {
    clearTimeout(this.timer);
    this.latest = null;
    this.inFlight = null;
  }

  /** Forget everything and never save again (file closed). Call flush() first if the text matters. */
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.latest = null;
    this.inFlight = null;
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), ms);
  }

  private async run(): Promise<void> {
    if (this.running) { await this.running; if (this.latest === null || this.blocked) return; }
    if (this.disposed || this.blocked || this.latest === null) return;
    this.running = this.loop().finally(() => { this.running = null; });
    await this.running;
  }

  private async loop(): Promise<void> {
    while (this.latest !== null && !this.blocked && !this.disposed) {
      const content = this.latest;
      this.latest = null;
      this.inFlight = content;
      this.set('saving');
      try {
        await this.opts.save(content);
        this.inFlight = null;
        this.retryDelay = this.opts.retryMs ?? 3000;
        if (this.latest === null) this.set('saved');
      } catch (e) {
        this.inFlight = null;
        const err = e instanceof ApiError ? e : new ApiError(0, 'network', String(e));
        if (this.latest === null) this.latest = content; // keep the text: nothing was saved
        if (err.code === 'version_conflict') { this.blocked = true; this.set('conflict', err); return; }
        if (err.code === 'too_large') { this.latest = null; this.set('toobig', err); return; } // wait for the next edit
        if (err.status === 0 || err.status >= 500 || err.status === 429) {
          this.set('error', err);
          this.schedule(err.retryAfter ? err.retryAfter * 1000 : this.retryDelay);
          this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
          return;
        }
        this.blocked = true; // 401 / 403 / 404 ...: the page must decide
        this.set('error', err);
        return;
      }
    }
  }
}
