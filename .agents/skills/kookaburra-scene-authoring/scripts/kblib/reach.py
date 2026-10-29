"""How far kb reaches outside the project (docs/agent-kit.md, "kb reach").

kb runs without a permission prompt, so it is the boundary. A read outside the workspace is announced on stderr with
the resolved path and size, and credential folders and files are refused outright. A write outside the workspace lands
only in a folder the app's own file dialog returned this session (the heartbeat's `pickedDirs`).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .util import EXIT_ENV, WORKSPACE_DIR_NAME, KbError, emit_err, home

# Folders under the home directory that hold keys and credentials.
DENIED_DIRS = (".ssh", ".aws", ".config", ".gnupg", "Library/Keychains")
DENIED_NAMES = (".netrc", ".bash_history", ".zsh_history", ".zhistory", ".sh_history", ".history",
                ".python_history", ".node_repl_history", ".lesshst", "fish_history")
DENIED_PREFIXES = (".env",)
DENIED_SUFFIXES = (".pem", ".p12", ".key")


def resolve(raw: str) -> Path:
    """The path as the filesystem sees it: `~` expanded, relative to the cwd, symlinks followed."""
    return Path(os.path.realpath(str(Path(raw).expanduser())))


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def workspace_roots(project_root: Path) -> List[Path]:
    """The project, its workspace and the home workspace: reads here are routine and writes here are always allowed."""
    root = resolve(str(project_root))
    roots = [root, root.parent, resolve(str(home() / WORKSPACE_DIR_NAME))]
    out: List[Path] = []
    for r in roots:
        if r not in out:
            out.append(r)
    return out


def denied_reason(path: Path) -> Optional[str]:
    """Why a path is never read: a credential folder, a secret file or a shell history."""
    user_home = resolve(str(home()))
    for rel in DENIED_DIRS:
        if _inside(path, user_home / rel):
            return f"~/{rel} holds keys and credentials"
    name = path.name
    if name in DENIED_NAMES:
        return f"{name} is a credential or history file"
    if any(name == p or name.startswith(p + ".") for p in DENIED_PREFIXES):
        return f"{name} is an environment file (secrets)"
    if any(name.endswith(s) for s in DENIED_SUFFIXES):
        return f"{name} is a key or certificate"
    return None


def guard_read_at(project_root: Path, raw: str, what: str = "file") -> Path:
    """A path kb is about to read on the agent's behalf: refused when it names a credential, announced when it lies
    outside the workspace, silent inside it. Returns the resolved path; existence is the caller's check."""
    path = resolve(raw)
    reason = denied_reason(path)
    if reason:
        raise KbError(f"{what} {raw} is not read: {reason}; kb never reads credentials", EXIT_ENV, kind="usage",
                      hint="pick another file, or ask the person to copy what you need into the project")
    if any(_inside(path, root) for root in workspace_roots(project_root)):
        return path
    try:
        size = f"{path.stat().st_size} bytes" if path.is_file() else ("a folder" if path.is_dir() else "missing")
    except OSError as e:
        raise KbError(f"{what} {raw} cannot be read: {e.strerror or e}", EXIT_ENV, kind="usage") from None
    emit_err(f"kb: reading {path} ({size}) from outside the workspace")
    return path


def guard_read(project: Any, raw: str, what: str = "file") -> Path:
    return guard_read_at(project.root, raw, what)


def picked_dirs(project: Any) -> List[Path]:
    """Folders the running app's dialogs returned this session, from the serving instance's heartbeat."""
    from . import bridge

    hb: Optional[Dict[str, Any]] = bridge.live_heartbeat(project)
    dirs = hb.get("pickedDirs") if isinstance(hb, dict) else None
    out: List[Path] = []
    for d in dirs if isinstance(dirs, list) else []:
        if isinstance(d, str) and d and os.path.isabs(d):
            out.append(resolve(d))
    return out


def allowed_write_roots(project: Any) -> Tuple[List[Path], List[Path]]:
    """The workspace roots, and the picked folders that add to them."""
    roots = workspace_roots(project.root)
    picked = [d for d in picked_dirs(project) if d not in roots]
    return roots, picked


def guard_write(project: Any, raw: str, what: str = "--out") -> Path:
    """A folder or file kb is about to write on the agent's behalf: inside the project, the workspace, or a folder the
    person picked in the app this session, else exit 2 naming the allowed roots."""
    path = resolve(raw)
    workspace, picked = allowed_write_roots(project)
    roots = workspace + picked
    if any(path == root or _inside(path, root) for root in roots):
        return path
    where = ", ".join(str(r) for r in roots)
    if picked:
        note = "or a folder picked in the app this session"
    else:
        note = "or a folder the person picks in Kookaburra Cut this session (none picked yet)"
    raise KbError(f"{what} {raw} is outside where kb writes: the project, ~/{WORKSPACE_DIR_NAME}, {note}; allowed: {where}",
                  EXIT_ENV, kind="usage",
                  hint="save under the project or the workspace, or ask the person to choose that folder in Kookaburra Cut")
