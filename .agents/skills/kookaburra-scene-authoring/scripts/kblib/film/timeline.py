"""Mirror of src/engine/sceneTimeline.ts (`buildSceneTimeline`, `resolveOverlapMs`, `resolveAt`) and `outgoingSceneTransitions`, pinned by tests/fixtures/timeline-vectors.json; plus the project's own timeline and the export frame grid."""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Tuple

from ..project import DEFAULT_SCENE_DURATION_MS, Project, stem_of
from ..util import is_number

KNOWN_TYPES = (
    "crossfade", "dip", "slide", "wipe", "blur", "push", "zoom", "whip", "luma", "glitch", "slice", "dissolve", "warp",
    "inkbleed", "flowmorph", "shockwave", "glasssweep", "rackfocus", "halftone", "lightsweep", "shatter",
    "pixelstretch", "chromasplit", "datamosh", "prism", "spinblur",
)

_DURATION_RE = re.compile(r"\bdurationMs\s*:\s*([0-9]+(?:\.[0-9]+)?)")


def normalize_transition_type(kind: Any) -> str:
    return kind if isinstance(kind, str) and kind in KNOWN_TYPES else "crossfade"


def resolve_overlap_ms(spec: Optional[Dict[str, Any]], prev_ms: float, next_ms: float) -> float:
    dur = spec.get("durationMs") if isinstance(spec, dict) else None
    return max(0, min(dur if is_number(dur) else 0, prev_ms, next_ms))


def outgoing_transitions(manifest: Dict[str, Any]) -> List[Optional[Dict[str, Any]]]:
    """v2 reads each scene's own transition; unversioned (legacy) files stored it on the incoming scene."""
    scenes = [s if isinstance(s, dict) else {} for s in manifest.get("scenes") or []]
    version = manifest.get("version")
    if is_number(version) and version >= 2:
        return [s.get("transition") if isinstance(s.get("transition"), dict) else None for s in scenes]
    out: List[Optional[Dict[str, Any]]] = []
    for i in range(len(scenes)):
        nxt = scenes[i + 1].get("transition") if i + 1 < len(scenes) else None
        out.append(nxt if isinstance(nxt, dict) else None)
    return out


def build_scene_timeline(scenes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Each scene `{ id, durationMs, transition? }` placed on the global timeline (slot dicts shaped like SceneSlot)."""
    slots: List[Dict[str, Any]] = []
    for i, sc in enumerate(scenes):
        start: float = 0
        transition_in: Optional[Dict[str, Any]] = None
        if i > 0:
            prev = slots[i - 1]
            spec = scenes[i - 1].get("transition")
            overlap = resolve_overlap_ms(spec, prev["durationMs"], sc["durationMs"])
            start = prev["endMs"] - overlap
            if isinstance(spec, dict) and overlap > 0:
                transition_in = dict(spec, type=normalize_transition_type(spec.get("type")), durationMs=overlap)
        slot: Dict[str, Any] = {"index": i, "id": sc["id"], "startMs": start, "durationMs": sc["durationMs"], "endMs": start + sc["durationMs"]}
        if transition_in is not None:
            slot["transitionIn"] = transition_in
        slots.append(slot)
    return slots


def timeline_total_ms(slots: List[Dict[str, Any]]) -> float:
    return slots[-1]["endMs"] if slots else 0


def apply_transition_ease(ease: Any, t: float) -> float:
    if ease == "smooth":
        return t * t * (3 - 2 * t)
    if ease == "snappy":
        return 1 - (1 - t) ** 3
    return t


def _clamp(v: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, v))


def resolve_at(slots: List[Dict[str, Any]], t_ms: float) -> Dict[str, Any]:
    """The scene(s) on screen at a global instant: `{ active: [{ index, localMs }], transition }` (resolveAt without params)."""
    if not slots:
        return {"active": [], "transition": None}
    t = _clamp(t_ms, 0, timeline_total_ms(slots))
    candidates = [s for s in slots if s["startMs"] <= t < s["endMs"]]
    if not candidates:
        last = slots[-1]
        return {"active": [{"index": last["index"], "localMs": last["durationMs"]}], "transition": None}
    if len(candidates) == 1:
        s = candidates[0]
        return {"active": [{"index": s["index"], "localMs": _clamp(t - s["startMs"], 0, s["durationMs"])}], "transition": None}
    a, b = candidates[-2], candidates[-1]
    spec = b.get("transitionIn")
    if not spec:
        return {"active": [{"index": b["index"], "localMs": _clamp(t - b["startMs"], 0, b["durationMs"])}], "transition": None}
    linear = _clamp((t - b["startMs"]) / spec["durationMs"], 0, 1) if spec["durationMs"] > 0 else 1
    return {
        "active": [
            {"index": a["index"], "localMs": _clamp(t - a["startMs"], 0, a["durationMs"])},
            {"index": b["index"], "localMs": _clamp(t - b["startMs"], 0, b["durationMs"])},
        ],
        "transition": {"type": spec["type"], "progress": apply_transition_ease(spec.get("ease"), linear),
                       "fromIndex": a["index"], "toIndex": b["index"]},
    }


def scene_at(slots: List[Dict[str, Any]], t_ms: float) -> Optional[Tuple[int, float]]:
    """(index, localMs) of the scene a moment belongs to: the incoming scene mid-transition."""
    active = resolve_at(slots, t_ms)["active"]
    if not active:
        return None
    last = active[-1]
    return last["index"], last["localMs"]


def tsx_duration(project: Project, stem: str) -> Optional[float]:
    try:
        m = _DURATION_RE.search(project.read_tsx(stem))
    except (OSError, UnicodeDecodeError):
        return None
    return float(m.group(1)) if m else None


def scene_duration(project: Project, entry: Dict[str, Any]) -> float:
    """The manifest's durationMs wins; else the TSX's defineScene literal; else kb's default."""
    d = entry.get("durationMs")
    if is_number(d):
        return d
    stem = stem_of(entry.get("file") if isinstance(entry.get("file"), str) else "")
    return tsx_duration(project, stem) or DEFAULT_SCENE_DURATION_MS


def project_slots(project: Project) -> List[Dict[str, Any]]:
    """The project's timeline: slots keyed by stem, plus each scene's `file` and `stem`."""
    manifest = project.manifest()
    entries = [e if isinstance(e, dict) else {} for e in project.scene_entries()]
    outgoing = outgoing_transitions(dict(manifest, scenes=entries))
    stems = [stem_of(e.get("file") if isinstance(e.get("file"), str) else "") for e in entries]
    slots = build_scene_timeline([
        {"id": stems[i], "durationMs": scene_duration(project, e), "transition": outgoing[i]} for i, e in enumerate(entries)
    ])
    for slot, entry, stem in zip(slots, entries, stems):
        slot["stem"] = stem
        slot["file"] = entry.get("file")
    return slots


# ── the export's frame grid ──────────────────────────────────────────────────


def js_round(x: float) -> int:
    """Math.round: half towards +infinity."""
    return int(math.floor(x + 0.5))


def export_frames(total_ms: float, fps: float) -> int:
    """Frames an export renders: max(1, round(total s x fps)), the poster frame excluded."""
    return max(1, js_round(total_ms / 1000.0 * fps))


def frame_at(ms: float, fps: float, offset: int = 0) -> int:
    """The export frame showing a timeline instant (frame k shows k x 1000 / fps), shifted past a poster frame."""
    return max(0, int(math.floor(ms * fps / 1000.0 + 1e-6))) + offset


def last_frame_before(ms: float, fps: float, offset: int = 0) -> int:
    return max(0, int(math.ceil(ms * fps / 1000.0 - 1e-6)) - 1) + offset


def frame_ms(frame: int, fps: float, offset: int = 0) -> float:
    return max(0, frame - offset) * 1000.0 / fps
