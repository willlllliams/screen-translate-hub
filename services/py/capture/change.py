"""Change detection (spec 05 sections 2 and 4). Pure numpy, independent of the
frame source, so the replay source in tests runs exactly the same code.

Frames are numpy arrays of shape (H, W, 4), dtype uint8, BGRA. Alpha is ignored.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

MAX_SHIFTS = 8          # bit 0 is the zero shift
MIN_COMPONENT_TILES = 4  # spec 05 section 4.3
UNEXPLAINED_RATIO = 0.2
MAX_ROW_REPEATS = 8
MIN_VOTES = 3
MIN_VOTE_SHARE = 0.2

_rng = np.random.default_rng(0x5EED)
_COEFFS = (_rng.integers(1, 2**63, size=16384, dtype=np.uint64) | np.uint64(1))


@dataclass
class ChangeMap:
    base_frame_id: int
    frame_id: int
    tile: int
    cols: int
    rows: int
    shifts: list[tuple[int, int]]
    masks: np.ndarray  # (rows, cols) uint8
    changed_ratio: float
    timings_ms: dict = field(default_factory=dict)

    def to_wire(self) -> dict:
        return {
            "base_frame_id": self.base_frame_id,
            "frame_id": self.frame_id,
            "tile": self.tile,
            "cols": self.cols,
            "rows": self.rows,
            "shifts": [{"dx": int(dx), "dy": int(dy)} for dx, dy in self.shifts],
            "masks": self.masks.astype(np.uint8).tobytes(),
            "changed_ratio": float(self.changed_ratio),
        }


def _rgb(a: np.ndarray) -> np.ndarray:
    return a[:, :, :3]


def _max_channel_diff(new: np.ndarray, old: np.ndarray) -> np.ndarray:
    """(H, W) uint8: the largest absolute difference over the B, G, R channels."""
    d = cv2.absdiff(new, old)
    if d.ndim == 2:
        return d
    b, g, r = cv2.split(d)[:3]
    return cv2.max(cv2.max(b, g), r)


def pixel_changed(new: np.ndarray, old: np.ndarray, tol: int) -> np.ndarray:
    """(H, W) bool: some RGB channel differs by more than tol."""
    return _max_channel_diff(new, old) > tol


def differs(a: np.ndarray, b: np.ndarray, tol: int) -> bool:
    """Spec 05 section 2.1: different size, or any pixel beyond tolerance."""
    if a.shape != b.shape:
        return True
    _, max_val, _, _ = cv2.minMaxLoc(_max_channel_diff(a, b))
    return max_val > tol


def tile_reduce_any(mask: np.ndarray, t: int) -> np.ndarray:
    """(H, W) bool -> (rows, cols) bool: any pixel set within each tile."""
    H, W = mask.shape
    rows, cols = -(-H // t), -(-W // t)
    padded = np.zeros((rows * t, cols * t), dtype=bool)
    padded[:H, :W] = mask
    return padded.reshape(rows, t, cols, t).any(axis=(1, 3))


def tile_areas(H: int, W: int, t: int) -> np.ndarray:
    rows, cols = -(-H // t), -(-W // t)
    hs = np.full(rows, t)
    hs[-1] = H - (rows - 1) * t
    ws = np.full(cols, t)
    ws[-1] = W - (cols - 1) * t
    return np.outer(hs, ws)


def components8(mask: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    """8-connected components of a tile mask: (row0, col0, row1, col1, count), half-open."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    out = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        out.append((int(y), int(x), int(y + h), int(x + w), int(area)))
    return out


def _row_hashes(a: np.ndarray, x0: int, x1: int) -> tuple[np.ndarray, np.ndarray]:
    """Hash of each row of a[:, x0:x1] and whether the row is uniform."""
    # pack RGB into one integer per pixel
    rgb = _rgb(a)[:, x0:x1].astype(np.uint32)
    vals = (rgb[:, :, 0] | (rgb[:, :, 1] << 8) | (rgb[:, :, 2] << 16)).astype(np.uint64)
    n = vals.shape[1]
    coeffs = _COEFFS[np.arange(n) % len(_COEFFS)]
    with np.errstate(over="ignore"):
        h = (vals * coeffs[None, :]).sum(axis=1, dtype=np.uint64)
    uniform = (vals == vals[:, :1]).all(axis=1)
    return h, uniform


def estimate_shift(new: np.ndarray, old: np.ndarray, box_px: tuple[int, int, int, int], axis: str) -> int | None:
    """Spec 05 section 4.3: vote on the offset of identical rows (axis='y') or columns (axis='x').

    box_px = (y0, x0, y1, x1) in pixels: the component's bounding box.
    Returns the non-zero offset with the most votes, or None.
    """
    y0, x0, y1, x1 = box_px
    if axis == "x":
        # transpose so columns become rows
        new_t = np.ascontiguousarray(np.transpose(new, (1, 0, 2)))
        old_t = np.ascontiguousarray(np.transpose(old, (1, 0, 2)))
        return estimate_shift(new_t, old_t, (x0, y0, x1, y1), "y")
    if x1 - x0 < 2:
        return None
    old_h, old_uniform = _row_hashes(old, x0, x1)
    new_h, new_uniform = _row_hashes(new[y0:y1], x0, x1)
    index: dict[int, list[int]] = {}
    for y, hv in enumerate(old_h.tolist()):
        if old_uniform[y]:
            continue
        index.setdefault(hv, []).append(y)
    votes: dict[int, int] = {}
    participating = 0
    for i, hv in enumerate(new_h.tolist()):
        if new_uniform[i]:
            continue
        rows = index.get(hv)
        if not rows or len(rows) > MAX_ROW_REPEATS:
            continue
        participating += 1
        y = y0 + i
        for yy in rows:
            d = y - yy
            if d != 0:
                votes[d] = votes.get(d, 0) + 1
    if not votes:
        return None
    d, n = max(votes.items(), key=lambda kv: kv[1])
    if n < MIN_VOTES or n < MIN_VOTE_SHARE * participating:
        return None
    return d


def verify_shift(new: np.ndarray, old: np.ndarray, tol: int, t: int, shift: tuple[int, int],
                 tile_box: tuple[int, int, int, int]) -> np.ndarray:
    """Spec 05 section 4.4: per tile in tile_box (row0, col0, row1, col1), whether every pixel
    (x, y) satisfies |N(x, y) - O(x - dx, y - dy)| <= tol with the source inside O."""
    H, W = new.shape[:2]
    r0, c0, r1, c1 = tile_box
    Y0, X0 = r0 * t, c0 * t
    Y1, X1 = min(r1 * t, H), min(c1 * t, W)
    dx, dy = shift
    # source coordinates
    sy0, sy1, sx0, sx1 = Y0 - dy, Y1 - dy, X0 - dx, X1 - dx
    bad = np.ones((Y1 - Y0, X1 - X0), dtype=bool)
    # overlap of source rect with old frame
    oy0, oy1 = max(sy0, 0), min(sy1, H)
    ox0, ox1 = max(sx0, 0), min(sx1, W)
    if oy1 > oy0 and ox1 > ox0:
        n_part = new[oy0 + dy:oy1 + dy, ox0 + dx:ox1 + dx]
        o_part = old[oy0:oy1, ox0:ox1]
        bad[oy0 + dy - Y0:oy1 + dy - Y0, ox0 + dx - X0:ox1 + dx - X0] = pixel_changed(n_part, o_part, tol)
    rows, cols = r1 - r0, c1 - c0
    padded = np.ones((rows * t, cols * t), dtype=bool)
    padded[: Y1 - Y0, : X1 - X0] = bad
    return ~padded.reshape(rows, t, cols, t).any(axis=(1, 3))


def change_map(new: np.ndarray, old: np.ndarray | None, tol: int, t: int, frame_id: int = 0,
               base_frame_id: int = 0) -> ChangeMap | None:
    """Spec 05 section 4. Returns None when there is no old frame."""
    import time

    if old is None:
        return None
    H, W = new.shape[:2]
    rows, cols = -(-H // t), -(-W // t)
    if old.shape != new.shape:
        return ChangeMap(base_frame_id, frame_id, t, cols, rows, [(0, 0)], np.zeros((rows, cols), np.uint8), 1.0)

    timings = {}
    t0 = time.perf_counter()
    changed_px = pixel_changed(new, old, tol)
    zero_ok = ~tile_reduce_any(changed_px, t)
    timings["zero"] = (time.perf_counter() - t0) * 1000

    t1 = time.perf_counter()
    comps = components8(~zero_ok)
    timings["components"] = (time.perf_counter() - t1) * 1000

    # candidate shift -> list of tile boxes whose component proposed it
    proposals: dict[tuple[int, int], list[tuple[int, int, int, int]]] = {}
    t2 = time.perf_counter()
    for (r0, c0, r1, c1, count) in comps:
        if count < MIN_COMPONENT_TILES:
            continue
        box_px = (r0 * t, c0 * t, min(r1 * t, H), min(c1 * t, W))
        box_tiles = (max(r0 - 1, 0), max(c0 - 1, 0), min(r1 + 1, rows), min(c1 + 1, cols))
        explained = np.zeros((r1 - r0, c1 - c0), dtype=bool)
        dy = estimate_shift(new, old, box_px, "y")
        if dy is not None:
            proposals.setdefault((0, dy), []).append(box_tiles)
            ok = verify_shift(new, old, tol, t, (0, dy), (r0, c0, r1, c1))
            explained |= ok
        comp_mask = ~zero_ok[r0:r1, c0:c1]
        unexplained = (comp_mask & ~explained).sum()
        if unexplained > UNEXPLAINED_RATIO * count:
            dx = estimate_shift(new, old, box_px, "x")
            if dx is not None:
                proposals.setdefault((dx, 0), []).append(box_tiles)
    timings["estimate"] = (time.perf_counter() - t2) * 1000

    t3 = time.perf_counter()
    bits_for: dict[tuple[int, int], np.ndarray] = {}
    for shift, boxes in proposals.items():
        full = np.zeros((rows, cols), dtype=bool)
        for (r0, c0, r1, c1) in boxes:
            full[r0:r1, c0:c1] |= verify_shift(new, old, tol, t, shift, (r0, c0, r1, c1))
        bits_for[shift] = full
    ranked = sorted(bits_for.items(), key=lambda kv: int((kv[1] & ~zero_ok).sum()), reverse=True)
    ranked = [kv for kv in ranked if (kv[1] & ~zero_ok).any()][: MAX_SHIFTS - 1]
    timings["verify"] = (time.perf_counter() - t3) * 1000

    masks = zero_ok.astype(np.uint8)
    shifts: list[tuple[int, int]] = [(0, 0)]
    for k, (shift, bits) in enumerate(ranked, start=1):
        shifts.append(shift)
        masks |= (bits.astype(np.uint8) << k)
    areas = tile_areas(H, W, t)
    ratio = float(areas[masks == 0].sum() / (H * W))
    return ChangeMap(base_frame_id, frame_id, t, cols, rows, shifts, masks, ratio, timings)
