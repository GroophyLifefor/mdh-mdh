import { expect, test, registerAndCreate, showHistory, treeItem, typeInEditor, watchProblems, clickItem } from './helpers';

test.describe('editing', () => {
  test('typing is saved by itself and is still there after a reload', async ({ page }) => {
    const problems = watchProblems(page);
    await registerAndCreate(page);
    await typeInEditor(page, '# Hello\n\nSaved without a button.', { replace: true });
    await expect(page.locator('#status')).toContainText('Saving');
    await expect(page.locator('#status')).toHaveText('Saved');
    await page.reload();
    await expect(page.locator('.cm-content')).toContainText('Saved without a button.');
    expect(problems).toEqual([]);
  });

  test('one editing session is ONE history entry, however many saves it took', async ({ page }) => {
    await registerAndCreate(page);
    await typeInEditor(page, 'first', { replace: true });
    await expect(page.locator('#status')).toHaveText('Saved');
    await typeInEditor(page, ' second');
    await expect(page.locator('#status')).toHaveText('Saved');
    await typeInEditor(page, ' third');
    await expect(page.locator('#status')).toHaveText('Saved');
    await expect(page.locator('#history .change')).toHaveCount(2);          // created readme.md + edited readme.md
    await expect(page.locator('#history .change').first()).toContainText('edited readme.md');
  });

  test('closing the tab saves what is still waiting (no 1 s wait needed)', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await typeInEditor(page, 'LAST WORDS BEFORE CLOSING', { replace: true });
    await page.goto('about:blank');                                     // leaves at once: the 1 s wait has not passed
    await expect.poll(async () => {
      const res = await page.context().request.get(`/api/projects/${id}/file?path=readme.md`);
      return (await res.json()).file?.content;
    }).toBe('LAST WORDS BEFORE CLOSING');
  });

  test('the pagehide handler itself sends the text (before the 1 s timer would)', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await typeInEditor(page, 'SENT BY PAGEHIDE', { replace: true });
    const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes(`/api/projects/${id}/file`), { timeout: 600 });
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));   // page stays visible: no visibilitychange flush
    expect((await put).postDataJSON().content).toBe('SENT BY PAGEHIDE');
  });

  test('switching files saves the first one right away (nothing is lost)', async ({ page }) => {
    await registerAndCreate(page);
    await page.locator('#new-file').click();
    await page.locator('#tree input').fill('other.md');
    await page.locator('#tree input').press('Enter');
    await expect(page.locator('#bar .name')).toHaveText('other.md');
    await typeInEditor(page, 'quick');
    await clickItem(page, 'readme.md');                               // leave immediately, before the 1 s wait is over
    await expect(page.locator('#bar .name')).toHaveText('readme.md');
    await clickItem(page, 'other.md');
    await expect(page.locator('.cm-content')).toContainText('quick');
  });

  test('markdown: preview with highlighted code, and the Edit | Split | Preview switch', async ({ page }) => {
    await registerAndCreate(page);
    await typeInEditor(page, '# Title\n\n```ts\nconst answer: number = 42; // yes\n```\n\n[link](https://example.com)', { replace: true });
    await expect(page.locator('#preview h1')).toHaveText('Title');
    await expect(page.locator('#preview .hljs-keyword').first()).toBeVisible();
    await expect(page.locator('#preview a')).toHaveAttribute('rel', 'noopener');

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.locator('#preview')).toBeHidden();
    await expect(page.locator('#cm')).toBeVisible();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.locator('#cm')).toBeHidden();
    await expect(page.locator('#preview')).toBeVisible();
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(page.locator('#cm')).toBeVisible();
    await expect(page.locator('#preview')).toBeVisible();
  });

  test('yaml: single pane with a live check', async ({ page }) => {
    await registerAndCreate(page);
    await page.locator('#new-file').click();
    await page.locator('#tree input').fill('config.yml');
    await page.locator('#tree input').press('Enter');
    await expect(page.locator('#bar .name')).toHaveText('config.yml');
    await expect(page.locator('#preview')).toBeHidden();
    await typeInEditor(page, 'name: demo\nlevel: 1');
    await expect(page.locator('#status')).toContainText('yaml ok ✓');
    await typeInEditor(page, '\nbad: [unclosed');
    await expect(page.locator('#status')).toContainText('yaml error');
    await expect(page.locator('#status')).toHaveText(/Saved|Saving/);       // invalid yaml is still saved: it is the person's text
  });

  test('files and folders: create (also nested), name rules, collapse, rename, delete', async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await registerAndCreate(page);

    // name rules, with the server's wording too
    await page.locator('#new-file').click();
    await page.locator('#tree input').fill('notes.txt');
    await page.locator('#tree input').press('Enter');
    await expect(page.locator('#tree .err')).toHaveText('Files must end in .md, .yml or .yaml');
    await page.locator('#tree input').press('Escape');
    await page.locator('#new-folder').click();
    await page.locator('#tree input').fill('v1.md');
    await page.locator('#tree input').press('Enter');
    await expect(page.locator('#tree .err')).toContainText("Folder names can't end in");
    await page.locator('#tree input').fill('docs');
    await page.locator('#tree input').press('Enter');
    await expect(treeItem(page, 'docs')).toBeVisible();

    // a new file goes into the selected folder
    await clickItem(page, 'docs');             // closes it (it was open) and selects it
    await clickItem(page, 'docs');             // opens it again
    await page.locator('#new-file').click();
    await page.locator('#tree input').fill('guide.md');
    await page.locator('#tree input').press('Enter');
    await expect(treeItem(page, 'docs/guide.md')).toBeVisible();
    await expect(page.locator('#bar .name')).toHaveText('docs/guide.md');

    // collapse / expand / collapse all
    await clickItem(page, 'docs');
    await expect(treeItem(page, 'docs/guide.md')).toHaveCount(0);
    await clickItem(page, 'docs');
    await expect(treeItem(page, 'docs/guide.md')).toBeVisible();
    await page.getByTitle('Collapse all folders').click();
    await expect(treeItem(page, 'docs/guide.md')).toHaveCount(0);
    await clickItem(page, 'docs');

    // rename the folder: the open file follows
    await treeItem(page, 'docs').hover();
    await treeItem(page, 'docs').getByTitle('Rename').click();
    await page.locator('#tree input').fill('manual');
    await page.locator('#tree input').press('Enter');
    await expect(treeItem(page, 'manual/guide.md')).toBeVisible();
    await expect(page.locator('#bar .name')).toHaveText('manual/guide.md');
    await expect(treeItem(page, 'docs')).toHaveCount(0);

    // delete the open file
    await treeItem(page, 'manual/guide.md').hover();
    await treeItem(page, 'manual/guide.md').getByTitle('Delete').click();
    await expect(treeItem(page, 'manual/guide.md')).toHaveCount(0);
    await expect(page.locator('#bar')).toContainText('No file open');
    await expect(page.locator('#history .change').first()).toContainText('deleted manual/guide.md');
  });

  test('opening a new name box right after closing another one keeps it open (the old box must not cancel the new one)', async ({ page }) => {
    await registerAndCreate(page);
    await page.locator('#new-folder').click();
    await page.locator('#tree input').fill('first');
    await page.locator('#tree input').press('Enter');
    await page.locator('#new-file').click();                         // at once, well inside the old box's 150 ms cancel timer
    await page.waitForTimeout(600);
    await expect(page.locator('#tree input')).toBeVisible();
    await expect(page.locator('#tree input')).toBeFocused();
  });

  test('history: open an entry to see the paths, roll back, and the rollback is a new entry', async ({ page }) => {
    await registerAndCreate(page);
    await page.locator('#new-file').click();
    await page.locator('#tree input').fill('a.md');
    await page.locator('#tree input').press('Enter');
    await typeInEditor(page, 'content of a');
    await expect(page.locator('#status')).toHaveText('Saved');
    await page.locator('#new-file').click();
    await page.locator('#tree input').fill('b.md');
    await page.locator('#tree input').press('Enter');
    await expect(treeItem(page, 'b.md')).toBeVisible();

    await showHistory(page);
    await page.locator('#history .change', { hasText: 'created a.md' }).click();
    await expect(page.locator('#history .change.sel .paths')).toContainText('a.md');
    await expect(page.getByRole('button', { name: /Rollback to/ })).toBeEnabled();

    await page.locator('#history .change', { hasText: 'edited a.md' }).click();
    await page.getByRole('button', { name: /Rollback to/ }).click();
    await expect(page.locator('#toast')).toContainText('Rolled back to #');
    await expect(treeItem(page, 'b.md')).toHaveCount(0);                     // b.md did not exist yet
    await expect(treeItem(page, 'a.md')).toBeVisible();
    await expect(page.locator('#history .change').first()).toContainText('rolled back to #');
    expect(await page.locator('#history .change').count()).toBeGreaterThanOrEqual(5);   // nothing was removed
  });

  test('panels: hide, resize, and remember', async ({ page }) => {
    await registerAndCreate(page);
    const treeWidth = () => page.locator('aside.tree').evaluate((e) => e.getBoundingClientRect().width);
    const before = await treeWidth();
    expect(before).toBeGreaterThan(200);

    const rz = page.locator('.rz[data-side="tree"]');
    const box = (await rz.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 150);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 150, { steps: 6 });
    await page.mouse.up();
    expect(await treeWidth()).toBeGreaterThan(before + 80);

    await page.reload();
    await expect(page.locator('#bar .name')).toHaveText('readme.md');
    expect(await treeWidth()).toBeGreaterThan(before + 80);                 // remembered

    await expect(page.locator('aside.hist')).toBeHidden();                  // the history starts closed
    await page.locator('#toggle-hist').click();
    await expect(page.locator('aside.hist')).toBeVisible();
    await page.locator('#toggle-tree').click();
    await expect(page.locator('aside.tree')).toBeHidden();
    await page.reload();
    await expect(page.locator('aside.tree')).toBeHidden();                  // all three choices are remembered
    await expect(page.locator('aside.hist')).toBeVisible();
    await page.locator('#toggle-tree').click();
    await expect(page.locator('aside.tree')).toBeVisible();
    await page.locator('#toggle-hist').click();
    await expect(page.locator('aside.hist')).toBeHidden();
  });

  test('the editor | preview divider resizes and double-click resets it', async ({ page }) => {
    await registerAndCreate(page);
    const cmWidth = () => page.locator('#cm').evaluate((e) => e.getBoundingClientRect().width);
    const start = await cmWidth();
    const rz = page.locator('#split-rz');
    const box = (await rz.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 150);
    await page.mouse.down();
    await page.mouse.move(box.x - 150, box.y + 150, { steps: 6 });
    await page.mouse.up();
    expect(await cmWidth()).toBeLessThan(start - 100);
    await rz.dblclick();
    expect(Math.abs((await cmWidth()) - start)).toBeLessThan(4);
  });
});
