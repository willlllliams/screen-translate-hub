// Spec 06 section 6: merge consecutive lines of a leaf into paragraphs.
import type { Direction, Unit } from '@sth/model';
import { endsWithContinuation, endsWithSentencePunct } from './join.ts';
import { isVertical, type Line } from './lines.ts';
import type { OrderItem } from './order.ts';
import type { NormalizeParams } from './params.ts';

export type Piece = { kind: 'line'; line: Line } | { kind: 'reused'; unit: Unit };

export type Paragraph = { kind: 'new'; lines: Line[] } | { kind: 'reused'; unit: Unit };

function extent(l: Line): number {
  return isVertical(l.dir) ? l.box.h : l.box.w;
}

function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Gap between consecutive lines in line heights, or null when they could never merge (conditions 2 to 5). */
function lineGap(a: Line, b: Line, p: NormalizeParams): number | null {
  if (a.dir !== b.dir) return null; // 2
  const ratio = Math.max(a.glyph, b.glyph) / Math.max(1e-6, Math.min(a.glyph, b.glyph));
  if (ratio > p.kh) return null; // 3
  const v = isVertical(a.dir);
  const h = Math.min(a.glyph, b.glyph);
  const dist = v ? a.box.x - (b.box.x + b.box.w) : b.box.y - (a.box.y + a.box.h);
  if (dist < -p.kv * h || dist > p.kg * h) return null; // 4
  const ov = v
    ? overlap1d(a.box.y, a.box.y + a.box.h, b.box.y, b.box.y + b.box.h)
    : overlap1d(a.box.x, a.box.x + a.box.w, b.box.x, b.box.x + b.box.w);
  if (ov < p.ko * Math.min(extent(a), extent(b))) return null; // 5
  return dist / h;
}

/**
 * v1 addition: the usual gap between lines of one paragraph in a leaf, the lower quartile
 * of the gaps of mergeable neighbours; undefined with fewer than two of them.
 */
export function usualGap(lines: Line[], p: NormalizeParams): number | undefined {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lineGap(lines[i - 1], lines[i], p);
    if (g !== null) gaps.push(g);
  }
  if (gaps.length < 2) return undefined;
  gaps.sort((x, y) => x - y);
  return gaps[Math.floor((gaps.length - 1) / 4)];
}

/**
 * Spacing between two horizontal lines, measured from their centres, in line heights. OCR
 * boxes of one font differ by up to a fifth in height, so the line height is the smaller of
 * the two lines' and the leaf's typical one.
 */
function looseGap(a: Line, b: Line, typicalGlyph = Infinity): number {
  const h = Math.max(1e-6, Math.min(a.glyph, b.glyph, typicalGlyph));
  const pitch = b.box.y + b.box.h / 2 - (a.box.y + a.box.h / 2);
  return (pitch - h) / h;
}

/** The median glyph size of a leaf's horizontal lines. */
export function typicalGlyph(lines: Line[]): number | undefined {
  const sizes = lines.filter((l) => !isVertical(l.dir)).map((l) => l.glyph).sort((x, y) => x - y);
  return sizes.length ? sizes[Math.floor(sizes.length / 2)] : undefined;
}

export function shouldMerge(a: Line, b: Line, colWidth: number, p: NormalizeParams, baseGap?: number, glyph?: number): boolean {
  const gap = lineGap(a, b, p);
  if (gap === null) return false; // 2 to 5
  const v = isVertical(a.dir);
  const h = Math.min(a.glyph, b.glyph);
  // v1 addition: paragraphs set apart by extra spacing, even when it is under kg
  if (baseGap !== undefined && gap > baseGap + p.kp) return false;
  if (endsWithSentencePunct(a.text) && extent(a) < p.ks * colWidth) return false; // 6
  const startsUnit = /^[\p{Lu}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(b.text.trimStart());
  // v1 addition: loose spacing after a sentence end, or before a heading, ends the paragraph.
  // The lines of one paragraph sit closer than this; it holds when every paragraph is a single
  // line, where the usual gap above has nothing smaller to compare with.
  if (!v && looseGap(a, b, glyph) > p.ksg) {
    if (endsWithSentencePunct(a.text)) return false;
    if (startsUnit && extent(b) < p.shortLine * colWidth && b.glyph >= p.kHead * a.glyph) return false;
  }
  if (v || endsWithContinuation(a.text)) return true;
  // v1 addition: a line that stops well short of the column (a heading, or the last line of a
  // paragraph without final punctuation) ends its unit when the next line starts a new one.
  if (extent(a) < p.shortLine * colWidth && startsUnit) return false;
  // v1 addition: stacked short labels of a Latin UI (menus, lists) are separate units.
  const short = (l: Line) => extent(l) < p.shortLine * colWidth || l.text.trim().split(/\s+/).length <= 4;
  if (short(a) && short(b)) {
    const aligned = a.dir === 'rtl' ? Math.abs(a.box.x + a.box.w - (b.box.x + b.box.w)) < 0.5 * h : Math.abs(a.box.x - b.box.x) < 0.5 * h;
    if (aligned && /^[A-Z]/.test(b.text.trimStart())) return false;
  }
  return true;
}

export function mergeParagraphs(leaf: OrderItem<Piece>[], p: NormalizeParams): Paragraph[] {
  const lines = leaf.flatMap((it) => (it.ref.kind === 'line' ? [it.ref.line] : []));
  const colWidth = Math.max(1, ...lines.map(extent));
  const baseGap = usualGap(lines, p);
  const glyph = typicalGlyph(lines);
  const out: Paragraph[] = [];
  let current: Line[] | null = null;
  for (const it of leaf) {
    if (it.ref.kind === 'reused') {
      current = null; // 1: reused paragraphs never merge
      out.push({ kind: 'reused', unit: it.ref.unit });
      continue;
    }
    const line = it.ref.line;
    if (current && shouldMerge(current[current.length - 1], line, colWidth, p, baseGap, glyph)) {
      current.push(line);
    } else {
      current = [line];
      out.push({ kind: 'new', lines: current });
    }
  }
  return out;
}

export function majorityDir(lines: Line[]): Direction {
  const w = new Map<Direction, number>();
  for (const l of lines) w.set(l.dir, (w.get(l.dir) ?? 0) + l.box.w * l.box.h);
  return [...w.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'ltr';
}
