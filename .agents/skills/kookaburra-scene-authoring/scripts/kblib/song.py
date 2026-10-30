"""kb song: the app's song analyser through its headless CLI (`<exe> song analyse`), and what kb reads out of the result.

The result stays in the app's cache (by audio SHA-256) and in a copy at `.kb/song/<sha12>.json` (never packed), hits and
form included, so `kb song hits` and `kb project fit` never recompute it. project.json changes only with `--accept`: the
fitted grid (`audio.grid`) and the detected form (`audio.cues`, `audio.sections`), never over an id already authored.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import lock as lockmod
from . import music, untrusted
from .beats import cache, model
from .beats import commands as beats
from .film import timeline as tl
from .project import stem_of
from .util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, emit, emit_err, fmt_secs, is_number
from .video import appcli

ANALYSE_TIMEOUT_S = 600.0
UPDATE_HINT = "ask the user to update Kookaburra Cut"
BANDS = ("low", "mid", "high")
DEFAULT_MIN_STRENGTH = 0.5
# project.ts DEFAULT_AUDIO_FADE_OUT_MS.
DEFAULT_FADE_OUT_MS = 1000
_BARS = re.compile(r"(-?\d+)(?:-(-?\d+))?\Z", re.ASCII)

EPILOG = """\
  ./kb song analyse                fit, downbeat, form, breaths, audible end and stabs of the soundtrack (cached by its SHA-256)
  ./kb song analyse --accept       and use the fitted grid, plus the detected cues and sections
  ./kb song analyse --file REF.mp4 any audio or video file; the project stays as it is
  ./kb song analyse --force --tracker dsp   analyse again with the DSP tracker only
  ./kb song analyse --lyrics       also print the lyrics tag, when the file has one
  ./kb song hits --bars 29-32 --band mid    strong onsets as bar:B.beat.16th, each with its strength
Runs the app's own analyser (the beat lane's), with the app closed too. The full analysis is copied to
.kb/song/<sha12>.json; project.json changes only with --accept."""

HITS_EPILOG = """\
  ./kb song hits --bars 29-32                  every strong hit in those bars, full band
  ./kb song hits --bars 29 --band low          the kicks in bar 29
  ./kb song hits --bars 1-8 --min-strength 0.8 only the hardest
  ./kb song hits --file REF.mp4 --bars 9-12    any audio or video file
Positions come from the project's grid, else the analysis's fit, and go straight into --at, at or cutAt. Strength is 0..1
within the band. A hit further than 5 ms from its 16th carries a nudge (bar:29.3.2+12ms). Reads the saved analysis; runs
one only when there is none."""


def song_caps(info: appcli.CliInfo) -> Dict[str, Any]:
    """The edit CLI's `song` caps; an older binary would start the whole app on `song`, so it is refused here (exit 2)."""
    caps = appcli.caps(info)
    song = caps.get("song")
    if not isinstance(song, dict) or not isinstance(song.get("trackers"), list):
        raise KbError(
            f"Kookaburra Cut {caps.get('appVersion') or info.app_version or '?'} can't analyse songs from the terminal",
            EXIT_ENV, kind="env", hint=UPDATE_HINT,
        )
    return song


def run_song(info: appcli.CliInfo, args: List[str], timeout: float) -> Dict[str, Any]:
    """One `<exe> song <args>` call: one JSON object on stdout; exit 1 is a failed analysis, anything else odd exit 2."""
    argv = [info.path, "song"] + args
    try:
        proc = subprocess.run(argv, capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise KbError(f"the song analysis took longer than {int(timeout)} s", EXIT_ENV, kind="env", hint="rerun with a longer --timeout") from None
    except OSError as e:
        raise KbError(f"could not run {info.path}: {e.strerror}", EXIT_ENV, kind="env") from None
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
        raise KbError(f"Kookaburra Cut's song {args[0]} gave no JSON (exit {proc.returncode}): {tail or 'no output'}", EXIT_ENV, kind="env")
    if proc.returncode == 0 and data.get("ok", True):
        return data
    if proc.returncode == 130:
        raise KbError("the song analysis was interrupted", EXIT_ENV, kind="env", hint="rerun the command")
    message = str(data.get("error") or f"song {args[0]} failed")
    if proc.returncode == 1:
        raise KbError(f"the song analysis failed ({data.get('code') or 'error'}): {message}", EXIT_PROBLEMS, kind="failed",
                      hint="check the file plays, then rerun (./kb assets probe names what is wrong with it)")
    raise KbError(f"the song analysis could not run ({data.get('code') or 'env'}): {message}", EXIT_ENV, kind="env", hint=UPDATE_HINT)


def summary(analysis: Dict[str, Any], start_offset_ms: float, lyrics: bool) -> Dict[str, Any]:
    """What kb shows of an analysis: everything but the per-hop curves (those stay in the .kb copy)."""
    fit = analysis.get("fit") if isinstance(analysis.get("fit"), dict) else None
    out: Dict[str, Any] = {
        "version": analysis.get("version"), "sha256": analysis.get("sha256"), "tracker": analysis.get("tracker"),
        "model": analysis.get("model"), "fallbackReason": analysis.get("fallbackReason"), "durationMs": analysis.get("durationMs"),
        "fit": fit,
        "downbeat": ({"trackMs": fit.get("offsetMs"), "projectMs": fit["offsetMs"] - start_offset_ms} if fit and is_number(fit.get("offsetMs")) else None),
        "sections": analysis.get("sections") or [], "breaths": analysis.get("breaths") or [],
        "stabs": (analysis.get("stabs") or {}).get("per16th") if isinstance(analysis.get("stabs"), dict) else None,
        "beats": len(analysis.get("beats") or []), "keyMoments": len(analysis.get("keyMoments") or []),
        "ending": analysis.get("ending") if isinstance(analysis.get("ending"), dict) else None,
        "form": analysis.get("form") if isinstance(analysis.get("form"), dict) else None,
        "hits": {k: len(v) for k, v in analysis["hits"].items() if isinstance(v, list)} if isinstance(analysis.get("hits"), dict) else None,
    }
    raw = analysis.get("lyrics") if isinstance(analysis.get("lyrics"), dict) else None
    if raw is None:
        out["lyrics"] = None
    elif lyrics:
        out["lyrics"] = raw
    else:
        out["lyrics"] = {"source": raw.get("source"), "lang": raw.get("lang"), "present": bool(raw.get("text"))}
    return out


def drift_words(fit: Dict[str, Any]) -> str:
    if not model.drift_holds(fit):
        return f"over one frame at 30 fps ({model.MAX_GRID_DRIFT_MS} ms), so one grid won't hold"
    drift = fit.get("maxDriftMs")
    if is_number(drift) and drift > model.STEADY_DRIFT_MS:
        return f"under one frame at 30 fps ({model.MAX_GRID_DRIFT_MS} ms), so one grid holds"
    return "steady tempo"


def fit_grid(fit: Any) -> Optional[Dict[str, Any]]:
    """A fit as the grid --accept would write, without its provenance; None when the fit is missing or out of range."""
    grid = model.detected_grid({"fit": fit})
    return {k: grid[k] for k in ("bpm", "offsetMs", "beatsPerBar")} if grid else None


def print_ending(s: Dict[str, Any], fit: Any) -> None:
    ending = s.get("ending")
    if not isinstance(ending, dict) or not is_number(ending.get("audibleEndMs")):
        return
    line = f"  audible end: {ending['audibleEndMs'] / 1000:.2f} s, then {(ending.get('trailingSilenceMs') or 0) / 1000:.2f} s of silence"
    last = ending.get("lastHitMs")
    if is_number(last):
        grid = fit_grid(fit)
        where = f" ({model.nearest_sixteenth(grid, last)['position']})" if grid else ""
        line += f"; last strong hit at {last / 1000:.2f} s{where}, strength {ending.get('lastHitStrength')}"
    emit(line)


def print_form(s: Dict[str, Any], fit: Any) -> None:
    form = s.get("form")
    grid = fit_grid(fit)
    if not isinstance(form, dict) or not grid:
        return
    phrase = form.get("phrase") if isinstance(form.get("phrase"), dict) else {}
    if phrase.get("detected"):
        emit(f"  phrases: {phrase.get('bars')} bars, counting from bar {phrase.get('startBar')}")
    else:
        emit(f"  phrases: nothing marks them, so {phrase.get('bars')} bars is a guess")
    parts = [p for p in form.get("parts") or [] if isinstance(p, dict)]
    if parts:
        emit("  parts: " + ", ".join(f"{p.get('id')} bars {p.get('fromBar')}-{(p.get('toBar') or 1) - 1}" for p in parts))
    moments = [m for m in form.get("moments") or [] if isinstance(m, dict) and is_number(m.get("ms"))]
    if moments:
        emit("  moments: " + ", ".join(f"{m.get('id')} {model.nearest_sixteenth(grid, m['ms'], compact=True)['position']}" for m in moments))


def form_entries(analysis: Dict[str, Any], grid: Dict[str, Any]) -> Tuple[Dict[str, str], List[Dict[str, Any]]]:
    """The detected form as audio.cues and audio.sections values."""
    form = analysis.get("form") if isinstance(analysis.get("form"), dict) else {}
    cues: Dict[str, str] = {}
    for m in form.get("moments") or []:
        if isinstance(m, dict) and isinstance(m.get("id"), str) and is_number(m.get("ms")) and music.MUSIC_ID_PATTERN.match(m["id"]):
            cues[m["id"]] = model.nearest_sixteenth(grid, m["ms"], compact=True)["position"]
    sections: List[Dict[str, Any]] = []
    for p in form.get("parts") or []:
        if isinstance(p, dict) and isinstance(p.get("id"), str) and is_number(p.get("fromBar")) and is_number(p.get("toBar")) and music.MUSIC_ID_PATTERN.match(p["id"]):
            section = {"id": p["id"], "from": f"bar:{p['fromBar']}", "to": f"bar:{p['toBar']}"}
            if isinstance(p.get("label"), str):
                section["label"] = p["label"]
            sections.append(section)
    return cues, sections


def merge_form(audio: Dict[str, Any], cues: Dict[str, str], sections: List[Dict[str, Any]], notes: List[str]) -> str:
    """Adds the detected cues and sections. An id already there stays as it is, authored or not, and the note says what
    the analysis found now."""
    added = [0, 0]
    if cues:
        have = audio.get("cues") if isinstance(audio.get("cues"), dict) else {}
        for ident, value in cues.items():
            if ident not in have:
                have[ident] = value
                added[0] += 1
            elif have[ident] != value:
                notes.append(f"kept cue {ident} = {have[ident]} (the analysis says {value}); ./kb beats cue rm {ident}, then accept again, takes the new one")
        audio["cues"] = have
    if sections:
        have_s = audio.get("sections") if isinstance(audio.get("sections"), list) else []
        known = {s.get("id"): s for s in have_s if isinstance(s, dict)}
        for section in sections:
            old = known.get(section["id"])
            if old is None:
                have_s.append(section)
                added[1] += 1
            elif (old.get("from"), old.get("to")) != (section["from"], section["to"]):
                notes.append(f"kept section {section['id']} = {old.get('from')} to {old.get('to')} (the analysis says {section['from']} to {section['to']}); "
                             f"./kb beats section rm {section['id']}, then accept again, takes the new one")
        audio["sections"] = have_s
    return f"{added[0]} cue{'s' if added[0] != 1 else ''} and {added[1]} section{'s' if added[1] != 1 else ''} added"


def print_summary(rel: str, s: Dict[str, Any], resp: Dict[str, Any], copy: Optional[str]) -> None:
    model_name = s["model"].get("name") if isinstance(s.get("model"), dict) else None
    how = f"{s['tracker']} tracker" + (f" ({model_name})" if model_name else "")
    emit(f"Analysed {rel}{' (cached)' if resp.get('cached') else ''} with the {how}, {fmt_secs(s['durationMs'])} long")
    if s.get("fallbackReason"):
        emit(f"  the beat model was not used ({s['fallbackReason']}); DSP downbeats are weaker on four-on-the-floor tracks")
    fit = s["fit"]
    if not fit:
        emit("  tempo: no steady beat found, so there is no grid to accept (./kb beats set-grid --bpm B --offset MS sets one by hand)")
    else:
        emit(f"  tempo: {fit.get('bpm')} bpm (a beat every {fit.get('periodMs')} ms), {fit.get('beatsPerBar')} beats a bar, "
             f"residual {fit.get('residualMs')} ms, max drift {fit.get('maxDriftMs')} ms: {drift_words(fit)}")
        down = s["downbeat"]
        if down:
            emit(f"  downbeat: bar 1 beat 1 at {down['trackMs']:g} ms in the track ({down['projectMs']:g} ms in the film)")
    sections = [x for x in s["sections"] if isinstance(x, dict)]
    if sections:
        emit("  sections: " + ", ".join(f"bars {x.get('fromBar')}-{x.get('toBar')}" + (f" ({x['novelty']:.2f})" if is_number(x.get("novelty")) else "") for x in sections))
    print_form(s, fit)
    breaths = [x for x in s["breaths"] if isinstance(x, dict)]
    if breaths:
        shown = ", ".join(f"{fmt_secs(x.get('fromMs'))}-{fmt_secs(x.get('toMs'))} {x.get('kind') or ''}".strip() for x in breaths[:12])
        emit(f"  breaths: {shown}" + (f" (+{len(breaths) - 12} more)" if len(breaths) > 12 else ""))
    print_ending(s, fit)
    stabs = s.get("stabs")
    if isinstance(stabs, list) and stabs:
        top = sorted(range(len(stabs)), key=lambda i: (-(stabs[i] if is_number(stabs[i]) else 0), i))[:4]
        emit(f"  stabs per 16th: {' '.join(f'{v:.2f}' if is_number(v) else '?' for v in stabs)} (strongest: {', '.join(str(i + 1) for i in top)})")
    lyr = s.get("lyrics")
    if isinstance(lyr, dict) and "text" in lyr:
        emit(f"  lyrics ({lyr.get('lang') or '?'}, {lyr.get('source') or '?'}):")
        for line in str(lyr.get("text") or "").splitlines():
            emit(f"    {line}")
    elif isinstance(lyr, dict) and lyr.get("present"):
        lang = f" ({lyr['lang']})" if lyr.get("lang") else ""
        emit(f"  lyrics: the file has a lyrics tag{lang}; pass --lyrics to print it")
    if copy:
        emit(f"  saved: {copy}")


def analyse_file(ctx: Any, info: appcli.CliInfo, path: Path, force: bool, tracker: Optional[str], timeout: float) -> Tuple[Dict[str, Any], Dict[str, Any], Any]:
    """Runs the app's analyser over one file and copies the result to .kb/song/. Returns (analysis, the CLI's answer, the copy's write)."""
    project = ctx.project
    caps = song_caps(info)
    if tracker and tracker not in caps["trackers"]:
        raise KbError(f"this Kookaburra Cut has no {tracker} tracker (it has {', '.join(map(str, caps['trackers']))})", EXIT_ENV, kind="usage")
    args = ["analyse", "--file", str(path.resolve())]
    if force:
        args.append("--force")
    if tracker:
        args += ["--tracker", tracker]
    resp = run_song(info, args, timeout)
    analysis = resp.get("analysis")
    if not isinstance(analysis, dict) or not isinstance(analysis.get("sha256"), str):
        raise KbError("the song analysis answered without an analysis", EXIT_ENV, kind="env", hint=UPDATE_HINT)
    copy_rel = cache.copy_rel(analysis["sha256"])
    if not ctx.dry_run:
        lockmod.kb_dir(project)
    mut = lockmod.mutate_json(project, copy_rel, lambda _old: analysis, op=f"kb {ctx.command}", caller=ctx.caller, dry_run=ctx.dry_run, lock=False)
    return analysis, resp, mut


def named_file(ctx: Any, raw: str) -> Path:
    """A file the agent named: reach first, then the untrusted-media checks (size, length, what it is), with audio required."""
    path = untrusted.locate(ctx.project, raw)
    untrusted.facts(path, need_audio=True)
    return path


def cmd_analyse(ctx: Any) -> int:
    a = ctx.args
    project = ctx.project
    if a.file and a.accept:
        raise KbError("--accept takes the project's own soundtrack, not --file", EXIT_ENV, kind="usage", hint="run one or the other")
    manifest = project.manifest()
    if a.file:
        path = named_file(ctx, a.file)
        rel, offset = str(path), 0
    else:
        rel, path = beats.require_soundtrack(project, manifest)
        offset = beats.start_offset(manifest)
        if not path.is_file():
            raise KbError(f"the soundtrack {rel} is missing on disk", EXIT_PROBLEMS, kind="invalid", hint="restore the file, or set another with ./kb project set audio.file")
    info = appcli.locate()
    analysis, resp, mut = analyse_file(ctx, info, path, a.force, a.tracker, a.timeout)
    copy_abs = str(project.root / cache.copy_rel(analysis["sha256"]))
    s = summary(analysis, offset, a.lyrics)
    payload: Dict[str, Any] = {"file": rel, "cached": bool(resp.get("cached")), "cachePath": resp.get("cachePath"),
                               "analysisPath": None if ctx.dry_run else copy_abs, **s}
    if not ctx.json:
        print_summary(rel, s, resp, None if ctx.dry_run else copy_abs)
    if not a.accept:
        if ctx.json:
            ctx.out(dict(payload, writes=mut.writes, dryRun=ctx.dry_run))
        elif s["fit"] and not a.file:
            emit("next: ./kb song analyse --accept puts bar: positions on this grid and names the sections and cues above")
        return EXIT_OK

    def edit(_manifest: Dict[str, Any], audio: Dict[str, Any], notes: List[str]) -> str:
        grid = beats.grid_from(analysis, rel, False, None)
        audio["grid"] = grid
        note = beats.grid_note(analysis)
        if note:
            notes.append(note)
        added = merge_form(audio, *form_entries(analysis, grid), notes)
        return f"{beats.grid_summary(grid)}; {added}"

    res = beats.apply_music(ctx, edit)
    if ctx.json:
        ctx.out(dict(payload, accepted=res, writes=mut.writes + res["writes"], dryRun=ctx.dry_run))
    else:
        beats.print_written(res)
    return EXIT_OK


def saved_analysis(ctx: Any, path: Path) -> Dict[str, Any]:
    """The analysis of these bytes with the hits and form in it: the saved copy, else one fresh pass."""
    digest = cache.file_digest(path)
    if digest is None:
        raise KbError(f"{path.name} cannot be read", EXIT_PROBLEMS, kind="invalid")
    analysis, _path = cache.project_analysis(ctx.project.root, digest)
    if cache.has_song_map(analysis):
        return analysis  # type: ignore[return-value]
    emit_err("kb: no saved analysis has the hits and form yet, so this runs one")
    fresh, _resp, _mut = analyse_file(ctx, appcli.locate(), path, False, None, ANALYSE_TIMEOUT_S)
    if not cache.has_song_map(fresh):
        raise KbError("this Kookaburra Cut's analysis has no hits or audible end", EXIT_ENV, kind="env", hint=UPDATE_HINT)
    return fresh


def parse_bars(text: Optional[str]) -> Optional[Tuple[int, int]]:
    if text is None:
        return None
    hit = _BARS.match(text)
    if hit is None:
        raise KbError(f'--bars "{text}" isn\'t a bar or a range', EXIT_ENV, kind="usage", hint="write --bars 29 or --bars 29-32")
    first = int(hit.group(1))
    last = int(hit.group(2)) if hit.group(2) is not None else first
    if last < first:
        raise KbError(f'--bars "{text}": the last bar comes before the first', EXIT_ENV, kind="usage", hint="write --bars 29-32 (first to last)")
    return first, last


def cmd_hits(ctx: Any) -> int:
    a = ctx.args
    project = ctx.project
    bars = parse_bars(a.bars)
    if not 0 <= a.min_strength <= 1:
        raise KbError("--min-strength is 0..1", EXIT_ENV, kind="usage")
    manifest = project.manifest()
    if a.file:
        path = named_file(ctx, a.file)
        grid, offset, grid_from = None, 0, "fit"
    else:
        rel, path = beats.require_soundtrack(project, manifest)
        if not path.is_file():
            raise KbError(f"the soundtrack {rel} is missing on disk", EXIT_PROBLEMS, kind="invalid", hint="restore the file, or set another with ./kb project set audio.file")
        grid = model.grid_of(model.project_music(manifest))
        offset = beats.start_offset(manifest)
        grid_from = "authored" if grid else "fit"
    analysis = saved_analysis(ctx, path)
    fit = analysis.get("fit") if isinstance(analysis.get("fit"), dict) else None
    grid = grid or fit_grid(fit)
    if bars and not grid:
        raise KbError("--bars needs a beat grid, and neither the project nor the analysis has one", EXIT_PROBLEMS, kind="no-grid")
    band = a.band or "full"
    raw = analysis["hits"].get(band)
    rows: List[Dict[str, Any]] = []
    for hit in raw if isinstance(raw, list) else []:
        if not (isinstance(hit, list) and len(hit) == 2 and is_number(hit[0]) and is_number(hit[1])) or hit[1] < a.min_strength:
            continue
        row: Dict[str, Any] = {"trackMs": hit[0], "projectMs": round(hit[0] - offset, 1), "strength": hit[1]}
        if grid:
            row.update(model.nearest_sixteenth(grid, hit[0]))
            if bars and not bars[0] <= row["bar"] <= bars[1]:
                continue
        rows.append(row)
    scope = f"bars {bars[0]}-{bars[1]}" if bars and bars[0] != bars[1] else (f"bar {bars[0]}" if bars else "the whole track")
    if ctx.json:
        ctx.out({"band": band, "minStrength": a.min_strength, "bars": list(bars) if bars else None, "gridFrom": grid_from if grid else None, "hits": rows})
        return EXIT_OK
    emit(f"{len(rows)} hit{'s' if len(rows) != 1 else ''} in {scope} ({band} band, strength {a.min_strength:g} or more)")
    for row in rows:
        emit(f"  {row.get('position', '-'):<20} {row['strength']:.2f}   {row['projectMs'] / 1000:.3f} s")
    return EXIT_OK


def cmd_song(ctx: Any) -> int:
    return {"analyse": cmd_analyse, "hits": cmd_hits}[ctx.args.op](ctx)


def cmd_fit(ctx: Any) -> int:
    """`kb project fit --to song-end`: the last scene's length, so the film ends at the audible end plus --hold."""
    a = ctx.args
    project = ctx.project
    if not (math.isfinite(a.hold) and a.hold >= 0):
        raise KbError("--hold is how long the film stays past the music, so it can't be negative", EXIT_ENV, kind="usage")
    rel, path = beats.require_soundtrack(project, project.manifest())
    if not path.is_file():
        raise KbError(f"the soundtrack {rel} is missing on disk", EXIT_PROBLEMS, kind="invalid", hint="restore the file, or set another with ./kb project set audio.file")
    ending = saved_analysis(ctx, path).get("ending")
    end = ending.get("audibleEndMs") if isinstance(ending, dict) else None
    if not is_number(end) or end <= 0:
        raise KbError(f"the analysis of {rel} found no sound to end on", EXIT_PROBLEMS, kind="invalid")

    def edit(manifest: Dict[str, Any], audio: Dict[str, Any], notes: List[str]) -> str:
        scenes = manifest.get("scenes")
        if not isinstance(scenes, list) or not scenes:
            raise KbError("this project has no scenes to fit", EXIT_PROBLEMS, kind="invalid", hint="add one with ./kb scene add")
        index = len(scenes) - 1
        target = music.round_ms(end - beats.start_offset(manifest) + a.hold)
        start = model.slots_of(project, manifest)[index]["startMs"]
        stem = stem_of(scenes[index].get("file") or "") if isinstance(scenes[index], dict) else str(index)
        if target <= start:
            raise KbError(f"the music ends at {target} ms in the film, before the last scene {stem} starts ({start:g} ms)", EXIT_PROBLEMS, kind="invalid",
                          hint="shorten the scenes before it, or check audio.startOffsetMs")
        if isinstance(ending.get("trailingSilenceMs"), (int, float)) and ending["trailingSilenceMs"] > 0:  # type: ignore[union-attr]
            notes.append(f"the file runs {ending['trailingSilenceMs'] / 1000:.2f} s of silence past the music; the film stops before it")  # type: ignore[index]
        fade = audio.get("fadeOutMs", DEFAULT_FADE_OUT_MS)
        last = ending.get("lastHitMs")  # type: ignore[union-attr]
        if is_number(fade) and fade > 0 and is_number(last) and last > end + a.hold - fade:
            notes.append(f"the soundtrack fades out over its last {fade:g} ms, so the last strong hit plays inside the fade; ./kb project set audio.fadeOutMs 0 lets it land at full level")
        duration, _change = model.cut_timing(f"{target}ms", "end")(project, manifest, index)
        scenes[index]["durationMs"] = duration
        hold = f", holding {a.hold:g} ms past it" if a.hold else ""
        return f"scene {index} {stem}: durationMs = {duration}, so the film ends at {target / 1000:.2f} s on the music's audible end{hold}"

    return beats.write_music(ctx, edit)


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """Adds `kb song` to kb's top-level subparsers."""
    structural = argparse.ArgumentParser(add_help=False)
    structural.add_argument("--dry-run", action="store_true", help="analyse, but write nothing (no .kb copy, no grid)")
    structural.add_argument("--wait", type=float, nargs="?", const=600.0, default=None, metavar="SECONDS", help="wait for another kb write to finish (default 10 s)")
    p = sub.add_parser("song", help="analyse the soundtrack: tempo, form, audible end; list its hits",
                       description="analyse the soundtrack with the app's song analyser, and list what it found", epilog=EPILOG, formatter_class=Formatter, parents=[common])
    ops = p.add_subparsers(dest="op", metavar="OP")
    ops.required = True
    x = ops.add_parser("analyse", help="fit, downbeat, form, breaths, audible end, stabs (and the lyrics tag with --lyrics)",
                       description="fit, downbeat, form, breaths, audible end, stabs (and the lyrics tag with --lyrics)", epilog=EPILOG,
                       formatter_class=Formatter, parents=[common, structural])
    x.add_argument("--force", action="store_true", help="analyse again even when the app has it cached")
    x.add_argument("--tracker", choices=["nn", "dsp"], help="nn (the bundled beat model) or dsp; default: nn when the model is there")
    x.add_argument("--lyrics", action="store_true", help="print the lyrics tag too")
    x.add_argument("--accept", action="store_true", help="then use the fitted grid and add the detected cues and sections to project.json")
    x.add_argument("--file", metavar="PATH", help="analyse this audio or video file instead; the project stays as it is")
    x.add_argument("--timeout", type=float, default=ANALYSE_TIMEOUT_S, help=f"seconds to wait (default {int(ANALYSE_TIMEOUT_S)})")
    y = ops.add_parser("hits", help="strong onsets as bar:B.beat.16th, with a strength; split by band",
                       description="strong onsets as bar:B.beat.16th, with a strength; split by band", epilog=HITS_EPILOG,
                       formatter_class=Formatter, parents=[common])
    y.add_argument("--bars", metavar="A-B", help="only these bars (29, or 29-32)")
    y.add_argument("--band", choices=BANDS, help="low (under 200 Hz), mid or high (over 2 kHz); default: the full band")
    y.add_argument("--min-strength", type=float, default=DEFAULT_MIN_STRENGTH, metavar="N", help=f"0..1 (default {DEFAULT_MIN_STRENGTH})")
    y.add_argument("--file", metavar="PATH", help="read this audio or video file instead of the soundtrack")
    p.set_defaults(fn=cmd_song)
