// Native layered window (WS_EX_LAYERED + UpdateLayeredWindow) for overlays.
// Chromium transparent windows need GPU compositing, which is missing on remote
// sessions and virtual displays (found on the dev machine: transparent Electron
// windows never appear, opaque ones do). Overlay pages therefore render offscreen
// and their BGRA frames are pushed into this window; it needs no GPU at all.
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const POINT = koffi.struct('LW_POINT', { x: 'long', y: 'long' });
const SIZE = koffi.struct('LW_SIZE', { cx: 'long', cy: 'long' });
const BLEND = koffi.struct('LW_BLEND', { op: 'uint8', flags: 'uint8', alpha: 'uint8', format: 'uint8' });
const BMIH = koffi.struct('LW_BITMAPINFOHEADER', {
  biSize: 'uint32',
  biWidth: 'int32',
  biHeight: 'int32',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'int32',
  biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32',
});

const GetModuleHandleW = kernel32.func('intptr __stdcall GetModuleHandleW(intptr name)');
const GetLastError = kernel32.func('uint32 __stdcall GetLastError()');
const RtlMoveMemory = kernel32.func('void __stdcall RtlMoveMemory(intptr dst, const uint8 *src, uintptr n)');
const CreateWindowExW = user32.func(
  'intptr __stdcall CreateWindowExW(uint32 ex, const char16 *cls, const char16 *name, uint32 style, int x, int y, int w, int h, intptr parent, intptr menu, intptr inst, intptr param)',
);
const DestroyWindow = user32.func('bool __stdcall DestroyWindow(intptr hwnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr hwnd, int cmd)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr hwnd, intptr after, int x, int y, int cx, int cy, uint32 flags)');
const SetWindowDisplayAffinity = user32.func('bool __stdcall SetWindowDisplayAffinity(intptr hwnd, uint32 affinity)');
const GetWindowLongPtrW = user32.func('intptr __stdcall GetWindowLongPtrW(intptr hwnd, int index)');
const SetWindowLongPtrW = user32.func('intptr __stdcall SetWindowLongPtrW(intptr hwnd, int index, intptr value)');
const GetDC = user32.func('intptr __stdcall GetDC(intptr hwnd)');
const ReleaseDC = user32.func('int __stdcall ReleaseDC(intptr hwnd, intptr dc)');
const UpdateLayeredWindow = user32.func(
  'bool __stdcall UpdateLayeredWindow(intptr hwnd, intptr dst, LW_POINT *pos, LW_SIZE *size, intptr src, LW_POINT *srcPos, uint32 key, LW_BLEND *blend, uint32 flags)',
);
const CreateCompatibleDC = gdi32.func('intptr __stdcall CreateCompatibleDC(intptr dc)');
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(intptr dc)');
const CreateDIBSection = gdi32.func('intptr __stdcall CreateDIBSection(intptr dc, LW_BITMAPINFOHEADER *bmi, uint32 usage, _Out_ intptr *bits, intptr section, uint32 offset)');
const SelectObject = gdi32.func('intptr __stdcall SelectObject(intptr dc, intptr obj)');
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(intptr obj)');

const WS_POPUP = 0x80000000;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_NOACTIVATE = 0x08000000;
const GWL_EXSTYLE = -20;
const SW_HIDE = 0;
const SW_SHOWNOACTIVATE = 4;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const HWND_TOPMOST = -1;
const ULW_ALPHA = 2;
const WDA_EXCLUDEFROMCAPTURE = 0x11;

export interface Physical { x: number; y: number; w: number; h: number }

export class LayeredSurface {
  readonly hwnd: number;
  private bounds: Physical;
  private visible = false;
  private destroyed = false;
  private dib = { dc: 0, bmp: 0, old: 0, bits: 0, w: 0, h: 0 };

  constructor(bounds: Physical, opts: { topmost: boolean; excludeFromCapture: boolean }) {
    this.bounds = { ...bounds };
    const ex = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | (opts.topmost ? WS_EX_TOPMOST : 0);
    this.hwnd = Number(CreateWindowExW(ex, 'Static', 'sth-overlay', WS_POPUP, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, GetModuleHandleW(0), 0));
    if (!this.hwnd) throw new Error('CreateWindowExW failed');
    if (opts.excludeFromCapture) SetWindowDisplayAffinity(this.hwnd, WDA_EXCLUDEFROMCAPTURE);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  private ensureDib(w: number, h: number): void {
    if (this.dib.w === w && this.dib.h === h && this.dib.dc) return;
    this.freeDib();
    const screen = Number(GetDC(0));
    const dc = Number(CreateCompatibleDC(screen));
    ReleaseDC(0, screen);
    const bits = [0];
    const bmi = { biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 };
    const bmp = Number(CreateDIBSection(dc, bmi, 0, bits, 0, 0));
    const old = Number(SelectObject(dc, bmp));
    this.dib = { dc, bmp, old, bits: Number(bits[0]), w, h };
  }

  private freeDib(): void {
    if (!this.dib.dc) return;
    SelectObject(this.dib.dc, this.dib.old);
    DeleteObject(this.dib.bmp);
    DeleteDC(this.dib.dc);
    this.dib = { dc: 0, bmp: 0, old: 0, bits: 0, w: 0, h: 0 };
  }

  /** Push a premultiplied BGRA frame (top-down rows) of size w x h; returns 0 or the Win32 error. */
  update(bgra: Buffer, w: number, h: number): number {
    if (this.destroyed || w <= 0 || h <= 0) return 0;
    this.ensureDib(w, h);
    if (!this.dib.bits) return -1;
    RtlMoveMemory(this.dib.bits, bgra, Math.min(bgra.length, w * h * 4));
    const screen = Number(GetDC(0));
    const ok = UpdateLayeredWindow(this.hwnd, screen, { x: this.bounds.x, y: this.bounds.y }, { cx: w, cy: h }, this.dib.dc, { x: 0, y: 0 }, 0, { op: 0, flags: 0, alpha: 255, format: 1 }, ULW_ALPHA);
    const err = ok ? 0 : Number(GetLastError()) || -2;
    ReleaseDC(0, screen);
    return err;
  }

  setBounds(b: Physical): void {
    if (this.destroyed) return;
    const moved = b.x !== this.bounds.x || b.y !== this.bounds.y;
    this.bounds = { ...b };
    if (moved) SetWindowPos(this.hwnd, 0, b.x, b.y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | 0x0004 /* NOZORDER */);
  }

  show(): void {
    if (this.destroyed || this.visible) return;
    ShowWindow(this.hwnd, SW_SHOWNOACTIVATE);
    this.visible = true;
  }

  hide(): void {
    if (this.destroyed || !this.visible) return;
    ShowWindow(this.hwnd, SW_HIDE);
    this.visible = false;
  }

  /** Interactive mode: let the window receive clicks where it draws something. */
  setClickThrough(on: boolean): void {
    const ex = Number(GetWindowLongPtrW(this.hwnd, GWL_EXSTYLE));
    SetWindowLongPtrW(this.hwnd, GWL_EXSTYLE, on ? ex | WS_EX_TRANSPARENT : ex & ~WS_EX_TRANSPARENT);
  }

  bringToTop(): void {
    SetWindowPos(this.hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.freeDib();
    DestroyWindow(this.hwnd);
  }
}
