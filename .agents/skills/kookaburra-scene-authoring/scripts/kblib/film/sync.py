"""`kb sync-check FILE`: each cut and large visual change in a finished film against its nearest beat, timed as a player shows it (edit lists honoured, any poster frame taken off)."""

from __future__ import annotations

import argparse
import bisect
import json
import math
import statistics
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..beats import cache as beat_cache
from ..beats import commands as beat_commands
from ..beats import model as beat_model
from ..catalog import load_catalog
from ..util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, emit, emit_json, ok_envelope
from ..video import passes
from . import timeline as tl

CHANGE_PCT = 8.0
CUT_FLOOR_PCT = 1.0
PEAK_RATIO = 2.0
REFRACTORY_MS = 120.0
SEAM_FRAMES = 2
TOLERANCE_MS = {"authored": 2.0, "bpm": 2.0, "detected": 25.0}
TEXT_EVENTS = 30

EPILOG = """\
Finds each cut and large picture change (frame-to-frame difference of the decoded film) and measures it against
the nearest beat: the project's authored grid, else its analysed beats, else --bpm N [--offset MS]. Times are the
film's presentation times measured from the soundtrack's start (edit lists honoured), minus a leading poster frame
(from the export record, else a frame count one over the project's; --poster-frame overrides).

A cut placed on a beat shows on the first frame at or after it, so 0 to 1 frame late (0 to 33.3 ms at 30 fps,
0 to 16.7 ms at 60) is the frame grid, not drift. Never nudge the beat grid to hide that.

  kb sync-check exports/product-tour-16x9.mp4
  kb sync-check .kb/verify/<stamp>/product-tour-16x9-custom.mp4 --json
  kb sync-check ~/Downloads/clip.mp4 --bpm 128 --offset 250"""


# ── the film's clock ─────────────────────────────────────────────────────────


def stream_starts(tools: passes.Tools, film: Path) -> Dict[str, Optional[float]]:
    """Presentation start (ms) of the format and the first video and audio streams, edit lists honoured."""
    proc = subprocess.run([tools.ffprobe, "-v", "error", "-print_format", "json", "-show_entries",
                           "stream=codec_type,start_time:format=start_time", str(film)],
                          capture_output=True, text=True, timeout=120, errors="replace")
    if proc.returncode != 0:
        raise KbError(f"ffprobe could not read {film.name}: {proc.stderr.strip()[-300:]}", EXIT_PROBLEMS)
    data = json.loads(proc.stdout or "{}")

    def ms(value: Any) -> Optional[float]:
        try:
            return float(value) * 1000.0
        except (TypeError, ValueError):
            return None

    out: Dict[str, Optional[float]] = {"format": ms((data.get("format") or {}).get("start_time")), "video": None, "audio": None}
    for s in data.get("streams") or []:
        kind = s.get("codec_type")
        if kind in ("video", "audio") and out[kind] is None:
            out[kind] = ms(s.get("start_time"))
    return out


# ── events ───────────────────────────────────────────────────────────────────


def frame_changes(small: bytes, size: int, frames: int) -> List[float]:
    """Mean absolute change from the previous frame, % of full scale (frame 0 is 0)."""
    out = [0.0]
    for i in range(1, frames):
        a = small[(i - 1) * size:i * size]
        b = small[i * size:(i + 1) * size]
        out.append(100.0 * sum(abs(x - y) for x, y in zip(a, b)) / (255.0 * size))
    return out


def detect(changes: List[float], times: List[float], first: int, threshold: float = CHANGE_PCT) -> List[int]:
    """Frames where the picture jumps: at least `threshold` % and twice the change into the frame before, one per 120 ms."""
    out: List[int] = []
    for i in range(max(1, first), len(changes)):
        d = changes[i]
        if d < threshold or d < PEAK_RATIO * changes[i - 1]:
            continue
        if out and times[i] - times[out[-1]] < REFRACTORY_MS:
            continue
        out.append(i)
    return out


def cut_seams(slots: List[Dict[str, Any]], fps: float, offset: int) -> List[Dict[str, Any]]:
    """Each hard cut on the timeline with the film frame that should show its new scene first."""
    return [{"frame": tl.frame_at(b["startMs"], fps, offset), "from": a.get("stem"), "to": b.get("stem"), "index": b["index"]}
            for a, b in zip(slots, slots[1:]) if not b.get("transitionIn")]


def events(changes: List[float], times: List[float], slots: List[Dict[str, Any]], fps: float, offset: int,
           threshold: float = CHANGE_PCT) -> List[Dict[str, Any]]:
    """Detected jumps, labelled a cut on a timeline cut; a quiet cut is the biggest change within two frames of its seam."""
    found = {i: {"frame": i, "kind": "change"} for i in detect(changes, times, offset + 1, threshold)}
    last = len(changes) - 1
    for seam in cut_seams(slots, fps, offset):
        lo, hi = max(offset + 1, seam["frame"] - SEAM_FRAMES), min(last, seam["frame"] + SEAM_FRAMES)
        if lo > hi:
            continue
        near = [i for i in found if lo <= i <= hi]
        pick = min(near, key=lambda i: abs(i - seam["frame"])) if near else max(range(lo, hi + 1), key=lambda i: changes[i])
        if pick not in found and changes[pick] < CUT_FLOOR_PCT:
            continue
        found[pick] = {"frame": pick, "kind": "cut", "from": seam["from"], "to": seam["to"], "scene": {"index": seam["index"], "stem": seam["to"]}}
    for ev in found.values():
        ev["changePct"] = round(changes[ev["frame"]], 2)
    return [found[i] for i in sorted(found)]


# ── beats ────────────────────────────────────────────────────────────────────


def bpm_beats(bpm: float, offset_ms: float, end_ms: float) -> List[float]:
    period = 60000.0 / bpm
    k = math.ceil(-offset_ms / period)
    out: List[float] = []
    while offset_ms + k * period <= end_ms:
        out.append(offset_ms + k * period)
        k += 1
    return out


def project_beats(project: Any, end_ms: float) -> Tuple[List[float], Dict[str, Any]]:
    """The project's beats in project ms: the authored grid, else the soundtrack analysis; empty when it has neither."""
    manifest = project.manifest()
    m = beat_model.project_music(manifest)
    grid = beat_model.grid_of(m)
    if grid:
        beats, _bars = beat_model.grid_beats(m, end_ms)  # type: ignore[arg-type]
        return beats, {"source": "authored", "bpm": grid["bpm"], "beatMs": round(60000 / grid["bpm"], 3), "offsetMs": grid["offsetMs"]}
    analysis, _path, _digest = beat_commands.load_analysis(project, manifest)
    if analysis is not None and analysis.get("version") in beat_cache.SUPPORTED_VERSIONS:
        offset = beat_commands.start_offset(manifest)
        beats = [t - offset for t in beat_cache.beat_times(analysis) if 0 <= t - offset <= end_ms]
        bpm, interval = beat_cache.tempo(analysis)
        return beats, {"source": "detected", "bpm": bpm, "beatMs": interval}
    return [], {"source": None}


def nearest(beats: List[float], ms: float) -> Tuple[int, float]:
    i = bisect.bisect_left(beats, ms)
    best = min((j for j in (i - 1, i) if 0 <= j < len(beats)), key=lambda j: abs(beats[j] - ms))
    return best, beats[best]


def place(evs: List[Dict[str, Any]], beats: List[float], beat_ms: float, window_ms: float) -> None:
    for ev in evs:
        index, at = nearest(beats, ev["projectMs"])
        ev.update(beat=index, beatMs=round(at, 3), offsetMs=round(ev["projectMs"] - at, 2), onBeat=abs(ev["projectMs"] - at) <= window_ms)


def stats(offsets: List[float]) -> Dict[str, Optional[float]]:
    if not offsets:
        return {"medianMs": None, "worstMs": None}
    return {"medianMs": round(statistics.median(offsets), 2), "worstMs": max(offsets, key=abs)}


def verdict(median: Optional[float], frame_ms: float, tolerance: float) -> Optional[str]:
    if median is None:
        return None
    if median < -tolerance:
        return "early"
    return "late" if median > frame_ms + tolerance else "in sync"


# ── the command ──────────────────────────────────────────────────────────────


def analyse(kbctx: Any) -> Dict[str, Any]:
    from . import cli as filmcli

    args = kbctx.args
    if args.offset is not None and args.bpm is None:
        raise KbError("--offset needs --bpm", EXIT_ENV, kind="usage", hint="kb sync-check FILE --bpm 120 --offset 250")
    if args.bpm is not None and not 20 <= args.bpm <= 400:
        raise KbError(f"--bpm {args.bpm:g} is out of range; give 20 to 400", EXIT_ENV, kind="usage")
    project = kbctx.project
    film = filmcli.resolve_film(args.file, project)
    tools = passes.find_tools()
    ctx = filmcli.film_context(project, film, tools, load_catalog())
    prof = passes.profile_pass(tools, film)
    fps = ctx["fps"]
    frame_ms = 1000.0 / fps
    slots = ctx["slots"]
    record_poster = ctx["expected"].get("posterFrame") if ctx["record"] else None
    if args.poster_frame in ("on", "off"):
        poster = args.poster_frame == "on"
    elif isinstance(record_poster, bool):
        poster = record_poster
    else:
        poster = prof["frames"] == tl.export_frames(tl.timeline_total_ms(slots), fps) + 1
    offset = 1 if poster else 0
    poster_ms = frame_ms if poster else 0.0
    starts = stream_starts(tools, film)
    has_audio = ctx["facts"].get("audio") is not None and starts["audio"] is not None
    origin = (starts["audio"] if has_audio else starts["video"]) or 0.0
    shift = (starts["format"] or 0.0) - origin - poster_ms
    sw, sh = prof["small"]
    changes = frame_changes(prof["smallData"], sw * sh, prof["frames"])
    times = list(prof["ptsMs"])
    film_ms = max(0.0, prof["endMs"] + shift)
    if args.bpm is not None:
        beats = bpm_beats(args.bpm, args.offset or 0.0, film_ms)
        grid = {"source": "bpm", "bpm": args.bpm, "beatMs": round(60000 / args.bpm, 3), "offsetMs": args.offset or 0.0}
    else:
        beats, grid = project_beats(project, film_ms)
    if not beats:
        raise KbError("no beats to measure against: the project has no beat grid or soundtrack analysis", EXIT_PROBLEMS, kind="invalid",
                      hint="./kb beats set-grid --from-analysis (after ./kb song analyse), or pass --bpm N [--offset MS]")
    gaps = [b - a for a, b in zip(beats, beats[1:])]
    beat_ms = float(grid.get("beatMs") or (statistics.median(gaps) if gaps else 500.0))
    window = args.window if args.window is not None else beat_ms / 4
    evs = events(changes, times, slots, fps, offset, args.threshold)
    for ev in evs:
        ev["fileMs"] = round(times[ev["frame"]] + (starts["format"] or 0.0), 2)
        ev["projectMs"] = round(times[ev["frame"]] + shift, 2)
        where = tl.scene_at(slots, ev["projectMs"]) if slots and "scene" not in ev else None
        if where is not None:
            ev["scene"] = {"index": where[0], "stem": slots[where[0]].get("stem")}
    place(evs, beats, beat_ms, window)
    on = [e for e in evs if e["onBeat"]]
    summary = dict(stats([e["offsetMs"] for e in on]), events=len(evs), onBeat=len(on))
    worst = next((e for e in on if e["offsetMs"] == summary["worstMs"]), None)
    summary["worstAtMs"] = worst["projectMs"] if worst else None
    summary["worstScene"] = (worst.get("scene") or {}).get("stem") if worst else None
    tolerance = TOLERANCE_MS.get(grid["source"], 2.0)
    summary["verdict"] = verdict(summary["medianMs"], frame_ms, tolerance)
    scenes = []
    for slot in slots:
        mine = [e["offsetMs"] for e in on if (e.get("scene") or {}).get("index") == slot["index"]]
        if mine:
            scenes.append(dict(stats(mine), index=slot["index"], stem=slot.get("stem"), events=len(mine)))
    warnings: List[str] = []
    if not has_audio:
        warnings.append("the film has no audio stream: offsets are timed from the picture's start")
    if summary["verdict"] in ("late", "early"):
        warnings.append(f"the median event lands {summary['medianMs']:+.1f} ms off its beat, beyond the frame grid's 0 to {frame_ms:.1f} ms: "
                        "the cuts or this file are off the beat (the app's export adds nothing past the frame grid); "
                        "check scene durations and cut-at positions with ./kb beats")
    if grid["source"] == "detected":
        warnings.append("beats come from the soundtrack analysis, which carries the tracker's own error (tens of ms)")
    return {
        "file": str(film), "record": ctx["record"], "fps": round(fps, 4), "frameMs": round(frame_ms, 3), "posterFrame": poster,
        "posterMs": round(poster_ms, 3), "starts": {k: (round(v, 3) if v is not None else None) for k, v in starts.items()},
        "clock": "audio" if has_audio else "video", "editLists": "honoured", "expectedLateMs": [0, round(frame_ms, 3)],
        "grid": dict(grid, count=len(beats)), "windowMs": round(window, 2), "summary": summary, "scenes": scenes,
        "events": evs, "warnings": warnings,
    }


def emit_text(p: Dict[str, Any]) -> None:
    s, g = p["summary"], p["grid"]
    emit(f"sync-check: {p['file']}")
    poster = f", a poster frame leads ({p['posterMs']:.1f} ms taken off)" if p["posterFrame"] else ""
    emit(f"  film     {p['fps']:g} fps{poster}; timed from the {p['clock']} start as a player shows it (edit lists honoured)")
    src = {"authored": "the authored grid", "detected": "the analysed beats", "bpm": "--bpm"}[g["source"]]
    emit(f"  beats    {src}: {g['bpm']} bpm, {g['beatMs']} ms a beat, {g['count']} beats")
    if s["medianMs"] is None:
        emit(f"  result   {s['events']} events, none within {p['windowMs']:.0f} ms of a beat")
    else:
        emit(f"  result   {s['verdict']}: median {s['medianMs']:+.1f} ms, worst {s['worstMs']:+.1f} ms at {s['worstAtMs'] / 1000:.2f}s"
             f"{' (' + s['worstScene'] + ')' if s.get('worstScene') else ''}; {s['onBeat']} of {s['events']} events within {p['windowMs']:.0f} ms of a beat")
    emit(f"  expect   0 to {p['frameMs']:.1f} ms late: a cut on a beat shows on the first frame at or after it")
    for sc in p["scenes"]:
        emit(f"  scene    {sc['stem']}: {sc['events']} on beat, median {sc['medianMs']:+.1f} ms, worst {sc['worstMs']:+.1f} ms")
    for ev in p["events"][:TEXT_EVENTS]:
        what = f"cut {ev['from']} -> {ev['to']}" if ev["kind"] == "cut" else f"change {ev['changePct']:.0f}%"
        where = f" in {ev['scene']['stem']}" if ev.get("scene") and ev["kind"] != "cut" else ""
        tail = f"{ev['offsetMs']:+.1f} ms from beat {ev['beat']}" + ("" if ev["onBeat"] else " (between beats, not counted)")
        emit(f"  {ev['projectMs'] / 1000:8.3f}s  {what}{where}: {tail}")
    if len(p["events"]) > TEXT_EVENTS:
        emit(f"  ... {len(p['events']) - TEXT_EVENTS} more (--json lists every event)")
    for w in p["warnings"]:
        emit(f"  warn     {w}")


def cmd_sync_check(kbctx: Any) -> int:
    payload = analyse(kbctx)
    if kbctx.json:
        emit_json(ok_envelope("sync-check", payload))
    else:
        emit_text(payload)
    return EXIT_OK


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    p = sub.add_parser("sync-check", help="each cut and big picture change in a film against its nearest beat, in ms",
                       description="measure a finished film's cuts against the beat grid, as a player shows them",
                       epilog=EPILOG, formatter_class=Formatter, parents=[common])
    p.add_argument("file", metavar="FILE", help="the exported film")
    p.add_argument("--bpm", type=float, metavar="N", help="measure against a steady N bpm grid instead of the project's music")
    p.add_argument("--offset", type=float, metavar="MS", help="with --bpm: a beat's time in the film, poster frame excluded (default 0)")
    p.add_argument("--poster-frame", choices=("auto", "on", "off"), default="auto", help="a leading poster frame (default: the record, else the frame count)")
    p.add_argument("--threshold", type=float, default=CHANGE_PCT, metavar="PCT", help=f"picture change that counts, %% of full scale (default {CHANGE_PCT:g})")
    p.add_argument("--window", type=float, metavar="MS", help="how near a beat an event must be to count (default a quarter beat)")
    p.set_defaults(fn=cmd_sync_check)
