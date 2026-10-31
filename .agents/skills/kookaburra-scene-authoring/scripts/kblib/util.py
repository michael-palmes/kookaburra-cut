"""Shared plumbing: exit codes, errors, JSON IO, atomic writes, issue reports."""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

EXIT_OK = 0
EXIT_PROBLEMS = 1
EXIT_ENV = 2
EXIT_TRANSIENT = 3

WORKSPACE_DIR_NAME = "Kookaburra Cut"

# ── Output escaping ───────────────────────────────────────────────────────────
# Text from project files (scene names, copy, paths) reaches the agent's context and the terminal through kb, so every
# output boundary escapes control and format characters as visible \uXXXX and caps one string. The app's bridge
# (`clean_text.rs`) applies the same rule to its answers.

CLEAN_CAP = 500
_UNSAFE = re.compile(
    "[\x00-\x08\x0b-\x1f\x7f-\x9f­؀-؅؜۝܏࢐࢑࣢᠎"
    "​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻"
    "\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a"
    "\U000e0001\U000e0020-\U000e007f]"
)


def _escape(match: "re.Match[str]") -> str:
    code = ord(match.group())
    return f"\\u{code:04X}" if code <= 0xFFFF else f"\\U{code:08X}"


def clean_text(text: Any, cap: Optional[int] = CLEAN_CAP) -> Any:
    """Escape every control (newline and tab excepted) and format character, bidi and tag characters included, then
    cap the string with a marker saying how much was dropped. Anything that is not a string passes through."""
    if not isinstance(text, str):
        return text
    clean = _UNSAFE.sub(_escape, text) if _UNSAFE.search(text) else text
    if cap is not None and len(clean) > cap:
        clean = f"{clean[:cap]} …[+{len(clean) - cap} chars]"
    return clean


def clean_lines(text: str) -> str:
    """`clean_text` line by line, so a long report keeps every line and each line keeps the cap."""
    return "\n".join(clean_text(line) for line in text.split("\n"))


def clean_value(value: Any) -> Any:
    """Every string in a JSON-shaped value, keys included."""
    if isinstance(value, str):
        return clean_text(value)
    if isinstance(value, list):
        return [clean_value(v) for v in value]
    if isinstance(value, tuple):
        return [clean_value(v) for v in value]
    if isinstance(value, dict):
        return {clean_text(k) if isinstance(k, str) else k: clean_value(v) for k, v in value.items()}
    return value

DEFAULT_KIND = {EXIT_PROBLEMS: "failed", EXIT_ENV: "env", EXIT_TRANSIENT: "transient"}

DEFAULT_HINTS: Dict[str, str] = {
    "usage": "run ./kb <command> --help",
    "no-app": "ask the user to open Kookaburra Cut, or run the static ./kb check",
    "needs-trust": "ask the user to open this project once in Kookaburra Cut",
    "invalid": "fix the file named above, then rerun",
    "leased": "leave the holder a ./kb note, or wait for the lease to end (./kb leases)",
    "others-changed": "undo only your own scene with ./kb undo --scene S, or pass --all",
    "conflict": "re-read the file and rerun the command",
    "locked": "another kb command holds the project lock; rerun in a moment",
    "index-locked": "another git process holds .git/index.lock; rerun in a moment",
    "app-busy": "the app is busy (exporting or rendering); rerun in a moment",
    "bridge-timeout": "the app did not answer in time; check ./kb status, then rerun",
    "gpu-stalled": "the render window was recycled; rerun once, with fewer or smaller frames",
    "gpu-wedged": "ask the user to quit and reopen Kookaburra Cut",
    "app-reloaded": "ask the user to quit and reopen Kookaburra Cut, then rerun",
    "throttled": "capture fewer or smaller frames (--scale 0.5), then rerun after retryAfterMs",
    "too-large": "use the default sheet size or --scale, and fewer frames",
    "flashes": "fix the flagged moments, or pass --allow-flashes after checking them",
    "no-grid": "./kb song analyse, then ./kb beats set-grid --from-analysis",
    "not-a-folder": "it came with the folder: move it aside with mv, then rerun",
    "transient": "rerun in a moment",
}


class KbError(Exception):
    """A failure with a message that says what to do next.

    `code` is the exit code (0 ok, 1 problems, 2 usage or environment, 3 transient); `kind` is the
    stable kebab-case id printed as the envelope's `code`; `hint` is the single next step.
    """

    def __init__(
        self,
        message: str,
        code: int = EXIT_PROBLEMS,
        *,
        kind: Optional[str] = None,
        hint: Optional[str] = None,
        retry_after_ms: Optional[int] = None,
        data: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.message = clean_text(message)
        self.code = code
        self.kind = kind or DEFAULT_KIND.get(code, "failed")
        self.hint = clean_text(hint) if hint is not None else DEFAULT_HINTS.get(self.kind)
        self.retry_after_ms = retry_after_ms
        self.data = data or {}

    def envelope(self, command: str) -> Dict[str, Any]:
        out: Dict[str, Any] = {"ok": False, "command": command, "code": self.kind, "error": self.message}
        if self.hint:
            out["hint"] = self.hint
        if self.retry_after_ms is not None:
            out["retryAfterMs"] = int(self.retry_after_ms)
        for key, value in self.data.items():
            out.setdefault(key, value)
        return out

    def text(self) -> str:
        lines = [f"kb: {self.message}"]
        if self.hint:
            lines.append(f"  hint: {self.hint}")
        return "\n".join(lines)


def ok_envelope(
    command: str,
    payload: Optional[Dict[str, Any]] = None,
    *,
    ok: Optional[bool] = None,
    code: Optional[str] = None,
    error: Optional[str] = None,
) -> Dict[str, Any]:
    """The --json shape: { ok, command, ...payload } (lists live under plural keys, never bare).

    ok defaults to the payload's own boolean "ok" (a check's verdict), else True. A report that exits 1 (problems
    found) is ok false and carries `code` (default "failed") and `error`, like a failure envelope.
    """
    body = dict(payload or {})
    own = body.pop("ok", None)
    flag = ok if ok is not None else (own if isinstance(own, bool) else True)
    out: Dict[str, Any] = {"ok": flag, "command": command}
    if not flag:
        out["code"] = code or body.pop("code", None) or "failed"
        out["error"] = error or body.pop("error", None) or "problems found (see the rest of this object)"
    for key, value in body.items():
        out.setdefault(key, value)
    return out


COMMAND_DESTS = ("command", "op", "action", "vop", "tap_op", "mask_op", "taps_op")
_command = ""


def command_name(args: Any) -> str:
    """The envelope's `command`: the subcommand and its ops, for example "scene add" or "video tap add"."""
    parts = []
    for dest in COMMAND_DESTS:
        value = getattr(args, dest, None)
        if isinstance(value, str) and value:
            parts.append(value)
    return " ".join(parts)


def set_command(name: str) -> None:
    """The command this kb process runs, for emit_ok() in modules that are not handed it."""
    global _command
    _command = name


def emit_ok(payload: Optional[Dict[str, Any]] = None, **kwargs: Any) -> None:
    emit_json(ok_envelope(_command, payload, **kwargs))


def home() -> Path:
    return Path(os.path.expanduser("~"))


def bridge_dir() -> Path:
    """KB_BRIDGE_DIR, else the app's KOOKABURRA_BRIDGE_DIR (absolute only, as the app reads it), else ~/Kookaburra Cut/_bridge."""
    override = os.environ.get("KB_BRIDGE_DIR")
    if override:
        return Path(override)
    app_dir = os.environ.get("KOOKABURRA_BRIDGE_DIR", "").strip()
    if app_dir and os.path.isabs(app_dir):
        return Path(app_dir)
    return home() / WORKSPACE_DIR_NAME / "_bridge"


def trash_dir() -> Path:
    override = os.environ.get("KB_TRASH_DIR")
    if override:
        return Path(override)
    return home() / ".Trash"


def now_ms() -> int:
    return int(time.time() * 1000)


def ago(ms: Optional[float]) -> str:
    if not ms:
        return "unknown"
    secs = max(0, (now_ms() - float(ms)) / 1000)
    if secs < 90:
        return f"{int(secs)}s ago"
    if secs < 5400:
        return f"{int(secs // 60)} min ago"
    if secs < 172800:
        return f"{int(secs // 3600)} h ago"
    return f"{int(secs // 86400)} days ago"


def fmt_secs(ms: Any) -> str:
    if not isinstance(ms, (int, float)) or isinstance(ms, bool):
        return "?"
    if ms >= 60000:
        return f"{int(ms // 60000)}m {(ms % 60000) / 1000:.1f}s"
    return f"{ms / 1000:.1f}s"


def is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def read_text(path: Path) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def load_json_text(text: str, label: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise KbError(f"{label} is not valid JSON (line {e.lineno} column {e.colno}: {e.msg}); fix the syntax first") from None


def load_json(path: Path, label: Optional[str] = None) -> Any:
    label = label or str(path)
    try:
        text = read_text(path)
    except FileNotFoundError:
        raise KbError(f"{label} does not exist") from None
    except OSError as e:
        raise KbError(f"cannot read {label}: {e.strerror}") from None
    except UnicodeDecodeError:
        raise KbError(f"{label} is not UTF-8 text") from None
    return load_json_text(text, label)


def dump_json(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def atomic_write_text(path: Path, text: str) -> None:
    """Temp file in the same folder, fsync, then rename: the bytes land whole or not at all."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".kbtmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        if path.exists():
            try:
                os.chmod(tmp, path.stat().st_mode & 0o777)
            except OSError:
                pass
        else:
            os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def atomic_write_json(path: Path, value: Any) -> None:
    text = dump_json(value)
    atomic_write_text(path, text)
    try:
        json.loads(read_text(path))
    except (OSError, ValueError) as e:
        raise KbError(f"wrote {path} but it does not read back as JSON ({e}); restore it with kb undo") from None


def file_sha256(path: Path) -> Optional[str]:
    """Lowercase hex SHA-256 of the file's bytes (the app's content hash), or None when it cannot be read."""
    import hashlib

    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None


def js_json(value: Any) -> Any:
    """Numbers as JSON.stringify writes them: integral floats as ints, -0 as 0."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float):
        if value.is_integer() and abs(value) < 2 ** 53:
            return int(value)
        return value
    if isinstance(value, dict):
        return {k: js_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [js_json(v) for v in value]
    return value


def exact_case_exists(root: Path, rel: str) -> Optional[str]:
    """None when `rel` exists under root with exactly this case; else a reason ("missing" or the on-disk spelling)."""
    current = root
    parts = [p for p in rel.split("/") if p]
    for i, part in enumerate(parts):
        try:
            names = os.listdir(current)
        except OSError:
            return "missing"
        if part in names:
            current = current / part
            continue
        lowered = [n for n in names if n.lower() == part.lower()]
        if lowered:
            fixed = "/".join(parts[:i] + [lowered[0]] + parts[i + 1:])
            return f"case differs from disk ({fixed})"
        return "missing"
    return None


def safe_rel(rel: str) -> bool:
    parts = rel.split("/")
    return bool(rel) and not rel.startswith("/") and all(p not in ("", ".", "..") for p in parts)


class Issue:
    __slots__ = ("severity", "file", "path", "message")

    def __init__(self, severity: str, file: str, path: str, message: str) -> None:
        self.severity = severity
        # `file` and `path` stay raw: `for_file` and the hooks match them against project-relative paths.
        self.file = file
        self.path = path
        self.message = clean_text(message)

    def as_dict(self) -> Dict[str, str]:
        return {"severity": self.severity, "file": clean_text(self.file), "path": clean_text(self.path), "message": self.message}

    def line(self) -> str:
        where = f"{clean_text(self.path)}: " if self.path else ""
        return f"{clean_text(self.file)}: {where}{self.message}"


class Report:
    """Errors and warnings grouped by file, in the order found."""

    def __init__(self) -> None:
        self.issues: List[Issue] = []

    def error(self, file: str, path: str, message: str) -> None:
        self.issues.append(Issue("error", file, path, message))

    def warn(self, file: str, path: str, message: str) -> None:
        self.issues.append(Issue("warning", file, path, message))

    def info(self, file: str, path: str, message: str) -> None:
        """Worth knowing, never a problem: counted in neither summary total."""
        self.issues.append(Issue("info", file, path, message))

    def extend(self, issues: Iterable[Issue]) -> None:
        for issue in issues:
            if not any(
                i.severity == issue.severity and i.file == issue.file and i.path == issue.path and i.message == issue.message
                for i in self.issues
            ):
                self.issues.append(issue)

    @property
    def errors(self) -> List[Issue]:
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self) -> List[Issue]:
        return [i for i in self.issues if i.severity == "warning"]

    def for_file(self, file: str) -> List[Issue]:
        return [i for i in self.issues if i.file == file]

    def summary(self) -> str:
        e, w = len(self.errors), len(self.warnings)
        return f"{e} error{'s' if e != 1 else ''}, {w} warning{'s' if w != 1 else ''}"

    def render(self, only: Optional[str] = None) -> str:
        files: List[str] = []
        for issue in self.issues:
            if only and issue.severity != only:
                continue
            if issue.file not in files:
                files.append(issue.file)
        out: List[str] = []
        for file in files:
            out.append(clean_text(file))
            for issue in self.issues:
                if issue.file != file or (only and issue.severity != only):
                    continue
                tag = {"error": "error", "info": "info "}.get(issue.severity, "warn ")
                where = f"{clean_text(issue.path)}: " if issue.path else ""
                out.append(f"  {tag}  {where}{issue.message}")
        return "\n".join(out)

    def as_json(self) -> Dict[str, Any]:
        return {
            "ok": not self.errors,
            "errors": len(self.errors),
            "warnings": len(self.warnings),
            "issues": [i.as_dict() for i in self.issues],
        }


def emit(text: str) -> None:
    text = clean_lines(text)
    sys.stdout.write(text if text.endswith("\n") else text + "\n")


def emit_err(text: str) -> None:
    text = clean_lines(text)
    sys.stderr.write(text if text.endswith("\n") else text + "\n")


def emit_json(value: Any) -> None:
    sys.stdout.write(json.dumps(clean_value(value), indent=2, ensure_ascii=False) + "\n")


def json_line(value: Any) -> str:
    """One compact, cleaned JSON object for streaming commands."""
    return json.dumps(clean_value(value), separators=(",", ":"), ensure_ascii=False) + "\n"
