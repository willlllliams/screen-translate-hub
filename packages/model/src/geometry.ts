// Geometry helpers (spec 02 section 1).
import type { Point, Quad, QuadRel, Rect, RectF, RectRel } from './types.ts';

/** Order four points clockwise on screen, starting at the smallest x + y; ties prefer smaller y. */
export function orderQuad(points: readonly Point[]): Quad {
  if (points.length !== 4) throw new Error('quad needs 4 points');
  const cx = points.reduce((s, p) => s + p.x, 0) / 4;
  const cy = points.reduce((s, p) => s + p.y, 0) / 4;
  // y grows downward, so increasing atan2 angle is clockwise on screen.
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) {
    const s = sorted[i].x + sorted[i].y;
    const best = sorted[start].x + sorted[start].y;
    if (s < best || (s === best && sorted[i].y < sorted[start].y)) start = i;
  }
  const out = [0, 1, 2, 3].map((k) => ({ x: sorted[(start + k) % 4].x, y: sorted[(start + k) % 4].y }));
  return out as Quad;
}

export function quadBounds(q: Quad): RectF {
  const xs = q.map((p) => p.x);
  const ys = q.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function rectFOfRect(r: Rect): RectF {
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}

/** px(q): the smallest pixel rectangle containing q, clipped to the frame (spec 02 section 1.2). */
export function pxRect(q: Quad, W: number, H: number): Rect | null {
  const b = quadBounds(q);
  const x0 = Math.max(0, Math.floor(b.x));
  const y0 = Math.max(0, Math.floor(b.y));
  const x1 = Math.min(W, Math.ceil(b.x + b.w));
  const y1 = Math.min(H, Math.ceil(b.y + b.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function translateQuad(q: Quad, dx: number, dy: number): Quad {
  return q.map((p) => ({ x: p.x + dx, y: p.y + dy })) as Quad;
}

export function area(r: RectF): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

export function intersect(a: RectF, b: RectF): RectF | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function union(a: RectF, b: RectF): RectF {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionAll(rs: readonly RectF[]): RectF | null {
  if (rs.length === 0) return null;
  return rs.reduce((acc, r) => union(acc, r));
}

export function iou(a: RectF, b: RectF): number {
  const i = intersect(a, b);
  if (!i) return 0;
  const ia = area(i);
  return ia / (area(a) + area(b) - ia);
}

export function expand(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

export function clip(r: Rect, W: number, H: number): Rect | null {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(W, r.x + r.w);
  const y1 = Math.min(H, r.y + r.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** True when the rectangles overlap or touch (share an edge). */
export function touches(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function containsRect(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function toRelativeQuad(q: Quad, W: number, H: number): QuadRel {
  return q.flatMap((p) => [p.x / W, p.y / H]);
}

export function toRelativeRect(r: RectF, W: number, H: number): RectRel {
  return { x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H };
}

/** Text height as defined in spec 06 section 1: quad height for horizontal text, width for vertical. */
export function glyphSize(q: Quad, vertical: boolean): number {
  const b = quadBounds(q);
  return vertical ? b.w : b.h;
}
