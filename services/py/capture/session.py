"""Capture session state (spec 05 sections 1 to 3): reference frame, pending slot,
previous batch frame and frame numbering. on_frame runs on the source's thread;
take_batch runs on the asyncio loop."""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass

import numpy as np

from .change import ChangeMap, change_map, differs


@dataclass
class Batch:
    frame_id: int
    frame: np.ndarray
    geometry: dict
    captured_at: str
    change_map: ChangeMap | None


class CaptureSession:
    def __init__(self, tolerance: int, tile: int, loop: asyncio.AbstractEventLoop):
        self.tol = int(tolerance)
        self.tile = int(tile)
        self._loop = loop
        self._lock = threading.Lock()
        self._ref: np.ndarray | None = None
        self._pend: tuple[np.ndarray, dict, str] | None = None
        self._batch_frame: np.ndarray | None = None
        self._n = 0
        self._paused = False
        self._wake = asyncio.Event()
        self.accepted = 0
        self.dropped = 0

    # ---- source thread ----

    def on_frame(self, frame: np.ndarray, geometry: dict, captured_at: str) -> None:
        """Spec 05 section 2.1: accept when there is no reference or the frame differs from it."""
        if self._paused:
            return
        with self._lock:
            if self._ref is None or differs(frame, self._ref, self.tol):
                self._pend = (frame, geometry, captured_at)
                self._ref = frame
                self.accepted += 1
                accepted = True
            else:
                self.dropped += 1
                accepted = False
        if accepted:
            self._loop.call_soon_threadsafe(self._wake.set)

    # ---- loop ----

    async def take_batch(self, wait_ms: int) -> Batch | None:
        """Spec 05 section 3: wait for a pending frame, make it the batch frame, compute the change map."""
        if self._pend is None and not self._paused:
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=wait_ms / 1000)
            except asyncio.TimeoutError:
                pass
        with self._lock:
            if self._pend is None or self._paused:
                return None
            frame, geometry, at = self._pend
            self._pend = None
        base = self._batch_frame
        base_id = self._n
        self._n += 1
        cm = await asyncio.to_thread(change_map, frame, base, self.tol, self.tile, self._n, base_id) if base is not None else None
        self._batch_frame = frame
        return Batch(self._n, frame, geometry, at, cm)

    def pause(self) -> None:
        """Clear the pending slot and the reference; keep the previous batch frame (spec 05 section 1)."""
        self._paused = True
        with self._lock:
            self._pend = None
            self._ref = None
        self._loop.call_soon_threadsafe(self._wake.set)

    def resume(self) -> None:
        self._paused = False

    def interrupt_wait(self) -> None:
        self._loop.call_soon_threadsafe(self._wake.set)
