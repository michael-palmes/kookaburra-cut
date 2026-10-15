"""Shared plumbing: exit codes, errors, JSON IO, atomic writes, issue reports."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

EXIT_OK = 0
EXIT_PROBLEMS = 1
EXIT_ENV = 2

WORKSPACE_DIR_NAME = "Kookaburra Cut"


class KbError(Exception):
    """A failure with a message that says what to do next, and the exit code to use."""

    def __init__(self, message: str, code: int = EXIT_PROBLEMS) -> None:
        super().__init__(message)
        self.message = message
        self.code = code


def home() -> Path:
    return Path(os.path.expanduser("~"))


def bridge_dir() -> Path:
    override = os.environ.get("KB_BRIDGE_DIR")
    if override:
        return Path(override)
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
        self.file = file
        self.path = path
        self.message = message

    def as_dict(self) -> Dict[str, str]:
        return {"severity": self.severity, "file": self.file, "path": self.path, "message": self.message}

    def line(self) -> str:
        where = f"{self.path}: " if self.path else ""
        return f"{self.file}: {where}{self.message}"


class Report:
    """Errors and warnings grouped by file, in the order found."""

    def __init__(self) -> None:
        self.issues: List[Issue] = []

    def error(self, file: str, path: str, message: str) -> None:
        self.issues.append(Issue("error", file, path, message))

    def warn(self, file: str, path: str, message: str) -> None:
        self.issues.append(Issue("warning", file, path, message))

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
            out.append(file)
            for issue in self.issues:
                if issue.file != file or (only and issue.severity != only):
                    continue
                tag = "error" if issue.severity == "error" else "warn "
                where = f"{issue.path}: " if issue.path else ""
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
    sys.stdout.write(text if text.endswith("\n") else text + "\n")


def emit_err(text: str) -> None:
    sys.stderr.write(text if text.endswith("\n") else text + "\n")


def emit_json(value: Any) -> None:
    sys.stdout.write(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
