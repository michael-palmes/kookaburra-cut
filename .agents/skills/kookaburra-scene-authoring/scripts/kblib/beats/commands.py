"""kb beats: the beat grid, bars per scene, cues and sections, each resolved; and the writes that author them.

Every write is one transaction over project.json plus each sidecar whose `at` caches move (kblib.beats.model), and
validates exactly as the app's sanitiseAudioMusic does, so nothing kb writes is dropped on load.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .. import lock as lockmod
from .. import music
from ..film import timeline as tl
from ..project import MANIFEST, Project
from ..util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, emit, emit_err, fmt_secs, is_number, js_json
from . import cache, model

NO_SOUNDTRACK_HINT = "add one: ./kb assets add FILE, then ./kb project set audio.file assets/<name>"

EPILOG = """\
  ./kb beats                              the grid, each scene's bars, cues and sections
  ./kb beats --scene 03-drop              every bar line and beat in one scene (scene-local ms)
  ./kb beats set-grid --from-analysis     the fitted grid from ./kb song analyse (refuses a drifting tempo without --force)
  ./kb beats set-grid --bpm 120 --offset 250 --beats-per-bar 4   by hand (offset: track ms of bar 1 beat 1)
  ./kb beats set-downbeat 12.48s          the nearest bar line moves there; --bar 9 makes it bar 9 instead
  ./kb beats cue set drop bar:29          named times: a position or a time (12.5s, 12500ms)
  ./kb beats section set chorus --from bar:17 --to bar:25 --label Chorus
  ./kb beats resolve bar:13.3+40ms        project and scene-local ms
Positions: bar:B[.beat[.16th]] (1-based, bar 0 and below are pickups), cue:ID, section:ID (its start), each with an
optional +Nms or -Nms nudge. Times: 12.5s, 12500ms, or bare seconds. Sidecar keys follow a position through a sibling
"at" (camera, rig and lighting keys); every write here refreshes their cached tMs in the same transaction."""


# ── reading ───────────────────────────────────────────────────────────────────


def soundtrack(project: Project, manifest: Dict[str, Any]) -> Tuple[Optional[str], Optional[Path], Optional[str]]:
    """(audio.file, its path, its SHA-256) with None for whatever is missing."""
    audio = manifest.get("audio")
    rel = audio.get("file") if isinstance(audio, dict) and isinstance(audio.get("file"), str) else None
    if not rel:
        return None, None, None
    path = project.root / rel
    return rel, path, (cache.file_digest(path) if path.is_file() else None)


def require_soundtrack(project: Project, manifest: Dict[str, Any]) -> Tuple[str, Path]:
    rel, path, _digest = soundtrack(project, manifest)
    if rel is None or path is None:
        raise KbError("this project has no soundtrack (project.json has no audio.file)", EXIT_PROBLEMS, kind="invalid", hint=NO_SOUNDTRACK_HINT)
    return rel, path


def load_analysis(project: Project, manifest: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[Path], Optional[str]]:
    """The analysis of the soundtrack's exact bytes (kb's copy, else the app's cache), its path and the digest."""
    _rel, _path, digest = soundtrack(project, manifest)
    if digest is None:
        return None, None, None
    analysis, path = cache.project_analysis(project.root, digest)
    return analysis, path, digest


def start_offset(manifest: Dict[str, Any]) -> float:
    audio = manifest.get("audio")
    offset = audio.get("startOffsetMs") if isinstance(audio, dict) else None
    return offset if is_number(offset) and math.isfinite(offset) else 0


def owner_of(slots: List[Dict[str, Any]], project_ms: float) -> Optional[Dict[str, Any]]:
    if not slots:
        return None
    rounded = music.round_ms(project_ms)
    index = model.owner_index(slots, rounded)
    slot = slots[index]
    return {"index": index, "stem": slot["stem"], "localMs": music.round_ms(project_ms - slot["startMs"])}


def show_data(project: Project) -> Dict[str, Any]:
    manifest = project.manifest()
    audio = manifest.get("audio") if isinstance(manifest.get("audio"), dict) else None
    m = model.project_music(manifest)
    spec, problems = model.sanitise_music(audio)
    slots = model.slots_of(project, manifest)
    total = tl.timeline_total_ms(slots)
    rel, _path, digest = soundtrack(project, manifest)
    analysis, apath, _ = load_analysis(project, manifest)
    notes: List[str] = []
    version = analysis.get("version") if analysis else None
    if analysis is not None and version not in cache.SUPPORTED_VERSIONS:
        notes.append(f"the cached analysis is version {version}, which this kit can't read; run ./kb song analyse")
        analysis = None
    if analysis is not None and version == 1:
        notes.append(cache.V1_WARNING)
    if rel and digest is None:
        notes.append(f"the soundtrack {rel} is missing on disk")
    elif rel and analysis is None:
        notes.append("no analysis of this soundtrack yet: ./kb song analyse")
    offset = start_offset(manifest)
    grid = model.grid_of(m)
    source = spec.get("grid", {}).get("source") if spec.get("grid") else None
    if grid:
        beats, bar_lines = model.grid_beats(m, total)  # type: ignore[arg-type]
        beat_source = "authored"
    elif analysis is not None:
        beats = [t - offset for t in cache.beat_times(analysis) if 0 <= t - offset <= total]
        bar_lines = [(None, t - offset) for t in cache.downbeat_times(analysis) if 0 <= t - offset <= total]  # type: ignore[misc]
        beat_source = "detected"
    else:
        beats, bar_lines, beat_source = [], [], None
    moments, moment_source = cache.effective_key_moments(analysis or {"keyMoments": []}, audio.get("markers") if audio else None, offset, total)
    if grid:
        bpm, interval = grid["bpm"], 60000 / grid["bpm"]
    elif analysis is not None:
        bpm, interval = cache.tempo(analysis)
    else:
        bpm, interval = None, None
    cues = []
    for ident, value in ((m or {}).get("cues") or {}).items():
        r = model.resolve(f"cue:{ident}", m)
        row: Dict[str, Any] = {"id": ident, "value": value}
        if r["ok"]:
            row.update(projectMs=music.round_ms(r["projectMs"]), scene=owner_of(slots, r["projectMs"]))
        else:
            row["error"] = r["message"]
        cues.append(row)
    sections = []
    for ident, s in ((m or {}).get("sections") or {}).items():
        row = {"id": ident, "from": s["from"], "to": s["to"]}
        if "label" in s:
            row["label"] = s["label"]
        lo = model.resolve(f"section:{ident}", m)
        hi = model.resolve(s["to"], m) if isinstance(s["to"], str) else {"ok": True, "projectMs": s["to"]}
        if lo["ok"] and hi["ok"]:
            row.update(fromMs=music.round_ms(lo["projectMs"]), toMs=music.round_ms(hi["projectMs"]))
        else:
            row["error"] = (lo if not lo["ok"] else hi)["message"]
        sections.append(row)
    scenes = []
    for i, slot in enumerate(slots):
        start, end = slot["startMs"], slot["endMs"]
        t_in = slot["transitionIn"]["durationMs"] if isinstance(slot.get("transitionIn"), dict) else 0
        nxt = slots[i + 1] if i + 1 < len(slots) else None
        next_in = nxt["transitionIn"]["durationMs"] if nxt and isinstance(nxt.get("transitionIn"), dict) else 0
        inside = [(b, t) for b, t in bar_lines if start <= t <= end]
        scenes.append({
            "index": i, "stem": slot["stem"], "startMs": music.round_ms(start), "durationMs": slot["durationMs"], "endMs": music.round_ms(end),
            "windowStartMs": music.round_ms(t_in / 2), "windowEndMs": music.round_ms(slot["durationMs"] - next_in / 2),
            "transitionInMs": music.round_ms(t_in),
            "transitionOutStartMs": music.round_ms(slot["durationMs"] - next_in if next_in else slot["durationMs"] - next_in / 2),
            "firstBar": inside[0][0] if inside else None, "lastBar": inside[-1][0] if inside else None,
            "bars": [{"bar": b, "localMs": music.round_ms(t - start)} for b, t in inside],
            "beats": [music.round_ms(t - start) for t in beats if start <= t <= end],
            "keyMoments": [{"tMs": music.round_ms(mo["tMs"] - start), "strength": round(mo["strength"], 3)} for mo in moments if start <= mo["tMs"] <= end],
            "cues": [{"id": c["id"], "localMs": c["projectMs"] - music.round_ms(start)} for c in cues if "projectMs" in c and start <= c["projectMs"] < end],
        })
    fit = analysis.get("fit") if analysis is not None and version == 2 else None
    return {
        "soundtrack": rel, "startOffsetMs": offset, "projectTotalMs": music.round_ms(total),
        "grid": (dict(grid, beatMs=60000 / grid["bpm"], barMs=model.bar_ms(grid), source=source) if grid else None),
        "gridMatchesSoundtrack": (source.get("sha256") == digest) if isinstance(source, dict) and digest else None,
        "problems": [{"path": f"audio.{p}", "message": msg} for p, msg in problems],
        "beatSource": beat_source, "bpm": bpm, "beatIntervalMs": round(interval, 3) if interval else None,
        "analysisVersion": version if analysis is not None else None, "tracker": analysis.get("tracker") if analysis else None,
        "fit": fit, "analysisPath": str(apath) if apath and analysis is not None else None,
        "keyMomentSource": moment_source, "keyMoments": [{"tMs": music.round_ms(mo["tMs"]), "strength": round(mo["strength"], 3)} for mo in moments],
        "beats": [music.round_ms(t) for t in beats], "bars": [music.round_ms(t) for _b, t in bar_lines],
        "cues": cues, "sections": sections, "scenes": scenes, "notes": notes,
    }


def grid_line(data: Dict[str, Any]) -> str:
    grid = data["grid"]
    if not grid:
        if data["beatSource"] == "detected":
            return f"Grid: none authored; the analysis detects about {data['bpm']} bpm (./kb beats set-grid --from-analysis to use it)"
        return "Grid: none. ./kb song analyse, then ./kb beats set-grid --from-analysis"
    line = f"Grid: {grid['bpm']:g} bpm, {grid['beatsPerBar']} beats a bar, bar 1 at {grid['offsetMs']:g} ms in the track (a bar is {grid['barMs']:.2f} ms)"
    source = grid.get("source")
    if isinstance(source, dict):
        line += f"; fitted by {source.get('tracker')}"
        if is_number(source.get("residualMs")):
            line += f", residual {source['residualMs']:g} ms"
        if data.get("gridMatchesSoundtrack") is False:
            line += "; FITTED TO ANOTHER FILE (./kb song analyse --accept refits it)"
    return line


def print_show(data: Dict[str, Any], scene: Optional[Dict[str, Any]]) -> None:
    if not data["soundtrack"] and not data["grid"] and not data["cues"] and not data["sections"]:
        emit("beats: this project has no soundtrack (no audio block in project.json)")
        return
    emit(f"Soundtrack: {data['soundtrack'] or 'none'}   startOffsetMs: {js_json(data['startOffsetMs'])}   film: {fmt_secs(data['projectTotalMs'])}")
    emit(grid_line(data))
    for p in data["problems"]:
        emit(f"  dropped by the app: {p['path']} {p['message']}")
    if data["cues"]:
        emit("Cues: " + "; ".join(
            f"{c['id']} = {c['value']} -> {fmt_secs(c['projectMs'])} (scene {c['scene']['index']} {c['scene']['stem']} at {c['scene']['localMs']} ms)"
            if "projectMs" in c else f"{c['id']} = {c['value']} ({c['error']})" for c in data["cues"]))
    if data["sections"]:
        emit("Sections: " + "; ".join(
            f"{s['id']}{' (' + s['label'] + ')' if s.get('label') else ''} {s['from']} to {s['to']}"
            + (f" = {fmt_secs(s['fromMs'])} to {fmt_secs(s['toMs'])}" if "fromMs" in s else f" ({s['error']})") for s in data["sections"]))
    emit(f"Key moments: {len(data['keyMoments'])} ({data['keyMomentSource']})   beats: {len(data['beats'])} ({data['beatSource'] or 'none'})")
    for n in data["notes"]:
        emit_err(f"kb: {n}")
    if scene is not None:
        s = scene
        emit(f"\nScene {s['index']} {s['stem']}  (film {fmt_secs(s['startMs'])} to {fmt_secs(s['endMs'])}; times below are scene-local ms)")
        emit(f"  window: {s['windowStartMs']} to {s['windowEndMs']}   transition in ends: {s['transitionInMs']}   transition out starts: {s['transitionOutStartMs']}")
        bars = ", ".join(f"{b['bar']}@{b['localMs']}" if b["bar"] is not None else str(b["localMs"]) for b in s["bars"])
        emit(f"  bars: {bars or 'none'}")
        emit(f"  beats: {' '.join(str(t) for t in s['beats']) or 'none'}")
        emit(f"  cues: {', '.join(c['id'] + '@' + str(c['localMs']) for c in s['cues']) or 'none'}")
        emit(f"  key moments: {cache.fmt_moments(s['keyMoments'])}")
        return
    emit("")
    for s in data["scenes"]:
        bars = f"bars {s['firstBar']}-{s['lastBar']}" if s["firstBar"] is not None else ("no bar lines" if data["beatSource"] else "")
        cues = f"  cues: {', '.join(c['id'] for c in s['cues'])}" if s["cues"] else ""
        emit(f"{s['index']:2}  {s['stem']:24} {s['startMs'] / 1000:6.2f}s - {s['endMs'] / 1000:6.2f}s  {bars:<14} beats: {len(s['beats']):3}{cues}")
    emit("\nRerun with --scene S for every bar and beat in one scene, or --json for everything.")


def cmd_show(ctx: Any) -> int:
    project = ctx.project
    data = show_data(project)
    scene = None
    if ctx.args.scene is not None:
        index, _stem = project.resolve(ctx.args.scene)
        scene = data["scenes"][index]
    if ctx.json:
        ctx.out(dict(data, scene=scene) if scene is not None else data)
        return EXIT_OK
    print_show(data, scene)
    return EXIT_OK


def cmd_resolve(ctx: Any) -> int:
    project = ctx.project
    manifest = project.manifest()
    m = model.project_music(manifest)
    text = ctx.args.position
    t = model.parse_time(text, m)
    slots = model.slots_of(project, manifest)
    total = tl.timeline_total_ms(slots)
    rounded = music.round_ms(t["projectMs"])
    out: Dict[str, Any] = {
        "position": text, "kind": t["kind"], "projectMs": rounded, "exactMs": t["projectMs"],
        "inFilm": 0 <= rounded <= total, "owner": owner_of(slots, t["projectMs"]) if 0 <= rounded <= total else None,
        "nearestBeat": model.nearest_beat(m, t["projectMs"]),
    }
    selector = ctx.args.resolve_scene or ctx.args.scene
    if selector is not None:
        index, stem = project.resolve(selector)
        local = music.round_ms(t["projectMs"] - slots[index]["startMs"])
        out["scene"] = {"index": index, "stem": stem, "localMs": local, "inside": model.in_slot(slots, index, local)}
    if ctx.json:
        ctx.out(out)
        return EXIT_OK
    line = f"{text} = {rounded} ms in the film ({fmt_secs(rounded)})"
    if out["owner"]:
        line += f", scene {out['owner']['index']} {out['owner']['stem']} at {out['owner']['localMs']} ms"
    elif not out["inFilm"]:
        line += f", outside the film (0 to {music.round_ms(total)} ms)"
    emit(line)
    if "scene" in out:
        s = out["scene"]
        emit(f"  in scene {s['index']} {s['stem']}: {s['localMs']} ms" + ("" if s["inside"] else " (outside that scene)"))
    near = out["nearestBeat"]
    if near and t["kind"] != "position":
        emit(f"  nearest beat: {near['position']} ({music.round_ms(near['projectMs'])} ms)")
    return EXIT_OK


# ── writing ───────────────────────────────────────────────────────────────────


Edit = Callable[[Dict[str, Any], Dict[str, Any], List[str]], str]


def apply_music(ctx: Any, edit: Edit) -> Dict[str, Any]:
    """One transaction: edit(manifest, audio, notes) changes the audio block in place and returns a summary; then every
    sidecar whose `at` caches move is rewritten. Returns { summary, changed, moved, notes, writes, dryRun }."""
    project = ctx.project

    def fn(tx: lockmod.Txn) -> Tuple[str, List[Dict[str, Any]], List[str], bool]:
        notes: List[str] = []
        data, _sha = tx.read(MANIFEST)
        if data is None:
            raise KbError("project.json does not exist")
        manifest = lockmod.decode_json(data, MANIFEST)
        if not isinstance(manifest, dict):
            raise KbError("project.json must be a JSON object; restore it with kb undo")
        require_soundtrack(project, manifest)
        summary = edit(manifest, manifest["audio"], notes)
        notes += model.settle_cuts(project, manifest)
        changed = lockmod.encode_json(manifest) != data
        if changed:
            tx.write_json(MANIFEST, manifest)
        moved = model.refresh_sidecars(tx, project, manifest, notes)
        return summary, moved, notes, changed

    (summary, moved, notes, changed), tx = lockmod.transact(project, f"kb {ctx.command}", fn, dry_run=ctx.dry_run, caller=ctx.caller, wait=ctx.wait)
    project.manifest(reload=True)
    return {"summary": summary, "changed": changed, "moved": moved, "notes": notes, "writes": tx.writes, "dryRun": tx.dry_run}


def print_written(res: Dict[str, Any]) -> None:
    summary, moved = res["summary"], res["moved"]
    if res["dryRun"]:
        emit(f"dry run, nothing written: {summary}")
        for w in res["writes"]:
            emit(f"  {w['action']:<6} {w['path']}" + (f"  (refused: {w['refusal']['error']})" if w.get("refusal") else ""))
    elif res["changed"]:
        emit(f"wrote project.json: {summary}")
    else:
        emit(f"project.json already has that: {summary}")
    if moved and not res["dryRun"]:
        emit(f"refreshed the tMs caches of {len(moved)} sidecar{'s' if len(moved) != 1 else ''} from their positions:")
    for line in model.moved_notes(moved):
        emit(f"  {line}")
    for n in res["notes"]:
        emit_err(f"kb: {n}")


def write_music(ctx: Any, edit: Edit) -> int:
    res = apply_music(ctx, edit)
    if ctx.json:
        ctx.out(res)
    else:
        print_written(res)
    return EXIT_OK


def invalid(message: str, hint: Optional[str] = None) -> KbError:
    return KbError(message, EXIT_PROBLEMS, kind="invalid", hint=hint)


def check_id(ident: str, what: str) -> None:
    if not music.MUSIC_ID_PATTERN.match(ident or ""):
        raise invalid(f'{what} id "{ident}" must be 1 to 40 lowercase letters, digits and dashes, starting with a letter or digit')


def check_grid(grid: Dict[str, Any]) -> None:
    _spec, problems = model.sanitise_music({"grid": grid})
    if problems:
        path, why = problems[0]
        raise invalid(f"audio.{path} {why}; nothing written", hint="bpm 30..300, beats per bar a whole number 1..16")


def music_value(text: str, grid: Optional[Dict[str, Any]], m: Optional[Dict[str, Any]], flag: str) -> Any:
    """A cue value or section bound as stored: a position stays its text; a time becomes whole project ms."""
    if music.is_position(text):
        problem = model.value_problem(text, grid)
        if problem:
            raise invalid(f"{flag} {problem}", hint="a cue or section holds bar:B[.beat[.16th]] or a time; never cue: or section:")
        return text
    return music.round_ms(model.parse_time(text, m, flag)["projectMs"])


def unresolved_after(project: Project, manifest: Dict[str, Any]) -> List[str]:
    m = model.project_music(manifest)
    out: List[str] = []
    for slot in model.slots_of(project, manifest):
        try:
            doc = project.load_sidecar(slot["stem"])
        except KbError:
            continue
        for issue in model.refresh_doc(doc, m, slot["startMs"])[2]:
            out.append(f"scenes/{slot['stem']}.json: {issue}")
    return out


def cmd_set_grid(ctx: Any) -> int:
    a = ctx.args
    project = ctx.project
    manual = a.bpm is not None or a.offset is not None
    if manual == bool(a.from_analysis):
        raise KbError("set-grid needs --bpm B --offset MS, or --from-analysis", EXIT_ENV, kind="usage", hint="./kb beats set-grid --help")
    if manual and (a.bpm is None or a.offset is None):
        raise KbError("a grid by hand needs both --bpm and --offset (track ms of bar 1 beat 1)", EXIT_ENV, kind="usage")
    if a.force and not a.from_analysis:
        raise KbError("--force only applies to --from-analysis", EXIT_ENV, kind="usage")
    accepted: Dict[str, Any] = {}

    def edit(manifest: Dict[str, Any], audio: Dict[str, Any], notes: List[str]) -> str:
        current, _ = model.sanitise_music(audio)
        if manual:
            per_bar = a.beats_per_bar if a.beats_per_bar is not None else (current.get("grid") or {}).get("beatsPerBar", 4)
            grid = {"bpm": model.round3(a.bpm), "offsetMs": model.round3(a.offset), "beatsPerBar": per_bar}
            check_grid(grid)
            grid = js_json(grid)
        else:
            grid = from_analysis(project, manifest, a.force, a.beats_per_bar)
        audio["grid"] = grid
        accepted.update(grid)
        lost = unresolved_after(project, manifest)
        if lost:
            notes.append(f"{len(lost)} key(s) still can't resolve and keep their stored tMs: " + "; ".join(lost[:4]))
        return grid_summary(grid)

    code = write_music(ctx, edit)
    return code


def grid_summary(grid: Dict[str, Any]) -> str:
    out = f"audio.grid = {grid['bpm']:g} bpm, {grid['beatsPerBar']} beats a bar, bar 1 at {grid['offsetMs']:g} ms in the track"
    source = grid.get("source")
    if isinstance(source, dict):
        out += f" (from the {source.get('tracker')} analysis"
        if is_number(source.get("residualMs")):
            out += f", residual {source['residualMs']:g} ms"
        out += ")"
    return out


def from_analysis(project: Project, manifest: Dict[str, Any], force: bool, beats_per_bar: Optional[int]) -> Dict[str, Any]:
    """The grid --from-analysis writes: the fitted grid with grid.source; refuses a drifting tempo unless forced."""
    rel, _path = require_soundtrack(project, manifest)
    analysis, _apath, digest = load_analysis(project, manifest)
    if digest is None:
        raise invalid(f"the soundtrack {rel} is missing on disk", hint="restore the file, or set another with ./kb project set audio.file")
    if analysis is None:
        raise invalid(f"no analysis of {rel} yet", hint="./kb song analyse --accept")
    if analysis.get("version") != cache.ANALYSIS_VERSION:
        raise invalid(f"the only analysis of {rel} is version {analysis.get('version')}, which has no fitted grid", hint="./kb song analyse --accept")
    return grid_from(analysis, rel, force, beats_per_bar)


def grid_from(analysis: Dict[str, Any], rel: str, force: bool, beats_per_bar: Optional[int]) -> Dict[str, Any]:
    grid = model.detected_grid(analysis)
    if grid is None:
        raise invalid(f"the analysis of {rel} found no steady tempo in 30..300 bpm to fit a grid to", hint="set one by hand: ./kb beats set-grid --bpm B --offset MS")
    fit = analysis.get("fit") or {}
    if fit.get("constantTempo") is False and not force:
        raise invalid(
            f"the analysis says the tempo of {rel} drifts (residual {fit.get('residualMs')} ms, max drift {fit.get('maxDriftMs')} ms), so one grid won't hold for the whole track",
            hint="check it with ./kb song analyse, then ./kb beats set-grid --from-analysis --force to use it anyway",
        )
    if beats_per_bar is not None:
        grid["beatsPerBar"] = beats_per_bar
    check_grid(grid)
    return js_json(grid)


def cmd_set_downbeat(ctx: Any) -> int:
    a = ctx.args
    project = ctx.project

    def edit(manifest: Dict[str, Any], audio: Dict[str, Any], notes: List[str]) -> str:
        m = model.project_music(manifest)
        t = model.parse_time(a.at, m, "AT")
        track_ms = t["projectMs"] + start_offset(manifest)
        current, _ = model.sanitise_music(audio)
        analysis = None if current.get("grid") else load_analysis(project, manifest)[0]
        if a.bar is not None and abs(a.bar) > music.MAX_BAR:
            raise KbError(f"--bar {a.bar} is outside -{music.MAX_BAR}..{music.MAX_BAR}", EXIT_ENV, kind="usage")
        grid = model.downbeat_grid(current.get("grid"), analysis, track_ms, a.bar)
        if grid is None:
            raise KbError("there is no grid to move and no analysis to start one from", EXIT_PROBLEMS, kind="no-grid")
        if not current.get("grid"):
            notes.append("started the grid from the analysis's tempo")
        check_grid(grid)
        audio["grid"] = grid
        which = f"bar {a.bar} beat 1" if a.bar is not None else "the nearest bar line"
        return f"{which} now lands at {music.round_ms(t['projectMs'])} ms in the film; {grid_summary(grid)}"

    return write_music(ctx, edit)


def cmd_clear_grid(ctx: Any) -> int:
    project = ctx.project

    def edit(manifest: Dict[str, Any], audio: Dict[str, Any], notes: List[str]) -> str:
        if "grid" not in audio:
            return "there is no audio.grid to clear"
        del audio["grid"]
        lost = unresolved_after(project, manifest)
        if lost:
            notes.append(f"{len(lost)} key(s) keep their last tMs and stop following the music until a grid returns: " + "; ".join(lost[:4]))
        return "removed audio.grid (bar: positions stop resolving; useBeatGrid() returns null)"

    return write_music(ctx, edit)


def cmd_cue(ctx: Any) -> int:
    a = ctx.args
    project = ctx.project
    check_id(a.id, "cue")

    def edit(manifest: Dict[str, Any], audio: Dict[str, Any], notes: List[str]) -> str:
        cues = audio.get("cues") if isinstance(audio.get("cues"), dict) else None
        if a.action == "rm":
            if not cues or a.id not in cues:
                raise invalid(f'no cue "{a.id}"', hint="list them with ./kb beats")
            del cues[a.id]
            if not cues:
                del audio["cues"]
            left = model.keys_following(project, f"cue:{a.id}")
            if left:
                notes.append(f"{len(left)} key(s) still name cue:{a.id} and keep their last tMs: " + "; ".join(left[:4]))
            return f'removed cue "{a.id}"'
        if "cues" in audio and cues is None:
            notes.append("audio.cues was not an object (the app dropped it); kb replaced it")
        current, _ = model.sanitise_music(audio)
        value = music_value(a.position, current.get("grid"), model.project_music(manifest), "POS")
        cues = cues if cues is not None else {}
        cues[a.id] = value
        audio["cues"] = cues
        if isinstance(value, str) and value.startswith("bar:") and not current.get("grid"):
            notes.append("the project has no grid yet, so this cue resolves once one exists (./kb beats set-grid)")
        r = model.resolve(f"cue:{a.id}", model.project_music(manifest))
        where = f" ({music.round_ms(r['projectMs'])} ms in the film)" if r["ok"] else ""
        return f"audio.cues.{a.id} = {js_json(value)}{where}"

    return write_music(ctx, edit)


def cmd_section(ctx: Any) -> int:
    a = ctx.args
    project = ctx.project
    check_id(a.id, "section")

    def edit(manifest: Dict[str, Any], audio: Dict[str, Any], notes: List[str]) -> str:
        sections = audio.get("sections") if isinstance(audio.get("sections"), list) else None
        at = next((i for i, s in enumerate(sections or []) if isinstance(s, dict) and s.get("id") == a.id), None)
        if a.action == "rm":
            if at is None:
                raise invalid(f'no section "{a.id}"', hint="list them with ./kb beats")
            del sections[at]  # type: ignore[union-attr]
            if not sections:
                del audio["sections"]
            left = model.keys_following(project, f"section:{a.id}")
            if left:
                notes.append(f"{len(left)} key(s) still name section:{a.id} and keep their last tMs: " + "; ".join(left[:4]))
            return f'removed section "{a.id}"'
        if "sections" in audio and sections is None:
            notes.append("audio.sections was not an array (the app dropped it); kb replaced it")
        current, _ = model.sanitise_music(audio)
        grid = current.get("grid")
        m = model.project_music(manifest)
        lo = music_value(a.from_, grid, m, "--from")
        hi = music_value(a.to, grid, m, "--to")
        lo_ms, hi_ms = model._bound_ms(lo, grid), model._bound_ms(hi, grid)
        if lo_ms is not None and hi_ms is not None and lo_ms >= hi_ms:
            raise invalid(f'section "{a.id}" needs --from before --to ({js_json(lo)} is not before {js_json(hi)})')
        section: Dict[str, Any] = {"id": a.id}
        old = sections[at] if sections is not None and at is not None else {}
        label = a.label if a.label is not None else old.get("label")
        if isinstance(label, str):
            section["label"] = label
        section.update({"from": lo, "to": hi})
        sections = sections if sections is not None else []
        if at is None:
            sections.append(section)
        else:
            sections[at] = section
        audio["sections"] = sections
        return f"audio.sections {a.id} = {js_json(lo)} to {js_json(hi)}" + (f' ("{label}")' if isinstance(label, str) else "")

    return write_music(ctx, edit)


def cmd_beats(ctx: Any) -> int:
    op = getattr(ctx.args, "op", None)
    handlers = {None: cmd_show, "resolve": cmd_resolve, "set-grid": cmd_set_grid, "set-downbeat": cmd_set_downbeat,
                "clear-grid": cmd_clear_grid, "cue": cmd_cue, "section": cmd_section}
    return handlers[op](ctx)


# ── parser ────────────────────────────────────────────────────────────────────


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """Adds `kb beats` to kb's top-level subparsers."""
    structural = argparse.ArgumentParser(add_help=False)
    structural.add_argument("--dry-run", action="store_true", help="list the files this would change; write nothing")
    structural.add_argument("--wait", type=float, nargs="?", const=600.0, default=None, metavar="SECONDS", help="wait for another kb write to finish (default 10 s)")
    writes = [common, structural]
    p = sub.add_parser("beats", help="the soundtrack's beat grid, bars per scene, cues and sections; author them",
                       description="the soundtrack's beat grid, bars per scene, cues and sections, each resolved; and the writes that author them",
                       epilog=EPILOG, formatter_class=Formatter, parents=[common])
    p.add_argument("--scene", metavar="S", help="every bar line, beat and cue in this scene (scene-local ms)")
    ops = p.add_subparsers(dest="op", metavar="OP")
    ops.required = False

    def op(name: str, help_: str, parents: List[argparse.ArgumentParser], epilog: Optional[str] = None) -> argparse.ArgumentParser:
        return ops.add_parser(name, help=help_, description=help_, epilog=epilog, formatter_class=Formatter, parents=parents)

    x = op("set-grid", "author audio.grid: the fitted one (--from-analysis) or by hand (--bpm and --offset)", writes,
           epilog="--offset is track ms of bar 1 beat 1 (the decoded file, before audio.startOffsetMs).\n"
           "--from-analysis takes ./kb song analyse's fit and records grid.source; a tempo the analysis calls drifting\n"
           "(constantTempo false) needs --force.")
    x.add_argument("--bpm", type=float, metavar="B", help="beats per minute, 30..300 (kept to 3 decimals)")
    x.add_argument("--offset", type=float, metavar="MS", help="track ms of bar 1 beat 1")
    x.add_argument("--beats-per-bar", type=int, metavar="N", help="1..16 (default: the current grid's, else 4)")
    x.add_argument("--from-analysis", action="store_true", help="use the soundtrack's analysis (./kb song analyse)")
    x.add_argument("--force", action="store_true", help="with --from-analysis, accept a drifting tempo")
    x = op("set-downbeat", "move the grid's phase so a bar line lands at AT (the tempo is kept)", writes,
           epilog="AT is film time: a position under the current grid, 12.48s, 12480ms or bare seconds.\n"
           "Without --bar the nearest bar line moves to AT and every bar keeps its number; --bar N makes AT bar N beat 1.\n"
           "With no grid it starts one from the analysis's tempo.")
    x.add_argument("at", metavar="AT")
    x.add_argument("--bar", type=int, metavar="N", help="make AT this bar's beat 1")
    op("clear-grid", "remove audio.grid (keys keep their last tMs)", writes)
    cue = op("cue", "set or remove a named time (audio.cues, addressed as cue:ID)", [common])
    cues = cue.add_subparsers(dest="action", metavar="ACTION")
    cues.required = True
    y = cues.add_parser("set", help="cue ID at POS (a position, 12.5s or 12500ms)", parents=writes, formatter_class=Formatter)
    y.add_argument("id", metavar="ID")
    y.add_argument("position", metavar="POS")
    y = cues.add_parser("rm", help="remove a cue", parents=writes, formatter_class=Formatter)
    y.add_argument("id", metavar="ID")
    section = op("section", "set or remove a section (audio.sections, addressed as section:ID, its start)", [common])
    secs = section.add_subparsers(dest="action", metavar="ACTION")
    secs.required = True
    y = secs.add_parser("set", help="section ID from POS to POS", parents=writes, formatter_class=Formatter)
    y.add_argument("id", metavar="ID")
    y.add_argument("--from", dest="from_", required=True, metavar="POS")
    y.add_argument("--to", required=True, metavar="POS")
    y.add_argument("--label", metavar="L", help="a display label (kept when omitted)")
    y = secs.add_parser("rm", help="remove a section", parents=writes, formatter_class=Formatter)
    y.add_argument("id", metavar="ID")
    x = op("resolve", "a position or time as project and scene-local ms", [common])
    x.add_argument("position", metavar="POS")
    x.add_argument("--scene", dest="resolve_scene", metavar="S", help="scene-local ms in this scene (default: the scene that owns it)")
    p.set_defaults(fn=cmd_beats)
