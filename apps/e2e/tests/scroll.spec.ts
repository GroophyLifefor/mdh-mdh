// Split mode: scrolling the editor moves the preview to the same place in the text, and the other way round.
import { agent, expect, passwordsOf, registerAndCreate, test, watchProblems } from './helpers';
import type { Page } from '@playwright/test';

/** 120 sections of different heights: plain text, long code blocks, tables and diagrams, every line says which section it belongs to. */
function longDoc(tallDiagramsEvery = 0): string {
  const out: string[] = ['# Long document'];
  for (let i = 1; i <= 120; i++) {
    out.push(`\n## Section ${i}\n\nThis paragraph belongs to Section ${i} and it is written long enough to wrap onto a second line in the narrow half of a split screen, which makes its source line taller than one row.`);
    if (i % 10 === 0) out.push('\n```ts\n' + Array.from({ length: 14 }, (_, k) => `// code line ${k} of Section ${i}`).join('\n') + '\n```');
    if (i % 15 === 0) out.push(`\n| Section ${i} | b |\n|---|---|\n| row 1 of Section ${i} | x |\n| row 2 of Section ${i} | y |`);
    if (i % 30 === 0) out.push(`\n\`\`\`mermaid\ngraph TD\n  A["Section ${i}"] --> B\n\`\`\``);
    if (tallDiagramsEvery && i % tallDiagramsEvery === 0 && i % 30 !== 0) out.push(`\n\`\`\`mermaid\ngraph TD\n  A["Section ${i}"] --> B --> C --> D --> E --> F\n\`\`\``);
  }
  return out.join('\n') + '\n';
}

async function openLongDoc(page: Page) {
  const { id } = await registerAndCreate(page);
  const api = agent(page.request, id, (await passwordsOf(page, id)).rw);
  await api.put('/file', { path: 'readme.md', content: longDoc(), baseVersion: 1 });
  await page.reload();
  await expect(page.locator('#editor.split')).toBeVisible();                              // split is the default
  await expect(page.locator('#preview h2').first()).toBeVisible();
  await expect(page.locator('#preview img.mermaid-img').first()).toBeVisible({ timeout: 20_000 });   // diagrams are drawn: the preview has its final heights
  await page.waitForTimeout(300);
  return id;
}

/** The section number at the top of each side (the first visible line / block that names one). */
const tops = (page: Page) => page.evaluate(() => {
  const num = (t: string | null) => { const m = /Section (\d+)/.exec(t ?? ''); return m ? Number(m[1]) : null; };
  const ed = document.querySelector('.cm-scroller') as HTMLElement, pv = document.getElementById('preview')!;
  let editor: number | null = null, preview: number | null = null;
  for (const l of document.querySelectorAll('.cm-line')) if (l.getBoundingClientRect().bottom > ed.getBoundingClientRect().top + 2 && num(l.textContent) !== null) { editor = num(l.textContent); break; }
  for (const b of pv.querySelectorAll('[data-line]')) if (b.getBoundingClientRect().bottom > pv.getBoundingClientRect().top + 2 && num(b.textContent) !== null) { preview = num(b.textContent); break; }
  return { editor, preview, ed: ed.scrollTop, pv: pv.scrollTop };
});
const scrollEditor = (page: Page, frac: number) => page.evaluate((f) => { const e = document.querySelector('.cm-scroller') as HTMLElement; e.scrollTop = f * (e.scrollHeight - e.clientHeight); }, frac);
const scrollPreview = (page: Page, frac: number) => page.evaluate((f) => { const p = document.getElementById('preview')!; p.scrollTop = f * (p.scrollHeight - p.clientHeight); }, frac);

test.describe('scrolling together in split mode', () => {
  test('scrolling the editor brings the preview to the same section, wherever in the document', async ({ page }) => {
    await openLongDoc(page);
    for (const frac of [0.1, 0.25, 0.4, 0.5, 0.63, 0.8, 0.9]) {
      await scrollEditor(page, frac);
      await page.waitForTimeout(250);
      const t = await tops(page);
      expect(t.editor, `editor at ${frac}`).not.toBeNull();
      expect(t.preview, `preview at ${frac}`).not.toBeNull();
      expect(Math.abs(t.editor! - t.preview!), `editor shows Section ${t.editor}, preview Section ${t.preview} (at ${frac})`).toBeLessThanOrEqual(1);
    }
  });

  test('scrolling the preview brings the editor to the same section', async ({ page }) => {
    await openLongDoc(page);
    for (const frac of [0.15, 0.33, 0.5, 0.7, 0.88]) {
      await scrollPreview(page, frac);
      await page.waitForTimeout(250);
      const t = await tops(page);
      expect(Math.abs(t.editor! - t.preview!), `preview Section ${t.preview}, editor Section ${t.editor} (at ${frac})`).toBeLessThanOrEqual(1);
    }
  });

  test('the top and the bottom match, so the last section can be read in both', async ({ page }) => {
    await openLongDoc(page);
    await scrollEditor(page, 1);
    await page.waitForTimeout(250);
    const end = await page.evaluate(() => { const p = document.getElementById('preview')!; return p.scrollHeight - p.clientHeight - p.scrollTop; });
    expect(end).toBeLessThan(3);                                                          // the preview is at its very end too
    await scrollEditor(page, 0);
    await page.waitForTimeout(250);
    expect((await tops(page)).pv).toBe(0);
    await scrollPreview(page, 1);
    await page.waitForTimeout(250);
    const edEnd = await page.evaluate(() => { const e = document.querySelector('.cm-scroller') as HTMLElement; return e.scrollHeight - e.clientHeight - e.scrollTop; });
    expect(edEnd).toBeLessThan(3);
  });

  test('it settles: no back and forth between the two sides after a scroll', async ({ page }) => {
    await openLongDoc(page);
    await page.evaluate(() => {
      const w = window as unknown as { events: number };
      w.events = 0;
      document.getElementById('preview')!.addEventListener('scroll', () => w.events++);
      document.querySelector('.cm-scroller')!.addEventListener('scroll', () => w.events++);
    });
    await scrollEditor(page, 0.5);
    await page.waitForTimeout(400);
    const a = await tops(page);
    const eventsAfter = await page.evaluate(() => (window as unknown as { events: number }).events);
    await page.waitForTimeout(600);
    const b = await tops(page);
    expect(b.pv).toBe(a.pv);                                                              // nothing moves any more
    expect(b.ed).toBe(a.ed);
    expect(eventsAfter, 'one scroll causes one answer, not a chain').toBeLessThanOrEqual(4);
    expect(await page.evaluate(() => (window as unknown as { events: number }).events)).toBe(eventsAfter);
  });

  test('inside a tall block the two sides move in proportion (a 14-line code block is not skipped over)', async ({ page }) => {
    await openLongDoc(page);
    await scrollEditor(page, 0.5);
    await page.waitForTimeout(250);
    const before = (await tops(page)).pv;
    await page.evaluate(() => { const e = document.querySelector('.cm-scroller') as HTMLElement; e.scrollTop += 60; });   // a few lines further
    await page.waitForTimeout(250);
    const after = (await tops(page)).pv;
    expect(after, 'the preview moved with it').toBeGreaterThan(before);
    expect(after - before, 'and by a sensible amount').toBeLessThan(400);
  });

  test('Edit only and Preview only are not affected; going back to Split lines the preview up again', async ({ page }) => {
    const problems = watchProblems(page);
    await openLongDoc(page);
    await scrollEditor(page, 0.6);
    await page.waitForTimeout(250);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await scrollEditor(page, 0.3);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await scrollPreview(page, 0.8);
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await page.waitForTimeout(400);
    const t = await tops(page);
    expect(Math.abs(t.editor! - t.preview!)).toBeLessThanOrEqual(1);
    expect(problems).toEqual([]);
  });

  test('a change in the text keeps the two sides together', async ({ page }) => {
    await openLongDoc(page);
    await scrollEditor(page, 0.5);
    await page.waitForTimeout(250);
    await page.locator('.cm-line', { hasText: /Section/ }).first().click();             // put the cursor in the middle of the document
    await page.keyboard.type(' EXTRA WORDS ADDED HERE ');
    await page.waitForTimeout(500);
    const t = await tops(page);
    expect(Math.abs(t.editor! - t.preview!), `editor Section ${t.editor}, preview Section ${t.preview}`).toBeLessThanOrEqual(1);
  });

  test('diagrams drawn AFTER the scroll make the preview taller; the two sides still end up together (also without the browser\'s own scroll anchoring, which Safari lacks)', async ({ page }) => {
    const { id } = await registerAndCreate(page);
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = '#preview { overflow-anchor: none; }'; document.head.append(st); }));
    await agent(page.request, id, (await passwordsOf(page, id)).rw).put('/file', { path: 'readme.md', content: longDoc(5), baseVersion: 1 });
    await page.reload();
    await expect(page.locator('#preview h2').first()).toBeVisible();
    await scrollEditor(page, 0.8);                                                      // far below the diagrams, which are not drawn yet
    await expect(page.locator('#preview img.mermaid-img')).toHaveCount(24, { timeout: 60_000 });
    await page.waitForTimeout(500);
    const t = await tops(page);
    expect(Math.abs(t.editor! - t.preview!), `editor Section ${t.editor}, preview Section ${t.preview}`).toBeLessThanOrEqual(1);
  });
});
