// Spec 06 section 4: join fragments of one line. Each fragment keeps its own box.
import { quadBounds, unionAll, type Direction, type RectF, type TextBlock } from '@sth/model';
import { joinLines } from './join.ts';
import type { NormalizeParams } from './params.ts';

export interface Line {
  blocks: TextBlock[];
  text: string;
  dir: Direction;
  box: RectF;
  /** Glyph size: height for horizontal lines, width for vertical columns (spec 06 section 1). */
  glyph: number;
}

export function isVertical(dir: Direction): boolean {
  return dir === 'ttb';
}

function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

export function lineOf(blocks: TextBlock[], dir: Direction): Line {
  const boxes = blocks.map((b) => quadBounds(b.quad));
  const box = unionAll(boxes) as RectF;
  const sizes = boxes.map((b) => (isVertical(dir) ? b.w : b.h)).sort((a, b) => a - b);
  const glyph = sizes[Math.floor(sizes.length / 2)];
  const text = blocks.map((b) => b.text).reduce((acc, t) => joinLines(acc, t));
  return { blocks, text, dir, box, glyph };
}

/** Can fragment b continue the line that ends with fragment a? */
function continues(a: RectF, b: RectF, dir: Direction, p: NormalizeParams): number | null {
  if (isVertical(dir)) {
    const size = Math.min(a.w, b.w);
    if (overlap1d(a.x, a.x + a.w, b.x, b.x + b.w) < p.fragOverlap * size) return null;
    const gap = b.y - (a.y + a.h);
    return gap >= -0.5 * size && gap <= p.fragGap * size ? gap : null;
  }
  const size = Math.min(a.h, b.h);
  if (overlap1d(a.y, a.y + a.h, b.y, b.y + b.h) < p.fragOverlap * size) return null;
  const gap = dir === 'rtl' ? a.x - (b.x + b.w) : b.x - (a.x + a.w);
  return gap >= -0.5 * size && gap <= p.fragGap * size ? gap : null;
}

export function mergeFragments(blocks: TextBlock[], p: NormalizeParams): Line[] {
  const byDir = new Map<Direction, TextBlock[]>();
  for (const b of blocks) {
    const d = b.direction ?? 'ltr';
    byDir.set(d, [...(byDir.get(d) ?? []), b]);
  }
  const lines: Line[] = [];
  for (const [dir, list] of byDir) {
    const sorted = [...list].sort((a, b) => {
      const ba = quadBounds(a.quad);
      const bb = quadBounds(b.quad);
      if (isVertical(dir)) return ba.y - bb.y;
      return dir === 'rtl' ? bb.x + bb.w - (ba.x + ba.w) : ba.x - bb.x;
    });
    const open: TextBlock[][] = [];
    for (const blk of sorted) {
      const box = quadBounds(blk.quad);
      let best: TextBlock[] | null = null;
      let bestGap = Infinity;
      for (const chain of open) {
        const last = quadBounds(chain[chain.length - 1].quad);
        const gap = continues(last, box, dir, p);
        if (gap !== null && gap < bestGap) {
          best = chain;
          bestGap = gap;
        }
      }
      if (best) best.push(blk);
      else open.push([blk]);
    }
    for (const chain of open) lines.push(lineOf(chain, dir));
  }
  return lines;
}
