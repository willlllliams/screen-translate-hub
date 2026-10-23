// Screenshot results, card.Open (spec 09 section 8): drawn in place over the
// selected area (default, like william's old app) or in a movable card with the
// original and translated layers (requirement 09 section 3.1).
import type { CaptureGeometry, DisplayEvent, DisplaySnapshot, Image } from '@sth/model';
import type { ScreenshotPlacement } from '@sth/render';
import type { Stream } from '@sth/wire';
import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { OverlayHost, type WindowEnv } from './host.ts';
import * as win32 from './win32.ts';

interface CardStart {
  kind: string;
  run_id: string;
  image?: Image;
  target_language: string;
  anchor?: { x: number; y: number };
}

type Target = { send(msg: unknown): void; onClosed(cb: () => void): void };

export class CardService {
  private readonly env: WindowEnv;
  private readonly placement: () => ScreenshotPlacement;
  private inplace: OverlayHost[] = [];
  private readonly floating = new Set<BrowserWindow>();
  private seq = 0;

  constructor(env: WindowEnv, placement: () => ScreenshotPlacement) {
    this.env = env;
    this.placement = placement;
  }

  open = async (stream: Stream): Promise<void> => {
    let target: Target | null = null;
    for await (const raw of stream as Stream<Record<string, unknown>, unknown>) {
      if (raw.start) {
        const start = raw.start as CardStart;
        const geom = start.image?.geometry as CaptureGeometry | undefined;
        const mode = this.placement();
        target = mode === 'inplace' && geom ? this.inPlace(geom) : this.card(start);
        target.send({ kind: 'settings', settings: this.env.settings() });
        target.send({ kind: 'view', target_language: start.target_language });
        if (mode !== 'inplace' && start.image) target.send({ kind: 'image', image: start.image.image });
        await stream.send({ opened: { card_id: `card-${++this.seq}` } });
        target.onClosed(() => void stream.send({ closed: {} }).catch(() => undefined));
      } else if (raw.snapshot) {
        target?.send({ kind: 'snapshot', snapshot: raw.snapshot as DisplaySnapshot });
      } else if (raw.display) {
        target?.send({ kind: 'event', event: raw.display as DisplayEvent });
      }
    }
  };

  private inPlace(g: CaptureGeometry): Target {
    const host = new OverlayHost(this.env, { x: Math.round(g.origin_x), y: Math.round(g.origin_y), w: g.width, h: g.height }, { topmost: true });
    this.inplace.push(host);
    const closers: Array<() => void> = [];
    host.onClosed = () => {
      this.inplace = this.inplace.filter((x) => x !== host);
      this.updateWatch();
      for (const c of closers) c();
    };
    this.updateWatch();
    return { send: (m) => host.send(m), onClosed: (cb) => closers.push(cb) };
  }

  private card(start: CardStart): Target {
    const img = start.image?.image;
    const work = screen.getPrimaryDisplay().workAreaSize;
    const scale = img ? Math.min(1, (work.width * 0.7) / img.width, (work.height * 0.7) / img.height) : 1;
    const width = Math.max(240, Math.round((img?.width ?? 480) * scale));
    const height = Math.max(120, Math.round((img?.height ?? 300) * scale)) + 30;
    const anchor = start.anchor ? screen.screenToDipPoint(start.anchor) : screen.getCursorScreenPoint();
    // below the selection when it fits; otherwise above it, and always inside the work area
    const area = screen.getDisplayNearestPoint(anchor).workArea;
    const geom = start.image?.geometry;
    let y = anchor.y;
    if (y + height > area.y + area.height && geom) y = screen.screenToDipPoint({ x: geom.origin_x, y: geom.origin_y }).y - height - 8;
    y = Math.max(area.y, Math.min(y, area.y + area.height - height));
    const x = Math.max(area.x, Math.min(anchor.x, area.x + area.width - width));
    const win = new BrowserWindow({
      x: Math.round(x),
      y: Math.round(y),
      width,
      height,
      frame: false,
      resizable: true,
      focusable: false, // floating cards never take focus (requirement 01 section 5.3)
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#202124',
      show: false,
      webPreferences: { preload: this.env.preload, contextIsolation: true, sandbox: false },
    });
    if (!this.env.debugCapturable) win.setContentProtection(true);
    win32.makeToolWindow(win32.hwndOf(win.getNativeWindowHandle()));
    this.floating.add(win);
    win.on('closed', () => this.floating.delete(win));
    void win.loadFile(join(this.env.rendererDir, 'card.html'));
    const ready = new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()));
    void ready.then(() => win.showInactive());
    return {
      send: (m) => void ready.then(() => !win.isDestroyed() && win.webContents.send('sth', m)),
      onClosed: (cb) => win.on('closed', cb),
    };
  }

  /**
   * While in-place results are on screen, Esc or a click outside them dismisses them
   * (requirement 09 section 3.1). Both are seen by polling: the results let clicks through,
   * so a click inside a result stays with the window under it, and a global Esc hotkey would
   * take the key away from every other program while results are shown.
   */
  private updateWatch(): void {
    const want = this.inplace.length > 0;
    if (want && !this.watchTimer) {
      this.wasDown = win32.leftButtonDown();
      this.escWasDown = win32.keyDown(win32.VK_ESCAPE);
      this.watchTimer = setInterval(() => this.watchInput(), 50);
    } else if (!want && this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = undefined;
    }
  }

  private wasDown = false;
  private escWasDown = false;
  private watchTimer?: ReturnType<typeof setInterval>;

  private watchInput(): void {
    const esc = win32.keyDown(win32.VK_ESCAPE);
    const escPressed = esc && !this.escWasDown;
    this.escWasDown = esc;
    if (escPressed) {
      this.dismissInPlace();
      return;
    }
    const down = win32.leftButtonDown();
    if (down && !this.wasDown) {
      const c = win32.cursorPos();
      const inside = this.inplace.some((h) => {
        const b = h.getBounds();
        return c.x >= b.x && c.y >= b.y && c.x < b.x + b.w && c.y < b.y + b.h;
      });
      if (!inside) this.dismissInPlace();
    }
    this.wasDown = down;
  }

  dismissInPlace(): void {
    for (const h of [...this.inplace]) h.close();
    this.inplace = [];
    this.updateWatch();
  }

  /** The floating cards on screen (dev control). */
  cardWindows(): BrowserWindow[] {
    return [...this.floating].filter((w) => !w.isDestroyed());
  }

  hosts(): OverlayHost[] {
    return this.inplace.filter((h) => !h.isClosed);
  }
}
