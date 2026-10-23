"""Echo service used by the cross-language test in packages/wire/test/interop.test.ts.

Prints the listening URL on the first line of stdout, then serves until stdin closes.
"""

import asyncio
import sys

from sth_wire import ServiceHost, listen
from sth_wire.test_wire import make_host


async def main() -> None:
    token = sys.argv[1]
    host: ServiceHost = make_host([])
    server = await listen(token, lambda c, h: host.attach(c))
    print(server.url, flush=True)
    await asyncio.get_running_loop().run_in_executor(None, sys.stdin.read)
    await server.aclose()


if __name__ == "__main__":
    asyncio.run(main())
