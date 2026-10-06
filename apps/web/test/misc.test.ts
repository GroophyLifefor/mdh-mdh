import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import { explain, lostAccess } from '../src/lib/errors';
import { sharePrompt } from '../src/lib/share';

describe('explain', () => {
  it('passes the server message through for people-facing errors', () => {
    expect(explain(new ApiError(409, 'username_taken', 'That username is taken'))).toBe('That username is taken');
    expect(explain(new ApiError(429, 'too_many_requests', 'Too many attempts. Try again in 30 seconds.'))).toBe('Too many attempts. Try again in 30 seconds.');
    expect(explain(new ApiError(0, 'network', "Can't reach the server. Check your connection."))).toBe("Can't reach the server. Check your connection.");
  });
  it('never shows server internals for a 5xx', () => {
    expect(explain(new ApiError(500, 'internal', 'SELECT * FROM secrets failed at line 3'))).toBe('The server had a problem. Try again in a moment.');
    expect(explain(new ApiError(502, 'http_502', 'The server answered 502'))).not.toContain('502');
  });
  it('has an answer for anything else', () => {
    expect(explain(new TypeError('x'))).toBe('Something went wrong.');
    expect(explain(undefined)).toBe('Something went wrong.');
  });
});

describe('lostAccess', () => {
  it('is true only when the server says the password is missing or no longer valid', () => {
    expect(lostAccess(new ApiError(401, 'password_required', ''))).toBe(true);
    expect(lostAccess(new ApiError(401, 'invalid_token', ''))).toBe(true);
    expect(lostAccess(new ApiError(401, 'unauthorized', ''))).toBe(false);   // not signed in: a different problem
    expect(lostAccess(new ApiError(403, 'read_only', ''))).toBe(false);
    expect(lostAccess(new ApiError(0, 'network', ''))).toBe(false);
    expect(lostAccess(new Error('x'))).toBe(false);
  });
});

describe('sharePrompt', () => {
  const base = { origin: 'https://mdh.example.com', projectId: '0197-abc', password: 'rw_SECRET' };
  it('tells an agent to read llm.txt, then use the password right away', () => {
    const t = sharePrompt({ ...base, mode: 'rw' });
    expect(t).toContain('Step 1. Read https://mdh.example.com/llm.txt');
    expect(t).toContain('Authorization: Bearer rw_SECRET');
    expect(t).toContain('Step 3.');
    expect(t).toContain('so only change what the task needs');
    expect(t).toContain('(For humans) Project page: https://mdh.example.com/p/0197-abc');
  });
  it('a view-only prompt says it is read only and does not invite changes', () => {
    const t = sharePrompt({ ...base, mode: 'ro', password: 'ro_SECRET' });
    expect(t).toContain('This password is read only.');
    expect(t).not.toContain('only change what the task needs');
    expect(t).toContain('Bearer ro_SECRET');
  });
  it('mentions the password only where it is needed (once, in the header line)', () => {
    expect(sharePrompt({ ...base, mode: 'rw' }).split('rw_SECRET').length - 1).toBe(1);
  });
});
