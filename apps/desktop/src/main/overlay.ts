// Local overlay service, overlay.Attach and overlay.Annotate (spec 09 section 7,
// spec 07 section 2, spec 12 section 3.3): a click-through, non-activating layer
// over the capture range, excluded from screen capture.
import type { Annotation, CaptureGeometry, CaptureRange, DisplayEvent, DisplaySnapshot } from '@sth/model';
import type { DisplaySettings } from '@sth/render';
import type { Stream } from '@sth/wire';
import { clipboard, screen } from 'electron';
import { OverlayHost, type WindowEnv } from './host.ts';
import type { Physical } from './layered.ts';
import * as win32 from './win32.ts';

export type { WindowEnv };

function primaryPhysical(): Physical {
  const d = screen.getPrimaryDisplay();
  const r = screen.dipToScreenRect(null, d.bounds);
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

class OverlaySession {
  readonly host: OverlayHost;
  private target = 0;
  private geometry?: CaptureGeometry;
  private timer?: ReturnType<typeof setInterval>;
  private hiddenByUser = false;
  private interactive = false;
  private wasDown = false;
  private lastBounds = '';

  constructor(env: WindowEnv, range: CaptureRange | undefined, targetLanguage: string) {
    if (range?.window_id) this.target = range.window_id;
    const followsWindow = !!(range?.window_id || range?.follow_active_window);
    let initial = primaryPhysical();
    if (range?.region) initial = { x: range.region.x, y: range.region.y, w: range.region.w, h: range.region.h };
    else if (range?.window_id) initial = win32.windowFrame(range.window_id) ?? initial;
    this.host = new OverlayHost(env, initial, { topmost: !followsWindow });
    this.host.send({ kind: 'settings', settings: env.settings() });
    this.host.send({ kind: 'view', target_language: targetLanguage });
    this.timer = setInterval(() => this.tick(), 60);
    this.host.onClosed = () => this.timer && clearInterval(this.timer);
  }

  send(msg: unknown): void {
    this.host.send(msg);
  }

  setGeometry(g: CaptureGeometry): void {
    this.geometry = g;
    if (g.kind === 'window' && g.window_id) this.target = g.window_id;
    this.tick();
  }

  private tick(): void {
    if (this.host.isClosed) return;
    this.follow();
    if (this.interactive) this.pointer();
  }

  /** Keep the layer over the capture range; follow a captured window (requirement 01 section 5.2). */
  private follow(): void {
    const g = this.geometry;
    let r: Physical | null = null;
    if (this.target) {
      if (!win32.isWindow(this.target) || win32.isMinimized(this.target)) {
        this.host.hide();
        return;
      }
      const f = win32.windowFrame(this.target);
      if (!f) return;
      r = { x: f.x + (g?.origin_x ?? 0), y: f.y + (g?.origin_y ?? 0), w: g?.width ?? f.w, h: g?.height ?? f.h };
      win32.placeAbove(this.host.hwnd, this.target);
    } else if (g) {
      r = { x: Math.round(g.origin_x), y: Math.round(g.origin_y), w: g.width, h: g.height };
    }
    if (r) {
      const key = `${r.x},${r.y},${r.w},${r.h}`;
      if (key !== this.lastBounds) {
        this.lastBounds = key;
        this.host.setBounds(r);
      }
    }
    if (!this.hiddenByUser && !this.host.isVisible) this.host.show();
  }

  /** Interactive mode: hover shows the original, a click copies original and translation. */
  private pointer(): void {
    const c = win32.cursorPos();
    const b = this.host.getBounds();
    const inside = c.x >= b.x && c.y >= b.y && c.x < b.x + b.w && c.y < b.y + b.h;
    const scale = screen.getPrimaryDisplay().scaleFactor || 1;
    this.host.send({ kind: 'pointer', inside, x: (c.x - b.x) / scale, y: (c.y - b.y) / scale });
    const down = win32.leftButtonDown();
    if (down && !this.wasDown && inside) {
      void this.host
        .eval<string | null>(`(() => { const h = window.__sthHit?.(${(c.x - b.x) / scale}, ${(c.y - b.y) / scale}); return h ? h.source + '\\n' + h.translation : null; })()`)
        .then((t) => {
          if (t) clipboard.writeText(t);
        });
    }
    this.wasDown = down;
  }

  setUserHidden(hidden: boolean): void {
    this.hiddenByUser = hidden;
    this.host.setUserHidden(hidden);
  }

  setInteractive(on: boolean): void {
    this.interactive = on;
    this.host.setClickThrough(!on);
    this.host.send({ kind: 'interactive', on });
  }

  close(): void {
    this.host.close();
  }
}

export class OverlayManager {
  private readonly env: WindowEnv;
  private current: OverlaySession | null = null;
  private hidden = false;
  private interactive = false;
  private readonly annotations = new Map<string, Annotation>();
  private annotationHost: OverlayHost | null = null;

  constructor(env: WindowEnv) {
    this.env = env;
  }

  /** overlay.Attach: OverlayStart, then a snapshot, then display events. */
  attach = async (stream: Stream): Promise<void> => {
    let session: OverlaySession | null = null;
    for await (const raw of stream as Stream<Record<string, unknown>, unknown>) {
      if (raw.start) {
        const start = raw.start as { range?: CaptureRange; target_language: string };
        this.current?.close(); // a new continuous run replaces the old overlay
        session = new OverlaySession(this.env, start.range, start.target_language);
        this.current = session;
        if (this.hidden) session.setUserHidden(true);
        if (this.interactive) session.setInteractive(true);
      } else if (raw.snapshot && session) {
        const snap = raw.snapshot as DisplaySnapshot;
        if (snap.geometry) session.setGeometry(snap.geometry);
        session.send({ kind: 'snapshot', snapshot: snap });
      } else if (raw.event && session) {
        const e = raw.event as DisplayEvent;
        if (e.ev.kind === 'batch_start' && e.ev.geometry) session.setGeometry(e.ev.geometry);
        session.send({ kind: 'event', event: e });
      }
    }
    // the run ended: keep the last drawing until hidden or a new run starts (spec 07 section 2.3)
  };

  /** overlay.Annotate: assistant annotations in screen coordinates (spec 17 section 7). */
  annotate = async (stream: Stream): Promise<void> => {
    for await (const m of stream as Stream<{ set?: Annotation[]; clear?: { ids?: string[] } }, unknown>) {
      if (m.set) for (const a of m.set) this.annotations.set(a.id, a);
      if (m.clear) {
        if (m.clear.ids?.length) for (const id of m.clear.ids) this.annotations.delete(id);
        else this.annotations.clear();
      }
      this.pushAnnotations();
    }
  };

  private pushAnnotations(): void {
    const items = [...this.annotations.values()];
    if (!this.annotationHost || this.annotationHost.isClosed) {
      if (items.length === 0) return;
      this.annotationHost = new OverlayHost(this.env, primaryPhysical(), { topmost: true, page: 'annotations.html' });
    }
    const b = this.annotationHost.getBounds();
    this.annotationHost.send({ kind: 'annotations', items, origin: { x: b.x, y: b.y }, scale: screen.getPrimaryDisplay().scaleFactor || 1 });
  }

  toggleVisible(): boolean {
    this.hidden = !this.hidden;
    this.current?.setUserHidden(this.hidden);
    return !this.hidden;
  }

  toggleInteractive(): boolean {
    this.interactive = !this.interactive;
    this.current?.setInteractive(this.interactive);
    return this.interactive;
  }

  applySettings(s: DisplaySettings): void {
    this.current?.send({ kind: 'settings', settings: s });
  }

  hosts(): OverlayHost[] {
    return [this.current?.host, this.annotationHost].filter((h): h is OverlayHost => !!h && !h.isClosed);
  }

  closeAll(): void {
    this.current?.close();
    this.current = null;
    this.annotationHost?.close();
    this.annotationHost = null;
  }
}
