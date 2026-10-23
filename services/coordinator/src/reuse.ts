// Paragraph reuse (spec 04 section 4): which paragraphs of the previous batch carry
// over unchanged or shifted, which stay on screen until OCR finishes, and which
// regions go to OCR.
import {
  area,
  cacheKey,
  clip,
  expand,
  intersect,
  iou,
  pxRect,
  quadBounds,
  touches,
  translateQuad,
  type ChangeMap,
  type OcrResult,
  type Rect,
  type RectF,
  type Unit,
} from '@sth/model';

export interface PrevParagraph {
  unit: Unit;
  /** Every race node that handled it ended with a complete result (condition 4). */
  complete: boolean;
}

export interface PrevBatch {
  batchSeq: number;
  width: number;
  height: number;
  paragraphs: PrevParagraph[];
}

export interface ReuseParams {
  fullReocrRatio: number;
  adjacencyPx: number;
  ocrMarginPx: number;
}

export interface ReusedPara {
  prev: PrevParagraph;
  k: number;
  dx: number;
  dy: number;
  /** The unit moved into the new frame (ids assigned by the caller). */
  moved: Unit;
}

export interface ReusePlan {
  full: boolean;
  reused: ReusedPara[];
  held: PrevParagraph[];
  regions: Rect[];
}

class Tiles {
  readonly t: number;
  readonly cols: number;
  readonly rows: number;
  readonly W: number;
  readonly H: number;
  private readonly masks: Uint8Array;

  constructor(map: ChangeMap, W: number, H: number) {
    this.t = map.tile;
    this.cols = map.cols;
    this.rows = map.rows;
    this.W = W;
    this.H = H;
    this.masks = map.masks;
  }

  byte(u: number, v: number): number {
    return this.masks[v * this.cols + u] ?? 0;
  }

  bit(k: number, u: number, v: number): boolean {
    return ((this.byte(u, v) >> k) & 1) === 1;
  }

  /** Tiles intersecting a pixel rectangle (clipped to the grid). */
  *tilesOf(r: Rect): Generator<[number, number]> {
    const u0 = Math.max(0, Math.floor(r.x / this.t));
    const v0 = Math.max(0, Math.floor(r.y / this.t));
    const u1 = Math.min(this.cols - 1, Math.floor((r.x + r.w - 1) / this.t));
    const v1 = Math.min(this.rows - 1, Math.floor((r.y + r.h - 1) / this.t));
    for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) yield [u, v];
  }
}

function shiftRect(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
}

function inside(r: Rect, W: number, H: number): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H;
}

/** First shift k under which every line rect is fully inside and all its tiles have bit k (4.3). */
function consistentShift(rects: Rect[], map: ChangeMap, tiles: Tiles): number | null {
  for (let k = 0; k < map.shifts.length; k++) {
    const { dx, dy } = map.shifts[k];
    let ok = true;
    for (const r of rects) {
      const R = shiftRect(r, dx, dy);
      if (!inside(R, tiles.W, tiles.H)) {
        ok = false;
        break;
      }
      for (const [u, v] of tiles.tilesOf(R)) {
        if (!tiles.bit(k, u, v)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
    }
    if (ok) return k;
  }
  return null;
}

/**
 * 4.5 step 2, per line: the first shift under which the in-frame part of this line is
 * consistent. Locating lines one by one (rather than requiring one shift for all lines)
 * also covers content scrolled under a fixed header: the hidden line is still inside
 * the frame but no longer consistent, while the visible lines must still be found.
 */
function partialShiftOne(r: Rect, map: ChangeMap, tiles: Tiles): number | null {
  // Locating only decides what to re-OCR, so a majority of consistent tiles is enough:
  // descenders of a neighbouring line can make one or two tiles inconsistent under every shift.
  let best: number | null = null;
  let bestRatio = 0.5;
  for (let k = 0; k < map.shifts.length; k++) {
    const { dx, dy } = map.shifts[k];
    const R = clip(shiftRect(r, dx, dy), tiles.W, tiles.H);
    if (!R) continue;
    let ok = 0;
    let all = 0;
    for (const [u, v] of tiles.tilesOf(R)) {
      all++;
      if (tiles.bit(k, u, v)) ok++;
    }
    const ratio = all ? ok / all : 0;
    if (ratio > bestRatio || (ratio === 1 && bestRatio < 1)) {
      best = k;
      bestRatio = ratio;
    }
  }
  return best;
}

/** Changed tiles dilated by r tiles (Chebyshev), as a set of v * cols + u. */
function dilatedChanged(tiles: Tiles, r: number): Set<number> {
  const out = new Set<number>();
  for (let v = 0; v < tiles.rows; v++) {
    for (let u = 0; u < tiles.cols; u++) {
      if (tiles.byte(u, v) !== 0) continue;
      for (let dv = -r; dv <= r; dv++) {
        for (let du = -r; du <= r; du++) {
          const uu = u + du;
          const vv = v + dv;
          if (uu >= 0 && vv >= 0 && uu < tiles.cols && vv < tiles.rows) out.add(vv * tiles.cols + uu);
        }
      }
    }
  }
  return out;
}

/** 8-connected components of changed tiles, as pixel bounding boxes (4.5 step 1). */
export function changedComponents(map: ChangeMap, W: number, H: number): Rect[] {
  const { cols, rows, tile: t } = map;
  const seen = new Uint8Array(cols * rows);
  const out: Rect[] = [];
  for (let i = 0; i < cols * rows; i++) {
    if (seen[i] || map.masks[i] !== 0) continue;
    let u0 = Infinity;
    let v0 = Infinity;
    let u1 = -1;
    let v1 = -1;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const u = j % cols;
      const v = (j - u) / cols;
      u0 = Math.min(u0, u);
      v0 = Math.min(v0, v);
      u1 = Math.max(u1, u);
      v1 = Math.max(v1, v);
      for (let dv = -1; dv <= 1; dv++) {
        for (let du = -1; du <= 1; du++) {
          const uu = u + du;
          const vv = v + dv;
          if (uu < 0 || vv < 0 || uu >= cols || vv >= rows) continue;
          const k = vv * cols + uu;
          if (!seen[k] && map.masks[k] === 0) {
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
    }
    const r = clip({ x: u0 * t, y: v0 * t, w: (u1 - u0 + 1) * t, h: (v1 - v0 + 1) * t }, W, H);
    if (r) out.push(r);
  }
  return out;
}

/** 4.5 steps 3 and 4: expand by m, clip, merge overlapping or touching rectangles. */
export function mergeRegions(rects: Rect[], m: number, W: number, H: number): Rect[] {
  let list = rects.map((r) => clip(expand(r, m), W, H)).filter((r): r is Rect => !!r);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (touches(list[i], list[j])) {
          const a = list[i];
          const b = list[j];
          const x0 = Math.min(a.x, b.x);
          const y0 = Math.min(a.y, b.y);
          const merged = { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
          list = [...list.slice(0, i), merged, ...list.slice(i + 1, j), ...list.slice(j + 1)];
          changed = true;
          break outer;
        }
      }
    }
  }
  return list;
}

export function moveUnit(u: Unit, dx: number, dy: number, prevBatch: number): Unit {
  return {
    ...u,
    origin: 'reused',
    lines: u.lines?.map((b) => ({ ...b, quad: translateQuad(b.quad, dx, dy), char_quads: b.char_quads?.map((q) => translateQuad(q, dx, dy)) })),
    bounds: u.bounds ? { ...u.bounds, x: u.bounds.x + dx, y: u.bounds.y + dy } : undefined,
    reused_from: { batch_seq: prevBatch, paragraph_id: u.paragraph_id, dx, dy },
  };
}

function lineRects(u: Unit, W: number, H: number): Rect[] {
  const rects = (u.lines ?? []).map((b) => pxRect(b.quad, W, H)).filter((r): r is Rect => !!r);
  if (rects.length === 0 && u.bounds) {
    const r = clip({ x: Math.floor(u.bounds.x), y: Math.floor(u.bounds.y), w: Math.ceil(u.bounds.w), h: Math.ceil(u.bounds.h) }, W, H);
    if (r) rects.push(r);
  }
  return rects;
}

export function planReuse(
  prev: PrevBatch | null,
  map: ChangeMap | null | undefined,
  W: number,
  H: number,
  p: ReuseParams,
  ocrDone: boolean,
): ReusePlan {
  const full: ReusePlan = { full: true, reused: [], held: [], regions: [{ x: 0, y: 0, w: W, h: H }] };
  // 4.2: whole-frame re-OCR
  if (!prev || !map || !ocrDone || map.changed_ratio > p.fullReocrRatio || prev.width !== W || prev.height !== H) return full;
  const tiles = new Tiles(map, W, H);
  const r = Math.ceil(p.adjacencyPx / map.tile);
  const near = dilatedChanged(tiles, r);
  const reused: ReusedPara[] = [];
  const held: PrevParagraph[] = [];
  const positions: Rect[] = [];
  for (const para of prev.paragraphs) {
    const rects = lineRects(para.unit, W, H);
    if (rects.length === 0) continue;
    const k = consistentShift(rects, map, tiles);
    if (k !== null) {
      const { dx, dy } = map.shifts[k];
      let adjacent = false;
      for (const rect of rects) {
        for (const [u, v] of tiles.tilesOf(shiftRect(rect, dx, dy))) {
          if (near.has(v * tiles.cols + u)) {
            adjacent = true;
            break;
          }
        }
        if (adjacent) break;
      }
      if (!adjacent && para.complete) {
        reused.push({ prev: para, k, dx, dy, moved: moveUnit(para.unit, dx, dy, prev.batchSeq) });
        continue;
      }
      positions.push(...rects.map((x) => shiftRect(x, dx, dy)));
      if (k === 0) held.push(para);
      continue;
    }
    // not consistent as a whole: locate each line's visible part (held only if nothing moved)
    let inPlace = true;
    for (const x of rects) {
      const k2 = partialShiftOne(x, map, tiles);
      if (k2 === null) {
        positions.push(x);
        continue;
      }
      if (k2 !== 0) inPlace = false;
      const { dx, dy } = map.shifts[k2];
      const c = clip(shiftRect(x, dx, dy), W, H);
      if (c) positions.push(c);
    }
    if (inPlace) held.push(para);
  }
  const regions = mergeRegions([...changedComponents(map, W, H), ...positions], p.ocrMarginPx, W, H);
  return { full: false, reused, held, regions };
}

/** 4.5: drop OCR blocks mostly covered by a reused paragraph (the reused one wins). */
export function dropDuplicates(result: OcrResult, reusedBounds: RectF[]): OcrResult {
  if (reusedBounds.length === 0) return result;
  return {
    ...result,
    regions: result.regions.map((reg) => ({
      ...reg,
      blocks: reg.blocks.filter((b) => {
        const local = quadBounds(b.quad);
        const s = reg.scale || 1;
        const fb = { x: reg.rect.x + local.x / s, y: reg.rect.y + local.y / s, w: local.w / s, h: local.h / s };
        const a = area(fb);
        if (a <= 0) return true;
        return !reusedBounds.some((rb) => {
          const i = intersect(fb, rb);
          return i !== null && area(i) > 0.5 * a;
        });
      }),
    })),
  };
}

/** 4.6: pair held paragraphs with new paragraphs of the same text at the same place that hit the cache. */
export function matchHeld(held: PrevParagraph[], units: Unit[], cacheHas: (text: string) => boolean): Map<number, number> {
  const pairs: Array<{ newId: number; oldId: number; score: number }> = [];
  for (const h of held) {
    const hk = cacheKey(h.unit.text);
    if (!h.unit.bounds) continue;
    for (const u of units) {
      if (!u.bounds || cacheKey(u.text) !== hk || !cacheHas(u.text)) continue;
      const score = iou(h.unit.bounds, u.bounds);
      if (score >= 0.5) pairs.push({ newId: u.paragraph_id, oldId: h.unit.paragraph_id, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedNew = new Set<number>();
  const usedOld = new Set<number>();
  const out = new Map<number, number>();
  for (const p of pairs) {
    if (usedNew.has(p.newId) || usedOld.has(p.oldId)) continue;
    usedNew.add(p.newId);
    usedOld.add(p.oldId);
    out.set(p.newId, p.oldId);
  }
  return out;
}
