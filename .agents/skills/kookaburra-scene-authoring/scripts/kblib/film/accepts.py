"""Accepted flash warnings: a flash warning a person looked at, with their reason, kept in the project's `flashes.accepted.json` so later checks show it once instead of repeating it. A failure is never accepted."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Optional

from ..util import EXIT_ENV, EXIT_PROBLEMS, KbError, now_ms

FILE = "flashes.accepted.json"
VERSION = 1
# A later check's warning is the same one when it lands this close in its scene.
MATCH_MS = 750
# `accept TC` takes the warnings whose span holds TC give or take this much.
PICK_MS = 250


def entries(doc: Any) -> List[Dict[str, Any]]:
    rows = doc.get("accepted") if isinstance(doc, dict) else None
    return [r for r in rows or [] if isinstance(r, dict) and isinstance(r.get("why"), str)]


def load(project: Any) -> List[Dict[str, Any]]:
    try:
        doc = json.loads((project.root / FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return entries(doc)


def project_ms(issue: Dict[str, Any]) -> float:
    at = issue.get("projectMs")
    return float(at if isinstance(at, (int, float)) else issue.get("startMs") or 0)


def entry_id(issue: Dict[str, Any]) -> str:
    scene = issue.get("scene") if isinstance(issue.get("scene"), dict) else {}
    key = f"{issue.get('type')}|{issue.get('standard')}|{scene.get('stem')}|{int(scene.get('localMs') or project_ms(issue)) // 100}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]


def matches(entry: Dict[str, Any], issue: Dict[str, Any]) -> bool:
    """The same warning: kind and standard, in the same scene near the same moment (or the same film time without one)."""
    if issue.get("severity") != "warn":
        return False
    if entry.get("type") != issue.get("type") or entry.get("standard") != issue.get("standard"):
        return False
    scene = issue.get("scene") if isinstance(issue.get("scene"), dict) else {}
    if entry.get("scene") and scene.get("stem"):
        return entry["scene"] == scene["stem"] and abs(float(entry.get("localMs") or 0) - float(scene.get("localMs") or 0)) <= MATCH_MS
    return abs(float(entry.get("atMs") or 0) - project_ms(issue)) <= MATCH_MS


def apply(report: Optional[Dict[str, Any]], accepted: List[Dict[str, Any]]) -> int:
    """Marks each warning a person accepted (`accepted: { id, why }`); failures stay as they are. Returns how many."""
    if not report or not accepted:
        return 0
    n = 0
    for issue in report.get("issues") or []:
        if not isinstance(issue, dict):
            continue
        hit = next((e for e in accepted if matches(e, issue)), None)
        if hit is not None:
            issue["accepted"] = {"id": hit.get("id"), "why": hit.get("why"), "by": hit.get("by")}
            n += 1
    report["acceptedCount"] = n
    return n


def at(report: Dict[str, Any], ms: float) -> List[Dict[str, Any]]:
    """The issues whose span holds `ms` (project time)."""
    out = []
    for issue in report.get("issues") or []:
        if not isinstance(issue, dict):
            continue
        start = project_ms(issue)
        length = max(0.0, float(issue.get("endMs") or 0) - float(issue.get("startMs") or 0))
        if start - PICK_MS <= ms <= start + length + PICK_MS:
            out.append(issue)
    return out


def new_entries(report: Dict[str, Any], ms: float, why: str, by: str, source: str) -> List[Dict[str, Any]]:
    """The entries `kb flashes accept` stores for the warnings at `ms`; refuses a failure there, or no warning at all."""
    if not why.strip():
        raise KbError("--why needs the reason the warning is fine, in a sentence", EXIT_ENV, kind="usage")
    found = at(report, ms)
    fails = [i for i in found if i.get("severity") == "fail"]
    if fails:
        raise KbError(f"{fails[0].get('tc')} is a flash FAILURE ({fails[0].get('type')}, {fails[0].get('standard')}); failures can never be accepted",
                      EXIT_PROBLEMS, kind="flashes", hint="fix the flash (hold each state 334 ms or more, or soften the change), then check again")
    warns = [i for i in found if i.get("severity") == "warn"]
    if not warns:
        times = ", ".join(str(i.get("tc")) for i in report.get("issues") or [] if isinstance(i, dict)) or "none"
        raise KbError(f"no flash warning at {ms / 1000:.2f}s in the last check ({source}); its moments: {times}", EXIT_PROBLEMS, kind="invalid",
                      hint="give a time inside a warning's span, as the check printed it (e.g. 00:35.4)")
    out = []
    for issue in warns:
        scene = issue.get("scene") if isinstance(issue.get("scene"), dict) else {}
        out.append({"id": entry_id(issue), "type": issue.get("type"), "standard": issue.get("standard"), "tc": issue.get("tc"),
                    "atMs": int(round(project_ms(issue))), "scene": scene.get("stem"), "localMs": scene.get("localMs"),
                    "flashesPerSecond": issue.get("flashesPerSecond"), "areaPct": issue.get("areaPct"),
                    "why": why.strip(), "by": by, "acceptedAtMs": now_ms(), "source": source})
    return out


def merged(doc: Any, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """The file with `rows` added, replacing any entry with the same id."""
    keep = [e for e in entries(doc) if e.get("id") not in {r["id"] for r in rows}]
    return {"version": VERSION, "accepted": keep + rows}


def without(doc: Any, ids: List[str]) -> Optional[Dict[str, Any]]:
    """The file without the entries `ids` names; None when nothing matches."""
    rows = entries(doc)
    keep = [e for e in rows if e.get("id") not in ids]
    return None if len(keep) == len(rows) else {"version": VERSION, "accepted": keep}
