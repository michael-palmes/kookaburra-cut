"""Scene handoffs on the finished film: at each seam, the outgoing scene's last solo frame against the incoming scene's first solo frame (a cut's two sides, or either side of a transition), with the picture and luminance change."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from ..util import KbError
from ..video import review
from . import swatch
from . import timeline as tl

LUMA_SIDE = 32
CUT_STEP = 0.10
SHORT_SCENE_MS = 1000
STROBE_CUTS = 4


def seam_frames(slots: List[Dict[str, Any]], fps: float, offset: int, total_frames: int) -> List[Dict[str, Any]]:
    """Per seam: the frame pair, the seam's kind (`cut` or the transition type) and its project time."""
    out: List[Dict[str, Any]] = []
    last = max(0, total_frames - 1)
    for i in range(len(slots) - 1):
        a, b = slots[i], slots[i + 1]
        spec = b.get("transitionIn")
        if spec:
            before = tl.last_frame_before(b["startMs"], fps, offset)
            after = tl.frame_at(a["endMs"], fps, offset)
            kind = spec.get("type") or "crossfade"
        else:
            before = tl.last_frame_before(a["endMs"], fps, offset)
            after = tl.frame_at(b["startMs"], fps, offset)
            kind = "cut"
        out.append({"index": i, "from": a.get("stem"), "to": b.get("stem"), "kind": kind, "atMs": int(round(b["startMs"])),
                    "frames": [min(before, last), min(after, last)],
                    "short": min(a["durationMs"], b["durationMs"]) < SHORT_SCENE_MS})
    return out


def mean_luminance(rgb: bytes) -> float:
    """Mean WCAG relative luminance of packed rgb24 pixels."""
    n = len(rgb) // 3
    if n == 0:
        return 0.0
    lin = swatch.linear
    total = 0.0
    for i in range(0, n * 3, 3):
        total += 0.2126 * lin(rgb[i]) + 0.7152 * lin(rgb[i + 1]) + 0.0722 * lin(rgb[i + 2])
    return total / n


def luminances(ffmpeg: str, path: Path, frames: List[int]) -> Dict[int, float]:
    tail = f"[sel]scale={LUMA_SIDE}:{LUMA_SIDE}:flags=area[out]"
    raw = swatch.raw_frames(ffmpeg, path, frames, tail, LUMA_SIDE * LUMA_SIDE * 3)
    return {n: mean_luminance(b) for n, b in raw.items()}


def flag_seams(seams: List[Dict[str, Any]], fps: float) -> List[str]:
    """Warnings: a hard luminance step next to a short scene, and four or more such cuts inside one second."""
    warnings: List[str] = []
    steps = [s for s in seams if s["kind"] == "cut" and s.get("deltaL") is not None and abs(s["deltaL"]) >= CUT_STEP]
    for s in steps:
        if s["short"]:
            s["flag"] = "luminance step next to a short scene"
            warnings.append(f"{s['from']} -> {s['to']}: a hard cut changes luminance by {abs(s['deltaL']):.2f} next to a scene under "
                            f"{SHORT_SCENE_MS} ms; that cut is one half of a flash, so soften it with a transition or hold longer")
    times = [s["atMs"] for s in steps]
    for i, t0 in enumerate(times):
        inside = [t for t in times[i:] if t < t0 + 1000]
        if len(inside) >= STROBE_CUTS:
            warnings.append(f"{len(inside)} hard luminance cuts within one second from {t0 / 1000:.2f}s: that strobes; "
                            "space the cuts or soften them")
            break
    return warnings


def check(ffmpeg: str, path: Path, slots: List[Dict[str, Any]], fps: float, offset: int, total_frames: int,
          out_dir: Optional[Path] = None) -> Dict[str, Any]:
    """The seams with their frame pairs, picture change (seam diff, % of full scale) and luminance step; PNGs when out_dir is given."""
    seams = seam_frames(slots, fps, offset, total_frames)
    frames = sorted({f for s in seams for f in s["frames"]})
    lum = luminances(ffmpeg, path, frames) if frames else {}
    pngs: Dict[int, Path] = {}
    if out_dir is not None and frames:
        pngs = review.extract_frames(ffmpeg, path, frames, out_dir, "seam")
    for s in seams:
        a, b = s["frames"]
        if a in lum and b in lum:
            s["deltaL"] = round(lum[b] - lum[a], 4)
        if a in pngs and b in pngs:
            s["pngs"] = [str(pngs[a]), str(pngs[b])]
            try:
                s["diffPct"] = review.seam_diff(ffmpeg, pngs[a], pngs[b])
            except KbError:
                pass
    return {"seams": seams, "warnings": flag_seams(seams, fps), "pngs": pngs}
