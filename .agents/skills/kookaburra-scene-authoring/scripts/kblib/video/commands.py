"""kb video: argparse wiring and one handler per command. Heavy modules load inside the handlers so kb stays quick."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

EXTENSIONS: List[Callable[..., None]] = []
EXTENSION_ERRORS: List[str] = []
_extensions_loaded = False


def load_extensions() -> List[Callable[..., None]]:
    """Each extension's register(video_subparsers, common, Formatter); smart_commands when it ships (loaded only for kb video)."""
    global _extensions_loaded
    if not _extensions_loaded:
        _extensions_loaded = True
        try:
            from . import smart_commands

            EXTENSIONS.append(smart_commands.register)
        except ImportError as e:
            if getattr(e, "name", None) != f"{__package__}.smart_commands":
                EXTENSION_ERRORS.append(f"smart_commands: {e}")
    return EXTENSIONS

EXIT_OK, EXIT_PROBLEMS, EXIT_ENV = 0, 1, 2

VIDEO_HELP = """\
kb video: edit screen recordings with the app's own video editor, from the terminal.
The edit lives in edits/NAME.json (the same document the editor opens); kb video render
writes assets/NAME-edited.mp4 and can point a scene at it.

  Inspect   list | show NAME [--at T] | map NAME (--at T|--src S|--tap ID|--scene-at T)
            usages [NAME|ASSET] | validate NAME | caps
  Create    new SRC [--name N] [--for SCENE[:SLOT]] [--fresh] | reset NAME --yes
  Clips     split NAME --at T... | cut NAME A-B... [--src] | keep NAME [SID:]A-B[@Nx]...
            trim NAME CLIP [--in T] [--out T] [--head D] [--tail D] | speed NAME CLIP X
            freeze NAME (--at T|--src S) [--hold D] | hold NAME CLIP D | remove NAME CLIP...
            move NAME CLIP (--to N|--before C|--after C) | insert NAME MEDIA [--at T|--index N]
            append NAME MEDIA [--hold D]
  Taps      tap add|move|retime|remove|style|list NAME ...
  Masks     mask add|key|hold|unkey|offset|set|span|remove|list NAME ...
            [--fade-in D] [--fade-out D] [--until-scene T --scene S [--slot P]]
  Framing   crop NAME CLIP (--rect x,y,w,h | --aspect 9:16 [--centre x,y] | --clear)
            zoom NAME CLIP (--at T [--rect x,y,w,h] [--ease linear|smooth] | --remove T
                 | --move T --to T2 | --clear)
  Batch     apply NAME PLAN|@file|-
  Smart     analyse SRC|NAME | cleanup NAME|SRC [--gentle|--aggressive] | taps suggest NAME
            fit NAME (--to T|--scene S [--slot P]) | align NAME (--src T|--tap ID) (--at T|--beat N)
  Review    frames NAME|SRC (--at L|--src L|--tap ID|--mask ID) [--grid] [--zoom x,y,w,h]
            sheet NAME|SRC [--count N|--every T|--seams|--compare|--changes] [--grid]
  Output    render NAME [--use [--scene S] [--slot P]] [--draft] | use NAME --scene S [--slot P]
            durations [--write] | open NAME [--scene S]

Times: bare numbers are seconds (2.5), or 2500ms, 2.5s, 1:02.5, f150 (output frame), end,
end-2s. --at is timeline time (the edited video); --src [SID@]T is source time.
Clips: c3 (id), 2 (0-based index), @4.5 (the clip at a time), first, last. Taps t1, masks m1.
Slots: background, media[:ID], window, device[:ID], device-cover[:ID], compare-device[:ID],
compare-device-cover[:ID] (picked for you when one slot shows the edit's source or output).
Mutations take --dry-run (print the result, write nothing) and --base HASH (refuse if the
doc changed). Exit 0 ok, 1 problem, 2 environment (no app CLI, app closed, worktree, busy).
"""


# ── shared plumbing ───────────────────────────────────────────────────────────


def _mods() -> Any:
    from . import appcli, cache, editdoc, editmath, plan, repoint

    class M:
        pass

    m = M()
    m.appcli, m.cache, m.editdoc, m.em, m.plan, m.repoint = appcli, cache, editdoc, editmath, plan, repoint
    return m


def _emit(text: str) -> None:
    sys.stdout.write(text if text.endswith("\n") else text + "\n")


def _err(text: str) -> None:
    sys.stderr.write(text if text.endswith("\n") else text + "\n")


def _json(value: Dict[str, Any]) -> None:
    """The --json envelope ({ ok, command, ...value }); a value's own boolean "ok" (validate's verdict) is kept."""
    from ..util import emit_ok

    emit_ok(value)


def _kb_error(message: str, code: int = EXIT_PROBLEMS) -> Exception:
    from ..util import KbError

    return KbError(message, code)


def start(ctx: Any) -> Any:
    """Every kb video command: find the project and prune the scratch folder."""
    project = ctx.project
    from . import cache

    try:
        cache.prune(project)
    except Exception:
        pass
    return project


def guard_worktree(project: Any) -> None:
    from .. import overview

    found = overview.session_worktree(project)
    if found:
        raise _kb_error(" ".join(overview.worktree_banner(found)), EXIT_ENV)


def checkpoint_before(project: Any, what: str) -> Optional[str]:
    """The checkpoint destructive video ops (cut, keep, apply, cleanup, fit, align ...) take first."""
    from .. import git as gitmod

    return gitmod.checkpoint_before(project, what)


def fmt_s(ms: Any) -> str:
    if ms is None:
        return "?"
    return f"{ms / 1000:.3f}s"


def _speed(v: Any) -> str:
    return f"{v:g}x" if isinstance(v, (int, float)) else "?"


def _caps_or_none() -> Optional[Dict[str, Any]]:
    from . import appcli
    from ..util import KbError

    try:
        return appcli.caps()
    except KbError:
        return None


def resolve_media_arg(project: Any, value: str) -> Tuple[str, Optional[str]]:
    """An asset path, or an outside file copied in with kb assets add; returns (rel, note)."""
    from .. import assets as assetmod
    from ..util import exact_case_exists

    text = value.strip()
    path = Path(text).expanduser()
    root = project.root.resolve()
    if text.startswith("assets/"):
        problem = exact_case_exists(project.root, text)
        if problem:
            raise _kb_error(f"{text}: {'does not exist; see kb assets list' if problem == 'missing' else problem}")
        return text, None
    if path.is_absolute() or path.exists():
        resolved = path.resolve()
        try:
            rel = resolved.relative_to(root).as_posix()
            if rel.startswith("assets/"):
                return rel, None
        except ValueError:
            pass
        if not resolved.is_file():
            raise _kb_error(f"{value} is not a file")
        res = assetmod.add(project, str(resolved), None, None)
        note = res.get("note") or f"copied {resolved.name} into {res['path']}"
        return res["path"], note
    raise _kb_error(f"{value} is neither an assets/ path nor a file; copy media in with kb assets add <file>")


# ── describing a timeline ─────────────────────────────────────────────────────


def timeline_data(doc: Dict[str, Any]) -> Dict[str, Any]:
    from . import editmath as em

    clips = em.relayout(doc.get("clips") or [])
    fps = em.output_fps(doc)
    frames = dict(zip([c["id"] for c in sorted(clips, key=lambda c: c["startMs"])], em.clip_frames(clips, fps)))
    sources = {s["id"]: s for s in doc.get("sources") or []}
    out_clips = []
    for i, c in enumerate(clips):
        start_frame, n = frames.get(c["id"], (0, 0))
        row = {
            "index": i, "id": c["id"], "sourceId": c["sourceId"], "inMs": c["inMs"], "outMs": c["outMs"], "speed": c.get("speed"),
            "startMs": c["startMs"], "endMs": c["startMs"] + em.clip_timeline_ms(c), "startFrame": start_frame, "frames": n,
            "image": (sources.get(c["sourceId"]) or {}).get("kind") == "image",
        }
        if "holdMs" in c:
            row["holdMs"] = c["holdMs"]
        for framing in ("crop", "zoom"):
            if c.get(framing) is not None:
                row[framing] = c[framing]
        out_clips.append(row)
    taps = [dict(t, windows=em.tap_windows(clips, t, em.TAP_DURATION_MS)) for t in doc.get("taps") or []]
    masks = []
    for m in doc.get("masks") or []:
        image = (sources.get(m["sourceId"]) or {}).get("kind") == "image"
        masks.append(dict(m, windows=[{"clipId": w["clipId"], "startMs": w["startMs"], "endMs": w["endMs"]} for w in em.mask_windows(clips, m, image)]))
    settings = doc.get("settings") or {}
    return {
        "name": doc.get("name"), "durationMs": em.timeline_duration_ms(clips), "fps": fps, "frames": em.total_frames(clips, fps),
        "width": settings.get("width"), "height": settings.get("height"), "sources": doc.get("sources") or [], "clips": out_clips,
        "taps": taps, "masks": masks, "tapStyle": doc.get("tapStyle"), "tapColor": doc.get("tapColor"), "tapSize": doc.get("tapSize"),
    }


def timeline_lines(doc: Dict[str, Any], state: Optional[str] = None) -> List[str]:
    data = timeline_data(doc)
    head = f"{data['name']}: {fmt_s(data['durationMs'])}, {data['frames']} frames at {data['fps']:g} fps, {data['width']}x{data['height']}"
    if state:
        head += f", render {state}"
    lines = [head, "   #  clip   source  in        out       speed   timeline             frames"]
    for c in data["clips"]:
        if "holdMs" in c:
            span = f"{'still' if c['image'] else 'freeze':<9} {fmt_s(c['inMs']):<9} {'hold':<7}"
            if not c["image"]:
                span = f"{fmt_s(c['inMs']):<9} {'(frame)':<9} {'hold':<7}"
        else:
            span = f"{fmt_s(c['inMs']):<9} {fmt_s(c['outMs']):<9} {_speed(c['speed']):<7}"
        lines.append(f"  {c['index']:>2}  {c['id']:<6} {c['sourceId']:<7} {span} {fmt_s(c['startMs'])}-{fmt_s(c['endMs']):<10} {c['startFrame']}+{c['frames']}")
        if c.get("crop"):
            lines.append(f"        crop {_box(c['crop'])}")
        for k in (c.get("zoom") or {}).get("keys") or []:
            lines.append(f"        zoom key at {fmt_s(c['startMs'] + k['tMs'])} {_box(k['rect'])}" + (", glides smoothly" if k.get("ease") == "smooth" else ""))
    for s in data["sources"]:
        lines.append(f"  source {s['id']} {s.get('rel')} ({s.get('kind', 'video')} {s.get('width')}x{s.get('height')}, {s.get('fps', 0):g} fps, {fmt_s(s.get('durationMs'))})")
    for t in data["taps"]:
        where = ", ".join(f"{fmt_s(w['startMs'])}-{fmt_s(w['endMs'])}" for w in t["windows"]) or "never on screen"
        lines.append(f"  tap {t['id']} {t['sourceId']}@{fmt_s(t['sourceMs'])} at ({t['pos'][0]:.3f}, {t['pos'][1]:.3f}) -> {where}")
    for m in data["masks"]:
        where = ", ".join(f"{fmt_s(w['startMs'])}-{fmt_s(w['endMs'])}" for w in m["windows"]) or "never on screen"
        look = m.get("style", "solid") + (f" {m['strength']:g}" if "strength" in m else "") + (f" {m['color']}" if "color" in m else "")
        fades = "".join(f", fades {edge} {fmt_s(m[key])}" for edge, key in (("in", "fadeInMs"), ("out", "fadeOutMs")) if m.get(key))
        lines.append(f"  mask {m['id']} {look} {m['sourceId']} {fmt_s(m['startMs'])}-{fmt_s(m['endMs'])}{fades}, {len(m['keys'])} key(s) -> {where}")
    if data["taps"] and (data.get("tapStyle") or data.get("tapColor") or data.get("tapSize")):
        lines.append(f"  tap look: style {data.get('tapStyle') or 'default'}, colour {data.get('tapColor') or 'default'}, size {data.get('tapSize') or 'default'}")
    return lines


def _box(r: List[float]) -> str:
    return f"x {r[0]:.3f} y {r[1]:.3f} w {r[2]:.3f} h {r[3]:.3f}"


def _issue_lines(issues: List[Dict[str, Any]]) -> List[str]:
    return [f"  {'error' if i['severity'] == 'error' else 'warn '}  {i['message']}" for i in issues]


# ── mutations ─────────────────────────────────────────────────────────────────


def _report_line(r: Dict[str, Any]) -> str:
    bits = [r.get("label") or r.get("op")]
    if r.get("detail"):
        bits.append(r["detail"])
    if r.get("created"):
        bits.append(f"-> {r['created']}")
    line = " ".join(str(b) for b in bits)
    for n in r.get("notes") or []:
        line += f"\n    {n}"
    if r.get("pruned"):
        line += f"\n    removed mask(s) {', '.join(r['pruned'])}: no clip shows them any more"
    return line


def run_mutation(ctx: Any, name: str, build: Callable[[Dict[str, Any]], List[Dict[str, Any]]], label: str, *, checkpoint: bool = False, base: Optional[str] = None) -> int:
    """Compile ops against the doc as read (again on a rebase), run them as one plan, save through the app's CLI."""
    m = _mods()
    project = start(ctx)
    a = ctx.args
    m.editdoc.check_name(name)
    guard_worktree(project)
    dry = bool(getattr(a, "dry_run", False))
    caps = _caps_or_none()
    if caps is None and not dry:
        m.appcli.caps()
    saved_rev = None
    if checkpoint and not dry:
        saved_rev = checkpoint_before(project, f"kb video {label} {name}")
    holder: Dict[str, Any] = {}

    def fn(doc: Dict[str, Any]) -> Dict[str, Any]:
        ops = build(doc)
        new, reports = m.plan.run_plan(doc, ops, probe=lambda rel: m.appcli.source_meta(project, rel))
        holder["reports"] = reports
        return new

    mut = m.editdoc.mutate(project, name, fn, base=base if base is not None else getattr(a, "base", None), label=f"kb video {label}", wait=getattr(a, "wait", None), dry_run=dry, caps=caps)
    reports = holder.get("reports") or []
    warnings = [i for i in mut.issues if i["severity"] == "warning"]
    if ctx.json:
        out = {"name": name, "dryRun": dry, "changes": reports, "warnings": warnings, "timeline": timeline_data(mut.doc), "checkpoint": saved_rev}
        out.update(mut.as_dict())
        _json(out)
        return EXIT_OK
    for r in reports:
        _emit(_report_line(r))
    if mut.pruned:
        _emit(f"removed mask(s) {', '.join(mut.pruned)}: no clip shows them any more")
    for line in timeline_lines(mut.doc, None if dry else m.editdoc.render_state(project, name)):
        _emit(line)
    for line in _issue_lines(warnings):
        _emit(line)
    if dry:
        _emit("dry run: nothing written")
    elif not mut.saved:
        _emit(f"edits/{name}.json unchanged")
    else:
        note = "; rebased on a newer save (someone else changed it meanwhile)" if mut.rebased else ""
        _emit(f"saved edits/{name}.json (hash {mut.after_sha[:12]}){note}")
    if saved_rev:
        _emit(f"checkpoint {saved_rev} holds the state before this (kb undo {saved_rev})")
    _emit(f"next: kb video render {name}")
    return EXIT_OK


def _times(doc: Dict[str, Any], texts: List[str], what: str = "--at") -> List[float]:
    m = _mods()
    return [m.plan.parse_time(t, fps=m.em.output_fps(doc), total_ms=m.plan.total_ms(doc), what=what) for t in texts]


def _at_or_src(doc: Dict[str, Any], a: Any, required: bool = True) -> Optional[float]:
    """--at T (timeline) or --src [SID@]T mapped to where that source moment first plays."""
    m = _mods()
    if getattr(a, "at", None) is not None:
        return _times(doc, [a.at])[0]
    if getattr(a, "src", None) is not None:
        sid, ms = m.plan.parse_src(doc, a.src)
        t = m.plan.first_occurrence(doc, sid, ms)
        if t is None:
            raise _kb_error(f"source moment {sid}@{fmt_s(ms)} is not on the timeline (it was cut, or only a freeze shows it)")
        return t
    if required:
        raise _kb_error("pass --at T (timeline time) or --src [SID@]T (source time)", EXIT_ENV)
    return None


def _source_at(doc: Dict[str, Any], t: float) -> Dict[str, Any]:
    m = _mods()
    moment = m.em.source_moment_at(m.em.relayout(doc["clips"]), t)
    if moment is None:
        raise _kb_error(f"nothing is on screen at {fmt_s(t)}")
    return next(s for s in doc["sources"] if s["id"] == moment["sourceId"])


def _pos(doc: Dict[str, Any], a: Any, t: Optional[float]) -> List[float]:
    m = _mods()
    if getattr(a, "pos", None) is not None:
        pos = m.plan.parse_pair(a.pos, "--pos")
    elif getattr(a, "px", None) is not None:
        x, y = m.plan.parse_pair(a.px, "--px")
        source = _source_at(doc, t if t is not None else 0)
        if not source.get("width") or not source.get("height"):
            raise _kb_error("--px needs the source's size; use --pos X,Y (0..1)")
        pos = [x / source["width"], y / source["height"]]
    else:
        raise _kb_error("pass --pos X,Y (0..1 across the source frame) or --px X,Y (source pixels)", EXIT_ENV)
    if not all(0 <= v <= 1 for v in pos):
        raise _kb_error(f"position {pos[0]:g},{pos[1]:g} is outside the frame (0..1)", EXIT_ENV)
    return pos


def _rect(doc: Dict[str, Any], a: Any, t: float) -> List[float]:
    m = _mods()
    source = _source_at(doc, t)
    if getattr(a, "rect", None) is not None:
        return m.em.clamp_rect(m.plan.parse_pair(a.rect, "--rect", 4))
    if getattr(a, "rect_px", None) is not None:
        x, y, w, h = m.plan.parse_pair(a.rect_px, "--rect-px", 4)
        if not source.get("width") or not source.get("height"):
            raise _kb_error("--rect-px needs the source's size; use --rect x,y,w,h (0..1)")
        return m.em.clamp_rect([x / source["width"], y / source["height"], w / source["width"], h / source["height"]])
    if getattr(a, "pos", None) is not None:
        return m.em.default_mask_rect(m.plan.parse_pair(a.pos, "--pos"), source)
    raise _kb_error("pass --rect x,y,w,h (0..1), --rect-px x,y,w,h (source pixels) or --pos x,y (a default box)", EXIT_ENV)


def _hex(value: str) -> str:
    raw = value.strip().lstrip("#").lower()
    if len(raw) == 3 and all(c in "0123456789abcdef" for c in raw):
        return "#" + "".join(c * 2 for c in raw)
    if len(raw) == 6 and all(c in "0123456789abcdef" for c in raw):
        return "#" + raw
    raise _kb_error(f'colour "{value}" is not a hex like #000000', EXIT_ENV)


def _strength(value: str) -> float:
    try:
        s = float(value)
    except ValueError:
        raise _kb_error(f'--strength "{value}" is not a number (0..1)', EXIT_ENV) from None
    if not 0 <= s <= 1:
        raise _kb_error("--strength is 0..1 (0 already hides typical UI text)", EXIT_ENV)
    return s


def _span_ops(doc: Dict[str, Any], mask_ref: str, a: Any, at: Optional[float]) -> List[Dict[str, Any]]:
    """--until T / --span D / --src-start S --src-end S as start, end, start retimes (each clamps against the other)."""
    m = _mods()
    start = end = None
    laid = m.em.relayout(doc["clips"])
    if getattr(a, "src_start", None) is not None:
        start = m.plan.parse_src(doc, a.src_start)[1]
    if getattr(a, "src_end", None) is not None:
        end = m.plan.parse_src(doc, a.src_end)[1]
    if getattr(a, "from_", None) is not None:
        t = _times(doc, [a.from_], "--from")[0]
        i = m.em.clip_index_at(laid, t)
        if i < 0:
            raise _kb_error(f"--from {a.from_} is off the timeline")
        start = m.em.timeline_to_source_unclamped(laid[i], t)
    if getattr(a, "until", None) is not None:
        t = _times(doc, [a.until], "--until")[0]
        i = m.em.clip_index_at(laid, min(t, m.plan.total_ms(doc) - 1e-6))
        if i < 0:
            raise _kb_error(f"--until {a.until} is off the timeline")
        end = m.em.timeline_to_source_unclamped(laid[i], t)
    if getattr(a, "span", None) is not None:
        if at is None:
            raise _kb_error("--span needs the mask's start time (--at)")
        d = m.plan.parse_time(a.span, fps=m.em.output_fps(doc), what="--span")
        moment = m.em.source_moment_at(laid, at)
        speed = 1 if moment["hold"] else m.em.effective_speed(moment["clip"].get("speed"))
        end = moment["sourceMs"] + d * speed
    ops: List[Dict[str, Any]] = []
    if start is not None:
        ops.append({"op": "retimeMaskEdge", "maskId": mask_ref, "edge": "start", "sourceMs": m.em.js_round(start)})
    if end is not None:
        ops.append({"op": "retimeMaskEdge", "maskId": mask_ref, "edge": "end", "sourceMs": m.em.js_round(end)})
    if start is not None and end is not None:
        ops.append({"op": "retimeMaskEdge", "maskId": mask_ref, "edge": "start", "sourceMs": m.em.js_round(start)})
    return ops


def _scene_source_moment(project: Any, name: str, doc: Dict[str, Any], a: Any) -> Tuple[str, int, Dict[str, Any]]:
    """--until-scene T --scene S [--slot P]: the source moment the slot shows at scene time T, through its delay, inMs and speed."""
    m = _mods()
    if getattr(a, "scene", None) is None:
        raise _kb_error("--until-scene needs the scene that plays this edit: --scene S [--slot P]", EXIT_ENV)
    output = m.editdoc.output_rel(name)
    slot = a.slot
    if slot is None:
        base, target = m.repoint.pick_slot(project, a.scene, [output] + [s["rel"] for s in doc["sources"]])
        slot = m.repoint.slot_ref(base, target)
    info = m.repoint.slot_info(project, a.scene, slot)
    scene_ms = m.plan.parse_time(a.until_scene, total_ms=info.get("sceneDurationMs"), what="--until-scene")
    media_ms = m.repoint.slot_media_ms(info, scene_ms)
    if info["src"] == output:
        laid = m.em.relayout(doc["clips"])
        total = m.plan.total_ms(doc)
        i = m.em.clip_index_at(laid, min(media_ms, total - 1e-6))
        if i < 0 or media_ms > total:
            raise _kb_error(f"scene time {a.until_scene} reaches {fmt_s(media_ms)} into the render, past the edit's {fmt_s(total)}")
        return laid[i]["sourceId"], m.em.js_round(m.em.timeline_to_source_unclamped(laid[i], media_ms)), info
    source = next((s for s in doc["sources"] if s["rel"] == info["src"]), None)
    if source is None:
        raise _kb_error(f"{info['ref']} in scene {info['scene']} plays {info['src']}, which is neither this edit's render nor one of its sources", EXIT_ENV)
    return source["id"], m.em.js_round(media_ms), info


def _until_scene_op(project: Any, name: str, doc: Dict[str, Any], a: Any, mask_ref: str, source_id: str) -> Dict[str, Any]:
    sid, source_ms, info = _scene_source_moment(project, name, doc, a)
    if sid != source_id:
        raise _kb_error(f"at scene time {a.until_scene}, {info['ref']} shows source {sid}, not the mask's {source_id}")
    return {"op": "retimeMaskEdge", "maskId": mask_ref, "edge": "end", "sourceMs": source_ms}


def _fade_ms(doc: Dict[str, Any], text: Optional[str], what: str) -> Optional[int]:
    if text is None:
        return None
    if text.strip().lower() in ("none", "off"):
        return 0
    m = _mods()
    ms = m.plan.parse_time(text, fps=m.em.output_fps(doc), what=what)
    if ms < 0:
        raise _kb_error(f"{what} is a length of source time, 0 or more", EXIT_ENV)
    return m.em.js_round(ms)


def _fade_op(doc: Dict[str, Any], a: Any, mask_ref: str) -> Optional[Dict[str, Any]]:
    fade_in, fade_out = _fade_ms(doc, getattr(a, "fade_in", None), "--fade-in"), _fade_ms(doc, getattr(a, "fade_out", None), "--fade-out")
    if fade_in is None and fade_out is None:
        return None
    op: Dict[str, Any] = {"op": "setMaskFade", "maskId": mask_ref}
    if fade_in is not None:
        op["fadeInMs"] = fade_in
    if fade_out is not None:
        op["fadeOutMs"] = fade_out
    return op


def _require_caps(features: List[str], what: str) -> None:
    """Refuse a flag the app's edit CLI can't save (a dry run with no CLI to ask goes ahead)."""
    caps = _caps_or_none()
    if caps is not None and features:
        _mods().editdoc.require_caps(caps, features, what)


# ── inspect ───────────────────────────────────────────────────────────────────


def _used_by(project: Any, rels: List[str]) -> List[Dict[str, Any]]:
    from . import repoint

    return repoint.usages(project, rels)


def cmd_list(ctx: Any) -> int:
    m = _mods()
    project = start(ctx)
    rows = []
    for name in m.editdoc.list_names(project):
        row: Dict[str, Any] = {"name": name, "output": m.editdoc.output_rel(name)}
        try:
            doc, _sha = m.editdoc.load(project, name)
            data = timeline_data(doc)
            row.update({"durationMs": data["durationMs"], "clips": len(data["clips"]), "taps": len(data["taps"]), "masks": len(data["masks"]), "sources": [s["rel"] for s in doc["sources"]]})
        except m.editdoc.DocError as e:
            row["error"] = e.message
        row["render"] = {"state": m.editdoc.render_state(project, name)}
        row["usedBy"] = sorted({u["scene"] for u in _used_by(project, [row["output"]])})
        rows.append(row)
    if ctx.json:
        _json({"edits": rows})
        return EXIT_OK
    if not rows:
        _emit("no edits yet; start one with kb video new assets/<recording>.mp4")
        return EXIT_OK
    for r in rows:
        if "error" in r:
            _emit(f"{r['name']}  CORRUPT: {r['error']}")
            continue
        used = ", ".join(r["usedBy"]) or "unused"
        _emit(f"{r['name']}  {fmt_s(r['durationMs'])}  {r['clips']} clip(s) {r['taps']} tap(s) {r['masks']} mask(s)  render {r['render']['state']}  used by {used}  ({', '.join(r['sources'])})")
    _emit("next: kb video show NAME")
    return EXIT_OK


def _moment_lines(doc: Dict[str, Any], t: float) -> Tuple[Dict[str, Any], List[str]]:
    m = _mods()
    laid = m.em.relayout(doc["clips"])
    fps = m.em.output_fps(doc)
    total = m.plan.total_ms(doc)
    info: Dict[str, Any] = {"timelineMs": t, "frame": m.em.frame_at(t, fps), "totalMs": total}
    moment = m.em.source_moment_at(laid, t)
    lines = [f"timeline {fmt_s(t)} = output frame {info['frame']} (of {m.em.total_frames(laid, fps)})"]
    if moment is None:
        lines.append("  nothing on screen (the edit is empty)")
        return info, lines
    clip = moment["clip"]
    info.update({"clip": clip["id"], "clipIndex": moment["index"], "sourceId": moment["sourceId"], "sourceMs": moment["sourceMs"], "hold": moment["hold"]})
    kind = "holds" if moment["hold"] else f"plays at {_speed(clip.get('speed'))}"
    lines.append(f"  clip {clip['id']} (index {moment['index']}) {kind}: source {moment['sourceId']}@{fmt_s(moment['sourceMs'])}")
    taps = [tp["id"] for tp in doc.get("taps") or [] if any(w["startMs"] <= t < w["endMs"] for w in m.em.tap_windows(laid, tp, m.em.TAP_DURATION_MS))]
    sources = {s["id"]: s for s in doc["sources"]}
    masks = [mk["id"] for mk in doc.get("masks") or [] if mk["sourceId"] == moment["sourceId"] and m.em.mask_active_at(mk, moment["sourceMs"], (sources.get(mk["sourceId"]) or {}).get("kind") == "image")]
    info.update({"taps": taps, "masks": masks})
    if taps:
        lines.append(f"  taps on screen: {', '.join(taps)}")
    if masks:
        lines.append(f"  masks on screen: {', '.join(masks)}")
    return info, lines


def cmd_show(ctx: Any) -> int:
    m = _mods()
    project = start(ctx)
    a = ctx.args
    doc, sha = m.editdoc.load(project, m.editdoc.check_name(a.name))
    doc = dict(doc, clips=m.em.relayout(doc["clips"]))
    state = m.editdoc.render_state(project, a.name)
    issues = m.editdoc.static_issues(doc, a.name, project)
    used = _used_by(project, [m.editdoc.output_rel(a.name)])
    at = _at_or_src(doc, a, required=False)
    if ctx.json:
        out = {"name": a.name, "hash": sha, "render": {"state": state, "record": m.editdoc.render_record(project, a.name)}, "output": m.editdoc.output_rel(a.name), "usedBy": used, "issues": issues, "timeline": timeline_data(doc)}
        if at is not None:
            out["at"] = _moment_lines(doc, at)[0]
        _json(out)
        return EXIT_OK
    for line in timeline_lines(doc, state):
        _emit(line)
    if used:
        _emit("  used by: " + ", ".join(f"{u['scene']} {u['ref']}" for u in used))
    for line in _issue_lines(issues):
        _emit(line)
    if at is not None:
        for line in _moment_lines(doc, at)[1]:
            _emit(line)
    _emit(f"hash {sha[:12]}")
    _emit(f"next: kb video render {a.name}" if state != "fresh" else f"next: kb video map {a.name} --at T, or kb capture to see it in a scene")
    return EXIT_OK


def _usage_context(project: Any, name: str, doc: Dict[str, Any], a: Any) -> Optional[Dict[str, Any]]:
    m = _mods()
    rels = [m.editdoc.output_rel(name)] + [s["rel"] for s in doc["sources"]]
    if getattr(a, "scene", None) is not None:
        slot = a.slot
        if slot is None:
            base, target = m.repoint.pick_slot(project, a.scene, rels)
            slot = m.repoint.slot_ref(base, target)
        return m.repoint.slot_info(project, a.scene, slot)
    used = _used_by(project, rels)
    if len(used) == 1:
        return m.repoint.slot_info(project, str(used[0]["index"]), used[0]["ref"])
    return None


def cmd_map(ctx: Any) -> int:
    m = _mods()
    project = start(ctx)
    a = ctx.args
    doc, _sha = m.editdoc.load(project, m.editdoc.check_name(a.name))
    doc = dict(doc, clips=m.em.relayout(doc["clips"]))
    where = _usage_context(project, a.name, doc, a)
    times: List[float] = []
    label = ""
    if a.at is not None:
        times = _times(doc, [a.at])
        label = f"--at {a.at}"
    elif a.src is not None:
        sid, ms = m.plan.parse_src(doc, a.src)
        for clip in doc["clips"]:
            if clip["sourceId"] == sid and not m.em.is_freeze(clip) and clip["inMs"] <= ms < clip["outMs"]:
                times.append(clip["startMs"] + (ms - clip["inMs"]) / m.em.effective_speed(clip.get("speed")))
        label = f"source {sid}@{fmt_s(ms)}"
        if not times:
            raise _kb_error(f"{label} is not on the timeline (cut, or only on a freeze)")
    elif a.tap is not None:
        tap = m.plan.select_tap(doc, a.tap)
        times = [w["startMs"] for w in m.em.tap_windows(doc["clips"], tap, m.em.TAP_DURATION_MS)]
        label = f"tap {tap['id']}"
        if not times:
            raise _kb_error(f"{label} is never on screen")
    elif a.scene_at is not None:
        if where is None:
            raise _kb_error("--scene-at needs the scene that shows this edit: pass --scene S [--slot P]", EXIT_ENV)
        scene_t = m.plan.parse_time(a.scene_at, total_ms=where.get("sceneDurationMs"), what="--scene-at")
        if where.get("retimed"):
            t = m.repoint.slot_media_ms(where, scene_t)
        else:
            t = scene_t - (where.get("startMs") or 0)
        if t < 0:
            raise _kb_error(f"the video starts {fmt_s(where.get('startMs'))} into the scene, after {a.scene_at}")
        times = [t]
        label = f"scene time {a.scene_at}"
    else:
        raise _kb_error("pass one of --at T, --src [SID@]T, --tap ID or --scene-at T", EXIT_ENV)
    rows = []
    for t in times:
        info, lines = _moment_lines(doc, t)
        if where is not None and where.get("retimed") and m.repoint.slot_scene_ms(where, t) is None:
            lines.append(f"  scene {where['scene']} {where['ref']}: never shown (outside the slot's inMs..outMs)")
        elif where is not None:
            scene_ms = m.repoint.slot_scene_ms(where, t) if where.get("retimed") else (where.get("startMs") or 0) + t
            info["scene"] = {"scene": where["scene"], "slot": where["ref"], "sceneMs": scene_ms, "projectMs": where["sceneStartMs"] + scene_ms, "startMs": where.get("startMs") or 0, "sceneDurationMs": where.get("sceneDurationMs")}
            past = where.get("sceneDurationMs") is not None and scene_ms >= where["sceneDurationMs"]
            lines.append(f"  scene {where['scene']} {where['ref']}: {fmt_s(scene_ms)} into the scene (video starts at {fmt_s(where.get('startMs') or 0)}), project {fmt_s(info['scene']['projectMs'])}" + ("  PAST THE SCENE END" if past else ""))
        rows.append((info, lines))
    if ctx.json:
        _json({"name": a.name, "query": label, "results": [r[0] for r in rows], "usage": where})
        return EXIT_OK
    _emit(f"{a.name} {label}:")
    for _info, lines in rows:
        for line in lines:
            _emit(line)
    if where is None:
        _emit("  (no single scene shows this edit; pass --scene S [--slot P] for scene and project times)")
    return EXIT_OK


def cmd_usages(ctx: Any) -> int:
    m = _mods()
    project = start(ctx)
    a = ctx.args
    rels: Optional[List[str]] = None
    if a.target:
        if a.target.startswith("assets/"):
            rels = [a.target]
        else:
            doc, _sha = m.editdoc.load(project, m.editdoc.check_name(a.target))
            rels = [m.editdoc.output_rel(a.target)] + [s["rel"] for s in doc["sources"]]
    else:
        rels = []
        for name in m.editdoc.list_names(project):
            rels.append(m.editdoc.output_rel(name))
            try:
                rels += [s["rel"] for s in m.editdoc.load(project, name)[0]["sources"]]
            except m.editdoc.DocError:
                continue
    used = m.repoint.usages(project, rels)
    edits_using = []
    for name in m.editdoc.list_names(project):
        try:
            doc, _sha = m.editdoc.load(project, name)
        except m.editdoc.DocError:
            continue
        for s in doc["sources"]:
            if rels is not None and s["rel"] in rels and (not a.target or a.target != name):
                edits_using.append({"edit": name, "source": s["rel"]})
    if ctx.json:
        _json({"slots": used, "edits": edits_using})
        return EXIT_OK
    if not used and not edits_using:
        _emit("no scene shows " + (", ".join(rels) if rels else "any edit's media"))
        return EXIT_OK
    for u in used:
        timing = ", ".join(f"{k} {v}" for k, v in (u.get("timing") or {}).items())
        tags = [u["kind"] or "?"] + (["follows media"] if u["followsMedia"] else []) + ([] if u["repointable"] else ["not re-pointable"]) + ([f"retimed: {timing}"] if timing else [])
        _emit(f"scene {u['index']} {u['scene']} {u['ref']}: {u['src']} ({', '.join(tags)})")
    for e in edits_using:
        _emit(f"edit {e['edit']} uses {e['source']}")
    return EXIT_OK


def cmd_validate(ctx: Any) -> int:
    m = _mods()
    project = start(ctx)
    a = ctx.args
    name = m.editdoc.check_name(a.name)
    doc, _sha = m.editdoc.load(project, name)
    static = m.editdoc.static_issues(doc, name, project)
    from ..util import KbError

    report: Optional[Dict[str, Any]] = None
    cli_note = None
    try:
        report = m.appcli.validate(project, name=name)
    except KbError as e:
        cli_note = e.message
    issues = list(static)
    if report is not None:
        def key(i: Dict[str, Any]) -> Tuple[Any, ...]:
            return (i.get("code"), i.get("clip"), i.get("tap"), i.get("mask"))

        app_issues = []
        for sev, field in (("error", "errors"), ("warning", "warnings")):
            for i in report.get(field) or []:
                item = dict(i) if isinstance(i, dict) else {"message": str(i)}
                item["severity"] = sev
                item.setdefault("code", "app")
                item["message"] = str(item.get("message") or item["code"])
                app_issues.append(item)
        known = {key(i) for i in app_issues}
        issues = app_issues + [i for i in static if key(i) not in known]
    errors = [i for i in issues if i["severity"] == "error"]
    if ctx.json:
        _json({"name": name, "ok": not errors, "app": report, "issues": issues, "appError": cli_note})
        return EXIT_PROBLEMS if errors else EXIT_OK
    if report is not None:
        _emit(f"{name}: {report.get('totalFrames')} frames, {fmt_s(report.get('durationMs'))} at {report.get('fps')} fps, {report.get('width')}x{report.get('height')} (the app's check)")
    else:
        _emit(f"{name}: static check only ({cli_note})")
    for line in _issue_lines(issues):
        _emit(line)
    _emit(f"{len(errors)} error(s), {len(issues) - len(errors)} warning(s)" + ("" if errors else "; ok"))
    if errors:
        _emit(f"next: fix the errors (kb video show {name})")
    elif m.editdoc.render_state(project, name) == "fresh":
        _emit(f"next: the render is up to date; kb video map {name} --at T, or kb capture to see it in a scene")
    else:
        _emit(f"next: kb video render {name}")
    return EXIT_PROBLEMS if errors else EXIT_OK


def cmd_caps(ctx: Any) -> int:
    m = _mods()
    info = m.appcli.locate()
    caps = m.appcli.caps(info)
    if ctx.json:
        _json({"cli": info.as_dict(), "caps": caps, "extensionErrors": EXTENSION_ERRORS})
        return EXIT_OK
    _emit(f"edit CLI: {info.path} (found via {info.source})")
    _emit(f"app {caps.get('appVersion')} ({caps.get('build')}), cli {caps.get('cli')}, commands {', '.join(caps.get('commands') or [])}")
    for tool in ("ffmpeg", "ffprobe"):
        t = caps.get(tool) or {}
        _emit(f"{tool}: {t.get('path')} ({'ok' if t.get('ok') else 'BROKEN'})")
    tap = caps.get("tap") or {}
    _emit(f"taps: styles {', '.join(tap.get('styles') or [])}; colours {', '.join(tap.get('colors') or [])}; size {tap.get('sizeRange')}")
    mask = caps.get("mask") or {}
    _emit(f"masks: {', '.join(mask.get('styles') or [])}")
    _emit(f"limits: {json.dumps(caps.get('limits') or {})}; {len(caps.get('filters') or [])} ffmpeg filters; hardware video {'on' if caps.get('hardwareVideo') else 'off'}")
    for e in EXTENSION_ERRORS:
        _emit(f"warning: {e}")
    return EXIT_OK


# ── create ────────────────────────────────────────────────────────────────────


def _targets_path(project: Any) -> Path:
    from . import cache

    return cache.video_dir(project) / "targets.json"


def remembered_target(project: Any, name: str) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(_targets_path(project).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    hit = data.get(name) if isinstance(data, dict) else None
    return hit if isinstance(hit, dict) else None


def remember_target(project: Any, name: str, scene: str, slot: str) -> None:
    from ..util import atomic_write_json

    path = _targets_path(project)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    data[name] = {"scene": scene, "slot": slot}
    atomic_write_json(path, data)


def _parse_for(project: Any, spec: str) -> Tuple[str, Optional[str]]:
    """SCENE[:SLOT[:ID]] to (scene stem, slot ref or None)."""
    scene, _, slot = spec.partition(":")
    _idx, stem = project.resolve(scene)
    return stem, slot or None


def cmd_new(ctx: Any) -> int:
    m = _mods()
    project = start(ctx)
    a = ctx.args
    guard_worktree(project)
    notes: List[str] = []
    for_scene, for_slot = _parse_for(project, a.for_) if a.for_ else (None, None)
    if a.src is None:
        if for_scene is None:
            raise _kb_error("kb video new needs SRC (an assets/ path or a file), or --for SCENE[:SLOT] to edit what a slot shows", EXIT_ENV)
        if for_slot is None:
            entries = [e for e in m.repoint.slot_entries(m.repoint._read_sidecar(project, for_scene)[0] or {}) if e["repointable"] and e["kind"] in ("video", "image")]
            if len(entries) != 1:
                shown = ", ".join(f"{m.repoint.slot_ref(e['slot'], e['targetId'])} ({e['src']})" for e in entries) or "no media"
                raise _kb_error(f"scene {for_scene} shows {shown}; name the slot: --for {for_scene}:SLOT", EXIT_ENV)
            for_slot = m.repoint.slot_ref(entries[0]["slot"], entries[0]["targetId"])
        rel = m.repoint.slot_info(project, for_scene, for_slot)["src"]
    else:
        rel, note = resolve_media_arg(project, a.src)
        if note:
            notes.append(note)
    reopened = m.editdoc.name_of_output(rel)
    if reopened and m.editdoc.edit_path(project, reopened).is_file() and not a.name:
        name = reopened
        doc, _sha = m.editdoc.load(project, name)
        notes.append(f"{rel} is the render of edits/{name}.json, so this reopens that edit")
        created = False
    else:
        name = m.editdoc.check_name(a.name) if a.name else m.editdoc.default_name(rel)
        path = m.editdoc.edit_path(project, name)
        created = True
        if path.is_file():
            try:
                existing, _sha = m.editdoc.load(project, name)
                current = existing["sources"][0]["rel"] if existing["sources"] else None
            except m.editdoc.DocError:
                existing, current = None, None
            if existing is not None and current != rel:
                n = 2
                while m.editdoc.edit_path(project, f"{name}-{n}").exists():
                    n += 1
                free = f"{name}-{n}"
                raise _kb_error(f"edits/{name}.json already edits {current}; pass --name to start a separate edit of {rel} (e.g. --name {free})")
            if not a.fresh:
                if existing is None:
                    raise _kb_error(f"edits/{name}.json is unreadable; kb video reset {name} --yes rebuilds it, or pass --fresh")
                doc = existing
                created = False
                notes.append(f"edits/{name}.json already edits {rel}; reusing it (--fresh starts over)")
        if created:
            m.appcli.caps()
            if path.is_file():
                saved = checkpoint_before(project, f"kb video new --fresh {name}")
                if saved:
                    notes.append(f"checkpoint {saved} holds the old edit (kb undo {saved})")
            result = m.appcli.create(project, rel, name, force=path.is_file())
            doc = result.get("doc") or m.editdoc.load(project, name)[0]
            notes.append(f"created edits/{name}.json from {rel}")
    if for_scene is not None:
        if for_slot is None:
            base, target = m.repoint.pick_slot(project, for_scene, [rel, m.editdoc.output_rel(name)])
            for_slot = m.repoint.slot_ref(base, target)
        m.repoint.slot_info(project, for_scene, for_slot)
        remember_target(project, name, for_scene, for_slot)
        notes.append(f"render --use will point {for_scene} {for_slot} at {m.editdoc.output_rel(name)}")
    doc = dict(doc, clips=m.em.relayout(doc["clips"]))
    if ctx.json:
        _json({"name": name, "created": created, "source": rel, "notes": notes, "for": remembered_target(project, name), "timeline": timeline_data(doc)})
        return EXIT_OK
    for n in notes:
        _emit(n)
    for line in timeline_lines(doc, m.editdoc.render_state(project, name)):
        _emit(line)
    _emit(f"next: kb video show {name}, edit it (kb video cut/split/speed/tap/mask ...), then kb video render {name}" + (" --use" if for_scene else ""))
    return EXIT_OK


def cmd_reset(ctx: Any) -> int:
    m = _mods()
    project = start(ctx)
    a = ctx.args
    name = m.editdoc.check_name(a.name)
    guard_worktree(project)
    if not a.yes:
        raise _kb_error(f"reset discards every change in edits/{name}.json (it is kept as {name}.json.bak); pass --yes", EXIT_ENV)
    rel = a.source
    if rel is None:
        try:
            doc, _sha = m.editdoc.load(project, name)
            rel = doc["sources"][0]["rel"] if doc["sources"] else None
        except m.editdoc.DocError:
            try:
                raw = json.loads(m.editdoc.edit_path(project, name).read_text(encoding="utf-8"))
                rel = raw["sources"][0]["rel"]
            except Exception:
                rel = None
    if not isinstance(rel, str):
        from .. import assets as assetmod

        matches = [a["path"] for a in assetmod.list_assets(project) if a["kind"] in ("video", "image") and m.editdoc.default_name(a["path"]) == name and not m.editdoc.name_of_output(a["path"])]
        rel = matches[0] if len(matches) == 1 else None
    if not isinstance(rel, str):
        raise _kb_error(f"cannot tell which file edits/{name}.json started from; pass --source assets/<file>")
    m.appcli.caps()
    saved = checkpoint_before(project, f"kb video reset {name}")
    with m.editdoc.edit_lock(project, name, "kb video reset", getattr(a, "wait", None)):
        result = m.appcli.create(project, rel, name, force=True)
    doc = result.get("doc") or m.editdoc.load(project, name)[0]
    if ctx.json:
        _json({"name": name, "source": rel, "checkpoint": saved, "timeline": timeline_data(doc)})
        return EXIT_OK
    _emit(f"rebuilt edits/{name}.json from {rel} (the old one is edits/{name}.json.bak)")
    if saved:
        _emit(f"checkpoint {saved} holds the state before this (kb undo {saved})")
    for line in timeline_lines(doc):
        _emit(line)
    _emit(f"next: kb video render {name}")
    return EXIT_OK


# ── clips ─────────────────────────────────────────────────────────────────────


def cmd_split(ctx: Any) -> int:
    a = ctx.args
    return run_mutation(ctx, a.name, lambda doc: [{"op": "split", "atMs": t} for t in _times(doc, a.at)], "split")


def cmd_cut(ctx: Any) -> int:
    m = _mods()
    a = ctx.args

    def build(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
        if a.src:
            return [dict(m.plan.parse_src_range(doc, r), op="cutSource") for r in a.ranges]
        ranges = [m.plan.parse_range(r, fps=m.em.output_fps(doc), total_ms=m.plan.total_ms(doc)) for r in a.ranges]
        ops = m.plan.timeline_ranges_to_source(doc, ranges, "cutSource")
        if not ops:
            raise _kb_error("no clip plays in " + ", ".join(a.ranges))
        return ops

    return run_mutation(ctx, a.name, build, "cut", checkpoint=True)


def cmd_keep(ctx: Any) -> int:
    m = _mods()
    a = ctx.args
    return run_mutation(ctx, a.name, lambda doc: [{"op": "keep", "ranges": [m.plan.parse_src_range(doc, r) for r in a.ranges]}], "keep", checkpoint=True)


def cmd_trim(ctx: Any) -> int:
    m = _mods()
    a = ctx.args

    def build(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
        clip = m.plan.select_clip(doc, a.clip)
        source = next((s for s in doc["sources"] if s["id"] == clip["sourceId"]), {})
        fps = m.plan.source_fps(doc, source) if source else m.em.output_fps(doc)
        speed = m.em.effective_speed(clip.get("speed"))
        ops: List[Dict[str, Any]] = []
        if a.in_ is not None:
            ops.append({"op": "trimIn", "clipId": clip["id"], "inMs": m.plan.parse_time(a.in_, fps=fps, total_ms=source.get("durationMs"), what="--in")})
        if a.head is not None:
            ops.append({"op": "trimIn", "clipId": clip["id"], "inMs": clip["inMs"] + m.plan.parse_time(a.head, fps=m.em.output_fps(doc), what="--head") * speed})
        if a.out is not None:
            ops.append({"op": "trimOut", "clipId": clip["id"], "outMs": m.plan.parse_time(a.out, fps=fps, total_ms=source.get("durationMs"), what="--out")})
        if a.tail is not None:
            ops.append({"op": "trimOut", "clipId": clip["id"], "outMs": clip["outMs"] - m.plan.parse_time(a.tail, fps=m.em.output_fps(doc), what="--tail") * speed})
        if not ops:
            raise _kb_error("trim needs --in T or --out T (source time), or --head D or --tail D (timeline)", EXIT_ENV)
        return ops

    return run_mutation(ctx, a.name, build, "trim")


def cmd_speed(ctx: Any) -> int:
    m = _mods()
    a = ctx.args

    def build(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
        if a.range or a.src_range:
            if len(a.rest) != 1:
                raise _kb_error("with --range or --src-range pass only the speed, e.g. kb video speed NAME --range 2-5 2", EXIT_ENV)
            speed = m.plan.parse_speed(a.rest[0])
            if a.src_range:
                return [dict(m.plan.parse_src_range(doc, a.src_range), op="speedSource", speed=speed)]
            rng = m.plan.parse_range(a.range, fps=m.em.output_fps(doc), total_ms=m.plan.total_ms(doc))
            ops = m.plan.timeline_ranges_to_source(doc, [rng], "speedSource", speed)
            if not ops:
                raise _kb_error(f"no clip plays in {a.range}")
            return ops
        if len(a.rest) != 2:
            raise _kb_error("speed takes CLIP X (e.g. kb video speed NAME c2 1.5), or --range A-B X", EXIT_ENV)
        clip = m.plan.select_clip(doc, a.rest[0])
        return [{"op": "setSpeed", "clipId": clip["id"], "speed": m.plan.parse_speed(a.rest[1])}]

    return run_mutation(ctx, a.name, build, "speed")


def cmd_freeze(ctx: Any) -> int:
    m = _mods()
    a = ctx.args

    def build(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
        op: Dict[str, Any] = {"op": "freeze", "atMs": _at_or_src(doc, a)}
        if a.hold is not None:
            op["holdMs"] = m.em.js_round(m.plan.parse_time(a.hold, fps=m.em.output_fps(doc), what="--hold"))
        return [op]

    return run_mutation(ctx, a.name, build, "freeze")


def cmd_hold(ctx: Any) -> int:
    m = _mods()
    a = ctx.args
    return run_mutation(ctx, a.name, lambda doc: [{"op": "setHold", "clipId": m.plan.select_clip(doc, a.clip)["id"], "holdMs": m.em.js_round(m.plan.parse_time(a.duration, fps=m.em.output_fps(doc), what="hold"))}], "hold")


def cmd_remove(ctx: Any) -> int:
    m = _mods()
    a = ctx.args

    def build(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
        ids = []
        for sel in a.clips:
            cid = m.plan.select_clip(doc, sel)["id"]
            if cid not in ids:
                ids.append(cid)
        return [{"op": "removeClip", "clipId": cid} for cid in ids]

    return run_mutation(ctx, a.name, build, "remove", checkpoint=True)


def cmd_move(ctx: Any) -> int:
    m = _mods()
    a = ctx.args

    def build(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
        clips = doc["clips"]
        clip = m.plan.select_clip(doc, a.clip)
        frm = next(i for i, c in enumerate(clips) if c["id"] == clip["id"])
        if a.to is not None:
            to = a.to
        elif a.before is not None or a.after is not None:
            other = m.plan.select_clip(doc, a.before if a.before is not None else a.after)
            j = next(i for i, c in enumerate(clips) if c["id"] == other["id"])
            if a.before is not None:
                to = j if j < frm else j - 1
            else:
                to = j + 1 if j < frm else j
        else:
            raise _kb_error("move needs --to N, --before CLIP or --after CLIP", EXIT_ENV)
        return [{"op": "moveClip", "from": frm, "to": to}]

    return run_mutation(ctx, a.name, build, "move")


def _media_ops(ctx: Any, rel: str, place: Dict[str, Any]) -> Callable[[Dict[str, Any]], List[Dict[str, Any]]]:
    m = _mods()
    a = ctx.args

    def build(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
        op = dict(place)
        if "atMs" in op and isinstance(op["atMs"], str):
            op["atMs"] = _times(doc, [op["atMs"]])[0]
        op.update({"source": rel, "as": "new"})
        ops = [op]
        if getattr(a, "hold", None) is not None:
            ops.append({"op": "setHold", "clipId": "$new", "holdMs": m.em.js_round(m.plan.parse_time(a.hold, fps=m.em.output_fps(doc), what="--hold"))})
        return ops

    return build


def cmd_insert(ctx: Any) -> int:
    a = ctx.args
    project = start(ctx)
    rel, note = resolve_media_arg(project, a.media)
    if note:
        _err(f"kb: {note}")
    if a.at is not None:
        place: Dict[str, Any] = {"op": "insertClip", "atMs": a.at}
    elif a.index is not None:
        place = {"op": "addClip", "index": a.index}
    else:
        place = {"op": "addClip"}
    return run_mutation(ctx, a.name, _media_ops(ctx, rel, place), "insert")


def cmd_append(ctx: Any) -> int:
    a = ctx.args
    project = start(ctx)
    rel, note = resolve_media_arg(project, a.media)
    if note:
        _err(f"kb: {note}")
    return run_mutation(ctx, a.name, _media_ops(ctx, rel, {"op": "addClip"}), "append")


# ── taps ──────────────────────────────────────────────────────────────────────


def cmd_tap(ctx: Any) -> int:
    m = _mods()
    a = ctx.args
    verb = a.tap_op
    if verb == "list":
        project = start(ctx)
        doc, _sha = m.editdoc.load(project, m.editdoc.check_name(a.name))
        data = timeline_data(doc)
        if ctx.json:
            _json({"name": a.name, "taps": data["taps"], "tapStyle": data["tapStyle"], "tapColor": data["tapColor"], "tapSize": data["tapSize"]})
            return EXIT_OK
        if not data["taps"]:
            _emit(f"{a.name} has no taps; add one with kb video tap add {a.name} --at T --pos X,Y")
        for line in timeline_lines(doc):
            if line.startswith(("  tap ", "  tap look")):
                _emit(line.strip())
        return EXIT_OK

    def build(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
        if verb == "add":
            if a.src is not None:
                sid, ms = m.plan.parse_src(doc, a.src)
                t = m.plan.first_occurrence(doc, sid, ms)
                return [{"op": "addTapAtSource", "sourceId": sid, "sourceMs": ms, "pos": _pos(doc, a, t)}]
            t = _at_or_src(doc, a)
            return [{"op": "addTap", "atMs": t, "pos": _pos(doc, a, t)}]
        tap = m.plan.select_tap(doc, a.taps[0]) if verb != "style" else None
        if verb == "move":
            t = m.plan.first_occurrence(doc, tap["sourceId"], tap["sourceMs"])
            return [{"op": "moveTap", "tapId": tap["id"], "pos": _pos(doc, a, t)}]
        if verb == "retime":
            return [{"op": "retimeTap", "tapId": tap["id"], "atMs": _at_or_src(doc, a)}]
        if verb == "remove":
            ids = []
            for sel in a.taps:
                tid = m.plan.select_tap(doc, sel)["id"]
                if tid not in ids:
                    ids.append(tid)
            return [{"op": "removeTap", "tapId": tid} for tid in ids]
        caps = _caps_or_none() or {}
        tap_caps = caps.get("tap") or {}
        op: Dict[str, Any] = {"op": "setTapLook"}
        if a.style is not None:
            if tap_caps.get("styles") and a.style not in tap_caps["styles"]:
                raise _kb_error(f'unknown tap style "{a.style}"; one of {", ".join(tap_caps["styles"])}', EXIT_ENV)
            op["style"] = a.style
        if a.colour is not None:
            if tap_caps.get("colors") and a.colour not in tap_caps["colors"]:
                raise _kb_error(f'unknown tap colour "{a.colour}"; one of {", ".join(tap_caps["colors"])}', EXIT_ENV)
            op["color"] = a.colour
        if a.size is not None:
            lo, hi = tap_caps.get("sizeRange") or (0.25, 4)
            if not lo <= a.size <= hi:
                raise _kb_error(f"--size is {lo}..{hi} (1.25 is the default)", EXIT_ENV)
            op["size"] = a.size
        if len(op) == 1:
            raise _kb_error("tap style needs --style, --colour or --size", EXIT_ENV)
        return [op]

    return run_mutation(ctx, a.name, build, f"tap {verb}")


# ── masks ─────────────────────────────────────────────────────────────────────


def cmd_mask(ctx: Any) -> int:
    m = _mods()
    a = ctx.args
    verb = a.mask_op
    if verb == "list":
        project = start(ctx)
        doc, _sha = m.editdoc.load(project, m.editdoc.check_name(a.name))
        data = timeline_data(doc)
        if ctx.json:
            _json({"name": a.name, "masks": data["masks"]})
            return EXIT_OK
        if not data["masks"]:
            _emit(f"{a.name} has no masks; add one with kb video mask add {a.name} --at T --rect x,y,w,h")
        for mk in data["masks"]:
            where = ", ".join(f"{fmt_s(w['startMs'])}-{fmt_s(w['endMs'])}" for w in mk["windows"]) or "never on screen"
            fades = "".join(f", fades {edge} {fmt_s(mk[key])}" for edge, key in (("in", "fadeInMs"), ("out", "fadeOutMs")) if mk.get(key))
            _emit(f"{mk['id']} {mk.get('style')} {mk['sourceId']} source {fmt_s(mk['startMs'])}-{fmt_s(mk['endMs'])}{fades} -> {where}")
            for k in mk["keys"]:
                r = k["rect"]
                _emit(f"    key {mk['sourceId']}@{fmt_s(k['sourceMs'])}: x {r[0]:.3f} y {r[1]:.3f} w {r[2]:.3f} h {r[3]:.3f}")
        return EXIT_OK

    fading = getattr(a, "fade_in", None) is not None or getattr(a, "fade_out", None) is not None
    if fading:
        _require_caps(["mask.fades"], f"mask {verb} --fade-in/--fade-out")
    if getattr(a, "until_scene", None) is None and (getattr(a, "scene", None) is not None or getattr(a, "slot", None) is not None):
        raise _kb_error("--scene and --slot go with --until-scene T", EXIT_ENV)
    project = ctx.project

    def build(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
        if verb == "add":
            t = _at_or_src(doc, a)
            op: Dict[str, Any] = {"op": "addMask", "atMs": t, "rect": _rect(doc, a, t), "as": "new"}
            if a.style is not None:
                op["style"] = a.style
            if a.strength is not None:
                op["strength"] = _strength(a.strength)
            if a.colour is not None:
                op["color"] = _hex(a.colour)
            ops = [op] + _span_ops(doc, "$new", a, t)
            if a.until_scene is not None:
                ops.append(_until_scene_op(project, a.name, doc, a, "$new", _source_at(doc, t)["id"]))
            fade = _fade_op(doc, a, "$new")
            return ops + ([fade] if fade else [])
        if verb == "remove":
            ids = []
            for sel in a.masks:
                mid = m.plan.select_mask(doc, sel)["id"]
                if mid not in ids:
                    ids.append(mid)
            return [{"op": "removeMask", "maskId": mid} for mid in ids]
        mask = m.plan.select_mask(doc, a.masks[0])
        if verb == "key":
            t = _at_or_src(doc, a)
            return [{"op": "setMaskRect", "maskId": mask["id"], "atMs": t, "rect": _rect(doc, a, t)}]
        if verb == "hold":
            return [{"op": "addMaskKey", "maskId": mask["id"], "atMs": _at_or_src(doc, a)}]
        if verb == "unkey":
            return [{"op": "removeMaskKey", "maskId": mask["id"], "atMs": _at_or_src(doc, a)}]
        if verb == "offset":
            if a.by is None:
                raise _kb_error("mask offset needs --by DX,DY (0..1 fractions) or --px DX,DY", EXIT_ENV)
            dx, dy = m.plan.parse_pair(a.by, "--by")
            if a.px:
                source = next(s for s in doc["sources"] if s["id"] == mask["sourceId"])
                dx, dy = dx / source["width"], dy / source["height"]
            return [{"op": "offsetMask", "maskId": mask["id"], "dx": dx, "dy": dy}]
        if verb == "set":
            op = {"op": "setMaskLook", "maskId": mask["id"]}
            if a.style is not None:
                op["style"] = a.style
            if a.strength is not None:
                op["strength"] = None if a.strength.lower() in ("none", "default") else _strength(a.strength)
            if a.colour is not None:
                op["color"] = None if a.colour.lower() in ("none", "default") else _hex(a.colour)
            ops = [op] if len(op) > 2 else []
            if a.until_scene is not None:
                ops.append(_until_scene_op(project, a.name, doc, a, mask["id"], mask["sourceId"]))
            fade = _fade_op(doc, a, mask["id"])
            ops += [fade] if fade else []
            if not ops:
                raise _kb_error("mask set needs --style, --strength, --colour, --fade-in, --fade-out or --until-scene", EXIT_ENV)
            return ops
        ops = _span_ops(doc, mask["id"], a, None)
        if a.until_scene is not None:
            ops.append(_until_scene_op(project, a.name, doc, a, mask["id"], mask["sourceId"]))
        if not ops:
            raise _kb_error("mask span needs --from T / --until T (timeline), --src-start S / --src-end S (source) or --until-scene T --scene S", EXIT_ENV)
        return ops

    return run_mutation(ctx, a.name, build, f"mask {verb}")


# ── crop and zoom ─────────────────────────────────────────────────────────────


def _clip_source(doc: Dict[str, Any], clip: Dict[str, Any]) -> Dict[str, Any]:
    source = next((s for s in doc["sources"] if s["id"] == clip["sourceId"]), None)
    if source is None:
        raise _kb_error(f"clip {clip['id']} plays source {clip['sourceId']}, which this edit lacks")
    return source


def _aspect(text: str) -> float:
    raw = text.strip()
    try:
        if ":" in raw:
            w, h = (float(v) for v in raw.split(":", 1))
            value = w / h
        else:
            value = float(raw)
    except (ValueError, ZeroDivisionError):
        raise _kb_error(f'--aspect "{text}" is not W:H (9:16) or a ratio (0.5625)', EXIT_ENV) from None
    if not 0 < value < 100:
        raise _kb_error(f'--aspect "{text}" must be a positive width:height', EXIT_ENV)
    return value


def cmd_crop(ctx: Any) -> int:
    m = _mods()
    a = ctx.args
    if a.centre is not None and a.aspect is None:
        raise _kb_error("--centre goes with --aspect", EXIT_ENV)
    if not a.clear:
        _require_caps(["crop"], "a crop")

    def build(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
        clip = m.plan.select_clip(doc, a.clip)
        if a.clear:
            return [{"op": "setClipCrop", "clipId": clip["id"], "crop": None}]
        if a.rect is not None:
            rect = m.plan.parse_pair(a.rect, "--rect", 4)
        else:
            centre = m.plan.parse_pair(a.centre, "--centre") if a.centre is not None else [0.5, 0.5]
            rect = m.em.aspect_crop_rect(_clip_source(doc, clip), _aspect(a.aspect), centre)
        return [{"op": "setClipCrop", "clipId": clip["id"], "crop": rect}]

    return run_mutation(ctx, a.name, build, "crop")


def cmd_zoom(ctx: Any) -> int:
    m = _mods()
    a = ctx.args
    if a.at is None and (a.rect is not None or a.ease is not None):
        raise _kb_error("--rect and --ease go with --at T", EXIT_ENV)
    if a.at is not None and a.rect is None and a.ease is None:
        raise _kb_error("--at T needs --rect x,y,w,h (a key there), or --ease linear|smooth (how the key there glides)", EXIT_ENV)
    if a.to is not None and a.move is None:
        raise _kb_error("--to goes with --move T", EXIT_ENV)
    if a.move is not None and a.to is None:
        raise _kb_error("--move T needs --to T2", EXIT_ENV)
    if a.at is not None or a.move is not None:
        _require_caps(["zoom"], "a zoom key")

    def build(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
        clip = m.plan.select_clip(doc, a.clip)
        fps = m.em.output_fps(doc)
        keys = (clip.get("zoom") or {}).get("keys") or []
        if a.clear:
            if not keys:
                raise _kb_error(f"clip {clip['id']} has no zoom keys" + (f" (its static crop goes with kb video crop {a.name} {clip['id']} --clear)" if clip.get("crop") else ""))
            return [{"op": "setClipCrop", "clipId": clip["id"], "crop": None}]
        if a.at is not None:
            t = _times(doc, [a.at])[0]
            local = t - clip["startMs"]
            if a.rect is None:
                return [{"op": "setZoomKeyEase", "clipId": clip["id"], "tMs": local, "ease": a.ease}]
            op: Dict[str, Any] = {"op": "setZoomKey", "clipId": clip["id"], "atMs": t, "rect": m.plan.parse_pair(a.rect, "--rect", 4)}
            ease = a.ease if a.ease is not None else (None if m.em.zoom_key_index(keys, local, fps) >= 0 else "smooth")
            if ease is not None:
                op["ease"] = ease
            return [op]
        if a.remove is not None:
            return [{"op": "removeZoomKey", "clipId": clip["id"], "tMs": _times(doc, [a.remove], "--remove")[0] - clip["startMs"]}]
        frm, to = _times(doc, [a.move, a.to], "--move")
        return [{"op": "moveZoomKey", "clipId": clip["id"], "tMs": frm - clip["startMs"], "toMs": to - clip["startMs"]}]

    return run_mutation(ctx, a.name, build, "zoom")


# ── batch ─────────────────────────────────────────────────────────────────────


def _read_plan(arg: str) -> Any:
    from ..util import KbError

    if arg == "-":
        text = sys.stdin.read()
        label = "the plan on stdin"
    elif arg.startswith("@"):
        try:
            text = Path(arg[1:]).expanduser().read_text(encoding="utf-8")
        except OSError as e:
            raise KbError(f"cannot read {arg[1:]}: {e.strerror}", EXIT_ENV) from None
        label = arg[1:]
    else:
        text = arg
        label = "the plan"
    try:
        return json.loads(text)
    except ValueError as e:
        raise KbError(f"{label} is not valid JSON ({e}); pass a JSON list of ops, @file.json or - for stdin", EXIT_ENV) from None


def cmd_apply(ctx: Any) -> int:
    m = _mods()
    a = ctx.args
    ops, plan_base = m.plan.normalise_plan(_read_plan(a.plan))
    base = a.base or plan_base
    return run_mutation(ctx, a.name, lambda doc: ops, "apply", checkpoint=True, base=base)


# ── output ────────────────────────────────────────────────────────────────────


class Progress:
    """At most about ten progress lines on stderr (JSON lines with --json)."""

    def __init__(self, as_json: bool) -> None:
        self.as_json = as_json
        self.step = -1

    def __call__(self, event: Dict[str, Any]) -> None:
        if self.as_json:
            _err(json.dumps(event))
            return
        kind = event.get("event")
        if kind == "start":
            _err(f"kb: rendering {event.get('total')} frames ({event.get('lane')} lane)")
        elif kind == "progress":
            total = event.get("total") or 0
            frame = event.get("frame") or 0
            step = int(frame * 5 / total) if total else 0
            if step > self.step and step < 5:
                self.step = step
                _err(f"kb: {frame}/{total} frames")
        elif kind == "retry":
            _err(f"kb: the hardware encoder failed ({event.get('error')}); retrying in software")


def _wait_for_export(project: Any, output: str, wait: Optional[float]) -> Optional[str]:
    """Refuse (or wait) while the app exports a project that plays this output."""
    import time

    from .. import bridge

    deadline = time.monotonic() + (wait or 0)
    while True:
        hb = bridge.live_heartbeat()
        busy = bool(hb and hb.get("exporting") and hb.get("openProject") == project.project_id)
        if busy and not _used_by(project, [output]):
            busy = False
        if not busy:
            return None
        if wait is None:
            raise _kb_error(f"the app is exporting {project.project_id}, which plays {output}; re-rendering it now would change the export mid-way. Rerun after it finishes, or pass --wait", EXIT_ENV)
        if time.monotonic() >= deadline:
            raise _kb_error(f"the app is still exporting {project.project_id} after {int(wait)} s; rerun when it finishes", EXIT_ENV)
        time.sleep(2.0)


def notify_media(project: Any, rels: List[str], name: Optional[str], warn: Callable[[str], None]) -> Optional[Dict[str, Any]]:
    from .. import bridge

    body: Dict[str, Any] = {"project": project.project_id, "projectPath": str(project.root.resolve()), "paths": rels}
    if name:
        body["edit"] = name
    return bridge.notify("mediaChanged", body, timeout=30, warn=warn)


def _use(project: Any, name: str, scene: Optional[str], slot: Optional[str], *, force: bool, follow: bool, durations: bool, warn: Callable[[str], None], dry_run: bool = False) -> Dict[str, Any]:
    """Point a scene slot at the render, optionally make the scene follow it, then resync follow-media lengths."""
    m = _mods()
    output = m.editdoc.output_rel(name)
    doc, _sha = m.editdoc.load(project, name)
    rels = [output] + [s["rel"] for s in doc["sources"]]
    remembered = remembered_target(project, name)
    if scene is None:
        if remembered:
            scene, slot = remembered["scene"], slot or remembered.get("slot")
        else:
            candidates = sorted({(u["index"], u["scene"]) for u in m.repoint.usages(project, rels) if u["repointable"]})
            if len(candidates) != 1:
                shown = ", ".join(s for _i, s in candidates) or "no scene"
                raise _kb_error(f"which scene should play {output}? {shown} shows its media; pass --scene S [--slot P]", EXIT_ENV)
            scene = str(candidates[0][0])
    if slot is None:
        base, target = m.repoint.pick_slot(project, scene, rels)
        slot = m.repoint.slot_ref(base, target)
    result = m.repoint.apply(project, scene, slot, output, force=force, dry_run=dry_run)
    out: Dict[str, Any] = {"repoint": result, "follow": None, "durations": []}
    if follow and not dry_run:
        out["follow"] = m.repoint.set_follow(project, result["scene"], result["ref"], force=force)
    if durations:
        out["durations"] = m.repoint.resync_durations(project, [output], write=not dry_run)
    return out


def _use_lines(out: Dict[str, Any]) -> List[str]:
    r = out["repoint"]
    lines = []
    if r["changed"]:
        lines.append(f"scene {r['index']} {r['scene']} {r['ref']} now plays {r['to']}" + (f" (was {r['from']})" if r.get("from") and r["from"] != r["to"] else ""))
    else:
        lines.append(f"scene {r['index']} {r['scene']} {r['ref']} already plays {r['to']}")
    if out.get("follow"):
        lines.append(f"scene {r['scene']} length now follows that video ({json.dumps(out['follow'])})")
    for d in out.get("durations") or []:
        lines.append(f"scene {d['index']} {d['scene']} length {fmt_s(d['fromMs'])} -> {fmt_s(d['toMs'])} (follows {', '.join(d['sources'])})")
        for o in d.get("overhang") or []:
            lines.append(f"  warn  {o} is past the new length (left as is; move or delete it with kb doc)")
    return lines


def cmd_render(ctx: Any) -> int:
    import time

    m = _mods()
    project = start(ctx)
    a = ctx.args
    name = m.editdoc.check_name(a.name)
    guard_worktree(project)
    m.appcli.caps()
    warnings: List[str] = []
    warn = warnings.append
    doc, sha = m.editdoc.load(project, name)
    errors = m.editdoc.errors_of(m.editdoc.static_issues(doc, name, project))
    if errors:
        raise _kb_error(f"nothing rendered: edits/{name}.json has {len(errors)} error(s): " + "; ".join(e["message"] for e in errors))
    progress = Progress(ctx.json)
    if a.draft:
        out_path = m.cache.draft_path(project, name)
        done = m.appcli.render(project, doc=doc, out=str(out_path), draft=True, software=a.software, on_event=progress, timeout=a.timeout)
        if ctx.json:
            _json({"name": name, "draft": True, "path": done.get("path") or str(out_path), "done": done})
        else:
            _emit(f"draft {done.get('path') or out_path}: {done.get('frames')} frames, {fmt_s(done.get('durationMs'))}, {done.get('width')}x{done.get('height')} (half size, not in assets/)")
            _emit(f"next: Read frames of it with kb video frames {name} --render, or render for real: kb video render {name}")
        return EXIT_OK
    output = m.editdoc.output_rel(name)
    wait = a.wait
    started = time.monotonic()
    with m.editdoc.edit_lock(project, name, "kb video render", wait):
        _wait_for_export(project, output, wait)
        doc, sha = m.editdoc.load(project, name)
        report = m.appcli.validate(project, name=name)
        if not report.get("ok", True):
            msgs = "; ".join(str(e.get("message") if isinstance(e, dict) else e) for e in report.get("errors") or [])
            raise _kb_error(f"nothing rendered: the app's check of edits/{name}.json failed: {msgs}")
        expected = report.get("totalFrames")
        done = m.appcli.render(project, name=name, software=a.software, expect_hash=sha, on_event=progress, timeout=a.timeout)
    # The app counts the encoded frames before it replaces the old render, so a mismatch here means the plan changed.
    frames = done.get("frames")
    if isinstance(expected, int) and isinstance(frames, int) and frames != expected:
        raise _kb_error(f"{output} has {frames} frames but the checked timeline had {expected}; rerun kb video render {name}")
    notified = notify_media(project, [output], name, warn)
    used = None
    if a.use or a.scene is not None:
        if not getattr(a, "dry_run", False):
            saved = checkpoint_before(project, f"kb video use {name}")
            if saved:
                warn(f"checkpoint {saved} holds the scene before the re-point (kb undo {saved})")
        used = _use(project, name, a.scene, a.slot, force=a.force, follow=False, durations=True, warn=warn)
        durations = used["durations"]
    else:
        durations = m.repoint.resync_durations(project, [output])
    elapsed = time.monotonic() - started
    if ctx.json:
        _json({"name": name, "output": output, "done": done, "expectedFrames": expected, "app": notified, "use": used, "durations": durations, "warnings": warnings, "elapsedS": round(elapsed, 2)})
        return EXIT_OK
    _emit(f"rendered {output}: {frames} frames, {fmt_s(done.get('durationMs'))}, {done.get('width')}x{done.get('height')} at {done.get('fps')} fps ({done.get('lane')} lane, {elapsed:.1f} s)")
    if notified is not None:
        _emit("the app refreshed its copy" + (" (deferred until its export ends)" if notified.get("deferred") else ""))
    if used is not None:
        for line in _use_lines(used):
            _emit(line)
    else:
        for d in durations:
            _emit(f"scene {d['index']} {d['scene']} length {fmt_s(d['fromMs'])} -> {fmt_s(d['toMs'])} (follows {output})")
            for o in d.get("overhang") or []:
                _emit(f"  warn  {o} is past the new length (left as is)")
    for w in warnings:
        _emit(f"note: {w}")
    scenes = sorted({u["scene"] for u in _used_by(project, [output])})
    _emit(f"next: kb capture --scene {scenes[0]} and Read the PNG" if scenes else f"next: kb video use {name} --scene S (point a scene at it)")
    return EXIT_OK


def cmd_use(ctx: Any) -> int:
    m = _mods()
    project = start(ctx)
    a = ctx.args
    name = m.editdoc.check_name(a.name)
    guard_worktree(project)
    output = m.editdoc.output_rel(name)
    if not (project.root / output).is_file():
        raise _kb_error(f"{output} is not rendered yet; kb video render {name} first (or kb video render {name} --use)")
    warnings: List[str] = []
    saved = None
    if not a.dry_run:
        saved = checkpoint_before(project, f"kb video use {name}")
    if m.editdoc.render_state(project, name) == "stale":
        warnings.append(f"{output} is older than edits/{name}.json; kb video render {name} brings it up to date")
    out = _use(project, name, a.scene, a.slot, force=a.force, follow=a.follow, durations=not a.no_durations, warn=warnings.append, dry_run=a.dry_run)
    if ctx.json:
        _json(dict(out, warnings=warnings, checkpoint=saved, dryRun=a.dry_run))
        return EXIT_OK
    for line in _use_lines(out):
        _emit(line)
    for w in warnings:
        _emit(f"note: {w}")
    if a.dry_run:
        _emit("dry run: nothing written")
    if saved:
        _emit(f"checkpoint {saved} holds the state before this (kb undo {saved})")
    _emit(f"next: kb check, then kb capture --scene {out['repoint']['scene']} and Read the PNG")
    return EXIT_OK


def cmd_durations(ctx: Any) -> int:
    m = _mods()
    project = start(ctx)
    a = ctx.args
    if a.write:
        guard_worktree(project)
    changes = m.repoint.resync_durations(project, None, write=a.write)
    if ctx.json:
        _json({"written": bool(a.write and changes), "changes": changes})
        return EXIT_OK
    if not changes:
        _emit("every follow-media scene already matches its video")
        return EXIT_OK
    verb = "now" if a.write else "would be"
    for c in changes:
        _emit(f"scene {c['index']} {c['scene']} {verb} {fmt_s(c['toMs'])} (was {fmt_s(c['fromMs'])}; follows {', '.join(c['sources'])})")
        for o in c.get("overhang") or []:
            _emit(f"  warn  {o} is past the new length (left as is)")
    if not a.write:
        _emit("next: kb video durations --write")
    return EXIT_OK


def cmd_open(ctx: Any) -> int:
    m = _mods()
    from .. import bridge

    project = start(ctx)
    a = ctx.args
    name = m.editdoc.check_name(a.name)
    m.editdoc.load(project, name)
    body: Dict[str, Any] = {"project": project.project_id, "projectPath": str(project.root.resolve()), "name": name}
    if a.scene is not None:
        idx, _stem = project.resolve(a.scene)
        body["scene"] = idx
    resp = bridge.require_ok(bridge.request("openEdit", body, a.timeout, "kb video open"), "openEdit")
    if ctx.json:
        _json(resp)
        return EXIT_OK
    _emit(f"the editor window shows {name} ({resp.get('opened') or 'opened'})" + ("" if resp.get("projectOpen", True) else f"; {project.project_id} is not the open project"))
    _emit(f"edits you make there save to edits/{name}.json; kb video show {name} reads them")
    return EXIT_OK


# ── parser ────────────────────────────────────────────────────────────────────


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any, extensions: bool = True) -> argparse.ArgumentParser:
    """Adds `kb video ...` to kb's top-level subparsers (with the extensions' commands unless told not to); returns the video parser."""
    video = sub.add_parser("video", help="edit screen recordings: cut, speed, freeze, taps, masks, render and use in a scene", description=VIDEO_HELP, formatter_class=Formatter, parents=[common])
    vs = video.add_subparsers(dest="vop", metavar="COMMAND")
    vs.required = True

    mutating = argparse.ArgumentParser(add_help=False)
    mutating.add_argument("--dry-run", action="store_true", help="print the resulting timeline, write nothing")
    mutating.add_argument("--base", metavar="HASH", help="refuse if edits/NAME.json no longer has this hash")
    mutating.add_argument("--wait", type=float, nargs="?", const=600.0, default=None, metavar="SECONDS", help="wait for another kb command holding this edit (default 10 s)")

    def cmd(parent: Any, name: str, help_: str, fn: Callable[[Any], int], epilog: Optional[str] = None, mutates: bool = False, aliases: Tuple[str, ...] = ()) -> argparse.ArgumentParser:
        parents = [common, mutating] if mutates else [common]
        p = parent.add_parser(name, help=help_, description=help_, epilog=epilog, formatter_class=Formatter, parents=parents, aliases=list(aliases))
        p.set_defaults(fn=fn)
        return p

    def at_src(p: argparse.ArgumentParser, required: bool = False) -> None:
        g = p.add_mutually_exclusive_group(required=required)
        g.add_argument("--at", metavar="T", help="timeline time (the edited video): 2.5, 2500ms, 1:02.5, f150, end")
        g.add_argument("--src", metavar="[SID@]T", help="source time, e.g. 4.2 or s2@4.2")

    p = cmd(vs, "list", "edits in this project: length, clips, render state and which scenes play them", cmd_list)
    p = cmd(vs, "show", "an edit's timeline: clips, sources, taps, masks, render state and users", cmd_show, epilog="  kb video show demo\n  kb video show demo --at 4.5        what is on screen at 4.5 s")
    at_src(p)
    p.add_argument("name", metavar="NAME")
    p = cmd(vs, "map", "map a moment between clocks: timeline, source, scene and project time", cmd_map,
            epilog="  kb video map demo --at 3.2                 timeline -> source, scene, project\n"
            "  kb video map demo --src s1@12.5            where a source moment plays\n"
            "  kb video map demo --tap t1                 when a tap shows\n"
            "  kb video map demo --scene-at 2 --scene 03  scene-local time -> timeline")
    p.add_argument("name", metavar="NAME")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--at", metavar="T")
    g.add_argument("--src", metavar="[SID@]T")
    g.add_argument("--tap", metavar="ID")
    g.add_argument("--scene-at", dest="scene_at", metavar="T")
    p.add_argument("--scene", metavar="S", help="the scene that plays the edit (default: the only one)")
    p.add_argument("--slot", metavar="P", help="the slot in that scene (default: picked)")
    p = cmd(vs, "usages", "which scene slots play an edit's render or source, or an asset (all edits when omitted)", cmd_usages)
    p.add_argument("target", nargs="?", metavar="NAME|ASSET")
    p = cmd(vs, "validate", "the app's own check of an edit (frames, ranges, masks), plus missing files", cmd_validate)
    p.add_argument("name", metavar="NAME")
    cmd(vs, "caps", "the app's edit CLI: where it is, its version, ffmpeg, tap and mask vocabularies", cmd_caps)

    p = cmd(vs, "new", "start (or reopen) the edit of a recording: assets/ path, outside file, or --for a scene slot", cmd_new,
            epilog="  kb video new assets/rec.mp4\n  kb video new ~/Desktop/rec.mov             copied into assets/ first\n"
            "  kb video new --for 03-demo:device:phone     edit what that slot plays (render --use goes back there)\n"
            "  kb video new assets/rec-edited.mp4          reopens edits/rec.json\n"
            "The name is the file stem (slugified); a different recording with the same stem needs --name.")
    p.add_argument("src", nargs="?", metavar="SRC")
    p.add_argument("--name", metavar="N", help="edit name (letters, digits, - and _)")
    p.add_argument("--for", dest="for_", metavar="SCENE[:SLOT[:ID]]", help="the scene slot this edit is for")
    p.add_argument("--fresh", action="store_true", help="start over from the source (the old doc is kept as .json.bak)")
    p = cmd(vs, "reset", "rebuild an edit from its source, discarding its changes (kept as .json.bak)", cmd_reset)
    p.add_argument("name", metavar="NAME")
    p.add_argument("--yes", action="store_true", help="confirm")
    p.add_argument("--source", metavar="REL", help="the source to rebuild from when the doc is unreadable")
    p.add_argument("--wait", type=float, nargs="?", const=600.0, default=None, metavar="SECONDS")

    p = cmd(vs, "split", "split the clip under each time (two halves, nothing removed)", cmd_split, mutates=True, epilog="  kb video split demo --at 2.5 --at 7")
    p.add_argument("name", metavar="NAME")
    p.add_argument("--at", action="append", required=True, metavar="T")
    p = cmd(vs, "cut", "remove timeline ranges (as the edit plays now), or source ranges with --src", cmd_cut, mutates=True,
            epilog="  kb video cut demo 0-1.2 8.5-end         timeline ranges\n  kb video cut demo --src s1:30-42        a source range, every copy of it")
    p.add_argument("name", metavar="NAME")
    p.add_argument("ranges", nargs="+", metavar="A-B")
    p.add_argument("--src", action="store_true", help="the ranges are source time ([SID:]A-B)")
    p = cmd(vs, "keep", "keep only these source ranges (optionally sped up), cutting the rest", cmd_keep, mutates=True,
            epilog="  kb video keep demo 2-9 14-20@2x        source seconds; @2x speeds that range up")
    p.add_argument("name", metavar="NAME")
    p.add_argument("ranges", nargs="+", metavar="[SID:]A-B[@Nx]")
    p = cmd(vs, "trim", "move a clip's in or out point (source time), or shave its head or tail (timeline)", cmd_trim, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("clip", metavar="CLIP")
    p.add_argument("--in", dest="in_", metavar="T", help="new in-point, source time")
    p.add_argument("--out", metavar="T", help="new out-point, source time (end = the source's end)")
    p.add_argument("--head", metavar="D", help="trim D of timeline off the start")
    p.add_argument("--tail", metavar="D", help="trim D of timeline off the end")
    p = cmd(vs, "speed", "set a clip's speed, or speed up a timeline/source range", cmd_speed, mutates=True,
            epilog="  kb video speed demo c2 2\n  kb video speed demo --range 4-9 1.5\n  kb video speed demo --src-range s1:10-20 3")
    p.add_argument("name", metavar="NAME")
    p.add_argument("rest", nargs="+", metavar="CLIP X")
    p.add_argument("--range", metavar="A-B", help="a timeline range instead of a clip")
    p.add_argument("--src-range", dest="src_range", metavar="[SID:]A-B", help="a source range instead of a clip")
    p = cmd(vs, "freeze", "hold the frame at a moment (default 2 s; --at end holds the last frame)", cmd_freeze, mutates=True)
    p.add_argument("name", metavar="NAME")
    at_src(p, required=True)
    p.add_argument("--hold", metavar="D", help="hold length (default 2s)")
    p = cmd(vs, "hold", "retime a freeze or still clip", cmd_hold, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("clip", metavar="CLIP")
    p.add_argument("duration", metavar="D")
    p = cmd(vs, "remove", "remove clips", cmd_remove, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("clips", nargs="+", metavar="CLIP")
    p = cmd(vs, "move", "reorder a clip", cmd_move, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("clip", metavar="CLIP")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--to", type=int, metavar="N")
    g.add_argument("--before", metavar="CLIP")
    g.add_argument("--after", metavar="CLIP")
    p = cmd(vs, "insert", "splice a video or still in at a time (splitting the clip there), at an index, or at the end", cmd_insert, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("media", metavar="MEDIA")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--at", metavar="T")
    g.add_argument("--index", type=int, metavar="N")
    g.add_argument("--end", action="store_true")
    p.add_argument("--hold", metavar="D", help="for a still: how long it shows (default 2s)")
    p = cmd(vs, "append", "add a video or still as the last clip", cmd_append, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("media", metavar="MEDIA")
    p.add_argument("--hold", metavar="D", help="for a still: how long it shows (default 2s)")

    tap = vs.add_parser("tap", help="tap highlights: add, move, retime, remove, style, list", description="tap highlights: a glow dot at a moment, in source pixels", formatter_class=Formatter, parents=[common])
    ts = tap.add_subparsers(dest="tap_op", metavar="OP")
    ts.required = True
    p = cmd(ts, "add", "add a tap at a moment and spot on the source frame", cmd_tap, mutates=True, epilog="  kb video tap add demo --at 3.1 --pos 0.52,0.81\n  kb video tap add demo --src 12.4 --px 640,1210")
    p.add_argument("name", metavar="NAME")
    at_src(p, required=True)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--pos", metavar="X,Y", help="0..1 across the source frame")
    g.add_argument("--px", metavar="X,Y", help="source pixels")
    p = cmd(ts, "move", "move a tap's spot", cmd_tap, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("taps", nargs=1, metavar="TAP")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--pos", metavar="X,Y")
    g.add_argument("--px", metavar="X,Y")
    p = cmd(ts, "retime", "move a tap to another moment", cmd_tap, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("taps", nargs=1, metavar="TAP")
    at_src(p, required=True)
    p = cmd(ts, "remove", "remove taps", cmd_tap, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("taps", nargs="+", metavar="TAP")
    p = cmd(ts, "style", "the edit's tap look: shape, colour, size", cmd_tap, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("--style", metavar="S")
    p.add_argument("--colour", "--color", dest="colour", metavar="C")
    p.add_argument("--size", type=float, metavar="N")
    p = cmd(ts, "list", "taps with when they show", cmd_tap)
    p.add_argument("name", metavar="NAME")

    mask = vs.add_parser("mask", help="privacy masks: add, key, hold, unkey, offset, set, span, remove, list", description="privacy masks: a box hiding part of the source over a source span", formatter_class=Formatter, parents=[common])
    ms = mask.add_subparsers(dest="mask_op", metavar="OP")
    ms.required = True

    def box(p: argparse.ArgumentParser, required: bool = True) -> None:
        g = p.add_mutually_exclusive_group(required=required)
        g.add_argument("--rect", metavar="X,Y,W,H", help="0..1 across the source frame")
        g.add_argument("--rect-px", dest="rect_px", metavar="X,Y,W,H", help="source pixels")
        g.add_argument("--pos", metavar="X,Y", help="a default-sized box centred here")

    def scene_end(p: argparse.ArgumentParser, group: Any = None) -> None:
        (group or p).add_argument("--until-scene", dest="until_scene", metavar="T", help="end where scene S shows this edit at scene time T (through the slot's delay, inMs and speed)")
        p.add_argument("--scene", metavar="S", help="with --until-scene: the scene that plays the edit")
        p.add_argument("--slot", metavar="P", help="with --until-scene: the slot in that scene (default: the one showing this edit)")

    def fades(p: argparse.ArgumentParser) -> None:
        p.add_argument("--fade-in", dest="fade_in", metavar="D", help="fade in over this much source time from the start (0 or none: a hard edge)")
        p.add_argument("--fade-out", dest="fade_out", metavar="D", help="fade out over this much source time before the end")

    def span(p: argparse.ArgumentParser, with_span: bool) -> None:
        ends = p.add_mutually_exclusive_group()
        ends.add_argument("--until", metavar="T", help="end at this timeline time")
        scene_end(p, ends)
        if with_span:
            p.add_argument("--span", metavar="D", help="cover this much timeline (default 3s)")
        else:
            p.add_argument("--from", dest="from_", metavar="T", help="start at this timeline time")
        p.add_argument("--src-start", dest="src_start", metavar="[SID@]T", help="start at this source time")
        p.add_argument("--src-end", dest="src_end", metavar="[SID@]T", help="end at this source time")

    p = cmd(ms, "add", "add a mask from a moment (solid black, 3 s of timeline unless told otherwise)", cmd_mask, mutates=True,
            epilog="  kb video mask add demo --at 0 --rect 0.1,0.05,0.5,0.06 --until 5\n  kb video mask add demo --src 3 --rect-px 40,120,600,80 --style blur --strength 0.6\n"
            "  kb video mask add demo --at 0 --rect 0.1,0.05,0.5,0.06 --until-scene 2.4 --scene 03-demo --fade-out 0.3")
    p.add_argument("name", metavar="NAME")
    at_src(p, required=True)
    box(p)
    p.add_argument("--style", choices=["solid", "blur", "pixelate"])
    p.add_argument("--strength", metavar="0..1")
    p.add_argument("--colour", "--color", dest="colour", metavar="#RRGGBB")
    span(p, with_span=True)
    fades(p)
    p = cmd(ms, "key", "set the box at a moment (auto-key: replaces a key there or adds one)", cmd_mask, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("masks", nargs=1, metavar="MASK")
    at_src(p, required=True)
    box(p)
    p = cmd(ms, "hold", "pin the box where it is at a moment, so later keys only move what follows", cmd_mask, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("masks", nargs=1, metavar="MASK")
    at_src(p, required=True)
    p = cmd(ms, "unkey", "remove the key at a moment (a mask keeps its last key)", cmd_mask, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("masks", nargs=1, metavar="MASK")
    at_src(p, required=True)
    p = cmd(ms, "offset", "shift every key of a mask (kept inside the frame)", cmd_mask, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("masks", nargs=1, metavar="MASK")
    p.add_argument("--by", metavar="DX,DY", required=True)
    p.add_argument("--px", action="store_true", help="--by is in source pixels")
    p = cmd(ms, "set", "a mask's look: style, strength, colour (none resets), fades, and its end at a scene time", cmd_mask, mutates=True,
            epilog="  kb video mask set demo m1 --fade-in 0.2 --fade-out 0.4\n  kb video mask set demo m1 --until-scene 3.5 --scene 03-demo --slot device:phone")
    p.add_argument("name", metavar="NAME")
    p.add_argument("masks", nargs=1, metavar="MASK")
    p.add_argument("--style", choices=["solid", "blur", "pixelate"])
    p.add_argument("--strength", metavar="0..1|none")
    p.add_argument("--colour", "--color", dest="colour", metavar="#RRGGBB|none")
    fades(p)
    scene_end(p)
    p = cmd(ms, "span", "move a mask's start or end", cmd_mask, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("masks", nargs=1, metavar="MASK")
    span(p, with_span=False)
    p = cmd(ms, "remove", "remove masks", cmd_mask, mutates=True)
    p.add_argument("name", metavar="NAME")
    p.add_argument("masks", nargs="+", metavar="MASK")
    p = cmd(ms, "list", "masks with their keys and when they show", cmd_mask)
    p.add_argument("name", metavar="NAME")

    p = cmd(vs, "crop", "a clip's static crop: a box of its source, letterboxed into the output (replaces any zoom keys)", cmd_crop, mutates=True,
            epilog="  kb video crop demo c1 --rect 0.1,0.2,0.8,0.5       0..1 across the source frame\n"
            "  kb video crop demo c1 --aspect 9:16 --centre 0.5,0.4  the largest 9:16 box, centred there\n"
            "  kb video crop demo c1 --clear                        the whole frame again (clears zoom keys too)\n"
            "Boxes snap to even source pixels. Needs an app whose edit CLI writes document version 3.")
    p.add_argument("name", metavar="NAME")
    p.add_argument("clip", metavar="CLIP")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--rect", metavar="X,Y,W,H", help="0..1 across the source frame")
    g.add_argument("--aspect", metavar="W:H", help="the largest box of this shape (e.g. 9:16)")
    g.add_argument("--clear", action="store_true", help="remove the crop (and any zoom keys)")
    p.add_argument("--centre", "--center", dest="centre", metavar="X,Y", help="with --aspect: the box's centre (default 0.5,0.5)")
    p = cmd(vs, "zoom", "a clip's keyed zoom: framing keys that glide between output moments (the crop tool's keys)", cmd_zoom, mutates=True,
            epilog="  kb video zoom demo c1 --at 1.5 --rect 0.2,0.2,0.5,0.5   a key (a new one glides smoothly)\n"
            "  kb video zoom demo c1 --at 1.5 --ease linear             how the key at 1.5 glides to the next\n"
            "  kb video zoom demo c1 --move 1.5 --to 2                  retime a key\n"
            "  kb video zoom demo c1 --remove 2 | --clear\n"
            "Times are timeline times inside CLIP. Boxes take the output's shape and snap to even source pixels.")
    p.add_argument("name", metavar="NAME")
    p.add_argument("clip", metavar="CLIP")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--at", metavar="T", help="set the key at this timeline time (with --rect, --ease or both)")
    g.add_argument("--remove", metavar="T", help="delete the key at this timeline time")
    g.add_argument("--move", metavar="T", help="retime the key at this timeline time (with --to)")
    g.add_argument("--clear", action="store_true", help="remove every zoom key")
    p.add_argument("--rect", metavar="X,Y,W,H", help="the framing, 0..1 across the source frame")
    p.add_argument("--ease", choices=["linear", "smooth"], help="how the key glides into the next (a new key: smooth)")
    p.add_argument("--to", metavar="T2", help="with --move: the new timeline time")

    p = cmd(vs, "apply", "run a JSON plan of edit ops all or nothing", cmd_apply, mutates=True,
            epilog='  kb video apply demo \'[{"op": "split", "atMs": 2500}, {"op": "setSpeed", "clipId": "c2", "speed": 2}]\'\n'
            "  kb video apply demo @plan.json\n"
            '  {"baseHash": "<sha>", "ops": [{"op": "addMask", "atMs": 0, "rect": [0.1, 0.1, 0.4, 0.1], "as": "m"},\n'
            '                               {"op": "retimeMaskEdge", "maskId": "$m", "edge": "end", "sourceMs": 5000}]}\n'
            "Ops: the editor's own (addClip insertClip split freeze removeClip moveClip setSpeed trimIn trimOut setHold\n"
            "setClipCrop setZoomKey removeZoomKey setZoomKeyEase moveZoomKey addTap addTapAtSource moveTap retimeTap\n"
            "removeTap setTapLook addMask setMaskRect offsetMask addMaskKey removeMaskKey retimeMaskEdge setMaskLook\n"
            "setMaskFade removeMask) plus cutSource, speedSource and keep (source ms).")
    p.add_argument("name", metavar="NAME")
    p.add_argument("plan", metavar="PLAN|@file|-")

    p = cmd(vs, "render", "render assets/NAME-edited.mp4 with the app's encoder; --use points a scene at it", cmd_render,
            epilog="  kb video render demo\n  kb video render demo --use --scene 03-demo --slot device:phone\n"
            "  kb video render demo --draft            half-size review copy outside assets/\n"
            "Long renders: run in the background, or --draft first. The app refreshes its copy when it runs.")
    p.add_argument("name", metavar="NAME")
    p.add_argument("--use", action="store_true", help="then point a scene slot at the render (and resync its length)")
    p.add_argument("--scene", metavar="S")
    p.add_argument("--slot", metavar="P")
    p.add_argument("--force", action="store_true", help="re-point even if the sidecar check finds new errors")
    p.add_argument("--software", action="store_true", help="skip the hardware encoder")
    p.add_argument("--draft", action="store_true", help="a quick half-size review copy in the scratch folder")
    p.add_argument("--wait", type=float, nargs="?", const=1800.0, default=None, metavar="SECONDS", help="wait for an export or another kb command instead of refusing")
    p.add_argument("--timeout", type=float, default=None, metavar="SECONDS", help="stop the render after this long (default 3600)")
    p = cmd(vs, "use", "point a scene slot at an edit's render (and resync follow-media lengths)", cmd_use,
            epilog="  kb video use demo --scene 03-demo\n  kb video use demo --scene 03-demo --slot media:vid1 --follow")
    p.add_argument("name", metavar="NAME")
    p.add_argument("--scene", metavar="S")
    p.add_argument("--slot", metavar="P")
    p.add_argument("--follow", action="store_true", help="make the scene's length follow this video")
    p.add_argument("--no-durations", dest="no_durations", action="store_true", help="leave project.json lengths alone")
    p.add_argument("--force", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p = cmd(vs, "durations", "follow-media scenes whose length no longer matches their video", cmd_durations)
    p.add_argument("--write", action="store_true", help="fix project.json")
    p = cmd(vs, "open", "open the app's editor window on an edit (the app must be running)", cmd_open)
    p.add_argument("name", metavar="NAME")
    p.add_argument("--scene", metavar="S", help="the scene it is for (fills the editor's reference list)")
    p.add_argument("--timeout", type=float, default=30, metavar="SECONDS")

    if extensions:
        for extend in load_extensions():
            extend(vs, common, Formatter)
    return video
