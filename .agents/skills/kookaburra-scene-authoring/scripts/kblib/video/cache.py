"""Per-project video scratch space under the bridge folder: analysis, drafts, frames, sheets and edit locks."""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple

from ..util import bridge_dir

SUBDIRS = ("analysis", "drafts", "frames", "sheets", "locks")
KEEP_DRAFTS = 3
MAX_AGE_S = 24 * 3600
MAX_BYTES = 1024 ** 3
PRUNED_DIRS = ("analysis", "drafts", "frames", "sheets")


def _slug(project: Any) -> str:
    return project.slug if hasattr(project, "slug") else Path(project).name


def root() -> Path:
    return bridge_dir() / "video"


def video_dir(project: Any) -> Path:
    """bridge_dir()/video/<slug>, with its subfolders created."""
    base = root() / _slug(project)
    for sub in SUBDIRS:
        (base / sub).mkdir(parents=True, exist_ok=True)
    return base


def subdir(project: Any, kind: str) -> Path:
    if kind not in SUBDIRS:
        raise ValueError(f"unknown video cache folder {kind}")
    return video_dir(project) / kind


def draft_path(project: Any, name: str, ext: str = "mp4") -> Path:
    """A fresh draft file; drafts are grouped per edit by the name before the first dot (edit names never hold one)."""
    stamp = f"{int(time.time() * 1000)}-{os.getpid()}"
    return subdir(project, "drafts") / f"{name}.{stamp}.{ext}"


def _files(base: Path) -> List[Tuple[Path, os.stat_result]]:
    out: List[Tuple[Path, os.stat_result]] = []
    for sub in PRUNED_DIRS:
        folder = base / sub
        try:
            walker = os.walk(folder)
        except OSError:
            continue
        for dirpath, _dirs, names in walker:
            for n in names:
                p = Path(dirpath) / n
                try:
                    out.append((p, p.stat()))
                except OSError:
                    continue
    return out


def _unlink(path: Path) -> bool:
    try:
        path.unlink()
        return True
    except OSError:
        return False


def prune(project: Any, now: float = 0.0) -> Dict[str, int]:
    """Last 3 drafts per edit, nothing older than 24 h, the whole folder under 1 GB (oldest first). Never fails."""
    removed = 0
    try:
        base = video_dir(project)
    except OSError:
        return {"removed": 0}
    now = now or time.time()
    drafts: Dict[str, List[Tuple[Path, os.stat_result]]] = {}
    for path, st in _files(base):
        if path.parent == base / "drafts":
            drafts.setdefault(path.name.split(".", 1)[0], []).append((path, st))
    for entries in drafts.values():
        entries.sort(key=lambda e: e[1].st_mtime, reverse=True)
        for path, _st in entries[KEEP_DRAFTS:]:
            removed += _unlink(path)
    remaining = []
    for path, st in _files(base):
        if now - st.st_mtime > MAX_AGE_S:
            removed += _unlink(path)
        else:
            remaining.append((path, st))
    total = sum(st.st_size for _p, st in remaining)
    if total > MAX_BYTES:
        for path, st in sorted(remaining, key=lambda e: e[1].st_mtime):
            if total <= MAX_BYTES:
                break
            if _unlink(path):
                removed += 1
                total -= st.st_size
    for sub in PRUNED_DIRS:
        for dirpath, dirs, names in os.walk(base / sub, topdown=False):
            if Path(dirpath) != base / sub and not dirs and not names:
                try:
                    os.rmdir(dirpath)
                except OSError:
                    pass
    return {"removed": removed}
