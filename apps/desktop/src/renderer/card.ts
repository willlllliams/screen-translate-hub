// Screenshot card page (spec 07 section 4): the screenshot and the translation
// layer on top of it; the user can switch to the original.
import type { DisplayEvent, DisplaySnapshot, EncodedImage } from '@sth/model';
import { applyEvent, defaultSettings, emptyState, fromSnapshot, type DisplaySettings, type DisplayState } from '@sth/render';
import { DomRenderer } from '@sth/render/dom';
import { sth } from './bridge.ts';

const root = document.getElementById('root')!;
const stage = document.getElementById('stage')!;
const canvas = document.getElementById('img') as HTMLCanvasElement;
const toggle = document.getElementById('toggle')!;
let settings: DisplaySettings = { ...defaultSettings('card'), mode: 'plate' };
let state: DisplayState = emptyState();
let target = 'zh-Hans';
let showTranslation = true;
const renderer = new DomRenderer(root, settings);
let imageSize = { w: 0, h: 0 };

/** The screenshot keeps its aspect ratio: fitted into the stage and centred, the translations on top of it. */
function fitBox(): { x: number; y: number; w: number; h: number } {
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (!imageSize.w || !imageSize.h) return { x: 0, y: 0, w: sw, h: sh };
  const scale = Math.min(sw / imageSize.w, sh / imageSize.h);
  const w = Math.round(imageSize.w * scale);
  const h = Math.round(imageSize.h * scale);
  return { x: Math.floor((sw - w) / 2), y: Math.floor((sh - h) / 2), w, h };
}

function draw(): void {
  const box = fitBox();
  for (const el of [canvas, root]) Object.assign(el.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
  root.style.display = showTranslation ? 'block' : 'none';
  renderer.render(state, { width: box.w, height: box.h, targetLanguage: target });
}

function paint(img: EncodedImage): void {
  imageSize = { w: img.width, h: img.height };
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  const data = ctx.createImageData(img.width, img.height);
  const src = img.data;
  for (let i = 0; i < src.length; i += 4) {
    data.data[i] = src[i + 2];
    data.data[i + 1] = src[i + 1];
    data.data[i + 2] = src[i];
    data.data[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
}

sth.on((msg) => {
  if (msg.kind === 'settings') {
    settings = { ...(msg.settings as DisplaySettings), mode: 'plate' };
    renderer.setSettings(settings);
  } else if (msg.kind === 'view') target = String(msg.target_language);
  else if (msg.kind === 'image') paint(msg.image as EncodedImage);
  else if (msg.kind === 'snapshot') state = fromSnapshot(msg.snapshot as DisplaySnapshot);
  else if (msg.kind === 'event') applyEvent(state, msg.event as DisplayEvent);
  draw();
});

toggle.addEventListener('click', () => {
  showTranslation = !showTranslation;
  toggle.textContent = showTranslation ? 'Original' : 'Translation';
  draw();
});
document.getElementById('close')!.addEventListener('click', () => window.close());
window.addEventListener('resize', draw);
