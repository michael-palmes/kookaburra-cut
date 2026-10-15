"""Git checkpoints of project.json and scenes/: checkpoint, history, undo, diff."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .project import Project
from .util import EXIT_ENV, KbError, trash_dir

TRACKED = ["project.json", "scenes"]
FALLBACK_IDENTITY = ["-c", "user.name=Kookaburra Cut", "-c", "user.email=kookaburra@localhost"]
_available: Optional[bool] = None


def git_available() -> bool:
    """True when git runs without triggering the macOS developer-tools install prompt."""
    global _available
    if _available is not None:
        return _available
    exe = shutil.which("git")
    if not exe:
        _available = False
        return False
    if os.path.realpath(exe) == "/usr/bin/git" and shutil.which("xcode-select"):
        try:
            probe = subprocess.run(["xcode-select", "-p"], capture_output=True, timeout=5)
            _available = probe.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            _available = False
        return _available
    _available = True
    return True


def run(root: Path, args: List[str], check: bool = True, timeout: float = 30) -> subprocess.CompletedProcess:
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0", LC_ALL="C")
    env.pop("GIT_DIR", None)
    env.pop("GIT_WORK_TREE", None)
    env.pop("GIT_INDEX_FILE", None)
    try:
        proc = subprocess.run(["git", "-c", "core.quotepath=off", "-C", str(root)] + args, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise KbError(f"git {args[0]} timed out after {int(timeout)} s", EXIT_ENV) from None
    except OSError as e:
        raise KbError(f"git could not run ({e.strerror})", EXIT_ENV) from None
    if check and proc.returncode != 0:
        raise KbError(f"git {' '.join(args[:2])} failed: {proc.stderr.strip() or proc.stdout.strip()}")
    return proc


def require_git() -> None:
    if not git_available():
        raise KbError("git is not available (macOS asks to install the developer tools on first use); checkpoints need it", EXIT_ENV)


def repo_state(project: Project) -> str:
    """"own" (a repo rooted at the project), "none" or "foreign" (inside another repo)."""
    if not git_available():
        return "none"
    proc = run(project.root, ["rev-parse", "--show-toplevel"], check=False)
    if proc.returncode != 0:
        return "none"
    top = Path(proc.stdout.strip()).resolve()
    return "own" if top == project.root.resolve() else "foreign"


def ensure_repo(project: Project) -> None:
    require_git()
    state = repo_state(project)
    if state == "foreign":
        raise KbError(f"{project.root} sits inside another git repository; kb only checkpoints a repository rooted at the project folder", EXIT_ENV)
    if state == "none":
        run(project.root, ["init", "-q"])


def identity(project: Project) -> List[str]:
    name = run(project.root, ["config", "user.name"], check=False).stdout.strip()
    email = run(project.root, ["config", "user.email"], check=False).stdout.strip()
    return [] if name and email else list(FALLBACK_IDENTITY)


def has_head(project: Project) -> bool:
    return run(project.root, ["rev-parse", "--verify", "-q", "HEAD"], check=False).returncode == 0


def tracked_paths(project: Project) -> List[str]:
    """Pathspecs that exist on disk or in the index, so git never errors on a missing scenes/."""
    out: List[str] = []
    for p in TRACKED:
        if (project.root / p).exists():
            out.append(p)
        elif run(project.root, ["ls-files", "--", p], check=False).stdout.strip():
            out.append(p)
    return out


def dirty_files(project: Project) -> List[str]:
    paths = tracked_paths(project)
    if not paths:
        return []
    proc = run(project.root, ["status", "--porcelain", "--untracked-files=all", "--"] + paths, check=False)
    return [line[3:] for line in proc.stdout.splitlines() if line.strip()]


def checkpoint(project: Project, message: str) -> Optional[str]:
    """Commit project.json and scenes/ only. Returns the new short hash, or None when nothing changed."""
    ensure_repo(project)
    paths = tracked_paths(project)
    if not paths:
        raise KbError("nothing to checkpoint: no project.json or scenes/ here")
    if has_head(project) and not dirty_files(project):
        return None
    run(project.root, ["add", "-A", "--"] + paths)
    if has_head(project):
        staged = run(project.root, ["diff", "--cached", "--quiet", "--"] + paths, check=False)
        if staged.returncode == 0:
            return None
    subject = message if message.startswith("checkpoint") else f"checkpoint: {message}"
    run(project.root, identity(project) + ["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", subject, "--"] + paths)
    return run(project.root, ["rev-parse", "--short", "HEAD"]).stdout.strip()


def history(project: Project, limit: int) -> List[Dict[str, str]]:
    if repo_state(project) != "own" or not has_head(project):
        return []
    paths = tracked_paths(project) or TRACKED
    proc = run(project.root, ["log", f"-n{limit}", "--format=%h%x09%ct%x09%s", "--"] + paths, check=False)
    out: List[Dict[str, str]] = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t", 2)
        if len(parts) == 3:
            out.append({"rev": parts[0], "time": parts[1], "subject": parts[2]})
    return out


def resolve_rev(project: Project, rev: str) -> str:
    proc = run(project.root, ["rev-parse", "--verify", "-q", f"{rev}^{{commit}}"], check=False)
    if proc.returncode != 0:
        raise KbError(f'"{rev}" is not a checkpoint in this project; list them with kb history')
    return proc.stdout.strip()


def previous_rev(project: Project) -> Optional[str]:
    proc = run(project.root, ["log", "-n2", "--format=%H", "--"] + TRACKED, check=False)
    revs = proc.stdout.split()
    return revs[1] if len(revs) > 1 else None


def files_at(project: Project, rev: str) -> List[str]:
    proc = run(project.root, ["ls-tree", "-r", "--name-only", rev, "--"] + TRACKED, check=False)
    return [line for line in proc.stdout.splitlines() if line]


def trash(path: Path) -> Path:
    """Move a file to the macOS Trash under a unique name."""
    dest_dir = trash_dir()
    dest_dir.mkdir(parents=True, exist_ok=True)
    stem, suffix = os.path.splitext(path.name)
    dest = dest_dir / path.name
    n = 2
    while dest.exists():
        dest = dest_dir / f"{stem} {n}{suffix}"
        n += 1
    shutil.move(str(path), str(dest))
    return dest


def undo(project: Project, rev: Optional[str]) -> Tuple[str, Optional[str], List[str]]:
    """Restore project.json and scenes/ from rev (default: the last checkpoint). Returns (target, saved, trashed)."""
    ensure_repo(project)
    if not has_head(project):
        raise KbError("no checkpoints yet; make one with kb checkpoint first")
    dirty = bool(dirty_files(project))
    if rev:
        target = resolve_rev(project, rev)
    elif dirty:
        target = resolve_rev(project, "HEAD")
    else:
        prev = previous_rev(project)
        if not prev:
            raise KbError("nothing to undo: there is only one checkpoint and no changes since it")
        target = prev
    saved = checkpoint(project, "before kb undo") if dirty else None
    head_files = set(files_at(project, "HEAD"))
    target_files = files_at(project, target)
    if "project.json" not in target_files:
        raise KbError(f"checkpoint {target[:7]} has no project.json; pick another from kb history")
    run(project.root, ["checkout", target, "--"] + [p for p in TRACKED if any(f == p or f.startswith(p + "/") for f in target_files)])
    trashed: List[str] = []
    for rel in sorted(head_files - set(target_files)):
        if not rel.startswith("scenes/"):
            continue
        path = project.root / rel
        if path.is_file():
            trash(path)
            trashed.append(rel)
    if trashed:
        run(project.root, ["rm", "-q", "--cached", "--ignore-unmatch", "--"] + trashed, check=False)
    return target, saved, trashed


def diff(project: Project, rev: Optional[str], stat: bool) -> str:
    if repo_state(project) != "own":
        raise KbError("this project has no git history yet; kb checkpoint starts it", EXIT_ENV)
    if not has_head(project):
        return "no checkpoints yet; everything is new (kb checkpoint saves the first one)"
    base = resolve_rev(project, rev) if rev else "HEAD"
    paths = tracked_paths(project) or TRACKED
    args = ["diff", "--stat" if stat else "--no-color", base, "--"] + paths
    out = run(project.root, args, check=False).stdout
    untracked = run(project.root, ["ls-files", "--others", "--exclude-standard", "--"] + paths, check=False).stdout.split("\n")
    new = [u for u in untracked if u]
    if new:
        out += "".join(f"new (untracked): {u}\n" for u in new)
    return out or f"no changes to project.json or scenes/ since {base if rev else 'the last checkpoint'}"
