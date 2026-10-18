"""verify-export's expectations (a saved export record, else the project and catalogue), the frames worth looking at, contact sheets and the run folder."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..project import Project
from ..util import bridge_dir, is_number
from ..video import review
from ..video import sheetlayout as sl
from . import timeline as tl

RECORD_VERSION = 1
KEEP_RUNS = 12
FRAME_FPS = 60


# ── the run folder ───────────────────────────────────────────────────────────


def film_dir(project: Project, tag: str) -> Path:
    """A fresh `_bridge/film/<slug>/<stamp>-<tag>/` (readable under the managed Read rule); older runs beyond the newest 12 go."""
    base = bridge_dir() / "film" / project.slug
    base.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    out = base / f"{stamp}-{os.getpid()}-{tag}"
    out.mkdir(parents=True, exist_ok=True)
    try:
        runs = sorted((p for p in base.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in runs[KEEP_RUNS:]:
            shutil.rmtree(old, ignore_errors=True)
    except OSError:
        pass
    return out


# ── the export record (written by kb export; schema in docs/agent-kit.md) ────


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def record_path(slug: str, sha: str) -> Path:
    return bridge_dir() / "exports" / slug / f"{sha[:16]}.json"


def load_record(slug: str, sha: str) -> Optional[Dict[str, Any]]:
    """The saved export record for these exact bytes, or None."""
    try:
        data = json.loads(record_path(slug, sha).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("sha256") != sha:
        return None
    return data


# ── static expectations ──────────────────────────────────────────────────────


def aspect_slugs(catalog: Any) -> Dict[str, str]:
    """Filename aspect (`16x9`, `phone-landscape`) to aspect id."""
    ids = catalog.ids("aspects") if catalog is not None else None
    return {a.replace(":", "x"): a for a in ids or []}


def parse_name(name: str, slug: str, catalog: Any) -> Dict[str, Optional[str]]:
    """`<slug>-<aspect>[-<preset or custom>][ N].<ext>`, the export button's names (Downloads adds ` N`)."""
    stem = Path(name).stem
    stem = re.sub(r" \d+$", "", stem)
    rest = stem[len(slug) + 1:] if stem.startswith(slug + "-") else stem
    slugs = aspect_slugs(catalog)
    for key in sorted(slugs, key=len, reverse=True):
        if rest == key or rest.startswith(key + "-"):
            return {"aspect": slugs[key], "suffix": rest[len(key) + 1:] or None}
    return {"aspect": None, "suffix": None}


def out_dims(width: int, height: int, short_edge: Optional[int]) -> Tuple[int, int]:
    """encode.rs out_dims: short edge to the target, aspect kept, even, never upscaled."""
    if not short_edge:
        return width, height
    short = min(width, height)
    if short_edge >= short:
        return width, height
    f = short_edge / float(short)

    def even(v: float) -> int:
        half = v / 2.0
        return int(half + 0.5 if half >= 0 else half - 0.5) * 2

    return even(width * f), even(height * f)


def preset_entry(catalog: Any, preset_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """The catalogue's export preset (`exportPresets`: `fps`, `shortEdge`, `loudnessTarget` per row)."""
    if catalog is None or not preset_id:
        return None
    for entry in catalog.entries("exportPresets") or []:
        if entry.get("id") == preset_id:
            return entry
    return None


def static_expectations(project: Project, file: Path, catalog: Any, slots: List[Dict[str, Any]]) -> Dict[str, Any]:
    """What the export button would have made for this name: aspect from the filename, size and rate from the catalogue."""
    parsed = parse_name(file.name, project.slug, catalog)
    exp: Dict[str, Any] = {"source": "static", "aspect": parsed["aspect"], "preset": parsed["suffix"] or "kookaburra-standard",
                           "totalMs": tl.timeline_total_ms(slots), "audio": isinstance(project.manifest().get("audio"), dict)}
    aspect = next((a for a in (catalog.entries("aspects") or []) if a.get("id") == parsed["aspect"]), None) if catalog is not None else None
    preset = preset_entry(catalog, parsed["suffix"])
    if parsed["suffix"] is None:
        exp.update({"fps": FRAME_FPS, "shortEdge": None})
    elif preset:
        exp.update({"fps": preset.get("fps"), "shortEdge": preset.get("shortEdge"), "loudnessTarget": preset.get("loudnessTarget")})
    else:
        exp.update({"fps": None, "shortEdge": None, "note": f"preset {parsed['suffix']!r} is not in this kit's catalogue; size and rate unchecked"})
    if aspect and is_number(aspect.get("width")) and is_number(aspect.get("height")):
        w, h = out_dims(int(aspect["width"]), int(aspect["height"]), exp.get("shortEdge"))
        if exp.get("fps") is not None or parsed["suffix"] is None:
            exp.update({"width": w, "height": h})
        exp["ratio"] = round(int(aspect["width"]) / float(aspect["height"]), 4)
    if exp.get("fps"):
        exp["frames"] = tl.export_frames(exp["totalMs"], float(exp["fps"]))
    return exp


def record_expectations(record: Dict[str, Any]) -> Dict[str, Any]:
    keep = ("aspect", "preset", "fps", "width", "height", "frames", "posterFrame", "totalMs", "audio", "loudnessTarget", "codec", "lane")
    exp = {k: record.get(k) for k in keep if k in record}
    exp["source"] = "record"
    return exp


# ── frames worth looking at ──────────────────────────────────────────────────


def _still_keys(doc: Optional[Dict[str, Any]]) -> List[float]:
    out: List[float] = []
    for name in ("camera", "cameraRig"):
        block = doc.get(name) if doc else None
        for key in (block.get("keys") if isinstance(block, dict) else None) or []:
            if isinstance(key, dict) and key.get("still") is True and is_number(key.get("tMs")):
                out.append(float(key["tMs"]))
    return out


def moments(project: Project, slots: List[Dict[str, Any]], fps: float) -> List[Dict[str, Any]]:
    """Per scene: its first frame, its settled-in frame (after the incoming transition), named moments (stills marks,
    `still: true` camera keys, else the midpoint) and its last frame. Global ms."""
    out: List[Dict[str, Any]] = []
    step = 1000.0 / fps
    for slot in slots:
        stem = slot.get("stem") or str(slot["index"])
        try:
            doc = project.load_sidecar(stem)
        except Exception:  # noqa: BLE001 - a broken sidecar still gets its frames
            doc = None
        start, end = slot["startMs"], slot["endMs"]
        settled = start + (slot.get("transitionIn") or {}).get("durationMs", 0)
        stills = doc.get("stills") if isinstance(doc, dict) and isinstance(doc.get("stills"), dict) else {}
        named = [float(m) for m in stills.get("marksMs") or [] if is_number(m)] + _still_keys(doc)
        rows = [("first", start), ("settled", settled)]
        if named:
            rows += [(f"still {m / 1000:.2f}s", start + m) for m in sorted(named) if 0 <= m < slot["durationMs"]]
        else:
            rows.append(("middle", start + slot["durationMs"] / 2))
        rows.append(("last", max(start, end - step)))
        seen: List[float] = []
        for label, ms in rows:
            if any(abs(ms - s) < step / 2 for s in seen):
                continue
            seen.append(ms)
            out.append({"index": slot["index"], "stem": stem, "label": label, "ms": ms})
    return out


def contact_sheets(ffmpeg: str, film: Path, items: List[Dict[str, Any]], out_dir: Path, aspect: float, tag: str) -> Tuple[List[str], List[Dict[str, Any]]]:
    """Frames by index into PNGs, then as few sheets as Read takes in whole; returns the sheet paths and a legend."""
    frames = sorted({it["frame"] for it in items})
    pngs = review.extract_frames(ffmpeg, film, frames, out_dir / "frames", tag)
    cells = [dict(it, png=str(pngs[it["frame"]])) for it in items if it["frame"] in pngs]
    for i, cell in enumerate(cells):
        cell["seam"] = i > 0 and cell["index"] != cells[i - 1]["index"]
    paths: List[str] = []
    legend: List[Dict[str, Any]] = []
    cursor = 0
    sheets = sl.plan_sheets(len(cells), aspect)
    for lay in sheets:
        chunk = cells[cursor:cursor + lay["cells"]]
        suffix = f"-{lay['index']}" if len(sheets) > 1 else ""
        path = out_dir / f"{tag}-sheet{suffix}.png"
        review.compose_sheet(ffmpeg, chunk, path, lay)
        paths.append(str(path))
        for j, cell in enumerate(chunk):
            legend.append({"sheet": lay["index"], "cell": j + 1, "row": j // lay["cols"] + 1, "col": j % lay["cols"] + 1,
                           "scene": cell["stem"], "label": cell["label"], "frame": cell["frame"], "ms": int(round(cell["ms"]))})
        cursor += lay["cells"]
    return paths, legend
