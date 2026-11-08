"""kb pacing: pacing warnings a person kept, with their reason, in pacing.accepted.json; later checks show them as kept
instead of repeating them (DESIGN.md, "Pacing")."""

from __future__ import annotations

import argparse
from typing import Any, Dict, List

from .film import pacing as pc
from .util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, emit, now_ms

EPILOG = """\
  ./kb pacing                                              the warnings the person kept
  ./kb pacing accept 04-question --why "they want the question to breathe"
  ./kb pacing accept 18-lockup --kind end --why "the logo holds over the song's tail"
  ./kb pacing forget 04-question                           the next check raises it again

The pacing rules are defaults and the person decides. When they keep something
./kb check film pacing warns about, accept it with their reason. It holds per scene and
kind (still, read, short, final-hit, end), every kind when --kind is left out."""


def cmd_pacing(ctx: Any) -> int:
    op = ctx.args.op or "list"
    if op == "accept":
        return accept(ctx)
    if op == "forget":
        return forget(ctx)
    rows = pc.load_accepted(ctx.project)
    if ctx.json:
        ctx.out({"accepted": rows, "file": pc.ACCEPTED_FILE})
        return EXIT_OK
    if not rows:
        emit("no pacing warnings kept (./kb check film pacing lists the open ones)")
        return EXIT_OK
    emit(f"kept pacing warnings ({pc.ACCEPTED_FILE}):")
    for r in rows:
        emit(f"  {r.get('id')}  {r.get('scene')}, {r.get('kind')}: {r.get('why')}")
    return EXIT_OK


def accept(ctx: Any) -> int:
    from . import lock

    a = ctx.args
    if not a.scene:
        raise KbError('accept needs a scene, e.g. ./kb pacing accept 04-question --why "..."', EXIT_ENV, kind="usage")
    why = (a.why or "").strip()
    if not why:
        raise KbError("accept needs the person's reason: --why \"...\"", EXIT_ENV, kind="usage")
    _idx, stem = ctx.project.resolve(a.scene)
    kinds = [a.kind] if a.kind else list(pc.KINDS)
    by = getattr(ctx.caller, "name", None)
    rows: List[Dict[str, Any]] = [{"id": pc.issue_id(k, stem), "kind": k, "scene": stem, "why": why, "by": by, "atMs": now_ms()} for k in kinds]
    if not a.dry_run:
        lock.mutate_json(ctx.project, pc.ACCEPTED_FILE, lambda doc: pc.accepted_merge(doc, rows), op="kb pacing accept", caller=ctx.caller, wait=a.wait)
    if ctx.json:
        ctx.out({"accepted": rows, "file": pc.ACCEPTED_FILE, "dryRun": bool(a.dry_run)})
        return EXIT_OK
    emit(f"{'would keep' if a.dry_run else 'kept'} {stem} ({', '.join(kinds)}): {why}")
    return EXIT_OK


def forget(ctx: Any) -> int:
    from . import lock

    a = ctx.args
    if not a.scene:
        raise KbError("forget needs a scene or an id (./kb pacing lists them)", EXIT_ENV, kind="usage")
    rows = pc.load_accepted(ctx.project)
    hits = [r for r in rows if (r.get("id") == a.scene or r.get("scene") == a.scene) and (not a.kind or r.get("kind") == a.kind)]
    if not hits:
        try:
            _idx, stem = ctx.project.resolve(a.scene)
        except KbError:
            stem = None
        hits = [r for r in rows if stem and r.get("scene") == stem and (not a.kind or r.get("kind") == a.kind)]
    if not hits:
        raise KbError(f"no kept pacing warning matches {a.scene}", EXIT_PROBLEMS, kind="invalid", hint="./kb pacing lists them")
    ids = [str(h["id"]) for h in hits]
    if not a.dry_run:
        lock.mutate_json(ctx.project, pc.ACCEPTED_FILE, lambda doc: pc.accepted_without(doc, ids), op="kb pacing forget", caller=ctx.caller, wait=a.wait)
    if ctx.json:
        ctx.out({"forgotten": hits, "dryRun": bool(a.dry_run)})
        return EXIT_OK
    for h in hits:
        emit(f"{'would forget' if a.dry_run else 'forgot'} {h.get('scene')} ({h.get('kind')}); the next check raises it again")
    return EXIT_OK


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """Adds `kb pacing` to kb's top-level subparsers."""
    s = sub.add_parser("pacing", help="pacing warnings the person kept (accept, forget)",
                       description="pacing warnings a person kept, with their reason; later checks show them as kept",
                       epilog=EPILOG, formatter_class=Formatter, parents=[common])
    s.add_argument("op", nargs="?", choices=["list", "accept", "forget"], help="list (default), accept or forget")
    s.add_argument("scene", nargs="?", metavar="S", help="the scene (index or stem), or a kept id for forget")
    s.add_argument("--kind", choices=list(pc.KINDS), help="one kind of warning (default: every kind)")
    s.add_argument("--why", metavar="TEXT", help="accept: the person's reason, in a sentence (required)")
    s.add_argument("--dry-run", action="store_true", help="list what this would change; write nothing")
    s.add_argument("--wait", type=float, nargs="?", const=600.0, default=None, metavar="SECONDS", help="wait for another kb write to finish (default 10 s)")
    s.set_defaults(fn=cmd_pacing)
