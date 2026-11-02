"""The coordination feed: kb's journal in .kb/events.jsonl, the follower (which adds app events from the heartbeat), and shared notes.

Appends are one O_APPEND write() per event with no lock, so this module stays light enough for the Bash hooks; only
rotation (past 1 MiB, keeping events.1.jsonl) takes the project lock. The app never writes into a project.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from typing import Any, Callable, Dict, IO, Iterable, List, Optional, Tuple

from .leases import as_by, root_of, same_caller
from .realdir import no_follow, open_own_file, real_dir

VERSION = 1
EVENTS = "events.jsonl"
EVENTS_OLD = "events.1.jsonl"
EVENTS_MAX = 1 << 20
LINE_MAX = 4096
NOTES = "notes.md"
NOTES_OLD = "notes.1.md"
NOTES_MAX = 256 * 1024
NOTE_SHOWN = 160
EXIT_AFTER_S = 1740
HEARTBEAT_POLL_S = 1.0
APP_BY = {"name": "app", "session": None, "agentId": None}
QUIET_KINDS = ("files.changed",)
NOTE_LINE = re.compile(r"^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) · ([A-Za-z0-9._-]+)(?: · ([A-Za-z0-9._-]+))?: (.*)$")


def now_ms() -> int:
    return int(time.time() * 1000)


def kb_path(root: str, *parts: str) -> str:
    return os.path.join(root, ".kb", *parts)


def ensure_kb(root: str) -> str:
    """.kb/ that ignores itself, made without kblib.lock's imports (the Bash hooks call this)."""
    folder = real_dir(root, ".kb")
    ignore = os.path.join(folder, ".gitignore")
    if os.path.isfile(ignore):
        return folder
    try:
        fd = os.open(ignore, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        try:
            os.write(fd, b"*\n")
        finally:
            os.close(fd)
    except FileExistsError:
        pass
    exclude = os.path.join(root, ".git", "info", "exclude")
    if os.path.isdir(os.path.join(root, ".git")):
        try:
            with open(exclude, "a+", encoding="utf-8", opener=no_follow) as f:
                f.seek(0)
                current = f.read()
                if ".kb/" not in current.splitlines():
                    f.write(("" if not current or current.endswith("\n") else "\n") + ".kb/\n")
        except OSError:
            pass
    return folder


# ── the journal ───────────────────────────────────────────────────────────────


def new_id(at: int) -> str:
    return f"{at}-{os.getpid()}-{os.urandom(3).hex()}"


def encode(event: Dict[str, Any]) -> bytes:
    """One compact line under 4 KB: long lists keep their head (plus a count), long strings are clipped."""
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    if len(line.encode("utf-8")) < LINE_MAX:
        return (line + "\n").encode("utf-8")
    slim = dict(event)
    for key, value in list(slim.items()):
        if isinstance(value, list) and len(value) > 8:
            slim[key] = value[:8]
            slim[f"{key}More"] = len(value) - 8
        elif isinstance(value, str) and len(value) > 600:
            slim[key] = value[:597] + "..."
    line = json.dumps(slim, ensure_ascii=False, separators=(",", ":"))
    if len(line.encode("utf-8")) >= LINE_MAX:
        line = json.dumps({k: slim[k] for k in ("v", "id", "atMs", "kind", "by") if k in slim}, ensure_ascii=False, separators=(",", ":"))
    return (line + "\n").encode("utf-8")


def make(kind: str, caller: Any, at: Optional[int] = None, **fields: Any) -> Dict[str, Any]:
    at = now_ms() if at is None else at
    event: Dict[str, Any] = {"v": VERSION, "id": new_id(at), "atMs": at, "kind": kind, "by": caller if isinstance(caller, dict) and "name" in caller else as_by(caller)}
    for key, value in fields.items():
        if value is not None:
            event[key] = value
    return event


def append(project: Any, kind: str, caller: Any, **fields: Any) -> Dict[str, Any]:
    """Journal one event: O_APPEND, one write(), no lock; rotates past 1 MiB."""
    root = root_of(project)
    ensure_kb(root)
    from .leases import resolve

    event = make(kind, resolve(root, caller), **fields)
    path = kb_path(root, EVENTS)
    fd = open_own_file(path, os.O_WRONLY | os.O_APPEND)
    try:
        os.write(fd, encode(event))
        size = os.fstat(fd).st_size
    finally:
        os.close(fd)
    if size > EVENTS_MAX:
        rotate(project)
    return event


def journal(project: Any, kind: str, caller: Any, rels: List[str], via: str = "kb", **fields: Any) -> Dict[str, Any]:
    """kblib.lock's hook (and the edit and Bash hooks): who changed which files."""
    return append(project, kind, caller, files=list(rels), via=via, **fields)


def rotate(project: Any) -> None:
    from . import lock
    from .util import KbError

    root = root_of(project)
    try:
        with lock.project_lock(project, "kb events rotate", 2.0):
            path = kb_path(root, EVENTS)
            try:
                if os.path.getsize(path) <= EVENTS_MAX:
                    return
            except OSError:
                return
            os.replace(path, kb_path(root, EVENTS_OLD))
    except (KbError, OSError):
        pass


def _inode(path: str) -> int:
    try:
        return os.stat(path).st_ino
    except OSError:
        return 0


def cursor(root: str) -> str:
    """'<inode>:<offset>' of the journal's end, to resume from."""
    path = kb_path(root, EVENTS)
    try:
        st = os.stat(path)
    except OSError:
        return "0:0"
    return f"{st.st_ino}:{st.st_size}"


def parse_since(raw: Optional[str]) -> Tuple[str, Any]:
    """("all", None), ("ms", atMs), ("cursor", (inode, offset)) or ("end", None)."""
    if raw is None:
        return "end", None
    text = raw.strip().lower()
    if text in ("all", "0"):
        return "all", None
    if text == "now":
        return "end", None
    m = re.match(r"^(\d+):(\d+)$", text)
    if m:
        return "cursor", (int(m.group(1)), int(m.group(2)))
    m = re.match(r"^(\d+)\s*(s|m|h|d)$", text)
    if m:
        unit = {"s": 1000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}[m.group(2)]
        return "ms", now_ms() - int(m.group(1)) * unit
    if text.isdigit() and len(text) >= 12:
        return "ms", int(text)
    from .util import EXIT_ENV, KbError

    raise KbError(f'--since "{raw}" is not 10m, 2h, all, now or a cursor (INODE:OFFSET) from follow.end', EXIT_ENV, kind="usage")


def _read_lines(path: str, offset: int) -> Tuple[List[Dict[str, Any]], int]:
    """Complete lines from offset on, and the offset just past the last complete one."""
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            data = f.read()
    except OSError:
        return [], offset
    end = data.rfind(b"\n")
    if end < 0:
        return [], offset
    out: List[Dict[str, Any]] = []
    for raw in data[: end + 1].splitlines():
        try:
            event = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            continue
        if isinstance(event, dict) and isinstance(event.get("kind"), str):
            out.append(event)
    return out, offset + end + 1


def read_since(root: str, since: Tuple[str, Any]) -> Tuple[List[Dict[str, Any]], str]:
    """Journal events after `since` (rotated file first), and the cursor at the end."""
    mode, value = since
    cur_path, old_path = kb_path(root, EVENTS), kb_path(root, EVENTS_OLD)
    cur_ino, old_ino = _inode(cur_path), _inode(old_path)
    if mode == "end":
        return [], cursor(root)
    events: List[Dict[str, Any]] = []
    if mode == "cursor" and value[0] == cur_ino and cur_ino:
        found, end = _read_lines(cur_path, value[1])
        return found, f"{cur_ino}:{end}"
    if mode == "cursor" and value[0] == old_ino and old_ino:
        found, _end = _read_lines(old_path, value[1])
        events += found
    elif old_ino:
        found, _end = _read_lines(old_path, 0)
        events += found
    found, end = _read_lines(cur_path, 0)
    events += found
    if mode == "ms":
        events = [e for e in events if isinstance(e.get("atMs"), int) and e["atMs"] >= value]
    return events, f"{cur_ino}:{end}" if cur_ino else "0:0"


def changed_by(root: str, since_ms: int) -> Dict[str, Dict[str, Any]]:
    """The last `files.changed` writer of each path since since_ms."""
    events, _cursor = read_since(root, ("ms", since_ms))
    last: Dict[str, Dict[str, Any]] = {}
    for event in events:
        if event.get("kind") != "files.changed":
            continue
        for rel in event.get("files") or []:
            if isinstance(rel, str):
                last[rel] = event.get("by") or {}
    return last


def recent_tail(root: str, since_ms: int, budget: int = 512 * 1024) -> List[Dict[str, Any]]:
    """Events since since_ms from the journal's last `budget` bytes (the Bash post-hook's window)."""
    path = kb_path(root, EVENTS)
    try:
        size = os.path.getsize(path)
    except OSError:
        return []
    start = max(0, size - budget)
    try:
        with open(path, "rb") as f:
            f.seek(start)
            data = f.read()
    except OSError:
        return []
    if start:
        cut = data.find(b"\n")
        data = data[cut + 1:] if cut >= 0 else b""
    out: List[Dict[str, Any]] = []
    for raw in data.splitlines():
        try:
            event = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            continue
        if isinstance(event, dict) and isinstance(event.get("atMs"), int) and event["atMs"] >= since_ms:
            out.append(event)
    return out


# ── filtering and the follower ────────────────────────────────────────────────


def kind_matches(kind: str, kinds: Optional[List[str]]) -> bool:
    return any(kind == k or kind.startswith(k.rstrip(".*") + ".") for k in kinds or [])


def wanted(root: str, event: Dict[str, Any], caller: Any, kinds: Optional[List[str]], all_agents: bool) -> bool:
    kind = str(event.get("kind"))
    if kinds:
        if not kind_matches(kind, kinds):
            return False
    elif kind in QUIET_KINDS:
        return False
    if all_agents or event.get("by") == APP_BY:
        return True
    return not same_caller(root, event.get("by"), caller)


def split_kinds(raw: Optional[List[str]]) -> Optional[List[str]]:
    if not raw:
        return None
    out = [k.strip() for chunk in raw for k in chunk.split(",") if k.strip()]
    return out or None


class AppWatch:
    """Synthesises app events from the serving instance's heartbeat: load, export.*, render.stalled/recovered, app.opened/closed."""

    def __init__(self, project: Any) -> None:
        self.project = project
        self.state = self.read()

    def read(self) -> Dict[str, Any]:
        from . import bridge

        try:
            hb = bridge.live_heartbeat(self.project)
        except Exception:
            hb = None
        if not hb:
            return {"pid": None}
        last = hb.get("lastLoad") if isinstance(hb.get("lastLoad"), dict) else None
        job = hb.get("exportJob") if isinstance(hb.get("exportJob"), dict) else None
        health = hb.get("health") if isinstance(hb.get("health"), dict) else {}
        gpu = health.get("gpu") if isinstance(health.get("gpu"), dict) else {}
        return {
            "pid": hb.get("pid"),
            "appVersion": hb.get("appVersion"),
            "build": hb.get("build"),
            "openProject": hb.get("openProject"),
            "load": last if last and last.get("project") == getattr(self.project, "project_id", None) else None,
            "exporting": bool(hb.get("exporting")),
            "job": job,
            "stalled": bool(gpu.get("stalled")),
            "wedged": bool(gpu.get("wedged")),
        }

    def poll(self) -> List[Dict[str, Any]]:
        new = self.read()
        old = self.state
        self.state = new
        out: List[Dict[str, Any]] = []

        def emit(kind: str, **fields: Any) -> None:
            out.append(make(kind, APP_BY, **fields))

        if old.get("pid") != new.get("pid"):
            if old.get("pid") is not None:
                emit("app.closed", pid=old.get("pid"))
            if new.get("pid") is not None:
                emit("app.opened", pid=new.get("pid"), appVersion=new.get("appVersion"), build=new.get("build"), openProject=new.get("openProject"))
            if new.get("pid") is None:
                return out
            old = {"pid": new.get("pid"), "load": new.get("load"), "exporting": False, "job": None, "stalled": False}
        load = new.get("load")
        if load and (not old.get("load") or old["load"].get("atMs") != load.get("atMs")):
            emit("load", project=load.get("project"), ok=load.get("ok"), error=load.get("error"),
                 sceneErrors=len(load.get("sceneErrors") or []), fontIssues=len(load.get("fontIssues") or []), loadAtMs=load.get("atMs"))
        self._export(old, new, emit)
        if new.get("stalled") and not old.get("stalled"):
            emit("render.stalled", wedged=new.get("wedged"))
        elif old.get("stalled") and not new.get("stalled"):
            emit("render.recovered")
        return out

    def _export(self, old: Dict[str, Any], new: Dict[str, Any], emit: Callable[..., None]) -> None:
        job, before = new.get("job") or {}, old.get("job") or {}
        project = new.get("openProject")
        if new.get("exporting") and (not old.get("exporting") or (job.get("id") and before.get("id") and job.get("id") != before.get("id"))):
            if old.get("exporting"):
                emit("export.done", project=project, jobId=before.get("id"))
            emit("export.started", project=project, jobId=job.get("id"), origin=job.get("origin"), total=job.get("total"))
            self.state["bucket"] = 0
        elif new.get("exporting"):
            self.state["bucket"] = old.get("bucket", 0)
            frame, total = job.get("frame"), job.get("total")
            if isinstance(frame, int) and isinstance(total, int) and total > 0:
                bucket = min(100, (frame * 100 // total) // 10 * 10)
                if bucket > self.state["bucket"] and bucket < 100:
                    self.state["bucket"] = bucket
                    emit("export.progress", project=project, jobId=job.get("id"), percent=bucket, frame=frame, total=total, stage=job.get("stage"))
        elif old.get("exporting"):
            emit("export.done", project=project, jobId=before.get("id"))


def _watcher(path: str) -> Any:
    """A kqueue watching the journal for writes and renames, or None (then the follower polls every 0.5 s)."""
    try:
        import select

        if not hasattr(select, "kqueue"):
            return None
        fd = os.open(path, os.O_RDONLY)
        kq = select.kqueue()
        ev = select.kevent(fd, filter=select.KQ_FILTER_VNODE, flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                           fflags=select.KQ_NOTE_WRITE | select.KQ_NOTE_EXTEND | select.KQ_NOTE_DELETE | select.KQ_NOTE_RENAME)
        kq.control([ev], 0, 0)
        return (kq, fd)
    except (OSError, ValueError, ImportError):
        return None


def _unwatch(w: Any) -> None:
    if w is None:
        return
    kq, fd = w
    try:
        kq.close()
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def _wait(w: Any, timeout: float) -> None:
    if timeout <= 0:
        return
    if w is None:
        time.sleep(min(0.5, timeout))
        return
    try:
        w[0].control(None, 4, timeout)
    except (OSError, InterruptedError):
        time.sleep(min(0.5, timeout))


def write_line(out: IO[str], event: Dict[str, Any]) -> None:
    out.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    out.flush()


def follow(project: Any, caller: Any, since: Tuple[str, Any], kinds: Optional[List[str]], all_agents: bool, exit_after: float,
           out: IO[str] = sys.stdout, app_events: bool = True, on_cursor: Optional[Callable[[str], None]] = None) -> str:
    """Stream matching events as compact lines until exit_after seconds pass; ends with follow.end and returns its cursor."""
    root = root_of(project)
    path = kb_path(root, EVENTS)
    deadline = time.monotonic() + max(0.0, exit_after)
    found, cur = read_since(root, since)
    for event in found:
        if wanted(root, event, caller, kinds, all_agents):
            write_line(out, event)
    ino, offset = (int(x) for x in cur.split(":"))
    watch = AppWatch(project) if app_events else None
    next_poll = time.monotonic() + HEARTBEAT_POLL_S
    watcher = _watcher(path) if ino else None
    saved = time.monotonic()
    try:
        while True:
            now = time.monotonic()
            if now >= deadline:
                break
            _wait(watcher, min(deadline - now, max(0.0, next_poll - now), HEARTBEAT_POLL_S))
            now_ino = _inode(path)
            if ino and now_ino != ino:
                old = kb_path(root, EVENTS_OLD)
                if _inode(old) == ino:
                    rest, _end = _read_lines(old, offset)
                    for event in rest:
                        if wanted(root, event, caller, kinds, all_agents):
                            write_line(out, event)
                ino, offset = now_ino, 0
                _unwatch(watcher)
                watcher = _watcher(path) if ino else None
            elif not ino and now_ino:
                ino, offset = now_ino, 0
                watcher = _watcher(path)
            if ino:
                fresh, offset = _read_lines(path, offset)
                for event in fresh:
                    if wanted(root, event, caller, kinds, all_agents):
                        write_line(out, event)
            if watch is not None and time.monotonic() >= next_poll:
                next_poll = time.monotonic() + HEARTBEAT_POLL_S
                for event in watch.poll():
                    if not kinds or kind_matches(event["kind"], kinds):
                        write_line(out, event)
            if on_cursor is not None and time.monotonic() - saved > 5:
                saved = time.monotonic()
                on_cursor(f"{ino}:{offset}")
    except KeyboardInterrupt:
        pass
    finally:
        _unwatch(watcher)
    end = f"{ino}:{offset}"
    if on_cursor is not None:
        on_cursor(end)
    write_line(out, {"v": VERSION, "kind": "follow.end", "atMs": now_ms(), "cursor": end})
    return end


# ── per-agent read marks ──────────────────────────────────────────────────────


def seen_path(root: str, name: str) -> str:
    return kb_path(root, "agents", name, "seen.json")


def load_seen(root: str, name: str) -> Dict[str, Any]:
    try:
        with open(seen_path(root, name), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_seen(project: Any, name: str, **changes: Any) -> None:
    """Compare-and-swap the agent's own seen.json (one writer per name; never the project lock)."""
    from . import lock

    root = root_of(project)
    path = seen_path(root, name)
    for _attempt in range(3):
        data, base = lock.read_with_hash(path)
        try:
            current = json.loads(data.decode("utf-8")) if data else {}
        except (ValueError, UnicodeDecodeError):
            current = {}
        if not isinstance(current, dict):
            current = {}
        merged = dict(current, **changes)
        if merged == current:
            return
        ensure_kb(root)
        real_dir(root, ".kb", "agents", name)
        if lock.write_if_unchanged(path, base, lock.encode_json(merged)):
            return


# ── notes ─────────────────────────────────────────────────────────────────────


def one_line(text: str) -> str:
    return " ".join(str(text).split())


def note_text(at_ms: int, agent: str, scene: Optional[str], text: str) -> str:
    stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(at_ms / 1000))
    where = f" · {scene}" if scene else ""
    return f"- {stamp} · {agent}{where}: {one_line(text)}\n"


def add_note(project: Any, caller: Any, text: str, scene: Optional[str] = None, wait: Optional[float] = None) -> Dict[str, Any]:
    """Append one line to .kb/notes.md (rotated past 256 KB to notes.1.md) and journal `note`."""
    from . import lock
    from .util import EXIT_ENV, KbError

    body = one_line(text)
    if not body:
        raise KbError("kb note needs some text, e.g. ./kb note \"hero copy is final\" --scene 02-hero", EXIT_ENV, kind="usage")
    root = root_of(project)
    name = str(getattr(caller, "name", None) or "user")
    at = now_ms()
    line = note_text(at, name, scene, body)
    with lock.project_lock(project, "kb note", wait, caller):
        path = kb_path(root, NOTES)
        try:
            if os.path.getsize(path) + len(line.encode("utf-8")) > NOTES_MAX:
                os.replace(path, kb_path(root, NOTES_OLD))
        except OSError:
            pass
        fd = open_own_file(path, os.O_WRONLY | os.O_APPEND)
        try:
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)
    append(project, "note", caller, scene=scene, text=body if len(body) <= 600 else body[:597] + "...")
    return {"atMs": at, "agent": name, "scene": scene, "text": body, "line": line.rstrip("\n")}


def parse_notes(text: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for raw in text.splitlines():
        m = NOTE_LINE.match(raw)
        if m:
            out.append({"date": m.group(1), "time": m.group(2), "agent": m.group(3), "scene": m.group(4), "text": m.group(5)})
    return out


def _read_text(path: str, offset: int = 0) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def read_notes(root: str, include_old: bool = False) -> List[Dict[str, Any]]:
    text = (_read_text(kb_path(root, NOTES_OLD)) if include_old else "") + _read_text(kb_path(root, NOTES))
    return parse_notes(text)


def unseen_notes(project: Any, caller: Any, mark: bool = True) -> List[Dict[str, Any]]:
    """Notes from other agents since this agent's last look (oldest first); mark=True records them as seen."""
    root = root_of(project)
    name = str(getattr(caller, "name", None) or "user")
    path = kb_path(root, NOTES)
    try:
        st = os.stat(path)
    except OSError:
        return []
    seen = load_seen(root, name)
    offset = seen.get("notesOffset") if isinstance(seen.get("notesOffset"), int) else 0
    if seen.get("notesInode") not in (None, st.st_ino) or offset > st.st_size:
        offset = 0
    notes = [n for n in parse_notes(_read_text(path, offset)) if n["agent"] != name]
    if mark and (offset != st.st_size or seen.get("notesInode") != st.st_ino):
        try:
            save_seen(project, name, notesOffset=st.st_size, notesInode=st.st_ino)
        except Exception:
            pass
    return notes


def note_label(note: Dict[str, Any], width: int = NOTE_SHOWN) -> str:
    where = f" · {note['scene']}" if note.get("scene") else ""
    text = f"{note['time']} {note['agent']}{where}: {note['text']}"
    return text if len(text) <= width else text[: width - 3] + "..."


def notes_lines(notes: List[Dict[str, Any]], shown: int = 3) -> List[str]:
    """kb status: a count, then at most `shown` of the newest unseen notes, each capped at 160 characters."""
    if not notes:
        return []
    n = len(notes)
    head = f"{n} new note{'s' if n != 1 else ''} since your last status (./kb notes)"
    if n > shown:
        head = f"{n} new notes since your last status; the newest {shown} (./kb notes shows all):"
    return [head] + [f"  {note_label(x)}" for x in notes[-shown:]]


def newest_lines(root: str, count: int = 2) -> List[str]:
    notes = read_notes(root)
    if not notes:
        return []
    return ["Notes (newest; ./kb notes):"] + [f"  {note_label(x)}" for x in notes[-count:]]


def describe(event: Dict[str, Any]) -> str:
    """One line for people: "14:03:12 beta lease.taken 06-feature"."""
    try:
        when = time.strftime("%H:%M:%S", time.localtime(int(event.get("atMs") or 0) / 1000))
    except (TypeError, ValueError, OverflowError, OSError):
        when = "?"
    by = event.get("by") or {}
    name = by.get("name") or (f"{str(by.get('session') or '?')[:8]}/{by.get('agentId') or '?'}")
    bits = [when, str(name), str(event.get("kind"))]
    for key in ("scene", "rev", "target", "project"):
        if event.get(key) is not None:
            bits.append(str(event[key]))
    if event.get("percent") is not None:
        bits.append(f"{event['percent']}%")
    files = event.get("files")
    if isinstance(files, list) and files:
        bits.append(", ".join(str(f) for f in files[:4]) + (f" (+{len(files) - 4})" if len(files) > 4 else ""))
    if event.get("text"):
        bits.append(f"\"{one_line(str(event['text']))[:120]}\"")
    if event.get("via") and event.get("kind") == "files.changed":
        bits.append(f"via {event['via']}")
    return " ".join(bits)


def iter_wanted(root: str, events: Iterable[Dict[str, Any]], caller: Any, kinds: Optional[List[str]], all_agents: bool) -> List[Dict[str, Any]]:
    return [e for e in events if wanted(root, e, caller, kinds, all_agents)]
