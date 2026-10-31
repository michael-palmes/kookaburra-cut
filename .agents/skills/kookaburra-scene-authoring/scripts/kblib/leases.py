"""Opt-in scene leases: .kb/leases/<stem>.json, one small file per leased scene, plus the name bindings hooks write.

Reading is light (os, json, re, time) so the Bash hooks can check leases without importing the rest of kb; writes go
through kblib.lock under the project lock. Expired leases are ignored everywhere and pruned when kb next writes leases.
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

from .realdir import real_dir

VERSION = 1
DEFAULT_TTL_MS = 2 * 3600 * 1000
MAX_TTL_MS = 12 * 3600 * 1000
LEASES = (".kb", "leases")
AGENTS = (".kb", "agents")
SCENE_FILE = re.compile(r"^scenes/([^/]+)\.(?:tsx|json)$")
DEFAULT_NAME = re.compile(r"^session-[A-Za-z0-9_-]{0,8}$")
UNNAMED = ("user", "claude")
MAIN = "main"


def now_ms() -> int:
    return int(time.time() * 1000)


def root_of(project: Any) -> str:
    return os.fspath(project) if isinstance(project, (str, os.PathLike)) else os.fspath(project.root)


def who(caller: Any) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """(name, session, agentId) of a Caller, a { name, session, agentId } dict, or None."""
    if caller is None:
        return None, None, None
    if isinstance(caller, dict):
        return caller.get("name"), caller.get("session"), caller.get("agentId")
    return getattr(caller, "name", None), getattr(caller, "session", None), getattr(caller, "agent_id", None)


def as_by(caller: Any) -> Dict[str, Any]:
    name, session, agent = who(caller)
    return {"name": name, "session": session, "agentId": agent}


def named(name: Optional[str]) -> bool:
    """True for a name the caller chose (--agent); the session-<id>, user and claude defaults are not names."""
    return bool(name) and name not in UNNAMED and not DEFAULT_NAME.match(str(name))


def scene_of(rel: str) -> Optional[str]:
    m = SCENE_FILE.match(rel)
    return m.group(1) if m else None


def files_for(stem: str) -> List[str]:
    return [f"scenes/{stem}.tsx", f"scenes/{stem}.json"]


def lease_path(root: str, stem: str) -> str:
    return os.path.join(root, *LEASES, f"{stem}.json")


def _read(path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _valid(lease: Optional[Dict[str, Any]]) -> bool:
    return isinstance(lease, dict) and isinstance(lease.get("holder"), dict) and isinstance(lease.get("untilMs"), int)


def expired(lease: Dict[str, Any], now: Optional[int] = None) -> bool:
    return int(lease.get("untilMs") or 0) <= (now_ms() if now is None else now)


def read(root: str, stem: str, now: Optional[int] = None, include_expired: bool = False) -> Optional[Dict[str, Any]]:
    """The scene's lease, or None when there is none (or it expired, unless include_expired)."""
    lease = _read(lease_path(root, stem))
    if not _valid(lease):
        return None
    if not include_expired and expired(lease, now):  # type: ignore[arg-type]
        return None
    return lease


def all_leases(root: str, include_expired: bool = False) -> List[Dict[str, Any]]:
    folder = os.path.join(root, *LEASES)
    out: List[Dict[str, Any]] = []
    try:
        entries = sorted(e.name for e in os.scandir(folder) if e.name.endswith(".json") and not e.name.startswith("."))
    except OSError:
        return out
    now = now_ms()
    for name in entries:
        lease = read(root, name[:-5], now, include_expired)
        if lease is not None:
            lease.setdefault("scene", name[:-5])
            out.append(lease)
    return out


def binding_path(root: str, name: str) -> str:
    return os.path.join(root, *AGENTS, name, "identity.json")


def binding(root: str, name: Optional[str]) -> Optional[Dict[str, Any]]:
    """What the Bash pre-hook last bound NAME to: { session, agentId, atMs }."""
    if not named(name):
        return None
    data = _read(binding_path(root, str(name)))
    return data if data is not None and data.get("session") else None


def bound_name(root: str, session: Optional[str], agent_id: Optional[str]) -> Optional[str]:
    """The name a hook caller (session, agent id) was last bound to, newest binding first."""
    if not session:
        return None
    folder = os.path.join(root, *AGENTS)
    best: Tuple[int, Optional[str]] = (-1, None)
    try:
        names = [e.name for e in os.scandir(folder) if e.is_dir() and not e.name.startswith(".")]
    except OSError:
        return None
    for name in names:
        b = binding(root, name)
        if b and b.get("session") == session and b.get("agentId") == (agent_id or MAIN):
            at = b.get("atMs") if isinstance(b.get("atMs"), int) else 0
            if at > best[0]:
                best = (at, name)
    return best[1]


def resolve(root: str, caller: Any) -> Any:
    """A kb caller (name, session) gains the agent id its name is bound to in this session, so hooks can match it."""
    name, session, agent = who(caller)
    if agent is not None or not session or not named(name):
        return caller
    b = binding(root, name)
    if not b or b.get("session") != session:
        return caller
    from .identity import Caller

    return Caller(str(name), session, b.get("agentId"))


def is_holder(root: str, lease: Dict[str, Any], caller: Any) -> bool:
    """The ruling: the bound holder's session and agent id, or the binding of the holder's name, or (unnamed) the main agent of the holder's session, never its subagents."""
    holder = lease.get("holder") or {}
    name, session, agent = who(caller)
    h_name, h_session, h_agent = holder.get("name"), holder.get("session"), holder.get("agentId")
    if h_session == session and h_agent == agent and (h_agent is not None or (h_name is not None and h_name == name)):
        return True
    b = binding(root, h_name)
    if b is not None and session is not None and b.get("session") == session and b.get("agentId") == agent:
        return True
    return not named(name) and session is not None and h_session == session and h_agent in (None, MAIN) and agent in (None, MAIN)


def same_caller(root: str, by: Any, caller: Any) -> bool:
    """Whether a journalled `by` is this caller: names (chosen or bound) decide; a named side matches an unnamed one only by
    session and a known agent id; two unnamed sides match by session, an unknown agent id matching any."""
    b_name, b_session, b_agent = who(by)
    c_name, c_session, c_agent = who(caller)
    if not named(b_name):
        b_name = bound_name(root, b_session, b_agent) if b_agent else None
    if not named(c_name):
        c_name = bound_name(root, c_session, c_agent) if c_agent else None
    if named(b_name) and named(c_name):
        return b_name == c_name
    if b_session != c_session:
        return False
    if named(b_name) or named(c_name):
        return b_agent is not None and b_agent == c_agent
    return b_agent is None or c_agent is None or b_agent == c_agent


def clock(ms: Any) -> str:
    try:
        return time.strftime("%H:%M", time.localtime(int(ms) / 1000))
    except (TypeError, ValueError, OverflowError, OSError):
        return "?"


def left(ms: int) -> str:
    mins = max(0, ms) // 60000
    if mins < 1:
        return "<1m"
    return f"{mins // 60}h{mins % 60:02d}m" if mins >= 60 else f"{mins}m"


def holder_name(lease: Dict[str, Any]) -> str:
    return str((lease.get("holder") or {}).get("name") or "another agent")


def refusal_text(rel: str, lease: Dict[str, Any]) -> str:
    return f"{rel} is leased to {holder_name(lease)} until {clock(lease.get('untilMs'))}"


def deny_reason(rel: str, lease: Dict[str, Any]) -> str:
    stem = str(lease.get("scene") or scene_of(rel) or "")
    name = holder_name(lease)
    return f"{refusal_text(rel, lease)}. If you are {name}, run ./kb lease {stem} --agent {name}; otherwise leave them a ./kb note."


def check(project: Any, caller: Any, rels: List[str]) -> List[Dict[str, Any]]:
    """The refusals a write of rels would meet, touching nothing: [{ path, scene, holder, untilMs, error }]."""
    root = root_of(project)
    if not os.path.isdir(os.path.join(root, *LEASES)):
        return []
    caller = resolve(root, caller)
    out: List[Dict[str, Any]] = []
    seen: Dict[str, Optional[Dict[str, Any]]] = {}
    for rel in rels:
        stem = scene_of(rel)
        if stem is None:
            continue
        if stem not in seen:
            seen[stem] = read(root, stem)
        lease = seen[stem]
        if lease is None or is_holder(root, lease, caller):
            continue
        out.append({"path": rel, "scene": stem, "holder": lease.get("holder"), "untilMs": lease.get("untilMs"), "error": refusal_text(rel, lease)})
    return out


def guard(project: Any, caller: Any, rels: List[str]) -> None:
    """kblib.lock's commit hook, under the project lock: refuse a write to a scene leased to someone else; a holder's write renews."""
    refusals = check(project, caller, rels)
    if refusals:
        from .util import EXIT_PROBLEMS, KbError

        first = refusals[0]
        lease = read(root_of(project), first["scene"]) or {"holder": first["holder"], "untilMs": first["untilMs"], "scene": first["scene"]}
        name = holder_name(lease)
        raise KbError(
            f"{first['error']}; nothing was written",
            EXIT_PROBLEMS,
            kind="leased",
            hint=f'leave {name} a note (./kb note "..." --scene {first["scene"]}), or wait until {clock(first["untilMs"])} (./kb leases)',
            data={"holder": first["holder"], "untilMs": first["untilMs"], "scene": first["scene"], "path": first["path"], "refusals": refusals},
        )
    root = root_of(project)
    if not os.path.isdir(os.path.join(root, *LEASES)):
        return
    resolved = resolve(root, caller)
    for stem in sorted({s for s in (scene_of(r) for r in rels) if s}):
        lease = read(root, stem)
        if lease is not None and is_holder(root, lease, resolved):
            renew_if_due(project, stem, lease, resolved, wait=None)


def _encode(lease: Dict[str, Any]) -> bytes:
    return (json.dumps(lease, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _write(project: Any, stem: str, lease: Optional[Dict[str, Any]], base: str) -> bool:
    """Compare-and-swap the lease file (None removes it); the caller holds the project lock."""
    from . import lock

    path = lease_path(root_of(project), stem)
    real_dir(root_of(project), *LEASES)
    if lease is None:
        if lock.current_hash(path) != base:
            return False
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        return True
    return lock.write_if_unchanged(path, base, _encode(lease))


def renew_if_due(project: Any, stem: str, lease: Dict[str, Any], caller: Any, wait: Optional[float] = 2.0) -> bool:
    """Push untilMs out by the lease's own TTL once under half of it is left; best effort (a busy lock skips it)."""
    now = now_ms()
    ttl = int(lease.get("untilMs") or 0) - int(lease.get("renewedAtMs") or lease.get("takenAtMs") or 0)
    ttl = min(max(ttl, 60_000), MAX_TTL_MS)
    if int(lease.get("untilMs") or 0) - now >= ttl / 2:
        return False
    from . import lock
    from .util import KbError

    try:
        with lock.project_lock(project, "kb lease renew", wait, caller):
            path = lease_path(root_of(project), stem)
            data, base = lock.read_with_hash(path)
            fresh = _read(path) if data is not None else None
            if not _valid(fresh) or fresh.get("holder") != lease.get("holder"):  # type: ignore[union-attr]
                return False
            fresh["renewedAtMs"] = now  # type: ignore[index]
            fresh["untilMs"] = now + ttl  # type: ignore[index]
            return _write(project, stem, fresh, base)
    except (KbError, OSError):
        return False


def prune(project: Any) -> List[str]:
    """Remove expired lease files (under the project lock); returns their scenes."""
    from . import lock

    root = root_of(project)
    gone: List[str] = []
    for lease in all_leases(root, include_expired=True):
        if expired(lease):
            stem = str(lease.get("scene"))
            _data, base = lock.read_with_hash(lease_path(root, stem))
            if _write(project, stem, None, base):
                gone.append(stem)
    return gone


def parse_ttl(raw: Optional[str]) -> Tuple[int, Optional[str]]:
    """'2h', '90m', '1h30m', '45s' or bare minutes, to ms; (ms, note) with a note when it was capped at 12 h."""
    from .util import EXIT_ENV, KbError

    if raw is None:
        return DEFAULT_TTL_MS, None
    text = str(raw).strip().lower()
    if text.isdigit():
        ms = int(text) * 60_000
    else:
        parts = re.findall(r"(\d+)\s*([hms])", text)
        if not parts or re.sub(r"(\d+)\s*([hms])", "", text).strip():
            raise KbError(f'--ttl "{raw}" is not a duration; use 2h, 90m or 1h30m', EXIT_ENV, kind="usage")
        ms = sum(int(n) * {"h": 3_600_000, "m": 60_000, "s": 1000}[u] for n, u in parts)
    if ms < 60_000:
        raise KbError(f"--ttl {raw} is under a minute; a lease needs at least 1m", EXIT_ENV, kind="usage")
    if ms > MAX_TTL_MS:
        return MAX_TTL_MS, f"--ttl {raw} is capped at 12h"
    return ms, None


def _journal(project: Any, kind: str, caller: Any, **fields: Any) -> None:
    from . import events

    events.append(project, kind, caller, **fields)


def take(project: Any, stem: str, caller: Any, ttl_ms: int, note: Optional[str] = None, for_name: Optional[str] = None,
         wait: Optional[float] = None, dry_run: bool = False) -> Tuple[Dict[str, Any], str]:
    """Take, renew or (for_name) assign the scene's lease: (lease, "taken" | "renewed" | "assigned"). Someone else's is exit 1, kind leased."""
    from . import lock
    from .util import EXIT_PROBLEMS, KbError

    root = root_of(project)
    me = resolve(root, caller)
    m_name, m_session, m_agent = who(me)
    now = now_ms()
    held = lock.project_lock(project, "kb lease", wait, me) if not dry_run else None
    with held if held is not None else _null():
        if not dry_run:
            prune(project)
        path = lease_path(root, stem)
        _data, base = lock.read_with_hash(path)
        current = read(root, stem, now)
        if current is not None:
            mine = is_holder(root, current, me)
            theirs_by_name = for_name is not None and holder_name(current) == for_name
            claim = for_name is None and named(m_name) and holder_name(current) == m_name and (current.get("holder") or {}).get("session") is None
            if not (mine or theirs_by_name or claim):
                raise KbError(
                    f"scene {stem} is leased to {holder_name(current)} until {clock(current.get('untilMs'))}",
                    EXIT_PROBLEMS,
                    kind="leased",
                    hint=f'leave {holder_name(current)} a note (./kb note "..." --scene {stem}), or break it with ./kb lease {stem} --release --force',
                    data={"holder": current.get("holder"), "untilMs": current.get("untilMs"), "scene": stem},
                )
        if for_name is not None:
            holder: Dict[str, Any] = {"name": for_name, "session": None, "agentId": None}
            assigned_by: Optional[str] = m_name
            action = "assigned"
        else:
            holder = {"name": m_name, "session": m_session, "agentId": m_agent}
            assigned_by = current.get("assignedBy") if current is not None else None
            action = "renewed" if current is not None and current.get("holder") == holder else "taken"
        lease = {
            "version": VERSION,
            "scene": stem,
            "files": files_for(stem),
            "holder": holder,
            "assignedBy": assigned_by,
            "takenAtMs": current.get("takenAtMs", now) if current is not None and action == "renewed" else now,
            "renewedAtMs": now,
            "untilMs": now + ttl_ms,
            "note": note if note is not None else (current.get("note") if current is not None else None),
        }
        if dry_run:
            return lease, action
        if not _write(project, stem, lease, base):
            raise lock.exhausted(f".kb/leases/{stem}.json", 1)
    _journal(project, "lease.taken", me, scene=stem, holder=holder, untilMs=lease["untilMs"], action=action, note=lease["note"])
    return lease, action


def release(project: Any, stem: str, caller: Any, force: bool = False, wait: Optional[float] = None,
            dry_run: bool = False) -> Tuple[Optional[Dict[str, Any]], str]:
    """(the lease released, "released" | "broken" | "none"); someone else's needs force (journalled lease.broken)."""
    from . import lock
    from .util import EXIT_PROBLEMS, KbError

    root = root_of(project)
    me = resolve(root, caller)
    held = lock.project_lock(project, "kb lease --release", wait, me) if not dry_run else None
    with held if held is not None else _null():
        path = lease_path(root, stem)
        _data, base = lock.read_with_hash(path)
        current = read(root, stem)
        if current is None:
            if not dry_run and base != lock.ABSENT:
                _write(project, stem, None, base)
            return None, "none"
        mine = is_holder(root, current, me) or (current.get("assignedBy") is not None and current.get("assignedBy") == who(me)[0])
        if not mine and not force:
            raise KbError(
                f"scene {stem} is leased to {holder_name(current)} until {clock(current.get('untilMs'))}; only they can release it",
                EXIT_PROBLEMS,
                kind="leased",
                hint=f"ask {holder_name(current)} first; ./kb lease {stem} --release --force breaks it",
                data={"holder": current.get("holder"), "untilMs": current.get("untilMs"), "scene": stem},
            )
        if dry_run:
            return current, "released" if mine else "broken"
        if not _write(project, stem, None, base):
            raise lock.exhausted(f".kb/leases/{stem}.json", 1)
    kind = "lease.released" if mine else "lease.broken"
    _journal(project, kind, me, scene=stem, holder=current.get("holder"))
    return current, "released" if mine else "broken"


def release_removed(project: Any, stem: str, caller: Any) -> Optional[str]:
    """scene remove: the removed scene's lease goes with it (the transaction already refused anyone else's)."""
    root = root_of(project)
    if read(root, stem, include_expired=True) is None:
        return None
    try:
        _lease, action = release(project, stem, caller, force=True)
    except Exception:  # the scene is gone either way; a stale lease file only expires
        return None
    return action


def summary(root: str, caller: Any, leases: Optional[List[Dict[str, Any]]] = None) -> List[str]:
    """["06-feature alpha (yours, 1h52m)", "04-proof beta (40m)"], soonest to end first."""
    caller = resolve(root, caller)
    now = now_ms()
    rows = leases if leases is not None else all_leases(root)
    out: List[str] = []
    for lease in sorted(rows, key=lambda l: int(l.get("untilMs") or 0)):
        remaining = left(int(lease.get("untilMs") or 0) - now)
        tag = f"yours, {remaining}" if is_holder(root, lease, caller) else remaining
        out.append(f"{lease.get('scene')} {holder_name(lease)} ({tag})")
    return out


def line(project: Any, caller: Any) -> Optional[str]:
    """kb status and the session context: "Leases: 06-feature alpha (yours, 1h52m) · 04-proof beta (40m)", or None."""
    bits = summary(root_of(project), caller)
    return f"Leases: {' · '.join(bits)}" if bits else None


def rows(project: Any, caller: Any, include_expired: bool = False) -> List[Dict[str, Any]]:
    """kb leases --json and kb status --json: each lease plus whether the caller holds it and the ms left."""
    root = root_of(project)
    me = resolve(root, caller)
    now = now_ms()
    out: List[Dict[str, Any]] = []
    for lease in all_leases(root, include_expired):
        row = dict(lease)
        row["yours"] = is_holder(root, lease, me)
        row["leftMs"] = max(0, int(lease.get("untilMs") or 0) - now)
        row["expired"] = expired(lease, now)
        out.append(row)
    return out


class _null:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *exc: Any) -> None:
        return None
