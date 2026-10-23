"""WebSocket transport and handshake; mirrors packages/wire/src/ws.ts."""

from __future__ import annotations

import asyncio
import hmac
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from websockets.asyncio.client import connect as ws_connect
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from .connection import Connection, decode_frame, encode_frame
from .status import RpcError

SUBPROTOCOL = "sth.v1-lite"
MAX_PAYLOAD = 64 * 1024 * 1024
PROTOCOL_VERSION = (1, 0)


@dataclass
class WireServer:
    port: int
    url: str
    _server: Any

    async def aclose(self) -> None:
        self._server.close()
        await self._server.wait_closed()


async def _pump(ws: Any, conn: Connection) -> None:
    try:
        async for data in ws:
            if isinstance(data, (bytes, bytearray)):
                conn.receive(bytes(data))
    except ConnectionClosed:
        pass
    finally:
        conn.lost("peer closed")


async def listen(token: str, on_connection: Callable[[Connection, dict], None], host: str = "127.0.0.1", port: int = 0) -> WireServer:
    async def handler(ws: ServerConnection) -> None:
        if ws.request is not None and ws.request.headers.get("Origin"):
            await ws.close(1008, "origin not allowed")
            return
        try:
            first = await asyncio.wait_for(ws.recv(), timeout=5)
            hello = decode_frame(first if isinstance(first, bytes) else first.encode())
        except Exception:
            await ws.close(1002, "bad handshake")
            return
        if hello.get("t") != "hello":
            await ws.close(1002, "expected hello")
            return
        ver = hello.get("ver") or [0, 0]
        if ver[0] != PROTOCOL_VERSION[0]:
            await ws.send(encode_frame({"t": "ack", "ok": False, "code": "PROTOCOL_INCOMPATIBLE"}))
            await ws.close(1008, "protocol")
            return
        given = hello.get("token") or ""
        if not hmac.compare_digest(str(given).encode(), token.encode()):
            await ws.send(encode_frame({"t": "ack", "ok": False, "code": "INVALID_CREDENTIAL"}))
            await ws.close(1008, "credential")
            return
        await ws.send(encode_frame({"t": "ack", "ok": True}))
        conn = Connection(ws.send, ws.close, initiator=False, peer=str(hello.get("peer", "")))
        on_connection(conn, hello)
        await _pump(ws, conn)

    server = await serve(handler, host, port, subprotocols=[SUBPROTOCOL], max_size=MAX_PAYLOAD, compression=None,
                         ping_interval=None)
    actual = server.sockets[0].getsockname()[1]
    return WireServer(actual, f"ws://{host}:{actual}", server)


async def connect(url: str, token: str, peer: str, kind: str = "local", timeout: float = 5.0) -> Connection:
    try:
        ws = await asyncio.wait_for(
            ws_connect(url, subprotocols=[SUBPROTOCOL], max_size=MAX_PAYLOAD, compression=None, ping_interval=None),
            timeout=timeout,
        )
    except Exception as e:  # noqa: BLE001
        raise RpcError("unavailable", f"{url}: {e}") from e
    await ws.send(encode_frame({"t": "hello", "ver": list(PROTOCOL_VERSION), "kind": kind, "peer": peer, "token": token}))
    try:
        ack = decode_frame(await asyncio.wait_for(ws.recv(), timeout=timeout))
    except Exception as e:  # noqa: BLE001
        await ws.close()
        raise RpcError("unavailable", "bad handshake reply") from e
    if not ack.get("ok"):
        await ws.close()
        raise RpcError("unauthenticated", str(ack.get("code")))
    conn = Connection(ws.send, ws.close, initiator=True, peer=url)
    asyncio.create_task(_pump(ws, conn))
    return conn
