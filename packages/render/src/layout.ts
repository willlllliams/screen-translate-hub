// Translation layout (spec 07 section 5): largest font that fits by binary search,
// then borrowing adjacent free space, then truncation. Measurement is injected so
// the same code runs with canvas measureText in browsers and a stub in tests.
import type { RectF } from '@sth/model';

/** Width of `text` at font size `px` along the line direction. */
export type Measure = (text: string, px: number) => number;

export interface FitInput {
  text: string;
  box: RectF;
  vertical: boolean;
  minPx: number;
  maxPx: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  measure: Measure;
  /** Boxes of the other paragraphs, which expansion must not cross. */
  others?: RectF[];
  /** The drawing area; expansion stops at its edges. */
  area?: { w: number; h: number };
}

export interface FitResult {
  px: number;
  lines: string[];
  box: RectF;
  truncated: boolean;
}

function isBreakChar(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  // CJK ideographs, kana, Hangul syllables, full-width forms: break between any two
  return (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef);
}

/** Split into unbreakable pieces (a simplified UAX #14): words with their trailing space, or single CJK chars. */
export function breakPieces(text: string): string[] {
  const pieces: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (isBreakChar(ch)) {
      if (cur) pieces.push(cur);
      cur = '';
      pieces.push(ch);
    } else if (ch === ' ') {
      pieces.push(`${cur} `);
      cur = '';
    } else if (ch === '-' && cur.length > 0) {
      pieces.push(`${cur}-`);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) pieces.push(cur);
  return keepPunctuation(pieces);
}

// Line-breaking rules for East Asian text (kinsoku): closing punctuation never starts a
// line and opening punctuation never ends one.
const NO_LINE_START = new Set([...'。，、．！？：；）」』】〉》〕｝”’…‥ー々ゝゞぁぃぅぇぉっゃゅょァィゥェォッャュョ%),.!?:;]}']);
const NO_LINE_END = new Set([...'（「『【〈《〔｛“‘([{']);

function keepPunctuation(pieces: string[]): string[] {
  const out: string[] = [];
  let carry = '';
  for (const p of pieces) {
    const piece = carry + p;
    carry = '';
    if (out.length > 0 && NO_LINE_START.has([...p][0]) && !out[out.length - 1].endsWith(' ')) {
      out[out.length - 1] += piece;
    } else if (NO_LINE_END.has([...piece].pop() ?? '')) {
      carry = piece;
    } else {
      out.push(piece);
    }
  }
  if (carry) out.push(carry);
  return out;
}

/** Greedy line filling: put as much as possible on each line (spec 07 section 5.3). */
export function wrap(text: string, px: number, width: number, measure: Measure): string[] {
  const pieces = breakPieces(text);
  const lines: string[] = [];
  let line = '';
  for (const p of pieces) {
    const candidate = line + p;
    if (line && measure(candidate.trimEnd(), px) > width) {
      lines.push(line.trimEnd());
      line = p.trimStart();
    } else {
      line = candidate;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

function fits(text: string, px: number, box: RectF, input: FitInput): string[] | null {
  const along = input.vertical ? box.h : box.w;
  const across = input.vertical ? box.w : box.h;
  const lines = wrap(text, px, along, input.measure);
  if (lines.some((l) => input.measure(l, px) > along + 0.5)) return null; // an unbreakable piece is too long
  return lines.length * px * input.lineHeight <= across + 0.5 ? lines : null;
}

/** Binary search the largest integer font size in [minPx, maxPx] that fits; null if even minPx does not. */
export function largestFit(text: string, box: RectF, input: FitInput): { px: number; lines: string[] } | null {
  let lo = Math.floor(input.minPx);
  let hi = Math.max(lo, Math.floor(input.maxPx));
  const atMin = fits(text, lo, box, input);
  if (!atMin) return null;
  let best = { px: lo, lines: atMin };
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const l = fits(text, mid, box, input);
    if (l) {
      best = { px: mid, lines: l };
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function overlaps(a: RectF, b: RectF): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Grow the box along the reading direction (spec 07 section 5.4): down then right, or left then down for vertical text. */
export function expandBox(box: RectF, input: FitInput, gap: number): RectF {
  const area = input.area ?? { w: Infinity, h: Infinity };
  const others = (input.others ?? []).filter((o) => !overlaps(o, box));
  let b = { ...box };
  const step = Math.max(2, gap);
  const steps: Array<(r: RectF) => RectF> = input.vertical
    ? [(r) => ({ ...r, x: r.x - step, w: r.w + step }), (r) => ({ ...r, h: r.h + step })]
    : [(r) => ({ ...r, h: r.h + step }), (r) => ({ ...r, w: r.w + step })];
  for (const grow of steps) {
    for (let i = 0; i < 400; i++) {
      const next = grow(b);
      const padded = { x: next.x - gap, y: next.y - gap, w: next.w + 2 * gap, h: next.h + 2 * gap };
      if (next.x < 0 || next.y < 0 || next.x + next.w > area.w || next.y + next.h > area.h) break;
      if (others.some((o) => overlaps(o, padded))) break;
      b = next;
    }
  }
  return b;
}

function truncate(text: string, px: number, box: RectF, input: FitInput): string[] {
  const along = input.vertical ? box.h : box.w;
  const across = input.vertical ? box.w : box.h;
  const maxLines = Math.max(1, Math.floor(across / (px * input.lineHeight)));
  const lines = wrap(text, px, along, input.measure).slice(0, maxLines);
  const ell = String.fromCharCode(0x2026);
  let last = lines[lines.length - 1] ?? '';
  while (last && input.measure(last + ell, px) > along) last = [...last].slice(0, -1).join('');
  lines[lines.length - 1] = last + ell;
  return lines;
}

export function fitText(input: FitInput): FitResult {
  const direct = largestFit(input.text, input.box, input);
  if (direct) return { px: direct.px, lines: direct.lines, box: input.box, truncated: false };
  const grown = expandBox(input.box, input, input.minPx / 2);
  const second = largestFit(input.text, grown, { ...input, maxPx: input.minPx });
  if (second) return { px: second.px, lines: second.lines, box: grown, truncated: false };
  return { px: input.minPx, lines: truncate(input.text, input.minPx, grown, input), box: grown, truncated: true };
}
