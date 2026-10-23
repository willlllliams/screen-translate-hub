import time
import unittest

import numpy as np

from capture.change import change_map, components8, differs

TOOLBAR_H = 120
SIDEBAR_W = 300


def _document(H: int, W: int) -> np.ndarray:
    """A tall document whose text lines have glyph-like rows (each pixel row differs)."""
    doc = np.full((H, W, 4), 255, dtype=np.uint8)
    y, line = 20, 0
    while y + 14 < H:
        rng = np.random.default_rng(1000 + line)
        x = SIDEBAR_W + 20
        while x < W - 40:
            w = min(int(rng.integers(8, 60)), W - 40 - x)
            glyph = rng.integers(0, 2, size=(14, w)).astype(bool)   # per-row stroke pattern
            block = doc[y:y + 14, x:x + w, :3]
            block[glyph] = int(rng.integers(0, 80))
            x += w + int(rng.integers(6, 14))
        y += 24
        line += 1
    return doc


def screen(H: int, W: int, doc: np.ndarray, offset: int) -> np.ndarray:
    """The document scrolled by `offset` pixels inside the content area, plus fixed chrome."""
    f = np.full((H, W, 4), 255, dtype=np.uint8)
    f[TOOLBAR_H:, :, :] = doc[offset:offset + H - TOOLBAR_H, :, :]
    f[:TOOLBAR_H, :, :3] = 230
    f[:, :SIDEBAR_W, :3] = 245
    return f


class ChangeTest(unittest.TestCase):
    def test_differs(self):
        doc = _document(400, 400)
        a = screen(200, 400, doc, 0)
        b = a.copy()
        self.assertFalse(differs(a, b, 8))
        b[10, 10, 0] = 250
        a[10, 10, 0] = 245
        self.assertFalse(differs(a, b, 8))
        b[10, 10, 0] = 100
        self.assertTrue(differs(a, b, 8))
        self.assertTrue(differs(a, a[:100], 8))

    def test_identical_frames(self):
        doc = _document(600, 500)
        a = screen(300, 500, doc, 0)
        m = change_map(a, a.copy(), 8, 16)
        self.assertEqual(m.shifts, [(0, 0)])
        self.assertTrue((m.masks & 1).all())
        self.assertEqual(m.changed_ratio, 0.0)

    def test_size_change(self):
        doc = _document(600, 500)
        a = screen(300, 500, doc, 0)
        m = change_map(a[:200], a, 8, 16)
        self.assertEqual(m.changed_ratio, 1.0)
        self.assertFalse(m.masks.any())

    def test_scroll_with_toolbar_change_and_noise(self):
        """The setup of spec 05 section 5 at 1080p: scroll by 37 px, one glyph changes, tolerance-level noise."""
        H, W = 1080, 1920
        doc = _document(H * 2, W)
        old = screen(H, W, doc, 0)
        new = screen(H, W, doc, 37)
        new[50:64, 700:710, :3] = 0                    # a glyph changes in the toolbar
        rng = np.random.default_rng(7)
        ys = rng.integers(0, H, 2000)
        xs = rng.integers(0, SIDEBAR_W, 2000)
        new[ys, xs, 1] = new[ys, xs, 1] - 3            # within tolerance, in the sidebar
        t0 = time.perf_counter()
        m = change_map(new, old, 8, 16, frame_id=2, base_frame_id=1)
        elapsed = (time.perf_counter() - t0) * 1000
        self.assertIn((0, -37), m.shifts)
        self.assertLess(m.changed_ratio, 0.05)
        self.assertEqual(m.masks[50 // 16, 700 // 16], 0)          # toolbar glyph tile changed
        k = m.shifts.index((0, -37))
        self.assertTrue(m.masks[500 // 16, 1000 // 16] >> k & 1)   # content tile explained by the scroll
        self.assertTrue(m.masks[500 // 16, 100 // 16] & 1)          # sidebar noise is within tolerance
        print(f"\n1080p scroll change map: {elapsed:.1f} ms, ratio {m.changed_ratio:.4f}, "
              f"timings {({k: round(v, 1) for k, v in m.timings_ms.items()})}")

    def test_components(self):
        mask = np.zeros((10, 10), dtype=bool)
        mask[1:3, 1:3] = True
        mask[3, 3] = True  # diagonal neighbour joins
        mask[8, 8] = True
        comps = sorted(components8(mask))
        self.assertEqual(len(comps), 2)
        self.assertEqual(comps[0][4], 5)


if __name__ == "__main__":
    unittest.main()
