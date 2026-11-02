"""kb flashes: the last flash check at a glance, and accepted warnings (a person's reason, kept in flashes.accepted.json); failures are never accepted (docs/agent-kit.md, "Accepted flash warnings")."""

from __future__ import annotations

import argparse
from typing import Any, Dict, List

from .film import accepts as acc
from .film import flashes as fl
from .film import ranged as rg
from .util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, emit

EPILOG = """\
  ./kb flashes                                   the last flash check and the accepted warnings
  ./kb flashes accept 00:35.4 --why "a slow logo glint, checked by eye"
  ./kb flashes forget 00:35.400                  drop an accepted warning (by its time or id)

accept takes a WARNING from the last check (./kb check film --scene S, ./kb verify, an export)
and stores it with your reason; later checks show it as accepted instead of repeating it. A
FAILURE is never accepted: fix the flash. Time is film seconds or a timecode (35.4, 00:35.4)."""


def last_or_raise(project: Any) -> Dict[str, Any]:
    last = fl.load_last(project)
    if last is None:
        raise KbError("no flash check has run in this project yet", EXIT_ENV, kind="usage",
                      hint="./kb check film --scene S (seconds), or ./kb verify")
    return last


def source_of(last: Dict[str, Any]) -> str:
    if last.get("file"):
        return str(last["file"])
    spans = last.get("spans") or (last.get("report") or {}).get("spans") or []
    return "ranged check of " + ", ".join(str(s.get("label")) for s in spans if isinstance(s, dict)) if spans else str(last.get("source"))


def cmd_flashes(ctx: Any) -> int:
    a = ctx.args
    project = ctx.project
    op = a.op or "list"
    if op == "accept":
        return accept(ctx)
    if op == "forget":
        return forget(ctx)
    accepted = acc.load(project)
    last = fl.load_last(project)
    report = last.get("report") if last else None
    if report is not None:
        acc.apply(report, accepted)
    if ctx.json:
        ctx.out({"accepted": accepted, "last": last}, ok=True)
        return EXIT_OK
    if last:
        emit(f"last check: {source_of(last)}")
        for line in fl.summary_lines(report):
            emit(f"  {line.strip()}")
    else:
        emit("no flash check has run yet (./kb check film --scene S takes seconds)")
    if accepted:
        emit(f"accepted warnings ({acc.FILE}):")
        for e in accepted:
            where = f" in {e.get('scene')} at {(e.get('localMs') or 0) / 1000:.2f}s" if e.get("scene") else ""
            emit(f"  {e.get('id')}  {e.get('tc')}{where}, {e.get('type')} ({e.get('standard')}): {e.get('why')}")
    return EXIT_OK


def accept(ctx: Any) -> int:
    from . import lock

    a = ctx.args
    project = ctx.project
    if not a.time:
        raise KbError("accept needs the warning's time, e.g. ./kb flashes accept 00:35.4 --why \"...\"", EXIT_ENV, kind="usage")
    ms = rg.parse_time(a.time)
    if ms is None:
        raise KbError(f'"{a.time}" is not film seconds or a timecode', EXIT_ENV, kind="usage", hint="use 35.4 or 00:35.4, as the check printed it")
    last = last_or_raise(project)
    rows = acc.new_entries(last["report"], ms, a.why or "", ctx.caller.name, source_of(last))
    if not a.dry_run:
        lock.mutate_json(project, acc.FILE, lambda doc: acc.merged(doc, rows), op="kb flashes accept", caller=ctx.caller, wait=a.wait)
    if ctx.json:
        ctx.out({"accepted": rows, "file": acc.FILE, "dryRun": bool(a.dry_run)}, ok=True)
        return EXIT_OK
    for r in rows:
        emit(f"{'would accept' if a.dry_run else 'accepted'} {r['tc']} ({r['type']}, {r['standard']}) as {r['id']}: {r['why']}")
    return EXIT_OK


def forget(ctx: Any) -> int:
    from . import lock

    a = ctx.args
    if not a.time:
        raise KbError("forget needs an accepted warning's id or time (./kb flashes lists them)", EXIT_ENV, kind="usage")
    key = a.time
    ms = rg.parse_time(key)
    rows: List[Dict[str, Any]] = acc.load(ctx.project)
    # Every entry at that moment (one per standard), so nothing there stays accepted.
    hits = [e for e in rows if e.get("id") == key or e.get("tc") == key
            or (ms is not None and abs(float(e.get("atMs") or 0) - ms) <= acc.PICK_MS)]
    if not hits:
        raise KbError(f"no accepted warning matches {key}", EXIT_PROBLEMS, kind="invalid", hint="./kb flashes lists them")
    ids = [str(h["id"]) for h in hits]
    if not a.dry_run:
        lock.mutate_json(ctx.project, acc.FILE, lambda doc: acc.without(doc, ids), op="kb flashes forget", caller=ctx.caller, wait=a.wait)
    if ctx.json:
        ctx.out({"forgotten": hits, "dryRun": bool(a.dry_run)}, ok=True)
        return EXIT_OK
    for h in hits:
        emit(f"{'would forget' if a.dry_run else 'forgot'} {h.get('tc')} ({h.get('id')}, {h.get('standard')}); the next check warns about it again")
    return EXIT_OK


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """Adds `kb flashes` to kb's top-level subparsers."""
    s = sub.add_parser("flashes", help="the last flash check, and accepted flash warnings (accept, forget)",
                       description="the last flash check at a glance, and warnings a person accepted with a reason",
                       epilog=EPILOG, formatter_class=Formatter, parents=[common])
    s.add_argument("op", nargs="?", choices=["list", "accept", "forget"], help="list (default), accept or forget")
    s.add_argument("time", nargs="?", metavar="TIME", help="the warning's film time (35.4, 00:35.4), or an accepted id for forget")
    s.add_argument("--why", metavar="TEXT", help="accept: why the warning is fine, in a sentence (required)")
    s.add_argument("--dry-run", action="store_true", help="list what this would change; write nothing")
    s.add_argument("--wait", type=float, nargs="?", const=600.0, default=None, metavar="SECONDS", help="wait for another kb write to finish (default 10 s)")
    s.set_defaults(fn=cmd_flashes)
