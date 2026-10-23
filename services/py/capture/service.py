"""capture service: capture.Session and capture.Grab (spec 09 section 4)."""

from __future__ import annotations

import asyncio
import glob
import logging
import os
import sys

import cv2
import numpy as np

from sth_service import Boot, read_boot, run, serve, setup_logging
from sth_wire import RpcError, ServiceHost, Stream

from . import win32
from .session import Batch, CaptureSession
from .sources import ReplaySource, WgcSource, grab_once

log = logging.getLogger("sth")

MANIFEST = {
    "name": "capture",
    "display_name": "Screen capture (Windows.Graphics.Capture)",
    "interfaces": [{"name": "capture", "major": 1, "minor": 0}],
    "engine": {"id": "wgc", "name": "Windows.Graphics.Capture", "version": "windows-capture 2"},
    "platform": {"os": "windows", "arch": "x86_64", "accelerators": ["cpu"]},
}


def encode_image(frame: np.ndarray, fmt: str) -> dict:
    h, w = frame.shape[:2]
    if fmt == "png":
        ok, buf = cv2.imencode(".png", frame)
        data = buf.tobytes()
    elif fmt == "jpeg":
        ok, buf = cv2.imencode(".jpg", frame[:, :, :3], [cv2.IMWRITE_JPEG_QUALITY, 85])
        data = buf.tobytes()
    else:
        fmt = "raw_bgra8"
        data = np.ascontiguousarray(frame).tobytes()
    return {"format": fmt, "width": int(w), "height": int(h), "data": data}


def to_image(frame: np.ndarray, geometry: dict, captured_at: str, fmt: str) -> dict:
    return {"image": encode_image(frame, fmt), "geometry": geometry, "captured_at": captured_at}


def load_replay(cfg: dict) -> ReplaySource:
    """config.replay = {"dir": path, "interval_ms": 500}: PNG files played in name order."""
    files = sorted(glob.glob(os.path.join(cfg["dir"], "*.png")))
    step = cfg.get("interval_ms", 500) / 1000
    frames = []
    for i, f in enumerate(files):
        img = cv2.imread(f, cv2.IMREAD_UNCHANGED)
        if img.ndim == 2:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
        elif img.shape[2] == 3:
            img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
        frames.append((i * step, img))
    return ReplaySource(frames)


def build(boot: Boot) -> ServiceHost:
    host = ServiceHost()
    exclude = set(int(p) for p in boot.config.get("exclude_pids", []))

    async def session(stream: Stream, info) -> None:
        loop = asyncio.get_running_loop()
        first = await stream.recv()
        if not first or "start" not in first:
            raise RpcError("invalid_argument", "Session must start with Start")
        start = first["start"]
        trigger = start.get("trigger") or {}
        sess = CaptureSession(start.get("tolerance", 8), start.get("tile", 16), loop)
        fmt = start.get("frame_format", "raw_bgra8")
        if boot.config.get("replay"):
            src = load_replay(boot.config["replay"])
        else:
            src = WgcSource(start.get("range") or {}, trigger.get("interval_ms", 500), exclude)
        interrupted: asyncio.Queue[str] = asyncio.Queue()
        src.start(sess.on_frame, lambda reason: loop.call_soon_threadsafe(interrupted.put_nowait, reason))
        send_lock = asyncio.Lock()

        async def send(m: dict) -> None:
            async with send_lock:
                await stream.send(m)

        await send({"started": {}})
        takes: asyncio.Queue[int] = asyncio.Queue()

        async def worker() -> None:
            while True:
                wait_ms = await takes.get()
                b: Batch | None = await sess.take_batch(wait_ms)
                if b is None:
                    await send({"no_batch": {}})
                    continue
                msg = {"frame_id": b.frame_id, "frame": to_image(b.frame, b.geometry, b.captured_at, fmt)}
                if b.change_map is not None:
                    msg["change_map"] = b.change_map.to_wire()
                await send({"batch": msg})

        async def watch_interrupts() -> None:
            reason = await interrupted.get()
            await send({"interrupted": {"reason": reason}})

        tasks = [asyncio.create_task(worker()), asyncio.create_task(watch_interrupts())]
        try:
            async for m in stream:
                if "take_batch" in m:
                    takes.put_nowait(int((m["take_batch"] or {}).get("wait_ms", 1000)))
                elif "pause" in m:
                    sess.pause()
                    await send({"paused": {}})
                elif "resume" in m:
                    sess.resume()
                    src.restart()
                    await send({"resumed": {}})
        finally:
            src.stop()
            for t in tasks:
                t.cancel()

    async def grab(stream: Stream, info) -> None:
        req = await stream.recv() or {}
        try:
            frame, geom = await asyncio.to_thread(grab_once, req)
        except TimeoutError as e:
            raise RpcError("unavailable", str(e)) from e
        at = geom.pop("captured_at")
        await stream.send(to_image(frame, geom, at, req.get("format", "raw_bgra8")))

    host.implement(boot.name, "capture", (1, 0), {"Session": session, "Grab": grab})
    return host


async def main() -> None:
    setup_logging("capture")
    win32.set_dpi_aware()
    boot = read_boot("capture")
    await serve(boot, build(boot), {**MANIFEST, "name": boot.name})


if __name__ == "__main__":
    run(main)
