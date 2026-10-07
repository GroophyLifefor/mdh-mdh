// The diff of a markdown file as a page: new sections green, removed red, changed amber with the changed words marked.
import { agent, expect, passwordsOf, registerAndCreate, showHistory, stranger, test } from './helpers';
import type { Page } from '@playwright/test';

const BEFORE = `# Hermes delivery

The console delivers an alert to the agent by posting the rendered alert to the configured webhook.

- Content-Type: application/json
- X-Signature header computed as the hex-encoded HMAC of the request body

## Retries

The console retries three times.

## Notes

Nothing else here.
`;
const AFTER = `# Hermes delivery

The console delivers an alert to the agent by posting the signed alert to the configured webhook url.

- Content-Type: application/json
- X-Signature header computed as the lowercase hex-encoded HMAC-SHA256 of the exact request body bytes
- X-Delivery-Id header with a unique id

## Backoff

Retries wait one second, then two, then four.

## Notes

Nothing else here.
`;

async function writeFile(page: Page, id: string, path: string, before: string, after: string, who = 'murat') {
  const api = agent(page.request, id, (await passwordsOf(page, id)).rw, who);
  await api.post('/files', { path, kind: 'file', content: before });
  await api.put('/file', { path, content: after, baseVersion: 1 });
}
async function openDiffOfNewest(page: Page) {
  await page.goto(new URL(page.url()).pathname);                                         // the plain address (a reload would reopen the diff that is in it)
  await showHistory(page);
  await page.locator('#history .change').first().getByRole('button', { name: /Show what changed/ }).click();
  await expect(page.locator('#diff-dlg')).toBeVisible();
}

test.describe('rich diff of markdown', () => {
  test('shows the page with green / amber / red sections and the changed words marked', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await writeFile(page, id, 'spec.md', BEFORE, AFTER);
    await openDiffOfNewest(page);
    const view = page.locator('#diff-view');
    await expect(view.locator('.rd')).toBeVisible();                                    // rendered is the default for .md
    await expect(view.locator('.dl')).toHaveCount(0);                                   // no raw lines
    await expect(view.locator('h1')).toHaveText('Hermes delivery');                     // a real heading
    await expect(view.locator('.rd-changed ins').first()).toBeVisible();
    await expect(view.locator('.rd-changed del').first()).toContainText('rendered');    // "rendered" was replaced by "signed"
    await expect(view.locator('.rd-changed ins', { hasText: 'signed' })).toHaveCount(1);
    await expect(view.locator('.rd-changed ins', { hasText: 'X-Delivery-Id' })).toHaveCount(1);   // the new bullet, underlined
    await expect(view.locator('.rd-added h2', { hasText: 'Backoff' })).toBeVisible();   // a new section keeps its heading
    await expect(view.locator('.rd-removed h2', { hasText: 'Retries' })).toBeVisible();
    await expect(view.locator('.diff-viewbar .note')).toContainText('changed');
    for (const [cls, colour] of [['rd-added', 'ok'], ['rd-changed', 'warn'], ['rd-removed', 'danger']] as const) {
      const bar = await view.locator(`.${cls}`).first().evaluate((e) => getComputedStyle(e).borderLeftColor);
      expect(bar, `${cls} bar (${colour})`).not.toBe('rgba(0, 0, 0, 0)');
    }
    await expect(view.locator('.rd-same', { hasText: 'Nothing else here' })).toBeVisible();   // unchanged text is plain
    await page.locator('#diff-dlg').screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/rich-desktop-${await page.evaluate(() => document.documentElement.dataset.theme)}.png` : undefined });
  });

  test('Source shows the lines, Rendered brings the page back, and the choice is remembered', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await writeFile(page, id, 'spec.md', BEFORE, AFTER);
    await openDiffOfNewest(page);
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(page.locator('#diff-view .dl.add').first()).toBeVisible();
    await expect(page.locator('#diff-view .rd')).toHaveCount(0);
    await page.reload();                                                                // remembered for next time
    await expect(page.locator('#diff-view .dl.add').first()).toBeVisible();
    await page.getByRole('button', { name: 'Rendered', exact: true }).click();
    await expect(page.locator('#diff-view .rd')).toBeVisible();
    await page.reload();
    await expect(page.locator('#diff-view .rd')).toBeVisible();
  });

  test('a new markdown file is shown as a normal page (not painted green), a yaml file only as lines', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    const api = agent(page.request, id, (await passwordsOf(page, id)).rw);
    await api.post('/files', { path: 'fresh.md', kind: 'file', content: '# Fresh\n\nBrand **new** page.' });
    await openDiffOfNewest(page);
    await expect(page.locator('#diff-view .rd h1')).toHaveText('Fresh');
    await expect(page.locator('#diff-view .rd-added')).toHaveCount(0);
    await expect(page.locator('#diff-view .diff-viewbar .note')).toContainText('new file');
    await api.post('/files', { path: 'conf.yml', kind: 'file', content: 'a: 1\nb: 2\n' });
    await openDiffOfNewest(page);
    await expect(page.locator('#diff-view .diff-mode')).toHaveCount(0);                  // nothing to render
    await expect(page.locator('#diff-view .dl.add')).toHaveCount(2);
  });

  test('long unchanged stretches fold; one click shows them', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    const body = Array.from({ length: 12 }, (_, i) => `Section ${i} stays exactly the same.`).join('\n\n');
    await writeFile(page, id, 'long.md', `${body}\n\nThe ending says old.`, `${body}\n\nThe ending says new.`);
    await openDiffOfNewest(page);
    const gap = page.locator('#diff-view .rd-gap');
    await expect(gap).toContainText('11 unchanged sections');
    await expect(page.locator('#diff-view', { hasText: 'Section 5 stays' })).toHaveCount(0);
    await gap.click();
    await expect(page.locator('#diff-view')).toContainText('Section 5 stays');
    await expect(gap).toHaveCount(0);
  });

  test('hostile markdown in a diff stays text, and a mermaid diagram is drawn inside it', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    const { id } = await registerAndCreate(page);
    const evil = '<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n\n[x](javascript:alert(3))\n\n';
    const diagram = (to: string) => `\`\`\`mermaid\ngraph TD\n  A-->${to}\n\`\`\`\n`;
    await writeFile(page, id, 'evil.md', `old text\n\n${evil}${diagram('B')}`, `new text\n\n${evil}${diagram('C')}`);
    await openDiffOfNewest(page);
    await expect(page.locator('#diff-view .rd-changed ins').first()).toBeVisible();
    await expect(page.locator('#diff-view img.mermaid-img')).toHaveCount(2, { timeout: 15_000 });   // the changed diagram: old and new, as pictures
    await expect(page.locator('#diff-view script, #diff-view iframe, #diff-view [onerror], #diff-view svg')).toHaveCount(0);
    await expect(page.locator('#diff-view a[href^="javascript"]')).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });

  test('a link to the diff opens the rendered view for someone with only the view password', async ({ page, browser }) => {
    const { id } = await registerAndCreate(page);
    await writeFile(page, id, 'spec.md', BEFORE, AFTER);
    await openDiffOfNewest(page);
    const pw = await passwordsOf(page, id);
    const { context, page: guest } = await stranger(browser);
    await guest.goto(page.url());
    await guest.locator('#gate-pw').fill(pw.ro);
    await guest.locator('#gate-pw').press('Enter');
    await expect(guest.locator('#diff-view .rd-changed ins').first()).toBeVisible();
    await context.close();
  });

  test('dark theme: the marks stay readable', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await writeFile(page, id, 'spec.md', BEFORE, AFTER);
    await page.locator('#theme-btn').click();
    await openDiffOfNewest(page);
    await expect(page.locator('#diff-view .rd-changed ins').first()).toBeVisible();
    const colours = await page.locator('#diff-view .rd-changed ins').first().evaluate((e) => ({ fg: getComputedStyle(e).color, bg: getComputedStyle(document.body).backgroundColor }));
    expect(colours.fg).not.toBe(colours.bg);
    await page.locator('#diff-dlg').screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/rich-desktop-dark.png` : undefined });
  });

  test('pictures: added, removed, renamed and re-addressed are all visible, and nothing is ever fetched', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => { if (/x\.test|evil\.test/.test(r.url())) requests.push(r.url()); });
    const { id } = await registerAndCreate(page);
    const before = '# Gallery\n\nIntro stays.\n\n![old logo](https://x.test/old.png)\n\nA sentence with ![chart](https://x.test/chart.png) inside.\n\n![removed one](https://x.test/gone.png)\n\nTail stays.\n';
    const after = '# Gallery\n\nIntro stays.\n\n![new logo](https://x.test/old.png)\n\nA sentence with inside.\n\n![brand new](https://x.test/new.png)\n\nTail stays.\n';
    await writeFile(page, id, 'gallery.md', before, after);
    await openDiffOfNewest(page);
    const view = page.locator('#diff-view');
    await expect(view.locator('.rd')).toBeVisible();
    await expect(view.locator('.rd-added .md-image', { hasText: 'Image: brand new (https://x.test/new.png)' })).toBeVisible();   // a new picture
    await expect(view.locator('.rd-removed .md-image', { hasText: 'Image: removed one' })).toBeVisible();                         // a removed picture
    await expect(view.locator('.rd-changed del', { hasText: 'chart' })).toHaveCount(1);                                             // removed inside a sentence
    await expect(view.locator('.rd-changed ins', { hasText: 'new' })).not.toHaveCount(0);                                           // a changed description
    await expect(view.locator('img:not(.mermaid-img)')).toHaveCount(0);                                                             // never a real <img>
    await page.waitForTimeout(300);
    expect(requests, 'no picture address was requested').toEqual([]);
    await page.locator('#diff-dlg').screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/rich-images.png` : undefined });
  });

  test('a picture whose address changed (same description) is a visible change', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await writeFile(page, id, 'p.md', 'Intro.\n\n![logo](https://x.test/v1/logo.png)\n', 'Intro.\n\n![logo](https://x.test/v2/logo.png)\n');
    await openDiffOfNewest(page);
    await expect(page.locator('#diff-view .rd-changed del')).toContainText('v1');
    await expect(page.locator('#diff-view .rd-changed ins')).toContainText('v2');
    await expect(page.locator('#diff-view .diff-viewbar .note')).toContainText('1 changed');
  });

  test('a new or deleted file with pictures shows the labels too', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    const api = agent(page.request, id, (await passwordsOf(page, id)).rw);
    await api.post('/files', { path: 'fresh.md', kind: 'file', content: '# Fresh\n\n![hero](https://x.test/hero.png)\n' });
    await openDiffOfNewest(page);
    await expect(page.locator('#diff-view .rd .md-image')).toContainText('Image: hero (https://x.test/hero.png)');
    await api.del('/file?path=fresh.md');
    await openDiffOfNewest(page);
    await expect(page.locator('#diff-view .rd .md-image')).toContainText('Image: hero');
    await expect(page.locator('#diff-view .diff-viewbar .note')).toContainText('deleted file');
  });

  test('hostile picture text in a diff is only text', async ({ page }) => {
    const dialogs: string[] = [];
    const requests: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    page.on('request', (r) => { if (/evil\.test/.test(r.url())) requests.push(r.url()); });
    const { id } = await registerAndCreate(page);
    const evil = '![\"><img src=x onerror=alert(1)>](https://evil.test/a.png "t")\n\n![x](javascript:alert(2))\n\n![y](https://evil.test/b.png" onerror="alert(3))';
    await writeFile(page, id, 'evil.md', 'Before.', `Before.\n\n${evil}`);
    await openDiffOfNewest(page);
    await expect(page.locator('#diff-view .rd-added .md-image').first()).toBeVisible();
    await expect(page.locator('#diff-view .rd img, #diff-view .rd script, #diff-view .rd iframe, #diff-view .rd [onerror]')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(dialogs).toEqual([]);
    expect(requests).toEqual([]);
  });
});

test.describe('rich diff of mermaid diagrams', () => {
  const diagram = (to: string) => '```mermaid\ngraph TD\n  A-->' + to + '\n```\n';

  test('an added diagram is drawn in a green section, a removed one in a red section', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await writeFile(page, id, 'd.md', 'Intro.\n', `Intro.\n\n${diagram('B')}`);
    await openDiffOfNewest(page);
    await expect(page.locator('#diff-view .rd-added img.mermaid-img')).toBeVisible({ timeout: 15_000 });
    await page.locator('#diff-close').click();
    const api = agent(page.request, id, (await passwordsOf(page, id)).rw);
    await api.put('/file', { path: 'd.md', content: 'Intro.\n', baseVersion: 2 });
    await openDiffOfNewest(page);
    await expect(page.locator('#diff-view .rd-removed img.mermaid-img')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#diff-view .rd-added')).toHaveCount(0);
  });

  test('a changed diagram shows the old picture (red) above the new one (green), and they differ', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await writeFile(page, id, 'd.md', `Intro.\n\n${diagram('B')}`, `Intro.\n\n${diagram('C')}`);
    await openDiffOfNewest(page);
    const oldOne = page.locator('#diff-view .rd-removed img.mermaid-img');
    const newOne = page.locator('#diff-view .rd-added img.mermaid-img');
    await expect(oldOne).toBeVisible({ timeout: 15_000 });
    await expect(newOne).toBeVisible({ timeout: 15_000 });
    expect(await oldOne.getAttribute('src')).not.toBe(await newOne.getAttribute('src'));
    const [a, b] = [(await oldOne.boundingBox())!, (await newOne.boundingBox())!];
    expect(a.y).toBeLessThan(b.y);                                                      // old above new
    await expect(page.locator('#diff-view ins, #diff-view del')).toHaveCount(0);
    await page.locator('#diff-dlg').screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/rich-mermaid.png` : undefined });
  });

  test('an unchanged diagram folded away is drawn, not shown as code, when the fold is opened', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    const filler = Array.from({ length: 5 }, (_, i) => `Filler ${i} stays.`).join('\n\n');
    const doc = (end: string) => `${filler}\n\n${diagram('B')}\n${filler}\n\n${end}`;
    await writeFile(page, id, 'd.md', doc('The end says old.'), doc('The end says new.'));
    await openDiffOfNewest(page);
    await expect(page.locator('#diff-view .rd-gap')).toBeVisible();
    await expect(page.locator('#diff-view img.mermaid-img')).toHaveCount(0);
    await page.locator('#diff-view .rd-gap').click();
    await expect(page.locator('#diff-view img.mermaid-img')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#diff-view .mermaid-block pre')).toHaveCount(0);
  });

  test('a broken diagram in a diff says so and keeps its source; a new file with a diagram draws it', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    const api = agent(page.request, id, (await passwordsOf(page, id)).rw);
    await api.post('/files', { path: 'bad.md', kind: 'file', content: '```mermaid\nthis is not a diagram\n```\n' });
    await openDiffOfNewest(page);
    await expect(page.locator('#diff-view .mermaid-err')).toContainText('Diagram error', { timeout: 15_000 });
    await expect(page.locator('#diff-view .mermaid-block')).toContainText('this is not a diagram');
    await api.post('/files', { path: 'good.md', kind: 'file', content: diagram('B') });
    await openDiffOfNewest(page);
    await expect(page.locator('#diff-view .rd img.mermaid-img')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#diff-view .rd-added')).toHaveCount(0);                  // a new file is not painted green
  });

  test('switching the theme with the diff open draws the diagrams again', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await writeFile(page, id, 'd.md', `Intro.\n\n${diagram('B')}`, `Intro.\n\n${diagram('C')}`);
    await openDiffOfNewest(page);
    const img = page.locator('#diff-view .rd-added img.mermaid-img');
    await expect(img).toBeVisible({ timeout: 15_000 });
    const light = await img.getAttribute('src');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await expect.poll(async () => await img.getAttribute('src'), { timeout: 15_000 }).not.toBe(light);
  });
});
