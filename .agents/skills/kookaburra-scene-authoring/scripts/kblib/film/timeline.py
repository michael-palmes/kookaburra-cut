"""Mirror of src/engine/sceneTimeline.ts (`buildSceneTimeline`, `resolveOverlapMs`, `resolveAt`), `outgoingSceneTransitions` and src/engine/sceneCuts.ts (`resolveSceneCuts`), pinned by tests/fixtures/timeline-vectors.json; plus the project's own timeline and the export frame grid."""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Tuple

from .. import music as musicmod
from ..project import DEFAULT_SCENE_DURATION_MS, Project, stem_of
from ..util import is_number, js_json

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


NO_MUSIC: Dict[str, Any] = {"startOffsetMs": 0, "cues": {}, "sections": {}}


def cut_align(value: Any) -> str:
    return "mid" if value == "mid" else "end"


def resolve_scene_cuts(scenes: List[Dict[str, Any]], m: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """resolveSceneCuts: each `{ durationMs, transition?, cutAt?, align? }` (transition = outgoing) with its pinned cut
    resolved. Returns { durations, changed, issues }."""
    durations = [s["durationMs"] for s in scenes]
    changed: List[int] = []
    issues: List[str] = []
    end: float = 0
    for i, scene in enumerate(scenes):
        cut = scene.get("cutAt")
        pinned = isinstance(cut, str)
        start = 0 if i == 0 else end - resolve_overlap_ms(scenes[i - 1].get("transition"), durations[i - 1], math.inf if pinned else durations[i])
        if pinned:
            r = musicmod.resolve(cut, m or NO_MUSIC)
            if not r["ok"]:
                issues.append(f'scene {i + 1} cutAt "{cut}": {r["message"]}')
            else:
                spec = scene.get("transition")
                out = spec.get("durationMs") if isinstance(spec, dict) else None
                half = max(0, out) / 2 if cut_align(scene.get("align")) == "mid" and i + 1 < len(scenes) and is_number(out) and math.isfinite(out) else 0
                want = musicmod.js_round(r["projectMs"] + half - start)
                if want <= 0:
                    issues.append(f'scene {i + 1} cutAt "{cut}" lands at {musicmod.js_round(r["projectMs"])} ms, before the scene starts ({js_json(start)} ms)')
                elif want != durations[i]:
                    durations[i] = want
                    changed.append(i)
        end = start + durations[i]
    return {"durations": durations, "changed": changed, "issues": issues}


ON_BEAT_MS = 1


def beat_at(m: Optional[Dict[str, Any]], project_ms: float) -> Optional[str]:
    """beatAt: the grid beat a project time sits on (bar:9, bar:9.3), or None without a grid or off the beat."""
    grid = m.get("grid") if m else None
    if not grid:
        return None
    beat_ms = 60000 / grid["bpm"]
    index = musicmod.js_round((project_ms + m["startOffsetMs"] - grid["offsetMs"]) / beat_ms)  # type: ignore[index]
    if abs(grid["offsetMs"] + index * beat_ms - m["startOffsetMs"] - project_ms) > ON_BEAT_MS:  # type: ignore[index]
        return None
    bar = math.floor(index / grid["beatsPerBar"]) + 1
    beat = index - (bar - 1) * grid["beatsPerBar"] + 1
    return f"bar:{bar}" if beat == 1 else f"bar:{bar}.{beat}"


def cut_timeline(entries: List[Dict[str, Any]], durations: List[float], m: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """cutTimeline: the slots v2 entries land on with their pinned cuts resolved."""
    cuts = resolve_scene_cuts([
        {"durationMs": durations[i], "transition": e.get("transition"), "cutAt": e.get("cutAt"), "align": e.get("align")} for i, e in enumerate(entries)
    ], m)
    return build_scene_timeline([
        {"id": str(i), "durationMs": cuts["durations"][i], "transition": e.get("transition")} for i, e in enumerate(entries)
    ])


def boundary_cut_ms(slots: List[Dict[str, Any]], index: int) -> float:
    """boundaryCutMs: the middle of boundary index's overlap (its end on a hard cut)."""
    nxt = slots[index + 1].get("transitionIn") if index + 1 < len(slots) else None
    return slots[index]["endMs"] - (nxt["durationMs"] if isinstance(nxt, dict) else 0) / 2


def keep_cuts_for_transition(entries: List[Dict[str, Any]], durations: List[float], index: int, spec: Optional[Dict[str, Any]],
                             m: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """keepCutsForTransition: sets scene index's outgoing transition (None = hard cut) without moving any later
    boundary. Returns { entries (copies), cutMs, position }."""
    before = cut_timeline(entries, durations, m)
    cut_ms = boundary_cut_ms(before, index)
    next_end = before[index + 1]["endMs"]
    lengths = list(durations)
    out = [dict(e) for e in entries]
    entry = out[index]
    if spec:
        entry["transition"] = spec
    else:
        entry.pop("transition", None)
    pinned = isinstance(entry.get("cutAt"), str)
    position = entry["cutAt"] if pinned else beat_at(m, cut_ms)
    if not pinned:
        if position:
            entry["cutAt"] = position
            entry["align"] = "mid"
        else:
            was_in = before[index + 1].get("transitionIn")
            was = was_in["durationMs"] if isinstance(was_in, dict) else 0
            now = resolve_overlap_ms(spec, lengths[index], lengths[index + 1])
            lengths[index] = musicmod.js_round(lengths[index] + (now - was) / 2)
            entry["durationMs"] = lengths[index]
    follower = out[index + 1]
    if not isinstance(follower.get("cutAt"), str):
        placed = cut_timeline(out, lengths, m)
        length = musicmod.js_round(next_end - placed[index + 1]["startMs"])
        if length > 0:
            lengths[index + 1] = length
            follower["durationMs"] = length
    cuts = resolve_scene_cuts([
        {"durationMs": lengths[i], "transition": e.get("transition"), "cutAt": e.get("cutAt"), "align": e.get("align")} for i, e in enumerate(out)
    ], m)
    for i in cuts["changed"]:
        out[i]["durationMs"] = cuts["durations"][i]
    return {"entries": out, "cutMs": cut_ms, "position": position}


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


def manifest_slots(project: Project, manifest: Dict[str, Any], m: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """A manifest's timeline with pinned cuts resolved against m: SceneSlot dicts plus each scene's `file` and `stem`."""
    entries = [e if isinstance(e, dict) else {} for e in manifest.get("scenes") or []]
    outgoing = outgoing_transitions(dict(manifest, scenes=entries))
    stems = [stem_of(e.get("file") if isinstance(e.get("file"), str) else "") for e in entries]
    cuts = resolve_scene_cuts([
        {"durationMs": scene_duration(project, e), "transition": outgoing[i], "cutAt": e.get("cutAt"), "align": e.get("align")}
        for i, e in enumerate(entries)
    ], m)
    slots = build_scene_timeline([
        {"id": stems[i], "durationMs": cuts["durations"][i], "transition": outgoing[i]} for i in range(len(entries))
    ])
    for slot, entry, stem in zip(slots, entries, stems):
        slot["stem"] = stem
        slot["file"] = entry.get("file")
    return slots


def project_slots(project: Project) -> List[Dict[str, Any]]:
    """The project's timeline: slots keyed by stem, plus each scene's `file` and `stem`."""
    from ..beats.model import project_music

    manifest = dict(project.manifest(), scenes=project.scene_entries())
    return manifest_slots(project, manifest, project_music(manifest))


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
