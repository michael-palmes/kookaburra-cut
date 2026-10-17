"""kb video analyse | cleanup | fit | align | frames | sheet | taps suggest, registered through commands.EXTENSIONS; the kb engine modules load lazily."""

from __future__ import annotations

import argparse
import importlib
import json
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .. import bridge
from ..project import Project, find_root, worktree_of
from ..util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, atomic_write_json, bridge_dir, emit, emit_err, emit_json
from . import cleanup as cl
from . import detect, passes, review
from . import fit as fitmod
from . import sheetlayout as sl

DEFAULT_SHEET_COUNT = 12
DEFAULT_COMPARE_COUNT = 6
DRAFT_SCALE = 0.5
KB = "kb video"


# ── plumbing ─────────────────────────────────────────────────────────────────


def need(name: str) -> Any:
    try:
        return importlib.import_module(f"{__package__}.{name}")
    except ImportError:
        raise KbError(f"this kit has no kb video engine ({name}); ask the user to update Kookaburra Cut", EXIT_ENV) from None


def maybe(name: str) -> Any:
    try:
        return importlib.import_module(f"{__package__}.{name}")
    except ImportError:
        return None


def project_of(ctx: Any) -> Project:
    p = getattr(ctx, "project", None)
    if isinstance(p, Project):
        return p
    return Project(find_root(explicit=getattr(ctx.args, "project_dir", None)))


def wants_json(ctx: Any) -> bool:
    return bool(getattr(ctx, "json", False) or getattr(ctx.args, "json", False))


def vdir(project: Project) -> Path:
    cache = maybe("cache")
    if cache is not None:
        try:
            return Path(cache.video_dir(project))
        except (TypeError, AttributeError):
            return Path(cache.video_dir(project.root))
    return bridge_dir() / "video" / project.root.name


def prune(project: Project) -> None:
    cache = maybe("cache")
    if cache is not None and hasattr(cache, "prune"):
        try:
            cache.prune(project)
        except Exception:  # noqa: BLE001 - housekeeping never fails a command
            pass


def refuse_worktree(project: Project) -> None:
    commands = maybe("commands")
    if commands is not None and hasattr(commands, "guard_worktree"):
        commands.guard_worktree(project)
        return
    found = worktree_of(project.root)
    if found:
        from ..overview import worktree_banner

        raise KbError("\n".join(worktree_banner(found)), EXIT_ENV)


def safe_name(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-")[:80] or "x"


def fmt(ms: Optional[float]) -> str:
    return "?" if ms is None else f"{ms / 1000:.2f}s"


def checkpoint(project: Project, what: str) -> Optional[str]:
    """kb's checkpoint_before when the engine has it (never fails the caller), else a plain checkpoint."""
    commands = maybe("commands")
    if commands is not None and hasattr(commands, "checkpoint_before"):
        return commands.checkpoint_before(project, what)
    from .. import git as gitmod

    try:
        return gitmod.checkpoint(project, f"before {what}")
    except KbError as e:
        emit_err(f"kb: note: no checkpoint ({e.message})")
        return None


# ── time grammar (kb's plan.parse_time when present) ─────────────────────────


_TIME_RE = re.compile(r"^(?:(\d+):)?(\d+(?:\.\d+)?)(ms|s)?$")


def ptime(text: str, *, fps: Optional[float] = None, total_ms: Optional[float] = None) -> float:
    plan = maybe("plan")
    if plan is not None and hasattr(plan, "parse_time"):
        return float(plan.parse_time(text, fps=fps, total_ms=total_ms))
    t = text.strip()
    if t.startswith("end"):
        if total_ms is None:
            raise KbError(f'"{text}": end needs a known length', 2)
        rest = t[3:]
        return float(total_ms) - (ptime(rest[1:], fps=fps) if rest.startswith("-") else 0.0)
    if t.startswith("f") and t[1:].isdigit():
        return int(t[1:]) * 1000.0 / (fps or 60.0)
    m = _TIME_RE.match(t)
    if not m:
        raise KbError(f'"{text}" is not a time: use seconds (2.5), 2500ms, 1:02.5, f150, end or end-2s', 2)
    minutes, num, unit = m.group(1), float(m.group(2)), m.group(3)
    if minutes is not None:
        return (int(minutes) * 60 + num) * 1000.0
    return num if unit == "ms" else num * 1000.0


def prange(text: str, *, fps: Optional[float] = None, total_ms: Optional[float] = None) -> Tuple[float, float]:
    plan = maybe("plan")
    if plan is not None and hasattr(plan, "parse_range"):
        a, b = plan.parse_range(text, fps=fps, total_ms=total_ms)
        return float(a), float(b)
    for i, ch in enumerate(text):
        if ch == "-" and 0 < i < len(text) - 1:
            try:
                a, b = ptime(text[:i], fps=fps, total_ms=total_ms), ptime(text[i + 1:], fps=fps, total_ms=total_ms)
            except KbError:
                continue
            if b > a:
                return a, b
    raise KbError(f'"{text}" is not a range: use A-B, for example 3-5.5 or 1:02-1:10', 2)


def plist(text: str) -> List[str]:
    return [p.strip() for p in text.split(",") if p.strip()]


def src_time(text: str, doc: Dict[str, Any]) -> Tuple[str, float]:
    """[SID@]T in source time; SID may be omitted when the edit has one video source."""
    vids = [s for s in doc.get("sources") or [] if s.get("kind") != "image"]
    if "@" in text:
        sid, t = text.split("@", 1)
        if not any(s["id"] == sid for s in doc.get("sources") or []):
            raise KbError(f'no source "{sid}" in this edit (it has {", ".join(s["id"] for s in doc.get("sources") or [])})', 2)
    else:
        if len(vids) != 1:
            raise KbError(f'this edit has {len(vids)} video sources; name one, for example s1@{text}', 2)
        sid, t = vids[0]["id"], text
    src = next(s for s in doc["sources"] if s["id"] == sid)
    return sid, ptime(t, fps=cl.doc_fps(doc), total_ms=src.get("durationMs"))


# ── targets ──────────────────────────────────────────────────────────────────


class Target:
    def __init__(self, kind: str, name: str, doc: Dict[str, Any], sha: Optional[str] = None, rel: Optional[str] = None) -> None:
        self.kind = kind
        self.name = name
        self.doc = doc
        self.sha = sha
        self.rel = rel

    @property
    def is_edit(self) -> bool:
        return self.kind == "edit"


def source_doc(tools: passes.Tools, project: Project, rel: str) -> Dict[str, Any]:
    """The single full-length clip a fresh edit of this file would start as (edit.rs create_default_doc)."""
    info = passes.probe(tools, project.root / rel)
    return {
        "version": 1, "name": Path(rel).stem, "settings": {"width": info["width"], "height": info["height"], "fps": info["editFps"]},
        "sources": [{"id": "s1", "rel": rel, "kind": "video", "width": info["width"], "height": info["height"], "fps": info["fps"], "durationMs": info["durationMs"]}],
        "clips": [{"id": "c1", "sourceId": "s1", "inMs": 0, "outMs": info["durationMs"], "speed": 1, "startMs": 0}],
        "taps": [], "masks": [],
    }


def asset_rel(project: Project, text: str) -> Optional[str]:
    rel = text[2:] if text.startswith("./") else text
    if not rel.startswith("assets/"):
        rel = f"assets/{rel}"
    if ".." in rel.split("/"):
        return None
    return rel if (project.root / rel).is_file() else None


def resolve_target(project: Project, text: str, tools: Optional[passes.Tools] = None) -> Target:
    editdoc = maybe("editdoc")
    if editdoc is not None:
        names = editdoc.list_names(project)
        if text in names:
            doc, sha = editdoc.load(project, text)
            return Target("edit", text, doc, sha)
    rel = asset_rel(project, text)
    if rel:
        from ..assets import kind_of

        if kind_of(rel) != "video":
            raise KbError(f"{rel} is not a video; analysis, frames and sheets need a recording", 2)
        return Target("source", rel, source_doc(tools or passes.find_tools(), project, rel), rel=rel)
    hint = "kb video list shows edits; kb assets list shows media" if editdoc else "kb assets list shows media"
    raise KbError(f'no edit or asset named "{text}" ({hint})', 2)


def edit_for_source(project: Project, rel: str, dry_run: bool, tools: passes.Tools) -> Target:
    """The edit that cuts this source (an existing one first), creating it unless this is a dry run."""
    editdoc = need("editdoc")
    for name in editdoc.list_names(project):
        try:
            doc, sha = editdoc.load(project, name)
        except KbError:
            continue
        if (doc.get("sources") or [{}])[0].get("rel") == rel:
            return Target("edit", name, doc, sha)
    name = editdoc.default_name(rel)
    if dry_run:
        doc = source_doc(tools, project, rel)
        doc["name"] = name
        return Target("edit", name, doc, None)
    refuse_worktree(project)
    need("appcli").create(project, rel)
    doc, sha = editdoc.load(project, name)
    return Target("edit", name, doc, sha)


def analyses_for(project: Project, doc: Dict[str, Any], tools: passes.Tools, profile: str = "auto",
                 refresh: bool = False, sources: Optional[Sequence[str]] = None) -> Dict[str, Dict[str, Any]]:
    used = {c.get("sourceId") for c in doc.get("clips") or []}
    out: Dict[str, Dict[str, Any]] = {}
    short = passes.CAMERA_SHORT_EDGE if profile == "camera" else passes.SCREEN_SHORT_EDGE
    for s in doc.get("sources") or []:
        if s.get("kind") == "image" or s["id"] not in used or (sources and s["id"] not in sources):
            continue
        path = project.root / s["rel"]
        if not path.is_file():
            raise KbError(f"{s['rel']} (source {s['id']}) is missing; restore it before analysing")
        raw = passes.raw_for(tools, path, short_edge=short, cache_dir=vdir(project) / "analysis", refresh=refresh)
        out[s["id"]] = detect.analyse(raw, profile)
    return out


# ── analyse ──────────────────────────────────────────────────────────────────


def analysis_text(label: str, an: Dict[str, Any], rng: Optional[Tuple[float, float]] = None) -> List[str]:
    rate = "VFR" if an["vfr"] else f"{an.get('fps') or 0:g} fps"
    lines = [f"{label}: {fmt(an['durationMs'])}, {an.get('width')}x{an.get('height')}, {rate} (edit fps {an.get('editFps') or 60:g}), "
             f"profile {an['profile']} ({an['profileReason']})"]
    lines.append(f"  activity |{detect.strip(an['activity'])}|")
    lines.append(f"  kinds    |{detect.kind_strip(an['intervals'], an['durationMs'])}|  (B black, < lead-in, > lead-out, . static, | blink, ~ loading, = typing, # active)")
    for iv in an["intervals"]:
        if rng and (iv["endMs"] <= rng[0] or iv["startMs"] >= rng[1]):
            continue
        kind = iv["kind"] + (f" {iv['sub']}" if iv.get("sub") and iv["kind"] != "black" else "")
        lines.append(f"  {iv['id']:<4} {iv['startMs'] / 1000:7.2f}-{iv['endMs'] / 1000:<7.2f} {kind:<18} {iv['confidence']:.2f}  {iv['note']}")
    events = [("screen change", c["tMs"], f"score {c['score']:.0f}{', out of black' if c['fromBlack'] else ''}") for c in an["screenChanges"]]
    events += [(f"tap candidate {k['id']}", k["tMs"], f"source {k['sourceMs'] / 1000:.3f}s at {k['pos'][0]:.3f},{k['pos'][1]:.3f}, "
                f"confidence {k['confidence']:.2f}, then a {k['followedBy']}") for k in an["tapCandidates"]]
    shown = [e for e in sorted(events, key=lambda e: e[1]) if not rng or rng[0] <= e[1] < rng[1]]
    if shown:
        lines.append("  events:")
        lines += [f"    {t / 1000:7.3f}s  {name}  ({note})" for name, t, note in shown]
    return lines


def cmd_analyse(ctx: Any) -> int:
    a = ctx.args
    project = project_of(ctx)
    tools = passes.find_tools()
    target = resolve_target(project, a.target, tools)
    analyses = analyses_for(project, target.doc, tools, a.profile, a.refresh)
    total = cl.total_ms(target.doc["clips"], cl.image_ids(target.doc))
    rng = prange(a.range, fps=cl.doc_fps(target.doc), total_ms=total) if a.range else None
    projected = detect.project(cl.relayout(target.doc["clips"]), analyses) if target.is_edit else []
    if wants_json(ctx):
        emit_json({"target": target.name, "kind": target.kind, "sources": {sid: dict(an, rel=next(s["rel"] for s in target.doc["sources"] if s["id"] == sid))
                                                                          for sid, an in analyses.items()},
                   "timeline": projected if target.is_edit else None})
        return EXIT_OK
    for sid, an in analyses.items():
        rel = next(s["rel"] for s in target.doc["sources"] if s["id"] == sid)
        for line in analysis_text(f"{rel}" + (f" (source {sid})" if target.is_edit else ""), an, None if target.is_edit else rng):
            emit(line)
    if target.is_edit:
        emit(f"\non the timeline of {target.name} ({fmt(total)}):")
        for p in sorted(projected, key=lambda r: r["timelineMs"][0] if isinstance(r["timelineMs"], list) else r["timelineMs"]):
            if rng and isinstance(p["timelineMs"], list) and (p["timelineMs"][1] <= rng[0] or p["timelineMs"][0] >= rng[1]):
                continue
            if p["kind"] in ("screen-change", "tap-candidate"):
                emit(f"  {p['clip']:<4} {p['timelineMs'] / 1000:7.3f}s  {p['kind']}{' ' + p['id'] if p.get('id') else ''}")
            else:
                kind = p["kind"] + (f" {p['sub']}" if p.get("sub") and p["kind"] != "black" else "")
                emit(f"  {p['clip']:<4} {p['timelineMs'][0] / 1000:7.2f}-{p['timelineMs'][1] / 1000:<7.2f} {kind:<18} {p['interval']}  at {p['speed']:g}x")
        emit(f"next: {KB} cleanup {target.name} --dry-run, then {KB} sheet {target.name} --changes and Read it")
    else:
        emit(f"next: {KB} cleanup {target.name} --dry-run (makes or reuses its edit), or {KB} sheet {target.name} and Read it")
    return EXIT_OK


# ── cleanup ──────────────────────────────────────────────────────────────────


def keep_ranges(doc: Dict[str, Any], texts: Sequence[str]) -> List[Tuple[str, float, float]]:
    """--keep A-B on the edit's timeline, mapped to every source span it shows."""
    clips = cl.relayout(doc["clips"], cl.image_ids(doc))
    total = cl.total_ms(clips, cl.image_ids(doc))
    out = []
    for text in texts:
        a, b = prange(text, fps=cl.doc_fps(doc), total_ms=total)
        for c in clips:
            if c.get("holdMs") is not None:
                continue
            end = c["startMs"] + cl.clip_ms(c)
            x, y = max(a, c["startMs"]), min(b, end)
            if y > x:
                s = cl.eff_speed(c.get("speed"))
                out.append((c["sourceId"], c["inMs"] + (x - c["startMs"]) * s, c["inMs"] + (y - c["startMs"]) * s))
    return out


def clip_signature(clips: Sequence[Dict[str, Any]]) -> List[Tuple[Any, ...]]:
    return [(c.get("sourceId"), int(c["inMs"]), int(c["outMs"]), round(cl.eff_speed(c.get("speed")), 6), c.get("holdMs")) for c in clips]


def clean_clip(c: Dict[str, Any]) -> Dict[str, Any]:
    out = {"id": c["id"], "sourceId": c["sourceId"], "inMs": int(c["inMs"]), "outMs": int(c["outMs"]),
           "speed": float(c.get("speed") or 1), "startMs": int(c.get("startMs") or 0)}
    if out["speed"].is_integer():
        out["speed"] = int(out["speed"])
    if c.get("holdMs") is not None:
        out["holdMs"] = int(round(c["holdMs"]))
    return out


def apply_clips(project: Project, name: str, clips: Sequence[Dict[str, Any]], sha: Optional[str], label: str) -> Any:
    editdoc = need("editdoc")
    wanted = [clean_clip(c) for c in clips]

    def fn(doc: Dict[str, Any]) -> Dict[str, Any]:
        return dict(doc, clips=wanted)

    return editdoc.mutate(project, name, fn, base=sha, label=label)


def apply_ops(project: Project, name: str, ops: Sequence[Dict[str, Any]], expected: Sequence[Dict[str, Any]], sha: Optional[str],
              label: str, notes: List[str]) -> Any:
    """Range ops through kb's plan, which must land exactly on cleanup's simulation; anything else writes nothing."""
    editdoc, plan, appcli = need("editdoc"), need("plan"), maybe("appcli")
    wanted = [clean_clip(c) for c in expected]

    def fn(doc: Dict[str, Any]) -> Dict[str, Any]:
        probe = (lambda rel: appcli.probe(project, rel)) if appcli else None
        new, _reports = plan.run_plan(doc, list(ops), probe=probe)
        if clip_signature(cl.relayout(new.get("clips") or [])) != clip_signature(wanted):
            raise KbError("nothing written: kb's plan and cleanup's simulation disagree on the new clips (a kb bug); rerun with --emit-plan to inspect the ops", EXIT_PROBLEMS)
        return new

    return editdoc.mutate(project, name, fn, base=sha, label=label)


def cmd_cleanup(ctx: Any) -> int:
    a = ctx.args
    project = project_of(ctx)
    tools = passes.find_tools()
    preset = "gentle" if a.gentle else ("aggressive" if a.aggressive else "normal")
    target = resolve_target(project, a.target, tools)
    if not target.is_edit:
        target = edit_for_source(project, target.rel or a.target, a.dry_run or a.emit_plan, tools)
    doc = target.doc
    analyses = analyses_for(project, doc, tools)
    keep = keep_ranges(doc, a.keep or [])
    plan = cl.plan_cleanup(doc, analyses, preset=preset, keep=keep, skip=a.skip or [], cuts_only=a.cuts_only, no_speed=a.no_speed)
    if a.emit_plan:
        emit_json({"name": target.name, "baseHash": target.sha, "ops": plan.ops})
        return EXIT_OK
    notes: List[str] = []
    applied = False
    if plan.capped:
        report = plan.as_json()
        if wants_json(ctx):
            emit_json(dict(report, ok=False, error=plan.capped))
        else:
            emit_err(f"kb: {plan.capped}")
        return EXIT_PROBLEMS
    if plan.ops and not a.dry_run:
        refuse_worktree(project)
        checkpoint(project, f"{KB} cleanup {target.name}")
        apply_ops(project, target.name, plan.ops, plan.doc["clips"], target.sha, f"{KB} cleanup", notes)
        applied = True
    sheet = None
    if plan.ops:
        try:
            sheet = build_sheet(project, Target("edit", target.name, plan.doc), tools, mode="changes", render=False, grid=False,
                                tag="cleanup")
        except KbError as e:
            notes.append(f"no changes sheet ({e.message})")
    if wants_json(ctx):
        emit_json(dict(plan.as_json(), name=target.name, applied=applied, dryRun=bool(a.dry_run), notes=notes,
                       sheet=sheet["paths"] if sheet else None))
        return EXIT_OK
    verb = "would change" if a.dry_run else "changed"
    if not plan.ops:
        emit(f"{target.name}: nothing to clean up at {preset} ({fmt(plan.before['ms'])}).")
    else:
        emit(f"{target.name}: {verb} {fmt(plan.before['ms'])} -> {fmt(plan.after['ms'])} ({plan.before['frames']} -> {plan.after['frames']} frames) at {preset}")
        for it in plan.items:
            what = "cut" if it["action"] == "cut" else f"sped up to {it['speed']:g}x"
            where = f"timeline {fmt(it['timelineMs'][0])}-{fmt(it['timelineMs'][1])}" if it.get("timelineMs") else ""
            sub = f" {it['sub']}" if it.get("sub") and it["kind"] != "black" else ""
            joined = "".join(f"+{n.split()[-1]}" for n in it.get("notes") or [] if n.startswith("joined with"))
            emit(f"  {what:<16} source {it['sourceId']} {it['fromMs'] / 1000:.2f}-{it['toMs'] / 1000:.2f}s  {where}  "
                 f"{it['kind']}{sub}{' and what follows' if joined else ''} {it['interval']}{joined} ({it['confidence']:.2f}), saves {it['savedMs'] / 1000:.2f}s")
    for sk in plan.skipped:
        if sk["reason"] == "--skip" or "confidence" in sk["reason"] or "seam" in sk["reason"] or "piece" in sk["reason"]:
            emit(f"  kept {sk['interval']} {sk['kind']}{' ' + sk['sub'] if sk.get('sub') else ''} {sk['rangeMs'][0] / 1000:.2f}-{sk['rangeMs'][1] / 1000:.2f}s: {sk['reason']}")
    for c in plan.clips_skipped:
        emit(f"  left {c['clip']} alone: {c['reason']}")
    if plan.protected_taps:
        emit(f"  taps protected: {', '.join(t['tap'] for t in plan.protected_taps)}")
    for m in plan.masks:
        emit(f"  mask {m['mask']} still covers source {m['spanMs'][0] / 1000:.2f}-{m['spanMs'][1] / 1000:.2f}s; parts of it were cut")
    for n in notes:
        emit(f"  note: {n}")
    if sheet:
        emit(f"changes sheet: {', '.join(sheet['paths'])}")
    if a.dry_run:
        again = target.name if target.sha else target.doc["sources"][0]["rel"]
        emit(f"next: Read the changes sheet, then {KB} cleanup {again}" + (f" --{preset}" if preset != "normal" else "") + " to apply")
    elif applied:
        emit(f"next: Read the changes sheet, then {KB} render {target.name}; undo: kb undo; open in the editor: {KB} open {target.name}")
    return EXIT_OK


def cmd_taps(ctx: Any) -> int:
    a = ctx.args
    project = project_of(ctx)
    tools = passes.find_tools()
    target = resolve_target(project, a.target, tools)
    analyses = analyses_for(project, target.doc, tools)
    rows = cl.tap_suggestions(target.doc, analyses, a.min_confidence)
    if wants_json(ctx):
        emit_json({"name": target.name, "candidates": rows})
        return EXIT_OK
    if not rows:
        emit(f"{target.name}: no tap candidates (a tap shows as a small change after a still moment, then a new screen).")
        return EXIT_OK
    for r in rows:
        src = f"{r['sourceId']}@{r['sourceMs'] / 1000:.3f}"
        emit(f"{r['id']}  {r['timelineMs'] / 1000:7.3f}s  (source {src}s, clip {r['clip']} at {r['speed']:g}x)  at {r['pos'][0]:.3f},{r['pos'][1]:.3f}  "
             f"confidence {r['confidence']:.2f}, then a {r['followedBy']}")
        emit(f"    check: {KB} frames {target.name} --src {src} --grid")
        emit(f"    add:   {KB} tap add {target.name} --src {src} --pos {r['pos'][0]:.3f},{r['pos'][1]:.3f}")
    emit("next: Read each gridded frame and add only the taps you can see; cleanup never adds them")
    return EXIT_OK


# ── fit / align ──────────────────────────────────────────────────────────────


def scene_slot(project: Project, scene: str, slot: Optional[str], doc: Dict[str, Any], name: str) -> Dict[str, Any]:
    """The slot showing this edit in the scene: --slot, else the one slot showing its sources or its render."""
    repoint = need("repoint")
    if not slot:
        rels = [s["rel"] for s in doc.get("sources") or []]
        editdoc = maybe("editdoc")
        if editdoc is not None:
            rels.append(editdoc.output_rel(name))
        base, target = repoint.pick_slot(project, scene, rels)
        slot = repoint.slot_ref(base, target)
    info = repoint.slot_info(project, scene, slot)
    if not isinstance(info, dict):
        raise KbError(f"scene {scene} has no slot {slot} showing this video", 2)
    return info


def fit_report(ctx: Any, name: str, res: fitmod.FitResult, applied: bool, dry: bool, extra: Optional[Dict[str, Any]] = None) -> None:
    if wants_json(ctx):
        emit_json(dict(res.as_json(), name=name, applied=applied, dryRun=dry, **(extra or {})))
        return
    verb = "would be" if dry else "is now"
    emit(f"{name}: {fmt(res.before_ms)} -> {fmt(res.ms)}, {verb} exactly {res.frames} frames at {res.fps:g} fps (target {res.target_frames})")
    for s in res.steps:
        emit(f"  {s}")
    for an in res.anchors:
        emit(f"  anchor {an['sourceId']}@{an['sourceMs'] / 1000:.3f}s lands at {fmt(an['landedMs'])} (target {fmt(an['targetMs'])})")
    for w in res.warnings:
        emit(f"  warning: {w}")
    if dry:
        emit(f"next: rerun without --dry-run to apply, then {KB} sheet {name} --seams and Read it")
    elif applied:
        emit(f"next: {KB} sheet {name} --seams and Read it, then {KB} render {name}; undo: kb undo; open in the editor: {KB} open {name}")


def cmd_fit(ctx: Any) -> int:
    a = ctx.args
    project = project_of(ctx)
    tools = passes.find_tools()
    target = resolve_target(project, a.target, tools)
    if not target.is_edit:
        raise KbError(f"fit works on an edit; make one first: {KB} new {target.rel}", 2)
    doc = target.doc
    fps = cl.doc_fps(doc)
    images = cl.image_ids(doc)
    total = cl.total_ms(doc["clips"], images)
    warnings: List[str] = []
    if a.to:
        goal = ptime(a.to, fps=fps, total_ms=total)
    elif a.scene is not None:
        info = scene_slot(project, a.scene, a.slot, doc, target.name)
        if info.get("followsMedia"):
            raise KbError(f"scene {a.scene} follows this video's length, so fitting to it changes nothing; pass --to T for the length you "
                          f"want and the scene follows once rendered and used ({KB} render {target.name} --use --scene {a.scene})", 2)
        start = float(info.get("startMs") or 0)
        end = info.get("transitionOutStartMs") if a.end == "before-transition" else info.get("sceneDurationMs")
        if not isinstance(end, (int, float)):
            end = info.get("sceneDurationMs")
        goal = float(end) - start
        if goal <= 0:
            raise KbError(f"the slot starts at {start:.0f} ms, after the {a.end} point; lower its startMs first")
    else:
        raise KbError("give --to T or --scene S", 2)
    anchors = []
    for spec in a.anchor or []:
        if "@" not in spec:
            raise KbError(f'--anchor "{spec}": use SRC@TARGET, for example s1@12.4@6 or 12.4@6', 2)
        left, right = spec.rsplit("@", 1)
        tap = next((t for t in doc.get("taps") or [] if t["id"] == left), None)
        sid, ms = (tap["sourceId"], float(tap["sourceMs"])) if tap else src_time(left, doc)
        anchors.append((sid, ms, ptime(right, fps=fps, total_ms=goal)))
    analyses = analyses_for(project, doc, tools)
    try:
        res = fitmod.fit(doc, analyses, goal, strategy=a.strategy, anchors=anchors)
    except fitmod.FitError as e:
        bound = f" (the shortest it can go is {fmt(e.minimum_ms)})" if e.minimum_ms else ""
        raise KbError(f"{e.message}{bound}") from None
    res.warnings.extend(warnings)
    applied = False
    if not a.dry_run and clip_signature(res.clips) != clip_signature(cl.relayout(doc["clips"], images)):
        refuse_worktree(project)
        checkpoint(project, f"{KB} fit {target.name}")
        apply_clips(project, target.name, res.clips, target.sha, f"{KB} fit")
        applied = True
    fit_report(ctx, target.name, res, applied, bool(a.dry_run))
    return EXIT_OK


def write_start_ms(project: Project, scene: str, info: Dict[str, Any], start: int) -> str:
    """Shift the slot's scene-local video start through kb's hash-checked, guarded sidecar write."""
    repoint = need("repoint")
    res = repoint.set_start(project, scene, repoint.slot_ref(str(info.get("slot") or ""), info.get("targetId")), int(start))
    return f"scenes/{res['scene']}.json {res['slot']} startMs {res['fromMs']} -> {res['toMs']}"


def cmd_align(ctx: Any) -> int:
    a = ctx.args
    project = project_of(ctx)
    tools = passes.find_tools()
    target = resolve_target(project, a.target, tools)
    if not target.is_edit:
        raise KbError(f"align works on an edit; make one first: {KB} new {target.rel}", 2)
    doc = target.doc
    fps = cl.doc_fps(doc)
    if a.tap:
        tap = next((t for t in doc.get("taps") or [] if t["id"] == a.tap), None)
        if tap is None:
            raise KbError(f'no tap "{a.tap}" in {target.name} ({KB} tap list {target.name})', 2)
        sid, ms = tap["sourceId"], float(tap["sourceMs"])
        lead = fitmod.TAP_LEAD_MS
    elif a.src:
        sid, ms = src_time(a.src, doc)
        lead = 0.0
    else:
        raise KbError("give the moment: --src [SID@]T or --tap ID", 2)
    if a.lead is not None:
        lead = ptime(a.lead, fps=fps)
    info = None
    target_local = target_tl = None
    if a.at is not None:
        target_tl = ptime(a.at, fps=fps, total_ms=cl.total_ms(doc["clips"], cl.image_ids(doc)))
    else:
        if a.scene is None:
            raise KbError("--beat, --moment and --scene-at need --scene S (and --slot P when it shows more than one video)", 2)
        info = scene_slot(project, a.scene, a.slot, doc, target.name)
        if a.scene_at is not None:
            target_local = ptime(a.scene_at, fps=fps, total_ms=info.get("sceneDurationMs"))
        elif a.beat is not None or a.moment is not None:
            idx, _stem = project.resolve(a.scene)
            beats = fitmod.scene_beats(project.root, idx, lambda p: json.loads(p.read_text(encoding="utf-8")))
            kind, n = ("beat", a.beat) if a.beat is not None else ("moment", a.moment)
            target_local = fitmod.pick_beat(beats, kind, n)
        else:
            raise KbError("give a target: --at, --beat N, --moment N or --scene-at T", 2)
    if a.scene is not None and info is None:
        info = scene_slot(project, a.scene, a.slot, doc, target.name)
    analyses = analyses_for(project, doc, tools)
    try:
        plan = fitmod.align(doc, analyses, sid, ms, target_tl=target_tl, target_local=target_local, slot=info, lead=lead,
                            prefer=a.prefer, keep_length=a.keep_length)
    except fitmod.FitError as e:
        bound = f" (the part before the moment can only shrink to {fmt(e.minimum_ms)})" if e.minimum_ms else ""
        raise KbError(f"{e.message}{bound}; pick a later target or cut more first") from None
    applied = False
    where = None
    if plan.side == "scene":
        if not a.dry_run:
            refuse_worktree(project)
            checkpoint(project, f"{KB} align {target.name}")
            where = write_start_ms(project, a.scene, info or {}, int(plan.start_ms or 0))
            applied = True
        if wants_json(ctx):
            emit_json(dict(plan.as_json(), name=target.name, applied=applied, wrote=where))
            return EXIT_OK
        emit(f"{target.name}: {'would move' if a.dry_run else 'moved'} the video's start in scene {a.scene} from {plan.old_start_ms} to {plan.start_ms} ms"
             f" so source {sid}@{ms / 1000:.3f}s lands at {fmt(target_local)} in the scene (lead {lead:.0f} ms); no re-render needed")
        if where:
            emit(f"  wrote {where}")
        emit(f"next: kb capture --scene {a.scene} --at {(target_local or 0) / 1000:.3f} and Read it; undo: kb undo")
        return EXIT_OK
    res = plan.fit
    assert res is not None
    if not a.dry_run and clip_signature(res.clips) != clip_signature(cl.relayout(doc["clips"], cl.image_ids(doc))):
        refuse_worktree(project)
        checkpoint(project, f"{KB} align {target.name}")
        apply_clips(project, target.name, res.clips, target.sha, f"{KB} align")
        applied = True
    for n in plan.notes:
        res.warnings.append(n)
    fit_report(ctx, target.name, res, applied, bool(a.dry_run), {"align": plan.as_json()})
    return EXIT_OK


# ── frames / sheets ──────────────────────────────────────────────────────────


def ensure_draft(project: Project, target: Target, tools: passes.Tools) -> Tuple[Path, Dict[str, Any]]:
    """A half-size software draft of the doc in the video cache, reused while the doc and its sources are unchanged."""
    appcli = need("appcli")
    memo = vdir(project) / "analysis" / "shas.json"
    shas = [passes.file_sha256(project.root / s["rel"], memo) for s in target.doc.get("sources") or []]
    key = review.doc_key(target.doc, shas, DRAFT_SCALE)
    path = vdir(project) / "drafts" / f"{safe_name(target.name)}-{key}.mp4"
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        appcli.render(project, doc=target.doc, out=str(path), draft=True)
        prune(project)
    if not path.is_file():
        raise KbError("the draft render did not produce a file; run kb video validate on the edit")
    return path, passes.probe(tools, path)


def source_of(doc: Dict[str, Any], sid: Optional[str]) -> Dict[str, Any]:
    return next((s for s in doc.get("sources") or [] if s["id"] == sid), {})


def gather(project: Project, target: Target, tools: passes.Tools, items: List[Dict[str, Any]], render: bool, out_dir: Path,
           stem: str) -> None:
    """Fill each item's raw png (+ crop): {mode: source, sourceId, slot} or {mode: output, k}."""
    doc = target.doc
    fps = cl.doc_fps(doc)
    outs = [it for it in items if it["mode"] == "output"]
    if outs and render:
        draft, info = ensure_draft(project, target, tools)
        pngs = review.extract_frames(tools.ffmpeg, draft, [it["k"] for it in outs], out_dir, f"{stem}-r")
        mapped = {p["k"]: p for p in review.predict(doc, [it["k"] for it in outs])}
        for it in outs:
            it["png"] = pngs[it["k"]]
            p = mapped.get(it["k"]) or {}
            src = source_of(doc, p.get("sourceId"))
            it.update({"clip": p.get("clip"), "speed": p.get("speed"), "cls": p.get("class"), "sourceId": p.get("sourceId"),
                       "sourceMs": p.get("sourceMs"), "timelineMs": p.get("timelineMs")})
            if src.get("width"):
                it["crop"] = review.contain_fit(info["width"], info["height"], src["width"], src["height"])
                it["shape"] = (src["width"], src["height"])
    elif outs:
        for it, p in zip(outs, review.predict(doc, [it["k"] for it in outs])):
            it.update({"clip": p["clip"], "speed": p["speed"], "cls": p["class"], "sourceId": p["sourceId"], "sourceMs": p["sourceMs"],
                       "timelineMs": p["timelineMs"], "slot": p.get("slot")})
            it["mode2"] = "image" if p.get("image") else "source"
    by_source: Dict[str, List[Dict[str, Any]]] = {}
    for it in items:
        if it["mode"] == "source" or it.get("mode2") == "source":
            by_source.setdefault(it["sourceId"], []).append(it)
        elif it.get("mode2") == "image":
            src = source_of(doc, it["sourceId"])
            it["png"] = project.root / src["rel"]
            it["shape"] = (src.get("width"), src.get("height"))
    for sid, group in by_source.items():
        src = source_of(doc, sid)
        path = project.root / src["rel"]
        pngs = review.extract_slots(tools.ffmpeg, path, fps, [it["slot"] for it in group], out_dir, f"{stem}-{sid}")
        for it in group:
            it["png"] = pngs[it["slot"]]
            it["shape"] = (src.get("width"), src.get("height"))
            it.setdefault("sourceMs", round(review.slot_ms(it["slot"], fps), 3))


def parse_zoom(text: Optional[str]) -> Optional[List[float]]:
    if not text:
        return None
    try:
        vals = [float(v) for v in text.split(",")]
    except ValueError:
        vals = []
    if len(vals) != 4 or vals[2] <= 0 or vals[3] <= 0 or any(v < 0 or v > 1 for v in vals):
        raise KbError("--zoom takes x,y,w,h as fractions of the frame, for example 0.1,0.6,0.5,0.2", 2)
    return vals


def cmd_frames(ctx: Any) -> int:
    a = ctx.args
    project = project_of(ctx)
    tools = passes.find_tools()
    target = resolve_target(project, a.target, tools)
    doc = target.doc
    fps = cl.doc_fps(doc)
    images = cl.image_ids(doc)
    clips = cl.relayout(doc["clips"], images)
    total_frames = cl.total_frames(clips, fps, images)
    total = cl.total_ms(clips, images)
    want = [w.strip() for w in (a.overlay or "").split(",") if w.strip()]
    zoom = parse_zoom(a.zoom)
    items: List[Dict[str, Any]] = []
    render = target.is_edit and not a.predict
    if a.src:
        for spec in plist(a.src):
            sid, ms = src_time(spec, doc)
            items.append({"mode": "source", "sourceId": sid, "slot": review.slot_of(ms, fps), "label": f"source {sid}@{ms / 1000:.3f}s", "cls": "raw"})
    elif a.at:
        for spec in plist(a.at):
            t = ptime(spec, fps=fps, total_ms=total)
            if target.is_edit:
                items.append({"mode": "output", "k": review.output_frame_at(t, fps, total_frames), "label": f"timeline {t / 1000:.3f}s"})
            else:
                items.append({"mode": "source", "sourceId": "s1", "slot": review.slot_of(t, fps), "label": f"{t / 1000:.3f}s", "cls": "raw"})
    elif a.tap or a.mask:
        if not target.is_edit:
            raise KbError("--tap and --mask need an edit", 2)
        if a.tap:
            tap = next((t for t in doc.get("taps") or [] if t["id"] == a.tap), None)
            if tap is None:
                raise KbError(f'no tap "{a.tap}" in {target.name}', 2)
            occ = cl.occurrences(clips, tap["sourceId"], tap["sourceMs"])
            if not occ:
                raise KbError(f"tap {a.tap} is not visible: no clip shows source {tap['sourceMs'] / 1000:.3f}s any more")
            t0 = cl.timeline_at(occ[0], tap["sourceMs"])
            for off in review.TAP_OFFSETS_MS:
                t = max(0.0, min(total - 1, t0 + off))
                items.append({"mode": "output", "k": review.output_frame_at(t, fps, total_frames, first_after=True), "label": f"tap {a.tap} {off:+d} ms"})
            want = want or ["taps"]
        else:
            mask = next((m for m in doc.get("masks") or [] if m["id"] == a.mask), None)
            if mask is None:
                raise KbError(f'no mask "{a.mask}" in {target.name}', 2)
            render = True
            moments = [("span start", mask["startMs"])] + [(f"key {k['sourceMs'] / 1000:.3f}s", k["sourceMs"]) for k in mask.get("keys") or []]
            moments += [("end - 1 ms", mask["endMs"] - 1), ("end + 1 ms", mask["endMs"] + 1)]
            for label, ms in moments:
                occ = cl.occurrences(clips, mask["sourceId"], ms)
                if occ:
                    t = cl.timeline_at(occ[0], ms)
                    items.append({"mode": "output", "k": review.output_frame_at(t, fps, total_frames, first_after=True), "label": f"mask {a.mask} {label}"})
            if not items:
                raise KbError(f"mask {a.mask} is not on the timeline: no clip shows its span")
            rects = [k["rect"] for k in mask.get("keys") or []]
            if rects and not zoom:
                x0 = max(0.0, min(r[0] for r in rects) - 0.08)
                y0 = max(0.0, min(r[1] for r in rects) - 0.08)
                x1 = min(1.0, max(r[0] + r[2] for r in rects) + 0.08)
                y1 = min(1.0, max(r[1] + r[3] for r in rects) + 0.08)
                zoom_items = [dict(items[0], label=items[0]["label"] + " (zoom)", zoom=[x0, y0, x1 - x0, y1 - y0])]
                items.extend(zoom_items)
            want = want or ["masks"]
    else:
        raise KbError("give --at LIST, --src LIST, --tap ID or --mask ID", 2)
    out_dir = vdir(project) / "frames" / safe_name(target.name)
    request = [str(getattr(a, k, None)) for k in ("at", "src", "tap", "mask", "grid", "zoom", "overlay", "predict")]
    stem = review.doc_key(doc, request, 0)[:10]
    gather(project, target, tools, items, render, out_dir / "raw", stem)
    results = []
    for n, it in enumerate(items, 1):
        sw, sh = it.get("shape") or (doc["settings"]["width"], doc["settings"]["height"])
        z = it.get("zoom") or zoom
        if z:
            size = sl.frame_size(int(sw * z[2]), int(sh * z[3]), grid=a.grid, upscale=True)
        else:
            size = sl.frame_size(int(sw), int(sh), grid=a.grid)
        boxes = review.overlay_boxes(doc, it.get("sourceId"), it.get("sourceMs"), it.get("timelineMs"), want) if target.is_edit else []
        out = out_dir / f"{stem}-{n:02d}{'-grid' if a.grid else ''}.png"
        review.finish(tools.ffmpeg, Path(it["png"]), out, crop=it.get("crop"), size=size, zoom=z, grid=a.grid, boxes=boxes)
        results.append({"path": str(out), "label": it["label"], "timelineMs": it.get("timelineMs"), "sourceId": it.get("sourceId"),
                        "sourceMs": it.get("sourceMs"), "clip": it.get("clip"), "speed": it.get("speed"),
                        "how": "draft render" if it.get("crop") is not None or (render and it["mode"] == "output") else "source frame",
                        "overlays": [b["id"] for b in boxes]})
    if wants_json(ctx):
        emit_json({"name": target.name, "frames": results})
        return EXIT_OK
    for r in results:
        bits = [r["label"]]
        if r.get("clip"):
            bits.append(f"clip {r['clip']} at {r['speed']:g}x")
        if r.get("sourceMs") is not None and not r["label"].startswith("source"):
            bits.append(f"source {r['sourceId']}@{r['sourceMs'] / 1000:.3f}s")
        bits.append(r["how"])
        if r["overlays"]:
            bits.append(f"outlined: {', '.join(r['overlays'])}")
        emit(f"{r['path']}\n    {'; '.join(bits)}")
    emit("next: Read " + (results[0]["path"] if len(results) == 1 else "each path") + (" (grid lines every tenth, yellow halves, red origin top left)" if a.grid else ""))
    return EXIT_OK


def sheet_items(target: Target, mode: str, a: Any) -> List[Dict[str, Any]]:
    doc = target.doc
    fps = cl.doc_fps(doc)
    images = cl.image_ids(doc)
    clips = cl.relayout(doc["clips"], images)
    total = cl.total_ms(clips, images)
    frames = cl.total_frames(clips, fps, images)
    grid = cl.frame_grid(clips, fps, images)
    items: List[Dict[str, Any]] = []

    def out(k: int, label: str, **extra: Any) -> Dict[str, Any]:
        if target.is_edit:
            return dict({"mode": "output", "k": max(0, min(frames - 1, k)), "label": label}, **extra)
        return dict({"mode": "source", "sourceId": "s1", "slot": k, "label": label, "cls": "raw"}, **extra)

    if mode in ("seams", "changes"):
        if not target.is_edit:
            raise KbError(f"--{mode} needs an edit", 2)
        marks = [(i, "seam") for _t, i in cl.seams(clips)]
        if mode == "changes":
            for i in range(1, len(clips)):
                if (i, "seam") not in marks and cl.speed_class(clips[i], images) != cl.speed_class(clips[i - 1], images) or \
                        (i, "seam") not in marks and abs(cl.eff_speed(clips[i].get("speed")) - cl.eff_speed(clips[i - 1].get("speed"))) > 1e-9:
                    marks.append((i, "speed"))
        for i, why in sorted(marks):
            start = grid[i][0]
            items.append(out(start - 1, f"before {why} {clips[i - 1]['id']}|{clips[i]['id']}", pair=len(items) // 2))
            items.append(out(start, f"after {why} {clips[i - 1]['id']}|{clips[i]['id']}", seam=why == "seam", pair=len(items) // 2))
        if not items:
            raise KbError(f"{target.name} has no seams (one continuous clip)")
        return items
    if mode == "compare":
        if not target.is_edit:
            raise KbError("--compare needs an edit", 2)
        n = a.count or DEFAULT_COMPARE_COUNT
        for j in range(n):
            k = int((j + 0.5) * frames / n)
            p = review.predict(doc, [k])[0]
            if p.get("slot") is not None:
                items.append({"mode": "source", "sourceId": p["sourceId"], "slot": p["slot"], "label": f"raw for {k * 1000 / fps / 1000:.2f}s", "cls": "raw"})
            items.append(out(k, f"edit {k * 1000 / fps / 1000:.2f}s"))
        return items
    if mode == "at":
        for spec in plist(a.at):
            t = ptime(spec, fps=fps, total_ms=total)
            items.append(out(int(t * fps / 1000 + 1e-9) if target.is_edit else review.slot_of(t, fps), f"{t / 1000:.2f}s"))
        return items
    if mode == "every":
        step = ptime(a.every, fps=fps, total_ms=total)
        if step <= 0:
            raise KbError("--every needs a positive time", 2)
        t = 0.0
        while t < total and len(items) < sl.MAX_CELLS:
            items.append(out(int(t * fps / 1000 + 1e-9) if target.is_edit else review.slot_of(t, fps), f"{t / 1000:.2f}s"))
            t += step
        return items
    n = min(sl.MAX_CELLS, a.count or DEFAULT_SHEET_COUNT)
    for j in range(n):
        t = (j + 0.5) * total / n
        items.append(out(int(t * fps / 1000 + 1e-9) if target.is_edit else review.slot_of(t, fps), f"{t / 1000:.2f}s"))
    return items


class _Args:
    def __init__(self, **kw: Any) -> None:
        self.__dict__.update(kw)


def build_sheet(project: Project, target: Target, tools: passes.Tools, *, mode: str, render: bool, grid: bool, args: Any = None,
                cols: Optional[int] = None, tag: str = "sheet") -> Dict[str, Any]:
    a = args or _Args(count=None, at=None, every=None)
    items = sheet_items(target, mode, a)
    if len(items) > sl.MAX_CELLS:
        items = items[:sl.MAX_CELLS]
    doc = target.doc
    key = review.doc_key(doc, [mode, str(render), str(grid)], 0)[:10]
    out_dir = vdir(project) / "sheets" / safe_name(target.name)
    gather(project, target, tools, items, render, out_dir / "raw", f"{tag}-{key}")
    for it in items:
        it["grid"] = grid
        if it.get("crop") is None and it.get("shape") is None:
            it["shape"] = (doc["settings"]["width"], doc["settings"]["height"])
    st = doc.get("settings") or {}
    aspect = (st.get("width") or 16) / float(st.get("height") or 9)
    if not target.is_edit:
        src = source_of(doc, "s1")
        aspect = src.get("width", 16) / float(src.get("height", 9))
    diffs: Dict[int, float] = {}
    if mode == "seams":
        for i in range(0, len(items) - 1, 2):
            try:
                diffs[i + 1] = review.seam_diff(tools.ffmpeg, Path(items[i]["png"]), Path(items[i + 1]["png"]))
            except KbError:
                pass
    sheets = sl.plan_sheets(len(items), aspect, cols, pairs=mode in ("seams", "changes", "compare"))
    paths: List[str] = []
    legend: List[Dict[str, Any]] = []
    cursor = 0
    for lay in sheets:
        chunk = items[cursor:cursor + lay["cells"]]
        suffix = f"-{lay['index']}" if len(sheets) > 1 else ""
        path = out_dir / f"{tag}-{mode}-{key}{suffix}.png"
        review.compose_sheet(tools.ffmpeg, chunk, path, lay)
        paths.append(str(path))
        for j, it in enumerate(chunk):
            n = cursor + j
            note = []
            if it.get("seam"):
                note.append("first frame after a seam (red edge)")
            if n in diffs:
                d = diffs[n]
                note.append(f"seam diff {d:.3f}% ({'seamless' if d < review.SEAMLESS_PCT else 'visible jump'})")
            legend.append({"sheet": lay["index"], "cell": j + 1, "row": j // lay["cols"] + 1, "col": j % lay["cols"] + 1,
                           "label": it["label"], "timelineMs": it.get("timelineMs"), "sourceId": it.get("sourceId"),
                           "sourceMs": it.get("sourceMs"), "clip": it.get("clip"), "speed": it.get("speed"),
                           "bar": it.get("cls") or "raw", "notes": note})
        cursor += lay["cells"]
    meta = {"name": target.name, "mode": mode, "render": render, "paths": paths, "cells": legend,
            "bars": {"1x": "light grey", "faster": "orange", "slower": "blue", "hold": "purple (freeze or still)", "raw": "grey (raw source)"}}
    atomic_write_json(Path(paths[0]).with_suffix(".json"), meta)
    meta["json"] = str(Path(paths[0]).with_suffix(".json"))
    return meta


def cmd_sheet(ctx: Any) -> int:
    a = ctx.args
    project = project_of(ctx)
    tools = passes.find_tools()
    target = resolve_target(project, a.target, tools)
    mode = "seams" if a.seams else "compare" if a.compare else "changes" if a.changes else "at" if a.at else "every" if a.every else "count"
    render = target.is_edit and not a.predict
    meta = build_sheet(project, target, tools, mode=mode, render=render, grid=a.grid, args=a, cols=a.cols)
    if wants_json(ctx):
        emit_json(meta)
        return EXIT_OK
    for p in meta["paths"]:
        emit(p)
    for c in meta["cells"]:
        where = f"timeline {fmt(c['timelineMs'])}" if c.get("timelineMs") is not None else ""
        src = f"source {c['sourceId']}@{c['sourceMs'] / 1000:.3f}s" if c.get("sourceMs") is not None else ""
        clip = f"{c['clip']} {c['speed']:g}x" if c.get("clip") else ""
        sheet = f"{c['sheet']}:" if len(meta["paths"]) > 1 else ""
        emit(f"  {sheet}{c['cell']:>2} r{c['row']}c{c['col']}  {c['label']:<28} {where:<18} {src:<22} {clip:<10} {'; '.join(c['notes'])}")
    emit(f"bars: 1x light grey, faster orange, slower blue, hold purple, raw source grey; legend in {meta['json']}")
    emit(f"next: Read {meta['paths'][0]}" + (" and the other sheets" if len(meta["paths"]) > 1 else ""))
    return EXIT_OK


# ── registration ─────────────────────────────────────────────────────────────


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    def add(name: str, help_: str, epilog: Optional[str] = None, aliases: Sequence[str] = ()) -> argparse.ArgumentParser:
        return sub.add_parser(name, help=help_, description=help_, epilog=epilog, formatter_class=Formatter, parents=[common], aliases=list(aliases))

    s = add("analyse", "find dead time in a recording: black, lead-in/out, static, blink, loading, typing, screen changes, tap candidates",
            epilog="  kb video analyse assets/sim.mov            a source\n  kb video analyse sim                       an edit (also maps intervals onto its timeline)\n"
                   "  kb video analyse sim --range 10-20 --profile screen\nCached by content, so a rerun is instant.", aliases=["analyze"])
    s.add_argument("target", metavar="NAME|SRC")
    s.add_argument("--range", metavar="A-B", help="only report this range (timeline for an edit, source for a file)")
    s.add_argument("--profile", choices=["auto", "screen", "camera"], default="auto", help="screen recordings vs camera footage (auto decides)")
    s.add_argument("--refresh", action="store_true", help="ignore the cached analysis")
    s.set_defaults(fn=cmd_analyse)

    s = add("cleanup", "remove dead time (static stretches, cursor blinks, black, long heads and tails) and speed up loading",
            epilog="Default strength is normal. --gentle keeps more reading time (tutorials, \"keep it natural\"); --aggressive keeps least.\n"
                   "Never touches active stretches, screen changes, taps, likely taps or --keep ranges; never reorders; only 1x clips.\n"
                   "  kb video cleanup sim --dry-run      plan, changes sheet, nothing written\n"
                   "  kb video cleanup sim --gentle --keep 4-9 --skip i7\n"
                   "  kb video cleanup sim --emit-plan    JSON ops for kb video apply")
    s.add_argument("target", metavar="NAME|SRC")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--gentle", action="store_true")
    g.add_argument("--aggressive", action="store_true")
    s.add_argument("--keep", action="append", metavar="A-B", help="never cut this timeline range (repeatable)")
    s.add_argument("--skip", action="append", metavar="iN", help="leave this analysis interval alone (repeatable; s2:i4 for another source)")
    s.add_argument("--cuts-only", action="store_true", help="interior cuts only: keep the head and tail, no speed changes")
    s.add_argument("--no-speed", action="store_true", help="never speed up loading")
    s.add_argument("--dry-run", action="store_true", help="report and draw the changes sheet; write nothing")
    s.add_argument("--emit-plan", action="store_true", help="print the plan JSON instead of applying it")
    s.set_defaults(fn=cmd_cleanup)

    s = add("fit", "fit an edit to an exact length (lands the render on the exact frame count)",
            epilog="  kb video fit sim --to 8                       8 s: cleanup, then a speed ramp (idle fastest), then exact\n"
                   "  kb video fit sim --scene 3 --slot device     to the video's time in scene 3 (until its outgoing transition)\n"
                   "  kb video fit sim --to 8 --anchor s1@12.4@5   and land source 12.4 s at 5 s\n"
                   "  kb video fit sim --to 12 --strategy hold     lengthen with holds only")
    s.add_argument("target", metavar="NAME")
    s.add_argument("--to", metavar="T", help="target length (seconds, 8000ms, f480)")
    s.add_argument("--scene", metavar="S", help="fit to this scene's slot")
    s.add_argument("--slot", metavar="P", help="background, media[:ID], window, device[:ID], ... (auto when only one shows it)")
    s.add_argument("--end", choices=["before-transition", "scene-end"], default="before-transition", help="where the video should end in the scene")
    s.add_argument("--anchor", action="append", metavar="SRC@TGT", help="land source moment SRC ([SID@]T or a tap id) at timeline TGT (repeatable)")
    s.add_argument("--strategy", choices=["auto", "trim", "speed", "hold"], default="auto")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(fn=cmd_fit)

    s = add("align", "land one moment of the recording on a time, beat or key moment",
            epilog="  kb video align sim --tap t2 --beat 4 --scene 3      tap t2 on scene 3's 4th beat (83 ms early, so it reads on the beat)\n"
                   "  kb video align sim --src 12.4 --at 5                source 12.4 s at timeline 5 s\n"
                   "  kb video align sim --tap t1 --scene-at 2.5 --scene 3 --keep-length\n"
                   "The scene side (shifting the video's startMs 0-1500 ms, no re-render) is tried first unless --prefer edit.")
    s.add_argument("target", metavar="NAME")
    s.add_argument("--src", metavar="[SID@]T", help="the source moment")
    s.add_argument("--tap", metavar="ID", help="a tap's moment (lead 83 ms)")
    s.add_argument("--at", metavar="T", help="target on the edit's timeline")
    s.add_argument("--beat", type=int, metavar="N", help="target: the scene's Nth grid beat (1-based, kb beats)")
    s.add_argument("--moment", type=int, metavar="N", help="target: the scene's Nth key moment (1-based)")
    s.add_argument("--scene-at", metavar="T", help="target: scene-local time")
    s.add_argument("--scene", metavar="S")
    s.add_argument("--slot", metavar="P")
    s.add_argument("--lead", metavar="T", help="land this much early (default 83 ms for taps, 0 for --src)")
    s.add_argument("--keep-length", action="store_true", help="also refit what follows so the total length stays")
    s.add_argument("--prefer", choices=["auto", "scene", "edit"], default="auto")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(fn=cmd_align)

    s = add("frames", "PNG frames to Read: the draft render of an edit (default), predicted source frames, or raw source frames",
            epilog="  kb video frames sim --at 1,2.5,end-0.1 --grid\n  kb video frames sim --src s1@24.967 --grid      raw source frame (check a tap spot)\n"
                   "  kb video frames sim --tap t1                     -100, 0, +83, +275, +550 ms around it\n"
                   "  kb video frames sim --mask m1                    span start, each key, both ends, plus a zoom\n"
                   "  kb video frames assets/sim.mov --at 3 --zoom 0.1,0.6,0.5,0.2")
    s.add_argument("target", metavar="NAME|SRC")
    s.add_argument("--at", metavar="LIST", help="timeline times (source times for a file)")
    s.add_argument("--src", metavar="LIST", help="source times, [SID@]T,...")
    s.add_argument("--tap", metavar="ID")
    s.add_argument("--mask", metavar="ID")
    m = s.add_mutually_exclusive_group()
    m.add_argument("--render", action="store_true", help="draft render (default for edits; always for masks)")
    m.add_argument("--predict", action="store_true", help="map to source frames without rendering (fast; no taps or masks drawn)")
    s.add_argument("--grid", action="store_true", help="tenths grid, yellow halves, red origin")
    s.add_argument("--zoom", metavar="x,y,w,h", help="crop (fractions of the frame) and enlarge")
    s.add_argument("--overlay", metavar="taps,masks", help="outline taps (green) and masks (white solid, cyan blur, magenta pixelate)")
    s.set_defaults(fn=cmd_frames)

    s = add("sheet", "one contact sheet (or a few) to Read: evenly spaced, at times, every T, seams, raw-vs-edit or the changes",
            epilog="Bars on each cell: 1x light grey, faster orange, slower blue, hold purple, raw source grey; a red left edge marks the\n"
                   "first frame after a seam. The legend prints here and in sheet.json.\n"
                   "  kb video sheet sim                  12 frames\n  kb video sheet sim --seams          each cut, with a numeric seam diff\n"
                   "  kb video sheet sim --compare        raw source beside the edit\n  kb video sheet assets/sim.mov --every 2")
    s.add_argument("target", metavar="NAME|SRC")
    s.add_argument("--count", type=int, metavar="N", help="cells spread over the edit (default 12; with --compare, pairs)")
    m = s.add_mutually_exclusive_group()
    m.add_argument("--every", metavar="T")
    m.add_argument("--at", metavar="LIST")
    m.add_argument("--seams", action="store_true")
    m.add_argument("--compare", action="store_true")
    m.add_argument("--changes", action="store_true")
    s.add_argument("--cols", type=int, metavar="C")
    s.add_argument("--grid", action="store_true")
    r = s.add_mutually_exclusive_group()
    r.add_argument("--render", action="store_true")
    r.add_argument("--predict", action="store_true")
    s.set_defaults(fn=cmd_sheet)

    s = add("taps", "tap highlight suggestions from the analysis (never added automatically)")
    tsub = s.add_subparsers(dest="taps_op", metavar="OP")
    tsub.required = True
    x = tsub.add_parser("suggest", help="list likely taps with the commands to check and add each", parents=[common], formatter_class=Formatter)
    x.add_argument("target", metavar="NAME|SRC")
    x.add_argument("--min-confidence", type=float, default=0.0)
    x.set_defaults(fn=cmd_taps)


def standalone_parser() -> argparse.ArgumentParser:
    """A parser with only these commands (tests, and kits without kb's video engine)."""
    from ..cli import Formatter

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
    common.add_argument("-C", "--project-dir", default=argparse.SUPPRESS, metavar="DIR")
    p = argparse.ArgumentParser(prog="kb video", parents=[common], formatter_class=Formatter)
    sub = p.add_subparsers(dest="video_command", metavar="COMMAND")
    sub.required = True
    register(sub, common, Formatter)
    return p


class _Ctx:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.json = bool(getattr(args, "json", False))

    @property
    def project(self) -> Project:
        return Project(find_root(explicit=getattr(self.args, "project_dir", None)))


def run_standalone(argv: Sequence[str], out: Optional[Callable[[str], None]] = None) -> int:
    args = standalone_parser().parse_args(list(argv))
    try:
        return int(args.fn(_Ctx(args)) or 0)
    except KbError as e:
        emit_err(f"kb: {e.message}")
        return e.code
