import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';
import markdown from 'highlight.js/lib/languages/markdown';
import go from 'highlight.js/lib/languages/go';
import { esc } from './shared';

for (const [name, lang] of Object.entries({ javascript, typescript, json, yaml, bash, python, xml, css, sql, diff, markdown, go })) {
  hljs.registerLanguage(name, lang);
}

let showImages = false;

// Never render raw html, images or unsafe links: shared projects are written by other people.
marked.use({
  renderer: {
    html: ({ text }) => esc(text),
    // pictures are never loaded (other people wrote this text); the preview shows the alt text, the diff views a visible label
    image: ({ text, href }) => (showImages ? `<span class="md-image">Image: ${esc(text || 'no description')}<span class="md-image-src"> (${esc(href)})</span></span>` : esc(text)),
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens);
      return /^(https?:|mailto:|#)/i.test(href) ? `<a href="${esc(href)}" rel="noopener" target="_blank">${inner}</a>` : inner;
    },
    code({ text, lang }) {
      const l = (lang || '').split(/\s/)[0];
      // a mermaid diagram: the source stays in the page (escaped) and is drawn afterwards by lib/mermaid.ts
      if (l === 'mermaid') return `<div class="mermaid-block" data-mermaid="${esc(text)}"><pre><code class="hljs">${esc(text)}</code></pre></div>`;
      const body = l && hljs.getLanguage(l) ? hljs.highlight(text, { language: l, ignoreIllegals: true }).value : esc(text);
      return `<pre><code class="hljs">${body}</code></pre>`;
    },
  },
});

export const renderMarkdown = (text: string) => marked.parse(text, { async: false }) as string;

/** Like renderMarkdown, but a picture is drawn as a visible label "Image: alt (address)" (for the diff views, so adding or removing one can be seen). */
export function renderMarkdownShowingImages(text: string): string {
  showImages = true;
  try { return renderMarkdown(text); } finally { showImages = false; }
}

export type Block = { raw: string; html: string; type: string };

/** The top-level blocks of a markdown text (heading, paragraph, list, code, table...), each already drawn. For the rich diff. */
export function markdownBlocks(text: string): Block[] {
  showImages = true;
  try { return blocksOf(text); } finally { showImages = false; }
}

function blocksOf(text: string): Block[] {
  const tokens = marked.lexer(text);
  const out: Block[] = [];
  for (const t of tokens) {
    if (t.type === 'space') continue;
    const html = marked.parser(Object.assign([t], { links: tokens.links }) as unknown as typeof tokens);
    if (html.trim() === '') continue;                                           // e.g. a link definition, which draws nothing
    out.push({ raw: t.raw.replace(/\s+/g, ' ').trim(), html, type: t.type });
  }
  return out;
}

/**
 * Like renderMarkdown, but every top-level block carries `data-line="N"`, the source line it starts at. The preview uses it to
 * scroll together with the editor. The result is the same as renderMarkdown's apart from those attributes.
 */
export function renderMarkdownLines(text: string): string {
  const tokens = marked.lexer(text);
  let line = 1;
  const out: string[] = [];
  for (const t of tokens) {
    const lead = /^\n*/.exec(t.raw)![0].length;
    const html = marked.parser(Object.assign([t], { links: tokens.links }) as unknown as typeof tokens);
    out.push(t.type === 'space' ? html : html.replace(/^(\s*<[a-zA-Z][^\s>]*)/, `$1 data-line="${line + lead}"`));
    line += (t.raw.match(/\n/g) ?? []).length;
  }
  return out.join('');
}
