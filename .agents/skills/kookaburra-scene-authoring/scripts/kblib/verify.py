"""kb verify: every check worth running before calling the work done, in order: static, the app's load and render, each scene's first and last frames (every format with --formats) and the text outside their safe areas, the handoffs between them, and the film's flashes (the newest export when it is current, else a ranged check in the app; a draft export with --film). Every verdict lands in .kb/verify/last.json (`--last` reads it back)."""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple

from . import bridge
from . import capture as capturemod
from . import catalog as catmod
from . import check as checkmod
from . import queue
from .realdir import real_dir
from .util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, EXIT_TRANSIENT, KbError, Report, atomic_write_json, emit, emit_err, now_ms

MAX_FRAMES = 16
SHEET_LONG_EDGE = 1280
FRAME_MS = 1000.0 / 60
PROBE_GRID = 8
LIST_CAP = 12
FILM_EXTENSIONS = (".mp4", ".mov", ".m4v", ".webm")
SOURCE_DIRS = ("scenes", "assets")
CHECK_TIMEOUT_S = 300.0
RENDER_TIMEOUT_S = 600.0
CAPTURE_TIMEOUT_S = 300.0
FILM_EXPORT_ARGS = ["--fps", "30", "--short-edge", "720", "--allow-flashes"]
CUSTOM_EXPORT_SUFFIXES = ("-custom.mp4", "-custom.mp4.flashes.json")
KEEP_DRAFTS = 5
LAST_FILE = "last.json"
# A text line more than this far past the safe area (a share of the frame) is reported.
SAFE_TOLERANCE = 0.005

EPILOG = """\
Runs, in order, and reports each step (ok, time, errors, warnings, files to Read):

  static      the static check (kb check), scoped to --scene when given
  app         the running app's real load, fonts and assets, and one render of each scene
              (kb check --app --render; --no-render skips the render)
  captures    each scene's first and last solo frames at 1280 px (every aspect in formats with
              --formats), with a contact sheet per request (copies in .kb/captures/)
  safe-areas  text lines outside the safe area in those frames, by key and aspect
  handoffs    the luminance step across each seam from those frames (64 probes a frame); a hard
              step next to a short scene warns, and so do four such cuts inside one second
  flashes     the newest exports/ film when it is newer than every source file, else a ranged
              check: the app renders the film (or the --scene scenes) at 360p and 30 fps through
              the export path and runs the same detector; reused while nothing changed
  --film      instead of flashes: ./kb export --fps 30 --short-edge 720 --allow-flashes, then
              ./kb check film --file <it> (flashes, colour, handoffs and pacing on the real film);
              the draft is kept in .kb/verify/, never in exports/
  --quick     static, app, captures, safe areas and handoffs only: no flash check, so never the
              last check before calling the work done

Exit 0 only when every step ran clean (--quick: every step it runs); 1 when a step found
problems; 2 when a step could not run (no app serving this project, an app too old), so the
work is NOT checked: ask the user to open or update Kookaburra Cut; 3 when a step hit something
transient (rerun after retryAfterMs). Each verdict is saved: ./kb verify --last prints it and
exits with its code, so read that instead of a piped run's exit status.

  ./kb verify
  ./kb verify --quick
  ./kb verify --scene 03-pricing --aspect 9:16
  ./kb verify --formats
  ./kb verify --last
  ./kb verify --film"""


class Step:
    """One step's result: ok unless it has errors or was transient; skipped steps are ok."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.started = time.monotonic()
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.paths: List[str] = []
        self.skipped: Optional[str] = None
        self.transient = False
        self.env = False
        self.accepted: List[str] = []
        self.retry_after_ms: Optional[int] = None
        self.code: Optional[str] = None
        self.hint: Optional[str] = None
        self.extra: Dict[str, Any] = {}
        self.ms = 0

    @property
    def ok(self) -> bool:
        return not self.errors and not self.transient and not self.env

    def skip(self, reason: str) -> "Step":
        self.skipped = reason
        return self

    def fail(self, e: KbError) -> None:
        self.errors.append(e.message)
        self.code = e.kind
        self.hint = e.hint
        if e.code == EXIT_TRANSIENT:
            self.transient = True
            self.retry_after_ms = e.retry_after_ms
        elif e.code == EXIT_ENV:
            self.env = True

    def cannot_run(self, reason: str, code: str, hint: Optional[str] = None) -> "Step":
        """The step needed something a person must provide (the app, an update): not a pass."""
        self.errors.append(reason)
        self.code = code
        self.hint = hint
        self.env = True
        return self

    def finish(self) -> "Step":
        self.ms = int((time.monotonic() - self.started) * 1000)
        return self

    def as_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"name": self.name, "ok": self.ok, "ms": self.ms, "errors": self.errors, "warnings": self.warnings}
        if self.skipped:
            out["skipped"] = self.skipped
        if self.paths:
            out["paths"] = self.paths
        if self.transient:
            out["transient"] = True
            if self.retry_after_ms is not None:
                out["retryAfterMs"] = self.retry_after_ms
        if self.env:
            out["notRun"] = True
        if self.accepted:
            out["accepted"] = self.accepted
        if self.code:
            out["code"] = self.code
        if self.hint and not self.ok:
            out["hint"] = self.hint
        out.update(self.extra)
        return out


def lines_of(report: Report, severity: str) -> List[str]:
    return [i.line() for i in report.issues if i.severity == severity]


# ── the plan: which scenes, which frames ─────────────────────────────────────


def chosen_scenes(project: Any, selectors: Optional[List[str]]) -> List[int]:
    count = len(project.scene_entries())
    if not selectors:
        return list(range(count))
    return sorted({project.resolve(s)[0] for s in selectors})


def solo_window(slots: List[Dict[str, Any]], i: int) -> Tuple[float, float]:
    """(first, last) scene-local ms where scene i shows alone: after its incoming transition, before its outgoing one."""
    s = slots[i]
    start, end = float(s["startMs"]), float(s["endMs"])
    lo = max(start, float(slots[i - 1]["endMs"])) if i > 0 else start
    hi = min(end, float(slots[i + 1]["startMs"])) if i + 1 < len(slots) else end
    first = max(0.0, lo - start)
    return first, max(first, hi - start - FRAME_MS)


def frame_plan(project: Any, slots: List[Dict[str, Any]], indices: List[int]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for i in indices:
        if i >= len(slots):
            continue
        first, last = solo_window(slots, i)
        stem = slots[i]["stem"]
        out.append({"index": i, "stem": stem, "label": "first", "at": round(first / 1000.0, 3)})
        out.append({"index": i, "stem": stem, "label": "last", "at": round(last / 1000.0, 3)})
    return out


def capture_size(aspect: str) -> Optional[Tuple[int, int]]:
    """The 1280 px long-edge size a multi-frame capture of this aspect renders at (width even, as the app rounds)."""
    entry = next((e for e in catmod.load_catalog().entries("aspects") or [] if e.get("id") == aspect), None)
    w, h = (entry or {}).get("width"), (entry or {}).get("height")
    if not isinstance(w, (int, float)) or not isinstance(h, (int, float)) or w <= 0 or h <= 0:
        return None
    scale = min(1.0, SHEET_LONG_EDGE / float(max(w, h)))
    width = max(2, int(round(w * scale / 2.0)) * 2)
    return width, max(2, int(round(width * h / float(w))))


def probe_grid(size: Tuple[int, int]) -> List[List[int]]:
    """8 x 8 points at the centres of an even grid, kept clear of the edges (a pixel of rounding never leaves the image)."""
    w, h = size
    return [[int((c + 0.5) * (w - 2) / PROBE_GRID), int((r + 0.5) * (h - 2) / PROBE_GRID)] for r in range(PROBE_GRID) for c in range(PROBE_GRID)]


def probe_luminance(probes: Any) -> Optional[float]:
    from .film import swatch

    vals = []
    for p in probes or []:
        rgba = p.get("rgba") if isinstance(p, dict) else None
        if isinstance(rgba, list) and len(rgba) >= 3:
            vals.append(0.2126 * swatch.linear(rgba[0]) + 0.7152 * swatch.linear(rgba[1]) + 0.0722 * swatch.linear(rgba[2]))
    return sum(vals) / len(vals) if vals else None


# ── steps ────────────────────────────────────────────────────────────────────


def step_static(project: Any, indices: List[int], scoped: bool) -> Step:
    st = Step("static")
    files = None
    if scoped:
        stems = [project.resolve(str(i))[1] for i in indices]
        files = [rel for stem in stems for rel in (f"scenes/{stem}.tsx", f"scenes/{stem}.json") if (project.root / rel).is_file()]
    report = checkmod.check_project(project, files=files, heartbeat=bridge.live_heartbeat(project), once=True)
    st.errors, st.warnings = lines_of(report, "error"), lines_of(report, "warning")
    return st


def no_app_reason(project: Any, hb: Optional[Dict[str, Any]], kind: str) -> Optional[str]:
    if hb is None:
        if bridge.instance_rows(project):
            return "no running Kookaburra Cut serves this project's workspace (./kb status lists the instances), so nothing was rendered"
        return "Kookaburra Cut is not running, so nothing was rendered: ask the user to open the app"
    kinds = hb.get("kinds")
    if isinstance(kinds, list) and kind not in kinds:
        return f"the running app (v{hb.get('appVersion', '?')}) does not answer {kind} requests; ask the user to update Kookaburra Cut"
    return None


def step_app(ctx: Any, hb: Optional[Dict[str, Any]], render: bool) -> Step:
    from . import cli, fonts

    st = Step("app")
    project = ctx.project
    reason = no_app_reason(project, hb, "check")
    if reason:
        return st.cannot_run(reason, "no-app" if hb is None else "env", "ask the user to open (or update) Kookaburra Cut, then rerun ./kb verify")
    try:
        resp = bridge.request("check", {"project": project.project_id, "render": render}, RENDER_TIMEOUT_S if render else CHECK_TIMEOUT_S,
                              "kb verify", client=ctx.caller.name)
    except KbError as e:
        st.fail(e)
        return st
    if not resp.get("error"):
        fonts.record_verdicts([f for f in resp.get("fonts") or [] if isinstance(f, dict)], hb.get("appVersion") if hb else None)
    report = Report()
    if resp.get("error"):
        report.error("app", "", f"the app could not load the project: {resp['error']}")
    else:
        notes = cli.app_check_issues(resp, report)
        if not resp.get("ok") and not report.errors:
            report.error("app", "", "the app reported a failed check without details; run ./kb check --app --json")
        st.extra["rendered"] = bool(resp.get("rendered")) or bool(notes)
    st.errors, st.warnings = lines_of(report, "error"), lines_of(report, "warning")
    if isinstance(resp.get("servedBy"), dict):
        st.extra["servedBy"] = resp["servedBy"]
    return st


def rename_sheet(resp: Dict[str, Any], n: int) -> None:
    sheet = resp.get("sheetPath")
    if isinstance(sheet, str) and Path(sheet).is_file():
        dest = Path(sheet).with_name(f"sheet-{n}.png")
        os.replace(sheet, dest)
        resp["sheetPath"] = str(dest)


def step_captures(ctx: Any, hb: Optional[Dict[str, Any]], plan: List[Dict[str, Any]], aspects: List[str]) -> Tuple[Step, List[Dict[str, Any]]]:
    st = Step("captures")
    project = ctx.project
    reason = no_app_reason(project, hb, "capture")
    if reason:
        return st.skip(reason), []
    if not plan:
        return st.skip("the project has no scenes"), []
    features = queue.capture_features(hb)
    root = capturemod.captures_root(project)
    folder = capturemod.capture_folder(root, ctx.caller.name)
    jobs = [(aspect, plan[i:i + MAX_FRAMES]) for aspect in aspects for i in range(0, len(plan), MAX_FRAMES)]
    frames: List[Dict[str, Any]] = []
    sheets: List[str] = []
    probed = False
    for n, (aspect, chunk) in enumerate(jobs, 1):
        size = capture_size(aspect) if "width" in features else None
        probes = probe_grid(size) if size and "probe" in features else None
        probed = probed or bool(probes)
        body: Dict[str, Any] = {"project": project.project_id, "frames": [{"scene": f["stem"], "at": f["at"]} for f in chunk], "sheet": True, "aspect": aspect}
        if size:
            body["width"] = size[0]
        if probes:
            body["probe"] = probes
        if "texts" in features:
            body["texts"] = True
        try:
            resp = bridge.require_ok(bridge.request("capture", body, CAPTURE_TIMEOUT_S, "kb verify", client=ctx.caller.name), "capture")
        except KbError as e:
            st.fail(e)
            break
        try:
            copied = capturemod.copy_captures(resp, folder)
        except OSError as e:
            st.warnings.append(f"could not copy the capture into {folder}: {e.strerror or e}; the app's own files are listed instead")
        else:
            resp = copied
            if len(jobs) > 1:
                rename_sheet(resp, n)
        got = resp.get("frames") if isinstance(resp.get("frames"), list) else []
        safe = resp.get("safe") if isinstance(resp.get("safe"), dict) else None
        for planned, f in zip(chunk, got):
            f = f if isinstance(f, dict) else {}
            frames.append(dict(planned, aspect=aspect, path=f.get("path"), luminance=probe_luminance(f.get("probes")),
                               texts=f.get("texts") if isinstance(f.get("texts"), list) else None, safe=safe))
        if isinstance(resp.get("sheetPath"), str):
            sheets.append(resp["sheetPath"])
    capturemod.prune_captures(root, keep=folder)
    st.paths = sheets
    st.extra["frames"] = [{k: f.get(k) for k in ("stem", "label", "at", "aspect", "path")} for f in frames]
    st.extra["aspects"] = aspects
    if not probed and frames:
        st.warnings.append("the running app cannot probe pixels, so handoffs are skipped; ask the user to update Kookaburra Cut")
    return st, frames


def text_keys(project: Any, stem: str) -> List[Tuple[str, str]]:
    """(key, normalised text) for a scene's sidecar copy: `text` values and managed items (their points too)."""
    try:
        doc = project.load_sidecar(stem) or {}
    except KbError:
        return []
    out: List[Tuple[str, str]] = []
    text = doc.get("text")
    if isinstance(text, dict):
        out += [(f"text.{k}", norm_text(v)) for k, v in text.items() if isinstance(v, str)]
    managed = doc.get("managedText")
    for n, item in enumerate(managed.get("items") if isinstance(managed, dict) and isinstance(managed.get("items"), list) else []):
        if not isinstance(item, dict):
            continue
        key = f"managedText.{item['key']}" if isinstance(item.get("key"), str) else f"managedText.items.{n}"
        if isinstance(item.get("text"), str):
            out.append((key, norm_text(item["text"])))
        for i, point in enumerate(item.get("points") if isinstance(item.get("points"), list) else []):
            if isinstance(point, dict) and isinstance(point.get("text"), str):
                out.append((f"{key}.points.{i}", norm_text(point["text"])))
    return [(k, v) for k, v in out if v]


def norm_text(value: Any) -> str:
    return " ".join(str(value).split()).casefold()


def overflow(box: Dict[str, Any], safe: Dict[str, Any]) -> Dict[str, float]:
    """How far a normalised box reaches past each edge of the safe area (only the edges it crosses)."""
    x, y, w, h = (float(box.get(k) or 0) for k in ("x", "y", "w", "h"))
    sx, sy, sw, sh = (float(safe.get(k) or 0) for k in ("x", "y", "w", "h"))
    edges = {"left": sx - x, "top": sy - y, "right": (x + w) - (sx + sw), "bottom": (y + h) - (sy + sh)}
    return {k: round(v, 4) for k, v in edges.items() if v > SAFE_TOLERANCE}


def step_safe_areas(project: Any, frames: List[Dict[str, Any]], captures: Step) -> Step:
    """Text lines past the safe area in the captured frames, once per key and aspect; a line mostly off the frame is moving through, not placed."""
    st = Step("safe-areas")
    if captures.skipped:
        return st.skip("no captures")
    measured = [f for f in frames if f.get("texts") is not None and isinstance(f.get("safe"), dict)]
    if not measured:
        return st.skip("the running app does not report text boxes; ask the user to update Kookaburra Cut")
    keys: Dict[str, List[Tuple[str, str]]] = {}
    found: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for f in measured:
        for box in f["texts"]:
            if not isinstance(box, dict) or not isinstance(box.get("text"), str):
                continue
            w, h = float(box.get("w") or 0), float(box.get("h") or 0)
            x, y = float(box.get("x") or 0), float(box.get("y") or 0)
            inside = max(0.0, min(1.0, x + w) - max(0.0, x)) * max(0.0, min(1.0, y + h) - max(0.0, y))
            if w * h <= 0 or inside < 0.5 * w * h:
                continue
            past = overflow(box, f["safe"])
            if not past:
                continue
            stem = f["stem"]
            line = norm_text(box["text"])
            pairs = keys.setdefault(stem, text_keys(project, stem))
            key = next((k for k, v in pairs if line and (line in v or v in line)), None)
            name = key or f'"{box["text"][:40]}"'
            row = found.setdefault((f["aspect"], stem, name), {"aspect": f["aspect"], "scene": stem, "key": key, "text": box["text"],
                                                               "edges": {}, "frames": []})
            for edge, by in past.items():
                row["edges"][edge] = max(row["edges"].get(edge, 0.0), by)
            row["frames"].append(f["label"])
    for row in found.values():
        edges = ", ".join(f"{edge} by {by * 100:.1f}%" for edge, by in sorted(row["edges"].items()))
        what = row["key"] or f'"{row["text"][:40]}"'
        st.warnings.append(f"{row['aspect']} {row['scene']}: {what} crosses the safe area ({edges}) in its {'/'.join(sorted(set(row['frames'])))} frame")
    st.extra["outside"] = list(found.values())
    st.extra["aspects"] = sorted({f["aspect"] for f in measured})
    return st


def step_handoffs(slots: List[Dict[str, Any]], frames: List[Dict[str, Any]], captures: Step) -> Step:
    from .film import handoffs as ho

    st = Step("handoffs")
    if captures.skipped:
        return st.skip("no captures")
    if not captures.ok:
        return st.skip("the captures did not finish")
    primary = frames[0].get("aspect") if frames else None
    by: Dict[Tuple[int, str], Dict[str, Any]] = {(f["index"], f["label"]): f for f in frames if f.get("aspect") == primary}
    seams: List[Dict[str, Any]] = []
    for i in range(len(slots) - 1):
        a, b = by.get((i, "last")), by.get((i + 1, "first"))
        if a is None or b is None:
            continue
        spec = slots[i + 1].get("transitionIn")
        seam: Dict[str, Any] = {"index": i, "from": slots[i]["stem"], "to": slots[i + 1]["stem"], "kind": (spec.get("type") or "crossfade") if spec else "cut",
                                "atMs": int(round(slots[i + 1]["startMs"])),
                                "short": ho.seam_short(slots, i),
                                "paths": [a.get("path"), b.get("path")]}
        if a.get("luminance") is not None and b.get("luminance") is not None:
            seam["deltaL"] = round(b["luminance"] - a["luminance"], 4)
        seams.append(seam)
    if not seams:
        return st.skip("fewer than two neighbouring scenes were captured")
    if all(s.get("deltaL") is None for s in seams):
        return st.skip("the captures carry no pixel probes (an older app)")
    st.warnings = ho.flag_seams(seams, 60.0)
    st.extra["seams"] = seams
    return st


def newest_film(project: Any) -> Optional[Path]:
    folder = project.root / "exports"
    try:
        films = [p for p in folder.iterdir() if p.is_file() and not p.name.startswith(".") and p.suffix.lower() in FILM_EXTENSIONS]
    except OSError:
        return None
    return max(films, key=lambda p: p.stat().st_mtime) if films else None


def theme_sources(project: Any) -> List[Path]:
    """The workspace theme files the project and its scenes use: they change the pictures from outside the folder."""
    ids = {project.manifest().get("themeId")}
    for stem in project.stems():
        try:
            ids.add((project.load_sidecar(stem) or {}).get("themeId"))
        except KbError:
            continue
    files = [project.theme_file(i) for i in ids if isinstance(i, str)]
    return [f for f in files if f is not None]


def newest_source(project: Any) -> Tuple[float, Optional[str]]:
    """The newest mtime among project.json, scenes/**, assets/** (dotfiles skipped) and the workspace themes it uses, and that file."""
    best, name = 0.0, None
    candidates = [project.root / "project.json"] + theme_sources(project)
    for d in SOURCE_DIRS:
        base = project.root / d
        if base.is_dir():
            candidates += [p for p in base.rglob("*") if p.is_file() and not any(part.startswith(".") for part in p.relative_to(base).parts)]
    for p in candidates:
        try:
            m = p.stat().st_mtime
        except OSError:
            continue
        if m > best:
            best, name = m, p.relative_to(project.root).as_posix() if p.is_relative_to(project.root) else str(p)
    return best, name


def flash_lines(report: Optional[Dict[str, Any]]) -> Tuple[List[str], List[str], List[str]]:
    """Errors, open warnings and accepted warnings (shown once, never repeated as warnings)."""
    from .film import flashes as fl

    if not isinstance(report, dict):
        return [], [], []
    errors = [fl.issue_line(i) for i in fl.failures(report)]
    warnings = [fl.issue_line(i) for i in fl.open_warnings(report)]
    if report.get("gate") == "unavailable":
        warnings.append(str(report.get("note") or "the app's flash detector is unavailable; only ffmpeg's pre-check ran"))
    return errors, warnings, [fl.issue_line(i) for i in fl.accepted(report)]


def covers(last: Optional[Dict[str, Any]], spans: List[Dict[str, Any]], aspect: str, newest: float) -> bool:
    """A ranged check of both standards, newer than every source, at this aspect, over every span asked for."""
    if not last or last.get("source") != "range" or (last.get("aspect") or "") != aspect:
        return False
    if not {"wcag-2.3.1", "itu-bt1702"} <= set((last.get("report") or {}).get("standards") or []):
        return False
    if float(last.get("atMs") or 0) / 1000.0 <= newest:
        return False
    done = [s for s in last.get("spans") or [] if isinstance(s, dict)]
    return all(any(float(d.get("startMs", 0)) <= sp["startMs"] + 1 and float(d.get("endMs", 0)) >= sp["endMs"] - 1 for d in done)
               for sp in spans)


def step_flashes(ctx: Any, hb: Optional[Dict[str, Any]], indices: List[int], scoped: bool, aspect: str) -> Step:
    """The newest export when it shows the current project; else a ranged check in the app (reused while nothing changed)."""
    from .film import cli as filmcli
    from .film import flashes as fl
    from .film import probe as pb
    from .film import ranged as rg
    from .film import timeline as tl

    st = Step("flashes")
    project = ctx.project
    film = newest_film(project)
    newest, name = newest_source(project)
    report: Optional[Dict[str, Any]] = None
    if film is not None and film.stat().st_mtime > newest:
        rel = film.relative_to(project.root).as_posix()
        try:
            tools = pb.tools()
            fctx = filmcli.film_context(project, film, tools, catmod.load_catalog())
            report = fl.check(tools, film, fctx["fps"], slots=fctx["slots"], poster_ms=fctx["posterMs"])
            fl.settle(project, report, "file", film=film, tools=tools, fps=fctx["fps"], poster_ms=fctx["posterMs"])
        except KbError as e:
            st.fail(e)
            return st
        st.extra["file"] = rel
    else:
        reason = no_app_reason(project, hb, "range")
        if reason:
            stale = f"{film.relative_to(project.root).as_posix()} is older than {name}" if film else "there is no export yet"
            return st.cannot_run(f"flashes not checked: {stale}, and {reason[0].lower() + reason[1:]}", "not-checked",
                                 "ask the user to open (or update) Kookaburra Cut, or run ./kb verify --film")
        slots = tl.project_slots(project)
        spans = [rg.scene_span(slots, i) for i in indices] if scoped else [{"startMs": 0.0, "endMs": float(tl.timeline_total_ms(slots)), "label": "film"}]
        last = fl.load_last(project)
        if covers(last, spans, aspect, newest):
            from .film import accepts as acc

            report = last["report"]
            acc.apply(report, acc.load(project))
            st.extra["reused"] = time.strftime("%H:%M:%S", time.localtime(float(last.get("atMs") or 0) / 1000.0))
        else:
            try:
                report = rg.check(ctx, spans, aspect, action="kb verify")
            except KbError as e:
                st.fail(e)
                return st
        st.extra["ranged"] = True
        st.extra["spans"] = report.get("spans")
    st.errors, st.warnings, st.accepted = flash_lines(report)
    st.paths = [str(i["strip"]) for i in (report or {}).get("issues") or [] if isinstance(i, dict) and isinstance(i.get("strip"), str) and not i.get("accepted")]
    st.extra["flashes"] = report
    return st


def kb_script() -> Path:
    return Path(__file__).resolve().parent.parent / "kb.py"


def drafts_root(project: Any) -> Path:
    from . import lock

    return real_dir(lock.kb_dir(project), "verify")


def hold_custom_exports(project: Any, hold: Path) -> List[Tuple[Path, Path]]:
    """Move the user's Custom exports aside: the draft export takes the same canonical name."""
    exports = project.root / "exports"
    held: List[Tuple[Path, Path]] = []
    try:
        names = sorted(p for p in exports.iterdir() if p.is_file() and p.name.endswith(CUSTOM_EXPORT_SUFFIXES))
    except OSError:
        return held
    for original in names:
        hold.mkdir(parents=True, exist_ok=True)
        aside = hold / original.name
        os.replace(original, aside)
        held.append((original, aside))
    return held


def keep_draft(project: Any, film: Optional[str], hold: Path) -> Optional[str]:
    """Move the draft and its flash report out of exports/ into .kb/verify/, so exports/ keeps only the user's films."""
    if not film or not Path(film).is_file():
        return film
    folder = hold.parent / time.strftime("%Y%m%d-%H%M%S")
    n = 2
    while folder.exists():
        folder, n = hold.parent / f"{time.strftime('%Y%m%d-%H%M%S')}-{n}", n + 1
    folder.mkdir(parents=True)
    dest = folder / Path(film).name
    os.replace(film, dest)
    for side in (Path(film + ".flashes.json"), Path(film + ".flashes")):
        if side.exists():
            os.replace(side, folder / side.name)
    drafts = sorted(p for p in hold.parent.iterdir() if p.is_dir() and not p.name.startswith("held-"))
    for old in drafts[:-KEEP_DRAFTS]:
        shutil.rmtree(old, ignore_errors=True)
    return str(dest)


def restore_custom_exports(held: List[Tuple[Path, Path]], hold: Path) -> List[str]:
    """Put the user's Custom exports back; a name the draft still holds keeps the original aside and says where."""
    notes: List[str] = []
    for original, aside in held:
        if original.exists():
            notes.append(f"{original.name} is kept at {aside} (its name was taken)")
            continue
        os.replace(aside, original)
    with contextlib.suppress(OSError):
        hold.rmdir()
    return notes


def recover_held_exports(project: Any) -> List[str]:
    """Put back Custom exports that a killed earlier run held aside (its held-<pid>-<ms> folder outlived its pid)."""
    exports = project.root / "exports"
    try:
        holds = sorted(p for p in drafts_root(project).iterdir() if p.is_dir() and p.name.startswith("held-"))
    except OSError:
        return []
    notes: List[str] = []
    for hold in holds:
        pid = hold.name.split("-")[1]
        if pid.isdigit() and bridge.pid_alive(int(pid)):
            continue
        held = [(exports / f.name, f) for f in sorted(hold.iterdir()) if f.is_file()]
        exports.mkdir(exist_ok=True)
        conflicts = restore_custom_exports(held, hold)
        notes += [f"put back {original.name}, which an interrupted kb verify --film had set aside" for original, aside in held if not aside.exists()]
        notes += conflicts
    return notes


def _terminate(signum: int, frame: Any) -> None:
    raise KeyboardInterrupt()


def step_export(ctx: Any, aspect: Optional[str]) -> Tuple[Step, Optional[str]]:
    """./kb export at draft size, kept in .kb/verify/ with the user's Custom exports held aside meanwhile; the draft's absolute path."""
    recovered = recover_held_exports(ctx.project)
    hold = drafts_root(ctx.project) / f"held-{os.getpid()}-{int(time.time() * 1000)}"
    previous = signal.signal(signal.SIGTERM, _terminate)
    held = hold_custom_exports(ctx.project, hold)
    film: Optional[str] = None
    try:
        st, film = run_export(ctx, aspect)
        film = keep_draft(ctx.project, film, hold)
        if film:
            st.paths = [film]
            st.extra["file"] = film
    finally:
        notes = restore_custom_exports(held, hold)
        signal.signal(signal.SIGTERM, previous)
    st.warnings += recovered + notes
    return st, film


def run_export(ctx: Any, aspect: Optional[str]) -> Tuple[Step, Optional[str]]:
    """./kb export at draft size, its JSON lines read as they come (progress goes to stderr); the film's absolute path."""
    from . import exporting

    st = Step("export")
    argv = [sys.executable, "-I", str(kb_script()), "export"] + FILM_EXPORT_ARGS + ["--json", "--agent", ctx.caller.name]
    if aspect:
        argv += ["--aspect", aspect]
    if getattr(ctx.args, "project_dir", None):
        argv += ["-C", str(ctx.project.root)]
    final: Optional[Dict[str, Any]] = None
    try:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, cwd=str(ctx.project.root), text=True)
    except OSError as e:
        st.errors.append(f"could not run kb export: {e}")
        return st, None
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if not isinstance(obj, dict):
                continue
            if obj.get("event") == "progress":
                emit_err(f"kb verify: export {exporting.progress_text(obj)}")
            elif "ok" in obj:
                final = obj
    except BaseException:
        # kb export cancels the app's export on SIGTERM, so no draft lands under the user's held name.
        proc.terminate()
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=exporting.TERM_GRACE_S + 5)
        raise
    code = proc.wait()
    if final is None:
        st.errors.append(f"kb export exited {code} without an answer")
        return st, None
    if not final.get("ok"):
        st.fail(KbError(str(final.get("error") or "kb export failed"), code if code in (EXIT_PROBLEMS, EXIT_ENV, EXIT_TRANSIENT) else EXIT_PROBLEMS,
                        kind=final.get("code"), hint=final.get("hint"), retry_after_ms=final.get("retryAfterMs")))
        return st, None
    path = final.get("path") or (str(ctx.project.root / final["file"]) if final.get("file") else None)
    st.extra["file"] = final.get("file")
    if path:
        st.paths = [str(path)]
    return st, str(path) if path else None


def step_film(ctx: Any, film: Optional[str], export: Step) -> Step:
    from .film import cli as filmcli

    st = Step("film")
    if not film:
        return st.skip("no film (the export did not finish)")
    buf = io.StringIO()
    shim = SimpleNamespace(json=True, project=ctx.project, args=ctx.args, caller=ctx.caller)
    payload: Optional[Dict[str, Any]] = None
    try:
        with contextlib.redirect_stdout(buf):
            filmcli.run(shim, ["--file", film])
        text = buf.getvalue().strip()
        payload = json.loads(text[text.find("{"):]) if "{" in text else None
    except KbError as e:
        if e.kind != "flashes":
            st.fail(e)
            return st
        payload = dict(e.data or {})
    except ValueError:
        payload = None
    if not isinstance(payload, dict):
        st.errors.append("kb check film gave no report")
        return st
    errors, warnings, st.accepted = flash_lines(payload.get("flashes"))
    st.errors = errors
    st.warnings = warnings + [str(w) for w in payload.get("warnings") or []]
    handoffs = payload.get("handoffs") if isinstance(payload.get("handoffs"), dict) else {}
    st.paths = [str(p) for p in handoffs.get("sheets") or []]
    st.extra["file"] = export.extra.get("file")
    return st


# ── the command ──────────────────────────────────────────────────────────────


def overall(steps: List[Step]) -> int:
    if any(s.errors and not s.transient and not s.env for s in steps):
        return EXIT_PROBLEMS
    if any(s.env for s in steps):
        return EXIT_ENV
    if any(s.transient for s in steps):
        return EXIT_TRANSIENT
    return EXIT_OK


def tier_of(a: Any) -> str:
    return "film" if a.film else ("quick" if a.quick else "standard")


def cmd_verify(ctx: Any) -> int:
    from .film import timeline as tl

    a = ctx.args
    project = ctx.project
    if a.last:
        return show_last(ctx)
    if a.quick and a.film:
        raise KbError("--quick skips the flash check that --film runs; pick one", EXIT_ENV, kind="usage")
    known = catmod.load_catalog().ids("aspects", catmod.FALLBACK_ASPECTS) or []
    if a.aspect and known and a.aspect not in known:
        raise KbError(f'unknown aspect "{a.aspect}"; one of {", ".join(known)}', EXIT_ENV, kind="usage")
    indices = chosen_scenes(project, a.scene)
    hb = bridge.live_heartbeat(project)
    formats = project.manifest().get("formats")
    formats = [f for f in formats if isinstance(f, str)] if isinstance(formats, list) else []
    aspect = a.aspect or (hb.get("aspect") if hb and isinstance(hb.get("aspect"), str) else None) or (formats[0] if formats else "16:9")
    aspects = [aspect] + [f for f in formats if f != aspect] if a.formats else [aspect]
    steps: List[Step] = []

    def run(step: Step) -> Step:
        steps.append(step.finish())
        if not ctx.json:
            emit_step(step)
        return step

    run(step_static(project, indices, bool(a.scene)))
    app = run(step_app(ctx, hb, not a.no_render))
    slots = tl.project_slots(project)
    if app.transient:
        captures, frames = Step("captures").skip("the app check was transient; rerun after retryAfterMs"), []
        run(captures)
    elif app.env:
        captures, frames = Step("captures").skip("needs the app"), []
        run(captures)
    else:
        captures, frames = step_captures(ctx, hb, frame_plan(project, slots, indices), aspects)
        run(captures)
    run(step_safe_areas(project, frames, captures))
    run(step_handoffs(slots, frames, captures))
    if a.film:
        export, film = step_export(ctx, a.aspect)
        run(export)
        run(step_film(ctx, film, export))
    elif not a.quick:
        run(step_flashes(ctx, hb, indices, bool(a.scene), aspect))
    code = overall(steps)
    failed = next((s for s in steps if not s.ok), None)
    tier = tier_of(a)
    payload: Dict[str, Any] = {"project": project.project_id, "tier": tier, "aspect": aspect, "aspects": aspects,
                               "scenes": [slots[i]["stem"] for i in indices if i < len(slots)], "steps": [s.as_dict() for s in steps],
                               "exit": code, "summary": summary_line(steps, code, tier)}
    if code == EXIT_TRANSIENT and failed is not None and failed.retry_after_ms is not None:
        payload["retryAfterMs"] = failed.retry_after_ms
    save_last(project, payload, ctx.caller.name)
    if ctx.json:
        error = f"{failed.name}: {failed.errors[0]}" if failed is not None and failed.errors else None
        kind = {EXIT_TRANSIENT: "transient", EXIT_ENV: (failed.code if failed is not None and failed.code else "not-checked")}.get(code, "failed")
        ctx.out(payload, ok=code == EXIT_OK, code=kind, error=error)
    else:
        emit(payload["summary"])
    return code


def emit_step(st: Step) -> None:
    state = "skip" if st.skipped else "ok" if st.ok else "WAIT" if st.transient else "NOT RUN" if st.env else "FAIL"
    counts = f"{len(st.errors)} error{'s' if len(st.errors) != 1 else ''}, {len(st.warnings)} warning{'s' if len(st.warnings) != 1 else ''}"
    emit(f"{state:<7} {st.name:<10} {st.ms:>6} ms  " + (st.skipped or counts))
    for label, items in (("error", st.errors), ("warn ", st.warnings)):
        for line in items[:LIST_CAP]:
            emit(f"          {label}  {line}")
        if len(items) > LIST_CAP:
            emit(f"          ... {len(items) - LIST_CAP} more (--json lists them all)")
    for line in st.accepted:
        emit(f"          note   {line}")
    if st.hint and not st.ok:
        emit(f"          hint   {st.hint}")
    for p in st.paths:
        emit(f"          Read   {p}")


def summary_line(steps: List[Step], code: int, tier: str = "standard") -> str:
    ran = [s for s in steps if not s.skipped]
    skipped = [s.name for s in steps if s.skipped]
    tail = f"; skipped {', '.join(skipped)}" if skipped else ""
    if code == EXIT_OK and tier == "quick":
        return f"verify: quick checks ok ({len(ran)} step{'s' if len(ran) != 1 else ''} ran{tail}); flashes NOT checked, so run ./kb verify before calling the work done"
    if code == EXIT_OK:
        return f"verify: ok ({len(ran)} step{'s' if len(ran) != 1 else ''} ran{tail})"
    if code == EXIT_TRANSIENT:
        return f"verify: a step hit something transient; rerun in a moment{tail}"
    if code == EXIT_ENV:
        missing = [s.name for s in steps if s.env]
        return (f"verify: NOT CHECKED ({', '.join(missing)} could not run{tail}): the work is not verified; "
                "ask the user to open or update Kookaburra Cut, then rerun")
    bad = [s.name for s in steps if s.errors and not s.transient and not s.env]
    return f"verify: FAILED ({', '.join(bad)}){tail}"


# ── the last verdict ─────────────────────────────────────────────────────────


def last_path(project: Any) -> Path:
    # Built by hand: kb_dir creates .kb/, and kb status only reads.
    from . import lock

    return project.root / lock.KB_DIR / "verify" / LAST_FILE


def save_last(project: Any, payload: Dict[str, Any], agent: Optional[str]) -> None:
    """Every verdict, so a piped or backgrounded run is read from here, never from its exit status."""
    steps = []
    for step in payload.get("steps") or []:
        row = {k: step.get(k) for k in ("name", "ok", "ms", "skipped", "notRun", "transient", "code", "hint") if step.get(k) is not None}
        row["errors"] = list(step.get("errors") or [])[:LIST_CAP]
        row["warnings"] = list(step.get("warnings") or [])[:LIST_CAP]
        row["warningCount"] = len(step.get("warnings") or [])
        if step.get("accepted"):
            row["accepted"] = step["accepted"]
        if step.get("paths"):
            row["paths"] = step["paths"]
        steps.append(row)
    body = {"version": 1, "atMs": now_ms(), "agent": agent, "project": payload.get("project"), "tier": payload.get("tier"),
            "aspects": payload.get("aspects"), "scenes": payload.get("scenes"), "exit": payload.get("exit"),
            "ok": payload.get("exit") == EXIT_OK, "summary": payload.get("summary"), "steps": steps}
    try:
        atomic_write_json(last_path(project), body)
    except (KbError, OSError):
        pass


def load_last(project: Any) -> Optional[Dict[str, Any]]:
    try:
        doc = json.loads(last_path(project).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) and isinstance(doc.get("exit"), int) else None


def staleness(project: Any, last: Dict[str, Any]) -> Optional[str]:
    """The source file changed since the verdict, if any."""
    newest, name = newest_source(project)
    return name if newest * 1000 > float(last.get("atMs") or 0) else None


def age_text(ms: float) -> str:
    seconds = max(0, int((now_ms() - ms) / 1000))
    if seconds < 90:
        return f"{seconds} s ago"
    if seconds < 5400:
        return f"{seconds // 60} min ago"
    return f"{seconds // 3600} h ago"


def show_last(ctx: Any) -> int:
    """`kb verify --last`: the saved verdict, its steps and whether anything changed since; exits with its code."""
    last = load_last(ctx.project)
    if last is None:
        raise KbError("no kb verify has run in this project yet", EXIT_ENV, kind="usage", hint="./kb verify")
    stale = staleness(ctx.project, last)
    if ctx.json:
        code = int(last["exit"])
        kind = {EXIT_OK: None, EXIT_TRANSIENT: "transient", EXIT_ENV: next((s.get("code") for s in last.get("steps") or [] if s.get("notRun")), "not-checked")}
        ctx.out(dict(last, stale=stale), ok=code == EXIT_OK, code=kind.get(code, "failed"),
                error=None if code == EXIT_OK else str(last.get("summary")))
        return code
    emit(f"last verify ({last.get('tier')}, {age_text(float(last.get('atMs') or 0))}, by {last.get('agent') or '?'}): exit {last['exit']}")
    for step in last.get("steps") or []:
        state = "skip" if step.get("skipped") else "ok" if step.get("ok") else "WAIT" if step.get("transient") else "NOT RUN" if step.get("notRun") else "FAIL"
        emit(f"  {state:<7} {step.get('name'):<10} " + (str(step.get("skipped")) if step.get("skipped") else
                                                        f"{len(step.get('errors') or [])} errors, {step.get('warningCount', 0)} warnings"))
        for line in step.get("errors") or []:
            emit(f"            error  {line}")
    emit(str(last.get("summary")))
    if stale:
        emit(f"stale: {stale} changed since, so rerun ./kb verify")
    return int(last["exit"])


def status_lines(project: Any) -> List[str]:
    """kb status's last-verify line."""
    last = load_last(project)
    if last is None:
        return ["Last verify: none yet (./kb verify)"]
    verdict = {EXIT_OK: "ok", EXIT_PROBLEMS: "FAILED", EXIT_ENV: "NOT CHECKED", EXIT_TRANSIENT: "transient"}.get(int(last["exit"]), str(last["exit"]))
    stale = staleness(project, last)
    tail = f"; stale, {stale} changed since" if stale else ""
    quick = ", flashes not checked" if last.get("tier") == "quick" else ""
    return [f"Last verify: {verdict} ({last.get('tier')}{quick}) {age_text(float(last.get('atMs') or 0))}{tail}"]


def status_summary(project: Any) -> Optional[Dict[str, Any]]:
    """kb status --json's `lastVerify`."""
    last = load_last(project)
    if last is None:
        return None
    return {"exit": last["exit"], "tier": last.get("tier"), "atMs": last.get("atMs"), "summary": last.get("summary"),
            "stale": staleness(project, last)}


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """Adds `kb verify` to kb's top-level subparsers."""
    s = sub.add_parser("verify", help="every check before calling the work done: static, app load and render, first and last frames, safe areas, handoffs, flashes",
                       description="every check worth running before calling the work done, one step at a time", epilog=EPILOG,
                       formatter_class=Formatter, parents=[common])
    s.add_argument("--scene", action="append", metavar="S", help="only these scenes (repeatable); the app check still loads the whole project")
    s.add_argument("--aspect", metavar="A", help="capture at this aspect (default: the editor's)")
    s.add_argument("--no-render", action="store_true", help="the app check loads the project but renders nothing")
    s.add_argument("--film", action="store_true", help="export a 720p 30 fps draft and run every film check on it, instead of checking the newest export")
    s.add_argument("--quick", action="store_true", help="static, app, captures, safe areas and handoffs only: no flash check")
    s.add_argument("--formats", action="store_true", help="capture every aspect in project.json's formats (first and last frames, safe areas)")
    s.add_argument("--last", action="store_true", help="print the last verdict and exit with its code (read this after a piped or background run)")
    s.set_defaults(fn=cmd_verify)
