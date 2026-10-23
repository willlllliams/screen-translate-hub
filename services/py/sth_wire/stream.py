"""One call on a connection; mirrors packages/wire/src/stream.ts."""

from __future__ import annotations

import asyncio
import collections
import time
from typing import Any, AsyncIterator, Protocol

from .status import OK, RpcError, Status

INITIAL_CREDIT = 32
GRANT_BATCH = 8


class StreamSink(Protocol):
    def send_frame(self, frame: dict) -> None: ...
    def release(self, sid: int) -> None: ...


class Stream:
    def __init__(self, sink: StreamSink, sid: int, role: str, deadline_ms: int | None = None):
        self.id = sid
        self.role = role  # "caller" | "callee"
        self._sink = sink
        self._loop = asyncio.get_running_loop()
        self._queue: collections.deque[Any] = collections.deque()
        self._waiters: list[asyncio.Future] = []
        self._remote_half = False
        self._local_half = False
        self._finished: Status | None = None
        self._send_credit = INITIAL_CREDIT
        self._pending_grant = 0
        self.done: asyncio.Future[Status] = self._loop.create_future()
        self.aborted = asyncio.Event()
        self.deadline: float | None = None
        self._timer: asyncio.TimerHandle | None = None
        if deadline_ms and deadline_ms > 0:
            self.deadline = time.monotonic() + deadline_ms / 1000
            self._timer = self._loop.call_later(deadline_ms / 1000, self._on_deadline)

    @property
    def finished(self) -> bool:
        return self._finished is not None

    @property
    def status(self) -> Status | None:
        return self._finished

    def remaining_ms(self) -> int | None:
        if self.deadline is None:
            return None
        return max(0, int((self.deadline - time.monotonic()) * 1000))

    async def send(self, message: Any) -> None:
        while True:
            if self._finished:
                st = self._finished if self._finished.code != "ok" else Status("cancelled")
                raise RpcError.from_status(st)
            if self._local_half:
                raise RuntimeError(f"stream {self.id}: send after half_close")
            if self._send_credit > 0:
                break
            await self._wait()
        self._send_credit -= 1
        self._sink.send_frame({"t": "msg", "s": self.id, "b": message})

    async def recv(self) -> Any | None:
        while True:
            if self._queue:
                m = self._queue.popleft()
                self._grant()
                return m
            if self._finished:
                if self._finished.code == "ok" or self._remote_half:
                    return None
                raise RpcError.from_status(self._finished)
            if self._remote_half:
                return None
            await self._wait()

    def __aiter__(self) -> AsyncIterator[Any]:
        return self._iter()

    async def _iter(self):
        while True:
            m = await self.recv()
            if m is None:
                return
            yield m

    def half_close(self) -> None:
        if self._local_half or self._finished:
            return
        self._local_half = True
        self._sink.send_frame({"t": "half", "s": self.id})

    def cancel(self, reason: str = "cancelled") -> None:
        if self._finished:
            return
        self._sink.send_frame({"t": "cancel", "s": self.id, "reason": reason})
        self._finish(Status("cancelled", reason))

    def close(self, status: Status = OK) -> None:
        if self._finished:
            return
        frame: dict = {"t": "close", "s": self.id, "code": status.code}
        if status.message:
            frame["msg"] = status.message
        if status.retry_after_ms is not None:
            frame["retry"] = status.retry_after_ms
        self._sink.send_frame(frame)
        self._finish(status)

    # ---- called by Connection ----

    def on_msg(self, body: Any) -> None:
        if self._finished or self._remote_half:
            return
        self._queue.append(body)
        self._wake()

    def on_half(self) -> None:
        self._remote_half = True
        self._wake()

    def on_close(self, status: Status) -> None:
        self._remote_half = True
        self._finish(status)

    def on_cancel(self, reason: str) -> None:
        self._finish(Status("cancelled", reason))

    def on_credit(self, n: int) -> None:
        self._send_credit += n
        self._wake()

    def on_lost(self, status: Status) -> None:
        self._finish(status)

    # ---- internals ----

    def _on_deadline(self) -> None:
        if self._finished:
            return
        st = Status("deadline_exceeded")
        if self.role == "caller":
            self._sink.send_frame({"t": "cancel", "s": self.id, "reason": "deadline"})
            self._finish(st)
        else:
            self.close(st)

    def _grant(self) -> None:
        if self._finished or self._remote_half:
            return
        self._pending_grant += 1
        if self._pending_grant >= GRANT_BATCH or not self._queue:
            self._sink.send_frame({"t": "credit", "s": self.id, "n": self._pending_grant})
            self._pending_grant = 0

    def _finish(self, status: Status) -> None:
        if self._finished:
            return
        self._finished = status
        if self._timer:
            self._timer.cancel()
        self.aborted.set()
        self._wake()
        if not self.done.done():
            self.done.set_result(status)
        self._sink.release(self.id)

    async def _wait(self) -> None:
        fut = self._loop.create_future()
        self._waiters.append(fut)
        await fut

    def _wake(self) -> None:
        waiters, self._waiters = self._waiters, []
        for f in waiters:
            if not f.done():
                f.set_result(None)
