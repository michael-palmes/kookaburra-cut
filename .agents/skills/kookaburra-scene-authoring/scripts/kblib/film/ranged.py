"""The ranged flash check: a span of the film rendered by the app's render window through the export path at 360p and 30 fps and fed to the export's own flash detector, with a strip of each flagged moment. Seconds for a scene, never a full export (docs/agent-kit.md, "Ranged checks")."""

from __future__ import annotations

import re
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .. import bridge, music, queue
from ..util import EXIT_ENV, EXIT_PROBLEMS, KbError, atomic_write_json, emit_err
from . import flashes as fl
from . import strips as st
from . import timeline as tl

FPS = 30
# Long spans go as several requests overlapping by a second, so no flash window falls between two.
CHUNK_MS = 60_000
OVERLAP_MS = 1000
# A scene's check reaches a second either side, so the cuts into and out of it are counted.
SCENE_PAD_MS = 1000
TIMEOUT_S = 900.0
KEEP_RUNS = 10

_TC = re.compile(r"^(?:(\d+):)?(\d+(?:\.\d+)?)$")
_BARS = re.compile(r"^bars?:(\d+)(?:-(\d+))?$", re.ASCII)


def parse_time(text: str) -> Optional[float]:
    """Film seconds or a timecode (`35.4`, `00:35.4`, `1:02`) as ms; None otherwise."""
    m = _TC.match(text.strip())
    if not m:
        return None
    return (int(m.group(1) or 0) * 60 + float(m.group(2))) * 1000.0


def resolve_point(text: str, project: Any) -> float:
    """A span end: film seconds, a timecode or a musical position, as project ms."""
    ms = parse_time(text)
    if ms is not None:
        return ms
    if music.is_position(text):
        from ..beats import model

        r = model.resolve(text, model.project_music(project.manifest()))
        if not r["ok"]:
            raise model.position_error(text, r, "--range")
        return float(r["projectMs"])
    raise KbError(f'"{text}" is neither film seconds, a timecode nor a musical position', EXIT_ENV, kind="usage",
                  hint="use --range bar:13-16, --range 12-20 (seconds), --range 00:12-00:20 or --range bar:13..cue:drop")


def parse_span(text: str, project: Any, total_ms: float) -> Dict[str, Any]:
    """`bar:A-B` (bars A to B, through to bar B+1's downbeat), `A-B` (seconds or timecodes) or `FROM..TO` (any two points)."""
    raw = text.strip()
    bars = _BARS.match(raw)
    if bars:
        a = int(bars.group(1))
        b = int(bars.group(2) or a)
        if b < a:
            raise KbError(f"--range {raw}: the last bar comes before the first", EXIT_ENV, kind="usage")
        start, end = resolve_point(f"bar:{a}", project), resolve_point(f"bar:{b + 1}", project)
    elif ".." in raw:
        left, right = raw.split("..", 1)
        start, end = resolve_point(left, project), resolve_point(right, project)
    elif raw.count("-") == 1:
        left, right = raw.split("-", 1)
        if parse_time(left) is None or parse_time(right) is None:
            raise KbError(f"--range {raw}: use seconds or timecodes either side of -, or FROM..TO for positions", EXIT_ENV, kind="usage")
        start, end = resolve_point(left, project), resolve_point(right, project)
    else:
        raise KbError(f"--range {raw} is not a span", EXIT_ENV, kind="usage",
                      hint="use --range bar:13-16, --range 12-20, or --range bar:13..cue:drop")
    if end <= start:
        raise KbError(f"--range {raw} ends before it starts", EXIT_ENV, kind="usage")
    start, end = max(0.0, start), min(float(total_ms), end)
    if end <= start:
        raise KbError(f"--range {raw} covers no part of the {total_ms / 1000:.2f}s film", EXIT_PROBLEMS, kind="invalid")
    return {"startMs": start, "endMs": end, "label": raw}


def scene_span(slots: List[Dict[str, Any]], index: int, pad_ms: float = SCENE_PAD_MS) -> Dict[str, Any]:
    slot = slots[index]
    total = tl.timeline_total_ms(slots)
    return {"startMs": max(0.0, float(slot["startMs"]) - pad_ms), "endMs": min(float(total), float(slot["endMs"]) + pad_ms),
            "label": str(slot.get("stem") or index)}


def merge_spans(spans: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Overlapping or touching spans as one."""
    out: List[Dict[str, Any]] = []
    for s in sorted(spans, key=lambda s: s["startMs"]):
        if out and s["startMs"] <= out[-1]["endMs"]:
            out[-1] = {"startMs": out[-1]["startMs"], "endMs": max(out[-1]["endMs"], s["endMs"]), "label": f"{out[-1]['label']}+{s['label']}"}
        else:
            out.append(dict(s))
    return out


def chunks(span: Dict[str, Any], chunk_ms: float = CHUNK_MS, overlap_ms: float = OVERLAP_MS) -> List[Tuple[float, float]]:
    a, b = float(span["startMs"]), float(span["endMs"])
    out: List[Tuple[float, float]] = []
    while True:
        end = min(b, a + chunk_ms)
        out.append((a, end))
        if end >= b:
            return out
        a = end - overlap_ms


def same_moment(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    """Two chunks saw the same flash: same kind and standard, overlapping spans."""
    return (a.get("type") == b.get("type") and a.get("standard") == b.get("standard")
            and float(a["startMs"]) <= float(b["endMs"]) and float(b["startMs"]) <= float(a["endMs"]))


def merge_issues(issues: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One issue per moment across overlapping chunks; a failure outranks a warning."""
    out: List[Dict[str, Any]] = []
    for issue in sorted(issues, key=lambda i: (i["startMs"], i.get("standard") or "", i.get("type") or "")):
        twin = next((o for o in out if same_moment(o, issue)), None)
        if twin is None:
            out.append(issue)
        elif issue.get("severity") == "fail" and twin.get("severity") != "fail":
            out[out.index(twin)] = issue
    return sorted(out, key=lambda i: (i["startMs"], i.get("standard") or "", i.get("type") or ""))


def runs_root(project: Any) -> Path:
    from .. import lock

    return lock.kb_dir(project) / "flashes"


def run_folder(project: Any) -> Path:
    root = runs_root(project)
    root.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    folder, n = root / stamp, 2
    while folder.exists():
        folder, n = root / f"{stamp}-{n}", n + 1
    folder.mkdir()
    runs = sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name)
    for old in runs[:-KEEP_RUNS]:
        shutil.rmtree(old, ignore_errors=True)
    return folder


def request_chunk(ctx: Any, start: float, end: float, aspect: Optional[str], standard: str, action: str) -> Dict[str, Any]:
    body: Dict[str, Any] = {"project": ctx.project.project_id, "startMs": round(start, 3), "endMs": round(end, 3), "fps": FPS,
                            "flashes": True, "standard": standard}
    if aspect:
        body["aspect"] = aspect
    return bridge.require_ok(bridge.request("range", body, TIMEOUT_S, action, client=ctx.caller.name), "range")


def strips_from(ffmpeg: Optional[str], resp: Dict[str, Any], issues: List[Dict[str, Any]], folder: Path, n0: int) -> int:
    """Composes the app's before, at and after frames of each flagged moment into `folder`; returns the next strip number."""
    n = n0
    for row in resp.get("strips") or []:
        k = row.get("issue") if isinstance(row, dict) else None
        if not isinstance(k, int) or not 0 <= k < len(issues):
            continue
        frames = [f for f in row.get("frames") or [] if isinstance(f, dict)]
        paths = [Path(f["path"]) for f in frames if isinstance(f.get("path"), str)]
        if len(paths) != 3 or not all(p.is_file() for p in paths) or ffmpeg is None:
            continue
        issue = issues[k]
        out = st.compose(ffmpeg, paths, issue.get("region"), folder / st.strip_name(n, float(issue["startMs"])))
        issue["strip"] = str(out)
        issue["stripFrames"] = [{"role": f.get("role"), "frame": f.get("frame"), "tMs": f.get("tMs")} for f in frames]
        n += 1
    return n


def check(ctx: Any, spans: List[Dict[str, Any]], aspect: Optional[str], standard: str = "both", action: str = "kb check film") -> Dict[str, Any]:
    """The ranged report: every span (chunked) through the render window, issues in project time, placed on scenes, with strips; settled like any flash check."""
    project = ctx.project
    hb = bridge.require_app("range", action, project)
    queue.require_features(hb, {"range": "a ranged flash check"})
    try:
        from . import probe as pb

        ffmpeg: Optional[str] = pb.tools().ffmpeg
    except KbError:
        ffmpeg = None
    slots = tl.project_slots(project)
    folder = run_folder(project)
    issues: List[Dict[str, Any]] = []
    head: Dict[str, Any] = {}
    frames = 0
    render_ms = 0
    strip_n = 1
    started = time.monotonic()
    for span in merge_spans(spans):
        for a, b in chunks(span):
            emit_err(f"kb: checking flashes {a / 1000:.2f}-{b / 1000:.2f}s at {FPS} fps in the render window")
            resp = request_chunk(ctx, a, b, aspect, standard, action)
            report = resp.get("flashes") if isinstance(resp.get("flashes"), dict) else {}
            got = [i for i in report.get("issues") or [] if isinstance(i, dict)]
            try:
                strip_n = strips_from(ffmpeg, resp, got, folder, strip_n)
            except KbError as e:
                head["stripsError"] = e.message
            issues += got
            frames += int(resp.get("frames") or 0)
            render_ms += int((resp.get("timing") or {}).get("renderMs") or 0)
            if not head.get("standards"):
                head.update(standards=report.get("standards"), grid=report.get("grid"), size=resp.get("size"), format=resp.get("format"))
    merged = merge_issues(issues)
    out: Dict[str, Any] = {"version": 1, "approximate": True, "source": "range", "gate": "app", "fps": FPS, "frames": frames,
                           "standards": head.get("standards") or [], "grid": head.get("grid"), "size": head.get("size"),
                           "aspect": head.get("format") or aspect, "spans": [dict(s, startMs=int(round(s["startMs"])), endMs=int(round(s["endMs"])))
                                                                             for s in merge_spans(spans)],
                           "ok": not any(i.get("severity") == "fail" for i in merged), "issues": merged,
                           "renderMs": render_ms, "ms": int((time.monotonic() - started) * 1000), "folder": str(folder)}
    if head.get("stripsError"):
        out["stripsError"] = head["stripsError"]
    for issue in merged:
        issue["projectMs"] = int(issue["startMs"])
    fl.place_issues(out, slots, 0.0)
    fl.settle(project, out, "range", meta={"spans": out["spans"], "aspect": out["aspect"]})
    atomic_write_json(folder / "flashes.json", out)
    return out
