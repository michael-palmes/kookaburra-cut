"""Every kb write to project.json, scenes/** and .kb/**: the project lock, compare-and-swap writes, transactions.

A content hash is the lowercase hex SHA-256 of the file's bytes ("absent" when there is no file), the app's rule.
Each write re-hashes its target right before the rename, as live_edits.rs does; the app never takes the flock, so
the only race left is that last instant. Lock order: an edit lock before the project lock.
"""

from __future__ import annotations

import contextlib
import copy
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from .realdir import KB_DIR, open_own_file, real_dir, real_parent
from .util import EXIT_ENV, EXIT_PROBLEMS, EXIT_TRANSIENT, KbError, dump_json, load_json_text, now_ms

LOCK_WAIT_S = 10.0
RETRIES = 3
RETRY_AFTER_MS = 1000
ABSENT = "absent"
MANIFEST = "project.json"

_held: Dict[str, Tuple[int, int]] = {}


def _root(project: Any) -> Path:
    return Path(project) if isinstance(project, (str, os.PathLike)) else project.root


def _caller(caller: Any) -> Any:
    if caller is not None:
        return caller
    from . import identity

    return identity.current()


# ── locks ─────────────────────────────────────────────────────────────────────


class FileLock:
    """flock on path, reentrant within this process; the holder writes { pid, op, agent, atMs } into the file."""

    default_op = "a kb command"

    def __init__(self, path: Path, op: str, wait: Optional[float] = None, agent: Optional[str] = None) -> None:
        self.path = Path(path)
        self.op = op
        self.wait = LOCK_WAIT_S if wait is None else max(0.0, float(wait))
        self.agent = agent

    def busy(self, holder: str) -> KbError:
        return KbError(f"{self.path} is held: {holder}", EXIT_TRANSIENT, kind="locked", retry_after_ms=RETRY_AFTER_MS, data={"holder": self.holder_info()})

    def __enter__(self) -> "FileLock":
        key = str(self.path)
        if key in _held:
            fd, depth = _held[key]
            _held[key] = (fd, depth + 1)
            return self
        real_parent(self.path)
        fd = open_own_file(key, os.O_RDWR)
        deadline = time.monotonic() + self.wait
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as e:
                if e.errno not in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK):
                    os.close(fd)
                    raise
                if time.monotonic() >= deadline:
                    holder = self.holder()
                    os.close(fd)
                    raise self.busy(holder) from None
                time.sleep(0.05)
        try:
            os.ftruncate(fd, 0)
            os.write(fd, json.dumps({"pid": os.getpid(), "op": self.op, "agent": self.agent, "atMs": now_ms()}).encode("utf-8"))
        except OSError:
            pass
        _held[key] = (fd, 1)
        return self

    def holder_info(self) -> Dict[str, Any]:
        try:
            info = json.loads(self.path.read_text(encoding="utf-8") or "{}")
        except (OSError, ValueError):
            return {}
        return info if isinstance(info, dict) else {}

    def holder(self) -> str:
        info = self.holder_info()
        if not info.get("pid"):
            return "another kb command holds its lock"
        who = f" ({info['agent']})" if info.get("agent") else ""
        since = f", for {max(0, (now_ms() - int(info.get('atMs') or now_ms())) // 1000)} s" if info.get("atMs") else ""
        return f"pid {info.get('pid')}{who} is running {info.get('op') or self.default_op}{since}"

    def __exit__(self, *exc: Any) -> None:
        key = str(self.path)
        fd, depth = _held[key]
        if depth > 1:
            _held[key] = (fd, depth - 1)
            return
        del _held[key]
        try:
            os.ftruncate(fd, 0)
        except OSError:
            pass
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


class ProjectLock(FileLock):
    def busy(self, holder: str) -> KbError:
        return KbError(
            f"another kb command is changing this project: {holder}. Nothing was written",
            EXIT_TRANSIENT,
            kind="locked",
            hint="rerun in a moment, or pass --wait SECONDS",
            retry_after_ms=RETRY_AFTER_MS,
            data={"holder": self.holder_info()},
        )


def kb_dir(project: Any) -> Path:
    """The project's .kb/ folder; the first call makes it ignore itself (.gitignore "*", and .kb/ in .git/info/exclude)."""
    root = _root(project)
    folder = real_dir(root, KB_DIR)
    ignore = folder / ".gitignore"
    if not ignore.is_file():
        try:
            write_if_unchanged(ignore, ABSENT, b"*\n")
        except OSError as e:
            raise KbError(f"cannot create {folder}: {e.strerror}", EXIT_ENV, kind="env") from None
        from . import git as gitmod
        from .project import Project

        gitmod.ensure_excludes(Project(root))
    return folder


def project_lock(project: Any, op: str, wait: Optional[float] = None, caller: Any = None) -> FileLock:
    """.kb/lock, held for every kb write to the project; a busy lock past wait (10 s) is exit 3, kind "locked", naming the holder."""
    return ProjectLock(kb_dir(project) / "lock", op, wait, getattr(_caller(caller), "name", None))


# ── hashes and compare-and-swap ───────────────────────────────────────────────


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


HASH_CHUNK = 1 << 20


def file_sha256(path: Path) -> str:
    """The file's hash read in 1 MiB chunks (a large asset never sits in memory whole); "absent" when there is no file."""
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(HASH_CHUNK), b""):
                h.update(chunk)
    except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
        return ABSENT
    except OSError as e:
        raise KbError(f"cannot read {path}: {e.strerror}") from None
    return h.hexdigest()


def read_with_hash(path: Path) -> Tuple[Optional[bytes], str]:
    """(bytes, hash), or (None, "absent") when there is no file."""
    try:
        data = Path(path).read_bytes()
    except FileNotFoundError:
        return None, ABSENT
    except OSError as e:
        raise KbError(f"cannot read {path}: {e.strerror}") from None
    return data, sha256_hex(data)


def current_hash(path: Path) -> str:
    return file_sha256(path)


def _temp_beside(path: Path) -> str:
    real_parent(path)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".kbtmp", dir=str(path.parent))
    os.close(fd)
    return tmp


def _finish_temp(tmp: str, path: Path) -> None:
    try:
        mode = path.stat().st_mode & 0o777
    except OSError:
        mode = 0o644
    try:
        os.chmod(tmp, mode)
    except OSError:
        pass


def _land(tmp: str, path: Path, base: str) -> bool:
    """Move tmp onto path when path still hashes to base; "absent" creates without ever replacing a file."""
    _finish_temp(tmp, path)
    if base == ABSENT:
        try:
            os.link(tmp, str(path))
            return True
        except FileExistsError:
            return False
        except OSError:
            if path.exists():
                return False
            os.replace(tmp, str(path))
            return True
    if current_hash(path) != base:
        return False
    os.replace(tmp, str(path))
    return True


def write_if_unchanged(path: Path, base: str, data: bytes) -> bool:
    """Temp file in the same folder, fsync, re-hash the target, rename. False when the target no longer hashes to base."""
    path = Path(path)
    tmp = _temp_beside(path)
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        return _land(tmp, path, base)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def copy_if_absent(src: Path, path: Path) -> bool:
    """Copy a file in under a name that must still be free."""
    return copy_if_unchanged(src, path, ABSENT)


def copy_if_unchanged(src: Path, path: Path, base: str) -> bool:
    """Copy src to a temp file beside path, then land it as write_if_unchanged does (a large file is never read whole)."""
    tmp = _temp_beside(Path(path))
    try:
        shutil.copyfile(str(src), tmp)
        return _land(tmp, Path(path), base)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def link_if_unchanged(src: Path, path: Path, base: str) -> bool:
    """Give src's bytes the name path (a hard link; a copy where links fail), landing as write_if_unchanged does."""
    path = Path(path)
    tmp = _temp_beside(path)
    try:
        os.unlink(tmp)
        try:
            os.link(str(src), tmp)
        except OSError:
            shutil.copyfile(str(src), tmp)
        return _land(tmp, path, base)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def encode_json(value: Any) -> bytes:
    return dump_json(value).encode("utf-8")


def decode_json(data: bytes, label: str) -> Any:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise KbError(f"{label} is not UTF-8 text") from None
    return load_json_text(text, label)


class Conflict(KbError):
    """A file changed between kb's read and its write; transact() and mutate_json() re-apply the op."""

    def __init__(self, rel: str, base: str, current: str) -> None:
        super().__init__(
            f"{rel} changed while kb wrote it (it was {base[:12]}, now {current[:12]}); nothing was written",
            EXIT_TRANSIENT,
            kind="conflict",
            retry_after_ms=RETRY_AFTER_MS,
            data={"path": rel, "base": base, "current": current},
        )
        self.rel = rel


def exhausted(rel: str, tries: int) -> KbError:
    return KbError(
        f"{rel} kept changing while kb wrote it ({tries} tries; the app may be saving it); nothing was written",
        EXIT_TRANSIENT,
        kind="conflict",
        hint="rerun the command in a moment",
        retry_after_ms=RETRY_AFTER_MS,
        data={"path": rel},
    )


def pinned_conflict(rel: str, base: str, current: str) -> KbError:
    return KbError(
        f"{rel} changed since {base[:12]} (it is now {current[:12]}); nothing was written",
        EXIT_PROBLEMS,
        kind="conflict",
        hint=f"re-read {rel} and rerun with its current hash",
        data={"path": rel, "base": base, "current": current},
    )


# ── lease guard and journal (later modules; skipped while they do not exist) ──


def _optional(name: str) -> Any:
    full = f"{__package__}.{name}"
    if full in sys.modules:
        return sys.modules[full]
    try:
        if importlib.util.find_spec(full) is None:
            return None
    except (ImportError, ValueError):
        return None
    return importlib.import_module(full)


def guard(project: Any, caller: Any, rels: List[str]) -> None:
    leases = _optional("leases")
    if leases is not None and rels:
        leases.guard(project, caller, rels)


def refusals(project: Any, caller: Any, rels: List[str]) -> List[Dict[str, Any]]:
    """What guard() would refuse, touching nothing (dry runs report these instead of failing)."""
    leases = _optional("leases")
    check = getattr(leases, "check", None) if leases is not None else None
    return check(project, caller, rels) if check is not None and rels else []


def mark_refused(writes: List[Dict[str, Any]], found: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_path = {r["path"]: r for r in found}
    for w in writes:
        r = by_path.get(w["path"])
        if r is not None:
            w["refusal"] = {"code": "leased", "error": r["error"], "holder": r.get("holder"), "untilMs": r.get("untilMs")}
    return writes


def journal(project: Any, caller: Any, rels: List[str]) -> None:
    events = _optional("events")
    if events is None or not rels:
        return
    try:
        events.journal(project, "files.changed", caller, rels, via="kb")
    except Exception as e:  # the files are written; a journal failure must not undo the command's success
        sys.stderr.write(f"kb: note: could not journal files.changed ({type(e).__name__}: {e})\n")


# ── one file: mutate_json ─────────────────────────────────────────────────────


class Mutation:
    """mutate_json's outcome: the documents and hashes either side, whether it was written, and its plan."""

    def __init__(self, before: Any, after: Any, before_hash: str, after_hash: str, written: bool, attempts: int, writes: List[Dict[str, Any]], dry_run: bool) -> None:
        self.before = before
        self.after = after
        self.before_hash = before_hash
        self.after_hash = after_hash
        self.written = written
        self.attempts = attempts
        self.writes = writes
        self.dry_run = dry_run
        self.refusals: List[Dict[str, Any]] = []

    @property
    def rebased(self) -> bool:
        return self.attempts > 0


def mutate_json(
    project: Any,
    rel: Any,
    fn: Callable[[Any], Any],
    *,
    op: Optional[str] = None,
    base: Optional[str] = None,
    retries: int = RETRIES,
    caller: Any = None,
    wait: Optional[float] = None,
    dry_run: bool = False,
    lock: bool = True,
    label: Optional[str] = None,
) -> Mutation:
    """Read-modify-write one JSON file under the project lock.

    fn gets a fresh copy of the document (None when the file is absent) and returns the new one, or None to leave it.
    When the file changed between the read and the rename, fn is re-applied to the fresh document up to `retries`
    times, then exit 3 (kind "conflict"); a pinned base refuses at once (exit 1). rel is project-relative, or an
    absolute path outside the project with lock=False (workspace themes: compare-and-swap only).
    """
    root = _root(project)
    path = Path(rel) if Path(str(rel)).is_absolute() else root / str(rel)
    name = label or (str(rel) if not Path(str(rel)).is_absolute() else str(path))
    rels = [str(rel)] if lock else []
    who = _caller(caller)
    held = project_lock(project, op or f"kb write {name}", wait, who) if lock and not dry_run else contextlib.nullcontext()
    guarded = False
    with held:
        for attempt in range(retries + 1):
            data, sha = read_with_hash(path)
            if base is not None and base != sha:
                raise pinned_conflict(name, base, sha)
            before = None if data is None else decode_json(data, name)
            after = fn(copy.deepcopy(before))
            if after is None:
                return Mutation(before, before, sha, sha, False, attempt, [], dry_run)
            payload = encode_json(after)
            if payload == data:
                return Mutation(before, after, sha, sha, False, attempt, [], dry_run)
            writes = [{"path": name, "action": "create" if sha == ABSENT else "modify", "base": sha}]
            if dry_run:
                mut = Mutation(before, after, sha, sha, False, attempt, writes, True)
                mut.refusals = refusals(project, who, rels)
                mark_refused(writes, mut.refusals)
                return mut
            if not guarded:
                guard(project, who, rels)
                guarded = True
            if write_if_unchanged(path, sha, payload):
                _read_back(path, name)
                journal(project, who, rels)
                return Mutation(before, after, sha, sha256_hex(payload), True, attempt, writes, False)
    raise exhausted(name, retries + 1)


def _read_back(path: Path, label: str) -> None:
    try:
        json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise KbError(f"wrote {label} but it does not read back as JSON ({e}); restore it with kb undo") from None


def save_json(project: Any, rel: str, value: Any, base: Optional[str] = None, *, op: Optional[str] = None, caller: Any = None) -> str:
    """One locked compare-and-swap write of a whole document; base None takes whatever is there now. Returns the new hash."""
    payload = encode_json(value)
    path = _root(project) / rel
    who = _caller(caller)
    with project_lock(project, op or f"kb write {rel}", None, who):
        sha = current_hash(path)
        if base is not None and base != sha:
            raise Conflict(rel, base, sha)
        guard(project, who, [rel])
        if not write_if_unchanged(path, sha, payload):
            raise Conflict(rel, sha, current_hash(path))
        _read_back(path, rel)
        journal(project, who, [rel])
    return sha256_hex(payload)


# ── several files: project_txn and transact ───────────────────────────────────


class _Op:
    __slots__ = ("rel", "action", "base", "data", "src", "trash_fn", "landed", "move_from", "move_base")

    def __init__(self, rel: str, action: str, base: str, data: Optional[bytes] = None, src: Optional[Path] = None, trash_fn: Any = None,
                 move_from: Optional[str] = None, move_base: Optional[str] = None) -> None:
        self.rel = rel
        self.action = action
        self.base = base
        self.data = data
        self.src = src
        self.trash_fn = trash_fn
        self.landed: Optional[Tuple[int, int]] = None
        self.move_from = move_from
        self.move_base = move_base


class Txn:
    """A multi-file change: reads record base hashes; writes are planned, then committed together by commit()."""

    def __init__(self, project: Any, op: str, *, dry_run: bool = False, caller: Any = None, wait: Optional[float] = None) -> None:
        self.project = project
        self.root = _root(project)
        self.op = op
        self.dry_run = dry_run
        self.caller = _caller(caller)
        self.wait = wait
        self.attempt = 0
        self.committed = False
        self.refusals: List[Dict[str, Any]] = []
        self._bases: Dict[str, str] = {}
        self._data: Dict[str, Optional[bytes]] = {}
        self._ops: Dict[str, _Op] = {}

    def read(self, rel: str) -> Tuple[Optional[bytes], str]:
        """The file's bytes and base hash ("absent" when missing); a later write of rel checks against this base."""
        planned = self._ops.get(rel)
        if planned is not None and planned.data is not None:
            return planned.data, sha256_hex(planned.data)
        data, sha = read_with_hash(self.root / rel)
        if rel not in self._bases:
            self._bases[rel] = sha
            self._data[rel] = data
        return data, sha

    def read_json(self, rel: str, label: Optional[str] = None) -> Tuple[Any, str]:
        data, sha = self.read(rel)
        return (None if data is None else decode_json(data, label or rel)), sha

    def hash(self, rel: str) -> str:
        """The file's base hash, streamed (a large asset is never read into memory); later ops on rel check against it."""
        if rel not in self._bases:
            self._bases[rel] = current_hash(self.root / rel)
        return self._bases[rel]

    def _base(self, rel: str, create_only: bool, base: Optional[str]) -> str:
        if base is not None:
            return base
        if create_only:
            current = current_hash(self.root / rel)
            if current != ABSENT:
                raise Conflict(rel, ABSENT, current)
            return ABSENT
        if rel in self._bases:
            return self._bases[rel]
        return current_hash(self.root / rel)

    def write_bytes(self, rel: str, data: bytes, *, create_only: bool = False, base: Optional[str] = None) -> None:
        b = self._base(rel, create_only, base)
        self._ops[rel] = _Op(rel, "create" if b == ABSENT else "modify", b, data=data)

    def write_text(self, rel: str, text: str, *, create_only: bool = False, base: Optional[str] = None) -> None:
        self.write_bytes(rel, text.encode("utf-8"), create_only=create_only, base=base)

    def write_json(self, rel: str, value: Any, *, create_only: bool = False, base: Optional[str] = None) -> None:
        self.write_bytes(rel, encode_json(value), create_only=create_only, base=base)

    def copy_in(self, rel: str, src: Path) -> None:
        """Copy a file in (assets) under a name that must still be free at commit."""
        b = self._base(rel, True, None)
        self._ops[rel] = _Op(rel, "create", b, src=Path(src))

    def copy_over(self, rel: str, src: Path, base: Optional[str] = None) -> None:
        """Copy src onto rel at commit while rel still hashes to base (default: its hash now; "absent" creates)."""
        b = base if base is not None else self.hash(rel)
        self._ops[rel] = _Op(rel, "create" if b == ABSENT else "modify", b, src=Path(src))

    def move(self, rel: str, dest: str, *, base: Optional[str] = None, dest_base: str = ABSENT) -> None:
        """Move rel to dest at commit: dest gets rel's bytes (a hard link, else a copy) while dest still hashes to
        dest_base ("absent": a new name), and rel goes once every write landed, unless another op writes rel."""
        b = base if base is not None else self.hash(rel)
        if b == ABSENT:
            raise KbError(f"{rel} does not exist, so it can't be moved", EXIT_PROBLEMS, kind="invalid")
        self._ops[dest] = _Op(dest, "create" if dest_base == ABSENT else "modify", dest_base, move_from=rel, move_base=b)

    def trash(self, rel: str, trash_fn: Callable[[Path], Any]) -> None:
        """Move rel to the Trash at commit, after every write (a missing file is no change)."""
        b = self._base(rel, False, None)
        if b != ABSENT:
            self._ops[rel] = _Op(rel, "trash", b, trash_fn=trash_fn)

    def planned(self, rel: str) -> bool:
        return rel in self._ops

    def _vacated(self) -> List[_Op]:
        """Moves whose source goes at the end (no other op writes it)."""
        return [o for o in self._ops.values() if o.move_from is not None and o.move_from not in self._ops]

    @property
    def writes(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for o in self._order():
            w: Dict[str, Any] = {"path": o.rel, "action": o.action, "base": o.base}
            if o.move_from is not None:
                w["from"] = o.move_from
            out.append(w)
        out += [{"path": o.move_from, "action": "delete", "base": o.move_base, "to": o.rel} for o in self._vacated()]
        return mark_refused(out, self.refusals)

    def _order(self) -> List[_Op]:
        ops = list(self._ops.values())
        rank = {"create": 0, "modify": 1, "trash": 3}
        return sorted(ops, key=lambda o: 2 if o.rel == MANIFEST and o.action != "trash" else rank[o.action])

    def _touched(self, ordered: List[_Op]) -> List[str]:
        return [o.rel for o in ordered] + [str(o.move_from) for o in self._vacated()]

    def commit(self) -> None:
        """Lock, lease guard, verify every base, write new files first and project.json last, trash, drop moved
        sources, journal."""
        if not self._ops:
            return
        ordered = self._order()
        touched = self._touched(ordered)
        if self.dry_run:
            self.refusals = refusals(self.project, self.caller, touched)
            return
        with project_lock(self.project, self.op, self.wait, self.caller):
            guard(self.project, self.caller, touched)
            for rel in touched:
                real_parent(self.root / rel, make=False)
            for o in ordered:
                now = current_hash(self.root / o.rel)
                if now != o.base:
                    raise Conflict(o.rel, o.base, now)
                if o.move_from is not None:
                    now = current_hash(self.root / o.move_from)
                    if now != o.move_base:
                        raise Conflict(o.move_from, o.move_base or ABSENT, now)
            done: List[_Op] = []
            for o in ordered:
                path = self.root / o.rel
                if o.action == "trash":
                    if current_hash(path) != o.base:
                        self._undo(done)
                        raise Conflict(o.rel, o.base, current_hash(path))
                    o.trash_fn(path)
                    continue
                if o.move_from is not None:
                    ok = link_if_unchanged(self.root / o.move_from, path, o.base)
                elif o.src is not None:
                    ok = copy_if_unchanged(o.src, path, o.base)
                else:
                    ok = write_if_unchanged(path, o.base, o.data or b"")
                if not ok:
                    self._undo(done)
                    raise Conflict(o.rel, o.base, current_hash(path))
                try:
                    st = path.stat()
                    o.landed = (st.st_dev, st.st_ino)
                except OSError:
                    o.landed = None
                done.append(o)
            for o in self._vacated():
                self._drop_source(o)
            self.committed = True
            journal(self.project, self.caller, touched)

    def _drop_source(self, o: _Op) -> None:
        """A move's source once its bytes landed: unlinked while it is still the same file, or still hashes the same."""
        src = self.root / str(o.move_from)
        try:
            st = src.stat()
        except OSError:
            return
        same = o.landed is not None and (st.st_dev, st.st_ino) == o.landed
        if same or current_hash(src) == o.move_base:
            try:
                src.unlink()
            except OSError:
                pass

    def _undo(self, done: List[_Op]) -> None:
        """Best effort: take back this commit's earlier writes when a later one lost its race."""
        for o in reversed(done):
            path = self.root / o.rel
            try:
                st = path.stat()
                ours = o.landed == (st.st_dev, st.st_ino)
            except OSError:
                continue
            if not ours:
                continue
            if o.action == "create":
                try:
                    path.unlink()
                except OSError:
                    pass
                continue
            keeper = next((d for d in done if d.move_from == o.rel), None)
            if keeper is not None:
                link_if_unchanged(self.root / keeper.rel, path, current_hash(path))
            elif self._data.get(o.rel) is not None and o.data is not None:
                write_if_unchanged(path, sha256_hex(o.data), self._data[o.rel] or b"")


@contextlib.contextmanager
def project_txn(project: Any, op: str, dry_run: bool = False, caller: Any = None, wait: Optional[float] = None) -> Iterator[Txn]:
    """One attempt: plan reads and writes in the body; on a clean exit commit() writes them, or raises Conflict (exit 3)."""
    tx = Txn(project, op, dry_run=dry_run, caller=caller, wait=wait)
    yield tx
    tx.commit()


def transact(
    project: Any,
    op: str,
    fn: Callable[[Txn], Any],
    *,
    dry_run: bool = False,
    caller: Any = None,
    wait: Optional[float] = None,
    retries: int = RETRIES,
) -> Tuple[Any, Txn]:
    """fn(tx) plans a change from fresh reads, under the project lock; a Conflict re-runs it up to `retries` times, then exit 3."""
    who = _caller(caller)
    held = project_lock(project, op, wait, who) if not dry_run else contextlib.nullcontext()
    last: Optional[Conflict] = None
    with held:
        for attempt in range(retries + 1):
            tx = Txn(project, op, dry_run=dry_run, caller=who, wait=wait)
            tx.attempt = attempt
            try:
                result = fn(tx)
                tx.commit()
                return result, tx
            except Conflict as e:
                last = e
    raise exhausted(last.rel if last is not None else "the project", retries + 1)


class WriteOpts:
    """How a structural command writes: --dry-run, --wait for the project lock, and who is asking."""

    __slots__ = ("dry_run", "wait", "caller")

    def __init__(self, dry_run: bool = False, wait: Optional[float] = None, caller: Any = None) -> None:
        self.dry_run = dry_run
        self.wait = wait
        self.caller = caller
