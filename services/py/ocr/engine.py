"""RapidOCR engine wrapper: converts results to unified text blocks (spec 02 section 3.1)."""

from __future__ import annotations

import logging
import math
import threading

import numpy as np

log = logging.getLogger("sth")


def order_quad(points) -> list[dict]:
    """Clockwise on screen starting at the smallest x + y; ties prefer smaller y (spec 02 section 1.2)."""
    pts = [(float(p[0]), float(p[1])) for p in points]
    cx = sum(p[0] for p in pts) / 4
    cy = sum(p[1] for p in pts) / 4
    pts.sort(key=lambda p: math.atan2(p[1] - cy, p[0] - cx))
    start = min(range(4), key=lambda i: (pts[i][0] + pts[i][1], pts[i][1]))
    return [{"x": pts[(start + k) % 4][0], "y": pts[(start + k) % 4][1]} for k in range(4)]


def bgra_to_rgb(img: np.ndarray) -> np.ndarray:
    return np.ascontiguousarray(img[:, :, 2::-1]) if img.shape[2] >= 3 else img


class RapidOcrEngine:
    """PP-OCRv6 small via RapidOCR on onnxruntime CPU. Thread-safe by serializing calls."""

    name = "rapidocr"

    def __init__(self, use_dml: bool = False):
        from rapidocr import RapidOCR

        params = {
            "Global.use_cls": False,            # screen text is upright
            "Global.log_level": "warning",
            "EngineConfig.onnxruntime.use_dml": use_dml,
        }
        self._ocr = RapidOCR(params=params)
        self._lock = threading.Lock()
        import rapidocr

        self.version = getattr(rapidocr, "__version__", "3")

    def recognize(self, rgb: np.ndarray) -> list[dict]:
        with self._lock:
            out = self._ocr(rgb)
        blocks: list[dict] = []
        if out is None or getattr(out, "boxes", None) is None or out.txts is None:
            return blocks
        for i, (box, txt, score) in enumerate(zip(out.boxes, out.txts, out.scores)):
            text = str(txt).strip()
            if not text:
                continue
            blocks.append({"block_id": i + 1, "text": text, "quad": order_quad(box), "confidence": float(score)})
        return blocks
