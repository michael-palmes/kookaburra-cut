"""Claude Code hook entry points: session-start, pre-edit, post-edit (stdin JSON in, exit code and text out)."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import check as checkmod
from . import git as gitmod
from .project import KIT_REL, MANIFEST, Project, SAFE_SESSION, find_root
from .util import EXIT_OK, KbError, Report

BLOCK = 2
SESSION_TTL_S = 14 * 86400


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


def edited_rel(project: Project, payload: Dict[str, Any]) -> Optional[str]:
    """The edited file relative to the project, or None when it lies outside it."""
    tool_input = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    raw = tool_input.get("file_path") or tool_input.get("path")
    if not isinstance(raw, str) or not raw:
        return None
    path = Path(raw)
    if not path.is_absolute():
        base = payload.get("cwd") if isinstance(payload.get("cwd"), str) else str(project.root)
        path = Path(base) / path
    real = Path(os.path.realpath(str(path)))
    root = Path(os.path.realpath(str(project.root)))
    try:
        return real.relative_to(root).as_posix()
    except ValueError:
        return None


def blocked_reason(rel: str) -> Optional[str]:
    first = rel.split("/", 1)[0]
    if first in ("exports", "edits"):
        return f"{rel} is owned by the Kookaburra Cut app ({first}/ holds its renders and edits). Do not change it; edit project.json, scenes/ or assets/ instead."
    if first.startswith(".kookaburra"):
        return f"{rel} is the app's private state. Do not change it; edit project.json, scenes/ or assets/ instead."
    if rel == KIT_REL or rel.startswith(KIT_REL + "/"):
        return f"{rel} is the managed kit; the app replaces it on every launch, so edits are lost. Put project notes in CLAUDE.md instead."
    return None


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
    rel = edited_rel(project, payload)
    if rel is None:
        return EXIT_OK, "", ""
    reason = blocked_reason(rel)
    if reason:
        return BLOCK, "", f"kb: blocked: {reason}"
    if checked_source(rel):
        save_baseline(project, rel, payload)
    if rel != MANIFEST and not rel.startswith("scenes/"):
        return EXIT_OK, "", ""
    session = payload.get("session_id")
    if not isinstance(session, str) or not session or not gitmod.git_available():
        return EXIT_OK, "", ""
    try:
        state = gitmod.repo_state(project)
        if state == "foreign":
            return EXIT_OK, "", ""
        if state == "none":
            gitmod.ensure_repo(project)
        marker = session_marker(project, session)
        if marker.exists():
            return EXIT_OK, "", ""
        rev = None
        if not gitmod.has_head(project) or gitmod.dirty_files(project):
            rev = gitmod.checkpoint(project, f"before Claude edits (session {session[:8]})")
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(rev or "clean\n", encoding="utf-8")
        prune_sessions(marker.parent)
    except (KbError, OSError):
        return EXIT_OK, "", ""
    return EXIT_OK, "", ""


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
        lines.append("Rerun: python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py check")
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
        text = overview.context_text(project, summary)
    except Exception as e:
        text = f"Kookaburra Cut project {project.project_id} (kb context failed: {e}). Run python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py status"
    return EXIT_OK, text, ""
