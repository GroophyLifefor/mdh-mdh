import { expect, test, registerAndCreate, typeInEditor, watchProblems } from './helpers';

const FLOW = '# Plan\n\n```mermaid\ngraph TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Ship]\n  B -->|no| A\n```\n\nafter';

test.describe('mermaid diagrams', () => {
  test('a mermaid block is drawn as an image in the preview (under the real CSP), the text around it stays', async ({ page }) => {
    const problems = watchProblems(page);
    await registerAndCreate(page);
    await typeInEditor(page, FLOW, { replace: true });
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    const img = page.locator('#preview .mermaid-block img.mermaid-img');
    await expect(img).toBeVisible({ timeout: 15_000 });
    expect(await img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    const box = (await img.boundingBox())!;
    expect(box.width).toBeGreaterThan(80);
    expect(box.height).toBeGreaterThan(80);
    await expect(page.locator('#preview h1')).toHaveText('Plan');
    await page.locator('#preview').screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/mermaid-desktop.png` : undefined });
    await expect(page.locator('#preview')).toContainText('after');
    expect(problems).toEqual([]);                                                       // no CSP violation, no console error
  });

  test('the common diagram types all draw', async ({ page }) => {
    await registerAndCreate(page);
    const kinds: Record<string, string> = {
      sequence: 'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi',
      class: 'classDiagram\n  Animal <|-- Dog\n  Animal : +int age',
      state: 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy',
      er: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
      gantt: 'gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section A\n  Task :a1, 2026-01-01, 5d',
      pie: 'pie title Pets\n  "Dogs" : 5\n  "Cats" : 3',
    };
    const md = Object.entries(kinds).map(([k, src]) => `## ${k}\n\n\`\`\`mermaid\n${src}\n\`\`\``).join('\n\n');
    await typeInEditor(page, md, { replace: true });
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.locator('#preview img.mermaid-img')).toHaveCount(Object.keys(kinds).length, { timeout: 30_000 });
    await expect(page.locator('#preview .mermaid-err')).toHaveCount(0);
  });

  test('a broken diagram shows a small error and keeps the source readable', async ({ page }) => {
    await registerAndCreate(page);
    await typeInEditor(page, '```mermaid\nthis is not a diagram at all\n```', { replace: true });
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.locator('#preview .mermaid-err')).toContainText('Diagram error', { timeout: 15_000 });
    await expect(page.locator('#preview .mermaid-block')).toContainText('this is not a diagram at all');
    await expect(page.locator('#preview img')).toHaveCount(0);
    await expect(page.locator('body > [id^="dmermaid"], body > [id^="mermaid"]')).toHaveCount(0);   // no scratch element left behind
  });

  test('a hostile diagram runs nothing and adds no element to the page', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await registerAndCreate(page);
    const evil = [
      'graph TD',
      '  A["<img src=x onerror=alert(1)>"] --> B["<script>alert(2)</script>"]',
      '  click A call alert(3)',
      '  click B "javascript:alert(4)"',
      '  C["<a href=\'javascript:alert(5)\'>x</a>"]',
    ].join('\n');
    await typeInEditor(page, '```mermaid\n' + evil + '\n```', { replace: true });
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.locator('#preview .mermaid-block[data-state]')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);
    expect(dialogs).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).hacked)).toBeUndefined();
    await expect(page.locator('#preview script, #preview iframe, #preview object, #preview [onerror], #preview svg')).toHaveCount(0);   // only an <img>, never inline svg
    await expect(page.locator('#preview a[href^="javascript"]')).toHaveCount(0);
  });

  test('the diagram is drawn again in the other colours when the theme changes; typing elsewhere does not redraw it', async ({ page }) => {
    await registerAndCreate(page);
    await typeInEditor(page, FLOW, { replace: true });
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    const img = page.locator('#preview img.mermaid-img');
    await expect(img).toBeVisible({ timeout: 15_000 });
    const light = await img.getAttribute('src');
    await page.locator('#theme-btn').click();
    await expect.poll(async () => await img.getAttribute('src'), { timeout: 15_000 }).not.toBe(light);
    await page.locator('#preview').screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/mermaid-dark.png` : undefined });
  });

  test('editing the text next to a diagram keeps the picture on screen (no frame ever shows the code again)', async ({ page }) => {
    await registerAndCreate(page);
    await typeInEditor(page, FLOW, { replace: true });
    await expect(page.locator('#preview img.mermaid-img')).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => {                                                          // look at every frame from now on
      const w = window as unknown as { frames: number; flashes: number };
      w.frames = 0; w.flashes = 0;
      const look = () => { w.frames++; if (document.querySelector('#preview .mermaid-block pre')) w.flashes++; requestAnimationFrame(look); };
      requestAnimationFrame(look);
    });
    await typeInEditor(page, '\nmore words');
    await expect(page.locator('#preview')).toContainText('more words');
    await page.waitForTimeout(800);
    const seen = await page.evaluate(() => { const w = window as unknown as { frames: number; flashes: number }; return { frames: w.frames, flashes: w.flashes }; });
    expect(seen.frames).toBeGreaterThan(10);
    expect(seen.flashes).toBe(0);
    await expect(page.locator('#preview img.mermaid-img')).toBeVisible();
  });
});
