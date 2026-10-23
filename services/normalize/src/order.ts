// Spec 06 section 5: reading order by recursive XY cut. Returns the leaves in
// reading order; each leaf is ordered by its dominant direction (5.2).
import type { Direction, RectF } from '@sth/model';

export interface OrderItem<T = unknown> {
  box: RectF;
  dir: Direction;
  glyph: number;
  ref: T;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 1;
}

export function dominantDir(items: OrderItem[]): Direction {
  const w = new Map<Direction, number>();
  for (const it of items) w.set(it.dir, (w.get(it.dir) ?? 0) + Math.max(1, it.box.w * it.box.h));
  let best: Direction = 'ltr';
  let bestW = -1;
  for (const [d, v] of w) if (v > bestW) [best, bestW] = [d, v];
  return best;
}

interface Gap { axis: 'x' | 'y'; start: number; end: number }

/** Uncovered intervals between items along an axis. */
function gaps(items: OrderItem[], axis: 'x' | 'y'): Gap[] {
  const spans = items
    .map((it) => (axis === 'x' ? [it.box.x, it.box.x + it.box.w] : [it.box.y, it.box.y + it.box.h]))
    .sort((a, b) => a[0] - b[0]);
  const out: Gap[] = [];
  let end = spans[0][1];
  for (let i = 1; i < spans.length; i++) {
    const [s, e] = spans[i];
    if (s > end) out.push({ axis, start: end, end: s });
    end = Math.max(end, e);
  }
  return out;
}

export function readingOrder<T>(items: OrderItem<T>[], gMin: number): OrderItem<T>[][] {
  if (items.length === 0) return [];
  if (items.length === 1) return [items];
  const med = median(items.map((i) => i.glyph)) || 1;
  let best: Gap | null = null;
  let bestRel = 0;
  for (const g of [...gaps(items, 'x'), ...gaps(items, 'y')]) {
    const rel = (g.end - g.start) / med;
    if (rel > bestRel) [best, bestRel] = [g, rel];
  }
  if (!best || bestRel < gMin) return [leafOrder(items)];
  const cut = (best.start + best.end) / 2;
  const before = items.filter((it) => (best.axis === 'x' ? it.box.x + it.box.w / 2 : it.box.y + it.box.h / 2) < cut);
  const after = items.filter((it) => !before.includes(it));
  let first = before;
  let second = after;
  if (best.axis === 'x') {
    const d = dominantDir(items);
    if (d === 'rtl' || d === 'ttb') [first, second] = [after, before];
  }
  return [...readingOrder(first, gMin), ...readingOrder(second, gMin)];
}

export function leafOrder<T>(items: OrderItem<T>[]): OrderItem<T>[] {
  const dir = dominantDir(items);
  if (dir === 'ttb') {
    const sorted = [...items].sort((a, b) => b.box.x + b.box.w - (a.box.x + a.box.w));
    const cols: OrderItem<T>[][] = [];
    for (const it of sorted) {
      const col = cols[cols.length - 1];
      const ref = col?.[0];
      if (ref && Math.abs(ref.box.x + ref.box.w - (it.box.x + it.box.w)) < 0.5 * Math.min(ref.box.w, it.box.w)) col.push(it);
      else cols.push([it]);
    }
    return cols.flatMap((c) => c.sort((a, b) => a.box.y - b.box.y));
  }
  const sorted = [...items].sort((a, b) => a.box.y - b.box.y);
  const rows: OrderItem<T>[][] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    const ref = row?.[0];
    if (ref && Math.abs(ref.box.y - it.box.y) < 0.5 * Math.min(ref.box.h, it.box.h)) row.push(it);
    else rows.push([it]);
  }
  return rows.flatMap((r) =>
    r.sort((a, b) => (dir === 'rtl' ? b.box.x + b.box.w - (a.box.x + a.box.w) : a.box.x - b.box.x)),
  );
}
