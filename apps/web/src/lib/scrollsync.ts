// Scrolling the editor and the preview together. Matching by percentage drifts as soon as a document has a tall code block,
// a table or a diagram (one source line is not one preview pixel). So both sides are tied by ANCHORS: for each block of the
// preview, the source line it starts at and where it starts in the preview. In between, positions are interpolated.
export type Anchor = { line: number; top: number };

/** Anchors from the measured blocks, with a start (line 1 = top 0) and an end (just after the last line = end of the content). Tops never go backwards. */
export function buildAnchors(blocks: Anchor[], totalLines: number, contentHeight: number): Anchor[] {
  const sorted = [...blocks].filter((b) => b.line >= 1 && b.line <= totalLines).sort((a, b) => a.line - b.line);
  const out: Anchor[] = [{ line: 1, top: 0 }];
  for (const b of sorted) {
    const last = out[out.length - 1]!;
    if (b.line <= last.line) continue;                                       // two blocks on one line: the first one wins
    out.push({ line: b.line, top: Math.max(last.top, b.top) });
  }
  const last = out[out.length - 1]!;
  out.push({ line: Math.max(totalLines + 1, last.line + 1), top: Math.max(last.top, contentHeight) });
  return out;
}

/** The segment [i, i+1] that holds `value` of the given key (anchors are sorted by both keys). */
function segment(anchors: Anchor[], value: number, key: 'line' | 'top'): number {
  let lo = 0, hi = anchors.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (anchors[mid]![key] <= value) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Where in the preview (pixels) the given source line (may be fractional: 12.5 = halfway through line 12) is. */
export function lineToTop(line: number, anchors: Anchor[]): number {
  const i = segment(anchors, line, 'line');
  const a = anchors[i]!, b = anchors[i + 1]!;
  const t = Math.min(1, Math.max(0, (line - a.line) / (b.line - a.line)));
  return a.top + t * (b.top - a.top);
}

/** Which source line (fractional) is at the given preview position. If several lines share a position (a block that takes no room) the first one is returned. */
export function topToLine(top: number, anchors: Anchor[]): number {
  const i = segment(anchors, top, 'top');
  const a = anchors[i]!, b = anchors[i + 1]!;
  if (b.top === a.top) return a.line;
  const t = Math.min(1, Math.max(0, (top - a.top) / (b.top - a.top)));
  return a.line + t * (b.line - a.line);
}
