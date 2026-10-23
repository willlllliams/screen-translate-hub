"""ocr service: ocr.Recognize (spec 09 section 11)."""

from __future__ import annotations

import asyncio
import logging

import cv2
import numpy as np

from sth_service import Boot, read_boot, run, serve, setup_logging
from sth_wire import RpcError, ServiceHost, Stream

from .engine import RapidOcrEngine, bgra_to_rgb

log = logging.getLogger("sth")

LANGUAGES = ["zh-Hans", "zh-Hant", "en", "ja"]


def manifest(name: str) -> dict:
    return {
        "name": name,
        "display_name": "RapidOCR (PP-OCRv6 small)",
        "interfaces": [{"name": "ocr", "major": 1, "minor": 0}],
        "engine": {"id": "rapidocr", "name": "RapidOCR PP-OCRv6 small", "version": "3"},
        "languages": {"ocr": LANGUAGES + ["auto"]},
        "platform": {"os": "windows", "arch": "x86_64", "accelerators": ["cpu"]},
        "limits": {"max_concurrency": 1, "requests_per_second": 20, "burst": 5},
    }


def decode_image(img: dict) -> np.ndarray:
    fmt = img.get("format", "raw_bgra8")
    data = img["data"]
    if fmt == "raw_bgra8":
        width, height = int(img["width"]), int(img["height"])
        if width <= 0 or height <= 0 or len(data) != width * height * 4:
            raise RpcError("invalid_argument", f"raw_bgra8 image of {width}x{height} needs {width * height * 4} bytes, got {len(data)}")
        return np.frombuffer(data, dtype=np.uint8).reshape(height, width, 4)
    arr = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if arr is None:
        raise RpcError("invalid_argument", f"cannot decode {fmt}")
    if arr.ndim == 2:
        arr = cv2.cvtColor(arr, cv2.COLOR_GRAY2BGRA)
    elif arr.shape[2] == 3:
        arr = cv2.cvtColor(arr, cv2.COLOR_BGR2BGRA)
    return arr


def build(boot: Boot) -> ServiceHost:
    host = ServiceHost()
    engine = RapidOcrEngine(use_dml=bool(boot.config.get("use_dml")))

    async def recognize(stream: Stream, info) -> None:
        req = await stream.recv() or {}
        langs = [l for l in req.get("languages") or ["auto"]]
        unsupported = [l for l in langs if l != "auto" and l.split("-")[0] not in {x.split("-")[0] for x in LANGUAGES}]
        if unsupported:
            raise RpcError("invalid_argument", f"language not supported: {', '.join(unsupported)}")
        regions = []
        for reg in req.get("regions") or []:
            rgb = bgra_to_rgb(decode_image(reg["image"]))
            blocks = await asyncio.to_thread(engine.recognize, rgb)
            regions.append({"rect": reg["rect"], "scale": float(reg.get("scale", 1.0)), "blocks": blocks,
                            "engine": f"rapidocr {engine.version}"})
        await stream.send({"run_id": req.get("run_id", ""), "batch_seq": req.get("batch_seq", 0), "regions": regions})

    host.implement(boot.name, "ocr", (1, 0), {"Recognize": recognize})
    return host


async def main() -> None:
    setup_logging("ocr")
    boot = read_boot("ocr.rapidocr")
    await serve(boot, build(boot), manifest(boot.name))


if __name__ == "__main__":
    run(main)
