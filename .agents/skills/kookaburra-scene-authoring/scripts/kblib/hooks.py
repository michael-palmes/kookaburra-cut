"""Claude Code hook entry points: session-start, pre-edit, post-edit (stdin JSON in, exit code and text out)."""

from __future__ import annotations

import json
import os
import sys
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
    if rel != MANIFEST and not (rel.startswith("scenes/") and rel.endswith((".tsx", ".json"))):
        return EXIT_OK, "", ""
    report = checkmod.check_project(project, files=[rel])
    return render_hook_report(report, rel)


def render_hook_report(report: Report, rel: str) -> Tuple[int, str, str]:
    if report.errors:
        lines = [f"kb check found problems after editing {rel}. Fix every error before moving on:"]
        lines.append(report.render())
        lines.append("Rerun: python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py check")
        return BLOCK, "", "\n".join(lines)
    if report.warnings:
        context = f"kb check after editing {rel}: {report.summary()}\n{report.render()}"
        out = {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": context}}
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
