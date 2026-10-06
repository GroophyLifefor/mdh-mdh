import { expect, test, agent, passwordsOf, registerAndCreate, showHistory, stranger, treeItem, typeInEditor, watchProblems, clickItem } from './helpers';

const POLL = 20_000; // the page looks for other people's changes every 10 s

test.describe('sharing and working together', () => {
  test('Share shows a link, the password and a ready prompt for an AI, for both levels', async ({ page }) => {
    const base = process.env.E2E_PUBLIC_URL!;         // PUBLIC_DOMAIN of the test server: not the address the browser uses
    const { id } = await registerAndCreate(page);
    expect(page.url().startsWith(base)).toBe(false);
    await page.getByRole('button', { name: 'Share' }).click();
    await expect(page.locator('#sh-url')).toHaveValue(`${base}/p/${id}`);
    const rw = await page.locator('#sh-pw').inputValue();
    expect(rw).toMatch(/^rw_[A-Za-z0-9]{24}$/);
    const prompt = page.locator('#sh-prompt');
    await expect(prompt).toHaveValue(new RegExp(`Step 1\\. Read ${base}/llm\\.txt`));
    await expect(prompt).toHaveValue(new RegExp(`Authorization: Bearer ${rw}`));
    for (const id of ['#sh-url', '#sh-prompt']) {                      // the boxes show ALL their text: nothing to scroll
      const { scroll, client } = await page.locator(id).evaluate((e) => ({ scroll: e.scrollHeight, client: e.clientHeight }));
      expect(scroll, `${id} needs no scrolling`).toBeLessThanOrEqual(client);
    }
    expect((await page.locator('#share-dlg').boundingBox())!.width).toBeGreaterThan(800);   // wide on a desktop
    const box = (await page.locator('#share-dlg').boundingBox())!;      // the dialog fits the window, so its buttons can be reached
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.getByRole('button', { name: 'Copy prompt' }).scrollIntoViewIfNeeded();   // reachable by scrolling the dialog
    await expect(page.getByRole('button', { name: 'Copy prompt' })).toBeInViewport();
    expect(await prompt.inputValue()).not.toMatch(/[a-z,]\n[a-z]/);          // no hard line breaks in the middle of a sentence
    await page.getByRole('button', { name: 'Can view' }).click();
    const ro = await page.locator('#sh-pw').inputValue();
    expect(ro).toMatch(/^ro_[A-Za-z0-9]{24}$/);
    await expect(prompt).toHaveValue(/This password is read only\./);
    await expect(page.locator('#sh-desc')).toContainText('Can’t change anything');
  });

  test('a visitor must pass the gate; a view-only password gives a read-only page', async ({ page, browser }) => {
    const { id } = await registerAndCreate(page, 'Shared notes');
    const pw = await passwordsOf(page, id);

    const { context, page: guest } = await stranger(browser);
    const problems = watchProblems(guest);
    await guest.goto(`/p/${id}`);
    await expect(guest.locator('#gate-dlg')).toBeVisible();
    await guest.keyboard.press('Escape');
    await expect(guest.locator('#gate-dlg')).toBeVisible();                       // it cannot be dismissed
    await expect(guest.locator('#tree')).not.toContainText('readme.md');           // and nothing is shown behind it

    await guest.locator('#gate-pw').fill('ro_wrongwrongwrongwrongwrong');
    await guest.getByRole('button', { name: 'Open' }).click();
    await expect(guest.locator('#gate-err')).toHaveText('Wrong password');
    await guest.locator('#gate-pw').fill(pw.ro);
    await guest.locator('#gate-name').fill('Kim');
    await guest.locator('#gate-pw').press('Enter');

    await expect(guest.locator('#rights')).toHaveText('can view');
    await expect(guest.locator('#proj-name')).toHaveText('Shared notes');
    for (const hidden of ['#share-btn', '#gear-btn', '#tree-tools', '#profile-btn']) await expect(guest.locator(hidden)).toBeHidden();
    await expect(guest.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await expect(guest.locator('#status')).toHaveText('read only');
    await expect(guest.locator('#tree .acts button')).toHaveCount(0);                       // no rename or delete; only the download link is there
    await expect(guest.locator('aside.hist')).toBeVisible();                                // viewers see the history without asking for it
    await expect(guest.locator('#history .change').first()).toBeVisible();
    await showHistory(guest);
    await guest.locator('#history .change').first().click();
    await expect(guest.getByRole('button', { name: /Rollback to/ })).toBeDisabled();
    expect(problems).toEqual([]);

    // the gate remembers: a reload goes straight in
    await guest.reload();
    await expect(guest.locator('#rights')).toHaveText('can view');
    await expect(guest.locator('#gate-dlg')).toBeHidden();
    await context.close();
  });

  test('an edit password lets a visitor change files, under their name; the owner sees it without reloading', async ({ page, browser }) => {
    const { id } = await registerAndCreate(page);
    const pw = await passwordsOf(page, id);
    const { context, page: guest } = await stranger(browser);
    await guest.goto(`/p/${id}`);
    await guest.locator('#gate-pw').fill(pw.rw);
    await guest.locator('#gate-name').fill('  Sam   Lee ');
    await guest.getByRole('button', { name: 'Open' }).click();
    await expect(guest.locator('#rights')).toHaveText('can edit');
    await expect(guest.locator('#share-btn')).toBeHidden();                        // only the owner shares

    await typeInEditor(guest, 'Written by a visitor.', { replace: true });
    await expect(guest.locator('#status')).toHaveText('Saved');
    await expect(guest.locator('#history .change').first()).toContainText('pw: Sam Lee');

    // the owner's page was open all along: the change shows up by itself
    await expect(page.locator('#history .change').first()).toContainText('pw: Sam Lee', { timeout: POLL });
    await expect(page.locator('.cm-content')).toContainText('Written by a visitor.', { timeout: POLL });
    await context.close();
  });

  test('an AI agent with only a password reads and writes; the owner sees its work appear', async ({ page, request }) => {
    const { id } = await registerAndCreate(page);
    const { rw, ro } = await passwordsOf(page, id);
    const bot = agent(request, id, rw, 'claude');

    const who = await request.get('/api/access', { headers: { Authorization: `Bearer ${rw}` } });
    expect(await who.json()).toMatchObject({ level: 'rw', project: { id } });

    const file = (await (await bot.get('/file?path=readme.md')).json()).file;
    expect((await bot.put('/file', { path: 'readme.md', content: '# Updated by an agent', baseVersion: file.version })).status()).toBe(200);
    expect((await bot.post('/upload', { files: [{ path: 'agent/notes.md', content: 'n' }, { path: 'agent/data.yml', content: 'a: 1' }], folders: ['agent/empty'] })).status()).toBe(200);

    await expect(page.locator('#history .change').first()).toContainText('uploaded 2 files', { timeout: POLL });
    await expect(page.locator('#history .change').first()).toContainText('pw: claude');
    await expect(treeItem(page, 'agent/notes.md')).toBeVisible();
    await expect(treeItem(page, 'agent/empty')).toBeVisible();
    await expect(page.locator('.cm-content')).toContainText('Updated by an agent');   // the open file was clean, so it refreshed

    // read-only really is read only
    const reader = agent(request, id, ro);
    expect((await reader.get('/tree')).status()).toBe(200);
    const denied = await reader.post('/files', { path: 'x.md', kind: 'file' });
    expect([denied.status(), (await denied.json()).error.code]).toEqual([403, 'read_only']);
  });

  test('when someone else saved the file you are typing in, nothing is overwritten until you choose', async ({ page, request }) => {
    const { id } = await registerAndCreate(page);
    const { rw } = await passwordsOf(page, id);
    const bot = agent(request, id, rw);
    await typeInEditor(page, 'MY TEXT', { replace: true });                          // not saved yet
    const f = (await (await bot.get('/file?path=readme.md')).json()).file;
    await bot.put('/file', { path: 'readme.md', content: 'THEIR TEXT', baseVersion: f.version });

    await expect(page.locator('#notice')).toContainText('Someone else changed this file');
    await expect.poll(async () => (await (await bot.get('/file?path=readme.md')).json()).file.content).toBe('THEIR TEXT');
    await expect(page.locator('.cm-content')).toContainText('MY TEXT');

    await page.getByRole('button', { name: 'Keep my version' }).click();
    await expect(page.locator('#notice')).toBeHidden();
    await expect(page.locator('#status')).toHaveText('Saved');
    expect((await (await bot.get('/file?path=readme.md')).json()).file.content).toBe('MY TEXT');
    // their version is not lost: it is in the history
    await showHistory(page);
    await expect(page.locator('#history .change', { hasText: 'edited readme.md' }).first()).toBeVisible();

    // and the other way round
    await typeInEditor(page, ' + more');
    const g = (await (await bot.get('/file?path=readme.md')).json()).file;
    await bot.put('/file', { path: 'readme.md', content: 'THEIRS AGAIN', baseVersion: g.version });
    await page.getByRole('button', { name: 'Load their version' }).click({ timeout: POLL });
    await expect(page.locator('.cm-content')).toContainText('THEIRS AGAIN');
    await expect(page.locator('#notice')).toBeHidden();
  });

  test('a file deleted by someone else: closed quietly when clean, offered back when you have text in it', async ({ page, request }) => {
    const { id } = await registerAndCreate(page);
    const { rw } = await passwordsOf(page, id);
    const bot = agent(request, id, rw);
    await bot.post('/files', { path: 'clean.md', kind: 'file', content: 'x' });
    await bot.post('/files', { path: 'dirty.md', kind: 'file', content: 'y' });

    await clickItem(page, 'clean.md', { timeout: POLL });
    await expect(page.locator('#bar .name')).toHaveText('clean.md');
    await bot.del('/file?path=clean.md');
    await expect(page.locator('#bar')).toContainText('No file open', { timeout: POLL });
    await expect(page.locator('#toast')).toContainText('deleted or renamed by someone else');

    await clickItem(page, 'dirty.md');
    await typeInEditor(page, ' my text');
    await bot.del('/file?path=dirty.md');
    await expect(page.locator('#notice')).toContainText('deleted or renamed by someone else', { timeout: POLL });
    await expect(page.locator('.cm-content')).toContainText('my text');               // never thrown away
    await page.getByRole('button', { name: 'Save it again' }).click();
    await expect(treeItem(page, 'dirty.md')).toBeVisible();
    await expect(page.locator('.cm-content')).toContainText('my text');
  });

  test('refreshing a password ends the access of people who used the old one', async ({ page, browser, request }) => {
    page.on('dialog', (d) => void d.accept());
    const { id } = await registerAndCreate(page);
    const { rw } = await passwordsOf(page, id);
    const { context, page: guest } = await stranger(browser);
    await guest.goto(`/p/${id}`);
    await guest.locator('#gate-pw').fill(rw);
    await guest.getByRole('button', { name: 'Open' }).click();
    await expect(guest.locator('#rights')).toHaveText('can edit');

    await page.getByRole('button', { name: 'Share' }).click();
    await page.locator('#sh-new').click();
    await expect.poll(() => page.locator('#sh-pw').inputValue()).not.toBe(rw);
    await page.locator('#sh-close').click();

    await expect(guest.locator('#gate-dlg')).toBeVisible({ timeout: POLL });
    await expect(guest.locator('#gate-msg')).toHaveText('Your access changed. Enter the password again.');
    const old = await request.get(`/api/projects/${id}`, { headers: { Authorization: `Bearer ${rw}` } });
    expect((await old.json()).error.code).toBe('invalid_token');
    await context.close();
  });

  test('"only the project owner can roll back" is enforced for visitors with an edit password', async ({ page, browser, request }) => {
    const { id } = await registerAndCreate(page);
    const { rw } = await passwordsOf(page, id);
    await page.locator('#gear-btn').click();
    await page.locator('#s-policy').selectOption('author_only');
    await expect.poll(async () => (await (await request.get(`/api/projects/${id}`, { headers: { Authorization: `Bearer ${rw}` } })).json()).project.rollbackPolicy).toBe('author_only');
    await page.locator('#s-close').click();

    const { context, page: guest } = await stranger(browser);
    await guest.goto(`/p/${id}`);
    await guest.locator('#gate-pw').fill(rw);
    await guest.getByRole('button', { name: 'Open' }).click();
    await expect(guest.locator('#rights')).toHaveText('can edit');
    await showHistory(guest);
    await guest.locator('#history .change').first().click();
    const btn = guest.getByRole('button', { name: /Rollback to/ });
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute('title', 'Only the project owner can roll back in this project');
    const res = await request.post(`/api/projects/${id}/history/1/rollback`, { headers: { Authorization: `Bearer ${rw}` } });
    expect([res.status(), (await res.json()).error.code]).toEqual([403, 'rollback_not_allowed']);

    await showHistory(page);
    await page.locator('#history .change').first().click();                           // the owner still can
    await expect(page.getByRole('button', { name: /Rollback to/ })).toBeEnabled();
    await context.close();
  });

  test('the project switcher lists the owner\'s projects; a visitor without an account gets a hint', async ({ page, browser }) => {
    const { id } = await registerAndCreate(page, 'First');
    await page.locator('#switch-btn').click();
    await expect(page.locator('#switch-list')).toContainText('First');
    await expect(page.locator('#switch-list')).toContainText('open');
    await page.locator('#switch-close').click();

    const pw = await passwordsOf(page, id);
    const { context, page: guest } = await stranger(browser);
    await guest.goto(`/p/${id}`);
    await guest.locator('#gate-pw').fill(pw.ro);
    await guest.getByRole('button', { name: 'Open' }).click();
    await guest.locator('#switch-btn').click();
    await expect(guest.locator('#switch-list')).toContainText('Sign in on the home page');
    await context.close();
  });

  test('a project id that does not exist asks for a password like any other (no way to tell it apart)', async ({ browser }) => {
    const { context, page } = await stranger(browser);
    await page.goto('/p/0197abcd-1234-7000-8000-000000000000');
    await expect(page.locator('#gate-dlg')).toBeVisible();
    await page.locator('#gate-pw').fill('rw_whateverwhateverwhatever1');
    await page.getByRole('button', { name: 'Open' }).click();
    await expect(page.locator('#gate-err')).toHaveText('Wrong password');
    await context.close();
  });
});
