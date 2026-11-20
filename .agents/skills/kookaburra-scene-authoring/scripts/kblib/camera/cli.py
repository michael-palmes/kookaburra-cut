"""`kb check camera` and `kb camera`: the static camera check, and the camera warnings a person kept. Kept warnings live
beside the pacing ones in pacing.accepted.json (their own kinds), so they never travel in a pack and every checkpoint
keeps them."""

from __future__ import annotations

import argparse
from typing import Any, Dict, List, Optional, Sequence

from ..catalog import load_catalog
from ..film import pacing as pc
from ..util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, Report, emit, now_ms
from . import rules
from . import sample as cs

EPILOG = """\
  ./kb camera                                             the camera warnings the person kept
  ./kb camera accept 3f2a91c0 --why "the punch-in on the logo is the point"
  ./kb camera accept 03-glimpses --kind wobble --why "..."
  ./kb camera forget 3f2a91c0                             the next check raises it again

The camera rules are defaults and the person decides. When they keep something ./kb check
camera warns about, accept it with their reason, by the id the check prints beside it, or by
scene (every warning open on it now, or only --kind K)."""

CHECK_HELP = """\
kb check camera [S...] [--json]

Samples every scene's camera the way the app renders it and warns, with an id, a scene and a
time, about what reads as a mistake in motion:
  kick-at-cut   a kick on a scene's first moment while the camera carries on from the last scene
  kick-on-turn  a kick as the camera or a device in view starts turning (2° more than just before)
  sway          what the camera aims at drifting 2% of the frame off its line and back inside
                one move (a smooth spline bending towards another shot's keys), or a move running
                back on itself
  wobble        three or more jump cuts of one subject swinging to either side of it in turn
  climb         a push that tilts as it goes in, sliding the background 3% of the frame
  focus         a numeric focus, where a key sets it, whose sharp band reaches neither the aim nor
                any device in view
./kb check and ./kb verify carry the same warnings for the scenes they check. Warnings never fail
a check. Keep one the person wants: ./kb camera accept ID --why "..."."""


def scene_boxes() -> Dict[str, tuple]:
    """Each catalogue device's body: width, height and depth in fitted units."""
    out: Dict[str, tuple] = {}
    for d in load_catalog().entries("devices") or []:
        w, h = d.get("layoutWidth"), d.get("fittedHeight")
        if not (cs.finite(w) and cs.finite(h)):
            continue
        z = (d.get("screen") or {}).get("z") if isinstance(d.get("screen"), dict) else None
        depth = h if d.get("form") == "laptop" else (2 * abs(z) if cs.finite(z) else rules.DEFAULT_BOX[2])
        out[str(d["id"])] = (float(w), float(h), float(depth))
    return out


def widest_aspect(manifest: Dict[str, Any]) -> float:
    best = 16 / 9
    for f in manifest.get("formats") or []:
        if isinstance(f, str) and ":" in f:
            a, _, b = f.partition(":")
            try:
                best = max(best, float(a) / float(b))
            except (ValueError, ZeroDivisionError):
                continue
    return best


def load_scenes(project: Any) -> List[rules.Scene]:
    from ..beats.model import project_music
    from ..film import timeline as tl

    manifest = project.manifest()
    slots = tl.project_slots(project)
    docs: List[Optional[Dict[str, Any]]] = []
    for slot in slots:
        try:
            docs.append(project.load_sidecar(slot.get("stem") or ""))
        except KbError:
            docs.append(None)
    tracks = cs.scene_tracks(docs, project_music(manifest), [float(s["startMs"]) for s in slots])
    boxes, aspect = scene_boxes(), widest_aspect(manifest)
    return [rules.Scene(n, slot, doc, track, boxes, aspect) for n, (slot, doc, track) in enumerate(zip(slots, docs, tracks))]


def load_accepted(project: Any) -> List[Dict[str, Any]]:
    import json

    try:
        doc = json.loads((project.root / pc.ACCEPTED_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rows = doc.get("accepted") if isinstance(doc, dict) else None
    return [r for r in rows or [] if isinstance(r, dict) and r.get("kind") in rules.KINDS and isinstance(r.get("why"), str)]


def run(project: Any, only: Optional[Sequence[str]] = None) -> Dict[str, Any]:
    return rules.check(load_scenes(project), load_accepted(project), only)


def into_report(project: Any, report: Report, stems: Optional[Sequence[str]] = None) -> None:
    """kb check's camera pass: each open warning on its scene's sidecar; a broken pass is a note, never a failure."""
    try:
        result = run(project, stems)
    except Exception as e:  # noqa: BLE001 - a taste check must never break the static check
        report.info("project.json", "", f"camera check skipped ({type(e).__name__}); ./kb check camera runs it alone")
        return
    for issue in result["issues"]:
        report.warn(f"scenes/{issue['scene']}.json", f"camera {issue['kind']} {issue['id']}",
                    message_of(issue) + ' (keep it: ./kb camera accept ' + issue["id"] + ' --why "...")')


def message_of(issue: Dict[str, Any]) -> str:
    scene = str(issue.get("scene") or "")
    text = issue["message"]
    return text[len(scene) + 1:] if scene and text.startswith(scene + " ") else text


def check_camera(ctx: Any, rest: List[str]) -> int:
    if "-h" in rest or "--help" in rest:
        emit(CHECK_HELP)
        return EXIT_OK
    flags = [r for r in rest if r.startswith("-")]
    if flags or getattr(ctx.args, "app", False) or getattr(ctx.args, "render", False):
        raise KbError(f"kb check camera takes scenes, not {(flags or ['--app'])[0]}; it is static", EXIT_ENV, kind="usage",
                      hint="./kb check camera [S...] [--json]")
    project = ctx.project
    only = [project.resolve(s)[1] for s in rest] if rest else None
    result = run(project, only)
    if ctx.json:
        ctx.out({k: result[k] for k in ("issues", "accepted", "scenes", "checked")})
        return EXIT_OK
    head = f"camera: {result['checked']} of {result['scenes']} scenes keyed"
    emit(head + (f", {len(result['issues'])} warning{'s' if len(result['issues']) != 1 else ''}" if result["issues"] else ", nothing to flag"))
    for issue in result["issues"]:
        emit(f"  warn  {issue['id']}  {issue['scene']}, {issue['kind']}: {message_of(issue)}")
    if result["issues"]:
        emit('  to keep one the person wants: ./kb camera accept ID --why "..."')
    if result["accepted"]:
        emit(f"  {len(result['accepted'])} kept by the person (./kb camera lists them)")
    return EXIT_OK


# ── kb camera ────────────────────────────────────────────────────────────────


def cmd_camera(ctx: Any) -> int:
    op = ctx.args.op or "list"
    if op == "accept":
        return accept(ctx)
    if op == "forget":
        return forget(ctx)
    rows = load_accepted(ctx.project)
    if ctx.json:
        ctx.out({"accepted": rows, "file": pc.ACCEPTED_FILE})
        return EXIT_OK
    if not rows:
        emit("no camera warnings kept (./kb check camera lists the open ones)")
        return EXIT_OK
    emit(f"kept camera warnings ({pc.ACCEPTED_FILE}):")
    for r in rows:
        emit(f"  {r.get('id')}  {r.get('scene')}, {r.get('kind')}: {r.get('why')}")
    return EXIT_OK


def accept(ctx: Any) -> int:
    from .. import lock

    a = ctx.args
    if not a.target:
        raise KbError('accept needs a warning id or a scene, e.g. ./kb camera accept 3f2a91c0 --why "..."', EXIT_ENV, kind="usage")
    why = (a.why or "").strip()
    if not why:
        raise KbError("accept needs the person's reason: --why \"...\"", EXIT_ENV, kind="usage")
    result = run(ctx.project)
    every = result["issues"] + result["accepted"]
    picked = [i for i in every if i["id"] == a.target]
    if picked:
        if a.kind and picked[0]["kind"] != a.kind:
            raise KbError(f"{a.target} is the {picked[0]['kind']} warning on {picked[0]['scene']}, not {a.kind}; drop --kind", EXIT_ENV, kind="usage")
    else:
        try:
            _idx, stem = ctx.project.resolve(a.target)
        except KbError:
            if not pc.looks_like_id(a.target):
                raise
            raise KbError(f"no scene or open camera warning has the id {a.target}", EXIT_PROBLEMS, kind="invalid",
                          hint="./kb check camera prints each open warning's id") from None
        picked = [i for i in result["issues"] if i["scene"] == stem and (not a.kind or i["kind"] == a.kind)]
        if not picked:
            what = f" {a.kind}" if a.kind else ""
            raise KbError(f"no open{what} camera warning on {stem}", EXIT_PROBLEMS, kind="invalid", hint="./kb check camera lists the open ones")
    by = getattr(ctx.caller, "name", None)
    rows = [{"id": i["id"], "kind": i["kind"], "scene": i["scene"], "anchor": i["anchor"], "why": why, "by": by, "atMs": now_ms()} for i in picked]
    if not a.dry_run:
        lock.mutate_json(ctx.project, pc.ACCEPTED_FILE, lambda doc: pc.accepted_merge(doc, rows), op="kb camera accept", caller=ctx.caller, wait=a.wait)
    if ctx.json:
        ctx.out({"accepted": rows, "file": pc.ACCEPTED_FILE, "dryRun": bool(a.dry_run)})
        return EXIT_OK
    for r in rows:
        emit(f"{'would keep' if a.dry_run else 'kept'} {r['id']} ({r['scene']}, {r['kind']}): {why}")
    return EXIT_OK


def forget(ctx: Any) -> int:
    from .. import lock

    a = ctx.args
    if not a.target:
        raise KbError("forget needs a warning id or a scene (./kb camera lists them)", EXIT_ENV, kind="usage")
    rows = load_accepted(ctx.project)
    hits = [r for r in rows if r.get("id") == a.target and (not a.kind or r.get("kind") == a.kind)]
    if not hits:
        try:
            _idx, stem = ctx.project.resolve(a.target)
        except KbError:
            stem = None
        hits = [r for r in rows if stem and r.get("scene") == stem and (not a.kind or r.get("kind") == a.kind)]
    if not hits:
        raise KbError(f"no kept camera warning matches {a.target}", EXIT_PROBLEMS, kind="invalid", hint="./kb camera lists them")
    ids = [str(h["id"]) for h in hits]
    if not a.dry_run:
        lock.mutate_json(ctx.project, pc.ACCEPTED_FILE, lambda doc: pc.accepted_without(doc, ids), op="kb camera forget", caller=ctx.caller, wait=a.wait)
    if ctx.json:
        ctx.out({"forgotten": hits, "dryRun": bool(a.dry_run)})
        return EXIT_OK
    for h in hits:
        emit(f"{'would forget' if a.dry_run else 'forgot'} {h.get('id')} ({h.get('scene')}, {h.get('kind')}); the next check raises it again")
    return EXIT_OK


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """Adds `kb camera` to kb's top-level subparsers (`kb check camera` dispatches to `check_camera`)."""
    s = sub.add_parser("camera", help="camera warnings the person kept (accept, forget)",
                       description="camera warnings a person kept, with their reason; later checks show them as kept",
                       epilog=EPILOG, formatter_class=Formatter, parents=[common])
    s.add_argument("op", nargs="?", choices=["list", "accept", "forget"], help="list (default), accept or forget")
    s.add_argument("target", nargs="?", metavar="ID|S", help="a warning's id as the check prints it, or a scene (index or stem)")
    s.add_argument("--kind", choices=list(rules.KINDS), help="one kind of warning (default: every one open on the scene)")
    s.add_argument("--why", metavar="TEXT", help="accept: the person's reason, in a sentence (required)")
    s.add_argument("--dry-run", action="store_true", help="list what this would change; write nothing")
    s.add_argument("--wait", type=float, nargs="?", const=600.0, default=None, metavar="SECONDS", help="wait for another kb write to finish (default 10 s)")
    s.set_defaults(fn=cmd_camera)
