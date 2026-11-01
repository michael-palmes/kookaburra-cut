"""Folders kb owns inside a project. A shared folder keeps the links a pack refuses, so what is already at one of these
paths is never trusted. Standard library only until a refusal, since the Bash hooks import this."""

from __future__ import annotations

import errno
import os
import stat
from typing import Any

KB_DIR = ".kb"

def _refuse(path: Any, what: str) -> Exception:
    from .util import EXIT_PROBLEMS, KbError

    return KbError(f"{path} is {what}, so kb left it alone", EXIT_PROBLEMS, kind="not-a-folder")


def _failed(path: Any, verb: str, e: OSError) -> Exception:
    from .util import EXIT_ENV, KbError

    return KbError(f"cannot {verb} {path}: {e.strerror}", EXIT_ENV, kind="env")


def real_dir(root: Any, *parts: str, make: bool = True) -> Any:
    """root/parts as a real folder, made when missing (make=False only checks), in root's type. A link or file at any
    step is exit 1, kind "not-a-folder", naming it; root itself is the caller's."""
    path = os.fspath(root)
    for part in parts:
        path = os.path.join(path, part)
        try:
            if make:
                os.mkdir(path)
                continue
        except FileExistsError:
            pass
        except OSError as e:
            raise _failed(path, "create", e) from None
        try:
            if not stat.S_ISDIR(os.lstat(path).st_mode):
                raise _refuse(path, "a link or a file, not a folder")
        except FileNotFoundError:
            break
        except OSError as e:
            raise _failed(path, "read", e) from None
    return os.path.join(os.fspath(root), *parts) if isinstance(root, str) else root.joinpath(*parts)


def real_parent(path: Any, make: bool = True) -> None:
    """Before a write to path: inside a .kb/ every folder must be real; anywhere else the parent is just made."""
    from pathlib import Path

    parts = Path(path).parent.parts
    if KB_DIR in parts:
        at = len(parts) - 1 - parts[::-1].index(KB_DIR)
        real_dir(Path(*parts[:at]), *parts[at:], make=make)
    elif make:
        Path(path).parent.mkdir(parents=True, exist_ok=True)


def no_follow(path: Any, flags: int) -> int:
    """An `opener` for open(): a link at path fails with OSError instead of being written through."""
    return os.open(path, flags | os.O_NOFOLLOW, 0o666)


def open_own_file(path: Any, flags: int) -> int:
    """os.open(path, flags | O_CREAT) for a file kb owns; a link or folder there is refused, never opened through."""
    try:
        return os.open(path, flags | os.O_CREAT | os.O_NOFOLLOW, 0o644)
    except OSError as e:
        if e.errno in (errno.ELOOP, errno.EISDIR):
            raise _refuse(path, "a link or a folder, not a file") from None
        raise
