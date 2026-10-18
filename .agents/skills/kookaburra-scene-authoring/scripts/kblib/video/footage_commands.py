"""kb video log | pair: the footage log (holds, changes, scrolls, money frames, notes, timestamped sheets) and two takes
paired by their held states. Registered through commands.EXTENSIONS; the maths is footage.py, the decodes passes.py."""

from __future__ import annotations

import argparse
import importlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .. import lock as lockmod
from ..project import Project
from ..util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, atomic_write_json, emit, emit_ok, load_json
from . import detect, labels, passes, review
from . import footage as fo
from . import sheetlayout as sl
from . import smart_commands as sc

FOOTAGE = ".kb/footage"
ORIGINALS = "assets/.originals/"
VERDICT_VERSION = 1
MEDIA_PROBE_TIMEOUT_S = 120.0
MEDIA_DEEP_TIMEOUT_S = 1800.0
MAX_SHEET_CELLS = 2 * sl.MAX_CELLS
TEXT_ROWS = 40
LABEL_INSET = 4


# ── targets ──────────────────────────────────────────────────────────────────


class Source:
    """The recording a log reads: what was asked for, the file actually decoded and how it relates to a conform."""

    def __init__(self, target: str, rel: str, path: Path) -> None:
        self.target = target
        self.rel = rel
        self.path = path
        self.mezzanine: Optional[str] = None
        self.original: Optional[str] = None
        self.decode: Optional[Dict[str, Any]] = None
        self.notes: List[str] = []


def footage_key(rel: str) -> str:
    """assets/sub/rec.mov -> sub--rec: the log's name under .kb/footage/."""
    body = rel[len("assets/"):] if rel.startswith("assets/") else rel
    if "." in body.rsplit("/", 1)[-1]:
        body = body.rsplit(".", 1)[0]
    return sc.safe_name(body.replace("/", "--"))


def timing_rel(rel: str) -> str:
    folder, name = rel.rsplit("/", 1) if "/" in rel else ("", rel)
    stem = name.rsplit(".", 1)[0] if "." in name else name
    return f"{folder}/{stem}.timing.json" if folder else f"{stem}.timing.json"


def _timing(project: Project, rel: str) -> Optional[Dict[str, Any]]:
    path = project.root / rel
    if not path.is_file():
        return None
    try:
        data = load_json(path, rel)
    except KbError:
        return None
    return data if isinstance(data, dict) and data.get("kind") == "conform" else None


def mezzanine_of_original(project: Project, rel: str) -> Optional[str]:
    """The conformed file whose timing record names rel as its original."""
    stem = rel.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    first = f"assets/{stem}.timing.json"
    records = [first] + sorted(p.relative_to(project.root).as_posix() for p in (project.root / "assets").rglob("*.timing.json")
                               if not any(part.startswith(".") for part in p.relative_to(project.root).parts))
    for trel in dict.fromkeys(records):
        record = _timing(project, trel)
        if not record or (record.get("source") or {}).get("original") != rel:
            continue
        mez = (record.get("mezzanine") or {}).get("path")
        if isinstance(mez, str) and mez.startswith("assets/") and ".." not in mez.split("/") and (project.root / mez).is_file():
            return mez
    return None


def resolve_source(project: Project, text: str, tools: passes.Tools, allow_misdecode: bool = False, refresh: bool = False) -> Source:
    """NAME (an edit: its one video source) or SRC; an original resolves to its mezzanine, and an unconformed file ffmpeg
    misdecodes is refused unless allowed."""
    target = sc.resolve_target(project, text, tools)
    if target.is_edit:
        vids = [s for s in target.doc.get("sources") or [] if s.get("kind") != "image"]
        if len(vids) != 1:
            raise KbError(f'edit {target.name} has {len(vids)} video sources; log one by its file, for example ./kb video log {vids[0]["rel"] if vids else "assets/rec.mov"}',
                          EXIT_ENV, kind="usage")
        rel = vids[0]["rel"]
    else:
        rel = target.rel or target.name
    src = Source(text, rel, project.root / rel)
    if rel.startswith(ORIGINALS):
        mez = mezzanine_of_original(project, rel)
        if mez is not None:
            src.original, src.rel, src.path = rel, mez, project.root / mez
            src.notes.append(f"{rel} is the original of {mez}; logging the conformed file")
    if not src.path.is_file():
        raise KbError(f"{src.rel} is missing", EXIT_PROBLEMS, kind="invalid", hint="./kb assets list shows the project's media")
    record = _timing(project, timing_rel(src.rel))
    if record is not None:
        src.mezzanine = src.rel
        src.original = src.original or (record.get("source") or {}).get("original")
        return src
    if src.rel.endswith("-edited.mp4"):
        return src
    src.decode = decode_verdict(project, src.path, refresh)
    if src.decode is None:
        src.notes.append(f"{src.rel}: decode not checked (no Kookaburra Cut with the media probe); a misdecoding file would log the wrong frames")
    elif src.decode.get("verdict") == "ffmpeg-misdecodes" and not allow_misdecode:
        name = src.rel[len("assets/"):] if src.rel.startswith("assets/") else src.rel
        why = ", ".join(src.decode.get("reasons") or []) or "decoder disagreement"
        raise KbError(f"ffmpeg decodes {src.rel} wrongly ({why}), so its log would time the wrong frames; conform it, or pass --allow-misdecode to log it anyway",
                      EXIT_PROBLEMS, kind="invalid", hint=f"./kb assets conform {name}", data={"decode": src.decode})
    return src


# ── the decode verdict ───────────────────────────────────────────────────────


def _optional(name: str) -> Any:
    try:
        return importlib.import_module(f"{__package__.rsplit('.', 1)[0]}.{name}")
    except ImportError:
        return None


def _media_cli() -> Optional[Tuple[Any, int]]:
    """The app CLI and its media version when its caps list `media probe` (an older binary would start the GUI)."""
    from . import appcli

    try:
        info = appcli.locate()
        caps = appcli.caps(info)
    except KbError:
        return None
    media = caps.get("media")
    if not isinstance(media, dict) or "probe" not in (media.get("commands") or []):
        return None
    version = media.get("version")
    return info, version if isinstance(version, int) else 0


def media_probe(cli_path: str, path: Path, deep: bool) -> Optional[Dict[str, Any]]:
    """`<exe> media probe --file ABS [--pts]`: its verdict, or None when it could not judge the file."""
    argv = [cli_path, "media", "probe", "--file", str(path.resolve())] + (["--pts"] if deep else [])
    try:
        proc = subprocess.run(argv, capture_output=True, timeout=MEDIA_DEEP_TIMEOUT_S if deep else MEDIA_PROBE_TIMEOUT_S, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None
    out = proc.stdout.decode("utf-8", "replace").strip()
    for candidate in (out, out.splitlines()[-1] if out else ""):
        try:
            data = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(data, dict) and proc.returncode == 0 and data.get("ok", True) and isinstance(data.get("verdict"), str):
            return data
        return None
    return None


def _app_verdict(path: Path) -> Optional[Dict[str, Any]]:
    found = _media_cli()
    if found is None:
        return None
    info, version = found
    report = media_probe(info.path, path, deep=False)
    deep = False
    if report is not None and report.get("verdict") == "suspect":
        report = media_probe(info.path, path, deep=True) or report
        deep = True
    if report is None:
        return None
    return {"verdict": report["verdict"], "reasons": list(report.get("reasons") or []), "deep": deep, "via": f"app-media-{version}"}


def _kit_verdict(path: Path) -> Optional[Dict[str, Any]]:
    """kb's own verdict (kblib.conform.video_verdict) when this kit carries it."""
    conform = _optional("conform")
    judge = getattr(conform, "video_verdict", None)
    if judge is None:
        return None
    try:
        block = judge(path, deep=False)
        deep = False
        if isinstance(block, dict) and block.get("verdict") == "suspect":
            block, deep = judge(path, deep=True), True
    except KbError:
        return None
    if not isinstance(block, dict) or not isinstance(block.get("verdict"), str) or not block.get("checks"):
        return None
    checks = list(block.get("checks") or [])
    return {"verdict": block["verdict"], "reasons": list(block.get("reasons") or []), "deep": deep, "via": "kb", "checks": checks}


def decode_verdict(project: Project, path: Path, refresh: bool = False) -> Optional[Dict[str, Any]]:
    """Whether ffmpeg (and so the app's clips and kb's decodes) shows this file's frames at their times: the static probe,
    then the decoding one when the static one is unsure; cached by content sha. None when nothing could judge it."""
    adir = sc.vdir(project) / "analysis"
    adir.mkdir(parents=True, exist_ok=True)
    sha = passes.file_sha256(path, adir / "shas.json")
    cache = adir / f"{sha[:24]}-verdict-{VERDICT_VERSION}.json"
    if not refresh:
        try:
            hit = json.loads(cache.read_text(encoding="utf-8"))
            if isinstance(hit, dict) and isinstance(hit.get("verdict"), str):
                return hit
        except (OSError, ValueError):
            pass
    result = _kit_verdict(path) or _app_verdict(path)
    # A verdict without the app's decoders may firm up once the app is there, so only the app's is kept.
    if result is not None and (result["via"] != "kb" or "app" in result.get("checks", [])):
        try:
            atomic_write_json(cache, result)
        except OSError:
            pass
    return result


# ── sheets ───────────────────────────────────────────────────────────────────


def cell_origin(lay: Dict[str, Any], j: int) -> Tuple[int, int]:
    """Top left of cell j's picture in a compose_sheet layout (tile margin and padding, the bar on top)."""
    col, row = j % lay["cols"], j // lay["cols"]
    return (sl.MARGIN + col * (lay["cellW"] + sl.PADDING), sl.MARGIN + row * (lay["cellH"] + sl.BAR + sl.PADDING) + sl.BAR)


def label_scale(lay: Dict[str, Any]) -> int:
    return 2 if min(lay["cellW"], lay["cellH"]) >= 120 else 1


def cell_label(lay: Dict[str, Any], ident: str, ms: float) -> str:
    """The id and the time ("mf3 12.35s"), or just the time when the cell is too narrow for both."""
    stamp = labels.fmt_stamp(ms)
    full = f"{ident} {stamp}" if ident else stamp
    return full if labels.text_size(full, label_scale(lay))[0] <= lay["cellW"] - 2 * LABEL_INSET else stamp


def label_sheet(ffmpeg: str, sheet: Path, lay: Dict[str, Any], texts: Sequence[str]) -> Path:
    """Burn each cell's label into the sheet: one transparent overlay PNG, one ffmpeg overlay."""
    scale = label_scale(lay)
    marks = []
    for j, text in enumerate(texts):
        x, y = cell_origin(lay, j)
        marks.append((x + LABEL_INSET, y + LABEL_INSET, text))
    over = sheet.with_name(sheet.stem + ".labels.png")
    over.write_bytes(labels.overlay_png(lay["width"], lay["height"], marks, scale))
    out = sheet.with_name(sheet.stem + ".labelled.png")
    review._run([ffmpeg, "-v", "error", "-nostdin", "-y", "-i", str(sheet), "-i", str(over), "-filter_complex",
                 "[0:v][1:v]overlay=0:0:format=auto,format=rgb24", "-frames:v", "1", str(out)])
    over.unlink()
    return out


def draw_sheets(tools: passes.Tools, out_dir: Path, tag: str, cells: Sequence[Dict[str, Any]], aspect: float, pairs: bool = False) -> List[Dict[str, Any]]:
    """Cells ({png, id, ms}) tiled into labelled sheets in out_dir: [{ path, index, cells: [{ cell, row, col, id, atMs }] }]."""
    plans = sl.plan_sheets(len(cells), aspect, pairs=pairs)
    out = []
    cursor = 0
    for lay in plans:
        chunk = list(cells[cursor:cursor + lay["cells"]])
        bare = out_dir / f"{tag}-{lay['index']}.bare.png"
        review.compose_sheet(tools.ffmpeg, [{"png": c["png"], "cls": "raw"} for c in chunk], bare, lay)
        final = label_sheet(tools.ffmpeg, bare, lay, [cell_label(lay, c["id"], c["ms"]) for c in chunk])
        bare.unlink()
        legend = [{"cell": j + 1, "row": j // lay["cols"] + 1, "col": j % lay["cols"] + 1, "id": c["id"], "atMs": fo.round_ms(c["ms"])}
                  for j, c in enumerate(chunk)]
        out.append({"path": final, "index": lay["index"], "cells": legend})
        cursor += lay["cells"]
    return out


def source_fps(prof: Dict[str, Any]) -> float:
    info = prof.get("info") or {}
    return float(info.get("editFps") or 60.0)


def frames_at(tools: passes.Tools, path: Path, prof: Dict[str, Any], moments: Sequence[float], out_dir: Path, stem: str) -> List[Path]:
    """The source frame on screen at each moment, as the render's fps=F:start_time=0 grid picks it."""
    fps = source_fps(prof)
    slots = [review.slot_of(ms, fps) for ms in moments]
    pngs = review.extract_slots(tools.ffmpeg, path, fps, slots, out_dir, stem)
    return [pngs[s] for s in slots]


def aspect_of(prof: Dict[str, Any]) -> float:
    info = prof.get("info") or {}
    return (info.get("width") or 9) / float(info.get("height") or 16)


# ── writes ───────────────────────────────────────────────────────────────────


def write_outputs(project: Project, ctx: Any, op: str, json_rel: str, body: Dict[str, Any], sheets: Sequence[Tuple[str, Path]],
                  folder: Optional[str], prefix: str) -> List[Dict[str, Any]]:
    """The log JSON and its sheets in one transaction; earlier sheets of this log that this run did not draw go to the Trash."""
    from .. import git as gitmod

    keep = {rel for rel, _p in sheets}
    stale: List[str] = []
    if folder and (project.root / folder).is_dir():
        own = re.compile(rf"^{re.escape(prefix)}-\d+\.png$")
        stale = sorted(f"{folder}/{p.name}" for p in (project.root / folder).iterdir() if own.match(p.name) and f"{folder}/{p.name}" not in keep)
    if not ctx.dry_run:
        lockmod.kb_dir(project)

    def plan(tx: lockmod.Txn) -> None:
        files = [(json_rel, lockmod.encode_json(body))] + [(rel, path.read_bytes()) for rel, path in sheets]
        for rel, data in files:
            if tx.read(rel)[0] != data:
                tx.write_bytes(rel, data)
        for rel in stale:
            tx.trash(rel, gitmod.trash)

    _res, tx = lockmod.transact(project, op, plan, dry_run=ctx.dry_run, caller=ctx.caller, wait=ctx.wait)
    return tx.writes


# ── kb video log ─────────────────────────────────────────────────────────────


def load_notes(project: Project, text: str) -> Tuple[str, List[Dict[str, Any]], List[int]]:
    path = Path(text).expanduser()
    if not path.is_absolute():
        here = Path.cwd() / path
        path = here if here.is_file() else project.root / path
    try:
        body = path.read_text(encoding="utf-8")
    except OSError as e:
        raise KbError(f"cannot read the notes file {text}: {e.strerror}", EXIT_ENV, kind="usage") from None
    try:
        notes, skipped = fo.parse_notes(body)
    except fo.NotesError as e:
        raise KbError(f"{text}: {e}", EXIT_ENV, kind="usage", hint='write one note a line ("- 0:12.5 opens settings") or JSON { "notes": [{ "t": 12.5, "label": "..." }] }') from None
    try:
        shown = path.resolve().relative_to(project.root.resolve()).as_posix()
    except ValueError:
        shown = str(path.resolve())
    return shown, notes, skipped


def interval_rows(an: Dict[str, Any], rng: Optional[Tuple[float, float]]) -> List[Dict[str, Any]]:
    keys = ("id", "kind", "sub", "startMs", "endMs", "confidence", "note")
    return [{k: iv.get(k) for k in keys} for iv in an.get("intervals") or [] if rng is None or (iv["startMs"] < rng[1] and iv["endMs"] > rng[0])]


def cmd_log(ctx: Any) -> int:
    a = ctx.args
    project = sc.project_of(ctx)
    sc.prune(project)
    if a.money is not None and a.money < 1:
        raise KbError("--money takes a count of 1 or more", EXIT_ENV, kind="usage")
    tools = passes.find_tools()
    src = resolve_source(project, a.target, tools, a.allow_misdecode, a.refresh)
    adir = sc.vdir(project) / "analysis"
    prof = passes.profile_pass(tools, src.path, cache_dir=adir, refresh=a.refresh)
    raw = passes.raw_for(tools, src.path, short_edge=passes.SCREEN_SHORT_EDGE, cache_dir=adir, refresh=a.refresh)
    an = detect.analyse(raw, "auto")
    fr = fo.Frames.from_profile(prof)
    result = fo.analyse(fr, an, scroll=an["profile"] == "screen")
    info = prof.get("info") or {}
    rng = sc.prange(a.range, fps=source_fps(prof), total_ms=fr.end_ms) if a.range else None
    rep = fo.report(result, rng, a.money)
    notes = None
    if a.notes:
        shown, items, skipped = load_notes(project, a.notes)
        aligned = fo.align_notes(items, result["changes"])
        notes = {"file": shown, "medianOffsetMs": aligned["medianOffsetMs"], "items": aligned["items"], "skippedLines": skipped}
    key = footage_key(src.rel)
    json_rel = f"{FOOTAGE}/{key}.json"
    sheet_info: List[Dict[str, Any]] = []
    sheet_files: List[Tuple[str, Path]] = []
    if a.sheet and rep["moneyFrames"]:
        work = sc.vdir(project) / "sheets" / f"log-{key}"
        moments = [m["atMs"] for m in rep["moneyFrames"]][:MAX_SHEET_CELLS]
        pngs = frames_at(tools, src.path, prof, moments, work / "raw", "money")
        cells = [{"png": p, "id": m["id"], "ms": m["atMs"]} for p, m in zip(pngs, rep["moneyFrames"])]
        for sheet in draw_sheets(tools, work, "money", cells, aspect_of(prof)):
            rel = f"{FOOTAGE}/{key}/money-{sheet['index']}.png"
            sheet_files.append((rel, sheet["path"]))
            sheet_info.append({"path": rel, "scratch": sheet["path"], "cells": [dict(c, sheet=sheet["index"]) for c in sheet["cells"]]})
    body: Dict[str, Any] = {
        "version": fo.LOG_VERSION, "target": src.target, "file": src.rel, "sha256": prof.get("sha256"), "mezzanine": src.mezzanine,
        "original": src.original, "decode": src.decode, "durationMs": fo.round_ms(fr.end_ms), "fps": round(float(info.get("fps") or 0), 3),
        "frames": fr.n, "width": fr.width, "height": fr.height, "vfr": bool(info.get("vfr")), "profile": an["profile"],
        "range": [fo.round_ms(rng[0]), fo.round_ms(rng[1])] if rng else None,
        "intervals": interval_rows(an, rng), **rep, "notes": notes,
        "sheets": [], "sheetCells": [c for s in sheet_info for c in s["cells"]],
    }
    if a.sheet and not rep["moneyFrames"]:
        src.notes.append("no money frames to draw a sheet from")
    if ctx.dry_run:
        body["sheets"] = [str(s["scratch"]) for s in sheet_info]
    else:
        body["sheets"] = [str(project.root / s["path"]) for s in sheet_info]
    writes = write_outputs(project, ctx, "kb video log", json_rel, body, sheet_files, f"{FOOTAGE}/{key}" if a.sheet else None, "money")
    payload = dict(body, log=str(project.root / json_rel), notesForAgent=src.notes, writes=writes, dryRun=ctx.dry_run)
    if sc.wants_json(ctx):
        emit_ok(payload)
        return EXIT_OK
    print_log(payload, an)
    return EXIT_OK


def _n(count: int, word: str) -> str:
    return f"{count} {word}" + ("" if count == 1 else "s")


def _list(title: str, rows: List[str]) -> None:
    if not rows:
        return
    emit(f"  {title}:")
    for line in rows[:TEXT_ROWS]:
        emit(f"    {line}")
    if len(rows) > TEXT_ROWS:
        emit(f"    ... {len(rows) - TEXT_ROWS} more in the log")


def print_log(p: Dict[str, Any], an: Dict[str, Any]) -> None:
    rate = "VFR" if p["vfr"] else f"{p['fps']:g} fps"
    lead = f"{p['file']}: {sc.fmt(p['durationMs'])}, {p['width']}x{p['height']}, {rate}, {p['frames']} frames, profile {p['profile']}"
    emit(lead + (f" (mezzanine of {p['original']})" if p.get("mezzanine") and p.get("original") else ""))
    if p.get("decode"):
        emit(f"  decode: {p['decode']['verdict']}" + (f" ({', '.join(p['decode']['reasons'])})" if p["decode"].get("reasons") else ""))
    for note in p.get("notesForAgent") or []:
        emit(f"  note: {note}")
    emit(f"  activity |{detect.strip(an['activity'])}|")
    emit(f"  {_n(len(p['holds']), 'hold')}, {_n(len(p['changes']), 'change')} ({_n(len(p['scrolls']), 'scroll')}), {_n(len(p['moneyFrames']), 'money frame')}"
         + (f", range {sc.fmt(p['range'][0])}-{sc.fmt(p['range'][1])}" if p.get("range") else ""))
    _list("holds", [f"{h['id']:<5} {h['startMs'] / 1000:7.2f}-{h['endMs'] / 1000:<7.2f} {(h['endMs'] - h['startMs']) / 1000:.2f}s" for h in p["holds"]])
    _list("changes", [f"{c['id']:<5} {c['startMs'] / 1000:7.2f}-{c['endMs'] / 1000:<7.2f} {c['kind']:<8} peak {c['peak']:<5} box {','.join(f'{v:g}' for v in c['box'])}"
                      for c in p["changes"]])
    _list("scrolls", [f"{s['id']:<5} {s['startMs'] / 1000:7.2f}-{s['endMs'] / 1000:<7.2f} {s['direction']:<4} {s['pxPerS']} px/s ({s['pxPerFrame']} px a frame)"
                      for s in p["scrolls"]])
    _list("money frames", [f"{m['id']:<5} {m['atMs'] / 1000:7.3f}s  frame {m['frame']}  after {m['change']} ({m['kind']}), hold {m['hold']}, score {m['score']:.2f}"
                           for m in p["moneyFrames"]])
    notes = p.get("notes")
    if notes:
        off = notes["medianOffsetMs"]
        emit(f"  notes ({notes['file']}, median offset {'?' if off is None else f'{off / 1000:+.2f}s'}):")
        for it in notes["items"][:TEXT_ROWS]:
            got = f"{it['changeMs'] / 1000:.2f}s ({it['offsetMs'] / 1000:+.2f}s, {it['change']}, confidence {it['confidence']:.2f})" if it["changeMs"] is not None else "no change found"
            emit(f"    line {it['line']:<4} {it['noteMs'] / 1000:7.2f}s -> {got}  {it['label']}")
        if notes["skippedLines"]:
            emit(f"    skipped lines without a time: {', '.join(map(str, notes['skippedLines'][:12]))}")
    for path in p["sheets"]:
        emit(f"  sheet: {path}")
    emit(f"  log: {p['log']}" + (" (dry run: not written)" if p["dryRun"] else ""))
    if p["sheets"]:
        emit(f"next: Read {p['sheets'][0]}; each money frame is a moment to hold on (posterMs, a freeze, a cut point)")
    else:
        emit(f"next: ./kb video log {p['target']} --sheet, then Read the sheet")


# ── kb video pair ────────────────────────────────────────────────────────────


def states(tools: passes.Tools, project: Project, src: Source, refresh: bool) -> Tuple[Dict[str, Any], fo.Frames, List[Dict[str, Any]]]:
    prof = passes.profile_pass(tools, src.path, cache_dir=sc.vdir(project) / "analysis", refresh=refresh)
    fr = fo.Frames.from_profile(prof)
    return prof, fr, fo.states_of(fr, fo.holds_of(fr, fo.segments(fr, fo.Motion(fr))))


def cmd_pair(ctx: Any) -> int:
    a = ctx.args
    project = sc.project_of(ctx)
    sc.prune(project)
    tools = passes.find_tools()
    sa = resolve_source(project, a.take_a, tools, a.allow_misdecode, a.refresh)
    sb = resolve_source(project, a.take_b, tools, a.allow_misdecode, a.refresh)
    pa, fa, st_a = states(tools, project, sa, a.refresh)
    pb, fb, st_b = states(tools, project, sb, a.refresh)
    res = fo.pair(st_a, st_b)
    key = f"{footage_key(sa.rel)}--{footage_key(sb.rel)}"
    json_rel = f"{FOOTAGE}/pairs/{key}.json"
    sheet_files: List[Tuple[str, Path]] = []
    sheet_info: List[Dict[str, Any]] = []
    notes = sa.notes + sb.notes
    if not a.no_sheet and res["pairs"]:
        work = sc.vdir(project) / "sheets" / f"pair-{key}"
        shown = res["pairs"][:MAX_SHEET_CELLS // 2]
        if len(shown) < len(res["pairs"]):
            notes.append(f"the sheet shows the first {len(shown)} of {len(res['pairs'])} pairs")
        by_a = {s["id"]: s for s in st_a}
        by_b = {s["id"]: s for s in st_b}
        pngs_a = frames_at(tools, sa.path, pa, [fo.settle_ms(by_a[p["a"]]) for p in shown], work / "raw", "a")
        pngs_b = frames_at(tools, sb.path, pb, [fo.settle_ms(by_b[p["b"]]) for p in shown], work / "raw", "b")
        cells: List[Dict[str, Any]] = []
        for p, x, y in zip(shown, pngs_a, pngs_b):
            cells.append({"png": x, "id": "A", "ms": fo.settle_ms(by_a[p["a"]])})
            cells.append({"png": y, "id": "B", "ms": fo.settle_ms(by_b[p["b"]])})
        for sheet in draw_sheets(tools, work, "pair", cells, aspect_of(pa), pairs=True):
            rel = f"{FOOTAGE}/pairs/{key}-{sheet['index']}.png"
            sheet_files.append((rel, sheet["path"]))
            sheet_info.append({"path": rel, "scratch": sheet["path"]})
    sheets = [str(s["scratch"]) if ctx.dry_run else str(project.root / s["path"]) for s in sheet_info]
    body: Dict[str, Any] = {
        "version": fo.LOG_VERSION,
        "a": {"target": sa.target, "file": sa.rel, "sha256": pa.get("sha256"), "durationMs": fo.round_ms(fa.end_ms), "states": len(st_a), "decode": sa.decode},
        "b": {"target": sb.target, "file": sb.rel, "sha256": pb.get("sha256"), "durationMs": fo.round_ms(fb.end_ms), "states": len(st_b), "decode": sb.decode},
        **res, "sheet": sheets[0] if sheets else None, "sheets": sheets,
    }
    folder = f"{FOOTAGE}/pairs" if not a.no_sheet else None
    writes = write_outputs(project, ctx, "kb video pair", json_rel, body, sheet_files, folder, key)
    payload = dict(body, log=str(project.root / json_rel), notesForAgent=notes, writes=writes, dryRun=ctx.dry_run)
    if sc.wants_json(ctx):
        emit_ok(payload)
        return EXIT_OK
    print_pair(payload)
    return EXIT_OK


def print_pair(p: Dict[str, Any]) -> None:
    off, drift = p["medianOffsetMs"], p["driftMsPerS"]
    off_text = "?" if off is None else f"{off / 1000:+.3f}s"
    drift_text = "?" if drift is None else f"{drift:+.2f} ms/s"
    emit(f"{p['a']['file']} ({_n(p['a']['states'], 'hold')}) and {p['b']['file']} ({_n(p['b']['states'], 'hold')}): {_n(len(p['pairs']), 'pair')}, "
         f"median offset {off_text}, drift {drift_text}")
    for note in p.get("notesForAgent") or []:
        emit(f"  note: {note}")
    rows = []
    for x in p["pairs"]:
        so = "-" if x["startOffsetMs"] is None else f"{x['startOffsetMs']:+d}"
        eo = "-" if x["endOffsetMs"] is None else f"{x['endOffsetMs']:+d}"
        rows.append(f"A {x['a']:<5} {x['aMs'] / 1000:7.2f}s  B {x['b']:<5} {x['bMs'] / 1000:7.2f}s  start {so} ms, end {eo} ms, score {x['score']:.2f}")
    _list("pairs", rows)
    _list("only in A", [f"{s['id']:<5} {s['startMs'] / 1000:7.2f}-{s['endMs'] / 1000:.2f}s" for s in p["unmatchedA"]])
    _list("only in B", [f"{s['id']:<5} {s['startMs'] / 1000:7.2f}-{s['endMs'] / 1000:.2f}s" for s in p["unmatchedB"]])
    for path in p["sheets"]:
        emit(f"  sheet: {path}")
    emit(f"  log: {p['log']}" + (" (dry run: not written)" if p["dryRun"] else ""))
    if off is not None:
        lead = "later" if off > 0 else "earlier"
        emit(f"next: B shows each state {abs(off) / 1000:.3f}s {lead} than A" + (f"; Read {p['sheets'][0]} to check the pairs" if p["sheets"] else ""))


# ── registration ─────────────────────────────────────────────────────────────


LOG_EPILOG = """\
  ./kb video log assets/rec.mov                    holds, changes, scrolls and money frames (cached by content)
  ./kb video log rec --notes notes.md --sheet      align your notes, draw the money frames with timestamps
  ./kb video log assets/rec.mov --range 10-20 --money 6
Notes are lines like "- 0:12.5 opens settings" or "12.5s save" (# comments), or JSON { "notes": [{ "t": 12.5, "label": "..." }] }.
Writes .kb/footage/<name>.json (and sheets in .kb/footage/<name>/). An original resolves to its conformed file;
a file ffmpeg decodes wrongly is refused (./kb assets conform NAME) unless --allow-misdecode."""

PAIR_EPILOG = """\
  ./kb video pair assets/take1.mov assets/take2.mov    held states matched in order, B's offset from A
Writes .kb/footage/pairs/<a>--<b>.json and a sheet with each pair side by side (A left, B right)."""


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    writes = argparse.ArgumentParser(add_help=False)
    writes.add_argument("--dry-run", action="store_true", help="analyse and draw, write nothing into .kb/footage/")
    writes.add_argument("--wait", type=float, nargs="?", const=600.0, default=None, metavar="SECONDS", help="wait for the project lock (default 10 s)")
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--refresh", action="store_true", help="decode again, ignoring the cached analysis")
    shared.add_argument("--allow-misdecode", action="store_true", help="log a file ffmpeg decodes wrongly anyway (its times will be off)")

    s = sub.add_parser("log", help="footage log: holds, changes, scrolls with speed, money frames, notes aligned, timestamped sheets",
                       description="footage log of a recording: holds, changes, scrolls with speed, money frames, notes aligned to it, timestamped sheets",
                       epilog=LOG_EPILOG, formatter_class=Formatter, parents=[common, writes, shared])
    s.add_argument("target", metavar="NAME|SRC")
    s.add_argument("--notes", metavar="FILE", help="your notes, one timed line each, to align with the changes")
    s.add_argument("--sheet", action="store_true", help="a contact sheet of the money frames, each stamped with its time")
    s.add_argument("--range", metavar="A-B", help="only report this source range")
    s.add_argument("--money", type=int, metavar="N", help="keep the N best money frames")
    s.set_defaults(fn=cmd_log)

    s = sub.add_parser("pair", help="align two takes of one flow by their held states: per-state offsets, median offset and drift",
                       description="align two takes of one flow by their held states: per-state offsets, the median offset and drift",
                       epilog=PAIR_EPILOG, formatter_class=Formatter, parents=[common, writes, shared])
    s.add_argument("take_a", metavar="A", help="the first take (an edit NAME or a SRC)")
    s.add_argument("take_b", metavar="B", help="the second take; offsets are B minus A")
    s.add_argument("--no-sheet", action="store_true", help="skip the side-by-side sheet")
    s.set_defaults(fn=cmd_pair)
