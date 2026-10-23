import asyncio
import unittest

from sth_wire import Peer, RpcError, ServiceHost, connect, listen

TOKEN = "py-test-token"


def make_host(cancelled: list) -> ServiceHost:
    host = ServiceHost()

    async def unary(s, info):
        req = await s.recv()
        await s.send({"text": req["text"].upper(), "blob": bytes(req.get("blob", b""))[::-1]})

    async def count(s, info):
        req = await s.recv()
        for i in range(1, req["n"] + 1):
            await s.send(i)

    async def slow(s, info):
        await s.recv()
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled.append(s.status.code if s.status else "?")
            raise

    async def fail(s, info):
        await s.recv()
        raise RpcError("engine_error", "boom")

    host.implement("echo", "echo", (1, 2), {"Unary": unary, "Count": count, "Slow": slow, "Fail": fail})
    return host


class WireTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.cancelled: list = []
        host = make_host(self.cancelled)
        self.server = await listen(TOKEN, lambda c, h: host.attach(c))
        self.conn = await connect(self.server.url, TOKEN, "test")
        self.peer = Peer(self.conn, "echo")

    async def asyncTearDown(self):
        await self.conn.aclose()
        await self.server.aclose()

    async def test_unary_with_bytes(self):
        r = await self.peer.unary("echo", "Unary", {"text": "hi", "blob": b"\x01\x02\x03"})
        self.assertEqual(r["text"], "HI")
        self.assertEqual(r["blob"], b"\x03\x02\x01")

    async def test_server_stream_beyond_window(self):
        got = [v async for v in self.peer.server_stream("echo", "Count", {"n": 100})]
        self.assertEqual(got, list(range(1, 101)))

    async def test_deadline(self):
        with self.assertRaises(RpcError) as cm:
            await self.peer.unary("echo", "Slow", {}, deadline_ms=50)
        self.assertEqual(cm.exception.code, "deadline_exceeded")
        await asyncio.sleep(0.05)
        self.assertTrue(self.cancelled)

    async def test_error_and_version(self):
        with self.assertRaises(RpcError) as cm:
            await self.peer.unary("echo", "Fail", {})
        self.assertEqual(cm.exception.code, "engine_error")
        with self.assertRaises(RpcError) as cm:
            await self.peer.unary("echo", "Unary", {"text": ""}, version=(1, 3))
        self.assertEqual(cm.exception.code, "incompatible")

    async def test_bad_token(self):
        with self.assertRaises(RpcError):
            await connect(self.server.url, "nope", "x")


if __name__ == "__main__":
    unittest.main()
