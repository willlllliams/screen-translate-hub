// Normalization (spec 06): OCR result -> translation units for one batch.
import { quadBounds, unionAll, type OcrResult, type RectF, type TextBlock, type Unit } from '@sth/model';
import { toFrameCoords } from './coords.ts';
import { inferDirection } from './direction.ts';
import { joinLines } from './join.ts';
import { lineOf, mergeFragments, type Line } from './lines.ts';
import { readingOrder, type OrderItem } from './order.ts';
import { DEFAULT_PARAMS, type NormalizeParams } from './params.ts';
import { majorityDir, mergeParagraphs, type Piece } from './paragraphs.ts';

export interface NormalizeRequest {
  ocr: OcrResult;
  reused: Unit[];
  first_id: number;
  frame_width: number;
  frame_height: number;
}

function reusedGlyph(u: Unit): number {
  const sizes = (u.lines ?? []).map((b) => {
    const r = quadBounds(b.quad);
    return u.direction === 'ttb' ? r.w : r.h;
  });
  if (sizes.length === 0) return u.bounds ? Math.min(u.bounds.w, u.bounds.h) : 16;
  sizes.sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)];
}

export function normalize(req: NormalizeRequest, params: NormalizeParams = DEFAULT_PARAMS): Unit[] {
  const blocks: TextBlock[] = [];
  for (const region of req.ocr?.regions ?? []) {
    for (const b of region.blocks) {
      if (!b.text || !b.text.trim()) continue;
      const fb = toFrameCoords(region, b);
      fb.direction = inferDirection(fb);
      blocks.push(fb);
    }
  }
  const lines = mergeFragments(blocks, params);
  const items: OrderItem<Piece>[] = [
    ...lines.map((line) => ({ box: line.box, dir: line.dir, glyph: line.glyph, ref: { kind: 'line', line } as Piece })),
    ...(req.reused ?? []).map((unit) => ({
      box: (unit.bounds ?? { x: 0, y: 0, w: 1, h: 1 }) as RectF,
      dir: unit.direction ?? 'ltr',
      glyph: reusedGlyph(unit),
      ref: { kind: 'reused', unit } as Piece,
    })),
  ];
  const leaves = readingOrder(items, params.gMin);
  const units: Unit[] = [];
  let nextId = req.first_id;
  let order = 1;
  for (const leaf of leaves) {
    for (const para of mergeParagraphs(leaf, params)) {
      if (para.kind === 'reused') {
        units.push({ ...para.unit, order: order++ });
        continue;
      }
      units.push(unitOf(para.lines, nextId++, order++));
    }
  }
  return units;
}

function unitOf(lines: Line[], id: number, order: number): Unit {
  const blocks = lines.flatMap((l) => l.blocks);
  const langs = new Set(blocks.map((b) => b.language).filter(Boolean));
  const unit: Unit = {
    paragraph_id: id,
    order,
    text: lines.map((l) => l.text).reduce((acc, t) => joinLines(acc, t)),
    direction: majorityDir(lines),
    lines: blocks,
    bounds: unionAll(lines.map((l) => l.box)) as RectF,
    origin: 'recognized',
  };
  if (langs.size === 1 && blocks.every((b) => b.language)) unit.language = [...langs][0];
  return unit;
}

export { lineOf, mergeFragments, readingOrder, mergeParagraphs, joinLines, DEFAULT_PARAMS };
