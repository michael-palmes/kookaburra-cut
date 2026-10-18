"""kb song analyse: the app's song analyser over the soundtrack, through its headless CLI (`<exe> song analyse`).

The result stays in the app's cache (by audio SHA-256) and in a copy at `.kb/song/<sha12>.json` (never packed);
project.json only records `audio.grid.source` when a grid is accepted (`--accept` = `kb beats set-grid --from-analysis`).
"""

from __future__ import annotations

import argparse
import json
import subprocess
from typing import Any, Dict, List, Optional

from . import lock as lockmod
from .beats import cache
from .beats import commands as beats
from .util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, emit, fmt_secs, is_number
from .video import appcli

ANALYSE_TIMEOUT_S = 600.0
UPDATE_HINT = "ask the user to update Kookaburra Cut"

EPILOG = """\
  ./kb song analyse                fit, downbeat, sections, breaths and stabs of the soundtrack (cached by its SHA-256)
  ./kb song analyse --accept       and use the fitted grid (./kb beats set-grid --from-analysis)
  ./kb song analyse --force --tracker dsp   analyse again with the DSP tracker only
  ./kb song analyse --lyrics       also print the lyrics tag, when the file has one
Runs the app's own analyser (the beat lane's), with the app closed too. The full analysis is copied to
.kb/song/<sha12>.json; project.json changes only with --accept."""


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
    }
    raw = analysis.get("lyrics") if isinstance(analysis.get("lyrics"), dict) else None
    if raw is None:
        out["lyrics"] = None
    elif lyrics:
        out["lyrics"] = raw
    else:
        out["lyrics"] = {"source": raw.get("source"), "lang": raw.get("lang"), "present": bool(raw.get("text"))}
    return out


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
        steady = "steady tempo" if fit.get("constantTempo", True) else "the tempo DRIFTS, so one grid is approximate"
        emit(f"  tempo: {fit.get('bpm')} bpm (a beat every {fit.get('periodMs')} ms), {fit.get('beatsPerBar')} beats a bar, "
             f"residual {fit.get('residualMs')} ms, max drift {fit.get('maxDriftMs')} ms: {steady}")
        down = s["downbeat"]
        if down:
            emit(f"  downbeat: bar 1 beat 1 at {down['trackMs']:g} ms in the track ({down['projectMs']:g} ms in the film)")
    sections = [x for x in s["sections"] if isinstance(x, dict)]
    if sections:
        emit("  sections: " + ", ".join(f"bars {x.get('fromBar')}-{x.get('toBar')}" + (f" ({x['novelty']:.2f})" if is_number(x.get("novelty")) else "") for x in sections))
    breaths = [x for x in s["breaths"] if isinstance(x, dict)]
    if breaths:
        shown = ", ".join(f"{fmt_secs(x.get('fromMs'))}-{fmt_secs(x.get('toMs'))} {x.get('kind') or ''}".strip() for x in breaths[:12])
        emit(f"  breaths: {shown}" + (f" (+{len(breaths) - 12} more)" if len(breaths) > 12 else ""))
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


def cmd_song(ctx: Any) -> int:
    a = ctx.args
    project = ctx.project
    manifest = project.manifest()
    rel, path = beats.require_soundtrack(project, manifest)
    if not path.is_file():
        raise KbError(f"the soundtrack {rel} is missing on disk", EXIT_PROBLEMS, kind="invalid", hint="restore the file, or set another with ./kb project set audio.file")
    info = appcli.locate()
    caps = song_caps(info)
    if a.tracker and a.tracker not in caps["trackers"]:
        raise KbError(f"this Kookaburra Cut has no {a.tracker} tracker (it has {', '.join(map(str, caps['trackers']))})", EXIT_ENV, kind="usage")
    args = ["analyse", "--file", str(path.resolve())]
    if a.force:
        args.append("--force")
    if a.tracker:
        args += ["--tracker", a.tracker]
    resp = run_song(info, args, a.timeout)
    analysis = resp.get("analysis")
    if not isinstance(analysis, dict) or not isinstance(analysis.get("sha256"), str):
        raise KbError("the song analysis answered without an analysis", EXIT_ENV, kind="env", hint=UPDATE_HINT)
    digest = analysis["sha256"]
    copy_rel = cache.copy_rel(digest)
    copy_abs = str(project.root / copy_rel)
    if not ctx.dry_run:
        lockmod.kb_dir(project)
    mut = lockmod.mutate_json(project, copy_rel, lambda _old: analysis, op="kb song analyse", caller=ctx.caller, dry_run=ctx.dry_run, lock=False)
    s = summary(analysis, beats.start_offset(manifest), a.lyrics)
    payload: Dict[str, Any] = {"file": rel, "cached": bool(resp.get("cached")), "cachePath": resp.get("cachePath"),
                               "analysisPath": None if ctx.dry_run else copy_abs, **s}
    if not ctx.json:
        print_summary(rel, s, resp, None if ctx.dry_run else copy_abs)
    if not a.accept:
        if ctx.json:
            ctx.out(dict(payload, writes=mut.writes, dryRun=ctx.dry_run))
        elif s["fit"]:
            emit("next: ./kb beats set-grid --from-analysis (or rerun with --accept) to put bar: positions on this grid")
        return EXIT_OK

    def edit(_manifest: Dict[str, Any], audio: Dict[str, Any], _notes: List[str]) -> str:
        grid = beats.grid_from(analysis, rel, False, None)
        audio["grid"] = grid
        return beats.grid_summary(grid)

    res = beats.apply_music(ctx, edit)
    if ctx.json:
        ctx.out(dict(payload, accepted=res, writes=mut.writes + res["writes"], dryRun=ctx.dry_run))
    else:
        beats.print_written(res)
    return EXIT_OK


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """Adds `kb song` to kb's top-level subparsers."""
    structural = argparse.ArgumentParser(add_help=False)
    structural.add_argument("--dry-run", action="store_true", help="analyse, but write nothing (no .kb copy, no grid)")
    structural.add_argument("--wait", type=float, nargs="?", const=600.0, default=None, metavar="SECONDS", help="wait for another kb write to finish (default 10 s)")
    p = sub.add_parser("song", help="analyse the soundtrack with the app's song analyser",
                       description="analyse the soundtrack with the app's song analyser", epilog=EPILOG, formatter_class=Formatter, parents=[common])
    ops = p.add_subparsers(dest="op", metavar="OP")
    ops.required = True
    x = ops.add_parser("analyse", help="fit, downbeat, sections, breaths, stabs (and the lyrics tag with --lyrics)",
                       description="fit, downbeat, sections, breaths, stabs (and the lyrics tag with --lyrics)", epilog=EPILOG,
                       formatter_class=Formatter, parents=[common, structural])
    x.add_argument("--force", action="store_true", help="analyse again even when the app has it cached")
    x.add_argument("--tracker", choices=["nn", "dsp"], help="nn (the bundled beat model) or dsp; default: nn when the model is there")
    x.add_argument("--lyrics", action="store_true", help="print the lyrics tag too")
    x.add_argument("--accept", action="store_true", help="then use the fitted grid (./kb beats set-grid --from-analysis)")
    x.add_argument("--timeout", type=float, default=ANALYSE_TIMEOUT_S, help=f"seconds to wait (default {int(ANALYSE_TIMEOUT_S)})")
    p.set_defaults(fn=cmd_song)
