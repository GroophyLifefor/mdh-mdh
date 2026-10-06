import { expect, test, agent, passwordsOf, registerAndCreate, stranger, treeItem, watchProblems, clickItem } from './helpers';

const EVIL = [
  '<img src=x onerror=window.__pwned=1>', '"><svg onload=window.__pwned=2>', "<script>window.__pwned=3</script>", '<iframe src="javascript:window.__pwned=4">',
];

test.describe('hostile content stays text', () => {
  test('file names, folder names, change summaries, author names and markdown never run code', async ({ page, request }) => {
    const problems = watchProblems(page);
    page.on('dialog', (d) => { problems.push('unexpected dialog: ' + d.message()); void d.dismiss(); });
    const { id } = await registerAndCreate(page);
    const { rw } = await passwordsOf(page, id);
    const bot = agent(request, id, rw, EVIL[0]);                                          // even the author name is hostile

    await bot.post('/files', { path: `${EVIL[0]}.md`, kind: 'file', content: `# ${EVIL[2]}\n\n${EVIL[0]}\n\n[x](javascript:window.__pwned=5)\n\n![x](https://evil.example/p.png)\n\n\`\`\`html\n${EVIL[3]}\n\`\`\`` });
    await bot.post('/files', { path: `${EVIL[1]}/inner.md`, kind: 'file' });
    await expect(page.locator('#history .change').first()).toContainText('created', { timeout: 20_000 });

    await clickItem(page, `${EVIL[0]}.md`);
    await expect(page.locator('#preview h1')).toBeVisible();
    await expect(page.locator('#preview a')).toHaveCount(0);                              // the javascript: link became plain text

    const dangerous = 'img, script, iframe, [onerror], [onload], [onclick]';
    for (const area of ['#tree', '#history', '#preview', 'header', '#bar']) expect(await page.locator(`${area} :is(${dangerous})`).count(), area).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(problems).toEqual([]);

    // the project list and the share dialog too
    await page.goto('/');
    await page.getByRole('button', { name: 'New project' }).click();
    await page.locator('#np-name').fill(EVIL[0]);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/p\//);
    await page.goto('/');
    await expect(page.locator('#project-list .name').first()).toHaveText(EVIL[0]);
    expect(await page.locator(`#project-list :is(${dangerous})`).count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(problems).toEqual([]);
  });
});

test.describe('the production safety net', () => {
  test('pages come with a strict Content-Security-Policy that blocks inline scripts the server did not vouch for', async ({ page }) => {
    const res = await page.goto('/');
    const h = res!.headers();
    expect(h['content-security-policy']).toContain("script-src 'self' 'sha256-");
    expect(h['content-security-policy']).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['x-content-type-options']).toBe('nosniff');

    const violation = page.evaluate(() => new Promise<string>((ok) => {
      document.addEventListener('securitypolicyviolation', (e) => ok(e.violatedDirective));
      const s = document.createElement('script'); s.textContent = 'window.__injected = true'; document.body.appendChild(s);
      setTimeout(() => ok('none'), 2000);
    }));
    expect(await violation).toContain('script-src');
    expect(await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected)).toBeUndefined();
  });

  test('the API is not cached and refuses writes that come from another site', async ({ request, page }) => {
    const health = await request.get('/api/health');
    expect(health.headers()['cache-control']).toBe('no-store');
    await page.goto('/');
    const res = await request.post('/api/auth/login', { headers: { Origin: 'https://evil.example' }, data: { username: 'x', password: 'y' } });
    expect(res.status()).toBe(403);
  });

  test('the session cookie cannot be read by scripts and is not sent along with cross-site requests', async ({ page, context }) => {
    await registerAndCreate(page);
    expect(await page.evaluate(() => document.cookie)).not.toContain('mdh_session');
    const c = (await context.cookies()).find((x) => x.name === 'mdh_session')!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  });

  test('a visitor with an edit password cannot reach owner-only functions', async ({ page, browser }) => {
    const { id } = await registerAndCreate(page);
    const { rw } = await passwordsOf(page, id);
    const { context, page: guest } = await stranger(browser);
    await guest.goto(`/p/${id}`);
    await guest.locator('#gate-pw').fill(rw);
    await guest.getByRole('button', { name: 'Open' }).click();
    await expect(guest.locator('#rights')).toHaveText('can edit');
    for (const [method, path] of [['get', 'passwords'], ['post', 'passwords/rw/refresh']] as const) {
      const r = await context.request[method](`/api/projects/${id}/${path}`);
      expect(r.status(), path).toBe(403);
    }
    expect((await context.request.delete(`/api/projects/${id}`)).status()).toBe(403);
    expect((await context.request.patch(`/api/projects/${id}`, { data: { rollbackPolicy: 'author_only' } })).status()).toBe(403);
    expect((await context.request.get('/api/projects')).status()).toBe(401);                 // not an account holder
    await context.close();
  });

  test('llm.txt is served as plain text and explains the Bearer password', async ({ request }) => {
    const res = await request.get('/llm.txt');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^text\/plain/);
    expect(await res.text()).toContain('Authorization: Bearer <password>');
  });

  test('files that are not part of the site are never served', async ({ request }) => {
    for (const path of ['/.env', '/package.json', '/%2e%2e/%2e%2e/etc/passwd', '/_astro/../../server/dist/index.js']) {
      const res = await request.get(path);
      expect(res.status(), path).toBeGreaterThanOrEqual(400);
    }
  });
});
