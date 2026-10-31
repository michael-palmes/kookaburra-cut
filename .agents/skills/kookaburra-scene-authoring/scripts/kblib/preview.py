"""kb preview --range: a low-resolution clip (or GIF) of a span, rendered by the app's render window through the export path, plus a contact sheet to Read. For seeing motion while designing; never an export or a baseline."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List

from . import bridge, queue
from .film import ranged as rg
from .film import report as rp
from .film import timeline as tl
from .realdir import real_dir
from .util import EXIT_ENV, EXIT_OK, KbError, emit, emit_err

DEFAULT_FPS = 12
DEFAULT_WIDTH = 480
MAX_SPAN_MS = 30_000
SHEET_FRAMES = 12
KEEP = 10
TIMEOUT_S = 600.0
ENCODE_TIMEOUT_S = 300

EPILOG = """\
  ./kb preview --range bar:13-16                  a 480 px, 12 fps MP4 of bars 13 to 16, plus a sheet
  ./kb preview --scene 04-flythrough --gif        the scene as a GIF
  ./kb preview --range 12-18 --fps 24 --width 640 --aspect 9:16

The span is rendered by the running app at preview size (no export, the editor stays usable).
At most 30 s; files land in .kb/previews/ (the newest 10 kept). Read the sheet to see the
motion; open the clip to watch it."""


def previews_root(project: Any) -> Path:
    from . import lock

    return real_dir(lock.kb_dir(project), "previews")


def out_path(project: Any, label: str, ext: str) -> Path:
    root = previews_root(project)
    root.mkdir(parents=True, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "-._" else "-" for c in label)[:40].strip("-") or "span"
    path = root / f"{time.strftime('%Y%m%d-%H%M%S')}-{safe}{ext}"
    files = sorted((p for p in root.iterdir() if p.is_file() and not p.name.startswith(".")), key=lambda p: p.name)
    for old in files[: max(0, len(files) - KEEP * 2)]:
        old.unlink()
    return path


def encode(ffmpeg: str, frames: List[Path], fps: float, out: Path, gif: bool) -> None:
    """The PNG frames as an H.264 MP4 or a palette GIF."""
    with tempfile.TemporaryDirectory(prefix="kb-preview-") as tmp:
        for n, src in enumerate(frames):
            (Path(tmp) / f"f{n:05d}.png").symlink_to(src)
        pattern = str(Path(tmp) / "f%05d.png")
        if gif:
            graph = "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4"
            tail = ["-filter_complex", graph, "-loop", "0"]
        else:
            tail = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
        argv = [ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-y", "-framerate", f"{fps:g}", "-i", pattern] + tail + [str(out)]
        try:
            proc = subprocess.run(argv, capture_output=True, timeout=ENCODE_TIMEOUT_S)
        except OSError as e:
            raise KbError(f"could not run ffmpeg: {e.strerror}", EXIT_ENV) from None
        except subprocess.TimeoutExpired:
            raise KbError("ffmpeg took too long encoding the preview", EXIT_ENV) from None
        if proc.returncode != 0 or not out.is_file():
            raise KbError(f"ffmpeg could not encode the preview: {proc.stderr.decode('utf-8', 'replace').strip()[-300:]}")


def sheet(ffmpeg: str, clip: Path, slots: List[Dict[str, Any]], times: List[float], out_dir: Path, aspect: float) -> List[str]:
    """Up to 12 evenly spaced frames of the clip, labelled with their scene and film time."""
    n = len(times)
    picks = sorted({round(i * (n - 1) / max(1, SHEET_FRAMES - 1)) for i in range(min(n, SHEET_FRAMES))})
    items = []
    for k in picks:
        where = tl.scene_at(slots, times[k]) or (0, 0.0)
        items.append({"index": where[0], "stem": slots[where[0]].get("stem") if slots else "?", "label": f"{times[k] / 1000:.2f}s",
                      "frame": k, "ms": times[k]})
    paths, _ = rp.contact_sheets(ffmpeg, clip, items, out_dir, aspect, "preview")
    return paths


def cmd_preview(ctx: Any) -> int:
    from .film import probe as pb

    a = ctx.args
    project = ctx.project
    slots = tl.project_slots(project)
    if a.scene:
        span = rg.scene_span(slots, project.resolve(a.scene)[0], pad_ms=0)
    elif a.range:
        span = rg.parse_span(a.range, project, tl.timeline_total_ms(slots))
    else:
        raise KbError("kb preview needs --range SPAN or --scene S", EXIT_ENV, kind="usage", hint="./kb preview --range bar:13-16")
    if span["endMs"] - span["startMs"] > MAX_SPAN_MS:
        raise KbError(f"{span['label']} is {(span['endMs'] - span['startMs']) / 1000:.1f}s; a preview takes at most {MAX_SPAN_MS // 1000} s",
                      EXIT_ENV, kind="usage", hint="preview a shorter span, or ./kb export for the whole film")
    if not 1 <= a.fps <= 30:
        raise KbError("--fps takes 1 to 30", EXIT_ENV, kind="usage")
    hb = bridge.require_app("range", "kb preview", project)
    queue.require_features(hb, {"range": "kb preview"})
    tools = pb.tools()
    body: Dict[str, Any] = {"project": project.project_id, "startMs": round(span["startMs"], 3), "endMs": round(span["endMs"], 3),
                            "fps": a.fps, "flashes": False, "clip": True, "width": a.width}
    if a.aspect:
        body["aspect"] = a.aspect
    emit_err(f"kb: rendering {span['label']} ({span['startMs'] / 1000:.2f}-{span['endMs'] / 1000:.2f}s) at {a.fps} fps in the render window")
    resp = bridge.require_ok(bridge.request("range", body, TIMEOUT_S, "kb preview", client=ctx.caller.name), "range")
    paths = [Path(p) for p in (resp.get("clip") or {}).get("paths") or [] if isinstance(p, str)]
    if not paths or not all(p.is_file() for p in paths):
        raise KbError("the app rendered no preview frames", kind="failed")
    first = int(resp.get("firstFrame") or 0)
    times = [(first + n) * 1000.0 / a.fps for n in range(len(paths))]
    out = out_path(project, span["label"], ".gif" if a.gif else ".mp4")
    mp4 = out if not a.gif else out.with_suffix(".mp4")
    encode(tools.ffmpeg, paths, a.fps, mp4, gif=False)
    if a.gif:
        encode(tools.ffmpeg, paths, a.fps, out, gif=True)
    size = resp.get("size") if isinstance(resp.get("size"), dict) else {}
    work = rp.film_dir(project, "preview")
    sheets = sheet(tools.ffmpeg, mp4, slots, times, work, (size.get("width") or 16) / float(size.get("height") or 9))
    if a.gif:
        mp4.unlink()
    shutil.rmtree(work / "frames", ignore_errors=True)
    payload = {"path": str(out), "sheets": sheets, "frames": len(paths), "fps": a.fps, "size": size, "span": span,
               "renderMs": (resp.get("timing") or {}).get("renderMs")}
    if ctx.json:
        ctx.out(payload, ok=True)
        return EXIT_OK
    emit(f"{out}  ({len(paths)} frames at {a.fps} fps, {size.get('width')}x{size.get('height')})")
    for p in sheets:
        emit(f"sheet: {p} (Read it)")
    return EXIT_OK


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """Adds `kb preview` to kb's top-level subparsers."""
    s = sub.add_parser("preview", help="a low-resolution clip or GIF of a span, rendered by the app, plus a sheet to Read",
                       description="a low-resolution clip or GIF of a span of the film, rendered by the running app", epilog=EPILOG,
                       formatter_class=Formatter, parents=[common])
    s.add_argument("--range", metavar="SPAN", help="bar:13-16, 12-18 (film seconds), 00:12-00:18 or bar:13..cue:drop")
    s.add_argument("--scene", metavar="S", help="the whole scene instead of --range")
    s.add_argument("--aspect", metavar="A", help="render at this aspect (default: the editor's)")
    s.add_argument("--fps", type=int, default=DEFAULT_FPS, help=f"frames a second, 1 to 30 (default {DEFAULT_FPS})")
    s.add_argument("--width", type=int, default=DEFAULT_WIDTH, help=f"width in pixels (default {DEFAULT_WIDTH})")
    s.add_argument("--gif", action="store_true", help="a GIF instead of an MP4")
    s.set_defaults(fn=cmd_preview)
