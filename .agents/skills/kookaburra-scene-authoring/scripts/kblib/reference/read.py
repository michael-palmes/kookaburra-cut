"""Reading a reference film on this Mac into `.kb/reference/<sha>/`. The file is untrusted: reach and the media checks come first, every ffmpeg runs under a demuxer whitelist, nothing is written outside the project, and the folder only appears once it is whole."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

from .. import lock as lockmod
from .. import reach, song, untrusted
from ..beats import cache, model
from ..beats import commands as beats
from ..film import timeline as tl
from ..project import stem_of
from ..util import EXIT_ENV, EXIT_OK, KbError, atomic_write_json, atomic_write_text, clean_text, emit, is_number
from ..video import appcli
from ..video.passes import find_tools
from . import beatsheet, compare, frames, sheets, words

VERSION = 1
THUMB_WIDTH = 240
MAX_THUMBS = 200


def out_folder(project: Any, digest: str) -> Path:
    """The film's folder, refused if a link would take it outside the project."""
    lockmod.kb_dir(project)
    folder = project.root / lockmod.KB_DIR / "reference" / digest
    root = reach.resolve(str(project.root))
    resolved = reach.resolve(str(folder))
    if root not in resolved.parents:
        raise KbError(f"{folder} resolves outside the project ({resolved}), so kb will not write there", EXIT_ENV, kind="usage")
    return folder


def load_saved(folder: Path, digest: str) -> Optional[Dict[str, Any]]:
    """A whole earlier read of these bytes, or None to read the film again."""
    try:
        data = json.loads((folder / "analysis.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("version") != VERSION or data.get("sha256") != digest:
        return None
    file = data.get("file")
    whole = isinstance(file, dict) and is_number(file.get("durationMs")) and isinstance(data.get("segments"), list) and isinstance(data.get("words"), dict)
    whole = whole and all(isinstance(s, dict) and is_number(s.get("fromMs")) and is_number(s.get("toMs")) and "endsWith" in s for s in data["segments"])
    whole = whole and all(is_number(data.get(k)) for k in ("hardCuts", "continuousChanges")) and isinstance(data.get("moves"), list)
    return data if whole else None


def scene_stems(project: Any) -> List[str]:
    return [stem_of(e.get("file") or "") for e in project.scene_entries() if isinstance(e, dict)]


def write_sheet(folder: Path, data: Dict[str, Any], stems: List[str]) -> None:
    """The beat sheet in both forms, from the film's stretches and the project's scenes as they are now."""
    grid, segs = data.get("grid"), data["segments"]
    data["beatSheet"] = beatsheet.plan_rows(segs, grid, stems)
    atomic_write_json(folder / "analysis.json", data)
    atomic_write_json(folder / "beat-sheet.json", {"version": 1, "cuts": data["beatSheet"]})
    atomic_write_text(folder / "beat-sheet.md", beatsheet.markdown(str(data["file"].get("name")), data["file"]["durationMs"], grid, segs, data["beatSheet"],
                                                                   data.get("barMap"), data["words"], len(stems)))


def bar_map_of(analysis: Optional[Dict[str, Any]], grid: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The song map of the film's own music: sections, energy per bar, breaths, the audible end."""
    if not analysis:
        return None
    form = analysis.get("form") if isinstance(analysis.get("form"), dict) else {}
    parts = [p for p in form.get("parts") or [] if isinstance(p, dict)]
    rows = []
    beat_ms = 60000.0 / grid["bpm"] if grid else None
    for row in form.get("bars") or []:
        if not isinstance(row, dict) or not is_number(row.get("bar")):
            continue
        bar = row["bar"]
        out = {k: row.get(k) for k in ("bar", "lufs", "onsets", "quiet")}
        if grid and beat_ms:
            bar_ms = beat_ms * grid["beatsPerBar"]
            out["fromMs"] = round(grid["offsetMs"] + (bar - 1) * bar_ms, 1)
            out["toMs"] = round(grid["offsetMs"] + bar * bar_ms, 1)
        out["section"] = next((p.get("id") for p in parts if is_number(p.get("fromBar")) and is_number(p.get("toBar")) and p["fromBar"] <= bar < p["toBar"]), None)
        rows.append(out)
    return {"phrase": form.get("phrase"), "parts": parts, "moments": form.get("moments") or [], "bars": rows,
            "sections": analysis.get("sections") or [], "breaths": analysis.get("breaths") or [], "ending": analysis.get("ending")}


def read_film(ctx: Any, film: Path, facts: Dict[str, Any], digest: str, folder: Path) -> Dict[str, Any]:
    """Everything but the compare report, built in a scratch folder under the project and moved into place whole."""
    project = ctx.project
    tools = find_tools()
    parent = folder.parent
    parent.mkdir(parents=True, exist_ok=True)
    work = parent / f".work-{digest[:12]}-{os.getpid()}"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    try:
        analysis: Optional[Dict[str, Any]] = None
        if facts.get("audio"):
            analysis, _resp, _mut = song.analyse_file(ctx, appcli.locate(), film, ctx.args.force, ctx.args.tracker, song.ANALYSE_TIMEOUT_S)
        fit = analysis.get("fit") if analysis and isinstance(analysis.get("fit"), dict) else None
        grid = song.fit_grid(fit) if fit and model.drift_holds(fit) else None
        duration = float(facts["durationMs"])
        decoded = frames.decode(tools.ffmpeg, film, duration)
        found, moves = frames.boundaries(decoded)
        segs = frames.segments(decoded, found)
        by_frame = {b["frame"]: b for b in found}
        for seg in segs:
            if seg["endsWith"] == "continuous":
                seg["transitionMs"] = by_frame[seg["toFrame"]]["durationMs"]
        read, same_as = words.pick_frames(decoded, segs)
        seen = words.recognise(tools.ffmpeg, film, read, work)
        beat_ms = 60000.0 / grid["bpm"] if grid else None
        totals = words.fill_segments(segs, seen["frames"], same_as, beat_ms)
        word_block = {k: seen[k] for k in ("available", "reason", "engine") if k in seen}
        word_block.update(totals)
        thumbs = frames.extract(tools.ffmpeg, film, [(s["fromFrame"] + s["toFrame"]) // 2 for s in segs[:MAX_THUMBS]], work / "thumbs", "thumb", THUMB_WIDTH, quality=5)
        for seg in segs[:MAX_THUMBS]:
            shot = thumbs.get((seg["fromFrame"] + seg["toFrame"]) // 2)
            if shot:
                seg["thumb"] = f"thumbs/{shot.name}"
        video = facts["video"]
        aspect = video["width"] / float(video["height"])
        drawn = sheets.draw(tools.ffmpeg, film, grid, min(duration, frames.frame_ms(decoded.count)), aspect, work / "out", work)
        bar_map = bar_map_of(analysis, grid)
        data: Dict[str, Any] = {
            "version": VERSION, "sha256": digest, "file": dict(facts, name=clean_text(film.name)), "grid": grid,
            "gridNote": model.stray_note(fit) if grid else (f"the music drifts by up to {fit.get('maxDriftMs')} ms, over one frame at 30 fps, so cuts are times" if fit else None),
            "cuts": [{k: b[k] for k in ("ms", "kind", "durationMs")} for b in found], "moves": moves, "segments": segs,
            "words": word_block, "sheets": drawn, "barMap": bar_map, "hardCuts": sum(1 for b in found if b["kind"] == "hard"),
            "continuousChanges": sum(1 for b in found if b["kind"] == "continuous"),
        }
        final = work / "out"
        final.mkdir(parents=True, exist_ok=True)
        if (work / "thumbs").is_dir():
            shutil.move(str(work / "thumbs"), str(final / "thumbs"))
        atomic_write_json(final / "bar-map.json", bar_map)
        write_sheet(final, data, scene_stems(project))
        shutil.rmtree(folder, ignore_errors=True)
        os.replace(final, folder)
        return data
    finally:
        shutil.rmtree(work, ignore_errors=True)


def write_compare(ctx: Any, data: Dict[str, Any], folder: Path) -> Path:
    project = ctx.project
    manifest = project.manifest()
    slots = tl.project_slots(project)
    project_grid = model.grid_of(model.project_music(manifest))
    report = compare.render(str(data["file"].get("name") or "the reference"), data, project, slots, project_grid, beats.start_offset(manifest), folder)
    path = folder / "compare.html"
    atomic_write_text(path, report)
    return path


def print_text(data: Dict[str, Any], folder: Path, cached: bool, compared: Optional[Path]) -> None:
    video = data["file"].get("video") or {}
    emit(f"Read {data['file'].get('name')}{' (saved earlier)' if cached else ''}: {data['file']['durationMs'] / 1000:.1f} s, {video.get('width')}x{video.get('height')}, "
         f"{data['hardCuts']} hard cuts, {data['continuousChanges']} continuous changes, {len(data['moves'])} other moves")
    grid = data.get("grid")
    if grid:
        emit(f"  grid: {grid['bpm']:g} bpm, {grid['beatsPerBar']} beats a bar, bar 1 at {grid['offsetMs']:g} ms" + (f"; {data['gridNote']}" if data.get("gridNote") else ""))
    elif data.get("gridNote"):
        emit(f"  grid: none: {data['gridNote']}")
    else:
        emit("  grid: none (no steady beat, or no audio), so cuts are times")
    bar_map = data.get("barMap") or {}
    parts = bar_map.get("parts") or []
    if parts:
        emit("  parts: " + ", ".join(f"{p.get('id')} bars {p.get('fromBar')}-{(p.get('toBar') or 1) - 1}" for p in parts))
    ending = bar_map.get("ending") or {}
    if is_number(ending.get("audibleEndMs")):
        emit(f"  audible end: {ending['audibleEndMs'] / 1000:.2f} s, then {(ending.get('trailingSilenceMs') or 0) / 1000:.2f} s of silence")
    block = data.get("words") or {}
    if block.get("available"):
        per_beat = f", {block['perBeat']} a beat" if block.get("perBeat") is not None else ""
        emit(f"  words on screen: {block.get('total')}, {block.get('perSecond')} a second{per_beat}")
    else:
        emit(f"  words on screen: not read ({block.get('reason') or 'no text recognition here'})")
    emit(f"  folder: {folder}")
    for sheet in data.get("sheets") or []:
        span = f"bars {sheet['fromBar']}-{sheet['toBar']}" if "fromBar" in sheet else f"{sheet['fromMs'] / 1000:.1f}-{sheet['toMs'] / 1000:.1f} s"
        emit(f"  sheet: {folder / sheet['path']} ({span}, Read it)")
    emit(f"  beat sheet: {folder / 'beat-sheet.md'}")
    emit(f"  plan: {folder / 'beat-sheet.json'} (./kb timeline apply takes it as it is)")
    if compared:
        emit(f"  compare: {compared}")


def cmd_analyse(ctx: Any) -> int:
    a = ctx.args
    project = ctx.project
    film = untrusted.locate(project, a.file, "FILE")
    facts = untrusted.facts(film, need_video=True)
    digest = cache.file_digest(film)
    if digest is None:
        raise KbError(f"{film.name} cannot be read", 1, kind="invalid")
    folder = project.root / lockmod.KB_DIR / "reference" / digest
    if ctx.dry_run:
        payload = {"file": dict(facts, name=clean_text(film.name)), "sha256": digest, "folder": str(folder), "writes": [{"path": f".kb/reference/{digest}/", "action": "create"}], "dryRun": True}
        if ctx.json:
            ctx.out(payload)
        else:
            emit(f"dry run, nothing written: {film.name} passes the checks ({facts['durationMs'] / 1000:.1f} s); it would be read into {folder}")
        return EXIT_OK
    folder = out_folder(project, digest)
    saved = None if a.force else load_saved(folder, digest)
    if saved:
        write_sheet(folder, saved, scene_stems(project))
    data = saved or read_film(ctx, film, facts, digest, folder)
    compared = write_compare(ctx, data, folder) if a.compare else None
    if ctx.json:
        ctx.out({"folder": str(folder), "cached": saved is not None, "compare": str(compared) if compared else None,
                 "plan": str(folder / "beat-sheet.json"), "beatSheetPath": str(folder / "beat-sheet.md"), "dryRun": False, **data})
    else:
        print_text(data, folder, saved is not None, compared)
    return EXIT_OK
