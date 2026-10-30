"""Contact sheets to Read: thumbnails on the surface each picture is made for, labelled, drawn in plain Python so a look at
an imported folder or a brand's icons needs nothing but sips. They land in .kb/thumbs/, which git and packs never see."""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import imagefile
from .conform import UNTRUSTED_INPUT
from .video import labels

THUMBS = "thumbs"
KEEP_FOLDERS = 20
SHEET_EDGE = 1568
MAX_SHEETS = 6
GAP = 8
LABEL_H = 13
LIGHT = (240, 240, 238, 255)
DARK = (22, 22, 24, 255)
MID = (58, 58, 62, 255)
SHEET_BG = (36, 36, 38, 255)
UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")
VIDEO_TIMEOUT_S = 60


def thumbs_root(project: Any) -> Path:
    from . import lock as lockmod

    return lockmod.kb_dir(project) / THUMBS


def new_folder(project: Any, tag: str) -> Path:
    root = thumbs_root(project)
    base = time.strftime("%Y%m%d-%H%M%S") + "-" + (UNSAFE.sub("-", tag).strip("-")[:40] or "sheet")
    folder, n = root / base, 2
    while folder.exists():
        folder, n = root / f"{base}+{n}", n + 1
    folder.mkdir(parents=True)
    _prune(root, folder)
    return folder


def _prune(root: Path, keep: Path) -> None:
    try:
        folders = sorted(p for p in root.iterdir() if p.is_dir())
    except OSError:
        return
    for p in [p for p in folders if p != keep][: max(0, len(folders) - KEEP_FOLDERS)]:
        shutil.rmtree(p, ignore_errors=True)


def video_frame(ffmpeg: Optional[str], src: Path, out: Path, box: Tuple[int, int]) -> bool:
    """A representative early frame as a PNG."""
    if not ffmpeg:
        return False
    vf = f"thumbnail=30,scale=w={box[0]}:h={box[1]}:force_original_aspect_ratio=decrease"
    argv = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", *UNTRUSTED_INPUT, "-i", str(src), "-map", "0:v:0", "-vf", vf, "-frames:v", "1", "-y", str(out)]
    try:
        return subprocess.run(argv, capture_output=True, timeout=VIDEO_TIMEOUT_S, stdin=subprocess.DEVNULL).returncode == 0 and out.is_file()
    except (OSError, subprocess.TimeoutExpired):
        return False


def _background(surface: Optional[str]) -> Tuple[int, int, int, int]:
    return DARK if surface == "on-dark" else LIGHT


def _blit(canvas: labels.Canvas, x0: int, y0: int, box: Tuple[int, int], width: int, height: int, rgba: bytes, bg: Sequence[int]) -> None:
    """The picture centred in box over bg, scaled down by nearest neighbour when a thumbnail still came back larger."""
    k = min(box[0] / width, box[1] / height, 1.0)
    dw, dh = max(1, int(width * k)), max(1, int(height * k))
    ox, oy = x0 + (box[0] - dw) // 2, y0 + (box[1] - dh) // 2
    br, bg_g, bb = bg[0], bg[1], bg[2]
    stride = canvas.width * 4
    px = canvas.px
    for y in range(dh):
        sy = y * height // dh
        at = (oy + y) * stride + ox * 4
        row = sy * width * 4
        for x in range(dw):
            s = row + (x * width // dw) * 4
            a = rgba[s + 3]
            if a == 255:
                px[at], px[at + 1], px[at + 2] = rgba[s], rgba[s + 1], rgba[s + 2]
            elif a:
                inv = 255 - a
                px[at] = (rgba[s] * a + br * inv) // 255
                px[at + 1] = (rgba[s + 1] * a + bg_g * inv) // 255
                px[at + 2] = (rgba[s + 2] * a + bb * inv) // 255
            at += 4


def _fit_label(text: str, width: int) -> str:
    room = max(4, (width - 4) // labels.ADVANCE)
    return text if len(text) <= room else "..." + text[-(room - 3):]


def write_sheets(cells: List[Dict[str, Any]], folder: Path, box: Tuple[int, int], name: str = "sheet") -> Tuple[List[Path], int]:
    """cells: { label, image?: Path, rgba?: (w, h, bytes), surface? }. Returns the sheets written and how many cells fitted."""
    cols = max(1, (SHEET_EDGE - GAP) // (box[0] + GAP))
    rows = max(1, (SHEET_EDGE - GAP) // (box[1] + LABEL_H + GAP))
    per_sheet = cols * rows
    sheets: List[Path] = []
    fitted = min(len(cells), per_sheet * MAX_SHEETS)
    with tempfile.TemporaryDirectory(prefix="kb-sheet-") as tmp:
        for page, start in enumerate(range(0, fitted, per_sheet)):
            batch = cells[start:start + per_sheet]
            used_rows = (len(batch) + cols - 1) // cols
            used_cols = min(cols, len(batch))
            canvas = labels.Canvas(GAP + used_cols * (box[0] + GAP), GAP + used_rows * (box[1] + LABEL_H + GAP))
            canvas.fill(0, 0, canvas.width, canvas.height, SHEET_BG)
            for i, cell in enumerate(batch):
                x = GAP + (i % cols) * (box[0] + GAP)
                y = GAP + (i // cols) * (box[1] + LABEL_H + GAP)
                bg = _background(cell.get("surface"))
                canvas.fill(x, y, box[0], box[1], bg)
                decoded = cell.get("rgba")
                if decoded is None and cell.get("image") is not None:
                    try:
                        decoded = imagefile.thumb(Path(cell["image"]), Path(tmp) / f"{page}-{i}.png", box)
                    except imagefile.Refused:
                        decoded = None
                if decoded is not None:
                    _blit(canvas, x, y, box, decoded[0], decoded[1], decoded[2], bg)
                else:
                    canvas.fill(x, y, box[0], box[1], MID)
                canvas.label(x, y + box[1] + 1, _fit_label(str(cell["label"]), box[0]), 1)
            path = folder / (f"{name}-{page + 1}.png" if fitted > per_sheet else f"{name}.png")
            path.write_bytes(canvas.png())
            sheets.append(path)
    return sheets, fitted
