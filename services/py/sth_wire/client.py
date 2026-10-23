"""Caller-side helpers; mirrors packages/wire/src/client.ts."""

from __future__ import annotations

from typing import Any, AsyncIterator

from .connection import Connection
from .status import RpcError
from .stream import Stream


class Peer:
    def __init__(self, conn: Connection, svc: str):
        self.conn = conn
        self.svc = svc

    def open(self, iface: str, method: str, version: tuple[int, int] = (1, 0), deadline_ms: int | None = None,
             meta: dict[str, str] | None = None) -> Stream:
        return self.conn.open(self.svc, iface, version, method, deadline_ms, meta)

    async def unary(self, iface: str, method: str, req: Any, **kw: Any) -> Any:
        s = self.open(iface, method, **kw)
        await s.send(req)
        s.half_close()
        reply = await s.recv()
        status = await s.done
        if status.code != "ok":
            raise RpcError.from_status(status)
        if reply is None:
            raise RpcError("internal", f"{iface}.{method} returned no reply")
        return reply

    async def server_stream(self, iface: str, method: str, req: Any, **kw: Any) -> AsyncIterator[Any]:
        s = self.open(iface, method, **kw)
        complete = False
        try:
            await s.send(req)
            s.half_close()
            while True:
                m = await s.recv()
                if m is None:
                    break
                yield m
            status = await s.done
            if status.code != "ok":
                raise RpcError.from_status(status)
            complete = True
        finally:
            if not complete:
                s.cancel("caller stopped")
