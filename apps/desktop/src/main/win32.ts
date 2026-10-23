// Win32 calls through koffi (spec 12 section 3): window frames, z-order, minimized
// state, foreground window and extended styles. No native build step is needed.
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const dwmapi = koffi.load('dwmapi.dll');

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr hwnd, _Out_ RECT *rect)');
const DwmGetWindowAttribute = dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ RECT *value, uint32 size)');
const IsWindow = user32.func('bool __stdcall IsWindow(intptr hwnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr hwnd)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr hwnd)');
const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()');
const GetWindow = user32.func('intptr __stdcall GetWindow(intptr hwnd, uint32 cmd)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr hwnd, intptr after, int x, int y, int cx, int cy, uint32 flags)');
const GetWindowLongPtrW = user32.func('intptr __stdcall GetWindowLongPtrW(intptr hwnd, int index)');
const SetWindowLongPtrW = user32.func('intptr __stdcall SetWindowLongPtrW(intptr hwnd, int index, intptr value)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr hwnd, _Out_ uint16 *buf, int max)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32 *pid)');
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)');
const WindowFromPoint = user32.func('intptr __stdcall WindowFromPoint(POINT p)');
const GetAncestor = user32.func('intptr __stdcall GetAncestor(intptr hwnd, uint32 flags)');

const GetWindowDisplayAffinity = user32.func('bool __stdcall GetWindowDisplayAffinity(intptr hwnd, _Out_ uint32 *affinity)');

const DwmGetCloaked = dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ uint32 *value, uint32 size)');

/** Diagnostics for a window: visibility, DWM cloaking, extended style, frame. */
export function windowInfo(hwnd: number): Record<string, unknown> {
  const cloaked = [0];
  DwmGetCloaked(hwnd, 14, cloaked, 4); // DWMWA_CLOAKED
  return {
    hwnd,
    visible: isVisible(hwnd),
    cloaked: cloaked[0],
    exstyle: `0x${Number(GetWindowLongPtrW(hwnd, -20)).toString(16)}`,
    style: `0x${Number(GetWindowLongPtrW(hwnd, -16)).toString(16)}`,
    frame: windowFrame(hwnd),
    above: Number(GetWindow(hwnd, 3)),
  };
}

/** 0 = none, 1 = WDA_MONITOR, 0x11 = WDA_EXCLUDEFROMCAPTURE. */
export function displayAffinity(hwnd: number): number {
  const v = [0];
  GetWindowDisplayAffinity(hwnd, v);
  return v[0];
}

const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int key)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr hwnd)');

/** Give the keyboard back to a window; works while this process owns the foreground (after the hotkey). */
export function setForeground(hwnd: number): boolean {
  return !!hwnd && isWindow(hwnd) && SetForegroundWindow(hwnd);
}

/** Whether a key or mouse button (virtual-key code) is down right now. */
export function keyDown(vk: number): boolean {
  return (GetAsyncKeyState(vk) & 0x8000) !== 0;
}

/** Whether the left mouse button is down right now. */
export function leftButtonDown(): boolean {
  return keyDown(0x01);
}

export const VK_ESCAPE = 0x1b;

const GW_HWNDPREV = 3;
const GA_ROOT = 2;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_TOPMOST = 0x00000008;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const WS_EX_NOACTIVATE = 0x08000000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

export interface Rect { x: number; y: number; w: number; h: number }

export function hwndOf(handle: Buffer): number {
  return handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
}

/** The visible frame without the invisible resize border, in physical pixels. */
export function windowFrame(hwnd: number): Rect | null {
  const r = { left: 0, top: 0, right: 0, bottom: 0 };
  if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, koffi.sizeof(RECT)) !== 0) {
    if (!GetWindowRect(hwnd, r)) return null;
  }
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
}

export function isWindow(hwnd: number): boolean {
  return !!IsWindow(hwnd);
}

export function isMinimized(hwnd: number): boolean {
  return !!IsIconic(hwnd);
}

export function isVisible(hwnd: number): boolean {
  return !!IsWindowVisible(hwnd);
}

export function foregroundWindow(): number {
  return Number(GetForegroundWindow());
}

export function windowTitle(hwnd: number): string {
  const buf = new Uint16Array(512);
  const n = GetWindowTextW(hwnd, buf, 512);
  return String.fromCharCode(...buf.slice(0, n));
}

export function windowPid(hwnd: number): number {
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  return pid[0];
}

export function cursorPos(): { x: number; y: number } {
  const p = { x: 0, y: 0 };
  GetCursorPos(p);
  return p;
}

export function topWindowAt(x: number, y: number): number {
  const h = Number(WindowFromPoint({ x, y }));
  return h ? Number(GetAncestor(h, GA_ROOT)) : 0;
}

function isTopmost(hwnd: number): boolean {
  return (Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOPMOST) !== 0;
}

/**
 * Place `hwnd` directly above `target` in the z-order (spec 12 section 3.3).
 *
 * A background process cannot raise a window with HWND_TOP (the call succeeds and does
 * nothing), but it can lower one by inserting it after another window, and it can make
 * its own window topmost and back. So: when the target is the top window of the normal
 * band (the one above it is topmost), our window goes topmost and then HWND_NOTOPMOST,
 * which puts it at the top of the normal band; otherwise it is inserted after the window
 * above the target. Inserting after a topmost window would make ours topmost and draw it
 * over unrelated dialogs and overlays.
 */
export function placeAbove(hwnd: number, target: number): void {
  const prev = Number(GetWindow(target, GW_HWNDPREV));
  if (prev === hwnd && !isTopmost(hwnd)) return;
  const flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
  if (isTopmost(target)) {
    SetWindowPos(hwnd, prev && prev !== hwnd ? prev : HWND_TOPMOST, 0, 0, 0, 0, flags);
  } else if (!prev || prev === hwnd || isTopmost(prev)) {
    if (!isTopmost(hwnd)) SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
    SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
  } else {
    SetWindowPos(hwnd, prev, 0, 0, 0, 0, flags);
  }
}

/** Tool window (not in the taskbar or Alt+Tab) that never activates. */
export function makeToolWindow(hwnd: number): void {
  const ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
}
