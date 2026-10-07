import { ApiError, auth, projects as projectsApi } from '../lib/api';
import { explain } from '../lib/errors';
import { matches, timeAgo } from '../lib/format';
import { hydrateIcons, icon } from '../lib/icons';
import { $, esc, initProfile, toast, toggleTheme } from '../lib/shared';
import type { ProjectInfo, User } from '../lib/types';

let user: User | null = null;
let projects: ProjectInfo[] = [];
let mode: 'login' | 'register' = 'login';
let deleting: ProjectInfo | null = null;

const authDlg = $<HTMLDialogElement>('auth-dlg');
const newDlg = $<HTMLDialogElement>('new-dlg');
const delDlg = $<HTMLDialogElement>('del-dlg');
const show = (id: string, on: boolean) => $(id).classList.toggle('hidden', !on);

// ---------- page state ----------
function render() {
  show('landing', !user);
  show('projects', !!user);
  show('login-btn', !user);
  show('start-btn', !user);
  document.body.classList.toggle('on-landing', !user);
  show('profile-btn', !!user);
  if (user) $('profile-btn').innerHTML = icon('user') + `<span class="t">${esc(user.username)}</span>`;
  renderList();
}

function renderList() {
  const query = $<HTMLInputElement>('search').value;
  const shown = projects.filter((p) => matches(p.name, query));
  show('search', projects.length > 0);
  $('project-list').innerHTML = shown
    .map((p) => `<li><a href="/p/${encodeURIComponent(p.id)}"><b class="name">${esc(p.name)}</b><span class="muted">${esc(timeAgo(p.updatedAt))}</span></a>`
      + `<button class="icon-btn" data-del="${esc(p.id)}" title="Delete project" aria-label="Delete ${esc(p.name)}">${icon('trash')}</button></li>`)
    .join('');
  const note = $('empty-note');
  if (!projects.length) note.textContent = 'No projects yet. Create your first one.';
  else if (!shown.length) note.textContent = `No project matches "${query.trim()}".`;
  note.classList.toggle('hidden', !!shown.length);
}

async function loadProjects() {
  try { projects = await projectsApi.list(); }
  catch (e) { toast(explain(e)); }
  renderList();
}

async function boot() {
  show('boot-err', false);
  try {
    user = await auth.me();
  } catch (e) {
    $('boot-err-msg').textContent = explain(e);
    show('boot-err', true);
    return;
  }
  render();
  if (user) await loadProjects();
}

// ---------- log in / register ----------
function setMode(m: typeof mode) {
  mode = m;
  $('tab-login').classList.toggle('on', m === 'login');
  $('tab-register').classList.toggle('on', m === 'register');
  $('au-submit').textContent = m === 'login' ? 'Log in' : 'Create account';
  $<HTMLInputElement>('au-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('au-err').textContent = '';
}
function openAuth(m: typeof mode) {
  setMode(m);
  authDlg.showModal();
  $<HTMLInputElement>('au-user').focus();
}

async function submitAuth() {
  const username = $<HTMLInputElement>('au-user').value.trim();
  const password = $<HTMLInputElement>('au-pass').value;
  const err = $('au-err');
  if (!username) return void (err.textContent = 'Enter a username.');
  if (mode === 'register' && password.length < 8) return void (err.textContent = 'Password needs at least 8 characters.');
  if (!password) return void (err.textContent = 'Enter your password.');
  const btn = $<HTMLButtonElement>('au-submit');
  btn.disabled = true;
  err.textContent = '';
  try {
    user = mode === 'login' ? await auth.login(username, password) : await auth.register(username, password);
    $<HTMLInputElement>('au-pass').value = '';
    authDlg.close();
    render();
    await loadProjects();
  } catch (e) {
    err.textContent = e instanceof ApiError && e.code === 'invalid_input' ? e.message : explain(e);
  } finally {
    btn.disabled = false;
  }
}

// ---------- new project ----------
async function createProject() {
  const name = $<HTMLInputElement>('np-name').value.trim();
  const err = $('np-err');
  if (!name) return void (err.textContent = 'Give it a name.');
  const btn = $<HTMLButtonElement>('np-create');
  btn.disabled = true;
  err.textContent = '';
  try {
    const p = await projectsApi.create(name);
    location.href = `/p/${encodeURIComponent(p.id)}`;
  } catch (e) {
    err.textContent = explain(e);
    btn.disabled = false;
  }
}

// ---------- delete ----------
function askDelete(p: ProjectInfo) {
  deleting = p;
  $('del-name').textContent = p.name;
  $<HTMLInputElement>('del-input').value = '';
  $('del-err').textContent = '';
  $<HTMLButtonElement>('del-go').disabled = true;
  delDlg.showModal();
  $<HTMLInputElement>('del-input').focus();
}

async function confirmDelete() {
  if (!deleting) return;
  const p = deleting;
  const btn = $<HTMLButtonElement>('del-go');
  btn.disabled = true;
  try {
    await projectsApi.remove(p.id);
    projects = projects.filter((x) => x.id !== p.id);
    delDlg.close();
    renderList();
    toast(`Deleted "${p.name}".`);
  } catch (e) {
    $('del-err').textContent = explain(e);
    btn.disabled = false;
  }
}

// ---------- wiring ----------
const onEnter = (id: string, fn: () => void) => $(id).addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') fn(); });

toggleTheme($('theme-btn'));
$('login-btn').onclick = () => openAuth('login');
$('landing-btn').onclick = () => openAuth('register');
$('landing-btn-2').onclick = () => openAuth('register');
$('start-btn').onclick = () => openAuth('register');
$('tab-login').onclick = () => setMode('login');
$('tab-register').onclick = () => setMode('register');
$('au-cancel').onclick = () => authDlg.close();
$('au-submit').onclick = submitAuth;
onEnter('au-user', submitAuth); onEnter('au-pass', submitAuth);

$('new-btn').onclick = () => { $<HTMLInputElement>('np-name').value = ''; $('np-err').textContent = ''; $<HTMLButtonElement>('np-create').disabled = false; newDlg.showModal(); $<HTMLInputElement>('np-name').focus(); };
$('np-cancel').onclick = () => newDlg.close();
$('np-create').onclick = createProject;
onEnter('np-name', createProject);

$('search').addEventListener('input', renderList);
$('project-list').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-del]')?.dataset.del;
  const p = projects.find((x) => x.id === id);
  if (p) askDelete(p);
});
$('del-cancel').onclick = () => delDlg.close();
$('del-input').addEventListener('input', () => { $<HTMLButtonElement>('del-go').disabled = $<HTMLInputElement>('del-input').value.trim() !== deleting?.name; });
$('del-go').onclick = confirmDelete;
onEnter('del-input', () => { if (!$<HTMLButtonElement>('del-go').disabled) void confirmDelete(); });

$('boot-retry').onclick = boot;
initProfile($('profile-btn'), {
  getUser: () => user,
  onUser: (u) => { user = u; },
  onLogout: () => { user = null; projects = []; render(); },
});
hydrateIcons();
void boot();
