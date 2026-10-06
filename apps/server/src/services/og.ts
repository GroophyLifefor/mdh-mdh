import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

// The fonts sit in assets/fonts (src/services/ when running from source, dist/ when bundled).
const fontDir = [new URL('./assets/fonts/', import.meta.url), new URL('../../assets/fonts/', import.meta.url)]
  .map((u) => fileURLToPath(u)).find((p) => existsSync(p)) ?? fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const fontFiles = ['Inter_400Regular.ttf', 'Inter_600SemiBold.ttf'].map((f) => fontDir + f);

const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Names the card font can draw: Latin letters, digits, spaces and common punctuation. Anything else gets the plain card. */
const DRAWABLE = /^[\p{Script=Latin}\p{N}\p{Zs}!-/:-@[-`{-~’‘“”–—…·]+$/u;
export const canDraw = (name: string) => DRAWABLE.test(name);

/** Breaks text into lines of at most `maxChars` characters (words stay whole; a word longer than a line is cut). */
export function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > maxChars) {
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxChars) line += ' ' + word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

/** The biggest type size at which the title fits in at most three lines; longer titles are cut with an ellipsis. */
export function layoutTitle(title: string): { size: number; lines: string[] } {
  const width = 1040;
  for (const size of [84, 68, 56]) {
    const lines = wrap(title, Math.floor(width / (size * 0.6)));
    if (lines.length <= (size === 56 ? 3 : 2)) return { size, lines };
  }
  const size = 56;
  const lines = wrap(title, Math.floor(width / (size * 0.6)));
  const kept = lines.slice(0, 3);
  kept[2] = kept[2]!.slice(0, Math.max(0, kept[2]!.length - 1)).trimEnd() + '…';
  return { size, lines: kept };
}

/** The brand mark (rounded square with a # and a colon), drawn at (x, y) with the given size. */
const mark = (x: number, y: number, size: number) =>
  `<g transform="translate(${x} ${y}) scale(${size / 132}) translate(-274 -64)"><rect x="280" y="70" width="120" height="120" rx="28" fill="none" stroke="#0b0b0b" stroke-width="6"/>` +
  `<g stroke="#0b0b0b" stroke-width="6" stroke-linecap="round"><line x1="315" y1="100" x2="315" y2="160"/><line x1="337" y1="100" x2="337" y2="160"/><line x1="306" y1="118" x2="346" y2="118"/><line x1="306" y1="142" x2="346" y2="142"/></g>` +
  `<circle cx="371" cy="118" r="5.5" fill="#1D9E75"/><circle cx="371" cy="142" r="5.5" fill="#1D9E75"/></g>`;

export type Card = { title: string; subtitle: string };

export const DEFAULT_CARD: Card = { title: 'Markdown and YAML workspaces', subtitle: 'Share with a password. Roll back anything.' };
export const projectCard = (name: string): Card => ({
  title: canDraw(name) ? name : 'A shared workspace',
  subtitle: 'Protected workspace. Open the link and enter the password.',
});

export function cardSvg(card: Card): string {
  const { size, lines } = layoutTitle(card.title);
  const lineHeight = Math.round(size * 1.18);
  const top = 330 - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines.map((l, i) => `<text x="80" y="${top + i * lineHeight}" font-family="Inter" font-weight="600" font-size="${size}" fill="#0b0b0b">${escapeXml(l)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">` +
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#ffffff"/><rect x="0" y="0" width="${CARD_WIDTH}" height="10" fill="#1D9E75"/>` +
    mark(80, 70, 84) +
    `<text x="188" y="128" font-family="Inter" font-weight="600" font-size="40" fill="#0b0b0b">mdh-mdh</text>` +
    tspans +
    `<text x="80" y="560" font-family="Inter" font-weight="400" font-size="30" fill="#71717a">${escapeXml(card.subtitle)}</text></svg>`;
}

/** PNG bytes of the link-preview card. */
export function renderCard(card: Card): Buffer {
  return new Resvg(cardSvg(card), {
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Inter' },
    fitTo: { mode: 'original' },
  }).render().asPng();
}

/** Renders are cached (newest last); the key contains the name, so a rename shows up at once. */
export class CardCache {
  private map = new Map<string, Buffer>();
  constructor(private readonly max = 200) {}
  get(key: string, make: () => Buffer): Buffer {
    const hit = this.map.get(key);
    if (hit) { this.map.delete(key); this.map.set(key, hit); return hit; }
    const png = make();
    this.map.set(key, png);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return png;
  }
}
