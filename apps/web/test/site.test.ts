import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetSiteUrl, siteUrl } from '../src/lib/site';

beforeEach(() => forgetSiteUrl());
afterEach(() => vi.unstubAllGlobals());
const answer = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })));

describe('siteUrl', () => {
  it('uses PUBLIC_DOMAIN when the server has one', async () => {
    answer(200, { publicUrl: 'https://mdh.example.com' });
    expect(await siteUrl()).toBe('https://mdh.example.com');
  });
  it('falls back to the address of the tab when it has none', async () => {
    answer(200, { publicUrl: null });
    expect(await siteUrl()).toBe(location.origin);
  });
  it.each([['an error status', 500, { publicUrl: 'https://x.example' }], ['not JSON', 200, '<html>'], ['a wrong type', 200, { publicUrl: 5 }], ['an empty string', 200, { publicUrl: '' }], ['no field', 200, {}]])('falls back on %s', async (_n, status, body) => {
    answer(status, body);
    expect(await siteUrl()).toBe(location.origin);
  });
  it('falls back when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await siteUrl()).toBe(location.origin);
  });
  it('asks only once per page', async () => {
    answer(200, { publicUrl: 'https://mdh.example.com' });
    await siteUrl(); await siteUrl(); await siteUrl();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
