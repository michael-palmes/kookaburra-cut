"""Flash frame strips: the frames before, at and after each flagged moment side by side, the changing region boxed, so a person sees what flashes without pulling frames by hand."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from ..realdir import real_dir
from ..util import EXIT_ENV, KbError

MAX_STRIPS = 8
SHORT_EDGE = 360
GAP_PX = 6
BOX = "0xff3b30@0.95"
MIN_BOX = 0.02
TIMEOUT_S = 120
ROLES = ("before", "at", "after")


def strip_name(n: int, ms: float) -> str:
    """`strip-01-00m35.233s.png`: the strip's order and its project time."""
    whole = max(0, int(round(ms)))
    return f"strip-{n:02d}-{whole // 60000:02d}m{(whole % 60000) / 1000:06.3f}s.png"


def box_filter(region: Any) -> Optional[str]:
    """drawbox over a normalised `[x, y, w, h]`, at least 2% a side so a small region still shows; None without one."""
    if not isinstance(region, (list, tuple)) or len(region) != 4:
        return None
    try:
        x, y, w, h = (float(v) for v in region)
    except (TypeError, ValueError):
        return None
    if w <= 0 or h <= 0:
        return None
    w, h = max(w, MIN_BOX), max(h, MIN_BOX)
    x, y = min(max(0.0, x), 1.0 - w), min(max(0.0, y), 1.0 - h)
    return f"drawbox=x=iw*{x:.4f}:y=ih*{y:.4f}:w=iw*{w:.4f}:h=ih*{h:.4f}:color={BOX}:t=3"


def compose_args(ffmpeg: str, pngs: Sequence[Path], region: Any, out: Path) -> List[str]:
    """Three frames at a 360 px short edge, boxed, a dark gap between them, side by side."""
    box = box_filter(region)
    legs = []
    for i in range(len(pngs)):
        chain = [f"scale=w='if(gte(iw,ih),-2,{SHORT_EDGE})':h='if(gte(iw,ih),{SHORT_EDGE},-2)':flags=area", "format=rgb24"]
        if box:
            chain.append(box)
        if i < len(pngs) - 1:
            chain.append(f"pad=iw+{GAP_PX}:ih:0:0:color=0x111111")
        legs.append(f"[{i}:v]{','.join(chain)}[c{i}]")
    graph = ";".join(legs) + ";" + "".join(f"[c{i}]" for i in range(len(pngs))) + f"hstack=inputs={len(pngs)}[out]"
    argv = [ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-y"]
    for p in pngs:
        argv += ["-i", str(p)]
    return argv + ["-filter_complex", graph, "-map", "[out]", "-frames:v", "1", str(out)]


def compose(ffmpeg: str, pngs: Sequence[Path], region: Any, out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(compose_args(ffmpeg, pngs, region, out), capture_output=True, timeout=TIMEOUT_S)
    except OSError as e:
        raise KbError(f"could not run ffmpeg: {e.strerror}", EXIT_ENV) from None
    except subprocess.TimeoutExpired:
        raise KbError("ffmpeg took too long composing a flash strip", EXIT_ENV) from None
    if proc.returncode != 0 or not out.is_file():
        raise KbError(f"ffmpeg could not compose a flash strip: {proc.stderr.decode('utf-8', 'replace').strip()[-300:]}")
    return out


def clear(folder: Path) -> None:
    """Drop an earlier check's strips (only kb's own files)."""
    try:
        for p in folder.glob("strip-*.png"):
            p.unlink()
    except OSError:
        pass


def seek_frames(ffmpeg: str, film: Path, frames: Sequence[int], fps: float, out_dir: Path) -> Dict[int, Path]:
    """Each frame by its own accurate seek, a quarter frame early so rounding never lands on the next one: no decode of the whole film."""
    out_dir.mkdir(parents=True, exist_ok=True)
    found: Dict[int, Path] = {}
    for k in sorted(set(frames)):
        dest = out_dir / f"f{k:06d}.png"
        argv = [ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", f"{max(0.0, (k - 0.25) / fps):.6f}", "-i", str(film),
                "-frames:v", "1", str(dest)]
        try:
            subprocess.run(argv, capture_output=True, timeout=TIMEOUT_S)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if dest.is_file():
            found[k] = dest
    return found


def film_strips(ffmpeg: str, film: Path, report: Optional[Dict[str, Any]], out_dir: Path, fps: float,
                poster_ms: float = 0.0) -> List[Dict[str, Any]]:
    """Strips for a finished film's first flagged moments, frames pulled by index from the file."""
    issues = [i for i in (report or {}).get("issues") or [] if isinstance(i, dict)][:MAX_STRIPS]
    clear(out_dir)
    if not issues:
        return []
    last = max(0, int((report or {}).get("frames") or 0) - 1)
    wanted: List[List[int]] = []
    for issue in issues:
        at = int(round(float(issue.get("startMs") or 0) * fps / 1000.0))
        wanted.append([min(last, max(0, at + d)) if last else max(0, at + d) for d in (-1, 0, 1)])
    out_dir.mkdir(parents=True, exist_ok=True)
    scratch = real_dir(out_dir, ".frames")
    try:
        pngs = seek_frames(ffmpeg, film, [k for w in wanted for k in w], fps, scratch)
        out: List[Dict[str, Any]] = []
        for n, (issue, frames) in enumerate(zip(issues, wanted), 1):
            if not all(k in pngs for k in frames):
                continue
            ms = max(0.0, float(issue.get("startMs") or 0) - poster_ms)
            path = compose(ffmpeg, [pngs[k] for k in frames], issue.get("region"), out_dir / strip_name(n, ms))
            out.append(strip_row(n, issue, path, [{"role": r, "frame": k} for r, k in zip(ROLES, frames)]))
        return out
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def strip_row(n: int, issue: Dict[str, Any], path: Path, frames: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"n": n, "tc": issue.get("tc"), "type": issue.get("type"), "standard": issue.get("standard"),
            "severity": issue.get("severity"), "region": issue.get("region"), "path": str(path), "frames": frames}


def attach(report: Optional[Dict[str, Any]], strips: List[Dict[str, Any]]) -> None:
    """Each strip's path on its issue (issues keep their order), so a report names the picture to Read."""
    if not report:
        return
    issues = [i for i in report.get("issues") or [] if isinstance(i, dict)]
    for row in strips:
        k = row["n"] - 1
        if 0 <= k < len(issues):
            issues[k]["strip"] = row["path"]
    report["strips"] = strips
