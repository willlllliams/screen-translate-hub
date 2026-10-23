import unittest

import cv2
import numpy as np

from ocr.engine import order_quad
from ocr.service import build
from sth_service import Boot
from sth_wire import Peer, connect, listen

TOKEN = "ocr-test"


def text_image() -> np.ndarray:
    img = np.full((120, 640, 4), 255, dtype=np.uint8)
    cv2.putText(img, "Hello screen translation", (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0, 255), 2)
    cv2.putText(img, "second line of text", (20, 95), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0, 255), 2)
    return img


class OcrTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        host = build(Boot(name="ocr.rapidocr", token=TOKEN))
        self.server = await listen(TOKEN, lambda c, h: host.attach(c))
        self.conn = await connect(self.server.url, TOKEN, "test")
        self.peer = Peer(self.conn, "ocr.rapidocr")

    async def asyncTearDown(self):
        await self.conn.aclose()
        await self.server.aclose()

    async def test_recognize_region(self):
        img = text_image()
        req = {
            "run_id": "r", "batch_seq": 1, "languages": ["auto"],
            "regions": [{"image": {"format": "raw_bgra8", "width": 640, "height": 120, "data": img.tobytes()},
                         "rect": {"x": 100, "y": 200, "w": 640, "h": 120}, "scale": 1.0}],
        }
        res = await self.peer.unary("ocr", "Recognize", req, deadline_ms=30000)
        blocks = res["regions"][0]["blocks"]
        texts = " ".join(b["text"] for b in blocks).lower()
        self.assertIn("hello", texts)
        self.assertIn("second", texts)
        q = blocks[0]["quad"]
        self.assertLessEqual(q[0]["x"] + q[0]["y"], q[2]["x"] + q[2]["y"])

    async def test_unsupported_language(self):
        from sth_wire import RpcError

        with self.assertRaises(RpcError) as cm:
            await self.peer.unary("ocr", "Recognize", {"languages": ["ar"], "regions": []})
        self.assertEqual(cm.exception.code, "invalid_argument")

    async def test_image_size_mismatch(self):
        from sth_wire import RpcError

        bad = {"run_id": "r", "batch_seq": 1, "languages": ["auto"],
               "regions": [{"image": {"format": "raw_bgra8", "width": 100, "height": 100, "data": bytes(4)},
                            "rect": {"x": 0, "y": 0, "w": 100, "h": 100}, "scale": 1.0}]}
        with self.assertRaises(RpcError) as cm:
            await self.peer.unary("ocr", "Recognize", bad, deadline_ms=30000)
        self.assertEqual(cm.exception.code, "invalid_argument")

    def test_order_quad(self):
        q = order_quad([(10, 20), (0, 20), (10, 0), (0, 0)])
        self.assertEqual([(p["x"], p["y"]) for p in q], [(0, 0), (10, 0), (10, 20), (0, 20)])


if __name__ == "__main__":
    unittest.main()
