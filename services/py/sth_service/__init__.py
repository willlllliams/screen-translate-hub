"""Common startup for Python service processes (spec 18 section 2.1).

The desktop agent starts a service with one JSON line on stdin:
  {"agent": "ws://127.0.0.1:port", "token": "...", "name": "ocr.rapidocr", "config": {...}}
The service listens on its own loopback port, registers with agent.Register and
exits when the agent connection goes away.

For tests a service can run standalone:  python -m ocr.service --standalone TOKEN
which prints the endpoint URL and serves until stdin closes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from sth_wire import Peer, RpcError, ServiceHost, connect, listen

log = logging.getLogger("sth")


@dataclass
class Boot:
    name: str
    token: str
    agent: str | None = None
    config: dict[str, Any] = field(default_factory=dict)


def setup_logging(name: str) -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                        format=f"%(asctime)s {name} %(levelname)s %(message)s")


def read_boot(default_name: str) -> Boot:
    if len(sys.argv) >= 3 and sys.argv[1] == "--standalone":
        cfg = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
        return Boot(name=default_name, token=sys.argv[2], config=cfg)
    line = sys.stdin.readline()
    data = json.loads(line)
    return Boot(name=data.get("name", default_name), token=data["token"], agent=data.get("agent"),
                config=data.get("config") or {})


async def _stdin_closed() -> None:
    await asyncio.get_running_loop().run_in_executor(None, sys.stdin.read)


async def serve(boot: Boot, host: ServiceHost, manifest: dict[str, Any],
                on_settings: Callable[[dict], None] | None = None) -> None:
    """Listen, register with the agent (if any) and run until the agent or stdin goes away."""
    server = await listen(boot.token, lambda c, h: host.attach(c))
    log.info("listening on %s", server.url)
    if boot.agent is None:
        print(server.url, flush=True)
        await _stdin_closed()
        await server.aclose()
        return
    conn = await connect(boot.agent, boot.token, peer=boot.name)
    reg = Peer(conn, "agent").open("agent", "Register")
    await reg.send({"manifest": manifest, "endpoint": server.url})
    first = await reg.recv()
    result = (first or {}).get("result") or {}
    if not result.get("accepted"):
        raise RpcError("permission_denied", f"registration refused: {result.get('reason')}")
    log.info("registered as %s", boot.name)

    async def settings_loop() -> None:
        async for m in reg:
            if on_settings and isinstance(m, dict) and "settings" in m:
                on_settings(m["settings"])

    tasks = [asyncio.create_task(settings_loop()), asyncio.ensure_future(conn.closed), asyncio.create_task(_stdin_closed())]
    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in tasks:
        t.cancel()
    log.info("agent connection gone, exiting")
    await server.aclose()


def run(main: Callable[[], Awaitable[None]]) -> None:
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
