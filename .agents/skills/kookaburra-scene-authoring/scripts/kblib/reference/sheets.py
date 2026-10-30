"""Timecoded contact sheets of a reference film: one row per bar and one cell per beat when there is a grid, an even strip of the film when there is not."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..video import footage_commands as fc
from ..video import review
from ..video import sheetlayout as sl
from . import frames as fr

BARS_PER_SHEET = 8
MAX_CELLS = 960
MIN_STRIP_MS = 1000.0
CELL_WIDTH = 480


def bar_cells(grid: Dict[str, Any], duration_ms: float) -> Dict[str, Any]:
    """One row per bar across the film: { cols, cells: [{ bar, beat, ms, frame, id }] }; a long film keeps a cell every few beats."""
    beat_ms = 60000.0 / grid["bpm"]
    per_bar = int(grid["beatsPerBar"])
    bar_ms = beat_ms * per_bar
    first = math.floor(-grid["offsetMs"] / bar_ms) + 1
    last = math.floor((duration_ms - 1 - grid["offsetMs"]) / bar_ms) + 1
    bars = max(0, last - first + 1)
    step = max(1, math.ceil(bars * per_bar / MAX_CELLS))
    beats = list(range(1, per_bar + 1, step))
    cells = []
    for bar in range(first, last + 1):
        for beat in beats:
            ms = grid["offsetMs"] + ((bar - 1) * per_bar + beat - 1) * beat_ms
            at = min(max(0.0, ms), duration_ms - 1)
            cells.append({"bar": bar, "beat": beat, "ms": at, "frame": int(at * fr.FPS / 1000.0), "id": f"{bar}.{beat}"})
    return {"cols": len(beats), "cells": cells}


def strip_cells(duration_ms: float) -> Dict[str, Any]:
    gap = max(MIN_STRIP_MS, duration_ms / (MAX_CELLS / 4))
    count = max(1, int(duration_ms // gap))
    cells = [{"ms": i * gap, "frame": int(i * gap * fr.FPS / 1000.0), "id": ""} for i in range(count)]
    return {"cols": None, "cells": cells}


def _labelled(ffmpeg: str, chunk: List[Dict[str, Any]], lay: Dict[str, Any], out_dir: Path, index: int) -> Path:
    bare = out_dir / f"sheet-{index:02d}.bare.png"
    review.compose_sheet(ffmpeg, [{"png": c["png"], "cls": "raw"} for c in chunk], bare, lay)
    made = fc.label_sheet(ffmpeg, bare, lay, [fc.cell_label(lay, c["id"], c["ms"]) for c in chunk])
    final = out_dir / f"sheet-{index:02d}.png"
    made.replace(final)
    bare.unlink()
    return final


def draw(ffmpeg: str, film: Path, grid: Optional[Dict[str, Any]], duration_ms: float, aspect: float, out_dir: Path, work: Path) -> List[Dict[str, Any]]:
    """The sheets in out_dir: [{ path (name), index, fromBar?, toBar?, fromMs, toMs }]. duration_ms is the picture's own length, which audio can outlast."""
    plan = bar_cells(grid, duration_ms) if grid else strip_cells(duration_ms)
    cells = plan["cells"]
    if not cells:
        return []
    pngs = fr.extract(ffmpeg, film, [c["frame"] for c in cells], work / "cells", "cell", CELL_WIDTH)
    cells = [dict(c, png=str(pngs[c["frame"]])) for c in cells if c["frame"] in pngs]
    out_dir.mkdir(parents=True, exist_ok=True)
    sheets: List[Dict[str, Any]] = []
    if plan["cols"]:
        cols = plan["cols"]
        per_sheet = BARS_PER_SHEET * cols
        for index, start in enumerate(range(0, len(cells), per_sheet), 1):
            chunk = cells[start:start + per_sheet]
            lay = sl.layout_one(len(chunk), aspect, cols)
            path = _labelled(ffmpeg, chunk, lay, out_dir, index)
            sheets.append({"path": path.name, "index": index, "fromBar": chunk[0]["bar"], "toBar": chunk[-1]["bar"], "fromMs": round(chunk[0]["ms"]), "toMs": round(chunk[-1]["ms"])})
        return sheets
    cursor = 0
    for lay in sl.plan_sheets(len(cells), aspect):
        chunk = cells[cursor:cursor + lay["cells"]]
        path = _labelled(ffmpeg, chunk, lay, out_dir, lay["index"])
        sheets.append({"path": path.name, "index": lay["index"], "fromMs": round(chunk[0]["ms"]), "toMs": round(chunk[-1]["ms"])})
        cursor += lay["cells"]
    return sheets
