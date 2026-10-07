import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildAnchors, lineToTop, topToLine } from '../src/lib/scrollsync';
import { renderMarkdown, renderMarkdownLines } from '../src/lib/markdown';

describe('buildAnchors', () => {
  it('adds a start (line 1 = top 0) and an end (after the last line = the content height)', () => {
    expect(buildAnchors([{ line: 5, top: 100 }], 20, 900)).toEqual([{ line: 1, top: 0 }, { line: 5, top: 100 }, { line: 21, top: 900 }]);
  });
  it('a block on line 1 does not repeat the start, and a document without blocks is a straight line', () => {
    expect(buildAnchors([{ line: 1, top: 0 }, { line: 3, top: 40 }], 10, 200)).toEqual([{ line: 1, top: 0 }, { line: 3, top: 40 }, { line: 11, top: 200 }]);
    expect(buildAnchors([], 10, 200)).toEqual([{ line: 1, top: 0 }, { line: 11, top: 200 }]);
  });
  it('ignores blocks outside the document, keeps the first of two on the same line, and never lets a top go backwards', () => {
    const a = buildAnchors([{ line: 99, top: 5 }, { line: 4, top: 80 }, { line: 4, top: 999 }, { line: 6, top: 50 }], 10, 300);
    expect(a.map((x) => x.line)).toEqual([1, 4, 6, 11]);
    for (let i = 1; i < a.length; i++) expect(a[i]!.top).toBeGreaterThanOrEqual(a[i - 1]!.top);
  });
});

describe('lineToTop / topToLine', () => {
  const anchors = buildAnchors([{ line: 3, top: 50 }, { line: 4, top: 400 }, { line: 8, top: 450 }], 10, 600);
  it('hits the anchors exactly and interpolates between them', () => {
    expect(lineToTop(1, anchors)).toBe(0);
    expect(lineToTop(3, anchors)).toBe(50);
    expect(lineToTop(3.5, anchors)).toBe(225);                 // halfway through a tall block (3 -> 4 is 350 px)
    expect(lineToTop(6, anchors)).toBe(425);                   // 4 -> 8 is only 50 px: a tall preview block can be a short piece of source
    expect(lineToTop(11, anchors)).toBe(600);
  });
  it('stays in range for lines before the start or after the end', () => {
    expect(lineToTop(-5, anchors)).toBe(0);
    expect(lineToTop(500, anchors)).toBe(600);
  });
  it('the other way round', () => {
    expect(topToLine(0, anchors)).toBe(1);
    expect(topToLine(225, anchors)).toBe(3.5);
    expect(topToLine(600, anchors)).toBe(11);
    expect(topToLine(-10, anchors)).toBe(1);
  });
  it('PROPERTY: going there and back finds the same line; more source never means higher up; ends match', () => {
    const blocks = fc.array(fc.record({ line: fc.integer({ min: 1, max: 200 }), top: fc.integer({ min: 0, max: 5000 }) }), { maxLength: 40 });
    fc.assert(fc.property(blocks, fc.integer({ min: 200, max: 300 }), fc.integer({ min: 5000, max: 9000 }), fc.double({ min: 1, max: 250, noNaN: true }), (b, total, height, line) => {
      const a = buildAnchors(b, total, height);
      const top = lineToTop(line, a);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThanOrEqual(height + 1e-6);
      expect(lineToTop(line + 1, a)).toBeGreaterThanOrEqual(top - 1e-9);
      const back = lineToTop(topToLine(top, a), a);              // a position survives the round trip, even where several lines share it
      expect(Math.abs(back - top)).toBeLessThan(1e-6);
      expect(lineToTop(1, a)).toBe(0);
    }), { numRuns: 300 });
  });
});

describe('renderMarkdownLines', () => {
  const lineOf = (html: string, re: RegExp) => Number(new RegExp(`data-line="(\\d+)"[^>]*>[^<]*${re.source}`).exec(html)?.[1]);
  const doc = '# Title\n\nFirst paragraph\nspans two lines.\n\n```ts\nlet a = 1\nlet b = 2\n```\n\n- one\n- two\n\n\n## Second\n\nLast.\n';
  it('every block says which source line it starts at', () => {
    const html = renderMarkdownLines(doc);
    expect(lineOf(html, /Title/)).toBe(1);
    expect(lineOf(html, /First paragraph/)).toBe(3);
    expect(html).toMatch(/<pre data-line="6">/);
    expect(html).toMatch(/<ul data-line="11">/);
    expect(lineOf(html, /Second/)).toBe(15);
    expect(lineOf(html, /Last\./)).toBe(17);
  });
  it('the page is the same as the normal render, apart from the attributes', () => {
    expect(renderMarkdownLines(doc).replace(/ data-line="\d+"/g, '')).toBe(renderMarkdown(doc));
  });
  it('PROPERTY: for any markdown the stripped result equals the normal render, and the lines only go forward', () => {
    const piece = fc.constantFrom('# H', 'text', '- a\n- b', '1. x', '> q', '```\ncode\n```', '| a | b |\n|---|---|\n| 1 | 2 |', '---', '<b>raw</b>', '[x]: https://e.com', '![i](u.png)', '');
    fc.assert(fc.property(fc.array(piece, { maxLength: 14 }), fc.constantFrom('\n', '\n\n', '\n\n\n'), (parts, sep) => {
      const md = parts.join(sep);
      const html = renderMarkdownLines(md);
      expect(html.replace(/ data-line="\d+"/g, '')).toBe(renderMarkdown(md));
      const lines = [...html.matchAll(/data-line="(\d+)"/g)].map((m) => Number(m[1]));
      for (let i = 1; i < lines.length; i++) expect(lines[i]).toBeGreaterThan(lines[i - 1]!);
      for (const n of lines) expect(n).toBeLessThanOrEqual(md.split('\n').length);
    }), { numRuns: 200 });
  });
  it('hostile text gets no new tag or attribute from this (only data-line)', () => {
    const html = renderMarkdownLines('<script>alert(1)</script>\n\n"><img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))');
    expect(new DOMParser().parseFromString(html, 'text/html').querySelector('script, img, [onerror]')).toBeNull();
  });
});
