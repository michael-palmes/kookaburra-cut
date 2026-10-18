"""Static pacing from the project files: words per scene against reading speed, the longest stretch with no keyed motion, and scenes too short to read as anything but a flash."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from ..project import Project
from ..util import KbError, is_number

WORDS_PER_SECOND = 3.0
MIN_SCENE_MS = 334
STILL_WARN_MS = 6000
KEYED_BLOCKS = ("camera", "cameraRig", "deviceTrack", "lighting")

_WORD_RE = re.compile(r"[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)


def count_words(text: Any) -> int:
    return len(_WORD_RE.findall(text)) if isinstance(text, str) else 0


def scene_words(doc: Optional[Dict[str, Any]]) -> int:
    """Words a viewer reads: managed text items (bullet points too, not icons) and sidecar `text` values they do not own."""
    if not doc:
        return 0
    total = 0
    managed = doc.get("managedText")
    items = managed.get("items") if isinstance(managed, dict) else None
    owned = set()
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("key"), str):
            owned.add(item["key"])
        if item.get("type") == "icon":
            continue
        points = item.get("points")
        if isinstance(points, list) and points:
            total += sum(count_words(p.get("text")) for p in points if isinstance(p, dict))
        else:
            total += count_words(item.get("text"))
    text = doc.get("text")
    if isinstance(text, dict):
        total += sum(count_words(v) for k, v in text.items() if k not in owned)
    return total


def _keys(block: Any) -> List[float]:
    keys = block.get("keys") if isinstance(block, dict) else None
    return [float(k["tMs"]) for k in keys or [] if isinstance(k, dict) and is_number(k.get("tMs"))]


def keyed_times(doc: Optional[Dict[str, Any]]) -> List[float]:
    """Scene-local key times of the camera, rig, device, lighting and chart tracks."""
    if not doc:
        return []
    times: List[float] = []
    for name in KEYED_BLOCKS:
        times += _keys(doc.get(name))
    chart = doc.get("chart")
    if isinstance(chart, dict):
        times += _keys(chart.get("track"))
    return times


def check(project: Project, slots: List[Dict[str, Any]]) -> Dict[str, Any]:
    scenes: List[Dict[str, Any]] = []
    warnings: List[str] = []
    events: List[float] = []
    track = project.manifest().get("camera")
    for key in track if isinstance(track, list) else []:
        if isinstance(key, dict) and is_number(key.get("tMs")):
            events.append(float(key["tMs"]))
    for slot in slots:
        stem = slot.get("stem") or ""
        try:
            doc = project.load_sidecar(stem)
        except KbError:
            doc = None
        words = scene_words(doc)
        seconds = slot["durationMs"] / 1000.0
        rate = round(words / seconds, 2) if seconds > 0 else None
        row: Dict[str, Any] = {"index": slot["index"], "stem": stem, "durationMs": int(round(slot["durationMs"])), "words": words,
                               "wordsPerSecond": rate}
        if rate is not None and rate > WORDS_PER_SECOND:
            need = int(round(words / WORDS_PER_SECOND * 1000))
            row["flag"] = "too much to read"
            warnings.append(f"{stem}: {words} words in {seconds:.1f}s is {rate} a second (aim for {WORDS_PER_SECOND:g}); "
                            f"give it about {need} ms or cut words")
        if slot["durationMs"] < MIN_SCENE_MS:
            row["flag"] = "shorter than a flash"
            warnings.append(f"{stem}: {int(slot['durationMs'])} ms on screen is under {MIN_SCENE_MS} ms, so it reads as a flash; "
                            "lengthen it or merge it into a neighbour")
        events += [slot["startMs"] + t for t in keyed_times(doc) if 0 <= t <= slot["durationMs"]]
        scenes.append(row)
    total = slots[-1]["endMs"] if slots else 0
    marks = sorted(set([0.0, float(total)] + [e for e in events if 0 <= e <= total]))
    still = {"longestStillMs": 0, "fromMs": 0, "toMs": 0, "scenes": []}
    for a, b in zip(marks, marks[1:]):
        if b - a > still["longestStillMs"]:
            touched = [s.get("stem") for s in slots if s["startMs"] < b and s["endMs"] > a]
            still = {"longestStillMs": int(round(b - a)), "fromMs": int(round(a)), "toMs": int(round(b)), "scenes": touched}
    if still["longestStillMs"] > STILL_WARN_MS:
        warnings.append(f"{still['longestStillMs'] / 1000:.1f}s with no keyed camera, device, chart or lighting move "
                        f"({still['fromMs'] / 1000:.1f}-{still['toMs'] / 1000:.1f}s, {', '.join(str(s) for s in still['scenes'])}); "
                        "fine for reading, but a move or a new beat keeps it alive")
    return {"scenes": scenes, "still": still, "warnings": warnings, "wordsPerSecond": WORDS_PER_SECOND}
