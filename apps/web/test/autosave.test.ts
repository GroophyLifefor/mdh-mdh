import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { ApiError } from '../src/lib/api';
import { Autosave, type SaveState } from '../src/lib/autosave';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** A server that records what it was given, can be slow, and can be told to fail. */
function setup(opts: { delayMs?: number; retryMs?: number } = {}) {
  const saved: string[] = [];
  const states: SaveState[] = [];
  let inFlight = 0, maxInFlight = 0;
  let gate: (() => void) | null = null;       // when set, save() waits for it
  let failWith: ApiError | null = null;
  const server = {
    save: vi.fn(async (c: string) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (gate !== null) await new Promise<void>((r) => { const prev = gate; gate = () => { prev?.(); r(); }; });
        if (failWith) throw failWith;
        saved.push(c);
      } finally { inFlight--; }
    }),
  };
  const auto = new Autosave({ delayMs: opts.delayMs ?? 1000, retryMs: opts.retryMs, save: server.save, onState: (s) => states.push(s) });
  return {
    auto, saved, states, server,
    maxInFlight: () => maxInFlight,
    slow: () => { gate = () => {}; },
    release: () => { const g = gate; gate = null; g?.(); },
    fail: (e: ApiError | null) => { failWith = e; },
  };
}
const err = (status: number, code: string, retryAfter?: number) => new ApiError(status, code, code, undefined, retryAfter);

describe('timing', () => {
  it('waits for typing to stop: many edits inside the delay make ONE save with the newest text', async () => {
    const t = setup();
    t.auto.change('a'); await vi.advanceTimersByTimeAsync(400);
    t.auto.change('ab'); await vi.advanceTimersByTimeAsync(400);
    t.auto.change('abc'); await vi.advanceTimersByTimeAsync(999);
    expect(t.saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.saved).toEqual(['abc']);
  });
  it('goes pending, saving, saved', async () => {
    const t = setup();
    t.auto.change('x');
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.states).toEqual(['pending', 'saving', 'saved']);
    expect(t.auto.hasUnsaved).toBe(false);
  });
  it('saves again after a pause, each time the text changed', async () => {
    const t = setup();
    t.auto.change('one'); await vi.advanceTimersByTimeAsync(1000);
    t.auto.change('two'); await vi.advanceTimersByTimeAsync(1000);
    expect(t.saved).toEqual(['one', 'two']);
  });
  it('reports unsaved text while waiting', () => {
    const t = setup();
    expect(t.auto.hasUnsaved).toBe(false);
    t.auto.change('x');
    expect(t.auto.hasUnsaved).toBe(true);
  });
});

describe('flush', () => {
  it('saves right now and resolves after the save', async () => {
    const t = setup();
    t.auto.change('now');
    await t.auto.flush();
    expect(t.saved).toEqual(['now']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.saved).toEqual(['now']); // the timer did not save a second time
  });
  it('does nothing when there is nothing to save', async () => {
    const t = setup();
    await t.auto.flush();
    t.auto.change('x'); await vi.advanceTimersByTimeAsync(1000);
    await t.auto.flush();
    expect(t.saved).toEqual(['x']);
  });
  it('waits for a save that is already running, then saves newer text', async () => {
    const t = setup();
    t.slow();
    t.auto.change('first');
    await vi.advanceTimersByTimeAsync(1000);      // first save starts and hangs
    t.auto.change('second');
    const flushed = t.auto.flush();
    t.release();
    await flushed;
    expect(t.saved).toEqual(['first', 'second']);
    expect(t.maxInFlight()).toBe(1);
  });
});

describe('never loses text and never overlaps', () => {
  it('text typed during a save is saved right after it', async () => {
    const t = setup();
    t.slow();
    t.auto.change('a');
    await vi.advanceTimersByTimeAsync(1000);
    t.auto.change('ab'); t.auto.change('abc');
    t.release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.saved).toEqual(['a', 'abc']);
    expect(t.maxInFlight()).toBe(1);
  });
  it('property: whatever is typed and however the server fails, the last text reaches the server and saves never overlap', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.oneof(
        fc.record({ k: fc.constant('type' as const), text: fc.string({ maxLength: 6 }) }),
        fc.record({ k: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 4000 }) }),
        fc.record({ k: fc.constant('fail' as const), on: fc.boolean() }),
        fc.record({ k: fc.constant('flush' as const) }),
      ), { minLength: 1, maxLength: 25 }),
      async (steps) => {
        const t = setup({ retryMs: 500 });
        let last: string | null = null;
        for (const s of steps) {
          if (s.k === 'type') { t.auto.change(s.text); last = s.text; }
          else if (s.k === 'wait') await vi.advanceTimersByTimeAsync(s.ms);
          else if (s.k === 'fail') t.fail(s.on ? err(503, 'unavailable') : null);
          else await Promise.race([t.auto.flush(), vi.advanceTimersByTimeAsync(0)]);
        }
        t.fail(null);                       // the server recovers
        await vi.advanceTimersByTimeAsync(60_000);
        await t.auto.flush();
        expect(t.maxInFlight()).toBeLessThanOrEqual(1);
        if (last !== null) expect(t.saved.at(-1)).toBe(last);
        expect(t.auto.hasUnsaved).toBe(false);
        t.auto.dispose();
      },
    ), { numRuns: 80 });
  });
});

describe('when the server says no', () => {
  it('a version conflict stops saving, keeps the text, and resume() carries on', async () => {
    const t = setup();
    t.fail(err(409, 'version_conflict'));
    t.auto.change('mine'); await vi.advanceTimersByTimeAsync(1000);
    expect(t.auto.state).toBe('conflict');
    expect(t.auto.hasUnsaved).toBe(true);
    t.auto.change('mine, longer'); await vi.advanceTimersByTimeAsync(10_000);
    expect(t.server.save).toHaveBeenCalledTimes(1);   // blocked: no hammering
    t.fail(null);
    t.auto.resume();
    await vi.advanceTimersByTimeAsync(10);
    expect(t.saved).toEqual(['mine, longer']);
    expect(t.auto.state).toBe('saved');
  });
  it('reports the conflict error to the page', async () => {
    const seen: (ApiError | undefined)[] = [];
    const auto = new Autosave({ delayMs: 10, save: async () => { throw err(409, 'version_conflict'); }, onState: (_s, e) => seen.push(e) });
    auto.change('x'); await vi.advanceTimersByTimeAsync(10);
    expect(seen.at(-1)?.code).toBe('version_conflict');
  });
  it('a file that is too large reports it, does not retry, and saves again after the next edit', async () => {
    const t = setup();
    t.fail(err(400, 'too_large'));
    t.auto.change('huge'); await vi.advanceTimersByTimeAsync(1000);
    expect(t.auto.state).toBe('toobig');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.server.save).toHaveBeenCalledTimes(1);
    t.fail(null);
    t.auto.change('small'); await vi.advanceTimersByTimeAsync(1000);
    expect(t.saved).toEqual(['small']);
  });
  it('a network failure is retried with a growing wait (0.5 s, 1 s, 2 s...) and the text survives', async () => {
    const t = setup({ retryMs: 500 });
    t.fail(err(0, 'network'));
    t.auto.change('keep me'); await vi.advanceTimersByTimeAsync(1000);
    expect(t.auto.state).toBe('error');
    expect(t.server.save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500); expect(t.server.save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999); expect(t.server.save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(t.server.save).toHaveBeenCalledTimes(3);
    t.fail(null);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.saved).toEqual(['keep me']);
    expect(t.auto.state).toBe('saved');
  });
  it('the retry wait never grows past 30 seconds', async () => {
    const t = setup({ retryMs: 10_000 });
    t.fail(err(503, 'unavailable'));
    t.auto.change('x'); await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(10_000);   // retry 1 after 10 s
    await vi.advanceTimersByTimeAsync(20_000);   // retry 2 after 20 s
    const n = t.server.save.mock.calls.length;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(t.server.save.mock.calls.length).toBe(n);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.server.save.mock.calls.length).toBe(n + 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.server.save.mock.calls.length).toBe(n + 2);  // 30 s again, not 60
  });
  it('obeys Retry-After on a 429', async () => {
    const t = setup({ retryMs: 500 });
    t.fail(err(429, 'too_many_requests', 12));
    t.auto.change('x'); await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(11_999); expect(t.server.save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(t.server.save).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 404])('a %i stops saving until the page decides (no retries)', async (status) => {
    const t = setup();
    t.fail(err(status, 'nope'));
    t.auto.change('x'); await vi.advanceTimersByTimeAsync(1000);
    expect(t.auto.state).toBe('error');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.server.save).toHaveBeenCalledTimes(1);
    expect(t.auto.hasUnsaved).toBe(true);
  });
  it('a thrown non-ApiError counts as a network problem', async () => {
    const states: SaveState[] = [];
    let n = 0;
    const auto = new Autosave({ delayMs: 10, retryMs: 100, save: async () => { if (n++ === 0) throw new Error('boom'); }, onState: (s) => states.push(s) });
    auto.change('x'); await vi.advanceTimersByTimeAsync(10);
    expect(states).toContain('error');
    await vi.advanceTimersByTimeAsync(100);
    expect(auto.state).toBe('saved');
  });
});

describe('unsavedText and handOver (closing the tab)', () => {
  it('unsavedText is the newest text the server may not have: waiting, or being saved right now', async () => {
    const t = setup();
    expect(t.auto.unsavedText).toBeNull();
    t.auto.change('waiting');
    expect(t.auto.unsavedText).toBe('waiting');
    t.slow();
    await vi.advanceTimersByTimeAsync(1000);          // the save starts and hangs
    expect(t.auto.unsavedText).toBe('waiting');       // still not confirmed by the server
    t.auto.change('newer');
    expect(t.auto.unsavedText).toBe('newer');
    t.release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.auto.unsavedText).toBeNull();
  });
  it('a failed save keeps its text as unsaved', async () => {
    const t = setup({ retryMs: 100000 });
    t.fail(err(503, 'unavailable'));
    t.auto.change('keep'); await vi.advanceTimersByTimeAsync(1000);
    expect(t.auto.unsavedText).toBe('keep');
  });
  it('handOver stops waiting for the text (it was sent another way) and cancels the pending save', async () => {
    const t = setup();
    t.auto.change('sent elsewhere');
    t.auto.handOver();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.saved).toEqual([]);
    expect(t.auto.unsavedText).toBeNull();
    expect(t.auto.hasUnsaved).toBe(false);
  });
  it('after handOver the autosave still works if the page comes back', async () => {
    const t = setup();
    t.auto.change('a'); t.auto.handOver();
    t.auto.change('back again'); await vi.advanceTimersByTimeAsync(1000);
    expect(t.saved).toEqual(['back again']);
  });
});

describe('dispose', () => {
  it('cancels a pending save and ignores later edits', async () => {
    const t = setup();
    t.auto.change('never');
    t.auto.dispose();
    t.auto.change('also never');
    await vi.advanceTimersByTimeAsync(10_000);
    await t.auto.flush();
    expect(t.saved).toEqual([]);
  });
});
