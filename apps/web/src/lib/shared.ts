import { auth } from './api';
import { explain } from './errors';
import { icon } from './icons';
import type { Policy, User } from './types';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function setTheme(t: string) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('mdh_theme', t); } catch { /* private mode: the choice just will not stick */ }
}
export const getTheme = () => document.documentElement.dataset.theme || 'light';

export function setSize(v: string) {
  document.documentElement.dataset.size = v;
  try { localStorage.setItem('mdh_size', v); } catch { /* same */ }
}
export const getSize = () => document.documentElement.dataset.size || 'default';

export function toggleTheme(btn: HTMLElement) {
  const sync = () => {
    const dark = getTheme() === 'dark';
    btn.innerHTML = icon(dark ? 'sun' : 'moon');
    btn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  };
  sync();
  btn.onclick = () => { setTheme(getTheme() === 'dark' ? 'light' : 'dark'); sync(); };
}

export function copy(text: string, btn?: HTMLElement) {
  navigator.clipboard?.writeText(text).catch(() => {});
  if (btn) { const old = btn.innerHTML; btn.innerHTML = icon('check') + ' Copied'; setTimeout(() => (btn.innerHTML = old), 1200); }
}

export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

let toastTimer = 0;
/** A short message at the bottom of the page. */
export function toast(msg: string, ms = 5000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.add('hidden'), ms);
}

/** Wires the profile dialog: theme and size are local, the default rollback policy and logging out go to the server. */
export function initProfile(openBtn: HTMLElement, o: { getUser: () => User | null; onUser: (u: User) => void; onLogout: () => void }) {
  const dlg = $<HTMLDialogElement>('profile-dlg');
  const theme = $<HTMLSelectElement>('pf-theme');
  const size = $<HTMLSelectElement>('pf-size');
  const rb = $<HTMLSelectElement>('pf-rollback');
  const err = $('pf-err');
  openBtn.onclick = () => {
    const u = o.getUser();
    if (!u) return;
    $<HTMLInputElement>('pf-username').value = u.username;
    theme.value = getTheme();
    size.value = getSize();
    rb.value = u.defaultRollbackPolicy;
    err.textContent = '';
    dlg.showModal();
  };
  size.onchange = () => setSize(size.value);
  theme.onchange = () => setTheme(theme.value);
  rb.onchange = async () => {
    err.textContent = '';
    try { o.onUser(await auth.setDefaultPolicy(rb.value as Policy)); }
    catch (e) { err.textContent = explain(e); rb.value = o.getUser()?.defaultRollbackPolicy ?? 'author_and_write'; }
  };
  $('pf-close').onclick = () => dlg.close();
  $('pf-logout').onclick = async () => {
    try { await auth.logout(); } catch (e) { err.textContent = explain(e); return; }
    dlg.close();
    o.onLogout();
  };
}
