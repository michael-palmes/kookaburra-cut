"""History and coordination commands: checkpoint, history, undo, diff, lease, leases, note, notes, events and hook."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List, Optional

from . import check as checkmod
from . import events as eventsmod
from . import git as gitmod
from . import identity
from . import leases as leasemod
from . import lock as lockmod
from .project import MANIFEST, Project
from .util import EXIT_ENV, EXIT_OK, KbError, ago, emit, safe_rel

UNDO_NOTE = "Scene files that the checkpoint lacks go to the Trash; edit docs never do. Renders\n(assets/*-edited.mp4) are not versioned: re-render an edit that undo changed."


def emit_writes(writes: List[Dict[str, Any]]) -> None:
    for w in writes:
        refused = f"  (refused: {w['refusal']['error']})" if w.get("refusal") else ""
        emit(f"  {w['action']:<6} {w['path']}{refused}")


def resolve_stem(project: Project, selector: str) -> str:
    """A scene index or stem from project.json, else a stem whose files exist on disk or in a checkpoint."""
    try:
        return project.resolve(selector)[1]
    except KbError:
        sel = selector.strip()
        sel = sel[len("scenes/"):] if sel.startswith("scenes/") else sel
        for suffix in (".tsx", ".json"):
            if sel.endswith(suffix):
                sel = sel[: -len(suffix)]
        paths = gitmod.scene_paths(sel)
        if safe_rel(f"scenes/{sel}") and "/" not in sel:
            if any((project.root / p).exists() for p in paths):
                return sel
            if gitmod.git_available() and gitmod.repo_state(project) == "own" and gitmod.known_paths(project, paths):
                return sel
        raise


def checked_file(rel: str) -> str:
    rel = rel.strip()
    rel = rel[2:] if rel.startswith("./") else rel
    if not safe_rel(rel) or not any(rel == t or rel.startswith(t + "/") for t in gitmod.TRACKED):
        raise KbError(f"--files {rel}: checkpoints hold only project.json, scenes/ and edits/", EXIT_ENV, kind="usage")
    return rel


# ── history ───────────────────────────────────────────────────────────────────


def cmd_checkpoint(ctx: Any) -> int:
    a = ctx.args
    message = " ".join(a.message) if a.message else "manual"
    project = ctx.project
    stems = [resolve_stem(project, s) for s in a.scene or []]
    files = [checked_file(f) for f in a.files or []]
    scoped = bool(stems or files)
    if ctx.dry_run:
        gitmod.require_git()
        state = gitmod.repo_state(project)
        if state == "foreign":
            raise KbError(f"{project.root} sits inside another git repository; kb only checkpoints a repository rooted at the project folder", EXIT_ENV)
        if scoped:
            wanted = [p for s in stems for p in gitmod.scene_paths(s)] + files
            paths = gitmod.known_paths(project, wanted) if state == "own" else [p for p in wanted if (project.root / p).exists()]
            changed = gitmod.dirty_files(project, paths) if state == "own" and paths else paths
        else:
            changed = gitmod.dirty_files(project) if state == "own" else [p for p in gitmod.TRACKED if (project.root / p).exists()]
        if ctx.json:
            ctx.out({"rev": None, "saved": False, "files": changed, "scenes": stems, "newRepo": state == "none", "writes": [], "dryRun": True})
        elif changed:
            emit(f"dry run, nothing committed: a checkpoint would save {len(changed)} path(s)" + (" in a new git repository" if state == "none" else "") + ":")
            for f in changed:
                emit(f"  {f}")
        else:
            emit("dry run: nothing changed since the last checkpoint" + (f" in {', '.join(stems + files)}" if scoped else ""))
        return EXIT_OK
    rev = gitmod.checkpoint(project, message, scenes=stems or None, files=files or None, caller=ctx.caller, wait=ctx.wait)
    if ctx.json:
        ctx.out({"rev": rev, "saved": rev is not None, "scenes": stems, "files": files, "dryRun": False})
    elif rev is None:
        emit("nothing changed since the last checkpoint" + (f" in {', '.join(stems + files)}" if scoped else ""))
    elif scoped:
        back = f"kb undo --scene {stems[0]} {rev}" if len(stems) == 1 and not files else f"kb undo {rev}"
        emit(f"checkpoint {rev}: {', '.join(stems + files)} saved, nothing else ({back} returns here)")
    else:
        emit(f"checkpoint {rev}: project.json, scenes/ and edits/ saved (kb undo {rev} returns here)")
    return EXIT_OK


def cmd_history(ctx: Any) -> int:
    project = ctx.project
    paths = gitmod.scene_paths(resolve_stem(project, ctx.args.scene)) if ctx.args.scene else None
    rows = gitmod.history(project, ctx.args.n, paths)
    if ctx.json:
        checkpoints = [dict(r, atMs=int(r["time"]) * 1000 if r["time"].isdigit() else None) for r in rows]
        ctx.out({"checkpoints": checkpoints, "uncommitted": len(gitmod.dirty_files(project, paths)) if rows else None})
        return EXIT_OK
    if not rows:
        emit("no checkpoints yet (kb checkpoint saves one)")
        return EXIT_OK
    for r in rows:
        try:
            when = ago(int(r["time"]) * 1000)
        except ValueError:
            when = "?"
        emit(f"{r['rev']}  {when:<12} {r['subject']}")
    dirty = gitmod.dirty_files(project, paths)
    if dirty:
        emit(f"(uncommitted: {len(dirty)} file(s); kb diff shows them)")
    return EXIT_OK


def stale_edits(project: Project, before: Dict[str, str]) -> List[str]:
    after = gitmod.edit_hashes(project)
    out: List[str] = []
    for name in sorted(n for n in after if before.get(n) != after[n]):
        if (project.root / "assets" / f"{name}-edited.mp4").is_file():
            out.append(f"edits/{name}.json changed; assets/{name}-edited.mp4 is stale (renders are not versioned): kb video render {name}")
        else:
            out.append(f"edits/{name}.json changed (not rendered yet: kb video render {name})")
    return out


def cmd_undo(ctx: Any) -> int:
    a = ctx.args
    if a.scene and a.all:
        raise KbError("pass --scene S or --all, not both", EXIT_ENV, kind="usage")
    if a.scene:
        return undo_scene(ctx)
    project = ctx.project
    if ctx.dry_run:
        plan = gitmod.undo_plan(project, a.rev, ctx.caller, everything=a.all)
        if ctx.json:
            ctx.out(dict(plan, dryRun=True))
            return EXIT_OK
        emit(f"dry run, nothing written: would restore project.json, scenes/ and edits/ to {plan['target'][:7]}" + (" (after a checkpoint of the changes since)" if plan["checkpointFirst"] else ""))
        emit_writes(plan["writes"])
        if not plan["writes"]:
            emit("  (no file differs)")
        for r in plan["refusals"]:
            emit(f"  refused: {r['error']} (kb undo --scene S restores one scene; --all reverts everyone's)")
        return EXIT_OK
    edits_before = gitmod.edit_hashes(project)
    with lockmod.project_lock(project, "kb undo", ctx.wait, ctx.caller):
        target, saved, trashed = gitmod.undo(project, a.rev, ctx.caller, everything=a.all)
    stale = stale_edits(project, edits_before)
    report = checkmod.check_project(project)
    if ctx.json:
        ctx.out({"target": target, "checkpoint": saved, "trashed": trashed, "edits": stale, "check": report.as_json(), "dryRun": False})
        return EXIT_OK
    emit(f"restored project.json, scenes/ and edits/ to {target[:7]}")
    for line in stale:
        emit(line)
    if saved:
        emit(f"the state before this undo is checkpoint {saved} (kb undo {saved} reverts the undo)")
    if trashed:
        emit(f"moved to the Trash (not in {target[:7]}): {', '.join(trashed)}")
    if report.errors:
        emit(report.render("error"))
    emit(f"check: {report.summary()}")
    return EXIT_OK


def undo_scene(ctx: Any) -> int:
    a = ctx.args
    project = ctx.project
    stem = resolve_stem(project, a.scene)
    res = gitmod.undo_scene(project, stem, a.rev, ctx.caller, ctx.wait, ctx.dry_run)
    if ctx.dry_run:
        if ctx.json:
            ctx.out(res)
            return EXIT_OK
        emit(f"dry run, nothing written: would restore {stem} to {res['target'][:7]}" + (" (after a checkpoint of its changes)" if res["checkpointFirst"] else ""))
        emit_writes(res["writes"])
        if not res["writes"]:
            emit("  (no file differs)")
        for n in res["notes"]:
            emit(f"  {n}")
        return EXIT_OK
    files = [p for p in gitmod.scene_paths(stem) if (project.root / p).is_file()] + [MANIFEST]
    report = checkmod.check_project(project, files=files)
    if ctx.json:
        ctx.out(dict(res, check=report.as_json()))
        return EXIT_OK
    changed = res["restored"] + res["trashed"]
    emit(f"restored {stem} to {res['target'][:7]}: " + (", ".join(changed) if changed else "its files already matched") + ("; project.json entry restored" if res["manifest"] else ""))
    for n in res["notes"]:
        emit(n)
    if res["checkpoint"]:
        emit(f"the state before this undo is checkpoint {res['checkpoint']} (kb undo --scene {stem} {res['checkpoint']} reverts it)")
    if res["trashed"]:
        emit(f"moved to the Trash (not in {res['target'][:7]}): {', '.join(res['trashed'])}")
    if report.errors:
        emit(report.render("error"))
    emit(f"check: {report.summary()}")
    return EXIT_OK


def cmd_diff(ctx: Any) -> int:
    paths = gitmod.scene_paths(resolve_stem(ctx.project, ctx.args.scene)) if ctx.args.scene else None
    text = gitmod.diff(ctx.project, ctx.args.rev, ctx.args.stat, paths).rstrip("\n")
    if ctx.json:
        ctx.out({"rev": ctx.args.rev, "stat": bool(ctx.args.stat), "diff": text})
    else:
        emit(text)
    return EXIT_OK


# ── leases and notes ──────────────────────────────────────────────────────────


def lease_text(lease: Dict[str, Any]) -> str:
    holder = leasemod.holder_name(lease)
    note = f" ({lease['note']})" if lease.get("note") else ""
    return f"{lease.get('scene')} leased to {holder} until {leasemod.clock(lease.get('untilMs'))}{note}"


def cmd_lease(ctx: Any) -> int:
    a = ctx.args
    project = ctx.project
    stem = resolve_stem(project, a.scene)
    if a.force and not a.release:
        raise KbError("--force only breaks a lease with --release", EXIT_ENV, kind="usage")
    if a.release:
        if a.for_ or a.ttl or a.note:
            raise KbError("--release takes no --for, --ttl or --note", EXIT_ENV, kind="usage")
        lease, action = leasemod.release(project, stem, ctx.caller, a.force, ctx.wait, ctx.dry_run)
        if ctx.json:
            ctx.out({"scene": stem, "action": action, "lease": lease, "dryRun": ctx.dry_run})
            return EXIT_OK
        prefix = "dry run, nothing written: would have " if ctx.dry_run else ""
        if action == "none":
            emit(f"{stem} has no lease")
        elif action == "broken":
            emit(f"{prefix}broke {leasemod.holder_name(lease or {})}'s lease on {stem} (journalled as lease.broken; tell them with ./kb note)")
        else:
            emit(f"{prefix}released the lease on {stem}")
        return EXIT_OK
    ttl, capped = leasemod.parse_ttl(a.ttl)
    for_name = identity.check_name(a.for_) if a.for_ else None
    lease, action = leasemod.take(project, stem, ctx.caller, ttl, a.note, for_name, ctx.wait, ctx.dry_run)
    if ctx.json:
        ctx.out({"scene": stem, "action": action, "lease": lease, "notes": [capped] if capped else [], "dryRun": ctx.dry_run})
        return EXIT_OK
    prefix = "dry run, nothing written: would be " if ctx.dry_run else ""
    left = leasemod.left(lease["untilMs"] - leasemod.now_ms())
    if action == "assigned":
        emit(f"{prefix}{stem} assigned to {for_name} until {leasemod.clock(lease['untilMs'])} ({left}); it binds when {for_name} runs ./kb lease {stem} --agent {for_name}")
    else:
        emit(f"{prefix}{stem} {action} by {leasemod.holder_name(lease)} until {leasemod.clock(lease['untilMs'])} ({left}); your writes renew it, ./kb lease {stem} --release ends it")
    if capped:
        emit(capped)
    return EXIT_OK


def cmd_leases(ctx: Any) -> int:
    rows = leasemod.rows(ctx.project, ctx.caller, include_expired=ctx.args.all)
    if ctx.json:
        ctx.out({"leases": rows})
        return EXIT_OK
    if not rows:
        emit("no leases (./kb lease S takes one)")
        return EXIT_OK
    for r in rows:
        tag = "expired" if r["expired"] else ("yours, " if r["yours"] else "") + leasemod.left(r["leftMs"])
        by = f", assigned by {r['assignedBy']}" if r.get("assignedBy") else ""
        emit(f"{lease_text(r)} [{tag}{by}]")
    return EXIT_OK


def cmd_note(ctx: Any) -> int:
    a = ctx.args
    project = ctx.project
    scene = resolve_stem(project, a.scene) if a.scene else None
    note = eventsmod.add_note(project, ctx.caller, " ".join(a.text), scene, ctx.wait)
    if ctx.json:
        ctx.out({"note": note})
    else:
        emit(f"noted in .kb/notes.md: {note['line']}")
    return EXIT_OK


def cmd_notes(ctx: Any) -> int:
    project = ctx.project
    root = str(project.root)
    notes = eventsmod.read_notes(root, include_old=ctx.args.all)
    shown = notes if ctx.args.all else notes[-30:]
    eventsmod.unseen_notes(project, ctx.caller, mark=True)
    if ctx.json:
        ctx.out({"notes": shown, "total": len(notes)})
        return EXIT_OK
    if not shown:
        emit("no notes yet (./kb note \"TEXT\" [--scene S] leaves one for the other agents)")
        return EXIT_OK
    if len(shown) < len(notes):
        emit(f"(the newest {len(shown)} of {len(notes)}; --all shows every note)")
    for n in shown:
        where = f" · {n['scene']}" if n.get("scene") else ""
        emit(f"{n['date']} {n['time']} · {n['agent']}{where}: {n['text']}")
    return EXIT_OK


def cmd_events(ctx: Any) -> int:
    a = ctx.args
    project = ctx.project
    root = str(project.root)
    caller = leasemod.resolve(root, ctx.caller)
    name = str(ctx.caller.name)
    kinds = eventsmod.split_kinds(a.kinds)
    saved = eventsmod.load_seen(root, name).get("eventsCursor")
    if a.since is not None:
        since = eventsmod.parse_since(a.since)
    elif isinstance(saved, str):
        since = eventsmod.parse_since(saved)
    else:
        since = eventsmod.parse_since(None if a.follow else "10m")

    def remember(cursor: str) -> None:
        try:
            eventsmod.save_seen(project, name, eventsCursor=cursor)
        except Exception:
            pass

    if a.follow:
        exit_after = eventsmod.EXIT_AFTER_S if a.exit_after is None else max(0.0, a.exit_after)
        eventsmod.follow(project, caller, since, kinds, a.all_agents, exit_after, sys.stdout, on_cursor=remember)
        return EXIT_OK
    found, cursor = eventsmod.read_since(root, since)
    shown = eventsmod.iter_wanted(root, found, caller, kinds, a.all_agents)
    remember(cursor)
    if ctx.json:
        ctx.out({"events": shown, "cursor": cursor})
        return EXIT_OK
    for event in shown:
        emit(eventsmod.describe(event))
    emit(f"{'no new events' if not shown else str(len(shown)) + ' event(s)'}; cursor {cursor} (./kb events --since {cursor} resumes; --follow streams)")
    return EXIT_OK


# ── hooks ─────────────────────────────────────────────────────────────────────


def cmd_hook(ctx: Any) -> int:
    event = ctx.args.event
    if event in ("bash-pre", "bash-post"):
        from . import hookfast

        return hookfast.main(event)
    if event not in ("session-start", "pre-edit", "post-edit"):
        return EXIT_OK
    from . import hooks as hookmod

    payload = hookmod.read_stdin()
    try:
        if event == "session-start":
            code, out, err = hookmod.session_start(payload)
        elif event == "pre-edit":
            code, out, err = hookmod.pre_edit(payload)
        else:
            code, out, err = hookmod.post_edit(payload)
    except Exception as e:  # a kb bug must never block the user's edit
        if event == "post-edit":
            note = {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": f"kb post-edit check crashed ({type(e).__name__}: {e}); run kb check"}}
            sys.stdout.write(json.dumps(note) + "\n")
        return EXIT_OK
    if out:
        sys.stdout.write(out if out.endswith("\n") else out + "\n")
    if err:
        sys.stderr.write(err if err.endswith("\n") else err + "\n")
    return code


# ── parser ────────────────────────────────────────────────────────────────────


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """checkpoint, history, undo, diff, lease, leases, note, notes, events and hook on kb's top-level subparsers."""
    structural = argparse.ArgumentParser(add_help=False)
    structural.add_argument("--dry-run", action="store_true", help="list what this would change; write nothing")
    structural.add_argument("--wait", type=float, nargs="?", const=600.0, default=None, metavar="SECONDS", help="wait for another kb write to finish (default 10 s)")
    waits = argparse.ArgumentParser(add_help=False)
    waits.add_argument("--wait", type=float, nargs="?", const=600.0, default=None, metavar="SECONDS", help="wait for another kb write to finish (default 10 s)")

    def add(name: str, help_: str, epilog: Optional[str] = None, parents: Optional[List[argparse.ArgumentParser]] = None) -> argparse.ArgumentParser:
        return sub.add_parser(name, help=help_, description=help_, epilog=epilog, formatter_class=Formatter, parents=parents or [common])

    writes = [common, structural]
    s = add(
        "checkpoint",
        "git-commit project.json, scenes/ and edits/ (nothing else), or only some scenes' files",
        epilog="  kb checkpoint \"hero copy\"                       everything changed in project.json, scenes/, edits/\n"
        "  kb checkpoint \"hero copy\" --scene 02-hero       only scenes/02-hero.tsx and .json\n"
        "  kb checkpoint --scene 02-hero --files project.json\n"
        "With other agents at work, scope it (--scene) so their half-finished files stay out.",
        parents=writes,
    )
    s.add_argument("message", nargs="*", metavar="MESSAGE")
    s.add_argument("--scene", action="append", metavar="S", help="only this scene's TSX and sidecar (repeatable)")
    s.add_argument("--files", action="append", metavar="P", help="also this path under project.json, scenes/ or edits/ (repeatable)")
    s.set_defaults(fn=cmd_checkpoint)

    s = add("history", "recent checkpoints of project.json, scenes/ and edits/ (or one scene's files)")
    s.add_argument("-n", type=int, default=15, help="how many (default 15)")
    s.add_argument("--scene", metavar="S", help="only checkpoints that touched this scene's files")
    s.set_defaults(fn=cmd_history)

    s = add(
        "undo",
        "restore project.json, scenes/ and edits/ from a checkpoint, or one scene (checkpoints first, so it is undoable)",
        epilog="No REV: back to the last checkpoint (or the one before it when nothing changed since).\n"
        + UNDO_NOTE
        + "\n\n  kb undo --scene 02-hero          scenes/02-hero.tsx, .json and its project.json entry only\n"
        "  kb undo --scene 02-hero abc1234  that scene as it was in abc1234\n"
        "A plain undo refuses (exit 1, others-changed) when it would revert files another agent wrote\n"
        "or leases; undo your own scene with --scene, or pass --all to revert everyone's work.",
        parents=writes,
    )
    s.add_argument("rev", nargs="?", metavar="REV")
    s.add_argument("--scene", metavar="S", help="restore only this scene: its TSX, sidecar and project.json entry")
    s.add_argument("--all", action="store_true", help="revert other agents' changes too")
    s.set_defaults(fn=cmd_undo)

    s = add("diff", "changes to project.json, scenes/ and edits/ since the last checkpoint (or REV)")
    s.add_argument("rev", nargs="?", metavar="REV")
    s.add_argument("--stat", action="store_true", help="file summary only")
    s.add_argument("--scene", metavar="S", help="only this scene's files")
    s.set_defaults(fn=cmd_diff)

    s = add(
        "lease",
        "take, renew, assign or release a scene's lease (several agents: who is editing which scene)",
        epilog="  kb lease 06-feature --agent alpha               take or renew (2 h; your writes renew it)\n"
        "  kb lease 06-feature --agent alpha --ttl 4h --note \"hero rewrite\"\n"
        "  kb lease 06-feature --for alpha                  assign it to alpha (binds when alpha runs kb lease)\n"
        "  kb lease 06-feature --release                    give it back\n"
        "  kb lease 06-feature --release --force            break someone else's (journalled)\n"
        "While a scene is leased to someone else, kb refuses to write it and Claude Code denies Edit and\n"
        "Write to its files. TTL 2 h by default, 12 h at most; expired leases are ignored.",
        parents=writes,
    )
    s.add_argument("scene", metavar="S")
    s.add_argument("--ttl", metavar="DURATION", help="2h (default), 90m, 1h30m; 12h at most")
    s.add_argument("--note", metavar="TEXT", help="what you are doing, shown to the other agents")
    s.add_argument("--for", dest="for_", metavar="NAME", help="assign the lease to this agent instead of taking it")
    s.add_argument("--release", action="store_true", help="release the lease")
    s.add_argument("--force", action="store_true", help="with --release: break someone else's lease")
    s.set_defaults(fn=cmd_lease)

    s = add("leases", "who leases which scene, and for how long")
    s.add_argument("--all", action="store_true", help="include expired leases not yet pruned")
    s.set_defaults(fn=cmd_leases)

    s = add("note", "leave a note for the other agents in .kb/notes.md (their next kb status shows it)", parents=[common, waits])
    s.add_argument("text", nargs="+", metavar="TEXT")
    s.add_argument("--scene", metavar="S", help="the scene it is about")
    s.set_defaults(fn=cmd_note)

    s = add("notes", "the shared notes, newest last (marks them read for kb status)")
    s.add_argument("--all", action="store_true", help="every note, including the rotated notes.1.md")
    s.set_defaults(fn=cmd_notes)

    s = add(
        "events",
        "the coordination feed: kb's journal plus app events, one compact JSON object per line with --follow",
        epilog="  kb events                         since your last look (else the last 10 minutes)\n"
        "  kb events --since all --all-agents\n"
        "  kb events --follow                 stream until --exit-after (1740 s, under the Monitor's 30 min)\n"
        "  kb events --follow --since CURSOR  resume from the last follow.end\n"
        "  kb events --kinds lease,note,load  only these kinds (a prefix like lease matches lease.*)\n"
        "By default your own events and files.changed are left out. --follow adds app events from the\n"
        "running app's heartbeat: load, export.started/progress/done, render.stalled/recovered,\n"
        "app.opened/closed. A follow ends with { \"kind\": \"follow.end\", \"cursor\" }.",
    )
    s.add_argument("--follow", action="store_true", help="keep streaming new events")
    s.add_argument("--since", metavar="WHEN", help="10m, 2h, all, now or a cursor (INODE:OFFSET)")
    s.add_argument("--kinds", nargs="+", metavar="KIND", help="only these kinds (comma or space separated)")
    s.add_argument("--all-agents", action="store_true", help="include your own events")
    s.add_argument("--exit-after", type=float, default=None, metavar="SECONDS", help="with --follow: stop after this long (default 1740)")
    s.set_defaults(fn=cmd_events)

    s = add("hook", "Claude Code hook entry points (stdin JSON); wired by the app in .claude/settings.json")
    s.add_argument("event", metavar="EVENT", help="session-start, pre-edit, post-edit, bash-pre or bash-post (others exit 0)")
    s.set_defaults(fn=cmd_hook)
