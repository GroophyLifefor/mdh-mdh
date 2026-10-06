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

// Never render raw html, images or unsafe links: shared projects are written by other people.
marked.use({
  renderer: {
    html: ({ text }) => esc(text),
    image: ({ text }) => esc(text),
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
