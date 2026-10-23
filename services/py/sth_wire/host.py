"""Service dispatch; mirrors packages/wire/src/host.ts."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .connection import Connection
from .status import OK, Status, status_of
from .stream import Stream

Handler = Callable[[Stream, "OpenInfo"], Awaitable[None]]


@dataclass
class OpenInfo:
    svc: str
    iface: str
    maj: int
    min: int
    method: str
    meta: dict[str, str] = field(default_factory=dict)
    conn: Connection | None = None


def version_satisfies(impl: tuple[int, int], required: tuple[int, int]) -> bool:
    return impl[0] == required[0] and impl[1] >= required[1]


class ServiceHost:
    def __init__(self) -> None:
        self._services: dict[str, dict[str, tuple[tuple[int, int], dict[str, Handler]]]] = {}
        self._tasks: set[asyncio.Task] = set()

    def implement(self, svc: str, iface: str, ver: tuple[int, int], methods: dict[str, Handler]) -> "ServiceHost":
        self._services.setdefault(svc, {})[iface] = (ver, methods)
        return self

    def names(self) -> list[str]:
        return list(self._services)

    def interfaces_of(self, svc: str) -> list[dict[str, Any]]:
        return [{"name": n, "major": v[0], "minor": v[1]} for n, (v, _) in self._services.get(svc, {}).items()]

    def attach(self, conn: Connection) -> None:
        def on_open(frame: dict, stream: Stream) -> None:
            task = asyncio.create_task(self._dispatch(conn, frame, stream))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

        conn.on_open = on_open

    async def _dispatch(self, conn: Connection, f: dict, stream: Stream) -> None:
        ifaces = self._services.get(f.get("svc", ""))
        if ifaces is None:
            stream.close(Status("unavailable", f"no service {f.get('svc')}"))
            return
        impl = ifaces.get(f.get("iface", ""))
        if impl is None:
            stream.close(Status("unimplemented", f"{f.get('svc')} does not implement {f.get('iface')}"))
            return
        ver, methods = impl
        if not version_satisfies(ver, (int(f.get("maj", 0)), int(f.get("min", 0)))):
            stream.close(Status("incompatible", f"{f.get('iface')} {ver[0]}.{ver[1]}"))
            return
        handler = methods.get(f.get("method", ""))
        if handler is None:
            stream.close(Status("unimplemented", f"{f.get('iface')}.{f.get('method')}"))
            return
        info = OpenInfo(f["svc"], f["iface"], int(f["maj"]), int(f["min"]), f["method"], f.get("meta") or {}, conn)
        work = asyncio.create_task(handler(stream, info))
        abort = asyncio.create_task(stream.aborted.wait())
        done, _ = await asyncio.wait({work, abort}, return_when=asyncio.FIRST_COMPLETED)
        if work in done:
            abort.cancel()
            err = work.exception()
            stream.close(OK if err is None else status_of(err))
        else:
            # Cancelled, deadline or connection loss: stop the handler.
            work.cancel()
            try:
                await work
            except BaseException:
                pass
