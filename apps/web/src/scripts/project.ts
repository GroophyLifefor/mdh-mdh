import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { yaml as yamlLang } from '@codemirror/lang-yaml';
import YAML from 'yaml';
import { ApiError, auth, files, projects as projectsApi } from '../lib/api';
import { Autosave, type SaveState } from '../lib/autosave';
import { explain, lostAccess } from '../lib/errors';
import { timeAgo } from '../lib/format';
import { mergeHistory } from '../lib/history';
import { hydrateIcons, icon } from '../lib/icons';
import { renderMarkdownLines, renderMarkdownShowingImages } from '../lib/markdown';
import { buildAnchors, lineToTop, topToLine, type Anchor } from '../lib/scrollsync';
import { richDiff } from '../lib/richdiff';
import { renderMermaid } from '../lib/mermaid';
import { countChanges, diffLines, withContext } from '../lib/diff';
import { buildRows, orderedPaths, parentsOf, summarize, type ChangedFile } from '../lib/difftree';
import { join, nameError, parentOf } from '../lib/paths';
import { $, copy, esc, initProfile, toast, toggleTheme } from '../lib/shared';
import { sharePrompt } from '../lib/share';
import { siteUrl } from '../lib/site';
import { mdhHighlight } from '../lib/syntax';
import { dirPaths, dropPaths, remapPath, remapPaths, visibleRows } from '../lib/tree';
import type { Access, ChangeDetail, ChangeInfo, Mode, Policy, ProjectInfo, TreeNode, User } from '../lib/types';
import { collectDrop, describeSkipped, prepareUpload, snapshotDrop } from '../lib/upload';

// ---------- constants ----------
const AUTOSAVE_MS = 1000;       // save this long after the last keystroke
const POLL_MS = 10_000;         // look for changes made by other people (or agents) this often
const HISTORY_PAGE = 50;
const MAX_LISTED_PATHS = 30;    // paths shown when a history entry is opened

// ---------- state ----------
const projectId = decodeURIComponent(location.pathname.split('/')[2] ?? '');
let user: User | null = null;
let info: ProjectInfo;
let access: Access;
let nodes: TreeNode[] = [];
let current: string | null = null;
let currentVersion = 0;
let view: EditorView | null = null;
let autosave: Autosave | null = null;
let saveState: SaveState = 'idle';
let closed = new Set<string>();       // collapsed folders (everything else is open)
let selDir = '';                      // folder that new files/folders go into
let editing: { kind: 'create-file' | 'create-folder' | 'rename'; at: string } | null = null;
let mdMode: 'edit' | 'split' | 'preview' = 'split';
let history: ChangeInfo[] = [];
let nextBefore: number | null = null;
let selSeq: number | null = null;
const details = new Map<number, ChangeDetail>();
let lastKey = '';                     // newest history entry we have seen, to notice changes by others
let busy = 0;                         // mutations in flight
let polling = false;
let gateOpen = false;
let started = false;

// ---------- phones: one panel at a time ----------
type Tab = 'files' | 'editor' | 'history';
const mobileQuery = matchMedia('(max-width: 800px)');      // keep in step with the breakpoint in global.css
const isMobile = () => mobileQuery.matches;

function setTab(tab: Tab) {
  $('work').dataset.tab = tab;
  document.querySelectorAll<HTMLElement>('#tabbar button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (tab !== 'editor') void flushAutosave();    // leaving the editor: nothing waits in the background
}
document.querySelectorAll<HTMLElement>('#tabbar button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab as Tab); });
mobileQuery.addEventListener('change', () => { renderTree(); renderBar(); applyMode(); });

const isOwner = () => access.level === 'owner';
const canWrite = () => access.level !== 'ro';
const dlg = (id: string) => $<HTMLDialogElement>(id);

async function withBusy<T>(fn: () => Promise<T>): Promise<T> {
  busy++;
  try { return await fn(); } finally { busy--; }
}

/** Something failed that the person should hear about. If it means "your access ended", ask for the password again. */
function fail(e: unknown) {
  if (lostAccess(e)) return openGate('Your access changed. Enter the password again.');
  toast(explain(e));
}

// ---------- panels: resize + show/hide ----------
const LKEY = 'mdh_layout';
const layout = { tree: 250, hist: 290, treeOpen: true, histOpen: false, histChosen: false };   // the history starts closed (open for read-only viewers); once the person toggles it, the choice is remembered
try { Object.assign(layout, JSON.parse(localStorage.getItem(LKEY) || '{}')); } catch { /* use defaults */ }

function applyLayout() {
  const w = $('work');
  w.style.setProperty('--w-tree', layout.treeOpen ? layout.tree + 'px' : '0px');
  w.style.setProperty('--rz-tree', layout.treeOpen ? '7px' : '0px');
  w.style.setProperty('--w-hist', layout.histOpen ? layout.hist + 'px' : '0px');
  w.style.setProperty('--rz-hist', layout.histOpen ? '7px' : '0px');
  w.classList.toggle('no-tree', !layout.treeOpen);
  w.classList.toggle('no-hist', !layout.histOpen);
  $('toggle-tree').classList.toggle('on', layout.treeOpen);
  $('toggle-hist').classList.toggle('on', layout.histOpen);
}
const saveLayout = () => { try { localStorage.setItem(LKEY, JSON.stringify(layout)); } catch { /* ignore */ } };
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

document.querySelectorAll<HTMLElement>('.rz[data-side]').forEach((rz) => {
  rz.onpointerdown = (e) => {
    e.preventDefault();
    rz.setPointerCapture(e.pointerId);
    rz.classList.add('drag');
    document.body.style.userSelect = 'none';
    const side = rz.dataset.side;
    rz.onpointermove = (ev) => {
      const box = $('work').getBoundingClientRect();
      if (side === 'tree') layout.tree = clamp(ev.clientX - box.left, 160, Math.min(480, box.width - (layout.histOpen ? layout.hist : 0) - 320));
      else layout.hist = clamp(box.right - ev.clientX, 200, Math.min(520, box.width - (layout.treeOpen ? layout.tree : 0) - 320));
      applyLayout();
    };
    rz.onpointerup = () => {
      rz.onpointermove = rz.onpointerup = null;
      rz.classList.remove('drag');
      document.body.style.userSelect = '';
      saveLayout();
    };
  };
});
$('toggle-tree').onclick = () => { layout.treeOpen = !layout.treeOpen; applyLayout(); saveLayout(); };
$('toggle-hist').onclick = () => { layout.histOpen = !layout.histOpen; layout.histChosen = true; applyLayout(); saveLayout(); };

// editor | preview divider
const SKEY = 'mdh_split';
let splitR = 0.5;
try { const v = parseFloat(localStorage.getItem(SKEY) || ''); if (v > 0.15 && v < 0.85) splitR = v; } catch { /* default */ }
const applySplit = () => $('editor').style.setProperty('--split-r', String(splitR));
const splitRz = $('split-rz');
splitRz.onpointerdown = (e) => {
  e.preventDefault();
  splitRz.setPointerCapture(e.pointerId);
  splitRz.classList.add('drag');
  document.body.style.userSelect = 'none';
  splitRz.onpointermove = (ev) => {
    const box = $('editor').getBoundingClientRect();
    splitR = clamp((ev.clientX - box.left) / box.width, 0.2, 0.8);
    applySplit();
  };
  splitRz.onpointerup = () => {
    splitRz.onpointermove = splitRz.onpointerup = null;
    splitRz.classList.remove('drag');
    document.body.style.userSelect = '';
    try { localStorage.setItem(SKEY, String(splitR)); } catch { /* ignore */ }
  };
};
splitRz.ondblclick = () => { splitR = 0.5; applySplit(); try { localStorage.setItem(SKEY, '0.5'); } catch { /* ignore */ } };

// ---------- loading ----------
async function loadTree() {
  nodes = await files.tree(projectId);
}

async function refreshHistory() {
  const fresh = await files.history(projectId, { limit: HISTORY_PAGE });
  const stamp = new Map(history.map((c) => [c.seq, c.updatedAt]));
  ({ changes: history, nextBefore } = mergeHistory({ changes: history, nextBefore }, fresh));
  const top = fresh.changes[0];
  lastKey = top ? `${top.seq}:${top.updatedAt}` : '';
  // an edit that was merged keeps its number but its time moves: only then are the cached paths stale
  for (const c of history) if (stamp.has(c.seq) && stamp.get(c.seq) !== c.updatedAt) details.delete(c.seq);
}

async function refreshAll() {
  await Promise.all([loadTree(), refreshHistory()]);
  renderTree();
  renderHistory();
}

// ---------- tree ----------
const expandTo = (dir: string) => { for (let d = dir; d; d = parentOf(d)) closed.delete(d); };
const isDir = (p: string) => nodes.some((n) => n.path === p && n.kind === 'dir');
const downloadUrl = (path?: string) => `/api/projects/${encodeURIComponent(projectId)}/download${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`;

function inputRow(depth: number, value: string, onDone: (v: string) => Promise<string>) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'node';
  row.style.paddingLeft = depth * 14 + 4 + 'px';
  row.innerHTML = '<span class="chev"></span>';
  const inp = document.createElement('input');
  inp.value = value;
  row.appendChild(inp);
  const err = document.createElement('div');
  err.className = 'err';
  wrap.append(row, err);
  let submitting = false;
  const mine = editing;           // this box belongs to this editing session only
  queueMicrotask(() => { inp.focus(); inp.select(); });
  inp.onkeydown = async (e) => {
    if (e.key === 'Escape') { editing = null; renderTree(); }
    if (e.key !== 'Enter' || submitting) return;
    submitting = true;
    const msg = await onDone(inp.value.trim());
    submitting = false;
    if (msg) err.textContent = msg;
  };
  // Leaving the box cancels it. The timer must only cancel ITS OWN session: a box that was just closed (Enter) also
  // blurs, and its timer must not cancel the next box the person opened a moment later.
  inp.onblur = () => setTimeout(() => { if (editing === mine && !submitting) { editing = null; renderTree(); } }, 150);
  return wrap;
}

function renderTree() {
  const root = $('tree');
  root.innerHTML = '';
  const rows = visibleRows(nodes, closed);
  const addCreateInput = (at: string, depth: number) => {
    const kind = editing!.kind as 'create-file' | 'create-folder';
    root.appendChild(inputRow(depth, '', (name) => createNode(at, name, kind)));
  };
  if (editing && editing.kind !== 'rename' && editing.at === '') addCreateInput('', 0);
  for (const r of rows) {
    if (editing?.kind === 'rename' && editing.at === r.path) {
      root.appendChild(inputRow(r.depth, r.name, (n) => renameNode(r.path, n)));
    } else {
      root.appendChild(nodeRow(r.name, r.depth, r.path, r.kind === 'dir'));
    }
    if (editing && editing.kind !== 'rename' && editing.at === r.path && r.kind === 'dir') addCreateInput(r.path, r.depth + 1);
  }
  if (!root.children.length) root.innerHTML = '<p class="muted pad">No files yet.' + (canWrite() ? (isMobile() ? ' Tap the upload button.' : ' Drop files here.') : '') + '</p>';
}

function nodeRow(label: string, depth: number, path: string, dir: boolean) {
  const row = document.createElement('div');
  row.className = 'node' + (path === current ? ' sel' : '') + (dir && path === selDir ? ' seldir' : '');
  row.style.paddingLeft = depth * 14 + 4 + 'px';
  row.dataset.path = path;
  if (dir) row.dataset.dir = '1';
  const chev = dir ? icon(closed.has(path) ? 'chevron-right' : 'chevron-down', 14) : '';
  row.innerHTML = `<span class="chev">${chev}</span>` + icon(dir ? 'folder' : 'file') + `<span class="label">${esc(label)}</span>`;
  if (isMobile()) {
    // no hovering on a phone: one button opens a menu with everything that can be done with this entry
    const more = document.createElement('button');
    more.className = 'icon-btn'; more.innerHTML = icon('more'); more.title = 'Actions'; more.setAttribute('aria-label', `Actions: ${path}`);
    more.onclick = (e) => { e.stopPropagation(); openRowMenu(path, dir); };
    row.appendChild(more);
    row.onclick = dir
      ? () => { if (closed.has(path)) closed.delete(path); else closed.add(path); selDir = path; renderTree(); }
      : () => void openFile(path);
    return row;
  }
  const acts = document.createElement('span');
  acts.className = 'acts';
  const btn = (ico: string, title: string, fn: () => void) => {
    const b = document.createElement('button');
    b.className = 'icon-btn'; b.innerHTML = icon(ico, 15); b.title = title; b.setAttribute('aria-label', `${title}: ${path}`);
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    acts.appendChild(b);
  };
  if (canWrite()) {
    if (dir) {
      btn('file-plus', 'New file here', () => startCreate('create-file', path));
      btn('folder-plus', 'New folder here', () => startCreate('create-folder', path));
    }
    btn('pencil', 'Rename', () => { editing = { kind: 'rename', at: path }; renderTree(); });
    btn('trash', 'Delete', () => void deleteNode(path, dir));
  }
  // anyone who can see a file can take it with them: a file as it is, a folder as a .zip
  const dl = document.createElement('a');
  dl.className = 'icon-btn'; dl.innerHTML = icon('download', 15); dl.href = downloadUrl(path); dl.setAttribute('download', '');
  dl.title = dir ? 'Download folder as .zip' : 'Download'; dl.setAttribute('aria-label', `${dl.title}: ${path}`);
  dl.onclick = (e) => e.stopPropagation();
  acts.appendChild(dl);
  row.appendChild(acts);
  row.onclick = dir
    ? () => { if (closed.has(path)) closed.delete(path); else closed.add(path); selDir = path; renderTree(); }
    : () => void openFile(path);
  return row;
}

function openRowMenu(path: string, dir: boolean) {
  $('rm-title').textContent = path;
  const list = $('rm-list');
  list.innerHTML = '';
  const menu = dlg('row-menu');
  const add = (ico: string, label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.innerHTML = icon(ico, 18) + `<span>${esc(label)}</span>`;
    b.onclick = () => { menu.close(); fn(); };
    list.appendChild(b);
  };
  if (canWrite()) {
    if (dir) {
      add('file-plus', 'New file here', () => startCreate('create-file', path));
      add('folder-plus', 'New folder here', () => startCreate('create-folder', path));
    }
    add('pencil', 'Rename', () => { editing = { kind: 'rename', at: path }; renderTree(); });
    add('trash', 'Delete', () => void deleteNode(path, dir));
  }
  const a = document.createElement('a');
  a.className = 'menu-link'; a.href = downloadUrl(path); a.setAttribute('download', '');
  a.innerHTML = icon('download', 18) + `<span>${dir ? 'Download folder as .zip' : 'Download'}</span>`;
  a.onclick = () => menu.close();
  list.appendChild(a);
  menu.showModal();
}
dlg('row-menu').addEventListener('click', (e) => { if (e.target === dlg('row-menu')) dlg('row-menu').close(); });

function startCreate(kind: 'create-file' | 'create-folder', at: string) {
  if (!canWrite()) return;
  expandTo(at);
  editing = { kind, at };
  renderTree();
}

async function createNode(parent: string, name: string, kind: 'create-file' | 'create-folder'): Promise<string> {
  const isFile = kind === 'create-file';
  const bad = nameError(name, isFile);
  if (bad) return bad;
  const path = join(parent, name);
  try {
    await flushAutosave();
    await withBusy(() => files.create(projectId, path, isFile ? 'file' : 'dir'));
    editing = null;
    await refreshAll();
    if (isFile) await openFile(path);
    return '';
  } catch (e) {
    if (lostAccess(e)) { fail(e); return ''; }
    return explain(e);
  }
}

async function renameNode(oldPath: string, name: string): Promise<string> {
  const dir = isDir(oldPath);
  const bad = nameError(name, !dir);
  if (bad) return bad;
  const to = join(parentOf(oldPath), name);
  if (to === oldPath) { editing = null; renderTree(); return ''; }
  try {
    await flushAutosave();
    await withBusy(() => files.move(projectId, oldPath, to));
    editing = null;
    closed = remapPaths(closed, oldPath, to);
    selDir = remapPath(selDir, oldPath, to);
    const open = current ? remapPath(current, oldPath, to) : null;
    await refreshAll();
    if (open && open !== current) { current = null; await openFile(open, { force: true }); }
    return '';
  } catch (e) {
    if (lostAccess(e)) { fail(e); return ''; }
    return explain(e);
  }
}

async function deleteNode(path: string, dir: boolean) {
  if (!confirm(`Delete ${path}${dir ? ' and everything in it' : ''}?`)) return;
  try {
    const touchesOpen = current !== null && (current === path || current.startsWith(path + '/'));
    if (touchesOpen) discardEditor(); else await flushAutosave();
    await withBusy(() => files.remove(projectId, path));
    closed = dropPaths(closed, path);
    if (selDir === path || selDir.startsWith(path + '/')) selDir = '';
    if (touchesOpen) closeEditor();
    await refreshAll();
  } catch (e) { fail(e); await refreshAll().catch(() => {}); }
}

// ---------- drag & drop upload ----------
const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
const treeEl = $('tree');
let dropAt: string | null = null;

function clearDrop() {
  dropAt = null;
  treeEl.classList.remove('drop-root');
  treeEl.querySelectorAll('.node.drop').forEach((n) => n.classList.remove('drop'));
}
function dropTargetOf(e: DragEvent) {
  const n = (e.target as HTMLElement).closest<HTMLElement>('.node');
  if (!n || n.dataset.path === undefined) return '';
  return n.dataset.dir ? n.dataset.path : parentOf(n.dataset.path);
}

// never let the browser open a dropped file
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });

treeEl.addEventListener('dragover', (e) => {
  if (!hasFiles(e) || !canWrite()) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
  const t = dropTargetOf(e);
  if (t === dropAt) return;
  clearDrop();
  dropAt = t;
  if (t) [...treeEl.querySelectorAll<HTMLElement>('.node[data-dir]')].find((r) => r.dataset.path === t)?.classList.add('drop');
  else treeEl.classList.add('drop-root');
});
treeEl.addEventListener('dragleave', (e) => { if (!treeEl.contains(e.relatedTarget as Node)) clearDrop(); });
treeEl.addEventListener('drop', async (e) => {
  if (!hasFiles(e) || !canWrite()) return;
  e.preventDefault();
  const target = dropTargetOf(e);
  clearDrop();
  const snap = snapshotDrop(e.dataTransfer!);   // the browser only lets us read the drop during this event
  try {
    const collected = await collectDrop(snap, target);
    await uploadCollected(collected.items, collected.folders, target);
  } catch (err) { fail(err); }
});

async function uploadCollected(items: Parameters<typeof prepareUpload>[0], folders: string[], target: string) {
  const prepared = await prepareUpload(items, folders);
  const skipped = describeSkipped(prepared.skipped);
  if (!prepared.files.length && !prepared.folders.length) { toast(skipped ? `Nothing uploaded. Skipped: ${skipped}.` : 'Nothing to upload.'); return; }
  expandTo(target);
  await flushAutosave();
  const send = (overwrite: boolean) => withBusy(() => files.upload(projectId, { files: prepared.files, folders: prepared.folders, overwrite }));
  let result;
  try {
    result = await send(false);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'conflicts') {
      const n = (e.details as { paths?: string[] } | undefined)?.paths?.length ?? 0;
      if (!confirm(`${n} file${n === 1 ? '' : 's'} already exist${n === 1 ? 's' : ''} with other content. Replace ${n === 1 ? 'it' : 'them'}?`)) return;
      result = await send(true);
    } else throw e;
  }
  const done = result.seq === null ? 'Nothing new to upload.'
    : `Uploaded ${result.created + result.updated} file${result.created + result.updated === 1 ? '' : 's'}${result.newFolders && !(result.created + result.updated) ? ` (${result.newFolders} folder${result.newFolders === 1 ? '' : 's'})` : ''}.`;
  toast(skipped ? `${done} Skipped: ${skipped}.` : done);
  await refreshAll();
  await reconcileCurrent();
}

// ---------- editor ----------
const isYaml = (p: string) => /\.ya?ml$/i.test(p);

async function flushAutosave() {
  await autosave?.flush();
}

/** Throws the editor away without saving. For a file that is about to be deleted. */
function discardEditor() {
  autosave?.dispose();
  autosave = null;
}

// ---------- the address follows what is open ----------
// /p/<id>?file=notes/a.md opens that file, &diff=12&dpath=notes/a.md opens the changes of entry #12. Someone who gets the link
// needs access like for any page of the project (they are asked for the password first), then lands on the same view.
const startParams = new URLSearchParams(location.search);
let wantFile = startParams.get('file');
let wantDiff = Number(startParams.get('diff')) > 0 ? { seq: Number(startParams.get('diff')), path: startParams.get('dpath') } : null;
let diffState: { seq: number; path: string | null } | null = null;
function syncUrl() {
  const q = new URLSearchParams();
  if (current) q.set('file', current);
  if (diffState) { q.set('diff', String(diffState.seq)); if (diffState.path) q.set('dpath', diffState.path); }
  const qs = q.toString();
  try { window.history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '')); } catch { /* the address just stays as it is */ }
}

function closeEditor() {
  discardEditor();
  view?.destroy(); view = null;
  current = null;
  syncUrl();
  hideNotice();
  renderTree();
  renderBar();
  $('cm').innerHTML = '<p class="empty">Pick a file on the left.</p>';
  $('preview').classList.add('hidden');
  $('editor').classList.remove('split');
}

async function openFile(path: string, opts: { force?: boolean } = {}) {
  if (!opts.force && path === current) { if (isMobile()) setTab('editor'); return; }   // already open: just show it
  try {
    await flushAutosave();
    const f = await files.read(projectId, path);
    discardEditor();
    current = path;
    syncUrl();
    currentVersion = f.version;
    selDir = parentOf(path);
    expandTo(selDir);
    hideNotice();
    renderTree();
    mountEditor(path, f.content);
    if (isMobile() && !opts.force) setTab('editor');   // only a file the person opened moves the view; reloads (rename, rollback, other people's changes) stay where they are
  } catch (e) {
    fail(e);
    if (e instanceof ApiError && e.status === 404) await refreshAll().catch(() => {});
  }
}

function mountEditor(path: string, content: string) {
  view?.destroy(); view = null;
  saveState = 'idle';
  $('cm').innerHTML = '';
  renderBar();
  if (canWrite()) {
    autosave = new Autosave({
      delayMs: AUTOSAVE_MS,
      save: async (text) => {
        const r = await files.save(projectId, path, text, currentVersion);
        currentVersion = r.version;
        if (!r.unchanged) scheduleHistoryRefresh();
      },
      onState: (s, err) => {
        if (path !== current) return;
        saveState = s;
        updateStatus();
        if (s === 'conflict') showConflict('Someone else changed this file while you were editing it.');
        if (s === 'error' && err) {
          if (lostAccess(err)) openGate('Your access changed. Enter the password again.');
          else if (err.status === 404) showGone();
        }
      },
    });
  }
  view = new EditorView({
    parent: $('cm'),
    state: EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        mdhHighlight,
        isYaml(path) ? yamlLang() : markdown(),
        EditorView.lineWrapping,
        EditorView.editable.of(canWrite()),
        EditorState.readOnly.of(!canWrite()),
        keymap.of([{ key: 'Mod-s', run: () => { void flushAutosave(); return true; } }]),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          autosave?.change(u.state.doc.toString());
          updateStatus();
          renderPreview();
        }),
      ],
    }),
  });
  view.scrollDOM.addEventListener('scroll', () => { if (view && !ours(view.scrollDOM)) syncPreviewToEditor(); }, { passive: true });
  $('preview').scrollTop = 0;
  applyMode();
  renderPreview();
  updateStatus();
}

/** On a phone there is no room for two panes: Split behaves like Edit. */
const effectiveMode = () => (isMobile() && mdMode === 'split' ? 'edit' : mdMode);

function applyMode() {
  const md = current !== null && !isYaml(current);
  const mode = effectiveMode();
  $('editor').classList.toggle('split', md && mode === 'split');
  $('cm').classList.toggle('hidden', md && mode === 'preview');
  $('preview').classList.toggle('hidden', !md || mode === 'edit');
  if (md && mode === 'split') requestAnimationFrame(syncPreviewToEditor);
}
window.addEventListener('resize', () => syncPreviewToEditor());

function renderPreview() {
  if (current === null || isYaml(current) || !view) return;
  $('preview').innerHTML = renderMarkdownLines(view.state.doc.toString());
  renderMermaid($('preview'));
  syncPreviewToEditor();                                     // the new text may be taller or shorter: keep both where they were
}

// ---------- the editor and the preview scroll together (split mode) ----------
const isSplit = () => $('editor').classList.contains('split');
let scrollExpect: { el: HTMLElement; top: number; at: number } | null = null;

/** Scrolls `el` to `top` (kept inside its range) and remembers it, so the scroll event this causes is not answered with another scroll. */
function scrollTo(el: HTMLElement, top: number) {
  const to = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
  if (Math.abs(el.scrollTop - to) < 1) return;
  scrollExpect = { el, top: to, at: performance.now() };
  el.scrollTop = to;
}
/** True when this scroll event was caused by our own scrollTo (and so must not be mirrored back). */
function ours(el: HTMLElement): boolean {
  const e = scrollExpect;
  if (!e || e.el !== el) return false;
  scrollExpect = null;
  return performance.now() - e.at < 200 && Math.abs(el.scrollTop - e.top) < 2;
}
const atBottom = (el: HTMLElement) => el.scrollHeight - el.clientHeight > 0 && el.scrollTop >= el.scrollHeight - el.clientHeight - 1;

function previewAnchors(): Anchor[] {
  const pv = $('preview');
  const blocks = [...pv.querySelectorAll<HTMLElement>('[data-line]')].map((el) => ({ line: Number(el.dataset.line), top: el.offsetTop }));
  return buildAnchors(blocks, view!.state.doc.lines, pv.scrollHeight);
}
/** The source line at the top of the editor, with a fraction for how far into that line it is (long lines wrap, so lines differ in height). */
function editorTopLine(): number {
  const v = view!, h = Math.max(0, v.scrollDOM.scrollTop - v.documentPadding.top);
  const block = v.lineBlockAtHeight(h);
  return v.state.doc.lineAt(block.from).number + Math.min(1, Math.max(0, (h - block.top) / Math.max(1, block.height)));
}
function scrollEditorToLine(line: number) {
  const v = view!, n = Math.min(v.state.doc.lines, Math.max(1, Math.floor(line)));
  const block = v.lineBlockAt(v.state.doc.line(n).from);
  scrollTo(v.scrollDOM, v.documentPadding.top + block.top + (line - n) * block.height);
}

function syncPreviewToEditor() {
  if (!view || !isSplit()) return;
  const ed = view.scrollDOM, pv = $('preview');
  if (ed.scrollTop <= 0) scrollTo(pv, 0);
  else if (atBottom(ed)) scrollTo(pv, pv.scrollHeight);
  else scrollTo(pv, lineToTop(editorTopLine(), previewAnchors()));
}
function syncEditorToPreview() {
  if (!view || !isSplit()) return;
  const ed = view.scrollDOM, pv = $('preview');
  if (pv.scrollTop <= 0) scrollTo(ed, 0);
  else if (atBottom(pv)) scrollTo(ed, ed.scrollHeight);
  else scrollEditorToLine(topToLine(pv.scrollTop, previewAnchors()));
}
$('preview').addEventListener('scroll', () => { if (!ours($('preview'))) syncEditorToPreview(); }, { passive: true });
$('preview').addEventListener('mdh-resized', () => syncPreviewToEditor());       // a diagram or picture finished drawing: the preview got taller

function yamlStatus() {
  if (!view) return '';
  try {
    YAML.parseAllDocuments(view.state.doc.toString()).forEach((d) => { if (d.errors.length) throw d.errors[0]; });
    return '<span class="yaml-ok">yaml ok ✓</span>';
  } catch (e) {
    return `<span class="yaml-bad">yaml error: ${esc(String((e as Error).message).split('\n')[0] ?? '')}</span>`;
  }
}

/** The bar above the editor: file name and the Edit | Split | Preview switch. */
function renderBar() {
  const bar = $('bar');
  if (current === null) { bar.innerHTML = '<span class="muted">No file open</span>'; return; }
  bar.innerHTML = `<span class="name">${esc(current)}</span><span class="spacer"></span><span id="status" class="status"></span>`;
  if (!isYaml(current)) {
    const grp = document.createElement('div');
    grp.className = 'seg';
    for (const m of (isMobile() ? (['edit', 'preview'] as const) : (['edit', 'split', 'preview'] as const))) {
      const b = document.createElement('button');
      b.textContent = m[0]!.toUpperCase() + m.slice(1);
      b.className = m === effectiveMode() ? 'on' : '';
      b.onclick = () => { mdMode = m; applyMode(); renderBar(); };
      grp.appendChild(b);
    }
    bar.appendChild(grp);
  }
  bar.insertAdjacentHTML('beforeend', `<a id="download-file" class="icon-btn" title="Download this file" aria-label="Download this file" href="${esc(downloadUrl(current))}" download>${icon('download')}</a>`);
  updateStatus();
}

function updateStatus() {
  const el = document.getElementById('status');
  if (!el || current === null) return;
  const parts: string[] = [];
  if (isYaml(current)) parts.push(yamlStatus());
  if (!canWrite()) parts.push('<span class="muted">read only</span>');
  else if (saveState === 'pending' || saveState === 'saving') parts.push('<span class="muted">Saving…</span>');
  else if (saveState === 'saved') parts.push('<span class="muted">Saved</span>');
  else if (saveState === 'toobig') parts.push('<span class="warn">Too large to save (max 1 MB)</span>');
  else if (saveState === 'error') parts.push('<span class="warn">Can’t save, trying again…</span>');
  el.innerHTML = parts.join('');
}

// ---------- notices (changes by other people) ----------
function showNotice(msg: string, actions: { label: string; primary?: boolean; run: () => void }[]) {
  $('notice-msg').textContent = msg;
  const box = $('notice-actions');
  box.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.className = a.primary ? 'primary' : 'outline';
    b.onclick = a.run;
    box.appendChild(b);
  }
  $('notice').classList.remove('hidden');
}
function hideNotice() { $('notice').classList.add('hidden'); }

/** Someone else saved this file, and there is text here that is not saved yet. Never overwrite either silently. */
function showConflict(msg: string) {
  showNotice(msg, [
    { label: 'Keep my version', primary: true, run: () => void keepMine() },
    { label: 'Load their version', run: () => void loadTheirs() },
  ]);
}

async function keepMine() {
  if (!current) return;
  try {
    const f = await files.read(projectId, current);   // adopt their version number, then my text is saved on top of it
    currentVersion = f.version;
    hideNotice();
    autosave?.resume();
    await autosave?.flush();
  } catch (e) { fail(e); }
}

async function loadTheirs() {
  if (!current) return;
  const path = current;
  discardEditor();
  await openFile(path, { force: true });
}

function showGone() {
  showNotice('This file was deleted or renamed by someone else. Your text is still here.', [
    { label: 'Save it again', primary: true, run: () => void recreate() },
    { label: 'Close', run: () => closeEditor() },
  ]);
}

async function recreate() {
  if (!current || !view) return;
  const path = current;
  const text = view.state.doc.toString();
  try {
    discardEditor();
    await withBusy(() => files.create(projectId, path, 'file', text));
    await refreshAll();
    await openFile(path, { force: true });
  } catch (e) { fail(e); }
}

/** After the tree changed (by us or by others): is the open file still there, and still the version we have? */
async function reconcileCurrent() {
  if (!current) return;
  const node = nodes.find((n) => n.path === current && n.kind === 'file');
  if (!node) {
    if (autosave?.hasUnsaved) showGone();
    else { toast('The open file was deleted or renamed by someone else.'); closeEditor(); }
    return;
  }
  if (node.version <= currentVersion || autosave?.state === 'saving') return;
  if (autosave?.hasUnsaved) showConflict('Someone else changed this file while you were editing it.');
  else await openFile(current, { force: true });   // nothing of mine to lose: show their version
}

// ---------- history ----------
function canRollback() {
  return canWrite() && (info.rollbackPolicy === 'author_and_write' || isOwner());
}

function renderHistory() {
  const box = $('history');
  box.innerHTML = '';
  for (const c of history) {
    const el = document.createElement('div');
    el.className = 'change' + (c.seq === selSeq ? ' sel' : '');
    el.innerHTML = `<div class="muted meta">${c.seq === selSeq ? '<span class="dot"></span>' : ''}#${c.seq} · ${esc(c.actor.label)} · <span title="${esc(new Date(c.updatedAt).toLocaleString())}">${esc(timeAgo(c.updatedAt))}</span></div><div class="summary">${esc(c.summary)}</div><button class="icon-btn diff-btn" title="Show what changed" aria-label="Show what changed in #${c.seq}">${icon('diff', 16)}</button>`;
    el.querySelector<HTMLElement>('.diff-btn')!.onclick = (e) => { e.stopPropagation(); void openDiff(c.seq, null); };
    if (c.seq === selSeq) {
      const d = details.get(c.seq);
      if (d) {
        const shown = d.files.slice(0, MAX_LISTED_PATHS).map((f) => `<li>${esc(f.path)}${f.kind === 'dir' ? '/' : ''}</li>`).join('');
        const more = d.files.length > MAX_LISTED_PATHS ? `<li>… and ${d.files.length - MAX_LISTED_PATHS} more</li>` : '';
        el.insertAdjacentHTML('beforeend', `<ul class="paths">${shown}${more}</ul>`);
      } else {
        el.insertAdjacentHTML('beforeend', '<div class="muted">Loading…</div>');
        void loadDetail(c.seq);
      }
      const b = document.createElement('button');
      b.className = 'outline';
      b.innerHTML = icon('undo', 15) + 'Rollback to <span class="dot"></span>';
      b.disabled = !canRollback();
      b.title = b.disabled ? (canWrite() ? 'Only the project owner can roll back in this project' : 'Read-only access cannot roll back') : '';
      b.onclick = (e) => { e.stopPropagation(); void rollback(c.seq); };
      el.appendChild(b);
    }
    el.onclick = () => selectChange(c.seq);
    box.appendChild(el);
  }
  if (nextBefore !== null) {
    const more = document.createElement('button');
    more.className = 'outline';
    more.style.margin = '0.5rem 0.2rem';
    more.textContent = 'Load older changes';
    more.onclick = () => void loadOlder();
    box.appendChild(more);
  }
}

function selectChange(seq: number) {
  selSeq = selSeq === seq ? null : seq;
  renderHistory();
}

const detailRequested = new Set<number>();
/** Fetches the paths of the opened entry. Whatever refreshes the list meanwhile, an opened entry gets its paths. */
async function loadDetail(seq: number) {
  if (detailRequested.has(seq)) return;
  detailRequested.add(seq);
  try { details.set(seq, await files.change(projectId, seq)); }
  catch (e) { fail(e); }
  finally { detailRequested.delete(seq); }
  if (selSeq === seq && details.has(seq)) renderHistory();
}

async function loadOlder() {
  if (nextBefore === null) return;
  try {
    const page = await files.history(projectId, { limit: HISTORY_PAGE, before: nextBefore });
    history = [...history, ...page.changes];
    nextBefore = page.nextBefore;
    renderHistory();
  } catch (e) { fail(e); }
}

// ---------- the changes of one history entry ----------
const MAX_DIFF_ROWS = 3000;
const ACTION_LABEL = { created: 'new file', updated: 'changed file', deleted: 'deleted file' } as const;
const ACTION_MARK = { created: '+', updated: '~', deleted: '−' } as const;
let diffFiles: ChangedFile[] = [];
const diffClosed = new Set<string>();

/** A folder chain "a/b/c": the last folder stays readable, the part before it is dimmed and is what gets shortened when there is no room. */
function chainLabel(label: string): string {
  const cut = label.lastIndexOf('/');
  if (cut < 0) return `<span class="label">${esc(label)}</span>`;
  return `<span class="label chain"><span class="dim">${esc(label.slice(0, cut + 1))}</span><span class="last">${esc(label.slice(cut + 1))}</span></span>`;
}

/** The file list of the diff view: a tree like the Files panel, plus the "3 / 27" line with previous / next. */
function renderDiffList() {
  const box = $('diff-files');
  box.innerHTML = '';
  for (const r of buildRows(diffFiles, diffClosed)) {
    const row = document.createElement('div');
    row.style.paddingLeft = `${r.depth * 14 + 4}px`;
    if (r.type === 'dir') {
      row.className = 'dt dir';
      row.title = r.path;
      row.innerHTML = `${icon(r.closed ? 'chevron-right' : 'chevron-down', 14)}${icon('folder')}${chainLabel(r.label)}<span class="count">${r.count}</span>`;
      row.onclick = () => { if (diffClosed.has(r.path)) diffClosed.delete(r.path); else diffClosed.add(r.path); renderDiffList(); };
    } else {
      row.className = 'dt file' + (r.path === diffState?.path ? ' sel' : '');
      row.title = r.path;
      row.dataset.path = r.path;
      row.innerHTML = `<span style="width:14px;flex:none"></span>${icon('file')}<span class="label">${esc(r.name)}</span><span class="mark ${r.action}" title="${ACTION_LABEL[r.action]}">${ACTION_MARK[r.action]}</span>`;
      row.onclick = () => { $('diff-dlg').classList.remove('pick'); if (diffState) void openDiff(diffState.seq, r.path); };
    }
    box.appendChild(row);
  }
  const order = orderedPaths(diffFiles);
  const at = diffState?.path ? order.indexOf(diffState.path) : -1;
  $('diff-summary').textContent = summarize(diffFiles);
  $('diff-which').textContent = at >= 0 ? `${at + 1} / ${order.length} · ${diffState!.path!.slice(diffState!.path!.lastIndexOf('/') + 1)}` : '';
  $('diff-which').title = diffState?.path ?? '';
  $<HTMLButtonElement>('diff-prev').disabled = at <= 0;
  $<HTMLButtonElement>('diff-next').disabled = at < 0 || at >= order.length - 1;
}

function stepDiff(by: number) {
  if (!diffState) return;
  const order = orderedPaths(diffFiles);
  const to = order[order.indexOf(diffState.path ?? '') + by];
  if (to !== undefined) void openDiff(diffState.seq, to);
}

async function openDiff(seq: number, path: string | null) {
  try {
    const detail = details.get(seq) ?? await files.change(projectId, seq);
    details.set(seq, detail);
    diffFiles = detail.files.filter((f) => f.kind === 'file').map((f) => ({ path: f.path, action: f.action }));
    const chosen = diffFiles.find((f) => f.path === path)?.path ?? orderedPaths(diffFiles)[0] ?? null;
    if (diffState?.seq !== seq) diffClosed.clear();
    if (chosen) for (const dir of parentsOf(chosen)) diffClosed.delete(dir);       // the file you look at is always visible in the tree
    diffState = { seq, path: chosen };
    $('diff-title').textContent = `#${seq} · ${detail.summary}`;
    // an editing session is ONE entry (autosaves within 10 minutes merge): say so when the entry spans some time
    const started = new Date(detail.createdAt), ended = new Date(detail.updatedAt);
    const span = ended.getTime() - started.getTime() < 500 ? ended.toLocaleString()
      : `edited between ${started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} and ${ended.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, ${ended.toLocaleDateString()}`;
    $('diff-meta').textContent = `${detail.actor.label} · ${span}`;
    const many = diffFiles.length > 1;
    $('diff-nav').classList.toggle('hidden', !many);
    $('diff-dlg').querySelector('.diff-body')!.classList.toggle('single', !many);
    renderDiffList();
    const d = dlg('diff-dlg');
    if (!d.open) d.showModal();
    syncUrl();
    await showFileDiff(seq, chosen);
  } catch (e) {
    diffState = null; syncUrl();
    if (dlg('diff-dlg').open) dlg('diff-dlg').close();
    if (e instanceof ApiError && e.status === 404) toast(`Change #${seq} does not exist.`); else fail(e);
  }
}

const DIFF_MODE_KEY = 'mdh_diffmode';
const RICH_MAX = 300_000;      // characters per side; bigger texts are shown as lines
const diffMode = (): 'rendered' | 'source' => { try { return localStorage.getItem(DIFF_MODE_KEY) === 'source' ? 'source' : 'rendered'; } catch { return 'rendered'; } };
const setDiffMode = (m: 'rendered' | 'source') => { try { localStorage.setItem(DIFF_MODE_KEY, m); } catch { /* the choice just does not stick */ } };

async function showFileDiff(seq: number, path: string | null) {
  const view = $('diff-view');
  if (path === null) { view.innerHTML = '<p class="note">This change only touched folders.</p>'; return; }
  view.innerHTML = '<p class="note">Loading…</p>';
  try {
    const f = await files.changeFile(projectId, seq, path);
    if (diffState?.seq !== seq || diffState.path !== path) return;           // another file was picked meanwhile
    const before = f.before ?? '', after = f.after ?? '';
    const isMarkdown = /\.md$/i.test(path);
    const tooBig = before.length > RICH_MAX || after.length > RICH_MAX;
    const rich = isMarkdown && !tooBig && diffMode() === 'rendered';

    const bar = document.createElement('div');
    bar.className = 'diff-viewbar';
    const label = document.createElement('span');
    label.className = 'note';
    bar.appendChild(label);
    if (isMarkdown) {
      const seg = document.createElement('div');
      seg.className = 'seg diff-mode';
      for (const m of ['rendered', 'source'] as const) {
        const b = document.createElement('button');
        b.textContent = m === 'rendered' ? 'Rendered' : 'Source';
        b.className = (m === 'rendered') === rich ? 'on' : '';
        b.disabled = m === 'rendered' && tooBig;
        b.title = b.disabled ? 'Too big to show as a page' : '';
        b.onclick = () => { setDiffMode(m); void showFileDiff(seq, path); };
        seg.appendChild(b);
      }
      bar.appendChild(seg);
    }
    view.replaceChildren(bar);

    if (rich) {
      let body: HTMLElement;
      if (f.action === 'updated') {
        const r = richDiff(before, after, document, () => renderMermaid(view));
        body = r.root;
        const parts = [r.changed && `${r.changed} changed`, r.added && `${r.added} added`, r.removed && `${r.removed} removed`].filter(Boolean);
        label.textContent = `${path} · ${parts.length ? parts.join(' · ') : 'no visible change'}`;
        if (!parts.length) body.insertAdjacentHTML('afterbegin', '<p class="note">The page reads the same (only spacing or markup details changed). Switch to Source to see them.</p>');
      } else {
        body = document.createElement('div');
        body.className = 'preview rd';
        body.innerHTML = renderMarkdownShowingImages(f.action === 'created' ? after : before);
        label.textContent = `${path} · ${f.action === 'created' ? 'new file' : 'deleted file'}`;
      }
      view.appendChild(body);
      renderMermaid(view);
      return;
    }

    const { rows, exact } = diffLines(before, after);
    const { added, removed } = countChanges(rows);
    label.innerHTML = `${esc(path)} · <span style="color:var(--ok)">+${added}</span> <span style="color:var(--danger)">−${removed}</span>${exact ? '' : ' · too different to match line by line: everything is shown as removed and added'}${isMarkdown && tooBig ? ' · too big to show as a page' : ''}`;
    const shown = withContext(rows);
    // a new file has only new line numbers, a deleted one only old ones: one number column then, not an empty one next to it
    const both = f.action === 'updated';
    const digits = String(Math.max(1, ...rows.map((r) => Math.max(r.oldNo ?? 0, r.newNo ?? 0)))).length;
    const col = `calc(${digits}ch + 0.9rem)`;
    view.style.setProperty('--no-cols', both ? `${col} ${col}` : col);
    const html: string[] = [];
    let count = 0;
    for (const r of shown) {
      if (++count > MAX_DIFF_ROWS) { html.push(`<p class="note">… and ${shown.length - MAX_DIFF_ROWS} more lines. Download the file to see all of it.</p>`); break; }
      if (r.type === 'gap') html.push(`<div class="dl gap"><span>⋯ ${r.hidden} unchanged line${r.hidden === 1 ? '' : 's'}</span></div>`);
      else html.push(`<div class="dl ${r.type}">${both ? `<span class="no">${r.oldNo ?? ''}</span><span class="no">${r.newNo ?? ''}</span>` : `<span class="no">${(f.action === 'created' ? r.newNo : r.oldNo) ?? ''}</span>`}<span class="sign">${r.type === 'add' ? '+' : r.type === 'del' ? '−' : ''}</span><span>${esc(r.text)}</span></div>`);
    }
    if (!rows.length) html.push('<p class="note">The file is empty.</p>');
    view.insertAdjacentHTML('beforeend', html.join(''));
  } catch (e) {
    view.innerHTML = '<p class="note">Could not load this file.</p>';
    fail(e);
  }
}
$('diff-close').onclick = () => dlg('diff-dlg').close();
$('diff-prev').onclick = () => stepDiff(-1);
$('diff-next').onclick = () => stepDiff(1);
$('diff-which').onclick = () => { if (isMobile()) $('diff-dlg').classList.toggle('pick'); };   // on a phone the name opens the list
dlg('diff-dlg').addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && diffFiles.length > 1) { e.preventDefault(); stepDiff(e.key === 'ArrowRight' ? 1 : -1); }   // up / down keep scrolling the diff
});
dlg('diff-dlg').addEventListener('close', () => { diffState = null; $('diff-dlg').classList.remove('pick'); syncUrl(); });

let historyTimer = 0;
/** After our own save: update the list a moment later (once, however many saves happened). */
function scheduleHistoryRefresh() {
  clearTimeout(historyTimer);
  historyTimer = window.setTimeout(() => { refreshHistory().then(renderHistory).catch(() => {}); }, 400);
}

async function rollback(seq: number) {
  try {
    await flushAutosave();
    await withBusy(() => files.rollback(projectId, seq));
    selSeq = null;
    toast(`Rolled back to #${seq}.`);
    await refreshAll();
    if (current) {
      if (nodes.some((n) => n.path === current && n.kind === 'file')) await openFile(current, { force: true });
      else closeEditor();
    }
  } catch (e) { fail(e); }
}

// ---------- looking for changes by others ----------
async function poll() {
  if (document.hidden || busy || polling || gateOpen || !started) return;
  polling = true;
  try {
    const top = (await files.history(projectId, { limit: 1 })).changes[0];
    const key = top ? `${top.seq}:${top.updatedAt}` : '';
    if (key !== lastKey) {
      await refreshAll();
      await reconcileCurrent();
    }
  } catch (e) {
    if (lostAccess(e)) openGate('Your access changed. Enter the password again.');
    /* a network hiccup: try again at the next tick */
  } finally { polling = false; }
}
setInterval(() => void poll(), POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) void flushAutosave(); else void poll();
});
// Closing the tab saves what is still waiting. A `keepalive` request survives the page going away (the browser caps
// its body at 64 KiB); a larger text cannot be sent that way, so for that one the browser asks before closing.
const KEEPALIVE_MAX_BYTES = 60_000;
const tooBigToSendOnLeave = () => {
  const text = autosave?.unsavedText;
  return typeof text === 'string' && new TextEncoder().encode(text).length > KEEPALIVE_MAX_BYTES;
};
function saveOnLeave() {
  const text = autosave?.unsavedText;
  if (text === null || text === undefined || !current || !canWrite() || tooBigToSendOnLeave()) return;
  autosave?.handOver();   // sent below; do not send it again with an old version number if the page comes back
  void fetch(`/api/projects/${encodeURIComponent(projectId)}/file`, {
    method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: current, content: text, baseVersion: currentVersion }),
  }).catch(() => { /* nothing more can be done */ });
}
window.addEventListener('pagehide', saveOnLeave);
window.addEventListener('pageshow', (e) => { if (e.persisted) void poll(); });   // back from the back/forward cache: catch up
window.addEventListener('beforeunload', (e) => {
  if (autosave?.hasUnsaved && tooBigToSendOnLeave()) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- header and dialogs ----------
function setupHeader() {
  $('proj-name').textContent = info.name;
  $<HTMLAnchorElement>('download-all').href = downloadUrl();
  document.title = `${info.name} · mdh-mdh`;
  $('rights').textContent = { owner: 'owner', rw: 'can edit', ro: 'can view' }[access.level];
  show('share-btn', isOwner());
  show('gear-btn', isOwner());
  show('tree-tools', canWrite());
  if (!canWrite() && !layout.histChosen && !isMobile()) { layout.histOpen = true; applyLayout(); }   // viewers cannot edit: the history is what they came for
  show('profile-btn', !!user);
  if (user) $('profile-btn').innerHTML = icon('user') + `<span class="t">${esc(user.username)}</span>`;
}
function show(id: string, on: boolean) { $(id).classList.toggle('hidden', !on); }

const targetDir = () => (selDir && isDir(selDir) ? selDir : '');
$('new-file').onclick = () => startCreate('create-file', targetDir());
$('new-folder').onclick = () => startCreate('create-folder', targetDir());

// phones cannot drag files in: the upload button opens the file picker instead
$('upload-btn').onclick = () => $<HTMLInputElement>('upload-input').click();
$<HTMLInputElement>('upload-input').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const picked = [...(input.files ?? [])];
  input.value = '';                                  // the same file can be picked again later
  if (!picked.length) return;
  const target = targetDir();
  try { await uploadCollected(picked.map((file) => ({ path: join(target, file.name), file })), [], target); } catch (err) { fail(err); }
};
$('collapse-all').onclick = () => { closed = dirPaths(nodes); selDir = ''; renderTree(); };

// share: url + password + a ready-made prompt for an AI agent
const share = { mode: 'rw' as Mode, pw: { rw: '', ro: '' }, origin: location.origin };   // origin: PUBLIC_DOMAIN when the server has one
function fillShare() {
  $('sh-rw').classList.toggle('on', share.mode === 'rw');
  $('sh-ro').classList.toggle('on', share.mode === 'ro');
  $('sh-desc').textContent = share.mode === 'rw' ? 'Can read and change files.' : 'Can read. Can’t change anything.';
  $<HTMLTextAreaElement>('sh-url').value = `${share.origin}/p/${info.id}`;
  $<HTMLInputElement>('sh-pw').value = share.pw[share.mode];
  $<HTMLTextAreaElement>('sh-prompt').value = sharePrompt({ origin: share.origin, projectId: info.id, mode: share.mode, password: share.pw[share.mode] });
  fitBoxes();
}
/** Grow the read-only boxes to show all their text (measured only while the dialog is open). */
function fitBoxes() {
  for (const id of ['sh-url', 'sh-prompt']) {
    const box = $<HTMLTextAreaElement>(id);
    box.style.height = 'auto';
    if (box.scrollHeight) box.style.height = `${box.scrollHeight + 2}px`;
  }
}
$('share-btn').onclick = async () => {
  try {
    [share.pw, share.origin] = await Promise.all([projectsApi.passwords(projectId), siteUrl()]);
    fillShare();
    dlg('share-dlg').showModal();
    fitBoxes();
  } catch (e) { fail(e); }
};
$('sh-rw').onclick = () => { share.mode = 'rw'; fillShare(); };
$('sh-ro').onclick = () => { share.mode = 'ro'; fillShare(); };
$('sh-url-copy').onclick = () => copy(`${share.origin}/p/${info.id}`, $('sh-url-copy'));
$('sh-pw-copy').onclick = () => copy(share.pw[share.mode], $('sh-pw-copy'));
$('sh-prompt-copy').onclick = () => copy($<HTMLTextAreaElement>('sh-prompt').value, $('sh-prompt-copy'));
$('sh-new').onclick = async () => {
  if (!confirm(`Create a new "${share.mode === 'rw' ? 'can edit' : 'can view'}" password? The old one stops working.`)) return;
  try {
    share.pw[share.mode] = await projectsApi.refreshPassword(projectId, share.mode);
    fillShare();
  } catch (e) { fail(e); }
};
$('sh-close').onclick = () => dlg('share-dlg').close();

// project settings
$('gear-btn').onclick = () => { $<HTMLSelectElement>('s-policy').value = info.rollbackPolicy; dlg('settings-dlg').showModal(); };
$<HTMLSelectElement>('s-policy').onchange = async (e) => {
  const sel = e.target as HTMLSelectElement;
  try {
    info = await projectsApi.setPolicy(projectId, sel.value as Policy);
    renderHistory();
  } catch (err) { sel.value = info.rollbackPolicy; fail(err); }
};
$('s-close').onclick = () => dlg('settings-dlg').close();

// switch project
$('switch-btn').onclick = async () => {
  const list = $('switch-list');
  list.innerHTML = '';
  dlg('switch-dlg').showModal();
  if (!user) { list.innerHTML = '<li class="muted">Sign in on the home page to see your own projects.</li>'; return; }
  try {
    const all = await projectsApi.list();
    list.innerHTML = all.map((p) => `<li><a href="/p/${encodeURIComponent(p.id)}"><b class="name">${esc(p.name)}</b>${p.id === info.id ? '<span class="muted">open</span>' : ''}</a></li>`).join('')
      + '<li><a href="/">Back to home</a></li>';
  } catch (e) { list.innerHTML = `<li class="muted">${esc(explain(e))}</li>`; }
};
$('switch-close').onclick = () => dlg('switch-dlg').close();

// gate: the password prompt for people who are not the owner
function openGate(message?: string) {
  if (gateOpen) return;
  gateOpen = true;
  $('gate-msg').textContent = message ?? 'Enter the password you were given.';
  $('gate-err').textContent = '';
  void projectsApi.publicName(projectId).then((name) => { const el = $('gate-proj'); el.textContent = name; el.classList.remove('hidden'); }).catch(() => { /* no name to show */ });
  const d = dlg('gate-dlg');
  d.addEventListener('cancel', (e) => e.preventDefault()); // it cannot be dismissed
  d.showModal();
  $<HTMLInputElement>('gate-pw').focus();
}
async function submitGate() {
  const btn = $<HTMLButtonElement>('gate-go');
  btn.disabled = true;
  $('gate-err').textContent = '';
  try {
    await projectsApi.openGate(projectId, $<HTMLInputElement>('gate-pw').value.trim(), $<HTMLInputElement>('gate-name').value.trim() || undefined);
    $<HTMLInputElement>('gate-pw').value = '';
    dlg('gate-dlg').close();
    gateOpen = false;
    await boot();
  } catch (e) { $('gate-err').textContent = explain(e); } finally { btn.disabled = false; }
}
$('gate-go').onclick = submitGate;
$('gate-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') void submitGate(); });
$('gate-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') void submitGate(); });

// ---------- start ----------
function showFatal(msg: string) {
  $('fatal-msg').textContent = msg;
  show('fatal', true);
}
$('fatal-retry').onclick = () => { show('fatal', false); void boot(); };

async function boot() {
  show('fatal', false);
  try {
    user = await auth.me().catch(() => null);
    const r = await projectsApi.get(projectId);
    info = r.project;
    access = r.access;
  } catch (e) {
    if (lostAccess(e)) { openGate(); return; }
    showFatal(explain(e));
    return;
  }
  try {
    setupHeader();
    started = false;
    history = []; nextBefore = null; details.clear(); selSeq = null;
    await refreshAll();
    started = true;
    const asked = wantFile; wantFile = null;
    const askedDiff = wantDiff; wantDiff = null;
    if (asked && !current && nodes.some((n) => n.path === asked && n.kind === 'file')) await openFile(asked);
    else if (!current && nodes.some((n) => n.path === 'readme.md')) { if (asked) toast(`"${asked}" does not exist (any more).`); await openFile('readme.md'); }
    else if (!current) { if (asked) toast(`"${asked}" does not exist (any more).`); closeEditor(); if (isMobile()) setTab('files'); }
    else await reconcileCurrent();
    if (askedDiff) await openDiff(askedDiff.seq, askedDiff.path);
  } catch (e) {
    if (lostAccess(e)) openGate(); else showFatal(explain(e));
  }
}

toggleTheme($('theme-btn'));
initProfile($('profile-btn'), {
  getUser: () => user,
  onUser: (u) => { user = u; },
  onLogout: () => { location.href = '/'; },
});
applyLayout();
applySplit();
hydrateIcons();
void boot();

