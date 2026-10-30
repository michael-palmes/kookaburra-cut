"""Git checkpoints of project.json, scenes/ and edits/: checkpoint (whole or scoped to scenes), history, undo, diff."""

from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .project import MANIFEST, Project
from .util import EXIT_ENV, EXIT_PROBLEMS, EXIT_TRANSIENT, KbError, ago, now_ms, trash_dir

TRACKED = ["project.json", "scenes", "edits"]
EXCLUDES = ["/assets/", "/exports/", "edits/*.json.tmp", "edits/.*.tmp", "edits/.renders/", ".kb/", "/kb"]
FALLBACK_IDENTITY = ["-c", "user.name=Kookaburra Cut", "-c", "user.email=kookaburra@localhost"]
INDEX_LOCK_BACKOFF_MS = (50, 100, 200, 400, 800, 1600)
STALE_LOCK_S = 60
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


def index_lock_age_ms(root: Path) -> Optional[int]:
    try:
        return max(0, int((time.time() - (root / ".git" / "index.lock").stat().st_mtime) * 1000))
    except OSError:
        return None


def index_locked(root: Path, args: List[str]) -> KbError:
    """Exit 3 once the backoff is spent; the hint names the lock's age, and kb never deletes it."""
    age = index_lock_age_ms(root)
    if age is not None and age >= STALE_LOCK_S * 1000:
        hint = (f"rerun in a moment. .git/index.lock is {ago(now_ms() - age).replace(' ago', ' old')}, so it may be stale "
                "(a crashed git leaves it behind): if no git command is running, ask the user to remove it")
    else:
        hint = "rerun in a moment; another git command (an agent's git add or commit) holds .git/index.lock"
    return KbError(
        f"git {args[0]} could not run: .git/index.lock is held by another git process",
        EXIT_TRANSIENT,
        kind="index-locked",
        hint=hint,
        retry_after_ms=2000,
        data={"lockAgeMs": age},
    )


def run(root: Path, args: List[str], check: bool = True, timeout: float = 30) -> subprocess.CompletedProcess:
    """git in the project; a failure naming index.lock is retried (50 ms doubling to 1.6 s), then exit 3 kind index-locked."""
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0", LC_ALL="C")
    env.pop("GIT_DIR", None)
    env.pop("GIT_WORK_TREE", None)
    env.pop("GIT_INDEX_FILE", None)
    for attempt in range(len(INDEX_LOCK_BACKOFF_MS) + 1):
        try:
            proc = subprocess.run(["git", "-c", "core.quotepath=off", "-C", str(root)] + args, capture_output=True, text=True, timeout=timeout, env=env)
        except subprocess.TimeoutExpired:
            raise KbError(f"git {args[0]} timed out after {int(timeout)} s", EXIT_TRANSIENT, kind="transient", retry_after_ms=5000) from None
        except OSError as e:
            raise KbError(f"git could not run ({e.strerror})", EXIT_ENV) from None
        if proc.returncode == 0 or "index.lock" not in proc.stderr:
            break
        if attempt == len(INDEX_LOCK_BACKOFF_MS):
            if check:
                raise index_locked(root, args)
            return proc
        time.sleep(INDEX_LOCK_BACKOFF_MS[attempt] / 1000)
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
    ensure_excludes(project)


def ensure_excludes(project: Project) -> None:
    """Footage, renders, edit temp files and render records never enter a checkpoint (the app writes the same lines at `git init`)."""
    path = project.root / ".git" / "info" / "exclude"
    if not (project.root / ".git").is_dir():
        return
    try:
        current = path.read_text(encoding="utf-8") if path.is_file() else ""
    except OSError:
        return
    missing = [line for line in EXCLUDES if line not in current.splitlines()]
    if not missing:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            if current and not current.endswith("\n"):
                f.write("\n")
            f.write("".join(f"{line}\n" for line in missing))
    except OSError:
        pass


def checkpoint_before(project: Project, what: str) -> Optional[str]:
    """A checkpoint before a destructive change, when there is anything unsaved; never fails the caller."""
    if not git_available():
        return None
    try:
        state = repo_state(project)
        if state == "foreign":
            return None
        ensure_repo(project)
        if not has_head(project) or dirty_files(project):
            return checkpoint(project, f"before {what}")
    except KbError:
        return None
    return None


def edit_hashes(project: Project) -> Dict[str, str]:
    """edits/<name>.json content hashes, to tell which edit docs an undo changed."""
    import hashlib

    out: Dict[str, str] = {}
    folder = project.root / "edits"
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return out
    for n in names:
        if n.endswith(".json") and not n.startswith(("_", ".")):
            try:
                out[n[:-5]] = hashlib.sha256((folder / n).read_bytes()).hexdigest()
            except OSError:
                continue
    return out


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


def dirty_files(project: Project, paths: Optional[List[str]] = None) -> List[str]:
    paths = tracked_paths(project) if paths is None else paths
    if not paths:
        return []
    proc = run(project.root, ["status", "--porcelain", "--untracked-files=all", "--"] + paths, check=False)
    return [line[3:] for line in proc.stdout.splitlines() if line.strip()]


def scene_paths(stem: str) -> List[str]:
    return [f"scenes/{stem}.tsx", f"scenes/{stem}.json"]


def known_paths(project: Project, paths: List[str]) -> List[str]:
    """The paths that are on disk, in the index or in HEAD (git refuses a pathspec that matches nothing)."""
    keep = [p for p in paths if (project.root / p).exists()]
    rest = [p for p in paths if p not in keep]
    if rest:
        found = set(run(project.root, ["ls-files", "--"] + rest, check=False).stdout.splitlines())
        if has_head(project):
            found |= set(run(project.root, ["ls-tree", "-r", "--name-only", "HEAD", "--"] + rest, check=False).stdout.splitlines())
        keep += [p for p in rest if p in found]
    return [p for p in paths if p in keep]


def _caller(caller: Any) -> Any:
    if caller is not None:
        return caller
    from . import identity as ident

    return ident.current()


def _journal(project: Project, kind: str, caller: Any, **fields: Any) -> None:
    try:
        from . import events

        events.append(project, kind, _caller(caller), **fields)
    except Exception:  # history is written; a journal failure must not fail the command
        pass


def _named(caller: Any) -> Optional[str]:
    from .leases import named

    name = getattr(caller, "name", None)
    return name if named(name) else None


def checkpoint(project: Project, message: str, scenes: Optional[List[str]] = None, files: Optional[List[str]] = None, caller: Any = None,
               wait: Optional[float] = None) -> Optional[str]:
    """Commit project.json, scenes/ and edits/ (or only the given scenes' files and paths) under the project lock.

    Returns the short hash, or None when nothing changed.
    """
    from . import lock

    ensure_repo(project)
    who = _caller(caller)
    with lock.project_lock(project, "kb checkpoint", wait, who):
        return _commit(project, message, scenes, files, who)


def _commit(project: Project, message: str, scenes: Optional[List[str]], files: Optional[List[str]], who: Any) -> Optional[str]:
    scoped = bool(scenes or files)
    if scoped:
        wanted: List[str] = []
        for rel in [p for s in scenes or [] for p in scene_paths(s)] + list(files or []):
            if rel not in wanted:
                wanted.append(rel)
        paths = known_paths(project, wanted)
        if not paths:
            raise KbError(f"nothing to checkpoint: {', '.join(wanted)} exist neither on disk nor in a checkpoint")
    else:
        paths = tracked_paths(project)
        if not paths:
            raise KbError("nothing to checkpoint: no project.json or scenes/ here")
    if has_head(project) and not dirty_files(project, paths):
        return None
    run(project.root, ["add", "-A", "--"] + paths)
    if has_head(project):
        staged = run(project.root, ["diff", "--cached", "--quiet", "--"] + paths, check=False)
        if staged.returncode == 0:
            return None
    name = _named(who)
    tag = f" [{name}]" if name else ""
    if scoped:
        subject = f"checkpoint({','.join(scenes) if scenes else 'files'}): {message}{tag}"
    else:
        subject = (message if message.startswith("checkpoint") else f"checkpoint: {message}") + tag
    run(project.root, identity(project) + ["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "--only", "-m", subject, "--"] + paths)
    rev = run(project.root, ["rev-parse", "--short", "HEAD"]).stdout.strip()
    _journal(project, "checkpoint", who, rev=rev, message=message, scenes=scenes or None, files=paths if scoped else None)
    return rev


def last_checkpoint(project: Project) -> Optional[Tuple[str, int]]:
    """(short hash, commit time ms) of the newest commit touching the tracked set; reads only."""
    proc = run(project.root, ["log", "-n1", "--format=%h %ct", "--"] + TRACKED, check=False)
    parts = proc.stdout.split()
    if len(parts) == 2 and parts[1].isdigit():
        return parts[0], int(parts[1]) * 1000
    return None


def history(project: Project, limit: int, paths: Optional[List[str]] = None) -> List[Dict[str, str]]:
    if repo_state(project) != "own" or not has_head(project):
        return []
    paths = paths or tracked_paths(project) or TRACKED
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


def commit_ms(project: Project, rev: str) -> int:
    out = run(project.root, ["log", "-n1", "--format=%ct", rev], check=False).stdout.strip()
    return int(out) * 1000 if out.isdigit() else 0


def files_at(project: Project, rev: str, paths: Optional[List[str]] = None) -> List[str]:
    proc = run(project.root, ["ls-tree", "-r", "--name-only", rev, "--"] + (paths or TRACKED), check=False)
    return [line for line in proc.stdout.splitlines() if line]


def show_json(project: Project, rev: str, rel: str) -> Any:
    proc = run(project.root, ["show", f"{rev}:{rel}"], check=False)
    if proc.returncode != 0:
        return None
    try:
        return json.loads(proc.stdout)
    except ValueError:
        return None


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


# ── undo ──────────────────────────────────────────────────────────────────────


def undo_target(project: Project, rev: Optional[str]) -> Tuple[str, bool]:
    """(target, dirty): REV, else HEAD when anything changed since it, else the checkpoint before HEAD."""
    if not has_head(project):
        raise KbError("no checkpoints yet; make one with kb checkpoint first")
    dirty = bool(dirty_files(project))
    if rev:
        return resolve_rev(project, rev), dirty
    if dirty:
        return resolve_rev(project, "HEAD"), dirty
    prev = previous_rev(project)
    if not prev:
        raise KbError("nothing to undo: there is only one checkpoint and no changes since it")
    return prev, dirty


def changed_since(project: Project, target: str, paths: Optional[List[str]] = None) -> List[str]:
    """Files an undo to target would restore or trash: the diff against target plus untracked files."""
    paths = paths or tracked_paths(project) or TRACKED
    changed = run(project.root, ["diff", "--name-only", target, "--"] + paths, check=False).stdout.splitlines()
    untracked = run(project.root, ["ls-files", "--others", "--exclude-standard", "--"] + paths, check=False).stdout.splitlines()
    return sorted({r for r in changed + untracked if r})


def _by_label(root: str, by: Any) -> str:
    from .leases import bound_name, who

    name, session, agent = who(by)
    if name:
        return str(name)
    bound = bound_name(root, session, agent)
    return bound or f"session {str(session or '?')[:8]} ({agent or 'main'})"


def others_changed(project: Project, target: str, caller: Any, changed: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """[{ path, by }] for files another agent wrote since target (the journal) or that another agent leases."""
    from . import events, leases

    root = str(project.root)
    who = leases.resolve(root, _caller(caller))
    changed = changed if changed is not None else changed_since(project, target)
    last = events.changed_by(root, commit_ms(project, target))
    out: List[Dict[str, Any]] = []
    for rel in changed:
        by = last.get(rel)
        if by is not None and not leases.same_caller(root, by, who):
            out.append({"path": rel, "by": _by_label(root, by)})
            continue
        stem = leases.scene_of(rel)
        lease = leases.read(root, stem) if stem else None
        if lease is not None and not leases.is_holder(root, lease, who):
            out.append({"path": rel, "by": leases.holder_name(lease), "leased": True})
    return out


def refuse_others(target: str, others: List[Dict[str, Any]]) -> KbError:
    names = sorted({o["by"] for o in others})
    shown = ", ".join(f"{o['path']} ({o['by']})" for o in others[:5]) + (f" and {len(others) - 5} more" if len(others) > 5 else "")
    stems = sorted({p[len("scenes/"):].rsplit(".", 1)[0] for p in (o["path"] for o in others) if p.startswith("scenes/")})
    return KbError(
        f"kb undo to {target[:7]} would also revert work by {', '.join(names)}: {shown}. Nothing was changed",
        EXIT_PROBLEMS,
        kind="others-changed",
        hint="undo only your own scene with ./kb undo --scene S, or pass --all to revert everyone's changes",
        data={"files": others, "target": target, "theirScenes": stems},
    )


def undo(project: Project, rev: Optional[str], caller: Any = None, everything: bool = False) -> Tuple[str, Optional[str], List[str]]:
    """Restore project.json, scenes/ and edits/ from rev (default: the last checkpoint); only scene files are ever trashed.

    Refuses (exit 1, others-changed) when another agent changed or leases a file it would revert, unless everything.
    Returns (target, saved, trashed).
    """
    ensure_repo(project)
    who = _caller(caller)
    target, dirty = undo_target(project, rev)
    changed = changed_since(project, target)
    if not everything:
        others = others_changed(project, target, who, changed)
        if others:
            raise refuse_others(target, others)
    saved = checkpoint(project, "before kb undo", caller=who) if dirty else None
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
    _journal(project, "undo", who, target=target[:12], files=changed or None, trashed=trashed or None, all=everything or None)
    if changed:
        try:
            from . import events

            events.journal(project, "files.changed", who, changed, via="kb")
        except Exception:
            pass
    return target, saved, trashed


def undo_plan(project: Project, rev: Optional[str], caller: Any = None, everything: bool = False) -> Dict[str, Any]:
    """What kb undo would do, touching nothing: the target, each file it restores or trashes, and who else it would revert."""
    from . import lock

    require_git()
    if repo_state(project) != "own" or not has_head(project):
        raise KbError("no checkpoints yet; make one with kb checkpoint first")
    target, dirty = undo_target(project, rev)
    target_files = set(files_at(project, target))
    if "project.json" not in target_files:
        raise KbError(f"checkpoint {target[:7]} has no project.json; pick another from kb history")
    changed = changed_since(project, target)
    writes: List[Dict[str, Any]] = []
    for rel in changed:
        path = project.root / rel
        if rel in target_files:
            writes.append({"path": rel, "action": "modify" if path.is_file() else "create", "base": lock.current_hash(path)})
        elif rel.startswith("scenes/") and path.is_file():
            writes.append({"path": rel, "action": "trash", "base": lock.current_hash(path)})
    others = [] if everything else others_changed(project, target, caller, changed)
    refusals = [{"path": o["path"], "code": "others-changed", "by": o["by"], "error": f"{o['path']} was changed by {o['by']}"} for o in others]
    return {"target": target, "checkpointFirst": dirty, "writes": writes, "refusals": refusals}


def scene_target(project: Project, stem: str, rev: Optional[str]) -> Tuple[str, bool]:
    """(target, dirty) for one scene: REV, else HEAD when its files changed, else the parent of the last commit that touched them."""
    if not has_head(project):
        raise KbError("no checkpoints yet; make one with kb checkpoint first")
    paths = scene_paths(stem)
    dirty = bool(dirty_files(project, known_paths(project, paths)))
    if rev:
        return resolve_rev(project, rev), dirty
    if dirty:
        return resolve_rev(project, "HEAD"), dirty
    last = run(project.root, ["log", "-n1", "--format=%H", "--"] + paths, check=False).stdout.strip()
    if not last:
        raise KbError(f"nothing to undo for {stem}: no checkpoint has touched scenes/{stem}.tsx or scenes/{stem}.json")
    parent = run(project.root, ["rev-parse", "--verify", "-q", f"{last}^"], check=False)
    if parent.returncode != 0:
        raise KbError(f"nothing to undo for {stem}: its files first appear in the first checkpoint, so there is no earlier version")
    return parent.stdout.strip(), dirty


def _entry_for(manifest: Any, file: str) -> Optional[Dict[str, Any]]:
    scenes = manifest.get("scenes") if isinstance(manifest, dict) else None
    for entry in scenes if isinstance(scenes, list) else []:
        if isinstance(entry, dict) and entry.get("file") == file:
            return entry
    return None


def splice_entry(current: Any, target_manifest: Any, file: str) -> Tuple[Any, str]:
    """(new manifest or None, note): the scene's own project.json entry taken from target_manifest, keeping its file reference."""
    if not isinstance(current, dict) or not isinstance(target_manifest, dict):
        return None, "project.json could not be read at both ends, so it was left alone"
    if current.get("version") != target_manifest.get("version"):
        return None, "project.json changed format since then (version), so its entry was left alone"
    now, then = _entry_for(current, file), _entry_for(target_manifest, file)
    stem = file[len("scenes/"):-len(".tsx")]
    if now is None and then is None:
        return None, f"{stem} is in project.json at neither end, so the manifest was left alone"
    if now is None:
        return None, f"{stem} was removed from project.json since then; the manifest was left alone (register it again with ./kb scene add {stem})"
    if then is None:
        return None, f"{stem} was added to project.json since then; the manifest was left alone (./kb scene remove {stem} drops it)"
    entry = copy.deepcopy(then)
    entry["file"] = now.get("file")
    if entry == now:
        return None, ""
    out = copy.deepcopy(current)
    for i, e in enumerate(out["scenes"]):
        if isinstance(e, dict) and e.get("file") == file:
            out["scenes"][i] = entry
            break
    return out, f"restored {stem}'s project.json entry (duration, transition, effects)"


def undo_scene(project: Project, stem: str, rev: Optional[str], caller: Any = None, wait: Optional[float] = None, dry_run: bool = False) -> Dict[str, Any]:
    """Restore one scene: scenes/<stem>.tsx and .json from the target and its own project.json entry by compare-and-swap.

    A scoped checkpoint comes first, so it is undoable; only the scene's own files are trashed; other agents' files and new
    scenes are never touched. Returns { target, checkpoint, restored, trashed, manifest, notes, writes, refusals }.
    """
    from . import leases, lock

    ensure_repo(project)
    who = _caller(caller)
    target, dirty = scene_target(project, stem, rev)
    paths = scene_paths(stem)
    file = paths[0]
    at_target = set(files_at(project, target, paths))
    if file not in at_target:
        raise KbError(
            f"{stem} did not exist at checkpoint {target[:7]}, so there is nothing to undo it to",
            EXIT_PROBLEMS,
            kind="invalid",
            hint=f"remove the scene with ./kb scene remove {stem}",
        )
    target_manifest = show_json(project, target, MANIFEST)
    changed = changed_since(project, target, paths)
    writes: List[Dict[str, Any]] = []
    for rel in changed:
        path = project.root / rel
        if rel in at_target:
            writes.append({"path": rel, "action": "modify" if path.is_file() else "create", "base": lock.current_hash(path)})
        elif path.is_file():
            writes.append({"path": rel, "action": "trash", "base": lock.current_hash(path)})
    try:
        current = json.loads((project.root / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        current = None
    spliced, note = splice_entry(current, target_manifest, file)
    notes = [n for n in [note] if n]
    if spliced is not None:
        writes.append({"path": MANIFEST, "action": "modify", "base": lock.current_hash(project.root / MANIFEST)})
    result: Dict[str, Any] = {"target": target, "scene": stem, "checkpointFirst": dirty, "checkpoint": None, "restored": [], "trashed": [],
                              "manifest": spliced is not None, "notes": notes, "writes": writes, "refusals": [], "dryRun": dry_run}
    if dry_run:
        result["refusals"] = leases.check(project, who, paths)
        lock.mark_refused(writes, result["refusals"])
        return result
    with lock.project_lock(project, f"kb undo --scene {stem}", wait, who):
        leases.guard(project, who, paths)
        result["checkpoint"] = checkpoint(project, f"before kb undo --scene {stem}", scenes=[stem], caller=who) if dirty else None
        restore = [p for p in changed if p in at_target]
        if restore:
            run(project.root, ["checkout", target, "--"] + restore)
        trashed: List[str] = []
        for rel in changed:
            path = project.root / rel
            if rel not in at_target and path.is_file():
                trash(path)
                trashed.append(rel)
        if trashed:
            run(project.root, ["rm", "-q", "--cached", "--ignore-unmatch", "--"] + trashed, check=False)
        result["restored"], result["trashed"] = restore, trashed

        def splice(doc: Any) -> Any:
            out, again = splice_entry(doc, target_manifest, file)
            if again and again != note:
                notes[:] = [again]
            return out

        if spliced is not None:
            mut = lock.mutate_json(project, MANIFEST, splice, op=f"kb undo --scene {stem}", caller=who, wait=wait)
            result["manifest"] = mut.written
    if restore or trashed:
        try:
            from . import events

            events.journal(project, "files.changed", who, restore + trashed, via="kb")
        except Exception:
            pass
    _journal(project, "undo", who, target=target[:12], scene=stem, files=(restore + trashed) or None, manifest=result["manifest"] or None)
    result["notes"] = notes
    return result


def diff(project: Project, rev: Optional[str], stat: bool, paths: Optional[List[str]] = None) -> str:
    if repo_state(project) != "own":
        raise KbError("this project has no git history yet; kb checkpoint starts it", EXIT_ENV)
    if not has_head(project):
        return "no checkpoints yet; everything is new (kb checkpoint saves the first one)"
    base = resolve_rev(project, rev) if rev else "HEAD"
    where = ", ".join(paths) if paths else "project.json, scenes/ or edits/"
    paths = paths or tracked_paths(project) or TRACKED
    args = ["diff", "--stat" if stat else "--no-color", base, "--"] + paths
    out = run(project.root, args, check=False).stdout
    untracked = run(project.root, ["ls-files", "--others", "--exclude-standard", "--"] + paths, check=False).stdout.split("\n")
    new = [u for u in untracked if u]
    if new:
        out += "".join(f"new (untracked): {u}\n" for u in new)
    return out or f"no changes to {where} since {base if rev else 'the last checkpoint'}"
