// Screenshots of the approved design. A change in how the pages LOOK fails these tests until someone looks at the
// difference and runs `pnpm --filter @mdh/e2e test:update`.
import type { Page } from '@playwright/test';
import { expect, test, agent, passwordsOf, registerAndCreate } from './helpers';

const README = '# Product Notes\n\nWelcome! Pick a file on the left.\n\n```ts\nconst answer: number = 42; // yes\n```\n\n- Simple\n- **Friendly**\n';

/** Things that differ on every run: random user name, "2 min ago", and nothing else. */
const dynamic = (page: Page) => [page.locator('#profile-btn'), page.locator('#history .muted'), page.locator('.list .muted'), page.locator('#toast')];

async function seedProject(page: Page, request: Parameters<typeof agent>[0]) {
  const { id } = await registerAndCreate(page, 'Product Notes');
  const { rw } = await passwordsOf(page, id);
  const bot = agent(request, id, rw, 'claude');
  const f = (await (await bot.get('/file?path=readme.md')).json()).file;
  await bot.put('/file', { path: 'readme.md', content: README, baseVersion: f.version });
  await bot.post('/upload', { files: [
    { path: 'notes/spec.md', content: '# Spec\n\n- one\n- two\n' }, { path: 'notes/config.yml', content: 'name: demo\nlevel: 1\nitems:\n  - a\n  - b\n' }, { path: 'todo.md', content: '- [ ] ship it\n' },
  ] });
  await page.reload();
  await expect(page.locator('#bar .name')).toHaveText('readme.md');
  await expect(page.locator('#history .change').first()).toContainText('uploaded 3 files');
  return id;
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => { try { localStorage.setItem('mdh_theme', t); } catch { /* none */ } }, theme);
    });

    test('home: landing', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: /shared with your agents/ })).toBeVisible();
      await expect(page).toHaveScreenshot(`home-landing-${theme}.png`);
    });

    test('home: project list', async ({ page }) => {
      await registerAndCreate(page, 'Product Notes');
      await page.goto('/');
      await page.getByRole('button', { name: 'New project' }).click();
      await page.locator('#np-name').fill('Agent Prompts');
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await page.waitForURL(/\/p\//);
      await page.goto('/');
      await expect(page.locator('#project-list li')).toHaveCount(2);
      await expect(page).toHaveScreenshot(`home-projects-${theme}.png`, { mask: dynamic(page) });
    });

    test('project page (the history starts closed)', async ({ page, request }) => {
      await seedProject(page, request);
      await expect(page.locator('aside.hist')).toBeHidden();
      await expect(page).toHaveScreenshot(`project-${theme}.png`, { mask: dynamic(page) });
    });

    test('project page with the history open', async ({ page, request }) => {
      await seedProject(page, request);
      await page.locator('#toggle-hist').click();
      await page.locator('.change', { hasText: 'uploaded 3 files' }).click();
      await expect(page.locator('#history .paths')).toBeVisible();
      await expect(page).toHaveScreenshot(`project-history-${theme}.png`, { mask: dynamic(page) });
    });

    test('project page: yaml file', async ({ page, request }) => {
      await seedProject(page, request);
      await page.locator('#tree .node[data-path="notes/config.yml"]').click();
      await expect(page.locator('#status')).toContainText('yaml ok');
      await expect(page).toHaveScreenshot(`project-yaml-${theme}.png`, { mask: dynamic(page) });
    });

    test('dialogs: share and project settings', async ({ page, request }) => {
      await seedProject(page, request);
      await page.getByRole('button', { name: 'Share' }).click();
      await expect(page.locator('#sh-prompt')).not.toHaveValue('');
      await expect(page.locator('#share-dlg')).toHaveScreenshot(`dialog-share-${theme}.png`, { mask: [page.locator('#sh-url'), page.locator('#sh-pw'), page.locator('#sh-prompt')] });
      await page.locator('#sh-close').click();
      await page.locator('#gear-btn').click();
      await expect(page.locator('#settings-dlg')).toHaveScreenshot(`dialog-settings-${theme}.png`);
    });
  });
}

test.describe('text sizes', () => {
  for (const size of ['tiny', 'big'] as const) {
    test(`project page, ${size} text`, async ({ page, request }) => {
      await page.addInitScript((s) => { try { localStorage.setItem('mdh_size', s); } catch { /* none */ } }, size);
      await seedProject(page, request);
      await page.locator('#toggle-hist').click();
      await expect(page).toHaveScreenshot(`project-size-${size}.png`, { mask: dynamic(page) });
    });
  }
});
