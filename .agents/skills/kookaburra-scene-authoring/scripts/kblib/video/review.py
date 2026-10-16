"""Review: source frames as the render picks them, predicted or draft-rendered edit frames, grids, overlays, sheets and seam diffs (no drawtext, so labels live in the legend)."""

from __future__ import annotations

import hashlib
import json
import math
import re
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import cleanup as cl
from . import sheetlayout as sl
from ..util import EXIT_ENV, KbError

FAST_AFTER_MS = 8000.0
SEEK_MARGIN_S = 5.0
CLUSTER_MS = 10000.0
TAP_OFFSETS_MS = (-100, 0, 83, 275, 550)
TAP_DOT_FRACTION = 0.07
DEFAULT_TAP_SIZE = 1.25
SEAMLESS_PCT = 0.05

COLOURS = {
    "1x": "0xE5E5EA", "faster": "0xFF9F0A", "slower": "0x0A84FF", "hold": "0xBF5AF2", "raw": "0x8E8E93",
    "seam": "0xFF3B30", "tap": "0x30D158", "solid": "0xFFFFFF", "blur": "0x64D2FF", "pixelate": "0xFF375F",
}


# ── pure: rates, slots and the render's frame choice ─────────────────────────


def fps_fraction(fps: float) -> Fraction:
    """How ffmpeg reads the rate edit.rs prints (av_d2q with a 1001000 bound)."""
    return Fraction(fps).limit_denominator(1001000)


def fps_arg(fps: float) -> str:
    f = fps_fraction(fps)
    return str(f.numerator) if f.denominator == 1 else f"{f.numerator}/{f.denominator}"


def rescale_ms(ms: int, fps: float) -> int:
    """trim's start/end: av_rescale_q(us, 1/1e6, 1/F) with round-half-away."""
    f = fps_fraction(fps)
    num = int(ms) * 1000 * f.numerator
    den = 1_000_000 * f.denominator
    q, rem = divmod(num, den)
    return q + (1 if 2 * rem >= den else 0)


def slot_of(source_ms: float, fps: float) -> int:
    """The normalised slot on screen at a source moment."""
    f = fps_fraction(fps)
    return max(0, int(math.floor(source_ms * f.numerator / (1000.0 * f.denominator) + 1e-9)))


def slot_ms(n: int, fps: float) -> float:
    f = fps_fraction(fps)
    return n * 1000.0 * f.denominator / f.numerator


def source_frame_for_slot(n: int, fps: float, index_fps: float, frames: Sequence[int]) -> int:
    """The source's own frame index in slot n: the latest present frame (index/index_fps) whose pts rounds to at most n."""
    ratio = fps_fraction(fps) / Fraction(index_fps).limit_denominator(1001000)
    best = frames[0] if frames else 0
    for i in frames:
        x = Fraction(i) * ratio
        whole = x.numerator // x.denominator
        if whole + (1 if x - whole >= Fraction(1, 2) else 0) <= n:
            best = i
        else:
            break
    return best


def picked_local(j: int, length: int, speed: float) -> int:
    """The trimmed slot a clip's output frame j shows: setpts truncates (PTS-STARTPTS)/speed, fps keeps the latest, tpad clones the last."""
    best = 0
    lo = int(max(0, min(length - 1, math.floor(j * speed) - 2)))
    m = lo
    while m < length:
        if int(m / speed) <= j:
            best = m
            m += 1
        else:
            break
    return min(best, max(0, length - 1))


def predict(doc: Dict[str, Any], frames: Sequence[int]) -> List[Dict[str, Any]]:
    """Output frame k -> (clip, source slot) under build_render_args, without rendering."""
    images = cl.image_ids(doc)
    fps = cl.doc_fps(doc)
    clips = cl.relayout(doc.get("clips") or [], images)
    grid = cl.frame_grid(clips, fps, images)
    out = []
    for k in frames:
        i = next((i for i, g in enumerate(grid) if g[0] <= k < g[0] + g[1]), len(grid) - 1 if grid and k >= 0 else None)
        if i is None:
            continue
        c = clips[i]
        start_frame, count, _a, _b = grid[i]
        j = min(max(0, k - start_frame), count - 1)
        entry = {"k": k, "clip": c["id"], "clipIndex": i, "sourceId": c.get("sourceId"), "speed": cl.eff_speed(c.get("speed")),
                 "class": cl.speed_class(c, images), "timelineMs": round(k * 1000.0 / fps, 3), "local": j}
        if c.get("sourceId") in images:
            entry.update({"slot": None, "sourceMs": None, "image": True})
        elif c.get("holdMs") is not None:
            n = rescale_ms(c["inMs"], fps)
            entry.update({"slot": n, "sourceMs": round(slot_ms(n, fps), 3)})
        else:
            r0, r1 = rescale_ms(c["inMs"], fps), rescale_ms(c["outMs"], fps)
            n = r0 + picked_local(j, max(1, r1 - r0), cl.eff_speed(c.get("speed")))
            entry.update({"slot": n, "sourceMs": round(slot_ms(n, fps), 3)})
        out.append(entry)
    return out


def output_frame_at(ms: float, fps: float, total: int, first_after: bool = False) -> int:
    """The output frame on screen at ms, or with first_after the first frame starting at or after it."""
    x = ms * fps / 1000.0
    k = math.ceil(x - 1e-9) if first_after else math.floor(x + 1e-9)
    return max(0, min(total - 1, int(k)))


def contain_fit(out_w: int, out_h: int, src_w: int, src_h: int) -> Tuple[int, int, int, int]:
    """scale=W:H:force_original_aspect_ratio=decrease then pad=(ow-iw)/2 truncated: (x, y, w, h), as edit.rs places taps."""
    sw = min(out_w, int(math.floor(out_h * src_w / src_h + 0.5)))
    sh = min(out_h, int(math.floor(out_w * src_h / src_w + 0.5)))
    return ((out_w - sw) // 2, (out_h - sh) // 2, sw, sh)


def tap_box(doc: Dict[str, Any], source: Dict[str, Any]) -> float:
    """The tap dot's edge as a fraction of the source width (the render sizes it off the OUTPUT short edge)."""
    st = doc.get("settings") or {}
    w, h = int(st.get("width") or source["width"]), int(st.get("height") or source["height"])
    size = doc.get("tapSize")
    size = min(4.0, max(0.25, float(size))) if isinstance(size, (int, float)) else DEFAULT_TAP_SIZE
    dot_out = TAP_DOT_FRACTION * min(w, h) * size
    _x, _y, scaled_w, _h = contain_fit(w, h, source["width"], source["height"])
    return dot_out / max(1, scaled_w)


def sample_rect(keys: Sequence[Dict[str, Any]], ms: float) -> Optional[List[float]]:
    """editMasks.sampleMaskRect."""
    if not keys:
        return None
    keys = sorted(keys, key=lambda k: k["sourceMs"])
    if ms <= keys[0]["sourceMs"]:
        return list(keys[0]["rect"])
    for a, b in zip(keys, keys[1:]):
        if ms < b["sourceMs"]:
            t = (ms - a["sourceMs"]) / (b["sourceMs"] - a["sourceMs"])
            return [a["rect"][i] + (b["rect"][i] - a["rect"][i]) * t for i in range(4)]
    return list(keys[-1]["rect"])


def overlay_boxes(doc: Dict[str, Any], source_id: str, source_ms: Optional[float], timeline_ms: Optional[float],
                  want: Sequence[str]) -> List[Dict[str, Any]]:
    """Normalised source-space boxes to outline on a frame: taps visible at that moment, masks active there."""
    sources = {s["id"]: s for s in doc.get("sources") or []}
    src = sources.get(source_id)
    if not src:
        return []
    out = []
    if "taps" in want and timeline_ms is not None:
        clips = cl.relayout(doc.get("clips") or [], cl.image_ids(doc))
        edge = tap_box(doc, src) if src.get("width") else 0.05
        for tap in doc.get("taps") or []:
            if tap.get("sourceId") != source_id:
                continue
            for c in cl.occurrences(clips, source_id, tap["sourceMs"]):
                start = cl.timeline_at(c, tap["sourceMs"])
                end = min(start + cl.TAP_DURATION_MS, c["startMs"] + cl.clip_ms(c))
                if start <= timeline_ms < end:
                    ew, eh = edge, edge * src["width"] / max(1, src["height"])
                    x, y = tap["pos"]
                    out.append({"kind": "tap", "id": tap["id"], "rect": [x - ew / 2, y - eh / 2, ew, eh], "cross": [x, y]})
    if "masks" in want and source_ms is not None:
        pad = 1000.0 / cl.doc_fps(doc)
        for m in doc.get("masks") or []:
            if m.get("sourceId") != source_id:
                continue
            image = src.get("kind") == "image"
            # The render pads each mask's enable window by one frame (edit_masks.rs video_chain).
            if image or m.get("startMs", 0) - pad <= source_ms < m.get("endMs", 0) + pad:
                rect = sample_rect(m.get("keys") or [], source_ms)
                if rect:
                    out.append({"kind": m.get("style", "solid"), "id": m["id"], "rect": rect})
    return out


def _num(v: float) -> str:
    return f"{v:.0f}"


def decorate_filters(width: int, height: int, *, grid: bool, boxes: Sequence[Dict[str, Any]]) -> List[str]:
    """drawgrid at tenths and halves (haloed), the red origin marker, and outlined overlay boxes, in image pixels."""
    f: List[str] = []
    for b in boxes:
        x, y, w, h = b["rect"]
        px, py, pw, ph = x * width, y * height, max(2.0, w * width), max(2.0, h * height)
        colour = COLOURS.get(b["kind"], COLOURS["solid"])
        f.append(f"drawbox=x={_num(px)}:y={_num(py)}:w={_num(pw)}:h={_num(ph)}:color={colour}:t=3")
        if b.get("cross"):
            cx, cy = b["cross"][0] * width, b["cross"][1] * height
            arm = max(pw, ph) * 0.8
            f.append(f"drawbox=x={_num(cx - arm)}:y={_num(cy - 1)}:w={_num(2 * arm)}:h=2:color={colour}:t=fill")
            f.append(f"drawbox=x={_num(cx - 1)}:y={_num(cy - arm)}:w=2:h={_num(2 * arm)}:color={colour}:t=fill")
    if grid:
        f += [
            "drawgrid=x=-1:y=-1:w=iw/10:h=ih/10:t=3:c=black@0.35",
            "drawgrid=w=iw/10:h=ih/10:t=1:c=white@0.85",
            "drawgrid=x=-2:y=-2:w=iw/2:h=ih/2:t=4:c=black@0.4",
            "drawgrid=x=-1:y=-1:w=iw/2:h=ih/2:t=2:c=yellow@0.95",
            "drawbox=x=0:y=0:w=10:h=10:color=red:t=fill",
        ]
    return f


# ── runners ──────────────────────────────────────────────────────────────────


def _run(args: List[str], timeout: float = 600) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout, errors="replace")
    except OSError as e:
        raise KbError(f"ffmpeg failed to start: {e}", EXIT_ENV) from None
    except subprocess.TimeoutExpired:
        raise KbError(f"ffmpeg timed out after {int(timeout)} s", EXIT_ENV) from None
    if proc.returncode != 0:
        raise KbError(f"ffmpeg failed: {proc.stderr.strip()[-500:]}")
    return proc


def clusters(slots: Sequence[int], fps: float) -> List[List[int]]:
    out: List[List[int]] = []
    for n in sorted(set(slots)):
        if out and slot_ms(n, fps) - slot_ms(out[-1][0], fps) <= CLUSTER_MS:
            out[-1].append(n)
        else:
            out.append([n])
    return out


def select_expr(slots: Sequence[int]) -> str:
    return "+".join(f"eq(n\\,{n})" for n in slots)


def extract_slots(ffmpeg: str, src: Path, fps: float, slots: Sequence[int], out_dir: Path, stem: str, *,
                  vf_tail: Sequence[str] = (), fast: bool = True) -> Dict[int, Path]:
    """PNG per normalised slot as the render's fps=F:start_time=0 picks it; late frames seek 5 s early (never an accurate seek)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    result: Dict[int, Path] = {}
    for group in clusters(slots, fps):
        t0 = slot_ms(group[0], fps) / 1000.0
        head = [ffmpeg, "-v", "error", "-nostdin", "-y"]
        if fast and t0 * 1000.0 > FAST_AFTER_MS:
            head += ["-noaccurate_seek", "-ss", f"{max(0.0, t0 - SEEK_MARGIN_S):.3f}", "-copyts", "-start_at_zero"]
        vf = ",".join([f"fps={fps_arg(fps)}:start_time=0", f"select='{select_expr(group)}'"] + list(vf_tail))
        pattern = out_dir / f"{stem}-{group[0]}-%03d.png"
        _run(head + ["-i", str(src), "-vf", vf, "-fps_mode", "passthrough", "-frames:v", str(len(group)), str(pattern)])
        for i, n in enumerate(group, 1):
            path = out_dir / f"{stem}-{group[0]}-{i:03d}.png"
            if path.is_file():
                result[n] = path
    missing = [n for n in slots if n not in result]
    if missing:
        raise KbError(f"no frame at slot {missing[0]} ({slot_ms(missing[0], fps) / 1000:.3f}s); is it past the end?")
    return result


def extract_frames(ffmpeg: str, src: Path, frames: Sequence[int], out_dir: Path, stem: str, vf_tail: Sequence[str] = ()) -> Dict[int, Path]:
    """Frames of a CFR render by index (the draft is already on the output grid)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    order = sorted(set(frames))
    vf = ",".join([f"select='{select_expr(order)}'"] + list(vf_tail))
    pattern = out_dir / f"{stem}-%03d.png"
    _run([ffmpeg, "-v", "error", "-nostdin", "-y", "-i", str(src), "-vf", vf, "-fps_mode", "passthrough",
          "-frames:v", str(len(order)), str(pattern)])
    out = {}
    for i, k in enumerate(order, 1):
        p = out_dir / f"{stem}-{i:03d}.png"
        if p.is_file():
            out[k] = p
    return out


def finish(ffmpeg: str, png: Path, out: Path, *, crop: Optional[Tuple[int, int, int, int]], size: Tuple[int, int],
           zoom: Optional[Sequence[float]] = None, grid: bool = False, boxes: Sequence[Dict[str, Any]] = ()) -> Path:
    """Crop the letterbox, optionally zoom (lanczos up), scale for Read, then the grid and overlays."""
    f: List[str] = []
    if crop:
        x, y, w, h = crop
        f.append(f"crop={w}:{h}:{x}:{y}")
    W, H = size
    shown = list(boxes)
    if zoom:
        zx, zy, zw, zh = zoom
        f.append(f"crop=iw*{zw:.6f}:ih*{zh:.6f}:iw*{zx:.6f}:ih*{zy:.6f}")
        shown = [dict(b, rect=[(b["rect"][0] - zx) / zw, (b["rect"][1] - zy) / zh, b["rect"][2] / zw, b["rect"][3] / zh],
                      cross=[(b["cross"][0] - zx) / zw, (b["cross"][1] - zy) / zh] if b.get("cross") else None) for b in boxes]
    f.append(f"scale={W}:{H}:flags=lanczos,setsar=1")
    f += decorate_filters(W, H, grid=grid, boxes=shown)
    out.parent.mkdir(parents=True, exist_ok=True)
    _run([ffmpeg, "-v", "error", "-nostdin", "-y", "-i", str(png), "-vf", ",".join(f), "-frames:v", "1", str(out)])
    return out


def compose_sheet(ffmpeg: str, cells: Sequence[Dict[str, Any]], out: Path, layout: Dict[str, Any]) -> Path:
    """Tile cells (each {png, crop?, cls, seam}) with a 6 px speed-class bar on top and a red left edge after a seam."""
    cw, ch = layout["cellW"], layout["cellH"]
    args = [ffmpeg, "-v", "error", "-nostdin", "-y"]
    legs = []
    for i, cell in enumerate(cells):
        args += ["-i", str(cell["png"])]
        f = []
        if cell.get("crop"):
            x, y, w, h = cell["crop"]
            f.append(f"crop={w}:{h}:{x}:{y}")
        f += [f"scale={cw}:{ch}:force_original_aspect_ratio=decrease:flags=lanczos",
              f"pad={cw}:{ch}:(ow-iw)/2:(oh-ih)/2:color={sl.BG}",
              f"pad={cw}:{ch + sl.BAR}:0:{sl.BAR}:color={COLOURS.get(cell.get('cls') or '1x', COLOURS['1x'])}"]
        if cell.get("seam"):
            f.append(f"drawbox=x=0:y=0:w=4:h=ih:color={COLOURS['seam']}:t=fill")
        if cell.get("grid"):
            f += decorate_filters(cw, ch, grid=True, boxes=())
        f.append("setsar=1,format=rgb24")
        legs.append(f"[{i}:v]{','.join(f)}[c{i}]")
    joined = "".join(f"[c{i}]" for i in range(len(cells)))
    graph = ";".join(legs) + f";{joined}concat=n={len(cells)}:v=1:a=0,tile={layout['cols']}x{layout['rows']}:margin={sl.MARGIN}:padding={sl.PADDING}:color={sl.BG}[out]"
    out.parent.mkdir(parents=True, exist_ok=True)
    _run(args + ["-filter_complex", graph, "-map", "[out]", "-frames:v", "1", str(out)])
    return out


def seam_diff(ffmpeg: str, a: Path, b: Path) -> float:
    """Mean absolute luma difference between two frames, percent of full scale."""
    graph = "[0:v]format=gray,scale=320:-2[a];[1:v]format=gray,scale=320:-2[b];[a][b]blend=all_mode=difference,signalstats,metadata=mode=print"
    proc = _run([ffmpeg, "-hide_banner", "-nostdin", "-v", "repeat+info", "-i", str(a), "-i", str(b), "-filter_complex", graph, "-f", "null", "-"])
    m = re.search(r"lavfi\.signalstats\.YAVG=([0-9.]+)", proc.stderr)
    return round(float(m.group(1)) / 255.0 * 100.0, 4) if m else float("nan")


def doc_key(doc: Dict[str, Any], source_shas: Sequence[str], scale: float) -> str:
    text = json.dumps({"doc": doc, "sources": list(source_shas), "scale": scale}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
