import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown';
import { toPicture } from '../src/lib/mermaid';

describe('mermaid blocks in markdown', () => {
  it('become a placeholder that keeps the source (escaped) and shows it as code until drawn', () => {
    const html = renderMarkdown('```mermaid\ngraph TD\n  A["x"] --> B\n```');
    expect(html).toContain('class="mermaid-block"');
    expect(html).toContain('data-mermaid="graph TD\n  A[&quot;x&quot;] --&gt; B"');
    expect(html).toContain('<pre><code class="hljs">graph TD');
  });
  it('a hostile source cannot leave its attribute or add a tag', () => {
    const html = renderMarkdown('```mermaid\n"><img src=x onerror=alert(1)><script>alert(2)</script>\n```');
    expect(html).not.toMatch(/<img|<script/);
    expect(html.match(/data-mermaid="([^"]*)"/)![1]).not.toContain('<');
  });
  it('other languages and a language that only starts with mermaid are ordinary code', () => {
    expect(renderMarkdown('```ts\nlet a = 1\n```')).not.toContain('mermaid-block');
    expect(renderMarkdown('```mermaidx\nx\n```')).not.toContain('mermaid-block');
    expect(renderMarkdown('```mermaid extra words\ngraph TD\n```')).toContain('mermaid-block');
  });
});

describe('toPicture', () => {
  it('takes the natural width from the viewBox and makes a data url', () => {
    const p = toPicture('<svg viewBox="0 0 345.5 120" width="100%"><g/></svg>');
    expect(p.width).toBe(346);
    expect(p.url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(p.url.split(',')[1]!)).toContain('<g/>');
  });
  it('falls back to a sensible width without a viewBox', () => {
    expect(toPicture('<svg><g/></svg>').width).toBe(600);
  });
});
