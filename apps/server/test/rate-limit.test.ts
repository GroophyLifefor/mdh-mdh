import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate-limit';
import { makeClock } from './helpers';

describe('RateLimiter', () => {
  it('blocks after max events and reports when to retry', () => {
    const c = makeClock();
    const rl = new RateLimiter(3, 60_000, c.now);
    for (let i = 0; i < 3; i++) { expect(rl.isLimited('a')).toBe(false); rl.hit('a'); }
    expect(rl.isLimited('a')).toBe(true);
    expect(rl.retryAfterSeconds('a')).toBe(60);
    c.advance(20_000);
    expect(rl.retryAfterSeconds('a')).toBe(40);
  });
  it('lets traffic through again once the window has passed', () => {
    const c = makeClock();
    const rl = new RateLimiter(2, 60_000, c.now);
    rl.hit('a'); rl.hit('a');
    expect(rl.isLimited('a')).toBe(true);
    c.advance(60_001);
    expect(rl.isLimited('a')).toBe(false);
  });
  it('is a sliding window, not a fixed bucket', () => {
    const c = makeClock();
    const rl = new RateLimiter(2, 60_000, c.now);
    rl.hit('a'); c.advance(40_000); rl.hit('a');
    expect(rl.isLimited('a')).toBe(true);
    c.advance(30_000); // the first hit (70 s ago) is out, the second (30 s ago) is in
    expect(rl.isLimited('a')).toBe(false);
  });
  it('keeps keys apart and clear() resets one key', () => {
    const c = makeClock();
    const rl = new RateLimiter(1, 60_000, c.now);
    rl.hit('a');
    expect(rl.isLimited('a')).toBe(true);
    expect(rl.isLimited('b')).toBe(false);
    rl.clear('a');
    expect(rl.isLimited('a')).toBe(false);
  });
  it('retryAfterSeconds is 0 for an unknown key', () => {
    expect(new RateLimiter(1, 1000, makeClock().now).retryAfterSeconds('x')).toBe(0);
  });
});
