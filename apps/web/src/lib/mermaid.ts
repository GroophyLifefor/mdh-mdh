// Draws ```mermaid blocks of the markdown preview. The library is big, so it is only loaded when a block exists.
// The picture goes into the page as <img src="data:image/svg+xml,...">: an SVG shown as an image can never run a script,
// whatever the diagram source says (mermaid's own "strict" mode is the first layer, this is the second).
import { esc } from './shared';

type Mermaid = typeof import('mermaid').default;
type Theme = 'light' | 'dark';

const cache = new Map<string, { url: string; width: number }>();   // theme + source -> picture
const CACHE_MAX = 100;
let lib: Promise<Mermaid> | null = null;
let configuredFor: Theme | null = null;
let queue: Promise<void> = Promise.resolve();
let timer = 0;
let counter = 0;

const themeNow = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

function load(): Promise<Mermaid> {
  lib ??= import('mermaid').then((m) => m.default);
  return lib;
}

/** The data URL and natural width of an SVG string (the width comes from its viewBox). */
export function toPicture(svg: string): { url: string; width: number } {
  const box = /viewBox="[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+[\d.]+"/.exec(svg);
  return { url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), width: Math.max(1, Math.round(Number(box?.[1] ?? 600))) };
}

function show(block: HTMLElement, pic: { url: string; width: number }) {
  const img = new Image();
  img.src = pic.url;
  img.alt = 'Diagram';
  img.width = pic.width;
  img.className = 'mermaid-img';
  block.replaceChildren(img);
  block.dataset.state = 'done';
}

function showError(block: HTMLElement, message: string) {
  const note = document.createElement('div');
  note.className = 'mermaid-err';
  note.innerHTML = `Diagram error: ${esc(message.split('\n')[0] ?? 'invalid diagram')}`;
  block.insertBefore(note, block.firstChild);
  block.dataset.state = 'error';
}

async function draw(block: HTMLElement, theme: Theme) {
  const source = block.dataset.mermaid ?? '';
  const key = `${theme}\n${source}`;
  try {
    const mermaid = await load();
    if (configuredFor !== theme) {
      mermaid.initialize({
        startOnLoad: false, securityLevel: 'strict', theme: theme === 'dark' ? 'dark' : 'default',
        htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: 'Inter, system-ui, sans-serif',
      });
      configuredFor = theme;
    }
    const id = `mermaid-${++counter}`;
    let svg: string;
    try { ({ svg } = await mermaid.render(id, source)); }
    finally { document.getElementById(id)?.remove(); document.getElementById('d' + id)?.remove(); }   // mermaid leaves scratch elements after an error
    const pic = toPicture(svg);
    cache.set(key, pic);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    if (block.isConnected && block.dataset.mermaid === source) show(block, pic);
  } catch (e) {
    if (block.isConnected && block.dataset.mermaid === source) showError(block, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Draws every mermaid block under `root`. Pictures already known are put in at once (no flicker while typing in
 * the rest of the document); new ones are drawn one after another, shortly after the last change.
 */
export function renderMermaid(root: ParentNode, delayMs = 350) {
  const theme = themeNow();
  const todo: HTMLElement[] = [];
  for (const block of root.querySelectorAll<HTMLElement>('.mermaid-block')) {
    const hit = cache.get(`${theme}\n${block.dataset.mermaid ?? ''}`);
    if (hit) show(block, hit); else todo.push(block);
  }
  window.clearTimeout(timer);
  if (!todo.length) return;
  timer = window.setTimeout(() => {
    for (const block of todo) queue = queue.then(() => (block.isConnected ? draw(block, theme) : undefined));
  }, delayMs);
}

// a theme change draws the diagrams again in the other colours
new MutationObserver(() => renderMermaid(document, 0)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
