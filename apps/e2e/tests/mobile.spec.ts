// A phone: narrow screen, touch, no hovering. Runs in Chromium with a Pixel 7 profile (the "phone" project).
// Real Safari / iOS is not covered here; try the deployed site on a real phone as well.
import { devices, type Browser, type Page } from '@playwright/test';
import { PASSWORD, clickItem, createProject, expect, passwordsOf, register, registerAndCreate, showHistory, test, treeItem, typeInEditor, uniqueName } from './helpers';

const MIN_TARGET = 40;   // px: size of anything a finger has to hit

/** The page must fit the screen, and everything that can be tapped must be big enough and on screen. */
async function assertFits(page: Page, label: string, scope = 'body') {
  const problems = await page.evaluate(({ scope, MIN_TARGET }) => {
    const out: string[] = [];
    const vw = window.innerWidth;
    if (document.documentElement.scrollWidth > vw) out.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
    const root = document.querySelector(scope)!;
    const name = (e: Element) => ((e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || e.id || e.tagName) as string).trim().slice(0, 30);
    for (const e of root.querySelectorAll<HTMLElement>('button, a[href], select, textarea, input:not([type=hidden]):not([type=checkbox]):not([type=file])')) {
      if (!e.checkVisibility()) continue;
      const r = e.getBoundingClientRect();
      if (r.left < -1 || r.right > vw + 1) out.push(`off the screen: "${name(e)}" (${Math.round(r.left)}..${Math.round(r.right)})`);
      if (r.height < MIN_TARGET - 0.5 || r.width < MIN_TARGET - 0.5) out.push(`too small to tap: "${name(e)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      if ((e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement) && parseFloat(getComputedStyle(e).fontSize) < 16) out.push(`text smaller than 16px (iOS would zoom): "${name(e)}"`);
    }
    for (const d of document.querySelectorAll<HTMLElement>('dialog[open]')) {
      const r = d.getBoundingClientRect();
      if (r.left < 0 || r.right > vw || r.top < 0 || r.bottom > window.innerHeight + 1) out.push(`dialog does not fit the screen (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.right)},${Math.round(r.bottom)})`);
    }
    return out;
  }, { scope, MIN_TARGET });
  expect(problems, label).toEqual([]);
}

const tab = (page: Page, name: 'files' | 'editor' | 'history') => page.locator(`#tabbar [data-tab="${name}"]`);
const rowMenu = async (page: Page, path: string) => { await page.locator(`#tree .node[data-path="${path}"] button[aria-label^="Actions"]`).tap(); await expect(page.locator('#row-menu')).toBeVisible(); };

test.describe('on a phone', () => {
  test('home: register, create, search and delete a project with taps; everything fits', async ({ page }) => {
    await page.goto('/');
    await assertFits(page, 'landing');
    await page.getByRole('button', { name: 'Get started' }).tap();
    await assertFits(page, 'register dialog', '#auth-dlg');
    await page.locator('#au-user').fill(uniqueName());
    await page.locator('#au-pass').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).tap();
    await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
    await assertFits(page, 'empty project list');

    await page.getByRole('button', { name: 'New project' }).tap();
    await assertFits(page, 'new project dialog', '#new-dlg');
    await page.locator('#np-name').fill('Phone notes');
    await page.getByRole('button', { name: 'Create', exact: true }).tap();
    await page.waitForURL(/\/p\//);
    await page.goto('/');
    await expect(page.locator('#project-list li')).toHaveCount(1);
    await assertFits(page, 'project list');

    await page.locator('#search').fill('nothing');
    await expect(page.locator('#empty-note')).toBeVisible();
    await page.locator('#search').fill('');
    await page.getByRole('button', { name: 'Delete Phone notes' }).tap();
    await assertFits(page, 'delete dialog', '#del-dlg');
    await page.locator('#del-input').fill('Phone notes');
    await page.getByRole('button', { name: 'Delete project' }).tap();
    await expect(page.locator('#project-list li')).toHaveCount(0);

    await page.locator('#profile-btn').tap();
    await assertFits(page, 'profile dialog', '#profile-dlg');
  });

  test('the project page shows one panel at a time, chosen with the tabs at the bottom', async ({ page }) => {
    await registerAndCreate(page);
    await expect(page.locator('#tabbar')).toBeVisible();
    await expect(tab(page, 'editor')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('section.center')).toBeVisible();
    await expect(page.locator('aside.tree')).toBeHidden();
    await expect(page.locator('aside.hist')).toBeHidden();
    await assertFits(page, 'editor tab');

    await tab(page, 'files').tap();
    await expect(page.locator('aside.tree')).toBeVisible();
    await expect(page.locator('section.center')).toBeHidden();
    await assertFits(page, 'files tab');

    await tab(page, 'history').tap();
    await expect(page.locator('aside.hist')).toBeVisible();
    await assertFits(page, 'history tab');

    await tab(page, 'files').tap();
    await page.locator('#new-file').tap();
    await page.locator('#tree input').fill('second.md');
    await page.locator('#tree input').press('Enter');
    await expect(page.locator('#bar .name')).toHaveText('second.md');
    await tab(page, 'files').tap();
    await clickItem(page, 'readme.md');                              // a DIFFERENT file than the open one: goes back to the editor
    await expect(page.locator('#bar .name')).toHaveText('readme.md');
    await expect(tab(page, 'editor')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('section.center')).toBeVisible();
  });

  test('a wide table scrolls by itself; the page does not scroll sideways', async ({ page }) => {
    await registerAndCreate(page);
    const wide = '| a | b | c | d |\n|---|---|---|---|\n| ' + Array.from({ length: 4 }, () => 'a-very-long-unbreakable-cell-value-'.repeat(3)).join(' | ') + ' |\n\n- [ ] one task with a box\n';
    await typeInEditor(page, wide, { replace: true });
    await page.getByRole('button', { name: 'Preview', exact: true }).tap();
    await expect(page.locator('#preview table')).toBeVisible();
    await assertFits(page, 'preview with a wide table');
    const t = await page.locator('#preview table').evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
    expect(t.scroll).toBeGreaterThan(t.client);                          // it is the table that scrolls
    await page.locator('#preview').screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/preview-phone.png` : undefined });
  });

  test('header: the project name shrinks to fit and every button is reachable', async ({ page }) => {
    await register(page);
    await createProject(page, 'A very long project name that does not fit in a narrow header at all');
    await assertFits(page, 'header with a long name', 'header');
    await expect(page.locator('#proj-name')).toBeVisible();
    for (const hidden of ['#toggle-tree', '#toggle-hist', '#rights']) await expect(page.locator(hidden)).toBeHidden();   // no room, and the tabs replace them
  });

  test('typing on a phone: Edit and Preview only (no Split), and autosave works', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await expect(page.getByRole('button', { name: 'Split' })).toHaveCount(0);
    await typeInEditor(page, '# Phone title\n\n- one', { replace: true });
    await expect(page.locator('#status')).toHaveText('Saved');
    await expect(page.locator('#preview')).toBeHidden();
    await page.getByRole('button', { name: 'Preview', exact: true }).tap();
    await expect(page.locator('#preview h1')).toHaveText('Phone title');
    await expect(page.locator('#cm')).toBeHidden();
    await assertFits(page, 'preview');
    await page.getByRole('button', { name: 'Edit', exact: true }).tap();
    await expect(page.locator('.cm-content')).toBeVisible();
    const res = await page.context().request.get(`/api/projects/${id}/file?path=readme.md`);
    expect((await res.json()).file.content).toBe('# Phone title\n\n- one');
    const fontSize = await page.locator('.cm-content').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16);                       // below 16px iOS zooms the page when you tap the text
  });

  test('the row menu replaces the hover buttons: create inside a folder, rename, download, delete', async ({ page }) => {
    page.on('dialog', (d) => void d.accept());
    await registerAndCreate(page);
    await tab(page, 'files').tap();
    await page.locator('#new-folder').tap();
    await page.locator('#tree input').fill('docs');
    await page.locator('#tree input').press('Enter');
    await expect(treeItem(page, 'docs')).toBeVisible();
    await expect(page.locator('#tree .node .acts')).toHaveCount(0);       // no hover buttons on a phone

    await rowMenu(page, 'docs');
    await assertFits(page, 'row menu', '#row-menu');
    await expect(page.locator('#rm-list')).toContainText('New file here');
    await page.getByRole('button', { name: 'New file here' }).tap();
    await page.locator('#tree input').fill('guide.md');
    await page.locator('#tree input').press('Enter');
    await expect(page.locator('#bar .name')).toHaveText('docs/guide.md');
    await typeInEditor(page, 'hello');
    await expect(page.locator('#status')).toHaveText('Saved');

    await tab(page, 'files').tap();
    await rowMenu(page, 'docs/guide.md');
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#rm-list a', { hasText: 'Download' }).tap()]);
    expect(download.suggestedFilename()).toBe('guide.md');

    await rowMenu(page, 'docs/guide.md');
    await page.getByRole('button', { name: 'Rename' }).tap();
    await page.locator('#tree input').fill('manual.md');
    await page.locator('#tree input').press('Enter');
    await expect(treeItem(page, 'docs/manual.md')).toBeVisible();

    await rowMenu(page, 'docs/manual.md');
    await page.getByRole('button', { name: 'Delete' }).tap();
    await expect(treeItem(page, 'docs/manual.md')).toHaveCount(0);
  });

  test('a phone cannot drag files in, so the upload button opens the file picker', async ({ page }) => {
    await registerAndCreate(page);
    await tab(page, 'files').tap();
    await expect(page.locator('#upload-btn')).toBeVisible();
    await page.locator('#upload-input').setInputFiles([
      { name: 'from-phone.md', mimeType: 'text/markdown', buffer: Buffer.from('# From my phone') },
      { name: 'data.yml', mimeType: 'text/yaml', buffer: Buffer.from('a: 1') },
      { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) },
    ]);
    await expect(page.locator('#toast')).toHaveText('Uploaded 2 files. Skipped: 1 not .md/.yml/.yaml.');
    await expect(treeItem(page, 'from-phone.md')).toBeVisible();
    await expect(treeItem(page, 'data.yml')).toBeVisible();
  });

  test('history: tap an entry, see the paths, roll back', async ({ page }) => {
    await registerAndCreate(page);
    await typeInEditor(page, 'second version', { replace: true });
    await expect(page.locator('#status')).toHaveText('Saved');
    await showHistory(page);
    await page.locator('#history .change', { hasText: 'created readme.md' }).tap();
    await expect(page.locator('#history .change.sel .paths')).toContainText('readme.md');
    await assertFits(page, 'history with an entry open');
    await page.getByRole('button', { name: /Rollback to/ }).tap();
    await expect(page.locator('#toast')).toContainText('Rolled back to #1');
    await tab(page, 'editor').tap();
    await expect(page.locator('.cm-content')).not.toContainText('second version');
  });

  test('the download buttons are there for a viewer, and a stranger gets a password prompt that fits', async ({ page, browser }) => {
    const { id } = await registerAndCreate(page, 'Shared');
    const { ro } = await passwordsOf(page, id);
    const guest = await phoneGuest(browser);
    await guest.goto(`/p/${id}`);
    await expect(guest.locator('#gate-dlg')).toBeVisible();
    await assertFits(guest, 'password prompt', '#gate-dlg');
    await guest.locator('#gate-pw').fill(ro);
    await guest.getByRole('button', { name: 'Open' }).tap();
    await expect(guest.locator('#rights')).toBeHidden();               // hidden on a phone, so the editor says it:
    await expect(guest.locator('#status')).toHaveText('read only');
    await assertFits(guest, 'read-only editor');
    const [download] = await Promise.all([guest.waitForEvent('download'), guest.locator('#download-file').tap()]);
    expect(download.suggestedFilename()).toBe('readme.md');
    await guest.context().close();
  });

  test('every dialog of the project page fits the screen', async ({ page }) => {
    await registerAndCreate(page);
    await page.locator('#share-btn').tap();
    await expect(page.locator('#sh-prompt')).not.toHaveValue('');
    await assertFits(page, 'share dialog', '#share-dlg');
    await page.locator('#sh-close').tap();
    await page.locator('#gear-btn').tap();
    await assertFits(page, 'settings dialog', '#settings-dlg');
    await page.locator('#s-close').tap();
    await page.locator('#switch-btn').tap();
    await expect(page.locator('#switch-list li').first()).toBeVisible();
    await assertFits(page, 'project switcher', '#switch-dlg');
  });

  test('a change by someone else shows up here too, and the conflict bar fits', async ({ page, request }) => {
    const { id } = await registerAndCreate(page);
    const { rw } = await passwordsOf(page, id);
    await typeInEditor(page, 'MINE', { replace: true });
    const headers = { Authorization: `Bearer ${rw}` };
    const f = (await (await request.get(`/api/projects/${id}/file?path=readme.md`, { headers })).json()).file;
    await request.put(`/api/projects/${id}/file`, { headers, data: { path: 'readme.md', content: 'THEIRS', baseVersion: f.version } });
    await expect(page.locator('#notice')).toBeVisible();
    await assertFits(page, 'conflict notice');
    await page.getByRole('button', { name: 'Keep my version' }).tap();
    await expect(page.locator('#notice')).toBeHidden();
  });
});

async function phoneGuest(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...devices['Pixel 7'], extraHTTPHeaders: { 'X-Forwarded-For': `10.251.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });
  return context.newPage();
}

// ---- how it looks (reference images were checked by eye) ----
for (const theme of ['light', 'dark'] as const) {
  test.describe(`phone, ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => { await page.addInitScript((t) => { try { localStorage.setItem('mdh_theme', t); } catch { /* none */ } }, theme); });
    const mask = (page: Page) => [page.locator('#profile-btn'), page.locator('#history .muted'), page.locator('.list .muted'), page.locator('#toast'), page.locator('#sh-url'), page.locator('#sh-pw'), page.locator('#sh-prompt')];

    test('home', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveScreenshot(`phone-home-landing-${theme}.png`);
    });

    test('project: editor, files, history tabs and the row menu', async ({ page }) => {
      await registerAndCreate(page, 'Product Notes');
      await page.locator('#new-folder').dispatchEvent('click');          // not visible on the editor tab: go through the files tab
      await tab(page, 'files').tap();
      await page.locator('#new-folder').tap();
      await page.locator('#tree input').fill('notes');
      await page.locator('#tree input').press('Enter');
      await tab(page, 'editor').tap();
      await typeInEditor(page, '# Product Notes\n\nWelcome!\n\n- Simple\n- **Friendly**', { replace: true });
      await expect(page.locator('#status')).toHaveText('Saved');
      await page.getByRole('button', { name: 'Preview', exact: true }).tap();
      await expect(page.locator('#preview h1')).toBeVisible();
      await expect(page).toHaveScreenshot(`phone-project-preview-${theme}.png`, { mask: mask(page) });
      await page.getByRole('button', { name: 'Edit', exact: true }).tap();
      await expect(page).toHaveScreenshot(`phone-project-editor-${theme}.png`, { mask: mask(page) });
      await tab(page, 'files').tap();
      await expect(page).toHaveScreenshot(`phone-project-files-${theme}.png`, { mask: mask(page) });
      await rowMenu(page, 'notes');
      await expect(page).toHaveScreenshot(`phone-row-menu-${theme}.png`, { mask: mask(page) });
      await page.keyboard.press('Escape');
      await tab(page, 'history').tap();
      await expect(page.locator('#history .change').first()).toBeVisible();
      await expect(page).toHaveScreenshot(`phone-project-history-${theme}.png`, { mask: mask(page) });
    });

    test('share dialog', async ({ page }) => {
      await registerAndCreate(page, 'Product Notes');
      await page.locator('#share-btn').tap();
      await expect(page.locator('#sh-prompt')).not.toHaveValue('');
      await expect(page).toHaveScreenshot(`phone-share-${theme}.png`, { mask: mask(page) });
    });
  });
}
