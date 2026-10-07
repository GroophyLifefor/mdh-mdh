// The address follows what is open (?file=, ?diff=), so a link lands on the same view, after the password gate.
import { agent, clickItem, expect, passwordsOf, registerAndCreate, showHistory, stranger, test, treeItem, typeInEditor, watchProblems } from './helpers';

/** Opens a file by clicking through its folders (a folder that is already open must not be closed again). */
async function openInTree(page: import('@playwright/test').Page, path: string) {
  const parts = path.split('/');
  await expect(treeItem(page, parts[0]!)).toBeVisible();
  for (let i = 1; i < parts.length; i++) {
    const child = treeItem(page, parts.slice(0, i + 1).join('/'));
    const shown = await child.waitFor({ state: 'visible', timeout: 1000 }).then(() => true, () => false);
    if (!shown) await treeItem(page, parts.slice(0, i).join('/')).locator('.label').click();
  }
  await clickItem(page, path);
}

const search = (page: import('@playwright/test').Page) => new URL(page.url()).searchParams;

/** An API client that writes with the edit password (cookie writes need an Origin header, which a bare request does not send). */
async function writer(page: import('@playwright/test').Page, id: string) {
  return agent(page.request, id, (await passwordsOf(page, id)).rw);
}

async function seed(page: import('@playwright/test').Page, id: string) {
  const api = await writer(page, id);
  await api.post('/files', { path: 'notes/spec.md', kind: 'file', content: 'line one\nline two\nline three\n' });
  await api.put('/file', { path: 'notes/spec.md', content: 'line one\nline TWO\nline three\nline four\n', baseVersion: 1 });
}

test.describe('links to a file', () => {
  test('opening a file puts it in the address; a reload (or a pasted link) opens the same file', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await seed(page, id);
    await page.reload();
    await expect(page.locator('#bar .name')).toHaveText('readme.md');                   // the default file...
    expect(search(page).get('file')).toBe('readme.md');                                 // ...is in the address too
    await openInTree(page, 'notes/spec.md');
    await expect(page.locator('#bar .name')).toHaveText('notes/spec.md');
    expect(search(page).get('file')).toBe('notes/spec.md');
    await page.reload();
    await expect(page.locator('#bar .name')).toHaveText('notes/spec.md');
    await expect(page.locator('.cm-content')).toContainText('line TWO');
    expect(page.url()).toContain(`/p/${id}?file=notes%2Fspec.md`);
  });

  test('a link to a file that does not exist says so and opens the default', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await page.goto(`/p/${id}?file=nope%2Fmissing.md`);
    await expect(page.locator('#toast')).toContainText('nope/missing.md');
    await expect(page.locator('#bar .name')).toHaveText('readme.md');
    expect(search(page).get('file')).toBe('readme.md');
  });

  test('somebody with the link sees the password gate first, then lands on that file (view-only and edit passwords)', async ({ page, browser }) => {
    const { id } = await registerAndCreate(page);
    await seed(page, id);
    const pw = await passwordsOf(page, id);
    for (const [kind, password] of [['ro', pw.ro], ['rw', pw.rw]] as const) {
      const { context, page: guest } = await stranger(browser);
      await guest.goto(`/p/${id}?file=notes%2Fspec.md`);
      await expect(guest.locator('#gate-dlg')).toBeVisible();
      await expect(guest.locator('#bar .name')).toHaveCount(0);                            // nothing before the password
      await guest.locator('#gate-pw').fill(password);
      await guest.locator('#gate-pw').press('Enter');
      await expect(guest.locator('#bar .name')).toHaveText('notes/spec.md');
      await expect(guest.locator('.cm-content')).toContainText('line TWO');
      expect(search(guest).get('file'), kind).toBe('notes/spec.md');
      await context.close();
    }
  });

  test('deleting the open file takes it out of the address', async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    const { id } = await registerAndCreate(page);
    await seed(page, id);
    await page.reload();
    await openInTree(page, 'notes/spec.md');
    await expect(page.locator('#bar .name')).toHaveText('notes/spec.md');
    await expect.poll(() => search(page).get('file')).toBe('notes/spec.md');
    await treeItem(page, 'notes/spec.md').getByTitle('Delete').click();
    await expect(treeItem(page, 'notes/spec.md')).toHaveCount(0);
    await expect.poll(() => search(page).get('file')).toBeNull();
  });
});

test.describe('diff view', () => {
  test('the diff icon of a history entry opens what changed; the address carries it; a reload and another browser see the same', async ({ page, browser }) => {
    const problems = watchProblems(page);
    const { id } = await registerAndCreate(page);
    await seed(page, id);
    await page.reload();
    await showHistory(page);
    const edit = page.locator('#history .change').first();                              // the edit of notes/spec.md
    await edit.getByRole('button', { name: /Show what changed/ }).click();
    const dlg = page.locator('#diff-dlg');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('#diff-title')).toContainText('edited notes/spec.md');
    await expect(dlg.locator('.dl.del')).toHaveCount(1);
    await expect(dlg.locator('.dl.del')).toContainText('line two');
    await expect(dlg.locator('.dl.add')).toHaveCount(2);
    await expect(dlg.locator('.dl.add').first()).toContainText('line TWO');
    await expect(dlg.locator('#diff-view')).toContainText('+2');
    await dlg.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/diff-desktop.png` : undefined });
    const seq = search(page).get('diff')!;
    expect(Number(seq)).toBeGreaterThan(1);
    expect(search(page).get('dpath')).toBe('notes/spec.md');

    await page.reload();                                                                // the same modal after a reload
    await expect(page.locator('#diff-dlg')).toBeVisible();
    await expect(page.locator('#diff-dlg .dl.add')).toHaveCount(2);

    const pw = await passwordsOf(page, id);
    for (const password of [pw.ro, pw.rw]) {                                            // anyone with access can look at changes
      const { context, page: guest } = await stranger(browser);
      await guest.goto(page.url());
      await expect(guest.locator('#gate-dlg')).toBeVisible();
      await expect(guest.locator('#diff-dlg')).toBeHidden();
      await guest.locator('#gate-pw').fill(password);
      await guest.locator('#gate-pw').press('Enter');
      await expect(guest.locator('#diff-dlg')).toBeVisible();
      await expect(guest.locator('#diff-dlg .dl.add').first()).toContainText('line TWO');
      await expect(guest.getByRole('button', { name: /Rollback/ })).toHaveCount(0);      // looking only
      await context.close();
    }

    await page.locator('#diff-close').click();
    await expect(page.locator('#diff-dlg')).toBeHidden();
    await expect.poll(() => search(page).get('diff')).toBeNull();
    expect(problems).toEqual([]);
  });

  test('a created file shows only additions, a deleted one only removals; a folder-only change says so', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await seed(page, id);
    await (await writer(page, id)).post('/files', { path: 'emptydir', kind: 'dir' });
    await (await writer(page, id)).del('/file?path=notes%2Fspec.md');
    await page.reload();
    await showHistory(page);
    const open = async (n: number) => { await page.locator('#history .change').nth(n).getByRole('button', { name: /Show what changed/ }).click(); await expect(page.locator('#diff-dlg')).toBeVisible(); };
    await open(0);                                                                      // the delete
    await expect(page.locator('#diff-dlg .dl.del')).toHaveCount(4);
    await expect(page.locator('#diff-dlg .dl.add')).toHaveCount(0);
    await page.locator('#diff-close').click();
    await open(1);                                                                      // the empty folder
    await expect(page.locator('#diff-view')).toContainText('only touched folders');
    await page.locator('#diff-close').click();
    await open(3);                                                                      // the create of spec.md (entry #2)
    await expect(page.locator('#diff-dlg .dl.add')).toHaveCount(3);
    await expect(page.locator('#diff-dlg .dl.del')).toHaveCount(0);
  });

  test('a link to a change that does not exist says so; file content in a diff is text, never markup', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    const { id } = await registerAndCreate(page);
    await page.goto(`/p/${id}?diff=999`);
    await expect(page.locator('#toast')).toContainText('#999');
    await expect(page.locator('#diff-dlg')).toBeHidden();
    expect(search(page).get('diff')).toBeNull();

    await typeInEditor(page, '<img src=x onerror=alert(1)>\n<script>alert(2)</script>', { replace: true });
    await expect(page.locator('#status')).toHaveText('Saved');
    await showHistory(page);
    await expect(page.locator('#history .change').first()).toContainText('edited readme.md');
    await page.locator('#history .change').first().getByRole('button', { name: /Show what changed/ }).click();
    await expect(page.locator('#diff-dlg .dl.add').first()).toContainText('<img src=x onerror=alert(1)>');
    await expect(page.locator('#diff-view img, #diff-view script')).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });

  test('an editing session that was merged into one entry says over which time it spans; a single save does not', async ({ page }) => {
    await registerAndCreate(page);
    await typeInEditor(page, 'first', { replace: true });
    await expect(page.locator('#status')).toHaveText('Saved');
    await typeInEditor(page, ' second');
    await expect(page.locator('#status')).toHaveText('Saved');
    await showHistory(page);
    await expect(page.locator('#history .change')).toHaveCount(2);                       // created + ONE edit
    await page.locator('#history .change').first().getByRole('button', { name: /Show what changed/ }).click();
    await expect(page.locator('#diff-meta')).toContainText('edited between');
    await expect(page.locator('#diff-dlg .dl.add')).toContainText('first second');       // the whole session in one diff
    await page.locator('#diff-close').click();
    await page.locator('#history .change').nth(1).getByRole('button', { name: /Show what changed/ }).click();   // the creation: one moment
    await expect(page.locator('#diff-dlg')).toBeVisible();
    await expect(page.locator('#diff-meta')).not.toContainText('edited between');
  });

  test('a change with several files has a file list; picking one updates the address', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await (await writer(page, id)).post('/upload', { files: [{ path: 'a.md', content: 'A1' }, { path: 'b.md', content: 'B1' }] });
    await page.reload();
    await showHistory(page);
    await page.locator('#history .change').first().getByRole('button', { name: /Show what changed/ }).click();
    await expect(page.locator('#diff-files li')).toHaveCount(2);
    await expect(page.locator('#diff-dlg .dl.add')).toContainText('A1');
    await page.locator('#diff-files li', { hasText: 'b.md' }).click();
    await expect(page.locator('#diff-dlg .dl.add')).toContainText('B1');
    expect(search(page).get('dpath')).toBe('b.md');
  });
});
