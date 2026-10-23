// Overlay page (spec 07 section 2): keeps the display state from the snapshot and
// events and draws it over the whole surface. It renders offscreen, so pointer
// positions for the interactive mode come from the main process.
import type { DisplayEvent, DisplaySnapshot } from '@sth/model';
import { applyEvent, defaultSettings, emptyState, fromSnapshot, type DisplaySettings, type DisplayState } from '@sth/render';
import { DomRenderer } from '@sth/render/dom';
import { sth } from './bridge.ts';

const root = document.getElementById('root')!;
const tip = document.getElementById('tip')!;
let settings: DisplaySettings = defaultSettings('overlay');
let state: DisplayState = emptyState();
let target = 'zh-Hans';
let interactive = false;
const renderer = new DomRenderer(root, settings);
let scheduled = false;

function draw(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    renderer.render(state, { width: window.innerWidth, height: window.innerHeight, targetLanguage: target });
  });
}

(window as unknown as { __sthHit: (x: number, y: number) => unknown }).__sthHit = (x, y) => renderer.hit(x, y);

function pointer(inside: boolean, x: number, y: number): void {
  const hit = interactive && inside ? renderer.hit(x, y) : null;
  if (!hit) {
    tip.style.display = 'none';
    return;
  }
  tip.textContent = `${hit.source}\n\n${hit.translation}`;
  // the overlay is only as large as the target window: keep the tip inside it, to the left
  // of or above the pointer when it does not fit to the right or below
  const W = window.innerWidth;
  const H = window.innerHeight;
  tip.style.maxWidth = `${Math.min(480, W - 8)}px`;
  tip.style.maxHeight = `${H - 8}px`;
  tip.style.display = 'block';
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = x + 12 + w <= W ? x + 12 : x - 12 - w;
  const top = y + 12 + h <= H ? y + 12 : y - 12 - h;
  tip.style.left = `${Math.max(0, Math.min(left, W - w))}px`;
  tip.style.top = `${Math.max(0, Math.min(top, H - h))}px`;
}

sth.on((msg) => {
  switch (msg.kind) {
    case 'settings':
      settings = msg.settings as DisplaySettings;
      renderer.setSettings(settings);
      break;
    case 'view':
      target = String(msg.target_language ?? target);
      break;
    case 'snapshot':
      state = fromSnapshot(msg.snapshot as DisplaySnapshot);
      break;
    case 'event':
      if (applyEvent(state, msg.event as DisplayEvent) === 'gap') sth.send({ kind: 'overlay-gap' });
      break;
    case 'interactive':
      interactive = msg.on === true;
      tip.style.display = 'none';
      break;
    case 'pointer':
      pointer(msg.inside === true, Number(msg.x), Number(msg.y));
      return;
  }
  draw();
});

window.addEventListener('resize', draw);
