// The "rich" diff of two markdown texts: the page as it reads, with new sections marked green, removed ones red, and
// changed ones amber with the changed words underlined / struck through (like GitHub's rich diff).
// Everything shown comes from the same sanitising renderer as the preview; this file only adds <ins>, <del> and wrappers,
// all made with DOM calls (no text is ever pasted into HTML).
import { align } from './diff';
import { markdownBlocks, type Block } from './markdown';

export type RichResult = { root: HTMLElement; added: number; removed: number; changed: number };

const WORD = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu;
const SIMILAR = 0.4;
const KEEP_AROUND = 1;           // unchanged sections shown around a change
const MIN_FOLD = 3;              // a stretch of unchanged sections shorter than this is not folded

/** The words of a block's source, without the addresses of links and pictures (two different pictures must not look alike because both are "https://...png"). */
const words = (raw: string) => raw.replace(/\]\([^)]*\)/g, ']').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

/** 0..1: how many words two blocks share (Dice on word counts). Blocks of different kinds never match. */
export function similarity(a: Block, b: Block): number {
  if (a.type !== b.type) return 0;
  const count = new Map<string, number>();
  const wa = words(a.raw), wb = words(b.raw);
  for (const w of wa) count.set(w, (count.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of wb) { const n = count.get(w) ?? 0; if (n > 0) { common++; count.set(w, n - 1); } }
  const dice = wa.length + wb.length === 0 ? 1 : (2 * common) / (wa.length + wb.length);
  // the same picture or link with a new description is still the same thing
  const da = new Set(a.raw.match(/\]\([^)]*\)/g) ?? []);
  const sameTarget = (b.raw.match(/\]\([^)]*\)/g) ?? []).some((d) => da.has(d));
  return sameTarget ? Math.max(dice, SIMILAR) : dice;
}

type Seg =
  | { kind: 'same'; block: Block }
  | { kind: 'added'; block: Block }
  | { kind: 'removed'; block: Block }
  | { kind: 'changed'; before: Block; after: Block };

/** Block-level story of the change, in reading order of the new text (removed blocks sit where they used to be). */
export function segments(before: string, after: string): Seg[] {
  const A = markdownBlocks(before), B = markdownBlocks(after);
  const { ops } = align(A.map((b) => b.raw), B.map((b) => b.raw));
  const out: Seg[] = [];
  for (let i = 0; i < ops.length;) {
    if (ops[i]!.type === 'ctx') { out.push({ kind: 'same', block: B[ops[i]!.b]! }); i++; continue; }
    const dels: Block[] = [], adds: Block[] = [];
    for (; i < ops.length && ops[i]!.type !== 'ctx'; i++) (ops[i]!.type === 'del' ? dels.push(A[ops[i]!.a]!) : adds.push(B[ops[i]!.b]!));
    // pair each added block with a similar removed one (in order); then emit, with removed blocks before the new ones that replace them
    const pair: number[] = [];
    let from = 0;
    for (const add of adds) {
      let match = -1;
      for (let d = from; d < dels.length; d++) if (similarity(dels[d]!, add) >= SIMILAR) { match = d; break; }
      pair.push(match);
      if (match >= 0) from = match + 1;
    }
    let d = 0;
    adds.forEach((add, j) => {
      const upTo = pair[j]! >= 0 ? pair[j]! : (pair.slice(j + 1).find((m) => m >= 0) ?? dels.length);
      for (; d < upTo; d++) out.push({ kind: 'removed', block: dels[d]! });
      if (pair[j]! >= 0) { out.push({ kind: 'changed', before: dels[pair[j]!]!, after: add }); d = pair[j]! + 1; }
      else out.push({ kind: 'added', block: add });
    });
    for (; d < dels.length; d++) out.push({ kind: 'removed', block: dels[d]! });
  }
  return out;
}

type Piece = { kind: 'ctx' | 'ins' | 'del'; text: string };
type Tok = { text: string; node: Text; boundary?: boolean };

function tokens(root: HTMLElement, doc: Document): Tok[] {
  const out: Tok[] = [];
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    for (const t of node.data.match(WORD) ?? []) out.push({ text: t, node });
    // an invisible marker at the end of each piece of text, named after its first letters: it ties the alignment to the list item / cell / paragraph
    // it belongs to (without it a full stop of one item can be matched with the full stop of another)
    if (node.data.trim()) out.push({ text: `\u0001${node.data.trim().slice(0, 12)}`, node, boundary: true });
  }
  return out;
}

/** The new block with its changed words marked: <ins> for what was added, <del> (struck through) for what was removed. */
function wordDiff(before: Block, after: Block, doc: Document): HTMLElement {
  const b = doc.createElement('div'), a = doc.createElement('div');
  b.innerHTML = before.html;
  a.innerHTML = after.html;
  const bt = tokens(b, doc), at = tokens(a, doc);
  const { ops } = align(bt.map((t) => t.text), at.map((t) => t.text));

  const perNode = new Map<Text, Piece[]>();
  const push = (node: Text, piece: Piece) => {
    const list = perNode.get(node) ?? [];
    const last = list[list.length - 1];
    if (last && last.kind === piece.kind) last.text += piece.text; else list.push({ ...piece });
    perNode.set(node, list);
  };
  let pending = '';
  for (const op of ops) {
    if (op.type === 'del') { if (!bt[op.a]!.boundary) pending += bt[op.a]!.text; continue; }
    const tok = at[op.b]!;
    if (tok.boundary) continue;
    if (pending) { push(tok.node, { kind: 'del', text: pending }); pending = ''; }
    push(tok.node, { kind: op.type === 'add' ? 'ins' : 'ctx', text: tok.text });
  }
  if (pending && at.length) push(at[at.length - 1]!.node, { kind: 'del', text: pending });

  for (const [node, pieces] of perNode) {
    if (pieces.every((p) => p.kind === 'ctx')) continue;
    const frag = doc.createDocumentFragment();
    for (const p of pieces) {
      if (p.kind === 'ctx' || (p.kind === 'ins' && p.text.trim() === '')) frag.append(doc.createTextNode(p.text));
      else if (p.kind === 'del' && p.text.trim() === '') continue;               // a removed blank is not worth showing
      else { const el = doc.createElement(p.kind); el.textContent = p.text; frag.append(el); }
    }
    node.replaceWith(frag);
  }
  return a;
}

function wrap(doc: Document, kind: string, content: Node | string): HTMLElement {
  const el = doc.createElement('div');
  el.className = `rd-block rd-${kind}`;
  if (typeof content === 'string') el.innerHTML = content; else el.append(content);
  return el;
}

/** The whole rich diff as one element. Long stretches of unchanged sections are folded behind a button. */
export function richDiff(before: string, after: string, doc: Document = document, onShow: () => void = () => {}): RichResult {
  const segs = segments(before, after);
  const root = doc.createElement('div');
  root.className = 'preview rd';
  const count = { added: 0, removed: 0, changed: 0 };

  const nodes: { el: HTMLElement | DocumentFragment; same: boolean }[] = segs.map((s) => {
    if (s.kind === 'same') return { el: wrap(doc, 'same', s.block.html), same: true };
    if (s.kind === 'added') { count.added++; return { el: wrap(doc, 'added', s.block.html), same: false }; }
    if (s.kind === 'removed') { count.removed++; return { el: wrap(doc, 'removed', s.block.html), same: false }; }
    count.changed++;
    // a changed diagram cannot be marked word by word: show the old picture and the new one
    if (s.before.html.includes('mermaid-block') || s.after.html.includes('mermaid-block')) {
      const pair = doc.createDocumentFragment();
      pair.append(wrap(doc, 'removed', s.before.html), wrap(doc, 'added', s.after.html));
      return { el: pair, same: false };
    }
    return { el: wrap(doc, 'changed', wordDiff(s.before, s.after, doc)), same: false };
  });

  for (let i = 0; i < nodes.length;) {
    if (!nodes[i]!.same) { root.append(nodes[i]!.el); i++; continue; }
    let j = i;
    while (j < nodes.length && nodes[j]!.same) j++;
    const run = nodes.slice(i, j);
    const head = i === 0 ? 0 : KEEP_AROUND, tail = j === nodes.length ? 0 : KEEP_AROUND;
    const hidden = run.slice(head, run.length - tail);
    if (run.length - head - tail < MIN_FOLD || hidden.length === 0) run.forEach((n) => root.append(n.el));
    else {
      run.slice(0, head).forEach((n) => root.append(n.el));
      const gap = doc.createElement('button');
      gap.className = 'rd-gap';
      gap.type = 'button';
      gap.textContent = `⋯ ${hidden.length} unchanged section${hidden.length === 1 ? '' : 's'} (show)`;
      gap.onclick = () => { gap.replaceWith(...hidden.map((n) => n.el)); onShow(); };       // onShow: e.g. draw the diagrams that were folded away
      root.append(gap);
      run.slice(run.length - tail).forEach((n) => root.append(n.el));
    }
    i = j;
  }
  return { root, ...count };
}
