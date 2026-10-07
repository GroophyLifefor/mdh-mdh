import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { richDiff, segments, similarity } from '../src/lib/richdiff';
import { markdownBlocks, renderMarkdown, renderMarkdownShowingImages } from '../src/lib/markdown';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
/** The text of a block with some elements taken out. */
const textWithout = (el: Element, selector: string) => { const c = el.cloneNode(true) as Element; c.querySelectorAll(selector).forEach((n) => n.remove()); return norm(c.textContent ?? ''); };
const kinds = (before: string, after: string) => segments(before, after).map((s) => s.kind);

describe('markdownBlocks', () => {
  it('splits into top-level blocks, drawn, without blank spacing', () => {
    const blocks = markdownBlocks('# Title\n\nA paragraph.\n\n- one\n- two\n\n```ts\nlet a = 1\n```\n');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'code']);
    expect(blocks[0]!.html).toContain('<h1');
    expect(blocks[2]!.html).toContain('<li>');
  });
  it('a link definition draws nothing and is not a block', () => {
    expect(markdownBlocks('See [x][a].\n\n[a]: https://example.com\n').map((b) => b.type)).toEqual(['paragraph']);
  });
});

describe('segments', () => {
  it('knows what stayed, what is new, what is gone and what changed', () => {
    expect(kinds('# A\n\nSame.\n\nOld paragraph about cats.', '# A\n\nSame.\n\nNew paragraph about cats and dogs.\n\nBrand new.')).toEqual(['same', 'same', 'changed', 'added']);
    expect(kinds('One.\n\nTwo.', 'One.')).toEqual(['same', 'removed']);
    expect(kinds('', 'Hello world.')).toEqual(['added']);
  });
  it('unrelated blocks are removed + added, not "changed"; blocks of different kinds never pair', () => {
    expect(kinds('The quick brown fox.', 'Entirely different sentence here.')).toEqual(['removed', 'added']);                         // the old one first, then what replaced it
    expect(kinds('same words here', '# same words here')).not.toContain('changed');
    expect(similarity(markdownBlocks('a b c')[0]!, markdownBlocks('- a b c')[0]!)).toBe(0);
  });
  it('two different pictures do not look alike just because their addresses start the same', () => {
    expect(kinds('![removed one](https://x.test/gone.png)', '![brand new](https://x.test/new.png)')).toEqual(['removed', 'added']);
    expect(kinds('![old logo](https://x.test/a.png)', '![new logo](https://x.test/a.png)')).toEqual(['changed']);
  });
  it('a moved section shows as removed and added', () => {
    const k = kinds('Alpha one.\n\nBeta two.\n\nGamma three.', 'Beta two.\n\nGamma three.\n\nAlpha one.');
    expect(k).toContain('removed'); expect(k).toContain('added');
  });
});

describe('richDiff', () => {
  it('marks the changed words inside a changed paragraph: new ones <ins>, old ones <del>', () => {
    const r = richDiff('The server sends a request every minute.', 'The server sends a signed request every hour.');
    const block = r.root.querySelector('.rd-changed')!;
    expect([...block.querySelectorAll('ins')].map((n) => n.textContent)).toEqual(['signed ', 'hour']);
    expect([...block.querySelectorAll('del')].map((n) => n.textContent)).toEqual(['minute']);
    expect(r).toMatchObject({ added: 0, removed: 0, changed: 1 });
  });
  it('words inside bold, code and links are compared too, and the markup survives', () => {
    const r = richDiff('Use `old_name` and **bold text** here.', 'Use `new_name` and **bold words** here.');
    const block = r.root.querySelector('.rd-changed')!;
    expect(block.querySelector('code')).not.toBeNull();
    expect(block.querySelector('strong')).not.toBeNull();
    expect(block.textContent).toContain('new_name');
    expect(block.querySelector('del')!.textContent).toContain('old_name');
  });
  it('a list with one more item is ONE changed block with the new item underlined', () => {
    const r = richDiff('- apples\n- pears\n', '- apples\n- pears\n- plums\n');
    expect(r.root.querySelectorAll('.rd-changed')).toHaveLength(1);
    expect(r.root.querySelector('.rd-changed ins')!.textContent).toContain('plums');
    expect(r.root.querySelectorAll('.rd-changed li')).toHaveLength(3);
  });
  it('an unchanged list item is left alone even when its neighbours change (its full stop is not taken for another item\'s)', () => {
    const r = richDiff('- Results appear while typing.\n- Titles rank higher than body text.\n', '- Results appear while typing, in under 100 ms.\n- Titles rank higher than body text.\n- Typos are forgiven.\n');
    const marked = [...r.root.querySelectorAll('ins')].map((n) => n.textContent);
    expect(marked.join('|')).toBe(', in under 100 ms|Typos are forgiven.');        // nothing in the middle item
    expect(r.root.querySelector('li:nth-child(2) ins, li:nth-child(2) del')).toBeNull();
  });
  it('an added section keeps its own formatting (a heading stays a heading, code stays code)', () => {
    const r = richDiff('Intro.', 'Intro.\n\n## New part\n\n```ts\nlet x = 1\n```');
    expect(r.root.querySelector('.rd-added h2')!.textContent).toBe('New part');
    expect(r.root.querySelector('.rd-added pre code')).not.toBeNull();
    expect(r.added).toBe(2);
  });
  it('a removed section is shown (red) where it used to be', () => {
    const r = richDiff('First.\n\nGone section here.\n\nLast.', 'First.\n\nLast.');
    const order = [...r.root.children].map((c) => c.className.replace('rd-block ', ''));
    expect(order).toEqual(['rd-same', 'rd-removed', 'rd-same']);
    expect(r.root.querySelector('.rd-removed')!.textContent).toContain('Gone section');
  });
  it('folds long unchanged stretches behind a button that shows them', () => {
    const sections = Array.from({ length: 10 }, (_, i) => `Section number ${i} stays.`).join('\n\n');
    const r = richDiff(`${sections}\n\nTail old text here.`, `${sections}\n\nTail new text here.`);
    const gap = r.root.querySelector<HTMLButtonElement>('button.rd-gap')!;
    expect(gap.textContent).toContain('9 unchanged sections');
    expect(r.root.querySelectorAll('.rd-same')).toHaveLength(1);               // one section of context stays visible
    gap.click();
    expect(r.root.querySelector('button.rd-gap')).toBeNull();
    expect(r.root.querySelectorAll('.rd-same')).toHaveLength(10);
  });
  it('a short unchanged stretch is not folded, and an identical text has only unchanged sections', () => {
    expect(richDiff('A one.\n\nB two.\n\nC three.\n\nX old.', 'A one.\n\nB two.\n\nC three.\n\nX new.').root.querySelector('.rd-gap')).toBeNull();
    const same = richDiff('Same text.\n\nAnother.', 'Same text.\n\nAnother.');
    expect([...same.root.querySelectorAll('.rd-block')].every((b) => b.classList.contains('rd-same'))).toBe(true);
    expect(same).toMatchObject({ added: 0, removed: 0, changed: 0 });
  });
  it('PROPERTY: taking out the <del>s leaves exactly the new text, taking out the <ins>s leaves the old text', () => {
    const word = fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta');
    const sentence = fc.array(word, { minLength: 3, maxLength: 12 }).map((w) => w.join(' '));
    fc.assert(fc.property(sentence, sentence, (x, y) => {
      const r = richDiff(x, y);
      const block = r.root.querySelector('.rd-block')!;
      if (block.classList.contains('rd-changed')) {
        expect(textWithout(block, 'del')).toBe(norm(y));
        expect(textWithout(block, 'ins')).toBe(norm(x));
      } else if (x === y) expect(block.classList.contains('rd-same')).toBe(true);
    }), { numRuns: 200 });
  });
});

describe('richDiff is safe for hostile text', () => {
  const ALLOWED = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'A', 'EM', 'STRONG', 'CODE', 'PRE', 'SPAN', 'BLOCKQUOTE', 'HR', 'BR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'DEL', 'INS', 'DIV', 'BUTTON', 'INPUT']);
  const payloads = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '"><svg onload=alert(1)>', '<iframe src="javascript:alert(1)"></iframe>', '```mermaid\n"><img src=x onerror=alert(1)>\n```', '<a href="x" onclick="alert(1)">x</a>'];
  it('adds no element, handler or script link of its own, for every payload on either side', () => {
    for (const p of payloads) for (const [x, y] of [[p, 'plain'], ['plain', p], [`old ${p}`, `new ${p}`]] as const) {
      const root = richDiff(x, y).root;
      for (const el of root.querySelectorAll('*')) {
        expect(ALLOWED.has(el.tagName), `${el.tagName} from ${p}`).toBe(true);
        for (const a of el.getAttributeNames()) expect(/^on/i.test(a), `${a} from ${p}`).toBe(false);
        const href = el.getAttribute('href');
        if (href !== null) expect(/^(https?:|mailto:|#)/i.test(href)).toBe(true);
      }
    }
  });
});

describe('pictures in markdown', () => {
  const chips = (root: Element) => [...root.querySelectorAll('.md-image')].map((n) => norm(n.textContent ?? ''));

  it('the normal preview still shows only the alt text (nothing is ever loaded), also after the diff drew labels', () => {
    expect(renderMarkdown('![a cat](https://x.test/cat.png)')).toBe('<p>a cat</p>\n');
    markdownBlocks('![x](u.png)');
    expect(renderMarkdown('![a cat](https://x.test/cat.png)')).toBe('<p>a cat</p>\n');
    expect(renderMarkdownShowingImages('![a cat](https://x.test/cat.png)')).toContain('class="md-image"');
    expect(renderMarkdown('![a](u.png)')).not.toContain('md-image');
  });
  it('an added picture is a visible "Image: ..." label in an added section', () => {
    const r = richDiff('Text.', 'Text.\n\n![diagram](https://x.test/a.png)');
    expect(chips(r.root.querySelector('.rd-added')!)).toEqual(['Image: diagram (https://x.test/a.png)']);
    expect(r.added).toBe(1);
  });
  it('a removed picture is a label in a removed section', () => {
    const r = richDiff('Text.\n\n![diagram](https://x.test/a.png)', 'Text.');
    expect(chips(r.root.querySelector('.rd-removed')!)).toEqual(['Image: diagram (https://x.test/a.png)']);
    expect(r.removed).toBe(1);
  });
  it('a picture added or removed inside a sentence is marked inside that sentence', () => {
    const added = richDiff('Look here.', 'Look ![chart](c.png) here.').root.querySelector('.rd-changed')!;
    expect(textWithout(added, 'ins')).toBe('Look here.');
    expect(added.querySelector('ins .md-image, .md-image ins, ins')!.textContent).toContain('chart');
    const removed = richDiff('Look ![chart](c.png) here.', 'Look here.').root.querySelector('.rd-changed')!;
    expect(removed.querySelector('del')!.textContent).toContain('chart');
  });
  it('a changed description or a changed address is a visible change (it used to look like "nothing changed")', () => {
    const alt = richDiff('![a](https://x.test/a.png)', '![b](https://x.test/a.png)').root.querySelector('.rd-changed')!;
    expect(alt.querySelector('del')!.textContent).toBe('a');
    expect(alt.querySelector('ins')!.textContent).toBe('b');
    const src = richDiff('![a](https://x.test/old.png)', '![a](https://x.test/new.png)').root.querySelector('.rd-changed')!;
    expect(src.querySelector('del')!.textContent).toContain('old');
    expect(src.querySelector('ins')!.textContent).toContain('new');
  });
  it('a picture without a description says so; a title is ignored; a reference-style picture shows its address', () => {
    expect(chips(richDiff('', '![](u.png)').root)).toEqual(['Image: no description (u.png)']);
    expect(chips(richDiff('', '![a](u.png "A title")').root)).toEqual(['Image: a (u.png)']);
    expect(chips(richDiff('', '![a][r]\n\n[r]: https://x.test/ref.png').root)).toEqual(['Image: a (https://x.test/ref.png)']);
    expect(chips(richDiff('', '[![a](u.png)](https://example.com)').root)).toEqual(['Image: a (u.png)']);
  });
  it('hostile descriptions and addresses stay text: no <img>, no handlers, no script links', () => {
    const evil = ['![\"><img src=x onerror=alert(1)>](javascript:alert(1))', '![x](data:text/html,<script>alert(1)</script>)', '![<script>alert(1)</script>](https://x.test/a.png)', '![a](" onerror="alert(1))'];
    for (const md of evil) for (const [x, y] of [['', md], [md, ''], ['![ok](ok.png)', md]] as const) {
      const root = richDiff(x, y).root;
      expect(root.querySelector('img, script, iframe'), md).toBeNull();
      for (const el of root.querySelectorAll('*')) for (const a of el.getAttributeNames()) expect(/^on|^src$|^href$/i.test(a), `${a} from ${md}`).toBe(false);
    }
  });
});

describe('mermaid diagrams in the diff', () => {
  const diagram = (to: string) => `\`\`\`mermaid\ngraph TD\n  A-->${to}\n\`\`\``;
  const sources = (root: Element, sel: string) => [...root.querySelectorAll(`${sel} .mermaid-block`)].map((n) => (n as HTMLElement).dataset.mermaid);

  it('an added diagram sits in an added section, a removed one in a removed section (source kept for drawing)', () => {
    const add = richDiff('Intro.', `Intro.\n\n${diagram('B')}`);
    expect(sources(add.root, '.rd-added')).toEqual(['graph TD\n  A-->B']);
    const del = richDiff(`Intro.\n\n${diagram('B')}`, 'Intro.');
    expect(sources(del.root, '.rd-removed')).toEqual(['graph TD\n  A-->B']);
  });
  it('a CHANGED diagram shows the old one (red) and the new one (green), not a word diff of its source', () => {
    const r = richDiff(`Intro.\n\n${diagram('B')}`, `Intro.\n\n${diagram('C')}`);
    expect(sources(r.root, '.rd-removed')).toEqual(['graph TD\n  A-->B']);
    expect(sources(r.root, '.rd-added')).toEqual(['graph TD\n  A-->C']);
    expect(r.root.querySelector('ins, del')).toBeNull();
    expect(r.changed).toBe(1);
  });
  it('a diagram next to changed text: unchanged diagram stays, the text change is a word diff', () => {
    const r = richDiff(`The old words.\n\n${diagram('B')}`, `The new words.\n\n${diagram('B')}`);
    expect(r.root.querySelector('.rd-changed ins')!.textContent).toBe('new');
    expect(sources(r.root, '.rd-same')).toEqual(['graph TD\n  A-->B']);
  });
  it('a folded unchanged diagram is drawn when the fold is opened (the callback runs)', () => {
    const filler = Array.from({ length: 6 }, (_, i) => `Filler ${i} stays.`).join('\n\n');
    let shown = 0;
    const r = richDiff(`${filler}\n\n${diagram('B')}\n\n${filler}\n\nEnd old text here.`, `${filler}\n\n${diagram('B')}\n\n${filler}\n\nEnd new text here.`, document, () => shown++);
    expect(r.root.querySelector('.mermaid-block')).toBeNull();                       // folded away
    r.root.querySelector<HTMLButtonElement>('button.rd-gap')!.click();
    expect(r.root.querySelector('.mermaid-block')).not.toBeNull();
    expect(shown).toBe(1);
  });
  it('a hostile diagram source stays inside its attribute', () => {
    const r = richDiff('', '```mermaid\n"><img src=x onerror=alert(1)><script>alert(2)</script>\n```');
    expect(r.root.querySelector('img, script')).toBeNull();
    expect(r.root.querySelector<HTMLElement>('.mermaid-block')!.dataset.mermaid).toContain('<script>');   // as data, not as an element
  });
  it('a diagram turned into text or text turned into a diagram is removed + added', () => {
    const k = kinds(`Intro.\n\n${diagram('B')}`, 'Intro.\n\nJust a sentence now.');
    expect(k).toContain('removed'); expect(k).toContain('added');
  });
});
