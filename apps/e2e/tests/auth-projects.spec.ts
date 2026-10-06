import { expect, test, PASSWORD, createProject, register, uniqueName, watchProblems } from './helpers';

test.describe('accounts and the project list', () => {
  test('a visitor sees the landing page and can register, log out and log in again', async ({ page }) => {
    const problems = watchProblems(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Miracles Don't Happen/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    await expect(page.locator('#projects')).toBeHidden();

    const username = await register(page);
    await expect(page.locator('#profile-btn')).toContainText(username);
    await expect(page.locator('#empty-note')).toHaveText('No projects yet. Create your first one.');

    await page.locator('#profile-btn').click();
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByRole('heading', { name: /Miracles Don't Happen/ })).toBeVisible();

    await page.getByRole('button', { name: 'Log in' }).click();
    await page.locator('#au-user').fill(username.toUpperCase());      // usernames are not case sensitive
    await page.locator('#au-pass').fill(PASSWORD);
    await page.locator('#au-submit').click();
    await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('says what is wrong: short password, bad name, taken name, wrong password', async ({ page }) => {
    const taken = await register(page);
    await page.locator('#profile-btn').click();
    await page.getByRole('button', { name: 'Log out' }).click();

    await page.getByRole('button', { name: 'Get started' }).click();
    await page.locator('#au-user').fill(uniqueName());
    await page.locator('#au-pass').fill('short');
    await page.locator('#au-submit').click();
    await expect(page.locator('#au-err')).toHaveText('Password needs at least 8 characters.');

    await page.locator('#au-user').fill('Sam Lee');
    await page.locator('#au-pass').fill(PASSWORD);
    await page.locator('#au-submit').click();
    await expect(page.locator('#au-err')).toContainText('Username: 3-32 letters');

    await page.locator('#au-user').fill(taken);
    await page.locator('#au-submit').click();
    await expect(page.locator('#au-err')).toHaveText('That username is taken');

    await page.locator('#tab-login').click();
    await page.locator('#au-pass').fill('not-the-password');
    await page.locator('#au-submit').click();
    await expect(page.locator('#au-err')).toHaveText('Wrong username or password');
  });

  test('Enter submits the login form', async ({ page }) => {
    const username = await register(page);
    await page.locator('#profile-btn').click();
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.locator('#au-user').fill(username);
    await page.locator('#au-pass').fill(PASSWORD);
    await page.locator('#au-pass').press('Enter');
    await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  });

  test('create, search and delete projects', async ({ page }) => {
    await register(page);
    await createProject(page, 'Product Notes');
    await page.goto('/');
    await createProject(page, 'Agent Prompts');
    await page.goto('/');
    await createProject(page, 'Türkçe Proje');
    await page.goto('/');

    const names = page.locator('#project-list .name');
    await expect(names).toHaveText(['Türkçe Proje', 'Agent Prompts', 'Product Notes']);   // newest activity first

    await page.locator('#search').fill('AGENT');
    await expect(names).toHaveText(['Agent Prompts']);
    await page.locator('#search').fill('nothing like this');
    await expect(page.locator('#empty-note')).toHaveText('No project matches "nothing like this".');
    await page.locator('#search').fill('');
    await expect(names).toHaveCount(3);

    // deleting asks for the project name
    await page.getByRole('button', { name: 'Delete Agent Prompts' }).click();
    const del = page.getByRole('button', { name: 'Delete project' });
    await expect(del).toBeDisabled();
    await page.locator('#del-input').fill('agent prompts');          // wrong case: still disabled
    await expect(del).toBeDisabled();
    await page.locator('#del-input').fill('Agent Prompts');
    await expect(del).toBeEnabled();
    await del.click();
    await expect(names).toHaveText(['Türkçe Proje', 'Product Notes']);
    await page.reload();
    await expect(names).toHaveText(['Türkçe Proje', 'Product Notes']);   // really gone on the server
  });

  test('a deleted project is gone for everyone', async ({ page, browser }) => {
    await register(page);
    const id = await createProject(page, 'Short lived');
    const pw = await page.evaluate(async (pid) => (await fetch(`/api/projects/${pid}/passwords`)).json(), id);
    await page.goto('/');
    await page.getByRole('button', { name: 'Delete Short lived' }).click();
    await page.locator('#del-input').fill('Short lived');
    await page.getByRole('button', { name: 'Delete project' }).click();
    await expect(page.locator('#project-list li')).toHaveCount(0);

    const other = await browser.newContext();
    const res = await other.request.get(`/api/projects/${id}`, { headers: { Authorization: `Bearer ${pw.rw}` } });
    expect(res.status()).toBe(401);
    await other.close();
  });

  test('theme and text size are remembered', async ({ page }) => {
    await register(page);
    await page.locator('#theme-btn').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('#profile-btn').click();
    await page.locator('#pf-size').selectOption('big');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-size', 'big');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('17px');
  });

  test('the default rollback policy of the profile is used for new projects', async ({ page }) => {
    await register(page);
    await page.locator('#profile-btn').click();
    await page.locator('#pf-rollback').selectOption('author_only');
    await page.getByRole('button', { name: 'Done' }).click();
    const id = await createProject(page, 'Strict');
    const policy = await page.evaluate(async (pid) => (await (await fetch(`/api/projects/${pid}`)).json()).project.rollbackPolicy, id);
    expect(policy).toBe('author_only');
  });
});
