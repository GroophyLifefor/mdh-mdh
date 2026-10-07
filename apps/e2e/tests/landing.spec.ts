// The landing page: what a visitor who is not signed in sees.
import { expect, register, test } from './helpers';

const DESCRIPTION = 'A workspace for you and your AI agents. Markdown and YAML in one place, every change kept, anything can be rolled back.';

test.describe('landing page', () => {
  test('says what it is, calls itself mdh-mdh and nothing else, and has one top heading', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#landing')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Your workspace,\s*shared with your agents\./);
    expect(await page.title()).toBe('mdh-mdh: a workspace for you and your agents');
    const text = (await page.locator('body').textContent()) ?? '';
    expect(text).not.toMatch(/Miracles|Dreams/i);                                          // only the name mdh-mdh
    expect(text).toContain('mdh-mdh');
    for (const word of ['Claude Code', 'Codex', 'Gemini', 'Markdown', 'YAML', 'roll back', 'Self-hosting']) expect(text, word).toContain(word);
    expect(await page.locator('h2').count()).toBeGreaterThanOrEqual(7);
  });

  test('the link card text matches (what chat apps show for the home address)', async ({ page }) => {
    const html = await (await page.request.get('/')).text();
    expect(html).toContain(`<meta name="description" content="${DESCRIPTION}">`);
    expect(html).toContain('property="og:title" content="mdh-mdh"');
    expect(html).not.toMatch(/Miracles/i);
  });

  test('every picture has a description, loads when it is needed, and only the one for the current theme is fetched', async ({ page }) => {
    const fetched: string[] = [];
    page.on('response', (r) => { if (/\/landing\/.*\.jpg$/.test(r.url())) fetched.push(r.url().split('/landing/')[1]!); });
    await page.goto('/');
    await expect(page.locator('#landing')).toBeVisible();
    await page.waitForTimeout(400);
    expect(fetched.filter((f) => f.includes('-dark')), 'light theme: no dark picture').toEqual([]);
    expect(fetched.some((f) => f.startsWith('app-light'))).toBe(true);                    // the first one is there at once
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 100)); } });
    await page.waitForTimeout(500);
    expect(fetched.filter((f) => f.includes('-dark'))).toEqual([]);
    const shown = page.locator('img.shot.only-light');
    expect(await shown.count()).toBeGreaterThanOrEqual(6);
    for (const img of await shown.all()) {
      expect(await img.getAttribute('alt'), 'alt text').toBeTruthy();
      expect(await img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0), `${await img.getAttribute('src')} loaded`).toBe(true);
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; window.scrollTo(0, 0); });   // the other theme: now the dark ones are used
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 100)); } });
    await page.waitForTimeout(500);
    for (const img of await page.locator('img.shot.only-dark').all()) expect(await img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(true);
    await expect(page.locator('img.shot.only-light').first()).toBeHidden();
  });

  test('the first screen is light: the pictures fetched before scrolling stay small', async ({ page }) => {
    let bytes = 0;
    page.on('response', async (r) => { if (/\/landing\//.test(r.url())) bytes += (await r.body().catch(() => Buffer.alloc(0))).length; });
    await page.goto('/');
    await expect(page.locator('#landing')).toBeVisible();
    await page.waitForTimeout(800);
    expect(bytes, 'picture bytes before any scrolling').toBeLessThan(600_000);
  });

  test('all three "Get started" buttons open the sign-up form; "Log in" opens the other tab', async ({ page }) => {
    await page.goto('/');
    for (const sel of ['#start-btn', '#landing-btn', '#landing-btn-2']) {
      await page.locator(sel).scrollIntoViewIfNeeded();
      await page.locator(sel).click();
      await expect(page.locator('#auth-dlg')).toBeVisible();
      await expect(page.locator('#au-submit')).toHaveText('Create account');
      await page.keyboard.press('Escape');
      await expect(page.locator('#auth-dlg')).toBeHidden();
    }
    await page.locator('#login-btn').click();
    await expect(page.locator('#au-submit')).toHaveText('Log in');
  });

  test('the menu links scroll to their sections', async ({ page }) => {
    await page.goto('/');
    for (const [label, id] of [['Agents', 'agents'], ['History', 'history'], ['How it works', 'how'], ['FAQ', 'faq']] as const) {
      await page.locator('.top-links').getByRole('link', { name: label }).click();
      await expect.poll(async () => await page.locator(`#${id}`).evaluate((e) => Math.round(e.getBoundingClientRect().top))).toBeLessThan(160);
      expect(await page.locator(`#${id}`).evaluate((e) => e.getBoundingClientRect().top)).toBeGreaterThan(-40);
    }
  });

  test('the questions open and close, and the agent guide link works', async ({ page }) => {
    await page.goto('/');
    const first = page.locator('.l-faq details').first();
    await first.scrollIntoViewIfNeeded();
    await expect(first).not.toHaveAttribute('open', '');
    await first.locator('summary').click();
    await expect(first).toHaveAttribute('open', '');
    await first.locator('summary').click();
    await expect(first).not.toHaveAttribute('open', '');
    expect(await page.locator('.l-faq details', { hasText: 'Which agents' }).locator('a[href="/llm.txt"]').count()).toBe(1);
    expect((await page.request.get('/llm.txt')).status()).toBe(200);
    expect(await page.locator('.l-foot a[href^="https://github.com/"]').getAttribute('rel')).toContain('noopener');
  });

  test('nothing sticks out sideways', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#landing')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('a signed-in person gets the project list, not the landing page', async ({ page }) => {
    await register(page);
    await expect(page.locator('#landing')).toBeHidden();
    await expect(page.locator('.top-links')).toBeHidden();
    await expect(page.locator('#start-btn')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  });
});
