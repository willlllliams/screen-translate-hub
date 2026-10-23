// DOM drawing of a display state, shared by the local overlay, the screenshot
// result and the web viewer (spec 07 sections 2 to 5, requirement 09 section 3.1).
import { cacheKey, type RectF } from '@sth/model';
import { fitText, type Measure } from './layout.ts';
import type { DisplaySettings } from './settings.ts';
import type { DisplayState, ParaState } from './state.ts';

const CJK_TARGETS = ['zh', 'ja', 'ko'];

/** Equal up to whitespace (translators re-space "a.exe -b" as "a.exe - b"). */
function sameText(a: string, b: string): boolean {
  return cacheKey(a).replace(/\s+/g, '') === cacheKey(b).replace(/\s+/g, '');
}

export interface RenderView {
  /** Drawing area in CSS pixels; relative coordinates map onto it. */
  width: number;
  height: number;
  targetLanguage?: string;
  /** Clip areas (CSS px) where nothing may be drawn, e.g. windows on top of the target. */
  occluded?: RectF[];
}

function canvasMeasure(fonts: string[]): Measure {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const family = fonts.map((f) => (/\s/.test(f) && !f.includes('"') ? `"${f}"` : f)).join(', ');
  let lastPx = -1;
  return (text, px) => {
    if (px !== lastPx) {
      ctx.font = `${px}px ${family}`;
      lastPx = px;
    }
    return ctx.measureText(text).width;
  };
}

function median(xs: number[]): number {
  const s = xs.filter((x) => x > 0).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

export class DomRenderer {
  private readonly root: HTMLElement;
  private settings: DisplaySettings;
  private readonly dim: HTMLDivElement;
  private readonly layer: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly nodes = new Map<string, HTMLDivElement>();
  private measure: Measure;

  constructor(root: HTMLElement, settings: DisplaySettings) {
    this.root = root;
    this.settings = settings;
    // keep a positioning the page gave the root; only a static root becomes the containing block
    if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
    root.style.overflow = 'hidden';
    this.dim = this.el('sth-dim', 'position:absolute;inset:0;pointer-events:none;');
    this.layer = this.el('sth-layer', 'position:absolute;inset:0;pointer-events:none;');
    this.banner = this.el('sth-banner', 'position:absolute;left:0;right:0;top:0;display:none;padding:4px 10px;font:13px sans-serif;color:#fff;background:rgba(180,60,40,.88);pointer-events:none;');
    this.measure = canvasMeasure(settings.fonts);
  }

  private el(cls: string, css: string): HTMLDivElement {
    const d = document.createElement('div');
    d.className = cls;
    d.style.cssText = css;
    this.root.appendChild(d);
    return d;
  }

  setSettings(s: DisplaySettings): void {
    if (s.fonts.join() !== this.settings.fonts.join()) this.measure = canvasMeasure(s.fonts);
    this.settings = s;
  }

  /** Paragraph div by key; created on first use. */
  private node(key: string): HTMLDivElement {
    let d = this.nodes.get(key);
    if (!d) {
      d = document.createElement('div');
      d.className = 'sth-para';
      d.dataset.key = key;
      this.layer.appendChild(d);
      this.nodes.set(key, d);
    }
    return d;
  }

  render(state: DisplayState, view: RenderView): void {
    const s = this.settings;
    const W = view.width;
    const H = view.height;
    this.root.style.width = `${W}px`;
    this.root.style.height = `${H}px`;
    const visible = s.show_translation;
    this.dim.style.background = visible && s.mode === 'dim' ? `rgba(0,0,0,${(1 - s.brightness).toFixed(3)})` : 'transparent';
    this.layer.style.display = visible ? 'block' : 'none';

    const notices = [...state.notices.values()];
    this.banner.style.display = notices.length ? 'block' : 'none';
    this.banner.textContent = notices.map((n) => `Translation source unavailable: ${n.reason}`).join(' / ');

    const entries: Array<[string, ParaState]> = [
      ...[...state.held.entries()].map(([id, p]) => [`h${id}`, p] as [string, ParaState]),
      ...[...state.paragraphs.entries()].map(([id, p]) => [`p${id}`, p] as [string, ParaState]),
    ];
    const boxes = entries.map(([, p]) => ({ x: p.add.bounds.x * W, y: p.add.bounds.y * H, w: p.add.bounds.w * W, h: p.add.bounds.h * H }));
    const keep = new Set<string>();
    const vertTarget = CJK_TARGETS.includes((view.targetLanguage ?? '').split('-')[0]);

    entries.forEach(([key, p], i) => {
      const shown = p.show;
      if (!shown) return; // nothing to draw yet, or no translation needed
      // a translation identical to the original (file names, codes) would only hide it
      if (shown.show === 'text' && shown.final && sameText(shown.text ?? '', p.add.text)) return;
      keep.add(key);
      const d = this.node(key);
      const box = boxes[i];
      if (shown.show === 'error') {
        d.style.cssText = `position:absolute;left:${box.x}px;top:${box.y}px;width:14px;height:14px;border-radius:7px;background:#d33;color:#fff;font:bold 11px sans-serif;text-align:center;line-height:14px;`;
        d.textContent = '!';
        d.title = shown.error_reason ?? 'translation failed';
        d.dataset.source = p.add.text;
        d.dataset.full = '';
        d.dataset.error = d.title;
        return;
      }
      const text = shown.text ?? '';
      const vertical = p.add.direction === 'ttb' && vertTarget;
      const glyphs = p.add.quads.map((q) => {
        const ys = [q[1], q[3], q[5], q[7]].map((y) => y * H);
        const xs = [q[0], q[2], q[4], q[6]].map((x) => x * W);
        return vertical ? Math.max(...xs) - Math.min(...xs) : Math.max(...ys) - Math.min(...ys);
      });
      const maxPx = Math.max(s.min_font_px, Math.round((median(glyphs) || box.h) * 0.82 * s.font_scale));
      const fit = fitText({
        text,
        box,
        vertical,
        minPx: Math.min(s.min_font_px, maxPx),
        maxPx,
        lineHeight: 1.18,
        measure: this.measure,
        others: boxes.filter((_, j) => j !== i),
        area: { w: W, h: H },
      });
      const plate = s.mode === 'plate';
      const bg = plate ? hexToRgba(s.plate_color, s.plate_opacity) : 'transparent';
      const shadow = plate ? 'none' : '0 0 3px #000, 0 0 2px #000';
      d.style.cssText = [
        'position:absolute',
        `left:${fit.box.x}px`,
        `top:${fit.box.y}px`,
        `width:${fit.box.w}px`,
        `height:${fit.box.h}px`,
        `font-size:${fit.px}px`,
        'line-height:1.18',
        `font-family:${s.fonts.map((f) => `"${f}"`).join(',')}`,
        `color:${s.text_color}`,
        `background:${bg}`,
        `text-shadow:${shadow}`,
        'border-radius:4px',
        'white-space:pre',
        'overflow:hidden',
        'box-sizing:border-box',
        vertical ? 'writing-mode:vertical-rl' : '',
        p.add.direction === 'rtl' ? 'direction:rtl' : '',
      ].join(';');
      d.textContent = fit.lines.join('\n');
      d.title = '';
      d.dataset.full = text;
      d.dataset.source = p.add.text;
      delete d.dataset.error;
    });
    for (const [key, d] of this.nodes) {
      if (!keep.has(key)) {
        d.remove();
        this.nodes.delete(key);
      }
    }
  }

  /** The paragraph under a point (client coordinates), with its original, full translation or failure reason. */
  hit(x: number, y: number): { source: string; translation: string; error?: string } | null {
    for (const d of this.nodes.values()) {
      const r = d.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { source: d.dataset.source ?? '', translation: d.dataset.full ?? '', error: d.dataset.error };
    }
    return null;
  }
}

export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}
