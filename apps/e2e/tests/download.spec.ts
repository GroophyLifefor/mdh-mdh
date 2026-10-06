import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import type { Page } from '@playwright/test';
import { expect, test, clickItem, passwordsOf, registerAndCreate, stranger, treeItem, typeInEditor } from './helpers';

/** Clicks something that starts a download and returns what the browser would save. */
async function takeDownload(page: Page, click: () => Promise<void>) {
  const [download] = await Promise.all([page.waitForEvent('download'), click()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), bytes: new Uint8Array(await readFile(path!)) };
}
const unzip = (bytes: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k, v]) => [k, strFromU8(v)]));

async function makeFiles(page: Page) {
  await page.locator('#new-folder').click();
  await page.locator('#tree input').fill('docs');
  await page.locator('#tree input').press('Enter');
  await expect(treeItem(page, 'docs')).toBeVisible();
  await clickItem(page, 'docs');                                          // select the folder: new files go into it
  await page.locator('#new-file').click();
  await page.locator('#tree input').fill('guide.md');
  await page.locator('#tree input').press('Enter');
  await typeInEditor(page, '# Guide\n\nTürkçe 🙂');
  await expect(page.locator('#status')).toHaveText('Saved');
}

test.describe('downloading', () => {
  test('one file, from its row and from the editor bar, exactly as written', async ({ page }) => {
    await registerAndCreate(page, 'Notes');
    await makeFiles(page);

    const row = treeItem(page, 'docs/guide.md');
    await row.hover();
    const fromRow = await takeDownload(page, () => row.getByTitle('Download').click());
    expect(fromRow.name).toBe('guide.md');
    expect(strFromU8(fromRow.bytes)).toBe('# Guide\n\nTürkçe 🙂');

    const fromBar = await takeDownload(page, () => page.locator('#download-file').click());
    expect(fromBar.name).toBe('guide.md');
    expect(strFromU8(fromBar.bytes)).toBe('# Guide\n\nTürkçe 🙂');
  });

  test('the whole project as a .zip, named after the project, with every file and folder', async ({ page }) => {
    await registerAndCreate(page, 'My notes');
    await makeFiles(page);
    const zip = await takeDownload(page, () => page.getByLabel('Download project as zip').click());
    expect(zip.name).toBe('My notes.zip');
    const files = unzip(zip.bytes);
    expect(files['docs/guide.md']).toBe('# Guide\n\nTürkçe 🙂');
    expect(files['readme.md']).toContain('# My notes');
    expect(Object.keys(files).filter((k) => k.endsWith('/'))).toEqual(['docs/']);
  });

  test('a folder as a .zip with the folder inside', async ({ page }) => {
    await registerAndCreate(page);
    await makeFiles(page);
    const row = treeItem(page, 'docs');
    await row.hover();
    const zip = await takeDownload(page, () => row.getByTitle('Download folder as .zip').click());
    expect(zip.name).toBe('docs.zip');
    expect(Object.keys(unzip(zip.bytes)).sort()).toEqual(['docs/', 'docs/guide.md']);
  });

  test('a visitor with a view-only password can download too (and sees nothing else on the row)', async ({ page, browser }) => {
    const { id } = await registerAndCreate(page, 'Shared');
    await makeFiles(page);
    const pw = await passwordsOf(page, id);
    const { context, page: guest } = await stranger(browser);
    await guest.goto(`/p/${id}`);
    await guest.locator('#gate-pw').fill(pw.ro);
    await guest.getByRole('button', { name: 'Open' }).click();
    await expect(guest.locator('#rights')).toHaveText('can view');
    const row = treeItem(guest, 'docs/guide.md');
    await row.hover();
    await expect(row.locator('.acts button')).toHaveCount(0);            // no rename or delete
    const file = await takeDownload(guest, () => row.getByTitle('Download').click());
    expect(strFromU8(file.bytes)).toContain('Türkçe');
    const zip = await takeDownload(guest, () => guest.getByLabel('Download project as zip').click());
    expect(zip.name).toBe('Shared.zip');
    await context.close();
  });

  test('a hostile project name still makes a harmless file name', async ({ page }) => {
    await registerAndCreate(page, '../../etc/passwd:<x>|"y"');
    const zip = await takeDownload(page, () => page.getByLabel('Download project as zip').click());
    expect(zip.name).toBe('.._.._etc_passwd__x___y_.zip'.replace(/^\.+/, ''));
    expect(zip.name).not.toMatch(/[/\\:<>|"]/);
  });
});
