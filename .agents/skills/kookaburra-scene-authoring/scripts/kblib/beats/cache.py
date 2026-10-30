"""The soundtrack's song analysis as the app caches it (`<sha>-v3.json`) and kb copies it (`.kb/song/<sha12>.json`).

The readers scripts/beats.py always had (kb video align uses them through that shim): the analysis, its beats and
tempo, the timeline slots and the effective key moments, in project and scene-local time.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

APP_CACHE = Path.home() / "Library/Application Support/com.mpalmes.kookaburracut/cache/beats"
CACHE_DIR = APP_CACHE
ANALYSIS_VERSION = 3
SUPPORTED_VERSIONS = (1, 2, 3)
FITTED_VERSIONS = (2, 3)
V1_WARNING = ("beats: this analysis is v1 (unrefined, beats up to ~30 ms off); run ./kb song analyse, or open the project "
              "in an updated Kookaburra Cut, to refresh it")
MARKER_MATCH_MS = 30
MANUAL_STRENGTH = 0.8
SONG_DIR = "song"


def default_cache_dir() -> Path:
    """KB_BEATS_CACHE_DIR (tests), else the app's cache/beats folder."""
    override = os.environ.get("KB_BEATS_CACHE_DIR")
    return Path(override) if override else CACHE_DIR


def read_json(path: Any) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_analysis(digest: str, load_json: Callable[[Any], Any] = read_json, cache_dir: Optional[Any] = None) -> Tuple[Any, Optional[Path]]:
    """The app's cached analysis for a soundtrack's SHA-256, newest version first (each before its forced-DSP copy), then v1: (analysis, path), or (None, None)."""
    base = Path(cache_dir) if cache_dir else default_cache_dir()
    named = [base / f"{digest}-v{v}{tail}.json" for v in reversed(FITTED_VERSIONS) for tail in ("", "-dsp")]
    for path in named + [base / f"{digest}.json"]:
        if path.is_file():
            return load_json(path), path
    return None, None


def file_digest(path: Path) -> Optional[str]:
    """Lowercase hex SHA-256 of a file's bytes, streamed; None when it can't be read."""
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    except OSError:
        return None
    return h.hexdigest()


def copy_rel(digest: str) -> str:
    """Where kb song analyse keeps its copy of an analysis: .kb/song/<first 12 hex of the SHA-256>.json."""
    return f".kb/{SONG_DIR}/{digest[:12]}.json"


def has_song_map(analysis: Any) -> bool:
    """Whether an analysis carries the hits, audible end and form (v3 on)."""
    return isinstance(analysis, dict) and isinstance(analysis.get("hits"), dict) and isinstance(analysis.get("ending"), dict)


def project_analysis(root: Path, digest: str) -> Tuple[Optional[Dict[str, Any]], Optional[Path]]:
    """The analysis for these exact bytes: kb's own copy first (the one kb song analyse showed), then the app's cache."""
    copy = root / copy_rel(digest)
    if copy.is_file():
        try:
            data = read_json(copy)
        except (OSError, ValueError):
            data = None
        if isinstance(data, dict) and data.get("sha256") == digest and data.get("version") in SUPPORTED_VERSIONS:
            return data, copy
    try:
        data, path = load_analysis(digest)
    except (OSError, ValueError):
        return None, None
    return (data, path) if isinstance(data, dict) else (None, None)


def beat_times(analysis: Dict[str, Any]) -> List[float]:
    """Track ms of every beat: v2 stores {ms, bar, beat, conf} objects, v1 bare numbers."""
    times = []
    for b in analysis.get("beats", []):
        if isinstance(b, dict):
            b = b.get("ms")
        if isinstance(b, (int, float)) and not isinstance(b, bool):
            times.append(b)
    return times


def downbeat_times(analysis: Dict[str, Any]) -> List[float]:
    """Track ms of each v2 beat the tracker labelled beat 1 (none for v1)."""
    return [b["ms"] for b in analysis.get("beats", []) if isinstance(b, dict) and b.get("beat") == 1
            and isinstance(b.get("ms"), (int, float)) and not isinstance(b.get("ms"), bool)]


def tempo(analysis: Dict[str, Any]) -> Tuple[Any, Any]:
    """(bpm, beat interval ms): v2's fitted periodMs as stored, never re-derived from a rounded bpm."""
    fit = analysis.get("fit")
    if isinstance(fit, dict) and fit.get("periodMs"):
        return fit.get("bpm"), fit["periodMs"]
    bpm = analysis.get("bpm")
    return bpm, (round(60_000 / bpm) if bpm else None)


def build_slots(scenes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Mirror engine/sceneTimeline.ts: a scene's outgoing transition pulls the next start back."""
    slots: List[Dict[str, Any]] = []
    for i, sc in enumerate(scenes):
        duration = sc.get("durationMs", 0)
        start = 0
        t_in = 0
        if i:
            prev = slots[-1]
            spec = scenes[i - 1].get("transition") or {}
            t_in = max(0, min(spec.get("durationMs", 0) or 0, prev["durationMs"], duration))
            start = prev["endMs"] - t_in
        slots.append({
            "index": i,
            "stem": Path(sc.get("file", f"scene-{i}")).stem,
            "startMs": start,
            "durationMs": duration,
            "endMs": start + duration,
            "transitionInMs": t_in,
        })
    for i, slot in enumerate(slots):
        next_in = slots[i + 1]["transitionInMs"] if i + 1 < len(slots) else 0
        slot["windowStartMs"] = slot["transitionInMs"] / 2
        slot["windowEndMs"] = slot["durationMs"] - next_in / 2
        slot["transitionOutStartMs"] = slot["durationMs"] - next_in if next_in else slot["windowEndMs"]
    return slots


def effective_key_moments(analysis: Dict[str, Any], markers: Any, start_offset: float, total: float) -> Tuple[List[Dict[str, Any]], str]:
    """Mirror engine/beatState.ts: markers replace detection wholesale, in project time."""
    detected = [
        {"tMs": m["tMs"] - start_offset, "strength": m.get("strength", 0)}
        for m in analysis.get("keyMoments", [])
    ]
    detected = [m for m in detected if 0 <= m["tMs"] <= total]
    if not markers:
        return detected, "detected"
    moments = []
    for t in markers.get("keyMoments", []):
        if not 0 <= t <= total:
            continue
        near = next((m for m in detected if abs(m["tMs"] - t) <= MARKER_MATCH_MS), None)
        moments.append({"tMs": t, "strength": near["strength"] if near else MANUAL_STRENGTH})
    return sorted(moments, key=lambda m: m["tMs"]), "project.json audio.markers"


def scene_local(slot: Dict[str, Any], times: List[float]) -> List[float]:
    return [t - slot["startMs"] for t in times if slot["startMs"] <= t <= slot["endMs"]]


def fmt_moments(moments: List[Dict[str, Any]]) -> str:
    return ", ".join(f"{round(m['tMs'])} ({m['strength']:.2f})" for m in moments) or "none"
