"""Frame sources for the capture session: Windows.Graphics.Capture and replay.

A source calls on_frame(frame, geometry, captured_at) from its own thread with a
BGRA numpy array it owns (already copied), and on_closed(reason) once when the
capture target goes away.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Callable, Protocol

import numpy as np

from . import win32

OnFrame = Callable[[np.ndarray, dict, str], None]
OnClosed = Callable[[str], None]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class FrameSource(Protocol):
    def start(self, on_frame: OnFrame, on_closed: OnClosed) -> None: ...
    def stop(self) -> None: ...
    def restart(self) -> None: ...


def _geometry_display(m: win32.Monitor, w: int, h: int) -> dict:
    return {"kind": "display", "display_id": m.device, "origin_x": float(m.x), "origin_y": float(m.y),
            "scale": 1.0, "width": w, "height": h}


class WgcSource:
    """Windows.Graphics.Capture via windows-capture: no cursor, no yellow border (spec 12 section 3.2)."""

    def __init__(self, capture_range: dict, interval_ms: int, exclude_pids: set[int] | None = None):
        self.range = capture_range
        self.interval_ms = max(16, int(interval_ms))
        self.exclude_pids = exclude_pids or set()
        self._ctl = None
        self._lock = threading.Lock()
        self._stopping = False
        self._on_frame: OnFrame | None = None
        self._on_closed: OnClosed | None = None
        self._hwnd: int | None = None
        self._monitor: win32.Monitor | None = None
        self._crop: tuple[int, int, int, int] | None = None
        self._follow = bool(capture_range.get("follow_active_window"))
        self._follow_thread: threading.Thread | None = None

    # ---- FrameSource ----

    def start(self, on_frame: OnFrame, on_closed: OnClosed) -> None:
        self._on_frame, self._on_closed = on_frame, on_closed
        self._stopping = False
        if self._follow:
            self._hwnd = self._pick_foreground() or None
            self._follow_thread = threading.Thread(target=self._follow_loop, daemon=True)
            self._follow_thread.start()
        self._open()

    def stop(self) -> None:
        self._stopping = True
        self._close_capture()

    def restart(self) -> None:
        """Re-open the capture so a fresh first frame arrives even if the screen is static."""
        self._close_capture()
        if not self._stopping:
            self._open()

    # ---- internals ----

    def _pick_foreground(self) -> int:
        h = win32.foreground_window()
        if h and win32.is_capturable_top_window(h) and win32.window_pid(h) not in self.exclude_pids:
            return h
        return 0

    def _follow_loop(self) -> None:
        while not self._stopping:
            time.sleep(0.3)
            h = self._pick_foreground()
            if h and h != self._hwnd:
                self._hwnd = h
                self.restart()

    def _open(self) -> None:
        from windows_capture import WindowsCapture

        kwargs: dict = {"cursor_capture": False, "draw_border": False, "minimum_update_interval": self.interval_ms}
        r = self.range
        self._crop = None
        if self._follow or r.get("window_id"):
            hwnd = self._hwnd if self._follow else int(r["window_id"])
            if not hwnd:
                return  # follow mode with no eligible window yet; the follow loop will open one
            if not win32.is_window(hwnd):
                self._closed("TARGET_CLOSED")
                return
            self._hwnd = hwnd
            kwargs["window_hwnd"] = hwnd
        elif r.get("region"):
            reg = r["region"]
            m = win32.monitor_by_device(reg.get("display_id")) or win32.monitor_for_point(reg["x"], reg["y"])
            self._monitor = m
            kwargs["monitor_index"] = m.index
            x0, y0 = int(round(reg["x"] - m.x)), int(round(reg["y"] - m.y))
            self._crop = (max(0, x0), max(0, y0), int(round(reg["w"])), int(round(reg["h"])))
        else:
            m = win32.monitor_by_device(r.get("display_id"))
            self._monitor = m
            kwargs["monitor_index"] = m.index if m else 1

        cap = WindowsCapture(**kwargs)

        @cap.event
        def on_frame_arrived(frame, control):  # noqa: ANN001
            if self._stopping:
                control.stop()
                return
            self._deliver(frame.frame_buffer)

        @cap.event
        def on_closed():
            if not self._stopping and kwargs.get("window_hwnd") and not self._follow:
                if not win32.is_window(kwargs["window_hwnd"]):
                    self._closed("TARGET_CLOSED")

        with self._lock:
            self._ctl = cap.start_free_threaded()

    def _deliver(self, buf: np.ndarray) -> None:
        if self._crop is not None:
            x, y, w, h = self._crop
            frame = np.array(buf[y:y + h, x:x + w], copy=True)
            m = self._monitor
            geom = {"kind": "region", "display_id": m.device if m else "", "origin_x": float((m.x if m else 0) + x),
                    "origin_y": float((m.y if m else 0) + y), "scale": 1.0,
                    "width": frame.shape[1], "height": frame.shape[0]}
        elif self._hwnd:
            frame = np.array(buf, copy=True)
            geom = {"kind": "window", "display_id": "", "window_id": int(self._hwnd), "origin_x": 0.0,
                    "origin_y": 0.0, "scale": 1.0, "width": frame.shape[1], "height": frame.shape[0]}
        else:
            frame = np.array(buf, copy=True)
            m = self._monitor
            geom = _geometry_display(m, frame.shape[1], frame.shape[0]) if m else {
                "kind": "display", "display_id": "", "origin_x": 0.0, "origin_y": 0.0, "scale": 1.0,
                "width": frame.shape[1], "height": frame.shape[0]}
        if self._on_frame:
            self._on_frame(frame, geom, now_iso())

    def _closed(self, reason: str) -> None:
        if self._on_closed and not self._stopping:
            self._on_closed(reason)

    def _close_capture(self) -> None:
        with self._lock:
            ctl, self._ctl = self._ctl, None
        if ctl is not None:
            try:
                ctl.stop()
            except Exception:
                pass


class ReplaySource:
    """Replays frames from memory, for tests and headless runs (spec 16 section 2)."""

    def __init__(self, frames: list[tuple[float, np.ndarray]], loop_last: bool = False):
        self.frames = frames
        self.loop_last = loop_last
        self._stopping = False
        self._thread: threading.Thread | None = None
        self._on_frame: OnFrame | None = None
        self._restart = threading.Event()

    def start(self, on_frame: OnFrame, on_closed: OnClosed) -> None:
        self._on_frame = on_frame
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        t0 = time.monotonic()
        last = None
        for at, frame in self.frames:
            while not self._stopping and time.monotonic() - t0 < at:
                time.sleep(0.005)
            if self._stopping:
                return
            last = frame
            self._emit(frame)
        while not self._stopping:
            if self._restart.wait(0.05):
                self._restart.clear()
                if last is not None:
                    self._emit(last)

    def _emit(self, frame: np.ndarray) -> None:
        geom = {"kind": "display", "display_id": "replay", "origin_x": 0.0, "origin_y": 0.0, "scale": 1.0,
                "width": frame.shape[1], "height": frame.shape[0]}
        if self._on_frame:
            self._on_frame(frame.copy(), geom, now_iso())

    def stop(self) -> None:
        self._stopping = True

    def restart(self) -> None:
        self._restart.set()


def grab_once(target: dict, timeout_s: float = 5.0) -> tuple[np.ndarray, dict]:
    """capture.Grab: one frame of a display, window, region or the area around the cursor."""
    rng: dict
    if target.get("mouse_region"):
        mw, mh = target["mouse_region"]["width"], target["mouse_region"]["height"]
        cx, cy = win32.cursor_pos()
        m = win32.monitor_for_point(cx, cy)
        x = min(max(cx - mw / 2, m.x), m.x + m.w - mw)
        y = min(max(cy - mh / 2, m.y), m.y + m.h - mh)
        rng = {"region": {"display_id": m.device, "x": x, "y": y, "w": mw, "h": mh}}
    elif target.get("window_id"):
        rng = {"window_id": target["window_id"]}
    elif target.get("region"):
        rng = {"region": target["region"]}
    else:
        rng = {"display_id": target.get("display_id")}
    got: dict = {}
    ev = threading.Event()

    def on_frame(frame: np.ndarray, geom: dict, at: str) -> None:
        if not ev.is_set():
            got.update(frame=frame, geom=geom, at=at)
            ev.set()

    src = WgcSource(rng, 16)
    src.start(on_frame, lambda reason: ev.set())
    ok = ev.wait(timeout_s)
    src.stop()
    if not ok or "frame" not in got:
        raise TimeoutError("no frame from capture")
    geom = dict(got["geom"])
    geom["captured_at"] = got["at"]
    return got["frame"], geom
