// Assistant annotations (spec 17 section 7): boxes, arrows, bubbles, highlights
// and labels in screen coordinates, drawn on a click-through layer.
import type { Annotation } from '@sth/model';
import { sth } from './bridge.ts';

const svg = document.getElementById('svg') as unknown as SVGSVGElement;
const html = document.getElementById('html')!;
const NS = 'http://www.w3.org/2000/svg';
let items: Annotation[] = [];
let origin = { x: 0, y: 0 };
let scale = 1;
const expires = new Map<string, number>();

function px(v: number, axis: 'x' | 'y'): number {
  return (v - (axis === 'x' ? origin.x : origin.y)) / scale;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  svg.appendChild(e);
  return e;
}

function draw(): void {
  svg.innerHTML = '';
  html.innerHTML = '';
  const now = Date.now();
  const defs = el('defs', {});
  const marker = document.createElementNS(NS, 'marker');
  for (const [k, v] of Object.entries({ id: 'head', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })) marker.setAttribute(k, String(v));
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  path.setAttribute('fill', '#ff5a36');
  marker.appendChild(path);
  defs.appendChild(marker);
  for (const a of items) {
    const exp = expires.get(a.id);
    if (exp && exp < now) continue;
    const color = a.color ?? '#ff5a36';
    if ((a.kind === 'box' || a.kind === 'highlight') && a.rect) {
      el('rect', {
        x: px(a.rect.x, 'x'),
        y: px(a.rect.y, 'y'),
        width: a.rect.w / scale,
        height: a.rect.h / scale,
        rx: 4,
        fill: a.kind === 'highlight' ? `${color}33` : 'none',
        stroke: color,
        'stroke-width': a.kind === 'highlight' ? 0 : 3,
      });
    }
    if (a.kind === 'arrow' && a.from && a.to) {
      el('line', { x1: px(a.from.x, 'x'), y1: px(a.from.y, 'y'), x2: px(a.to.x, 'x'), y2: px(a.to.y, 'y'), stroke: color, 'stroke-width': 3, 'marker-end': 'url(#head)' });
    }
    const textAt = a.point ?? (a.rect ? { x: a.rect.x, y: a.rect.y + a.rect.h + 6 } : a.to);
    if ((a.kind === 'bubble' || a.kind === 'label' || a.text) && a.text && textAt) {
      const d = document.createElement('div');
      d.className = a.kind === 'label' ? 'label' : 'bubble';
      if (a.kind === 'label') d.style.background = color;
      d.textContent = a.text;
      d.style.left = `${Math.max(4, px(textAt.x, 'x'))}px`;
      d.style.top = `${Math.max(4, px(textAt.y, 'y'))}px`;
      html.appendChild(d);
    }
  }
}

sth.on((msg) => {
  if (msg.kind !== 'annotations') return;
  items = msg.items as Annotation[];
  origin = msg.origin as { x: number; y: number };
  scale = Number(msg.scale ?? 1);
  for (const a of items) if (a.ttl_ms && !expires.has(a.id)) expires.set(a.id, Date.now() + a.ttl_ms);
  draw();
});

setInterval(draw, 1000);
