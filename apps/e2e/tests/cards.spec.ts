// Link cards: what chat apps see when a link is pasted (they fetch the page without cookies), the logo, the gate.
import { expect, test, passwordsOf, registerAndCreate, stranger, createProject, register } from './helpers';

const meta = (html: string, key: string) => html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`))?.[1];

test.describe('link cards and logo', () => {
  test('a project link, fetched like a chat app does (no cookie), shows its name and a picture, and nothing from inside', async ({ page, browser }) => {
    const base = process.env.E2E_PUBLIC_URL!;
    const { id } = await registerAndCreate(page, 'Roadmap <2026> & "friends"');
    const { context, page: bot } = await stranger(browser);
    const res = await bot.request.get(`/p/${id}`);
    const html = await res.text();
    expect(res.status()).toBe(200);
    expect(meta(html, 'og:title')).toBe('Roadmap &lt;2026&gt; &amp; &quot;friends&quot; · mdh-mdh');
    expect(html).not.toContain('Roadmap <2026>');                                       // never raw
    expect(meta(html, 'og:image')).toBe(`${base}/og/${id}.png`);
    expect(meta(html, 'og:url')).toBe(`${base}/p/${id}`);
    expect(meta(html, 'twitter:card')).toBe('summary_large_image');
    expect(meta(html, 'robots')).toBe('noindex, nofollow');
    expect(html).not.toContain('readme.md');                                            // no file names, no content
    const pw = await passwordsOf(page, id);
    expect(html).not.toContain(pw.ro); expect(html).not.toContain(pw.rw);

    const img = await bot.request.get(`/og/${id}.png`);
    expect(img.status()).toBe(200);
    expect(img.headers()['content-type']).toBe('image/png');
    const bytes = await img.body();
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
    expect((await bot.request.get('/og/default.png')).status()).toBe(200);
    expect((await bot.request.get('/og/0197abcd-1234-7000-8000-000000000000.png')).status()).toBe(404);
    await context.close();
  });

  test('the home page and every page link the icons; the favicon files exist', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('link[rel=icon]')).toHaveAttribute('href', '/favicon.svg');
    await expect(page.locator('link[rel=apple-touch-icon]')).toHaveAttribute('href', '/apple-touch-icon.png');
    expect(await page.locator('meta[property="og:image"]').getAttribute('content')).toBe(`${process.env.E2E_PUBLIC_URL}/og/default.png`);
    for (const f of ['/favicon.svg', '/apple-touch-icon.png']) expect((await page.request.get(f)).status(), f).toBe(200);
    await expect(page.locator('.crumb a.brand svg.logo')).toBeVisible();
  });

  test('the logo mark follows the theme (visible in dark mode too)', async ({ page }) => {
    await register(page);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((th) => { document.documentElement.dataset.theme = th; }, theme);
      const color = await page.locator('.crumb a.brand').evaluate((e) => getComputedStyle(e).color);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(color, theme).not.toBe(bg);
    }
  });

  test('the password gate names the project it is asking about', async ({ page, browser }) => {
    const { id } = await registerAndCreate(page, 'Quiet garden');
    const { context, page: guest } = await stranger(browser);
    await guest.goto(`/p/${id}`);
    await expect(guest.locator('#gate-dlg')).toBeVisible();
    await expect(guest.locator('#gate-proj')).toHaveText('Quiet garden');
    await expect(guest.locator('#tree')).not.toContainText('readme.md');                // still nothing from inside
    await context.close();
  });
});
