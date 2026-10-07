// Makes the pictures of the landing page from the REAL app, filled with a small demo project.
// Not part of the normal run: LANDING_SHOTS=1 npx playwright test tests/landing-shots.spec.ts --project=chromium
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { devices, type Page } from '@playwright/test';
import { agent, expect, passwordsOf, register, test } from './helpers';

test.skip(!process.env.LANDING_SHOTS, 'run on demand: LANDING_SHOTS=1');
test.use({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1.5 });

const OUT = resolve(process.cwd(), '../web/public/landing');

const README = `# Product handbook

Everything our team and our agents need to know, in one quiet place.

## How we work

- Plans live in \`specs/\`, meeting notes in \`notes/\`, settings in \`config/\`.
- Every change is kept. If something looks wrong, roll it back.
- Agents are welcome. They write in the same files, under their own name.

## This week

The search project is in review. The details are in the search spec.
`;
const README2 = README.replace('is in review', 'is ready for review');

const SEARCH_V1 = `# Search

Search helps people find a page in a few keystrokes.

## Goals

- Results appear while typing.
- Titles rank higher than body text.

## How it works

\`\`\`mermaid
graph LR
  A[Query] --> B[Index]
  B --> C[Results]
\`\`\`

## Requirements

| Requirement | Owner | Status |
|---|---|---|
| Index titles | Mia | Done |
| Index body text | Jo | In progress |

## Open questions

Should archived pages show up in results?
`;
const SEARCH_V2 = `# Search

Search helps people find a page in a few keystrokes.

## Goals

- Results appear while typing, in under 100 ms.
- Titles rank higher than body text.
- Typos are forgiven.

## How it works

\`\`\`mermaid
graph LR
  A[Query] --> B[Index]
  B --> D[Ranking]
  D --> C[Results]
\`\`\`

## Requirements

| Requirement | Owner | Status |
|---|---|---|
| Index titles | Mia | Done |
| Index body text | Jo | Done |
| Typo tolerance | Agent | Proposed |

## Open questions

Should archived pages show up in results? Proposal: yes, below the live pages.

## Rollout

Ship to ten percent of users first, then widen once the error rate stays flat.
`;
const STANDUP = `# Stand-up, Tuesday

- Mia: title index is done, writing the ranking notes.
- Jo: body text index is almost there.
- Next: review the search spec on Thursday.
`;
const RELEASE = `# Release settings
release:
  name: search-v2
  date: 2026-11-03
  owners:
    - mia
    - jo
  checks:
    - unit-tests
    - accessibility
  notify:
    channel: "#launches"
`;
const STATUS = `# Weekly status

Search is on track for the third of November.

- Done: title index, body text index.
- Next: typo tolerance, ranking review.
- Risk: none right now.
`;

async function owner(page: Page, method: string, url: string, body?: unknown) {
  return page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    if (!r.ok) throw new Error(`${m} ${u} -> ${r.status} ${await r.text()}`);
    return r.json();
  }, [method, url, body ?? null] as const);
}

/** One picture in light, then the same view in dark. */
async function shoot(page: Page, name: string, target: () => Promise<void> | { screenshot: (o: object) => Promise<Buffer> }) {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; localStorage.setItem('mdh_theme', t); }, theme);
    await page.waitForTimeout(900);                                                      // diagrams are drawn again in the other colours
    const el = (typeof target === 'function' ? await target() : target) as unknown as { screenshot: (o: object) => Promise<Buffer> } | void;
    const shooter = el ?? page;
    await (shooter as { screenshot: (o: object) => Promise<Buffer> }).screenshot({ path: `${OUT}/${name}-${theme}.jpg`, type: 'jpeg', quality: 86 });
  }
}

test('landing pictures', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });
  await page.route('**/api/config', (route) => route.fulfill({ json: { publicUrl: 'https://mdh.example.com' } }));   // the Share dialog shows a believable address
  await register(page, 'alex');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.locator('#np-name').fill('Product handbook');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/p\/[0-9a-f-]{36}/);
  const id = new URL(page.url()).pathname.split('/')[2]!;
  await expect(page.locator('#bar .name')).toHaveText('readme.md');

  // the story: the owner writes, an agent edits and adds
  await owner(page, 'PUT', `/api/projects/${id}/file`, { path: 'readme.md', content: README, baseVersion: 1 });
  await owner(page, 'POST', `/api/projects/${id}/upload`, { files: [{ path: 'specs/search.md', content: SEARCH_V1 }, { path: 'notes/standup.md', content: STANDUP }, { path: 'config/release.yml', content: RELEASE }] });
  await owner(page, 'PUT', `/api/projects/${id}/file`, { path: 'readme.md', content: README2, baseVersion: 2 });
  const pw = await passwordsOf(page, id);
  const claude = agent(page.request, id, pw.rw, 'Claude Code');
  const read = await (await claude.get('/file?path=specs%2Fsearch.md')).json();
  await claude.put('/file', { path: 'specs/search.md', content: SEARCH_V2, baseVersion: read.file.version });
  await claude.post('/files', { path: 'notes/weekly-status.md', kind: 'file', content: STATUS });

  // 1. the app (hero)
  await page.goto(`/p/${id}?file=specs%2Fsearch.md`);
  await expect(page.locator('#preview img.mermaid-img')).toBeVisible({ timeout: 20_000 });
  await page.locator('#tree .node[data-path="specs"]').scrollIntoViewIfNeeded();
  await shoot(page, 'app', async () => {});

  // 2. Share (a narrower window keeps the text readable when the picture is shown small)
  await page.setViewportSize({ width: 820, height: 760 });
  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.locator('#sh-prompt')).not.toHaveValue('');
  await page.waitForTimeout(200);
  await shoot(page, 'share', async () => page.locator('#share-dlg') as never);
  await page.locator('#sh-close').click();

  // 3. the history with the agent's work (needed for the diff; not a picture of its own)
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.locator('#toggle-hist').click();
  await expect(page.locator('#history .change')).toHaveCount(6);
  await page.setViewportSize({ width: 860, height: 800 });

  // 4. the rich diff of the agent's edit
  await page.locator('#history .change').nth(1).getByRole('button', { name: /Show what changed/ }).click();
  await expect(page.locator('#diff-view .rd-changed').first()).toBeVisible();
  await expect(page.locator('#diff-view img.mermaid-img').first()).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => { const m = document.getElementById('diff-meta'); if (m) m.textContent = 'pw: Claude Code · yesterday'; });
  await shoot(page, 'diff', async () => page.locator('#diff-dlg') as never);
  await page.locator('#diff-close').click();

  // 5. yaml, without the file tree, cut after the first lines
  await page.setViewportSize({ width: 860, height: 700 });
  await page.locator('#toggle-hist').click();
  await page.locator('#toggle-tree').click();
  await page.locator('#toggle-tree').click();      // (open again: the tree is needed to pick the file)
  const yml = page.locator('#tree .node[data-path="config/release.yml"] .label');
  if (!(await yml.isVisible())) await page.locator('#tree .node[data-path="config"] .label').click();
  await yml.click({ timeout: 10_000 });
  await expect(page.locator('#bar .name')).toHaveText('config/release.yml');
  await page.locator('#toggle-tree').click();
  await page.waitForTimeout(300);
  const box = (await page.locator('section.center').boundingBox())!;
  await shoot(page, 'yaml', async () => ({ screenshot: (o: object) => page.screenshot({ ...o, clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 400) } }) }));

  // 6. the password gate, as somebody who only has the link
  const stranger = await browser.newContext({ viewport: { width: 600, height: 560 }, deviceScaleFactor: 1.5, baseURL });
  const guest = await stranger.newPage();
  await guest.goto(`/p/${id}`);
  await expect(guest.locator('#gate-proj')).toHaveText('Product handbook');
  await shoot(guest, 'gate', async () => guest.locator('#gate-dlg') as never);
  await stranger.close();

  // 7. a phone
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], deviceScaleFactor: 2, baseURL, storageState: await page.context().storageState() });
  const phone = await phoneCtx.newPage();
  await phone.goto(`/p/${id}?file=specs%2Fsearch.md`);
  await expect(phone.locator('#bar .name')).toHaveText('specs/search.md');
  await phone.getByRole('button', { name: 'Preview', exact: true }).tap();
  await expect(phone.locator('#preview img.mermaid-img')).toBeVisible({ timeout: 20_000 });
  await shoot(phone, 'phone', async () => {});
  await phoneCtx.close();
});
