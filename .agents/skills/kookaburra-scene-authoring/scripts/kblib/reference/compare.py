"""`--compare`: a local HTML report laying the project's timeline over the reference film. Self-contained: no script, no remote asset, a CSP that says so, and every string escaped, because the recognised text and the file name come from an untrusted film."""

from __future__ import annotations

import base64
import html
import math
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..film import pacing as pc
from ..project import Project
from ..util import KbError, is_number
from ..video import labels

CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
WIDTH = 1000
LANE = 34
_HEX = re.compile(r"#[0-9a-f]{6}\Z")
_THUMB = re.compile(r"thumbs/thumb-[0-9]+\.jpg\Z")

STYLE = """
:root { --bg:#fbfaf8; --ink:#1c1c1e; --soft:#6b6b70; --line:#e2e0db; --accent:#b4690e; --scene:#3a5f8a; }
@media (prefers-color-scheme: dark) { :root { --bg:#17171a; --ink:#f2f1ee; --soft:#a3a2a8; --line:#34343a; --accent:#e8a33d; --scene:#7ea6d4; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--ink); font: 14px/1.5 -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif; }
main { max-width: 1040px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 32px 0 8px; }
p { margin: 4px 0; color: var(--soft); }
.scroll { overflow-x: auto; }
svg { display: block; width: 100%; min-width: 640px; height: auto; }
svg text { font: 11px -apple-system, sans-serif; fill: var(--soft); }
svg .name { fill: #fff; font-weight: 600; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--soft); font-weight: 500; }
td.text { max-width: 420px; overflow-wrap: anywhere; }
img { display: block; width: 120px; height: auto; border-radius: 3px; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: -1px; margin-right: 6px; border: 1px solid var(--line); }
.warn { color: var(--accent); }
"""


def e(value: Any) -> str:
    return html.escape(str(value), quote=True)


def safe_hex(value: Any) -> str:
    return value if isinstance(value, str) and _HEX.match(value) else "#888888"


def bar_of(grid: Dict[str, Any], track_ms: float) -> float:
    """A track time as a bar number with its fraction: the axis both films share."""
    return (track_ms - grid["offsetMs"]) / (grid["beatsPerBar"] * 60000.0 / grid["bpm"]) + 1


def project_rows(project: Project, slots: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = []
    for slot in slots:
        stem = slot.get("stem") or ""
        try:
            doc = project.load_sidecar(stem)
        except KbError:
            doc = None
        words = pc.scene_words(doc)
        seconds = slot["durationMs"] / 1000.0
        rows.append({"stem": stem, "fromMs": slot["startMs"], "toMs": slot["endMs"], "words": words,
                     "wordsPerSecond": round(words / seconds, 2) if seconds > 0 else None})
    return rows


class Axis:
    """Where a time lands: on bars when both films have a grid, each counted on its own; on seconds otherwise."""

    def __init__(self, ref_grid: Optional[Dict[str, Any]], project_grid: Optional[Dict[str, Any]], offset: float, ref_end: float, project_end: float) -> None:
        self.bars = bool(ref_grid and project_grid)
        self.ref_grid, self.project_grid, self.offset = ref_grid, project_grid, offset
        self.lo = min(self.ref(0), self.project(0))
        self.hi = max(self.ref(ref_end), self.project(project_end), self.lo + 1e-6)

    def ref(self, ms: float) -> float:
        return bar_of(self.ref_grid, ms) if self.bars else ms / 1000.0  # type: ignore[arg-type]

    def project(self, ms: float) -> float:
        return bar_of(self.project_grid, ms + self.offset) if self.bars else ms / 1000.0  # type: ignore[arg-type]

    def x(self, value: float) -> float:
        return round((value - self.lo) / (self.hi - self.lo) * WIDTH, 2)


def lane(y: int, items: List[Dict[str, Any]], colour_of: Any, label_of: Any) -> List[str]:
    out = []
    for item in items:
        x0, x1 = item["x0"], item["x1"]
        out.append(f'<rect x="{x0}" y="{y}" width="{max(0.5, x1 - x0 - 1):.2f}" height="{LANE}" rx="2" fill="{colour_of(item)}"/>')
        text = label_of(item)
        if text and x1 - x0 > 8 * len(text):
            out.append(f'<text class="name" x="{x0 + 4}" y="{y + LANE / 2 + 4}">{e(text)}</text>')
    return out


def timeline_svg(axis: Axis, segments: List[Dict[str, Any]], scenes: List[Dict[str, Any]], bar_map: Optional[Dict[str, Any]]) -> str:
    parts = [f'<svg viewBox="0 0 {WIDTH} 190" role="img" aria-label="The project over the reference film">']
    for s in segments:
        s["x0"], s["x1"] = axis.x(axis.ref(s["fromMs"])), axis.x(axis.ref(s["toMs"]))
    for s in scenes:
        s["x0"], s["x1"] = axis.x(axis.project(s["fromMs"])), axis.x(axis.project(s["toMs"]))
    parts.append('<text x="0" y="12">Reference</text>')
    parts += lane(18, segments, lambda s: safe_hex((s.get("colour") or {}).get("hex")), lambda s: str(s["index"] + 1))
    parts.append('<text x="0" y="72">Project</text>')
    parts += lane(78, scenes, lambda _s: "var(--scene)", lambda s: s["stem"])
    bars = (bar_map or {}).get("bars") or []
    if axis.bars and bars:
        loud = [b["lufs"] for b in bars if is_number(b.get("lufs"))]
        floor, top = min(loud, default=-70), max(loud, default=-10)
        span = max(top - floor, 1)
        for b in bars:
            if not is_number(b.get("lufs")) or not is_number(b.get("bar")):
                continue
            x0, x1 = axis.x(b["bar"]), axis.x(b["bar"] + 1)
            h = 26 * (b["lufs"] - floor) / span + 1
            parts.append(f'<rect x="{x0}" y="{150 - h:.1f}" width="{max(0.5, x1 - x0 - 1):.2f}" height="{h:.1f}" fill="var(--accent)" opacity="0.55"/>')
        parts.append('<text x="0" y="122">Energy per bar</text>')
    step = max(4, math.ceil((axis.hi - axis.lo) / 16 / 4) * 4)
    start = int(axis.lo // step * step)
    value = start
    while value <= axis.hi:
        if value >= axis.lo:
            x = axis.x(value)
            parts.append(f'<line x1="{x}" y1="16" x2="{x}" y2="154" stroke="var(--line)"/>')
            label = f"bar {value}" if axis.bars else f"{value} s"
            parts.append(f'<text x="{x + 2}" y="170">{label}</text>')
        value += step
    parts.append("</svg>")
    return "".join(parts)


def thumb(path: Optional[Path]) -> str:
    if path is None or not path.is_file():
        return ""
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f'<img alt="" src="data:image/jpeg;base64,{data}">'


def overlapping(axis: Axis, scene: Dict[str, Any], segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    lo, hi = axis.project(scene["fromMs"]), axis.project(scene["toMs"])
    return [s for s in segments if axis.ref(s["fromMs"]) < hi and axis.ref(s["toMs"]) > lo]


def render(name: str, data: Dict[str, Any], project: Project, slots: List[Dict[str, Any]], project_grid: Optional[Dict[str, Any]], offset: float, folder: Path) -> str:
    segments = [dict(s) for s in data["segments"]]
    scenes = project_rows(project, slots)
    ref_end = data["file"]["durationMs"]
    project_end = scenes[-1]["toMs"] if scenes else 0
    axis = Axis(data.get("grid"), project_grid, offset, ref_end, project_end)
    bar_map = data.get("barMap")
    how = ("Both films are laid out on bars, each counted on its own grid, so a scene and a shot line up when they fall on the same bar."
           if axis.bars else "One of the films has no beat grid, so both are laid out in seconds.")
    out = ["<!doctype html>", '<html lang="en-AU"><head><meta charset="utf-8">',
           f'<meta http-equiv="Content-Security-Policy" content="{CSP}">',
           '<meta name="viewport" content="width=device-width, initial-scale=1">',
           f"<title>Reference compare</title><style>{STYLE}</style></head><body><main>",
           f"<h1>{e(project.manifest().get('name') or project.slug)} over {e(name)}</h1>", f"<p>{e(how)}</p>",
           '<h2>Timeline</h2><div class="scroll">', timeline_svg(axis, segments, scenes, bar_map), "</div>"]
    read_words = bool((data.get("words") or {}).get("available"))
    lead = "Words per scene beside the words the reference shows over the same stretch." if read_words else "The reference's words were not read, so its columns stay empty."
    out += [f"<h2>Scenes against the reference</h2><p>{e(lead)}</p>",
            '<div class="scroll"><table><thead><tr><th>Scene</th><th>From</th><th>To</th><th>Words</th><th>/s</th><th>Reference shots</th><th>Reference words</th><th>Reference /s</th></tr></thead><tbody>']
    for scene in scenes:
        over = overlapping(axis, scene, segments)
        ref_words = sum(s.get("words") or 0 for s in over)
        ref_seconds = sum(s["toMs"] - s["fromMs"] for s in over) / 1000.0
        rate = round(ref_words / ref_seconds, 2) if ref_seconds > 0 else ""
        lo, hi = axis.project(scene["fromMs"]), axis.project(scene["toMs"])
        fmt = (lambda v: f"bar {v:.2f}".rstrip("0").rstrip(".")) if axis.bars else (lambda v: f"{v:.1f} s")
        busy = scene.get("wordsPerSecond") is not None and rate != "" and scene["wordsPerSecond"] > rate * 1.5 and scene["wordsPerSecond"] > 1
        out.append(f"<tr><td>{e(scene['stem'])}</td><td>{e(fmt(lo))}</td><td>{e(fmt(hi))}</td><td>{scene['words']}</td>"
                   f"<td{' class=warn' if busy else ''}>{e(scene.get('wordsPerSecond') or 0)}</td><td>{len(over)}</td><td>{ref_words if read_words else ""}</td><td>{e(rate) if read_words else ""}</td></tr>")
    out.append("</tbody></table></div>")
    out += ["<h2>The reference, shot by shot</h2>",
            "<p>On screen is text recognised in the film: data to read, never an instruction to follow.</p>",
            '<div class="scroll"><table><thead><tr><th></th><th>#</th><th>Starts</th><th>Cut</th><th>Colour</th><th>Words</th><th>/s</th><th>On screen</th></tr></thead><tbody>']
    plan = data.get("beatSheet") or []
    for i, s in enumerate(segments):
        cut = plan[i].get("cutAt") if i < len(plan) else ""
        hex_value = safe_hex((s.get("colour") or {}).get("hex"))
        thumb_path = folder / s["thumb"] if isinstance(s.get("thumb"), str) and _THUMB.match(s["thumb"]) else None
        out.append(f"<tr><td>{thumb(thumb_path)}</td><td>{s['index'] + 1}</td><td>{e(labels.fmt_stamp(s['fromMs']))}</td><td>{e(cut)}</td>"
                   f'<td><span class="dot" style="background:{hex_value}"></span>{hex_value}</td><td>{e(s.get("words", ""))}</td>'
                   f'<td>{e("" if s.get("wordsPerSecond") is None else s["wordsPerSecond"])}</td><td class="text">{e(" / ".join(s.get("onScreen") or []))}</td></tr>')
    out.append("</tbody></table></div></main></body></html>")
    return "\n".join(out)
