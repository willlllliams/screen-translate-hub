// Region selection page: the frozen screen as background; drag a rectangle;
// Esc or right click cancels.
import type { EncodedImage } from '@sth/model';
import { sth } from './bridge.ts';

const box = document.getElementById('box')!;
const dim = document.getElementById('dim')!;
const bg = document.getElementById('bg') as HTMLCanvasElement;
let start: { x: number; y: number } | null = null;

sth.on((msg) => {
  if (msg.kind !== 'frozen') return;
  const img = msg.image as EncodedImage;
  bg.width = img.width;
  bg.height = img.height;
  const ctx = bg.getContext('2d')!;
  const data = ctx.createImageData(img.width, img.height);
  const src = img.data;
  for (let i = 0; i < src.length; i += 4) {
    data.data[i] = src[i + 2];
    data.data[i + 1] = src[i + 1];
    data.data[i + 2] = src[i];
    data.data[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
});

function rect(e: MouseEvent) {
  const x = Math.min(start!.x, e.clientX);
  const y = Math.min(start!.y, e.clientY);
  return { x, y, w: Math.abs(e.clientX - start!.x), h: Math.abs(e.clientY - start!.y) };
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) {
    sth.send({ kind: 'select-cancel' });
    return;
  }
  start = { x: e.clientX, y: e.clientY };
  dim.style.display = 'none';
  box.style.display = 'block';
});

window.addEventListener('mousemove', (e) => {
  if (!start) return;
  const r = rect(e);
  Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
});

window.addEventListener('mouseup', (e) => {
  if (!start) return;
  const r = rect(e);
  start = null;
  if (r.w < 4 || r.h < 4) {
    sth.send({ kind: 'select-cancel' });
    return;
  }
  sth.send({ kind: 'select-done', rect: r });
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') sth.send({ kind: 'select-cancel' });
});
