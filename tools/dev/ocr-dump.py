"""Run the bundled OCR engine on an image file and print an OcrResult as JSON.

    python tools/dev/ocr-dump.py shot.png [x y w h] > ocr.json
"""

import json
import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "py"))
from ocr.engine import RapidOcrEngine  # noqa: E402

img = cv2.imread(sys.argv[1], cv2.IMREAD_COLOR)
x, y, w, h = (map(int, sys.argv[2:6]) if len(sys.argv) >= 6 else (0, 0, img.shape[1], img.shape[0]))
crop = img[y : y + h, x : x + w]
blocks = RapidOcrEngine().recognize(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
region = {"rect": {"x": x, "y": y, "w": w, "h": h}, "scale": 1, "blocks": blocks, "engine": "rapidocr"}
json.dump({"run_id": "dump", "batch_seq": 1, "regions": [region]}, sys.stdout, ensure_ascii=False)
