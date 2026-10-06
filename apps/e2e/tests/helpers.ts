import { expect, test as base, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';

export { expect };
let client = 0;
/**
 * Every test comes from its own "client address" (the server runs with TRUST_PROXY), so the per-IP limits on
 * sign-ups and wrong passwords never add up across tests. Production code is unchanged: no test-only setting.
 */
export const test = base.extend({
  context: async ({ browser, contextOptions }, use, testInfo) => {
    const n = ++client + testInfo.workerIndex * 100_000 + (Date.now() % 100_000) * 7;
    const ctx = await browser.newContext({ ...contextOptions, extraHTTPHeaders: { 'X-Forwarded-For': `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}` } });
    await use(ctx);
    await ctx.close();
  },
});

/** Opens the history panel (it starts closed). On a phone it is a tab. */
export async function showHistory(page: Page) {
  if (await page.locator('#tabbar').isVisible()) { await page.locator('#tabbar [data-tab="history"]').click(); return; }
  if (!(await page.locator('aside.hist').isVisible())) await page.locator('#toggle-hist').click();
  await expect(page.locator('aside.hist')).toBeVisible();
}

let n = 0;
/** A username nobody used yet (tests share one database). */
export const uniqueName = (prefix = 'user') => `${prefix}${Date.now().toString(36).slice(-6)}${(++n).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const PASSWORD = 'longenough';

/** Registers through the UI and lands on the (empty) project list. */
export async function register(page: Page, username = uniqueName()) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.locator('#au-user').fill(username);
  await page.locator('#au-pass').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  return username;
}

/** Creates a project through the UI. Lands on its page with readme.md open. Returns the project id. */
export async function createProject(page: Page, name: string) {
  await page.getByRole('button', { name: 'New project' }).click();
  await page.locator('#np-name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
  await expect(page.locator('#bar .name')).toHaveText('readme.md');
  return page.url().split('/p/')[1]!;
}

export async function registerAndCreate(page: Page, projectName = 'My notes') {
  const username = await register(page);
  const id = await createProject(page, projectName);
  return { username, id };
}

/** Passwords of a project, read through the page's own session (the owner). */
export async function passwordsOf(page: Page, id: string) {
  return page.evaluate(async (pid) => (await fetch(`/api/projects/${pid}/passwords`)).json() as Promise<{ ro: string; rw: string }>, id);
}

/** A second person: a browser with its own cookies (nobody is signed in). */
export async function stranger(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1300, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': `10.250.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });
  return { context, page: await context.newPage() };
}

/** What an AI agent does: plain HTTP with a Bearer password, no browser, no cookies. */
export function agent(request: APIRequestContext, id: string, password: string, name = 'e2e-agent') {
  const headers = { Authorization: `Bearer ${password}`, 'X-Actor-Name': name };
  const base = `/api/projects/${id}`;
  return {
    get: (path: string) => request.get(`${base}${path}`, { headers }),
    put: (path: string, data: unknown) => request.put(`${base}${path}`, { headers, data }),
    post: (path: string, data?: unknown) => request.post(`${base}${path}`, { headers, data }),
    del: (path: string) => request.delete(`${base}${path}`, { headers }),
  };
}

export const treeItem = (page: Page, path: string) => page.locator(`#tree .node[data-path="${path}"]`);

/** Click the NAME of a tree entry, like a person does (the middle of a row can be covered by its hover buttons). */
export const clickItem = (page: Page, path: string, opts?: { timeout?: number }) => treeItem(page, path).locator('.label').click(opts);

/** Types into the open editor (CodeMirror). */
export async function typeInEditor(page: Page, text: string, opts: { replace?: boolean } = {}) {
  await page.locator('.cm-content').click();
  if (opts.replace) await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}

/** Collects Content-Security-Policy violations and page errors while a test runs. */
export function watchProblems(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy|violat/i.test(m.text())) problems.push('CSP: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('page error: ' + e.message));
  return problems;
}
