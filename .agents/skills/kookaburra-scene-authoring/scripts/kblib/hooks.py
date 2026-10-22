"""Claude Code hook entry points: session-start, pre-edit, post-edit (stdin JSON in, exit code and text out).

The Bash hooks (bash-pre, bash-post) live in kblib.hookfast, which kb.py runs before importing the CLI.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import check as checkmod
from . import git as gitmod
from . import leases
from .hookfast import asset_record_reason, hook_caller
from .project import KIT_REL, MANIFEST, Project, SAFE_SESSION, find_root, worktree_of
from .util import EXIT_OK, KbError, Report, ago

BLOCK = 2
SESSION_TTL_S = 14 * 86400
MANAGED_SKILLS = (KIT_REL, ".claude/skills/kookaburra-video-editing", ".claude/skills/kookaburra-brand-packs")
KB_STATE = re.compile(r"^\.kb/(?:lock|\.gitignore|leases(?:/.*)?|events[^/]*\.jsonl|notes[^/]*\.md|agents/[^/]+/(?:identity|seen)\.json)$")


def read_stdin() -> Dict[str, Any]:
    try:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    except (OSError, ValueError):
        raw = ""
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        data = {}
    return data if isinstance(data, dict) else {}


def hook_root(payload: Dict[str, Any]) -> Optional[Path]:
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    for candidate in (env, payload.get("cwd")):
        if isinstance(candidate, str) and candidate:
            try:
                return find_root(Path(candidate))
            except KbError:
                continue
    try:
        return find_root()
    except KbError:
        return None


def edited_path(project: Project, payload: Dict[str, Any]) -> Optional[Path]:
    tool_input = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    raw = tool_input.get("file_path") or tool_input.get("path")
    if not isinstance(raw, str) or not raw:
        return None
    path = Path(raw)
    if not path.is_absolute():
        base = payload.get("cwd") if isinstance(payload.get("cwd"), str) else str(project.root)
        path = Path(base) / path
    return Path(os.path.realpath(str(path)))


def edited_rel(project: Project, payload: Dict[str, Any]) -> Optional[str]:
    """The edited file relative to the project, or None when it lies outside it."""
    real = edited_path(project, payload)
    if real is None:
        return None
    root = Path(os.path.realpath(str(project.root)))
    try:
        return real.relative_to(root).as_posix()
    except ValueError:
        return None


def blocked_reason(rel: str) -> Optional[str]:
    first = rel.split("/", 1)[0]
    if first == "exports":
        return f"{rel} is owned by the Kookaburra Cut app (exports/ holds its renders). Do not change it; edit project.json, scenes/ or assets/ instead."
    if first == "edits":
        name = rel.split("/")[-1].rsplit(".json", 1)[0] if rel.endswith(".json") else "NAME"
        return f"{rel}: edits/ holds video edit documents; change them only with kb video (kb video show {name or 'NAME'})."
    if first.startswith(".kookaburra"):
        return f"{rel} is the app's private state. Do not change it; edit project.json, scenes/ or assets/ instead."
    for kit in MANAGED_SKILLS:
        if rel == kit or rel.startswith(kit + "/"):
            return f"{rel} is the managed kit; the app replaces it on every launch, so edits are lost. Put project notes in CLAUDE.md instead."
    if KB_STATE.match(rel):
        return (f"{rel} is kb's own coordination state; change it only through kb (./kb lease, ./kb note, ./kb events). "
                "Scratch files belong in .kb/agents/<your name>/ instead.")
    return asset_record_reason(rel)


def journal_by(project: Project, caller: Dict[str, Any]) -> Dict[str, Any]:
    return dict(caller, name=leases.bound_name(str(project.root), caller.get("session"), caller.get("agentId")))


def lease_decision(project: Project, rel: str, payload: Dict[str, Any]) -> Optional[str]:
    """A PreToolUse deny when rel belongs to a scene leased to someone else; the holder's own edit renews the lease."""
    stem = leases.scene_of(rel)
    root = str(project.root)
    lease = leases.read(root, stem) if stem else None
    if lease is None:
        return None
    caller = hook_caller(payload)
    if leases.is_holder(root, lease, caller):
        leases.renew_if_due(project, str(stem), lease, journal_by(project, caller))
        return None
    reason = leases.deny_reason(rel, lease)
    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}
    return json.dumps(out, ensure_ascii=False)


def worktree_reason(project: Project, payload: Dict[str, Any]) -> Optional[str]:
    """Any write into a project's linked git worktree: the app never sees it, so the edit would be lost."""
    from . import overview

    path = edited_path(project, payload)
    found = worktree_of(path.parent) if path else None
    if not found or not (found[0] / MANIFEST).is_file():
        return None
    return " ".join(overview.worktree_banner(found))


def session_marker(project: Project, session_id: str) -> Path:
    safe = SAFE_SESSION.sub("_", session_id)[:80] or "unknown"
    return project.root / ".git" / "kb" / "sessions" / safe


def prune_sessions(folder: Path) -> None:
    now = time.time()
    try:
        for entry in folder.iterdir():
            try:
                if now - entry.stat().st_mtime > SESSION_TTL_S:
                    entry.unlink()
            except OSError:
                continue
    except OSError:
        pass


def checked_source(rel: str) -> bool:
    return rel == MANIFEST or (rel.startswith("scenes/") and rel.endswith((".tsx", ".json")))


def baseline_path(project: Project, rel: str, payload: Dict[str, Any]) -> Path:
    """Where pre-edit leaves the edited file's existing errors for post-edit; keyed by the tool call both hooks share."""
    call = payload.get("tool_use_id") or payload.get("session_id") or ""
    key = hashlib.sha1(f"{os.path.realpath(str(project.root))}\0{rel}\0{call}".encode("utf-8")).hexdigest()
    return Path(tempfile.gettempdir()) / "kb-hooks" / f"{key}.json"


def error_signatures(report: Report) -> List[str]:
    return sorted({f"{i.file}\0{i.path}\0{i.message}" for i in report.errors})


def save_baseline(project: Project, rel: str, payload: Dict[str, Any]) -> None:
    try:
        path = baseline_path(project, rel, payload)
        path.parent.mkdir(parents=True, exist_ok=True)
        prune_sessions(path.parent)
        signatures = error_signatures(checkmod.check_project(project, files=[rel]))
        path.write_text(json.dumps(signatures), encoding="utf-8")
    except Exception:
        pass


def take_baseline(project: Project, rel: str, payload: Dict[str, Any]) -> Optional[set]:
    path = baseline_path(project, rel, payload)
    try:
        signatures = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    try:
        path.unlink()
    except OSError:
        pass
    return set(signatures) if isinstance(signatures, list) else None


def pre_edit(payload: Dict[str, Any]) -> Tuple[int, str, str]:
    root = hook_root(payload)
    if root is None:
        return EXIT_OK, "", ""
    project = Project(root)
    reason = worktree_reason(project, payload)
    if reason:
        return BLOCK, "", f"kb: blocked: {reason}"
    rel = edited_rel(project, payload)
    if rel is None:
        return EXIT_OK, "", ""
    reason = blocked_reason(rel)
    if reason:
        return BLOCK, "", f"kb: blocked: {reason}"
    denied = lease_decision(project, rel, payload)
    if denied:
        return EXIT_OK, denied, ""
    if checked_source(rel):
        save_baseline(project, rel, payload)
    if rel != MANIFEST and not rel.startswith("scenes/"):
        return EXIT_OK, "", ""
    session = payload.get("session_id")
    if not isinstance(session, str) or not session:
        return EXIT_OK, "", ""
    caller = journal_by(project, hook_caller(payload))
    from .identity import Caller

    note = session_checkpoint(project, session, Caller(caller.get("name") or f"session-{session[:8]}", session, caller.get("agentId")))
    if note:
        out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": note}}
        return EXIT_OK, json.dumps(out, ensure_ascii=False), ""
    return EXIT_OK, "", ""


def session_checkpoint(project: Project, session: str, caller: Any = None, what: str = "edit") -> Optional[str]:
    """The once-per-session checkpoint before the first write into project.json or scenes/ (Edit, Write or Bash).

    Returns None, or plain context when .git/index.lock kept it from running: no marker is written, so the next write retries.
    """
    if not gitmod.git_available():
        return None
    try:
        state = gitmod.repo_state(project)
        if state == "foreign":
            return None
        if state == "none":
            gitmod.ensure_repo(project)
        marker = session_marker(project, session)
        if marker.exists():
            return None
        rev = None
        if not gitmod.has_head(project) or gitmod.dirty_files(project):
            rev = gitmod.checkpoint(project, f"before Claude edits (session {session[:8]})", caller=caller)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(rev or "clean\n", encoding="utf-8")
        prune_sessions(marker.parent)
    except KbError as e:
        if e.kind != "index-locked":
            return None
        return skipped_checkpoint(project, caller, what)
    except OSError:
        return None
    return None


def skipped_checkpoint(project: Project, caller: Any, what: str) -> str:
    try:
        last = gitmod.last_checkpoint(project)
    except KbError:
        last = None
    try:
        from . import events

        events.append(project, "checkpoint.skipped", caller, reason="index-locked", last=last[0] if last else None)
    except Exception:
        pass
    tail = f"The last checkpoint is {last[0]}, {ago(last[1])}." if last else "There is no checkpoint yet."
    return (f"kb did not make the session checkpoint before this {what}: .git/index.lock is held by another git process. {tail} "
            "kb tries again before the next write.")


def post_edit(payload: Dict[str, Any]) -> Tuple[int, str, str]:
    root = hook_root(payload)
    if root is None:
        return EXIT_OK, "", ""
    project = Project(root)
    rel = edited_rel(project, payload)
    if rel is None:
        return EXIT_OK, "", ""
    if not checked_source(rel):
        return EXIT_OK, "", ""
    try:
        from . import events

        events.journal(project, "files.changed", journal_by(project, hook_caller(payload)), [rel], via="edit")
    except Exception:
        pass
    report = checkmod.check_project(project, files=[rel])
    return render_hook_report(report, rel, take_baseline(project, rel, payload))


def render_hook_report(report: Report, rel: str, before: Optional[set] = None) -> Tuple[int, str, str]:
    """Blocks only on errors this edit introduced; errors the file already had (seen by pre-edit) come back as context."""
    known = before or set()
    fresh = Report()
    older = Report()
    for issue in report.issues:
        signature = f"{issue.file}\0{issue.path}\0{issue.message}"
        target = older if issue.severity == "error" and signature in known else fresh
        target.issues.append(issue)
    if fresh.errors:
        lines = [f"kb check found problems after editing {rel}. Fix every error before moving on:"]
        lines.append(fresh.render())
        if older.errors:
            lines.append(f"({len(older.errors)} more error(s) were already there before this edit; kb check lists them.)")
        lines.append("Rerun: ./kb check")
        return BLOCK, "", "\n".join(lines)
    notes: List[str] = []
    if older.errors:
        notes.append(
            f"{len(older.errors)} error(s) were already in {rel} before this edit (not caused by it); "
            f"fix them if they touch the task:\n{older.render()}"
        )
    if fresh.warnings:
        notes.append(f"kb check after editing {rel}: {fresh.summary()}\n{fresh.render()}")
    if notes:
        out = {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "\n".join(notes)}}
        return EXIT_OK, json.dumps(out, ensure_ascii=False), ""
    return EXIT_OK, "", ""


def session_start(payload: Dict[str, Any], project: Optional[Project] = None) -> Tuple[int, str, str]:
    from . import overview

    if project is None:
        root = hook_root(payload)
        if root is None:
            return EXIT_OK, "", ""
        project = Project(root)
    summary: List[str] = []
    try:
        report = checkmod.check_project(project)
        if report.errors:
            summary.append(f"Static check: {report.summary()} (fix these first; kb check shows all):")
            for issue in report.errors[:6]:
                summary.append(f"  {issue.line()}")
    except Exception:
        summary = []
    try:
        cwd = payload.get("cwd")
        caller = hook_caller(payload) if payload.get("session_id") else None
        text = overview.context_text(project, summary, cwd if isinstance(cwd, str) else None, caller=caller)
    except Exception as e:
        text = f"Kookaburra Cut project {project.project_id} (kb context failed: {e}). Run python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py status"
    return EXIT_OK, text, ""
