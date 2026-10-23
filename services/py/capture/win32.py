"""Win32 helpers for the capture service: DPI awareness, monitors, windows, cursor."""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import sys
from dataclasses import dataclass

IS_WINDOWS = sys.platform == "win32"

if IS_WINDOWS:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    dwmapi = ctypes.WinDLL("dwmapi")
    kernel32 = ctypes.WinDLL("kernel32")


@dataclass
class Monitor:
    index: int          # 1-based, enumeration order (matches windows-capture's monitor_index)
    device: str         # e.g. \\.\DISPLAY1
    x: int
    y: int
    w: int
    h: int
    primary: bool


class MONITORINFOEXW(ctypes.Structure):
    _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT), ("dwFlags", wt.DWORD),
                ("szDevice", wt.WCHAR * 32)]


def set_dpi_aware() -> None:
    """Per-monitor DPI awareness V2: window and capture coordinates are physical pixels (spec 12 section 3.1)."""
    if not IS_WINDOWS:
        return
    try:
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        pass


def monitors() -> list[Monitor]:
    if not IS_WINDOWS:
        return []
    out: list[Monitor] = []
    proc_t = ctypes.WINFUNCTYPE(wt.BOOL, wt.HMONITOR, wt.HDC, ctypes.POINTER(wt.RECT), wt.LPARAM)

    def cb(hmon, hdc, rect, data):
        info = MONITORINFOEXW()
        info.cbSize = ctypes.sizeof(MONITORINFOEXW)
        user32.GetMonitorInfoW(hmon, ctypes.byref(info))
        r = info.rcMonitor
        out.append(Monitor(len(out) + 1, info.szDevice, r.left, r.top, r.right - r.left, r.bottom - r.top,
                           bool(info.dwFlags & 1)))
        return True

    user32.EnumDisplayMonitors(None, None, proc_t(cb), 0)
    return out


def monitor_for_point(x: float, y: float) -> Monitor | None:
    for m in monitors():
        if m.x <= x < m.x + m.w and m.y <= y < m.y + m.h:
            return m
    ms = monitors()
    return next((m for m in ms if m.primary), ms[0] if ms else None)


def monitor_by_device(device: str | None) -> Monitor | None:
    ms = monitors()
    if device:
        for m in ms:
            if m.device == device or str(m.index) == str(device):
                return m
    return next((m for m in ms if m.primary), ms[0] if ms else None)


def window_frame(hwnd: int) -> tuple[int, int, int, int] | None:
    """DWMWA_EXTENDED_FRAME_BOUNDS: the visible frame without the invisible resize border (spec 12 section 3.2)."""
    if not IS_WINDOWS:
        return None
    r = wt.RECT()
    hr = dwmapi.DwmGetWindowAttribute(wt.HWND(hwnd), 9, ctypes.byref(r), ctypes.sizeof(r))
    if hr != 0:
        if not user32.GetWindowRect(wt.HWND(hwnd), ctypes.byref(r)):
            return None
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def is_window(hwnd: int) -> bool:
    return bool(IS_WINDOWS and user32.IsWindow(wt.HWND(hwnd)))


def is_minimized(hwnd: int) -> bool:
    return bool(IS_WINDOWS and user32.IsIconic(wt.HWND(hwnd)))


def foreground_window() -> int:
    return int(user32.GetForegroundWindow() or 0) if IS_WINDOWS else 0


def window_pid(hwnd: int) -> int:
    if not IS_WINDOWS:
        return 0
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(wt.HWND(hwnd), ctypes.byref(pid))
    return int(pid.value)


def window_title(hwnd: int) -> str:
    if not IS_WINDOWS:
        return ""
    n = user32.GetWindowTextLengthW(wt.HWND(hwnd))
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(wt.HWND(hwnd), buf, n + 1)
    return buf.value


def cursor_pos() -> tuple[int, int]:
    if not IS_WINDOWS:
        return 0, 0
    p = wt.POINT()
    user32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y


def is_capturable_top_window(hwnd: int) -> bool:
    """A normal visible top-level window (skip tool windows, desktop, taskbar)."""
    if not IS_WINDOWS or not hwnd or not user32.IsWindowVisible(wt.HWND(hwnd)):
        return False
    GWL_EXSTYLE = -20
    WS_EX_TOOLWINDOW = 0x80
    ex = user32.GetWindowLongW(wt.HWND(hwnd), GWL_EXSTYLE)
    if ex & WS_EX_TOOLWINDOW:
        return False
    cls = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(wt.HWND(hwnd), cls, 256)
    return cls.value not in ("Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd")
