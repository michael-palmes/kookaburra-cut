"""The flash check: the app's own detector (`<app> check flashes`, gated on `edit caps` listing it) plus ffmpeg's `photosensitivity` pre-check, with every issue placed on the project's scenes."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..util import EXIT_ENV, KbError, atomic_write_json, now_ms
from ..video import appcli
from ..video.passes import Tools
from . import accepts as acc
from . import strips as st
from . import timeline as tl

CHECK_TIMEOUT_S = 3600
PRECHECK_TIMEOUT_S = 3600
# ffmpeg's badness with a one-second window: about 5.5 at 3 flashes a second, 6.75 at 3.75 (measured on full-frame strobes).
LOOK_HERE_BADNESS = 6.4
STANDARDS = ("wcag", "itu", "both")

_FRAME_RE = re.compile(r"^\[metadata@ps @ 0x[0-9a-f]+\] frame:\s*\d+\s+pts:\s*\S+\s+pts_time:\s*(\S+)")
_BADNESS_RE = re.compile(r"^\[metadata@ps @ 0x[0-9a-f]+\] lavfi\.photosensitivity\.badness=([0-9.]+)")


def precheck_args(ffmpeg: str, path: Path, fps: float) -> List[str]:
    frames = max(1, int(round(fps)))
    vf = f"scale=1024:-2:flags=area,photosensitivity=frames={frames}:bypass=1,metadata@ps=mode=print"
    return [ffmpeg, "-hide_banner", "-nostdin", "-v", "repeat+info", "-i", str(path), "-an", "-sn", "-dn", "-vf", vf, "-f", "null", "-"]


def parse_precheck(stderr: str) -> Dict[str, Any]:
    """Per-frame badness from metadata=print, folded into `look here` spans (badness at or over 6.4, gaps under 1 s merged)."""
    samples: List[List[float]] = []
    t: Optional[float] = None
    for line in stderr.splitlines():
        m = _FRAME_RE.match(line)
        if m:
            try:
                t = float(m.group(1))
            except ValueError:
                t = None
            continue
        m = _BADNESS_RE.match(line)
        if m and t is not None:
            samples.append([t * 1000.0, float(m.group(1))])
    worst = max((b for _, b in samples), default=0.0)
    spans: List[Dict[str, Any]] = []
    for ms, badness in samples:
        if badness < LOOK_HERE_BADNESS:
            continue
        if spans and ms - spans[-1]["endMs"] <= 1000:
            spans[-1]["endMs"] = int(round(ms))
            spans[-1]["badness"] = max(spans[-1]["badness"], round(badness, 2))
        else:
            spans.append({"startMs": int(round(ms)), "endMs": int(round(ms)), "badness": round(badness, 2)})
    return {"maxBadness": round(worst, 2), "threshold": LOOK_HERE_BADNESS, "candidates": spans, "frames": len(samples)}


def precheck(tools: Tools, path: Path, fps: float) -> Dict[str, Any]:
    try:
        proc = subprocess.run(precheck_args(tools.ffmpeg, path, fps), capture_output=True, text=True, timeout=PRECHECK_TIMEOUT_S, errors="replace")
    except OSError as e:
        raise KbError(f"could not run ffmpeg: {e.strerror}", EXIT_ENV) from None
    except subprocess.TimeoutExpired:
        raise KbError(f"the photosensitivity pre-check took longer than {PRECHECK_TIMEOUT_S} s", EXIT_ENV) from None
    if proc.returncode != 0:
        tail = proc.stderr.strip().splitlines()[-1:] or ["no output"]
        raise KbError(f"the photosensitivity pre-check failed: {tail[0][-300:]}", EXIT_ENV)
    return parse_precheck(proc.stderr)


def app_cli() -> Optional[appcli.CliInfo]:
    """The app binary when its caps list `checks: ["flashes"]` (an older one would start the whole app); else None."""
    try:
        info = appcli.locate()
        caps = appcli.caps(info)
    except KbError:
        return None
    checks = caps.get("checks")
    return info if isinstance(checks, list) and "flashes" in checks else None


def run_cli(info: appcli.CliInfo, path: Path, standard: str) -> Dict[str, Any]:
    argv = [info.path, "check", "flashes", "--file", str(path.resolve()), "--standard", standard]
    try:
        proc = subprocess.run(argv, capture_output=True, timeout=CHECK_TIMEOUT_S, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise KbError(f"the app's flash check took longer than {CHECK_TIMEOUT_S} s", EXIT_ENV) from None
    except OSError as e:
        raise KbError(f"could not run {info.path}: {e.strerror}", EXIT_ENV) from None
    out = proc.stdout.decode("utf-8", "replace").strip()
    data: Any = None
    for candidate in (out, out.splitlines()[-1] if out else ""):
        try:
            data = json.loads(candidate)
            break
        except ValueError:
            continue
    if not isinstance(data, dict):
        tail = proc.stderr.decode("utf-8", "replace").strip()[-300:]
        raise KbError(f"the app's flash check gave no JSON (exit {proc.returncode}): {tail or 'no output'}", EXIT_ENV)
    if not data.get("ok") or not isinstance(data.get("report"), dict):
        code = EXIT_ENV if proc.returncode == 2 else 1
        raise KbError(f"the app's flash check failed: {data.get('error') or 'no report'}", code)
    return data["report"]


def place_issues(report: Dict[str, Any], slots: List[Dict[str, Any]], poster_ms: float) -> None:
    """Fills each issue's `scene` from the timeline (file time minus any poster frame) and its project time (`projectMs`)."""
    for issue in report.get("issues") or []:
        if not isinstance(issue, dict):
            continue
        at = max(0.0, float(issue.get("startMs") or 0) - poster_ms)
        issue["projectMs"] = int(round(at))
        where = tl.scene_at(slots, at) if slots else None
        if where is None:
            continue
        index, local = where
        issue["scene"] = {"index": index, "stem": slots[index].get("stem"), "localMs": int(round(local))}


def check(tools: Tools, path: Path, fps: float, *, standard: str = "both", slots: Optional[List[Dict[str, Any]]] = None,
          poster_ms: float = 0.0) -> Dict[str, Any]:
    """The flash report: the app's detector when it qualifies (else `gate: unavailable`), always with the pre-check."""
    pre = precheck(tools, path, fps)
    info = app_cli()
    if info is None:
        return {"version": 1, "approximate": True, "gate": "unavailable", "ok": None, "issues": [], "source": "file",
                "precheck": pre, "note": "the app's flash detector is not available (update Kookaburra Cut); only ffmpeg's pre-check ran"}
    report = run_cli(info, path, standard)
    report["gate"] = "app"
    report["precheck"] = pre
    place_issues(report, slots or [], poster_ms)
    return report


def strips_folder(project: Any, film: Path) -> Path:
    """`<film>.flashes/` beside a film inside the project (exports/, .kb/verify/), else a kb film run folder."""
    from . import report as rp

    try:
        film.resolve().relative_to(project.root.resolve())
    except ValueError:
        return rp.film_dir(project, "flashes")
    return film.with_name(film.name + ".flashes")


def last_path(project: Any) -> Path:
    from .. import lock

    return lock.kb_dir(project) / "flashes" / "last.json"


def settle(project: Any, report: Optional[Dict[str, Any]], source: str, *, film: Optional[Path] = None, tools: Optional[Tools] = None,
           fps: Optional[float] = None, poster_ms: float = 0.0, meta: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """After every flash check: the person's accepted warnings marked, strips of a film's flagged moments, and the report kept as the last check (`kb flashes accept` reads it)."""
    if not isinstance(report, dict):
        return report
    acc.apply(report, acc.load(project))
    if film is not None and tools is not None and fps:
        try:
            st.attach(report, st.film_strips(tools.ffmpeg, film, report, strips_folder(project, film), fps, poster_ms))
        except (KbError, OSError) as e:
            report["stripsError"] = getattr(e, "message", None) or str(e)
    try:
        atomic_write_json(last_path(project), dict(meta or {}, version=1, atMs=now_ms(), source=source,
                                                   file=str(film) if film else None, report=report))
    except (KbError, OSError):
        pass
    return report


def load_last(project: Any) -> Optional[Dict[str, Any]]:
    try:
        doc = json.loads(last_path(project).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) and isinstance(doc.get("report"), dict) else None


def open_warnings(report: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Warnings nobody has accepted yet."""
    return [i for i in (report or {}).get("issues") or [] if isinstance(i, dict) and i.get("severity") != "fail" and not i.get("accepted")]


def accepted(report: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [i for i in (report or {}).get("issues") or [] if isinstance(i, dict) and i.get("accepted")]


def failures(report: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not report:
        return []
    return [i for i in report.get("issues") or [] if isinstance(i, dict) and i.get("severity") == "fail"]


def issue_line(issue: Dict[str, Any]) -> str:
    scene = issue.get("scene") or {}
    where = f" in {scene.get('stem')} at {scene.get('localMs', 0) / 1000:.2f}s" if scene.get("stem") else ""
    head = f"{issue.get('type')} flash ({issue.get('standard')}) at {issue.get('tc')}{where}"
    taken = issue.get("accepted") if isinstance(issue.get("accepted"), dict) else None
    if taken:
        return f"accepted: {head} ({taken.get('why')})"
    strip = f"; Read {issue['strip']}" if isinstance(issue.get("strip"), str) else ""
    return (f"{issue.get('severity')}: {head}, {issue.get('flashesPerSecond')} a second over {issue.get('areaPct')}% "
            f"(ΔL {issue.get('deltaL')}); {issue.get('hint')}{strip}")


def summary_lines(report: Optional[Dict[str, Any]]) -> List[str]:
    if not report:
        return []
    lines: List[str] = []
    if report.get("gate") == "unavailable":
        lines.append(f"flashes: gate unavailable ({report.get('note')})")
    else:
        fails = failures(report)
        warns = open_warnings(report)
        taken = accepted(report)
        verdict = "FAIL" if fails else "ok"
        extra = f", {len(taken)} accepted" if taken else ""
        lines.append(f"flashes: {verdict} ({len(fails)} fail, {len(warns)} warn{extra}; approximate, {', '.join(report.get('standards') or [])})")
        lines += [f"  {issue_line(i)}" for i in report.get("issues") or [] if isinstance(i, dict)]
    pre = report.get("precheck") or {}
    if pre:
        spots = pre.get("candidates") or []
        head = f"  pre-check: max badness {pre.get('maxBadness')}"
        if spots:
            head += "; look here: " + ", ".join(f"{s['startMs'] / 1000:.2f}-{s['endMs'] / 1000:.2f}s ({s['badness']})" for s in spots[:6])
        lines.append(head)
    return lines
