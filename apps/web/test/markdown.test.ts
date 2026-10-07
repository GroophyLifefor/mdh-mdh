// The preview shows text written by OTHER people. Whatever they write must stay text.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { renderMarkdown } from '../src/lib/markdown';

const ALLOWED_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'A', 'EM', 'STRONG', 'CODE', 'PRE', 'SPAN', 'BLOCKQUOTE', 'HR', 'BR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'DEL', 'INPUT', 'DIV']);
const ALLOWED_ATTRS = new Set(['href', 'rel', 'target', 'class', 'align', 'start', 'type', 'checked', 'disabled', 'data-mermaid', 'data-line']);

/** Parses the rendered HTML and returns everything a browser could run or load. */
function dangers(html: string): string[] {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const found: string[] = [];
  doc.body.querySelectorAll('*').forEach((el) => {
    if (!ALLOWED_TAGS.has(el.tagName)) found.push(`<${el.tagName.toLowerCase()}>`);
    if (el.tagName === 'INPUT' && el.getAttribute('type') !== 'checkbox') found.push('input that is not a checkbox');
    for (const a of el.getAttributeNames()) {
      if (!ALLOWED_ATTRS.has(a)) found.push(`attribute ${a}`);
      if (/^on/i.test(a)) found.push(`handler ${a}`);
    }
    const href = el.getAttribute('href');
    if (href !== null && !/^(https?:|mailto:|#)/i.test(href)) found.push(`href ${href}`);
    if (el.tagName === 'A' && el.getAttribute('target') === '_blank' && !/noopener/.test(el.getAttribute('rel') ?? '')) found.push('target=_blank without noopener');
  });
  return found;
}

const PAYLOADS = [
  '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">x</a>', '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](  javascript:alert(1))', '[x](data:text/html;base64,PHNjcmlwdD4=)',
  '[x](vbscript:msgbox(1))', '![x](javascript:alert(1))', '![x](https://evil.example/track.png)', '![x](x" onerror="alert(1))',
  '<details open ontoggle=alert(1)>', '<style>@import "https://evil.example"</style>', '<link rel=stylesheet href=//evil.example>', '<meta http-equiv=refresh content="0;url=//evil.example">',
  '<form action=//evil.example><input name=pw></form>', '<base href="//evil.example/">', '<object data="x"></object>', '<embed src="x">',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>', '<a href="x" onclick="alert(1)">x</a>', '"><script>alert(1)</script>', "'><img src=x onerror=alert(1)>",
  '[x]("onmouseover="alert(1))', '<https://evil.example>', '<javascript:alert(1)>', '[a]: javascript:alert(1)\n\n[a]',
  '```html\n<script>alert(1)</script>\n```', '```js\n</code></pre><script>alert(1)</script>\n```', '```<img onerror=alert(1)>\n x\n```', '    <script>alert(1)</script>',
  '| a |\n|---|\n| <img src=x onerror=alert(1)> |', '- [ ] <img src=x onerror=alert(1)>', '# <script>alert(1)</script>', '*<img src=x onerror=alert(1)>*', '&lt;script&gt;alert(1)&lt;/script&gt;',
  '```mermaid\n"><img src=x onerror=alert(1)>\n```', '```mermaid\n</code></pre></div><script>alert(1)</script>\n```',
  '<scr<script>ipt>alert(1)</scr</script>ipt>', '<IMG SRC=jAvascript:alert(1)>', '<a href=&#106;avascript:alert(1)>x</a>', '[x](&#106;avascript:alert(1))',
];

describe('renderMarkdown is safe for hostile input', () => {
  it.each(PAYLOADS)('%j produces nothing a browser can run or load', (payload) => {
    expect(dangers(renderMarkdown(payload)), payload).toEqual([]);
  });

  it('shows raw HTML as visible text instead of dropping it silently', () => {
    expect(renderMarkdown('<b>hi</b>')).toContain('&lt;b&gt;hi&lt;/b&gt;');
  });
  it('keeps normal links, with noopener', () => {
    const html = renderMarkdown('[site](https://example.com/a?b=1&c=2) and [mail](mailto:a@b.co) and [here](#top)');
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(html).toContain('href="mailto:a@b.co"');
    expect(html).toContain('href="#top"');
    expect(html.match(/rel="noopener"/g)).toHaveLength(3);
  });
  it('turns a javascript: link into plain text', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('href');
    expect(html).toContain('click');
  });
  it('shows an image as its alt text only (no request to another site)', () => {
    const html = renderMarkdown('![logo](https://evil.example/pixel.png)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('logo');
  });

  describe('code blocks', () => {
    it('highlights known languages and keeps the text intact', () => {
      const html = renderMarkdown('```ts\nconst x: number = 1; // hi\n```');
      expect(html).toContain('class="hljs"');
      expect(html).toContain('hljs-keyword');
      expect(new DOMParser().parseFromString(html, 'text/html').body.textContent).toContain('const x: number = 1; // hi');
    });
    it.each(['js', 'javascript', 'ts', 'json', 'yaml', 'yml', 'bash', 'sh', 'python', 'py', 'html', 'xml', 'css', 'sql', 'diff', 'markdown', 'md', 'go'])('knows %s', (lang) => {
      expect(renderMarkdown('```' + lang + '\nx\n```')).toContain('<pre><code class="hljs">');
    });
    it('escapes unknown languages and code with no language', () => {
      for (const fence of ['```nosuchlang', '```']) {
        const html = renderMarkdown(`${fence}\n<script>alert(1)</script>\n\`\`\``);
        expect(html).toContain('&lt;script&gt;');
        expect(dangers(html)).toEqual([]);
      }
    });
    it('escapes html inside a highlighted html block', () => {
      const html = renderMarkdown('```html\n<img src=x onerror=alert(1)>\n```');
      expect(dangers(html)).toEqual([]);
      expect(new DOMParser().parseFromString(html, 'text/html').body.textContent).toContain('<img src=x onerror=alert(1)>');
    });
    it('a hostile language name cannot break out of the tag', () => {
      expect(dangers(renderMarkdown('```"><script>alert(1)</script>\nx\n```'))).toEqual([]);
    });
  });

  it('property: random markup-looking text never produces anything outside the allowed tags and attributes', () => {
    const piece = fc.constantFrom('<', '>', '"', "'", '&', '[', ']', '(', ')', '!', '`', '*', '_', '#', '\n', ' ', 'script', 'img', 'onerror=', 'javascript:', 'http://x.y', 'a', '=', '/', '{', '}', '|', '-');
    fc.assert(fc.property(fc.array(piece, { maxLength: 40 }).map((a) => a.join('')), (md) => {
      expect(dangers(renderMarkdown(md)), md).toEqual([]);
    }), { numRuns: 800 });
  });
});
