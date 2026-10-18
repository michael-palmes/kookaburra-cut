"""The asset archive: files kb moved aside, in .kb/archive/<id>/<rel>, and its index, .kb/archive/index.jsonl.

One compact JSON object per line: { atMs, id, op, from, to, sha256, by, meta? }. op is "replace" (an old version a
replace kept), "unused" (an unused file moved aside), "displaced" (what a restore moved out of the way) or "restore"
(a batch put back; `restores` names it). A batch is every line of one id; `restore` puts a batch back.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import lock as lockmod
from .util import EXIT_PROBLEMS, KbError, now_ms

ARCHIVE_DIR = ".kb/archive"
INDEX_REL = f"{ARCHIVE_DIR}/index.jsonl"
KEPT_OPS = ("replace", "unused", "displaced")


def new_id(root: Path) -> str:
    """YYYYmmdd-HHMMSS-mmm, unique among the archive's folders."""
    ms = now_ms()
    base = time.strftime("%Y%m%d-%H%M%S", time.localtime(ms / 1000)) + f"-{ms % 1000:03d}"
    ident, n = base, 1
    while (Path(root) / ARCHIVE_DIR / ident).exists():
        n += 1
        ident = f"{base}-{n}"
    return ident


def dest_for(ident: str, rel: str, folder: Optional[str] = None) -> str:
    """Where rel goes in batch ident: .kb/archive/<id>/<rel>, or <folder>/<id>/<rel> for a custom folder."""
    return f"{folder.rstrip('/') if folder else ARCHIVE_DIR}/{ident}/{rel}"


def read_index(root: Path) -> List[Dict[str, Any]]:
    try:
        text = (Path(root) / INDEX_REL).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    out = []
    for line in text.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and isinstance(entry.get("id"), str):
            out.append(entry)
    return out


def line(ident: str, op: str, source: str, to: str, sha: str, caller: Any, **extra: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {"atMs": now_ms(), "id": ident, "op": op, "from": source, "to": to, "sha256": sha, "by": getattr(caller, "name", None)}
    out.update({k: v for k, v in extra.items() if v is not None})
    return out


def plan_append(tx: lockmod.Txn, lines: List[Dict[str, Any]]) -> None:
    """Append lines to the index inside tx (compare-and-swap like any other write)."""
    if not lines:
        return
    data, sha = tx.read(INDEX_REL)
    extra = "".join(json.dumps(entry, separators=(",", ":"), ensure_ascii=False) + "\n" for entry in lines).encode("utf-8")
    tx.write_bytes(INDEX_REL, (data or b"") + extra, base=sha)


def batches(root: Path) -> List[Dict[str, Any]]:
    """Each batch, oldest first: { id, atMs, op, by, items: [{ from, to, sha256, bytes? }], restored, present }."""
    entries = read_index(root)
    restored = {e.get("restores") for e in entries if e.get("op") == "restore"}
    out: Dict[str, Dict[str, Any]] = {}
    for e in entries:
        if e.get("op") not in KEPT_OPS:
            continue
        b = out.setdefault(e["id"], {"id": e["id"], "atMs": e.get("atMs"), "op": e.get("op"), "by": e.get("by"), "items": [], "restored": e["id"] in restored})
        item = {k: e.get(k) for k in ("from", "to", "sha256")}
        if e.get("meta") is not None:
            item["meta"] = e["meta"]
        item["present"] = _exists(root, str(e.get("to") or ""))
        b["items"].append(item)
    for b in out.values():
        b["present"] = sum(1 for i in b["items"] if i["present"])
    return list(out.values())


def _exists(root: Path, to: str) -> bool:
    path = Path(to) if Path(to).is_absolute() else Path(root) / to
    return path.is_file()


def pick(root: Path, ident: Optional[str]) -> Dict[str, Any]:
    """The batch to restore: ident, else the newest one not restored yet with files still in the archive."""
    found = batches(root)
    if ident:
        for b in found:
            if b["id"] == ident:
                return b
        raise KbError(f"no archive batch {ident}", EXIT_PROBLEMS, kind="invalid", hint="./kb assets restore --list")
    for b in reversed(found):
        if not b["restored"] and b["present"]:
            return b
    raise KbError("nothing in .kb/archive/ to restore", EXIT_PROBLEMS, kind="invalid", hint="./kb assets restore --list")
