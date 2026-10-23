"""Multiplexed connection; mirrors packages/wire/src/connection.ts."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable

import msgpack

from .status import Status
from .stream import Stream

PING_IDLE_S = 15.0
DEAD_AFTER_S = 45.0


def encode_frame(frame: dict) -> bytes:
    return msgpack.packb({k: v for k, v in frame.items() if v is not None}, use_bin_type=True)


def decode_frame(data: bytes) -> dict:
    f = msgpack.unpackb(data, raw=False)
    if not isinstance(f, dict) or not isinstance(f.get("t"), str):
        raise ValueError("malformed frame")
    return f


class Connection:
    def __init__(self, send: Callable[[bytes], Awaitable[None]], close: Callable[[], Awaitable[None]], initiator: bool, peer: str):
        self.initiator = initiator
        self.peer = peer
        self._send = send
        self._close = close
        self._streams: dict[int, Stream] = {}
        self._next_id = 1 if initiator else 2
        self._closed = False
        self._loop = asyncio.get_running_loop()
        self.closed: asyncio.Future[Status] = self._loop.create_future()
        self.on_open: Callable[[dict, Stream], None] | None = None
        self._outbox: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._last_recv = time.monotonic()
        self._last_send = time.monotonic()
        self._ping_seq = 0
        self._writer = asyncio.create_task(self._write_loop())
        self._keepalive = asyncio.create_task(self._keepalive_loop())

    @property
    def is_open(self) -> bool:
        return not self._closed

    def open(self, svc: str, iface: str, ver: tuple[int, int], method: str, deadline_ms: int | None = None,
             meta: dict[str, str] | None = None) -> Stream:
        sid = self._next_id
        self._next_id += 2
        stream = Stream(self, sid, "caller", deadline_ms)
        if self._closed:
            stream.on_lost(Status("unavailable", "connection closed"))
            return stream
        self._streams[sid] = stream
        self.send_frame({"t": "open", "s": sid, "svc": svc, "iface": iface, "maj": ver[0], "min": ver[1],
                         "method": method, "dl": int(deadline_ms or 0), "meta": meta})
        return stream

    def receive(self, data: bytes) -> None:
        self._last_recv = time.monotonic()
        try:
            f = decode_frame(data)
        except Exception:
            return
        t = f["t"]
        if t == "ping":
            self._enqueue({"t": "pong", "n": f.get("n", 0)})
            return
        if t in ("pong", "hello", "ack"):
            return
        sid = f.get("s")
        if not isinstance(sid, int):
            return
        if t == "open":
            self._accept_open(f)
            return
        stream = self._streams.get(sid)
        if stream is None:
            return
        if t == "msg":
            stream.on_msg(f.get("b"))
        elif t == "half":
            stream.on_half()
        elif t == "close":
            stream.on_close(Status(f.get("code", "internal"), f.get("msg"), f.get("retry")))
        elif t == "cancel":
            stream.on_cancel(f.get("reason", ""))
        elif t == "credit":
            stream.on_credit(int(f.get("n", 0)))

    def lost(self, reason: str = "connection lost") -> None:
        if self._closed:
            return
        self._closed = True
        status = Status("unavailable", reason)
        for s in list(self._streams.values()):
            s.on_lost(status)
        self._streams.clear()
        self._outbox.put_nowait(None)
        self._keepalive.cancel()
        if not self.closed.done():
            self.closed.set_result(status)

    async def aclose(self, reason: str = "closed") -> None:
        if self._closed:
            return
        self.lost(reason)
        try:
            await self._close()
        except Exception:
            pass

    # ---- StreamSink ----

    def send_frame(self, frame: dict) -> None:
        self._enqueue(frame)

    def release(self, sid: int) -> None:
        self._streams.pop(sid, None)

    # ---- internals ----

    def _accept_open(self, f: dict) -> None:
        dl = int(f.get("dl") or 0)
        stream = Stream(self, f["s"], "callee", dl if dl > 0 else None)
        self._streams[f["s"]] = stream
        if self.on_open is None:
            stream.close(Status("unavailable", "no services on this endpoint"))
            return
        self.on_open(f, stream)

    def _enqueue(self, frame: dict) -> None:
        if self._closed:
            return
        self._outbox.put_nowait(encode_frame(frame))

    async def _write_loop(self) -> None:
        while True:
            data = await self._outbox.get()
            if data is None:
                return
            try:
                await self._send(data)
                self._last_send = time.monotonic()
            except Exception:
                self.lost("send failed")
                return

    async def _keepalive_loop(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(5)
                now = time.monotonic()
                if now - self._last_recv > DEAD_AFTER_S:
                    await self.aclose("keepalive timeout")
                    return
                if now - self._last_send > PING_IDLE_S or now - self._last_recv > PING_IDLE_S:
                    self._ping_seq += 1
                    self._enqueue({"t": "ping", "n": self._ping_seq})
        except asyncio.CancelledError:
            pass
