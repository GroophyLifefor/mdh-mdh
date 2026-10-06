import type { Page } from '@playwright/test';
import { expect, test, registerAndCreate, treeItem, clickItem } from './helpers';

type F = { name: string; text?: string; bytes?: number[] };

/** Drops files on a tree row (or the empty tree area) the way the browser does. Folders cannot be faked this way. */
async function dropFiles(page: Page, files: F[], onPath?: string) {
  const target = onPath ? treeItem(page, onPath) : page.locator('#tree');
  const dt = await page.evaluateHandle((fs) => {
    const d = new DataTransfer();
    for (const f of fs) d.items.add(new File([f.bytes ? new Uint8Array(f.bytes) : (f.text ?? '')], f.name));
    return d;
  }, files);
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  await target.dispatchEvent('drop', { dataTransfer: dt });
}

test.describe('uploading by drag and drop', () => {
  test('files dropped on a folder go into it; unsupported ones are skipped and counted', async ({ page }) => {
    await registerAndCreate(page);
    await page.locator('#new-folder').click();
    await page.locator('#tree input').fill('docs');
    await page.locator('#tree input').press('Enter');
    await expect(treeItem(page, 'docs')).toBeVisible();

    await dropFiles(page, [
      { name: 'a.md', text: '# A' }, { name: 'b.yml', text: 'k: v' }, { name: 'pic.png', bytes: [137, 80, 78, 71] },
      { name: 'binary.md', bytes: [104, 0, 105] }, { name: 'notes.txt', text: 'x' },
    ], 'docs');
    await expect(page.locator('#toast')).toHaveText('Uploaded 2 files. Skipped: 2 not .md/.yml/.yaml, 1 not text.');
    await expect(treeItem(page, 'docs/a.md')).toBeVisible();
    await expect(treeItem(page, 'docs/b.yml')).toBeVisible();
    await expect(page.locator('#history .change').first()).toContainText('uploaded 2 files');   // ONE history entry for the lot
    await clickItem(page, 'docs/a.md');
    await expect(page.locator('.cm-content')).toContainText('# A');
  });

  test('a drop on the empty tree area goes to the top; a drop on a collapsed folder opens it', async ({ page }) => {
    await registerAndCreate(page);
    await page.locator('#new-folder').click();
    await page.locator('#tree input').fill('inbox');
    await page.locator('#tree input').press('Enter');
    await clickItem(page, 'inbox');            // collapse
    await dropFiles(page, [{ name: 'top.md', text: 't' }]);
    await expect(treeItem(page, 'top.md')).toBeVisible();
    await dropFiles(page, [{ name: 'deep.md', text: 'd' }], 'inbox');
    await expect(treeItem(page, 'inbox/deep.md')).toBeVisible();
  });

  test('a file that already exists with other content asks before replacing it', async ({ page }) => {
    await registerAndCreate(page);
    let asked = '';
    page.once('dialog', (d) => { asked = d.message(); void d.dismiss(); });
    await dropFiles(page, [{ name: 'readme.md', text: 'REPLACED' }]);
    await expect.poll(() => asked).toContain('1 file already exists with other content. Replace it?');
    await expect(page.locator('.cm-content')).not.toContainText('REPLACED');           // said no: nothing changed

    page.once('dialog', (d) => void d.accept());
    await dropFiles(page, [{ name: 'readme.md', text: 'REPLACED' }]);
    await expect(page.locator('#toast')).toContainText('Uploaded 1 file');
    await expect(page.locator('.cm-content')).toContainText('REPLACED');               // the open file shows the new content
  });

  test('uploading identical files changes nothing', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    const stored = await page.evaluate(async (pid) => (await (await fetch(`/api/projects/${pid}/file?path=readme.md`)).json()).file.content as string, id);
    const before = await page.locator('#history .change').count();
    await dropFiles(page, [{ name: 'readme.md', text: stored }]);                      // byte for byte the same
    await expect(page.locator('#toast')).toHaveText('Nothing new to upload.');
    expect(await page.locator('#history .change').count()).toBe(before);
  });

  test('a read-only visitor cannot upload (the drop is ignored)', async ({ page, browser }) => {
    const { id } = await registerAndCreate(page);
    const pw = await page.evaluate(async (pid) => (await fetch(`/api/projects/${pid}/passwords`)).json(), id);
    const ctx = await browser.newContext();
    const ro = await ctx.newPage();
    await ro.goto(`/p/${id}`);
    await ro.locator('#gate-pw').fill(pw.ro);
    await ro.getByRole('button', { name: 'Open' }).click();
    await expect(ro.locator('#rights')).toHaveText('can view');
    await dropFiles(ro, [{ name: 'sneaky.md', text: 'x' }]);
    await expect(ro.locator('#tree .node[data-path="sneaky.md"]')).toHaveCount(0);
    const tree = await ctx.request.get(`/api/projects/${id}/tree`, { headers: { Authorization: `Bearer ${pw.ro}` } });
    expect((await tree.json()).nodes.map((n: { path: string }) => n.path)).toEqual(['readme.md']);
    await ctx.close();
  });
});
