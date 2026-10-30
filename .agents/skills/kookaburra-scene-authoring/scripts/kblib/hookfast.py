"""The Bash hooks (`hook bash-pre`, `hook bash-post`): kb.py runs this before importing kblib.cli.

Standard library only, and nothing heavy until a command actually changed a project file: the pre-hook stamps
project.json, scenes/** and edits/*.json, binds `--agent NAME` to the hook's agent id, denies a visible write to a
scene leased to someone else or to an asset record (assets/_meta.json, timing records, assets/.originals/) and makes
the session checkpoint before the first write; the post-hook diffs the stamps,
reports the changed files' check results and journals `files.changed`. Every failure exits 0 (fail open).
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

from . import leases

BLOCK = 2
CHECK_ALL_OVER = 20
SNAP_TTL_S = 86400
SAFE_SESSION = re.compile(r"[^A-Za-z0-9._-]")
RUNS_KB = re.compile(r"(?:^|[\s;&|(/\"'])kb(?:\.py)?(?=[\"'\s;&|)]|$)")
AGENT_FLAG = re.compile(r"--agent(?:=|\s+)[\"']?([A-Za-z0-9][A-Za-z0-9._-]{0,63})")
SED_I = re.compile(r"\b(?:g?sed|perl)\b[^;&|\n]*?\s-[A-Za-z]*i")
REDIRECT = re.compile(r"(?<![-<&=0-9>])>>?\|?\s*[\"']?([^\s\"';&|<>()]+)")
TEE = re.compile(r"\btee\b((?:\s+[^\s;&|<>()]+)+)")
FILE_OPS = re.compile(r"(?:^|[\s;&|(])(mv|rm|cp|install|rsync|truncate|touch|ln)\b((?:\s+[^\s;&|<>()]+)+)")
HEREDOC = re.compile(r"<<-?\s*[\"']?[A-Za-z_]\w*")
PY_WRITE = re.compile(r"\.write_(?:text|bytes)\s*\(|\bopen\s*\([^)]*,\s*[\"'][rwax]?[wax+]|\bjson\.dump\s*\(|\bos\.(?:replace|rename|remove|unlink)\s*\(|\bshutil\.(?:copy\w*|move)\s*\(")
SCENE_TOKEN = re.compile(r"(?:[^\s\"'=;&|<>()]*/)?scenes/[^\s\"';&|<>(),]*")
ASSET_TOKEN = re.compile(r"(?:[^\s\"'=;&|<>()]*/)?(?:assets/|\.originals/)[^\s\"';&|<>(),]*")
RECORD_WORDS = ("assets", ".originals", "_meta.json", ".timing.json")
KB_WRITE = re.compile(
    r"\bkb(?:\.py)?[\"']?\s+(?:--?[\w-]+(?:[= ][^\s-][^\s]*)?\s+)*"
    r"(?:scene\s+(?:add|duplicate|move|remove|set)|doc\s+\S+\s+(?:set|unset|merge)|project\s+(?:set|unset)|theme\s+set|assets\s+(?:add|conform|replace)|"
    r"beats\s+(?:set-grid|set-downbeat|clear-grid|cue\s+(?:set|rm)|section\s+(?:set|rm))|song\s+analyse\b[^;&|\n]*--accept|"
    r"video\s+(?!list|show|map|usages|validate|caps|frames|sheet|analyse|durations|open)\w+)"
)
FILTERS = {"head", "tail", "grep", "egrep", "rg", "jq", "wc", "sort", "uniq", "cat", "less", "true", "column", "cut", "tr"}


def now_ms() -> int:
    return int(time.time() * 1000)


# ── reading the hook call ─────────────────────────────────────────────────────


def project_root(payload: Dict[str, Any]) -> Optional[str]:
    for start in (os.environ.get("CLAUDE_PROJECT_DIR"), payload.get("cwd")):
        if not isinstance(start, str) or not start:
            continue
        here = os.path.realpath(start)
        while True:
            if os.path.isfile(os.path.join(here, "project.json")):
                return here
            parent = os.path.dirname(here)
            if parent == here:
                break
            here = parent
    return None


def tool_input(payload: Dict[str, Any]) -> Dict[str, Any]:
    value = payload.get("tool_input")
    return value if isinstance(value, dict) else {}


def hook_caller(payload: Dict[str, Any]) -> Dict[str, Any]:
    """The Edit, Write or Bash call's own identity: no name, the session and the agent id (main outside a subagent)."""
    session = payload.get("session_id") if isinstance(payload.get("session_id"), str) else None
    agent = payload.get("agent_id") if isinstance(payload.get("agent_id"), str) and payload.get("agent_id") else leases.MAIN
    return {"name": None, "session": session, "agentId": agent}


def by_for(root: str, caller: Dict[str, Any], command: str = "") -> Dict[str, Any]:
    """Who to journal: the name this command passes kb, else the name the agent was last bound to."""
    names = AGENT_FLAG.findall(command) if command and RUNS_KB.search(command) else []
    name = names[0] if names else leases.bound_name(root, caller.get("session"), caller.get("agentId"))
    return dict(caller, name=name)


# ── the command text ──────────────────────────────────────────────────────────


def unquote(command: str) -> str:
    """Quoted strings collapse to Q, so operators and redirections inside them never count."""
    out: List[str] = []
    i, n = 0, len(command)
    while i < n:
        c = command[i]
        if c == "\\" and i + 1 < n:
            out.append("_")
            i += 2
            continue
        if c in "'\"":
            j = i + 1
            while j < n and command[j] != c:
                j += 2 if c == '"' and command[j] == "\\" else 1
            out.append("Q")
            i = j + 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def kb_only(command: str) -> bool:
    """Only kb calls (plus cd and read-only filters): kb checks its own writes, so the post-hook skips them."""
    flat = unquote(command)
    if not RUNS_KB.search(command) or re.search(r"[<>`]|\$\(", flat):
        return False
    for part in re.split(r"&&|\|\||[;|&\n]", flat):
        words = part.split()
        if not words:
            continue
        head = words[0]
        if head == "cd" or head in FILTERS:
            continue
        if head == "kb" or head.endswith("/kb"):
            continue
        if re.match(r"^python3?$", head) and any(w.endswith("kb.py") for w in words[1:]):
            continue
        return False
    return True


def _glob(token: str) -> "re.Pattern[str]":
    out = []
    for c in token:
        out.append("[^/]*" if c == "*" else "[^/]" if c == "?" else re.escape(c))
    return re.compile("".join(out) + "$")


def names_scene(token: str, stem: str) -> bool:
    """Whether a path token (scenes/x.tsx, a glob, a prefix) names scenes/<stem>.tsx or .json."""
    part = token[token.find("scenes/"):]
    if "*" in part or "?" in part:
        rx = _glob(part)
        return bool(rx.match(f"scenes/{stem}.tsx") or rx.match(f"scenes/{stem}.json"))
    return bool(re.match(rf"scenes/{re.escape(stem)}(?![A-Za-z0-9_-])", part))


def write_targets(command: str) -> List[str]:
    """Paths the command visibly writes: redirection and tee targets, mv/rm/touch arguments, cp and install destinations."""
    out = [m.group(1) for m in REDIRECT.finditer(command)]
    for m in TEE.finditer(command):
        out += [w for w in m.group(1).split() if not w.startswith("-")]
    for m in FILE_OPS.finditer(command):
        args = [w.strip("\"'") for w in re.sub(r"\s\d+$", "", m.group(2)).split() if not w.startswith("-")]
        if not args:
            continue
        out += args[-1:] if m.group(1) in ("cp", "install", "rsync", "ln") else args
    return [t.strip("\"'") for t in out]


def scripted_write(command: str) -> bool:
    return bool(SED_I.search(command) or HEREDOC.search(command) or PY_WRITE.search(command))


def asset_record_reason(rel: str) -> Optional[str]:
    """Why a hand write to an asset record is refused: the provenance file, a conform's timing record or a kept original."""
    if rel == "assets/_meta.json":
        return "assets/_meta.json is the provenance record kb and the app keep in step with the files; change it only with ./kb assets meta <asset> --set key=value."
    if rel.startswith("assets/") and rel.endswith(".timing.json"):
        return (f"{rel} is a conform's frame map, written with its video; only ./kb assets conform (or the app's Conform) writes it. "
                "To swap the video use ./kb assets replace, which moves the record aside with the old file (./kb assets restore undoes it).")
    if rel == "assets/.originals" or rel.startswith("assets/.originals/"):
        return ("assets/.originals/ keeps the untouched original of each conformed video, the only copy of its source frames. "
                "./kb assets conform keeps originals there and the app's media library removes them; to swap a clip's file use ./kb assets replace "
                "(./kb assets restore undoes it).")
    return None


def _project_rels(root: str, cwd: Any, token: str) -> List[str]:
    """A command's path token as project-relative paths (a glob expands the way the shell would); none outside the project."""
    import glob

    if not token or token.startswith(("~", "$")):
        return []
    base = cwd if isinstance(cwd, str) and os.path.isdir(cwd) else root
    path = os.path.join(base, token)
    paths = [path]
    if any(c in token for c in "*?["):
        paths = sorted(glob.glob(path)) or paths
    out = []
    for p in paths:
        rel = os.path.relpath(os.path.realpath(p), root).replace(os.sep, "/")
        if rel != ".." and not rel.startswith("../"):
            out.append(rel)
    return out


def asset_record_write(root: str, command: str, cwd: Any) -> Optional[Tuple[str, str]]:
    """(rel, reason) for the first asset record the command visibly writes; kb's own commands write them through kb."""
    if not any(word in command for word in RECORD_WORDS) or kb_only(command):
        return None
    tokens = write_targets(command)
    if SED_I.search(command) or PY_WRITE.search(command):
        tokens += ASSET_TOKEN.findall(command)
    for token in tokens:
        for rel in _project_rels(root, cwd, token.strip("\"'")):
            reason = asset_record_reason(rel)
            if reason:
                return rel, reason
    return None


def writes_project(command: str) -> bool:
    """A visible write to scenes/ or project.json, or a kb write command: the session checkpoint goes first."""
    if KB_WRITE.search(command) and "--dry-run" not in command:
        return True
    if any("scenes/" in t or t.endswith("project.json") for t in write_targets(command)):
        return True
    return scripted_write(command) and ("scenes/" in command or "project.json" in command)


def leased_writes(root: str, command: str, caller: Dict[str, Any]) -> List[Tuple[str, Dict[str, Any]]]:
    """(rel, lease) for each scene leased to someone else that the command names and visibly writes."""
    if "scenes/" not in command:
        return []
    found = leases.all_leases(root)
    if not found:
        return []
    tokens = SCENE_TOKEN.findall(command)
    targets = [t for t in write_targets(command) if "scenes/" in t]
    scripted = scripted_write(command)
    out: List[Tuple[str, Dict[str, Any]]] = []
    for lease in found:
        stem = str(lease.get("scene"))
        if leases.is_holder(root, lease, caller):
            continue
        hit = next((t for t in targets if names_scene(t, stem)), None)
        if hit is None and scripted:
            hit = next((t for t in tokens if names_scene(t, stem)), None)
        if hit is not None:
            part = hit[hit.find("scenes/"):]
            out.append((part if part.endswith((".tsx", ".json")) else f"scenes/{stem}.tsx", lease))
    return out


# ── snapshots ─────────────────────────────────────────────────────────────────


def _sha1(text: str) -> str:
    try:
        import _sha1  # type: ignore[import]

        return _sha1.sha1(text.encode("utf-8")).hexdigest()
    except ImportError:
        import hashlib

        return hashlib.sha1(text.encode("utf-8")).hexdigest()


def snap_dir() -> str:
    return os.path.join(os.environ.get("TMPDIR") or "/tmp", "kb-hooks")


def snap_path(root: str, call: str) -> str:
    return os.path.join(snap_dir(), f"bash-{_sha1(root + chr(0) + call)}.json")


def _stamp(st: os.stat_result) -> str:
    return f"{st.st_mtime_ns}:{st.st_size}"


def _skip(name: str) -> bool:
    return name.startswith(".") or name.endswith((".tmp", ".kbtmp"))


def stamps(root: str) -> Dict[str, str]:
    """`<st_mtime_ns>:<size>` for project.json, scenes/** and edits/*.json (dotfiles and temp files skipped)."""
    out: Dict[str, str] = {}
    try:
        out["project.json"] = _stamp(os.stat(os.path.join(root, "project.json")))
    except OSError:
        pass
    stack = ["scenes"]
    while stack:
        rel = stack.pop()
        try:
            entries = list(os.scandir(os.path.join(root, rel)))
        except OSError:
            continue
        for e in entries:
            if _skip(e.name):
                continue
            child = f"{rel}/{e.name}"
            try:
                if e.is_dir(follow_symlinks=False):
                    stack.append(child)
                elif e.is_file():
                    out[child] = _stamp(e.stat())
            except OSError:
                continue
    try:
        for e in os.scandir(os.path.join(root, "edits")):
            if e.name.endswith(".json") and not _skip(e.name) and e.is_file():
                out[f"edits/{e.name}"] = _stamp(e.stat())
    except OSError:
        pass
    return out


def _write_atomic(path: str, data: bytes) -> None:
    folder = os.path.dirname(path)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    tmp = os.path.join(folder, f".{os.path.basename(path)}.{os.getpid()}.kbtmp")
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def _prune_snaps() -> None:
    cutoff = time.time() - SNAP_TTL_S
    try:
        for e in os.scandir(snap_dir()):
            if e.name.startswith("bash-") and e.stat().st_mtime < cutoff:
                os.unlink(e.path)
    except OSError:
        pass


def bind(root: str, command: str, caller: Dict[str, Any]) -> List[str]:
    """`kb ... --agent NAME`: .kb/agents/NAME/identity.json { session, agentId, atMs }, written before kb runs."""
    if "--agent" not in command or not RUNS_KB.search(command) or not caller.get("session"):
        return []
    names = sorted(set(AGENT_FLAG.findall(command)))
    if not names:
        return []
    from . import events

    events.ensure_kb(root)
    for name in names:
        path = leases.binding_path(root, name)
        current = leases.binding(root, name)
        if current and current.get("session") == caller["session"] and current.get("agentId") == caller["agentId"]:
            continue
        body = {"session": caller["session"], "agentId": caller["agentId"], "atMs": now_ms()}
        _write_atomic(path, (json.dumps(body) + "\n").encode("utf-8"))
    return names


# ── bash-pre ──────────────────────────────────────────────────────────────────


def deny(reason: str) -> Tuple[int, str, str]:
    from .util import clean_lines

    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": clean_lines(reason)}}
    return 0, json.dumps(out, ensure_ascii=False), ""


def context(event: str, text: str) -> str:
    from .util import clean_lines

    return json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": clean_lines(text)}}, ensure_ascii=False)


def session_marker(root: str, session: str) -> str:
    return os.path.join(root, ".git", "kb", "sessions", SAFE_SESSION.sub("_", session)[:80] or "unknown")


def bash_pre(payload: Dict[str, Any]) -> Tuple[int, str, str]:
    root = project_root(payload)
    ti = tool_input(payload)
    command = ti.get("command")
    if root is None or not isinstance(command, str) or not command.strip():
        return 0, "", ""
    caller = hook_caller(payload)
    bind(root, command, caller)
    hits = leased_writes(root, command, caller)
    if hits:
        rel, lease = hits[0]
        return deny(leases.deny_reason(rel, lease) + " (kb denied this command: it writes a scene leased to someone else.)")
    record = asset_record_write(root, command, payload.get("cwd"))
    if record:
        return deny(f"{record[1]} (kb denied this command: it writes {record[0]} by hand.)")
    call = payload.get("tool_use_id")
    if isinstance(call, str) and call and not ti.get("run_in_background") and not kb_only(command):
        body: Dict[str, Any] = {"v": 1, "root": root, "atMs": now_ms(), "stamps": stamps(root)}
        named = named_sources(root, command) if writes_project(command) else []
        if named:
            body["baseline"] = baseline_errors(root, named)
        _write_atomic(snap_path(root, call), json.dumps(body, separators=(",", ":")).encode("utf-8"))
        if os.urandom(1)[0] < 4:
            _prune_snaps()
    session = caller.get("session")
    if session and os.path.isdir(os.path.join(root, ".git")) and not os.path.exists(session_marker(root, session)) and writes_project(command):
        from pathlib import Path

        from . import hooks
        from .identity import Caller
        from .project import Project

        who = by_for(root, caller, command)
        note = hooks.session_checkpoint(Project(Path(root)), session, Caller(who.get("name") or f"session-{session[:8]}", session, caller["agentId"]), "command")
        if note:
            return 0, context("PreToolUse", note), ""
    return 0, "", ""


def named_sources(root: str, command: str) -> List[str]:
    """Existing project.json and scene files the command names, so their errors before it can be told from new ones."""
    out = []
    for token in SCENE_TOKEN.findall(command):
        rel = token[token.find("scenes/"):]
        if checked(rel) and os.path.isfile(os.path.join(root, rel)) and rel not in out:
            out.append(rel)
    if "project.json" in command and os.path.isfile(os.path.join(root, "project.json")):
        out.append("project.json")
    return out[:20]


def baseline_errors(root: str, files: List[str]) -> List[str]:
    """Error signatures the named files already have (the Edit hook's rule); empty when the check cannot run."""
    try:
        from pathlib import Path

        from . import check as checkmod
        from .project import Project

        report = checkmod.check_project(Project(Path(root)), files=files)
        return sorted({f"{i.file}\0{i.path}\0{i.message}" for i in report.errors})
    except Exception:
        return []


# ── bash-post ─────────────────────────────────────────────────────────────────


def take_snapshot(root: str, call: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(call, str) or not call:
        return None
    path = snap_path(root, call)
    try:
        with open(path, "r", encoding="utf-8") as f:
            body = json.load(f)
    except (OSError, ValueError):
        return None
    try:
        os.unlink(path)
    except OSError:
        pass
    return body if isinstance(body, dict) and isinstance(body.get("stamps"), dict) else None


def diff(before: Dict[str, str], after: Dict[str, str]) -> List[str]:
    return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))


def others_wrote(root: str, since_ms: int, caller: Dict[str, Any]) -> Tuple[set, set]:
    """(other callers' writes while this command ran, this caller's own kb writes in it, which kb already checked)."""
    from . import events

    theirs, kb_own = set(), set()
    for event in events.recent_tail(root, since_ms):
        if event.get("kind") != "files.changed":
            continue
        files = {f for f in event.get("files") or [] if isinstance(f, str)}
        if not leases.same_caller(root, event.get("by"), caller):
            theirs |= files
        elif event.get("via") == "kb":
            kb_own |= files
    return theirs, kb_own


def checked(rel: str) -> bool:
    return rel == "project.json" or bool(re.match(r"^scenes/[^/]+\.(?:tsx|json)$", rel))


def relevant(issue: Any, changed: List[str]) -> bool:
    if issue.file in changed:
        return True
    return issue.file == "project.json" and any(c in issue.message or c in issue.path for c in changed)


def bash_post(payload: Dict[str, Any]) -> Tuple[int, str, str]:
    event = payload.get("hook_event_name") if payload.get("hook_event_name") in ("PostToolUse", "PostToolUseFailure") else "PostToolUse"
    failed = event == "PostToolUseFailure"
    root = project_root(payload)
    ti = tool_input(payload)
    command = ti.get("command")
    if root is None or not isinstance(command, str) or ti.get("run_in_background") or kb_only(command):
        return 0, "", ""
    snap = take_snapshot(root, payload.get("tool_use_id"))
    if snap is None or snap.get("root") != root:
        return 0, "", ""
    changed = diff(snap["stamps"], stamps(root))
    if not changed:
        return 0, "", ""
    caller = hook_caller(payload)
    since = int(snap.get("atMs") or 0)
    theirs, kb_own = others_wrote(root, since, caller)
    mine = [r for r in changed if r not in theirs and r not in kb_own]
    if not mine:
        return 0, "", ""
    from . import events

    by = by_for(root, caller, command)
    events.journal(root, "files.changed", by, mine, via="bash")
    errors: List[str] = []
    notes: List[str] = []
    if theirs & set(changed):
        notes.append(f"Other agents also changed {', '.join(sorted(theirs & set(changed)))} while this command ran; kb left those out.")
    edits = [r for r in mine if r.startswith("edits/")]
    if edits and not re.search(r"\bkb(?:\.py)?[\"']?\s+(?:--?\S+\s+)*video\b", command):
        errors.append(
            f"This command changed {', '.join(edits)}: only kb video changes edits/ (the app's video editor documents). "
            f"Put it back with git checkout -- {' '.join(edits)} and make the change with ./kb video."
        )
    for stem in sorted({s for s in (leases.scene_of(r) for r in mine) if s}):
        lease = leases.read(root, stem)
        if lease is None:
            continue
        files = [r for r in mine if leases.scene_of(r) == stem]
        if leases.is_holder(root, lease, caller):
            leases.renew_if_due(root, stem, lease, by)
            continue
        events.append(root, "lease.violated", by, scene=stem, files=files, holder=lease.get("holder"))
        errors.append(
            f"This command changed {', '.join(files)}, which {'is' if len(files) == 1 else 'are'} leased to {leases.holder_name(lease)} "
            f"until {leases.clock(lease.get('untilMs'))}. Leave the scene alone from now on and tell them what changed: "
            f"./kb note \"...\" --scene {stem}."
        )
    targets = [r for r in mine if checked(r)]
    if targets:
        from pathlib import Path

        from . import check as checkmod
        from .project import Project

        report = checkmod.check_project(Project(Path(root)), files=None if len(targets) > CHECK_ALL_OVER else targets)
        shown = [i for i in report.issues if relevant(i, targets)] if len(targets) <= CHECK_ALL_OVER else report.issues
        from .util import Report

        known = set(snap.get("baseline") or [])
        older = [i for i in shown if i.severity == "error" and f"{i.file}\0{i.path}\0{i.message}" in known]
        scoped = Report()
        scoped.issues = [i for i in shown if i not in older]
        if older:
            earlier = Report()
            earlier.issues = older
            notes.append(f"{len(older)} error(s) were already there before this command (not caused by it); fix them if they touch the task:\n{earlier.render('error')}")
        if scoped.errors:
            errors.append(f"kb check found problems in files this command changed: {', '.join(targets[:8])}{' ...' if len(targets) > 8 else ''}\n"
                          f"{scoped.render('error')}\nFix every error (prefer Edit or ./kb doc for scene files), then rerun ./kb check.")
        if scoped.warnings:
            notes.append(f"kb check after this command: {scoped.summary()}\n{scoped.render('warning')}")
    if errors and not failed:
        text = "\n".join(errors + notes)
        return BLOCK, "", text
    if errors or notes:
        return 0, context(event, "\n".join(errors + notes)), ""
    return 0, "", ""


# ── entry ─────────────────────────────────────────────────────────────────────


def run(event: str, payload: Any) -> Tuple[int, str, str]:
    if not isinstance(payload, dict):
        return 0, "", ""
    if event == "bash-pre":
        return bash_pre(payload)
    if event == "bash-post":
        return bash_post(payload)
    return 0, "", ""


def read_payload(raw: Optional[str] = None) -> Any:
    if raw is None:
        try:
            raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        except (OSError, ValueError):
            raw = ""
    try:
        return json.loads(raw) if raw.strip() else {}
    except ValueError:
        return {}


def main(event: str, raw: Optional[str] = None) -> int:
    """Hook entry: a kb bug or a broken payload never blocks the command (exit 0)."""
    try:
        code, out, err = run(event, read_payload(raw))
    except Exception:
        return 0
    try:
        if out:
            sys.stdout.write(out if out.endswith("\n") else out + "\n")
        if err:
            sys.stderr.write(err if err.endswith("\n") else err + "\n")
    except (OSError, ValueError):
        pass
    return code
