// An overlay page rendered offscreen and shown through a native layered window
// (see layered.ts for why). Used by the overlay, in-place screenshot results and
// assistant annotations.
import { BrowserWindow, screen, type NativeImage } from 'electron';
import { join } from 'node:path';
import { LayeredSurface, type Physical } from './layered.ts';

export interface WindowEnv {
  preload: string;
  rendererDir: string;
  debugCapturable: boolean;
  settings: () => import('@sth/render').DisplaySettings;
}

/**
 * A topmost window covering a whole monitor makes the shell treat it as a full-screen
 * app and drop the taskbar behind other windows (seen on the dev machine). Overlays
 * therefore stay one pixel short of a monitor; the lost bottom row holds nothing to read.
 */
function avoidFullscreen(b: Physical): Physical {
  for (const d of screen.getAllDisplays()) {
    const r = screen.dipToScreenRect(null, d.bounds);
    if (b.x <= r.x && b.y <= r.y && b.x + b.w >= r.x + r.width && b.y + b.h >= r.y + r.height) return { ...b, h: b.h - 1 };
  }
  return b;
}

export class OverlayHost {
  readonly osr: BrowserWindow;
  readonly surface: LayeredSurface;
  private bounds: Physical;
  private readonly ready: Promise<void>;
  private closed = false;
  private hiddenByUser = false;
  private lastFrame: NativeImage | null = null;
  /** Paint statistics for the dev control: frame count, last size, last UpdateLayeredWindow error. */
  readonly stats = { paints: 0, size: [0, 0], error: 0 };
  onClosed?: () => void;

  constructor(env: WindowEnv, requested: Physical, opts: { topmost: boolean; page?: string }) {
    const bounds = avoidFullscreen(requested);
    this.bounds = { ...bounds };
    this.surface = new LayeredSurface(bounds, { topmost: opts.topmost, excludeFromCapture: !env.debugCapturable });
    const scale = screen.getPrimaryDisplay().scaleFactor || 1;
    this.osr = new BrowserWindow({
      show: false,
      width: Math.max(1, Math.round(bounds.w / scale)),
      height: Math.max(1, Math.round(bounds.h / scale)),
      transparent: true,
      frame: false,
      webPreferences: { offscreen: true, preload: env.preload, contextIsolation: true, sandbox: false, backgroundThrottling: false },
    });
    this.osr.webContents.setFrameRate(30);
    this.osr.webContents.on('paint', (_e, _dirty, image) => {
      if (this.closed) return;
      this.lastFrame = image;
      const { width, height } = image.getSize();
      const bmp = image.toBitmap();
      this.stats.paints++;
      this.stats.size = [width, height];
      this.stats.error = this.surface.update(bmp, width, height);
    });
    this.ready = new Promise((r) => this.osr.webContents.once('did-finish-load', () => r()));
    void this.osr.loadFile(join(env.rendererDir, opts.page ?? 'overlay.html'));
    void this.ready.then(() => {
      // the page starts clamped to the work area (display minus taskbar); size it again once loaded
      this.resizePage();
      if (!this.hiddenByUser) this.surface.show();
    });
  }

  get hwnd(): number {
    return this.surface.hwnd;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isVisible(): boolean {
    return this.surface.isVisible;
  }

  getBounds(): Physical {
    return { ...this.bounds };
  }

  send(msg: unknown): void {
    if (this.closed) return;
    void this.ready.then(() => !this.closed && this.osr.webContents.send('sth', msg));
  }

  setBounds(requested: Physical): void {
    if (this.closed) return;
    const b = avoidFullscreen(requested);
    const resized = b.w !== this.bounds.w || b.h !== this.bounds.h;
    this.bounds = { ...b };
    this.surface.setBounds(b);
    if (resized) this.resizePage();
  }

  private resizePage(): void {
    if (this.closed) return;
    const scale = screen.getPrimaryDisplay().scaleFactor || 1;
    this.osr.setContentSize(Math.max(1, Math.round(this.bounds.w / scale)), Math.max(1, Math.round(this.bounds.h / scale)));
  }

  show(): void {
    this.hiddenByUser = false;
    if (!this.closed) this.surface.show();
  }

  hide(): void {
    if (!this.closed) this.surface.hide();
  }

  setUserHidden(hidden: boolean): void {
    this.hiddenByUser = hidden;
    if (hidden) this.hide();
    else this.show();
  }

  setClickThrough(on: boolean): void {
    if (!this.closed) this.surface.setClickThrough(on);
  }

  /** The last rendered frame (debug screenshots). */
  frame(): NativeImage | null {
    return this.lastFrame;
  }

  eval<T>(js: string): Promise<T> {
    return this.osr.webContents.executeJavaScript(js) as Promise<T>;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.surface.destroy();
    if (!this.osr.isDestroyed()) this.osr.destroy();
    this.onClosed?.();
  }
}
