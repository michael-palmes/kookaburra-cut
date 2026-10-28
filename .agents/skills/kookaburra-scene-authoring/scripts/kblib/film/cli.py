"""`kb verify-export FILE` and `kb check film [...]`: is the finished film what the project asked for, and is it safe and watchable."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..catalog import load_catalog
from ..project import Project
from ..util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, emit, emit_json, ok_envelope
from ..video.passes import Tools
from . import flashes as fl
from . import handoffs as ho
from . import pacing as pc
from . import probe as pb
from . import ranged as rg
from . import report as rp
from . import swatch as sw
from . import timeline as tl

FILM_CHECKS = ("flashes", "colour", "handoffs", "pacing")
NEEDS_FILM = ("flashes", "handoffs")
LATER_CHECKS = ("safe-areas",)
PEAK_WARN_DBTP = -1.0
LOUDNESS_TOLERANCE_LU = 1.0

VERIFY_EPILOG = """\
Checks the file against what the project asked for: the saved export record when kb exported
it, else the project (aspect from the file name, size from the catalogue, 60 fps for High
quality, frames = project length x fps, plus one when a poster frame leads). Then audio and
loudness (--loudness-target, or the preset's; more than 1 LU off warns), the flash gate (the
app's detector plus ffmpeg's photosensitivity pre-check), corner swatches on flat backgrounds
and one contact sheet of each scene's first, settled, named and last frames to Read.

Exit 1 when anything mismatches, or on a flash failure (kind flashes) unless --allow-flashes;
exit 2 without the app's ffmpeg.

  kb verify-export exports/product-tour-16x9.mp4
  kb verify-export ~/Downloads/product-tour-9x16-tiktok.mp4 --loudness-target -14
  kb verify-export exports/product-tour-16x9.mp4 --no-sheet --json"""

FILM_HELP = """\
kb check film [CHECK...] [--file F] [--standard wcag|itu|both] [--allow-flashes] [--no-sheet] [--json]
kb check film --range SPAN | --scene S [--aspect A] [--standard ...] [--allow-flashes] [--json]

Film checks (default: all). flashes and handoffs read a finished export (--file); pacing and
the colour tone-mapping note are static; colour adds corner swatches when --file is given.
--range or --scene checks flashes only, with no export: the running app renders that span
through the export path at 360p and 30 fps and runs the same detector (seconds a scene).
SPAN is bar:13-16 (bars 13 to 16), 12-20 or 00:12-00:20 (film time), or bar:13..cue:drop;
--scene S (repeatable) checks the scene plus a second either side. Each flagged moment gets
a strip (the frames before, at and after it, the changing region boxed) to Read.

  flashes    flash gate: WCAG 2.3.1 / ITU-R BT.1702 general and red flashes (approximate),
             plus ffmpeg's photosensitivity pre-check; exit 1 on a failure unless --allow-flashes
  colour     effects under ACES tone mapping; corner swatches of flat backgrounds (ΔE over 2 warns)
  handoffs   each seam's last and first frames (or either side of its transition), the
             luminance step and picture change; hard steps next to short scenes warn
  pacing     words above label size per second (aim for 3) and per beat, the longest stretch
             without motion (measured on the film with --file), scenes under 334 ms
  safe-areas runs in ./kb verify (text outside the safe area, by key and aspect)

  kb check film pacing
  kb check film --file exports/product-tour-16x9.mp4
  kb check film flashes --file exports/product-tour-16x9.mp4 --standard wcag
  kb check film --scene 04-flythrough
  kb check film --range bar:13-16 --aspect 9:16"""


# ── shared: the film and what it should be ───────────────────────────────────


def resolve_film(raw: str, project: Project) -> Path:
    path = Path(raw).expanduser()
    candidates = [path] if path.is_absolute() else [Path.cwd() / path, project.root / path]
    for c in candidates:
        if c.is_file():
            return c.resolve()
    raise KbError(f"{raw} is not a file; give the exported film's path", EXIT_ENV, kind="usage",
                  hint="look in exports/ or ~/Downloads for <project>-<aspect>.mp4")


def film_context(project: Project, film: Path, tools: Tools, catalog: Any) -> Dict[str, Any]:
    """Probe facts, expectations (record, else static), the timeline, the frame rate and any poster frame."""
    facts = pb.probe(film, tools)
    video = facts["video"]
    sha = rp.sha256_file(film)
    record = rp.load_record(project.slug, sha)
    slots = tl.project_slots(project)
    if record and isinstance(record.get("timeline"), list) and record["timeline"]:
        slots = [dict(s) for s in record["timeline"] if isinstance(s, dict)]
    exp = rp.record_expectations(record) if record else rp.static_expectations(project, film, catalog, slots)
    # Frames are addressed at the file's own rate; the count is judged at the rate the export should have used.
    fps = float(video.get("rFps") or video.get("avgFps") or exp.get("fps") or 60)
    normal = tl.export_frames(exp.get("totalMs") or tl.timeline_total_ms(slots), float(exp.get("fps") or fps))
    actual = video.get("frames")
    poster = exp["posterFrame"] if isinstance(exp.get("posterFrame"), bool) else actual == normal + 1
    expected_frames = exp["frames"] if record and exp.get("frames") else normal + (1 if poster else 0)
    return {"facts": facts, "sha256": sha, "record": str(rp.record_path(project.slug, sha)) if record else None,
            "expected": dict(exp, frames=expected_frames, posterFrame=poster), "slots": slots, "fps": fps,
            "offset": 1 if poster else 0, "posterMs": 1000.0 / fps if poster else 0.0,
            "totalFrames": actual or expected_frames, "width": int(video.get("width") or 0), "height": int(video.get("height") or 0)}


def settled_frames(slots: List[Dict[str, Any]], ctx: Dict[str, Any], project: Project) -> Dict[int, int]:
    """Each scene's settled frame (swatch.settled_ms), where swatches are read."""
    last = max(0, ctx["totalFrames"] - 1)
    return {s["index"]: min(last, tl.frame_at(sw.settled_ms(project, slots, n), ctx["fps"], ctx["offset"])) for n, s in enumerate(slots)}


def _check(rows: List[Dict[str, Any]], cid: str, ok: bool, message: str, severity: str = "error", **extra: Any) -> None:
    rows.append(dict({"id": cid, "ok": ok, "severity": "ok" if ok else severity, "message": message}, **extra))


def expectation_checks(ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    exp, facts = ctx["expected"], ctx["facts"]
    video = facts["video"]
    rows: List[Dict[str, Any]] = []
    w, h = ctx["width"], ctx["height"]
    if exp.get("ratio") and h:
        ok = abs(w / float(h) - exp["ratio"]) / exp["ratio"] < 0.01
        _check(rows, "aspect", ok, f"{w}x{h} is a {exp['aspect']} frame" if ok else f"{w}x{h} is not a {exp['aspect']} frame; the name says {exp['aspect']}")
    if exp.get("width") and exp.get("height"):
        same = (w, h) == (exp["width"], exp["height"])
        _check(rows, "size", same, f"size {w}x{h}" if same else f"size {w}x{h}, expected {exp['width']}x{exp['height']}",
               expected=[exp["width"], exp["height"]], actual=[w, h])
    if exp.get("fps"):
        rate = video.get("rFps") or 0
        same = abs(rate - float(exp["fps"])) < 0.01
        _check(rows, "fps", same, f"{rate:g} fps" if same else f"{rate:g} fps, expected {exp['fps']}", expected=exp["fps"], actual=rate)
    frames = video.get("frames")
    if frames is not None:
        same = frames == exp["frames"]
        poster = " (a poster frame leads)" if exp.get("posterFrame") else ""
        _check(rows, "frames", same,
               f"{frames} frames{poster}" if same else f"{frames} frames, expected {exp['frames']}{poster}: the export is stale or cut short",
               expected=exp["frames"], actual=frames)
    has_audio = facts.get("audio") is not None
    if isinstance(exp.get("audio"), bool):
        same = has_audio == exp["audio"]
        what = "a soundtrack" if exp["audio"] else "no soundtrack"
        _check(rows, "audio", same, f"audio {'present' if has_audio else 'absent'}" if same
               else f"the project has {what} but the file has {'an' if has_audio else 'no'} audio stream")
    return rows


def loudness_checks(film: Path, tools: Tools, ctx: Dict[str, Any], target: Optional[float]) -> Optional[Dict[str, Any]]:
    if ctx["facts"].get("audio") is None:
        return None
    measured = pb.loudness(film, tools) or {}
    rows: List[Dict[str, Any]] = []
    integrated, peak = measured.get("integratedLufs"), measured.get("truePeakDbtp")
    if target is not None and integrated is not None:
        ok = abs(integrated - target) <= LOUDNESS_TOLERANCE_LU
        # A warning, never a failure: gain-only matching lands near the target, and platforms renormalise anyway.
        _check(rows, "loudness", ok, f"{integrated:g} LUFS against a {target:g} LUFS target" + ("" if ok else f" (more than {LOUDNESS_TOLERANCE_LU:g} LU off)"),
               "warn", expected=target, actual=integrated)
    if peak is not None and peak > PEAK_WARN_DBTP:
        _check(rows, "truePeak", False, f"true peak {peak:g} dBTP is over {PEAK_WARN_DBTP:g} dBTP and may clip after upload", "warn")
    return {"measured": measured, "target": target, "checks": rows}


def describe_facts(facts: Dict[str, Any]) -> str:
    v = facts["video"]
    parts = [f"{v.get('codec')}{' (' + str(v.get('profile')) + ')' if v.get('profile') else ''} {v.get('pixFmt')} {v.get('width')}x{v.get('height')}",
             f"{v.get('rFps'):g} fps", f"{v.get('frames')} frames"]
    a = facts.get("audio")
    parts.append(f"{a.get('codec')} {a.get('sampleRate')} Hz {a.get('channels')} ch" if a else "no audio")
    return ", ".join(parts)


def _flash_fail(report: Optional[Dict[str, Any]], allow: bool) -> Optional[str]:
    fails = fl.failures(report)
    if not fails or allow:
        return None
    first = fails[0]
    return f"{len(fails)} flash failure{'s' if len(fails) != 1 else ''}; the first at {first.get('tc')} ({first.get('type')}, {first.get('standard')})"


# ── kb verify-export ─────────────────────────────────────────────────────────


def cmd_verify_export(kbctx: Any) -> int:
    args = kbctx.args
    project = kbctx.project
    catalog = load_catalog()
    film = resolve_film(args.file, project)
    tools = pb.tools()
    ctx = film_context(project, film, tools, catalog)
    rows = expectation_checks(ctx)
    target = args.loudness_target if args.loudness_target is not None else ctx["expected"].get("loudnessTarget")
    loud = loudness_checks(film, tools, ctx, target)
    if loud:
        rows += loud["checks"]
    out_dir = rp.film_dir(project, "verify")
    fps, offset, last = ctx["fps"], ctx["offset"], max(0, ctx["totalFrames"] - 1)
    items = [dict(m, frame=min(last, tl.frame_at(m["ms"], fps, offset))) for m in rp.moments(project, ctx["slots"], fps)]
    sheets: List[str] = []
    legend: List[Dict[str, Any]] = []
    if not args.no_sheet and items:
        aspect = (ctx["width"] or 16) / float(ctx["height"] or 9)
        sheets, legend = rp.contact_sheets(tools.ffmpeg, film, items, out_dir, aspect, "verify")
    settled = settled_frames(ctx["slots"], ctx, project)
    colour = sw.check(tools.ffmpeg, film, project, ctx["slots"], settled, ctx["width"], ctx["height"], catalog) if settled else {"swatches": [], "warnings": []}
    flash = None if args.no_flashes else fl.check(tools, film, fps, standard=args.standard, slots=ctx["slots"], poster_ms=ctx["posterMs"])
    fl.settle(project, flash, "file", film=film, tools=tools, fps=fps, poster_ms=ctx["posterMs"])
    warnings = [r["message"] for r in rows if r["severity"] == "warn"] + colour["warnings"]
    problems = [r["message"] for r in rows if r["severity"] == "error"]
    payload = {
        "file": str(film), "sha256": ctx["sha256"], "bytes": ctx["facts"].get("bytes"), "record": ctx["record"],
        "expected": ctx["expected"], "facts": ctx["facts"], "checks": rows, "loudness": loud and loud["measured"],
        "frames": [{"scene": it["stem"], "label": it["label"], "frame": it["frame"], "ms": int(round(it["ms"]))} for it in items],
        "sheets": sheets, "legend": legend, "swatches": colour["swatches"], "flashes": flash,
        "problems": problems, "warnings": warnings,
    }
    if not kbctx.json:
        emit_verify_text(film, ctx, rows, colour, flash, sheets)
    flash_error = _flash_fail(flash, args.allow_flashes)
    if flash_error:
        raise KbError(flash_error, EXIT_PROBLEMS, kind="flashes", data=payload if kbctx.json else None)
    if problems:
        raise KbError(f"{len(problems)} problem{'s' if len(problems) != 1 else ''} with {film.name}: {problems[0]}", EXIT_PROBLEMS,
                      hint="re-export with the settings named above, then rerun", data=payload if kbctx.json else None)
    if kbctx.json:
        emit_json(ok_envelope("verify-export", payload))
    return EXIT_OK


def emit_verify_text(film: Path, ctx: Dict[str, Any], rows: List[Dict[str, Any]], colour: Dict[str, Any],
                     flash: Optional[Dict[str, Any]], sheets: List[str]) -> None:
    exp = ctx["expected"]
    emit(f"verify-export: {film}")
    emit(f"  file      {describe_facts(ctx['facts'])}; sha256 {ctx['sha256'][:16]}")
    source = f"the export record {ctx['record']}" if ctx["record"] else "the project (no export record)"
    emit(f"  expected  from {source}: {exp.get('aspect') or '?'} {exp.get('preset')}, {exp.get('frames')} frames"
         + (f", {exp.get('fps')} fps" if exp.get("fps") else ""))
    if exp.get("note"):
        emit(f"  note      {exp['note']}")
    for r in rows:
        emit(f"  {r['severity']:<8}  {r['message']}")
    for line in fl.summary_lines(flash):
        emit(f"  {line}")
    for s in colour["swatches"]:
        if s.get("expected"):
            emit(f"  colour    {s['stem']}: corners {' '.join(s['corners'])} vs {s['expected']} (ΔE {s['worstDeltaE']})"
                 + (f"; {s['note']}" if s.get("note") else ""))
    for w in colour["warnings"]:
        emit(f"  warn      {w}")
    for path in sheets:
        emit(f"  sheet     {path} (Read it)")


# ── kb check film ────────────────────────────────────────────────────────────


def film_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="kb check film", description=FILM_HELP, formatter_class=argparse.RawDescriptionHelpFormatter, add_help=True,
                                usage=argparse.SUPPRESS)
    p.add_argument("checks", nargs="*", metavar="CHECK")
    p.add_argument("--file", metavar="F", help="the exported film (flashes, handoffs and colour swatches read it)")
    p.add_argument("--standard", choices=fl.STANDARDS, default="both", help="flash standard (default both)")
    p.add_argument("--allow-flashes", action="store_true", help="report flash failures without failing")
    p.add_argument("--no-sheet", action="store_true", help="skip the handoff contact sheet")
    p.add_argument("--range", metavar="SPAN", help="flashes over this span, rendered by the running app (no export)")
    p.add_argument("--scene", action="append", metavar="S", help="flashes over this scene, a second either side (repeatable)")
    p.add_argument("--aspect", metavar="A", help="the aspect a ranged check renders (default: the editor's)")
    p.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="machine-readable output")
    return p


def ranged_spans(project: Project, args: argparse.Namespace) -> List[Dict[str, Any]]:
    slots = tl.project_slots(project)
    spans = [rg.scene_span(slots, project.resolve(s)[0]) for s in args.scene or []]
    if args.range:
        spans.append(rg.parse_span(args.range, project, tl.timeline_total_ms(slots)))
    return spans


def run_ranged(kbctx: Any, args: argparse.Namespace, json_out: bool) -> int:
    """`kb check film --range SPAN | --scene S`: the flash check over a span the app renders, no export."""
    if args.file:
        raise KbError("--range and --scene render the span themselves; drop --file (or drop them to check the file)", EXIT_ENV, kind="usage")
    if any(c != "flashes" for c in args.checks):
        raise KbError("--range and --scene check flashes only", EXIT_ENV, kind="usage", hint="kb check film --scene S (or kb check film pacing, colour)")
    report = rg.check(kbctx, ranged_spans(kbctx.project, args), args.aspect, args.standard)
    payload = {"checks": ["flashes"], "file": None, "skipped": [], "flashes": report, "warnings": []}
    if not json_out:
        spans = ", ".join(f"{s['label']} ({s['startMs'] / 1000:.2f}-{s['endMs'] / 1000:.2f}s)" for s in report["spans"])
        emit(f"flashes over {spans}: {report['frames']} frames at {report['fps']} fps, {report.get('size', {}).get('width')}x"
             f"{report.get('size', {}).get('height')}, rendered in {report['renderMs'] / 1000:.1f}s")
        for line in fl.summary_lines(report):
            emit(line)
        emit(f"report: {report['folder']}/flashes.json")
    flash_error = _flash_fail(report, args.allow_flashes)
    if flash_error:
        raise KbError(flash_error, EXIT_PROBLEMS, kind="flashes", data=payload if json_out else None,
                      hint="Read each strip, fix the flash, then rerun the same check")
    if json_out:
        emit_json(ok_envelope("check film", payload))
    return EXIT_OK


def run(kbctx: Any, rest: List[str]) -> int:
    """`kb check film ...` (dispatched from kb check)."""
    try:
        args = film_parser().parse_args(rest)
    except SystemExit as e:
        return EXIT_OK if e.code in (0, None) else EXIT_ENV
    json_out = bool(getattr(kbctx, "json", False) or getattr(args, "json", False))
    if args.range or args.scene:
        return run_ranged(kbctx, args, json_out)
    for name in args.checks:
        if name in LATER_CHECKS:
            raise KbError(f"check film {name} runs in ./kb verify", EXIT_ENV, kind="usage", hint="./kb verify (add --formats for every aspect)")
        if name not in FILM_CHECKS:
            raise KbError(f"unknown film check {name!r}; use {', '.join(FILM_CHECKS)}", EXIT_ENV, kind="usage")
    wanted = [c for c in FILM_CHECKS if c in args.checks] or list(FILM_CHECKS)
    named = bool(args.checks)
    project = kbctx.project
    catalog = load_catalog()
    if named and not args.file and any(c in NEEDS_FILM for c in wanted):
        need = ", ".join(c for c in wanted if c in NEEDS_FILM)
        raise KbError(f"{need} read a finished film; pass --file", EXIT_ENV, kind="usage", hint="kb check film flashes --file exports/<project>-16x9.mp4")
    payload: Dict[str, Any] = {"checks": wanted, "file": None, "skipped": []}
    lines: List[str] = []
    film: Optional[Path] = None
    tools: Optional[Tools] = None
    ctx: Optional[Dict[str, Any]] = None
    if args.file:
        film = resolve_film(args.file, project)
        tools = pb.tools()
        ctx = film_context(project, film, tools, catalog)
        payload["file"] = str(film)
    else:
        payload["skipped"] = [c for c in wanted if c in NEEDS_FILM]
    slots = ctx["slots"] if ctx else tl.project_slots(project)
    warnings: List[str] = []
    flash = None
    if "flashes" in wanted and film and tools and ctx:
        flash = fl.check(tools, film, ctx["fps"], standard=args.standard, slots=slots, poster_ms=ctx["posterMs"])
        fl.settle(project, flash, "file", film=film, tools=tools, fps=ctx["fps"], poster_ms=ctx["posterMs"])
        payload["flashes"] = flash
        lines += fl.summary_lines(flash)
    if "colour" in wanted:
        if film and tools and ctx:
            colour = sw.check(tools.ffmpeg, film, project, slots, settled_frames(slots, ctx, project), ctx["width"], ctx["height"], catalog)
        else:
            tone = sw.tone_mapping_warning(project, catalog)
            colour = {"swatches": [], "warnings": [tone] if tone else []}
        payload["colour"] = colour
        warnings += colour["warnings"]
        flat = [s for s in colour["swatches"] if s.get("expected")]
        lines.append(f"colour: {len(flat)} flat background{'s' if len(flat) != 1 else ''} compared, {len(colour['swatches']) - len(flat)} measured only"
                     if film else "colour: static only (pass --file for swatches)")
        lines += [f"  {s['stem']}: {' '.join(s['corners'])} vs {s['expected']} (ΔE {s['worstDeltaE']})" + (f"; {s['note']}" if s.get("note") else "")
                  for s in flat]
        lines += [f"  warn  {w}" for w in colour["warnings"]]
    if "handoffs" in wanted and film and tools and ctx:
        out_dir = rp.film_dir(project, "handoffs")
        result = ho.check(tools.ffmpeg, film, slots, ctx["fps"], ctx["offset"], ctx["totalFrames"])
        if not args.no_sheet and result["seams"]:
            items = []
            for s in result["seams"]:
                a, b = s["frames"]
                kind = s["kind"]
                items.append({"index": s["index"], "stem": s["from"], "label": "last" if kind == "cut" else f"before {kind}", "frame": a,
                              "ms": tl.frame_ms(a, ctx["fps"], ctx["offset"])})
                items.append({"index": s["index"] + 1, "stem": s["to"], "label": "first" if kind == "cut" else f"after {kind}", "frame": b,
                              "ms": tl.frame_ms(b, ctx["fps"], ctx["offset"])})
            aspect = (ctx["width"] or 16) / float(ctx["height"] or 9)
            sheets, legend = rp.contact_sheets(tools.ffmpeg, film, items, out_dir, aspect, "handoffs")
            result["sheets"], result["legend"] = sheets, legend
        result.pop("pngs", None)
        payload["handoffs"] = result
        warnings += result["warnings"]
        lines.append(f"handoffs: {len(result['seams'])} seam{'s' if len(result['seams']) != 1 else ''}")
        for s in result["seams"]:
            step = f"ΔL {s['deltaL']:+.2f}" if s.get("deltaL") is not None else "ΔL ?"
            diff = f", diff {s['diffPct']:.2f}%" if isinstance(s.get("diffPct"), float) else ""
            lines.append(f"  {s['from']} -> {s['to']} ({s['kind']}) at {s['atMs'] / 1000:.2f}s: {step}{diff}" + (f"  !! {s['flag']}" if s.get("flag") else ""))
        lines += [f"  warn  {w}" for w in result["warnings"]]
        lines += [f"  sheet {p} (Read it)" for p in result.get("sheets") or []]
    if "pacing" in wanted:
        motion = pc.film_motion(tools.ffmpeg, film, ctx["fps"], ctx["offset"], slots) if film and tools and ctx else None
        pace = pc.check(project, slots, motion)
        payload["pacing"] = pace
        warnings += pace["warnings"]
        still = pace["still"]
        moved = "motion in the film" if motion is not None else "a keyed or TSX move"
        lines.append(f"pacing: {len(pace['scenes'])} scenes; longest stretch without {moved} {still['longestStillMs'] / 1000:.1f}s")
        lines += [f"  {r['stem']}: {r['words']} words in {r['durationMs'] / 1000:.1f}s ({r['wordsPerSecond']}/s"
                  + (f", {r['wordsPerBeat']:g} a beat" if "wordsPerBeat" in r else "") + ")"
                  + (f", {r['labelWords']} label words left out" if r.get("labelWords") else "") + (f"  !! {r['flag']}" if r.get("flag") else "")
                  for r in pace["scenes"]]
        lines += [f"  warn  {w}" for w in pace["warnings"]]
    if payload["skipped"]:
        lines.append(f"skipped {', '.join(payload['skipped'])}: no film (pass --file exports/<name>.mp4)")
    payload["warnings"] = warnings
    if not json_out:
        for line in lines:
            emit(line)
    flash_error = _flash_fail(flash, args.allow_flashes)
    if flash_error:
        raise KbError(flash_error, EXIT_PROBLEMS, kind="flashes", data=payload if json_out else None)
    if json_out:
        emit_json(ok_envelope("check film", payload))
    return EXIT_OK


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """Adds `kb verify-export` to kb's top-level subparsers (`kb check film` dispatches to `run`)."""
    p = sub.add_parser("verify-export", help="check an exported film: size, rate, frames, audio, loudness, flashes, swatches and a contact sheet",
                       description="check an exported film against what the project asked for, and that it is safe to watch",
                       epilog=VERIFY_EPILOG, formatter_class=Formatter, parents=[common])
    p.add_argument("file", metavar="FILE", help="the exported film (exports/<project>-<aspect>.mp4, or a Downloads copy)")
    p.add_argument("--no-sheet", action="store_true", help="skip the contact sheet")
    p.add_argument("--no-flashes", action="store_true", help="skip the flash check")
    p.add_argument("--allow-flashes", action="store_true", help="report flash failures without failing")
    p.add_argument("--loudness-target", type=float, metavar="LUFS", help="expected integrated loudness; more than 1 LU off warns")
    p.add_argument("--standard", choices=fl.STANDARDS, default="both", help="flash standard (default both)")
    p.set_defaults(fn=cmd_verify_export)
