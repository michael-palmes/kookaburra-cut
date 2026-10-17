"""Sizes for frames and contact sheets that Claude's Read takes in whole; pure."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

MAX_LONG = 1568
MAX_PIXELS = 1_150_000
MIN_CELL_SHORT = 160
MARGIN = 8
PADDING = 6
BAR = 6
BG = "0x1C1C1E"
MAX_CELLS = 48


def even_floor(v: float) -> int:
    return max(2, int(math.floor(v / 2.0)) * 2)


def frame_size(width: int, height: int, long_edge: int = MAX_LONG, grid: bool = False, upscale: bool = False) -> Tuple[int, int]:
    """A single frame scaled so its long edge is at most long_edge; a gridded frame snaps to multiples of 20 so tenths are whole pixels."""
    if width <= 0 or height <= 0:
        return (long_edge, long_edge)
    k = long_edge / float(max(width, height))
    if not upscale:
        k = min(1.0, k)
    w, h = width * k, height * k
    if grid:
        step = 20
        w2, h2 = max(step, int(round(w / step)) * step), max(step, int(round(h / step)) * step)
        while max(w2, h2) > long_edge:
            w2, h2 = max(step, w2 - step), max(step, h2 - step)
        return (w2, h2)
    return (even_floor(w), even_floor(h))


def _sheet_dims(cols: int, rows: int, cw: int, ch: int) -> Tuple[int, int]:
    return (2 * MARGIN + cols * cw + (cols - 1) * PADDING, 2 * MARGIN + rows * (ch + BAR) + (rows - 1) * PADDING)


def _best_cell(cols: int, rows: int, aspect: float) -> Tuple[int, int]:
    """The largest even cell (aspect = w/h) whose sheet keeps both edges and the pixel budget."""
    avail_w = (MAX_LONG - 2 * MARGIN - (cols - 1) * PADDING) / cols
    avail_h = (MAX_LONG - 2 * MARGIN - (rows - 1) * PADDING) / rows - BAR
    cw = min(avail_w, avail_h * aspect)
    while cw >= 2:
        w, h = even_floor(cw), even_floor(cw / aspect)
        sw, sh = _sheet_dims(cols, rows, w, h)
        if sw <= MAX_LONG and sh <= MAX_LONG and sw * sh <= MAX_PIXELS:
            return (w, h)
        cw *= 0.98
    return (2, 2)


def layout_one(count: int, aspect: float, cols: Optional[int] = None, pairs: bool = False) -> Dict[str, Any]:
    options = [cols] if cols else [c for c in range(1, count + 1) if not pairs or c % 2 == 0 or count < 2]
    best: Optional[Dict[str, Any]] = None
    for c in options:
        c = max(1, min(c, count))
        r = int(math.ceil(count / c))
        cw, ch = _best_cell(c, r, aspect)
        w, h = _sheet_dims(c, r, cw, ch)
        cand = {"cols": c, "rows": r, "cellW": cw, "cellH": ch, "width": w, "height": h, "cells": count}
        if best is None or cw * ch > best["cellW"] * best["cellH"]:
            best = cand
    assert best is not None
    return best


def plan_sheets(count: int, aspect: float, cols: Optional[int] = None, pairs: bool = False) -> List[Dict[str, Any]]:
    """The fewest balanced sheets whose cells keep MIN_CELL_SHORT; pairs keeps before/after cells side by side."""
    if count <= 0:
        return []
    for n_sheets in range(1, count + 1):
        per = int(math.ceil(count / n_sheets))
        if pairs and per % 2:
            per += 1
        lay = layout_one(per, aspect, cols, pairs)
        if min(lay["cellW"], lay["cellH"]) >= MIN_CELL_SHORT or per == 1:
            out = []
            left = count
            for i in range(n_sheets):
                take = min(per, left)
                if take <= 0:
                    break
                out.append(dict(layout_one(take, aspect, cols, pairs), index=i + 1))
                left -= take
            return out
    return [dict(layout_one(1, aspect, cols), index=1)]
