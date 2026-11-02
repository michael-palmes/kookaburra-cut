"""kb plan <command ...>: what a structural command would write, refuse and note, from its own dry run; nothing is written."""

from __future__ import annotations

import argparse
import contextlib
import io
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import lock as lockmod
from .util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, emit, set_command

PLANNABLE = (
    "scene add", "scene duplicate", "scene move", "scene remove", "scene set",
    "doc set", "doc unset", "doc merge", "project set", "project unset", "project fit", "theme set",
    "assets add", "assets conform", "assets replace", "assets unused", "assets restore", "assets meta", "checkpoint", "undo", "lease",
)
# A dry run that fails with one of these exit-1 kinds is a refusal the plan reports, not a failure of the plan.
REFUSAL_KINDS = ("leased", "others-changed", "invalid", "conflict")
REFUSAL_FIELDS = ("holder", "untilMs", "scene", "file", "issues", "files", "by")

EPILOG = """\
Runs the command with --dry-run --json and reports what it would do; nothing is written,
committed or leased. Covers scene add, duplicate, move, remove and set; doc set, unset and
merge; project set, unset and fit; theme set; assets add, conform, replace, unused, restore and
meta; checkpoint; undo; lease.

  ./kb plan scene add pricing --preset title --after 02-hero
  ./kb plan doc 03-pricing set textStyle.titleFont "Inter@600"
  ./kb plan undo --scene 03-pricing
  ./kb plan lease 03-pricing --agent alpha

writes: [{ path, action: create | modify | trash | delete, base, refusal? }], refusals, notes.
Exit 0 when nothing would be refused, 1 when something would be (a lease, another agent's
files, a write that would add errors), 2 for a command plan does not cover."""


def usage(message: str) -> KbError:
    return KbError(message, EXIT_ENV, kind="usage", hint="./kb plan --help lists the commands it covers")


def parse_inner(argv: List[str], outer: argparse.Namespace) -> argparse.Namespace:
    from . import cli

    parser = cli.build_parser(video_extensions=False)
    cli.KbParser.json_errors = True
    try:
        inner = parser.parse_args(argv)
    except cli.UsageError as e:
        raise usage(f"kb plan {' '.join(argv)}: {e.message}") from None
    except SystemExit:
        raise usage(f"kb plan {' '.join(argv)}: not a kb command") from None
    finally:
        cli.KbParser.json_errors = False
    for key in ("agent", "project_dir"):
        if getattr(outer, key, None) and not getattr(inner, key, None):
            setattr(inner, key, getattr(outer, key))
    inner.json = True
    inner.dry_run = True
    return inner


def last_object(text: str) -> Optional[Dict[str, Any]]:
    """The last JSON object a command printed (its envelope)."""
    decoder = json.JSONDecoder()
    found: Optional[Dict[str, Any]] = None
    i = text.find("{")
    while 0 <= i < len(text):
        try:
            value, end = decoder.raw_decode(text, i)
        except ValueError:
            i = text.find("{", i + 1)
            continue
        if isinstance(value, dict):
            found = value
        i = text.find("{", end)
    return found


def dry_run(inner: argparse.Namespace) -> Tuple[Optional[Dict[str, Any]], Optional[KbError], str]:
    """(the command's envelope, or the KbError it raised, and its name), its stdout captured."""
    from . import cli

    ictx = cli.Ctx(inner)
    buf = io.StringIO()
    set_command(ictx.command)
    try:
        with contextlib.redirect_stdout(buf):
            inner.fn(ictx)
    except KbError as e:
        return None, e, ictx.command
    return last_object(buf.getvalue()), None, ictx.command


def lease_writes(ctx: Any, inner: argparse.Namespace, envelope: Dict[str, Any]) -> List[Dict[str, Any]]:
    stem = envelope.get("scene") or inner.scene
    rel = f".kb/leases/{stem}.json"
    base = lockmod.current_hash(ctx.project.root / rel)
    action = envelope.get("action")
    if action == "none":
        return []
    if action in ("released", "broken"):
        return [{"path": rel, "action": "delete", "base": base}]
    return [{"path": rel, "action": "create" if base == lockmod.ABSENT else "modify", "base": base}]


def notes_for(command: str, env: Dict[str, Any]) -> List[str]:
    out: List[str] = [str(n) for n in env.get("notes") or [] if isinstance(n, str)]
    if command in ("scene add", "scene duplicate"):
        out.insert(0, f"would add {env.get('file')} at index {env.get('index')} (id \"{env.get('id')}\", name \"{env.get('name')}\")")
    elif command == "scene move":
        out.insert(0, f"would move scene {env.get('from')} to index {env.get('to')}; its outgoing transition moves with it")
    elif command == "scene remove":
        out.insert(0, f"would remove scene {env.get('index')} from project.json" + (" after a checkpoint" if env.get("checkpoint") else ""))
    elif command == "scene set":
        out[:0] = [str(c) for c in env.get("changes") or []]
    elif command == "project fit":
        if env.get("summary"):
            out.insert(0, f"project.json: {env['summary']}")
    elif command in ("doc set", "doc unset", "doc merge", "project set", "project unset", "theme set"):
        if env.get("summary"):
            out.insert(0, f"{env.get('file')}: {env['summary']}")
        out += [f"{i.get('severity')}: {i.get('path') + ': ' if i.get('path') else ''}{i.get('message')}" for i in env.get("issues") or [] if isinstance(i, dict)]
    elif command.startswith("assets "):
        if env.get("note"):
            out.append(str(env["note"]))
        out += [str(w) for w in env.get("warnings") or [] if isinstance(w, str)]
    elif command == "checkpoint":
        files = env.get("files") or []
        out.append(f"a checkpoint would commit {len(files)} path(s){' in a new git repository' if env.get('newRepo') else ''}: {', '.join(files)}"
                   if files else "nothing changed since the last checkpoint")
    elif command == "undo":
        target = str(env.get("target") or "")[:7]
        out.insert(0, f"would restore to {target}" + (" after a checkpoint of the changes since" if env.get("checkpointFirst") else ""))
    elif command == "lease":
        lease = env.get("lease") if isinstance(env.get("lease"), dict) else {}
        holder = (lease.get("holder") or {}).get("name") if isinstance(lease.get("holder"), dict) else None
        out.insert(0, f"lease on {env.get('scene')}: would be {env.get('action')}" + (f" (holder {holder})" if holder else ""))
    if env.get("dryRun") is False:
        out.append("this command has no dry run here, so kb plan could not preview it")
    return out


def refusal_of(e: KbError, command: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {"code": e.kind, "error": e.message}
    data = e.data or {}
    path = data.get("path") or data.get("file")
    if command == "lease" and data.get("scene"):
        path = f".kb/leases/{data['scene']}.json"
    if path:
        out["path"] = path
    for key in REFUSAL_FIELDS:
        if key in data:
            out[key] = data[key]
    if e.hint:
        out["hint"] = e.hint
    return out


def cmd_plan(ctx: Any) -> int:
    argv = list(ctx.args.argv or [])
    if argv[:1] == ["--"]:
        argv = argv[1:]
    if not argv:
        raise usage("kb plan needs a command, e.g. ./kb plan scene remove 03-pricing")
    if argv[0] == "plan":
        raise usage("kb plan takes a structural command, not another plan")
    if "--json" in argv:
        ctx.json = True
    inner = parse_inner(argv, ctx.args)
    from .util import command_name

    name = command_name(inner)
    if name not in PLANNABLE:
        raise usage(f"kb plan does not cover {name or argv[0]}; it covers {', '.join(PLANNABLE)}")
    try:
        envelope, failed, name = dry_run(inner)
    finally:
        set_command(ctx.command)
    writes: List[Dict[str, Any]] = []
    refusals: List[Dict[str, Any]] = []
    notes: List[str] = []
    if failed is not None:
        if failed.code != EXIT_PROBLEMS or failed.kind not in REFUSAL_KINDS:
            raise failed
        refused = refusal_of(failed, name)
        refusals.append(refused)
        rel = refused.get("path")
        if isinstance(rel, str) and not Path(rel).is_absolute():
            base = lockmod.current_hash(ctx.project.root / rel)
            writes.append({"path": rel, "action": "create" if base == lockmod.ABSENT else "modify", "base": base,
                           "refusal": {k: v for k, v in refused.items() if k != "path"}})
    elif envelope is not None:
        writes = [dict(w) for w in envelope.get("writes") or [] if isinstance(w, dict)]
        if name == "lease":
            writes = lease_writes(ctx, inner, envelope)
        refusals = [dict(w["refusal"], path=w["path"]) for w in writes if isinstance(w.get("refusal"), dict)]
        refusals += [dict(r) for r in envelope.get("refusals") or [] if isinstance(r, dict)]
        notes = notes_for(name, envelope)
        if envelope.get("ok") is False and not refusals:
            refusals.append({"code": envelope.get("code") or "failed", "error": str(envelope.get("error") or "the dry run reported a problem")})
    payload = {"plan": name, "argv": argv, "writes": writes, "refusals": refusals, "notes": notes, "dryRun": True}
    first = refusals[0] if refusals else None
    if ctx.json:
        ctx.out(payload, ok=first is None, code=first and first.get("code"), error=first and f"kb {name} would be refused: {first.get('error')}")
    else:
        emit_text(name, writes, refusals, notes)
    return EXIT_PROBLEMS if refusals else EXIT_OK


def emit_text(name: str, writes: List[Dict[str, Any]], refusals: List[Dict[str, Any]], notes: List[str]) -> None:
    emit(f"plan for kb {name} (nothing written):")
    attached = set()
    for w in writes:
        refusal = w.get("refusal")
        tail = f"  REFUSED: {refusal.get('error')}" + (f" ({refusal['hint']})" if refusal.get("hint") else "") if isinstance(refusal, dict) else ""
        if tail:
            attached.add(w["path"])
        base = str(w.get("base") or "")
        emit(f"  {w.get('action', '?'):<6} {w.get('path')}" + (f"  (base {base[:12]})" if base and base != lockmod.ABSENT else "") + tail)
    if not writes and not refusals:
        emit("  (no file would change)")
    for r in refusals:
        if r.get("path") in attached:
            continue
        where = f"{r['path']}: " if r.get("path") else ""
        emit(f"  REFUSED {where}{r.get('error')}" + (f" ({r['hint']})" if r.get("hint") else ""))
    for n in notes:
        emit(f"  note: {n}")


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """Adds `kb plan` to kb's top-level subparsers."""
    s = sub.add_parser("plan", help="what a structural command would write, refuse and note (its dry run); writes nothing",
                       description="what a structural command would write, refuse and note; writes nothing",
                       epilog=EPILOG, formatter_class=Formatter, parents=[common])
    s.add_argument("argv", nargs=argparse.REMAINDER, metavar="COMMAND ...")
    s.set_defaults(fn=cmd_plan)
