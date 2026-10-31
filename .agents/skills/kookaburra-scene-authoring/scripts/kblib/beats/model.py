"""The authored music in project.json (`audio.grid`, `audio.cues`, `audio.sections`) and the sidecar `at` fields it moves.

Mirrors the app: `sanitiseAudioMusic` and `projectMusicOf` (src/engine/project.ts), `resolveSceneDocMusic` and the
detach rule (src/engine/sceneDocMusic.ts), the grid edits (src/engine/musicGridEdit.ts), `effectiveBeatGrid` and
`nearestGridBeat` (src/engine/beatState.ts) and `activeSceneIndex` (src/engine/sceneTimeline.ts). Positions resolve
through kblib.music, the vector-pinned copy of musicTime.ts.
"""

from __future__ import annotations

import copy
import math
import re
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Set, Tuple

from .. import music
from ..film import timeline as tl
from ..project import Project, stem_of
from ..util import EXIT_ENV, EXIT_PROBLEMS, KbError, is_int, is_number, js_json

BPM_MIN = 30
BPM_MAX = 300
BEATS_PER_BAR_MAX = 16
MAX_GRID_BEATS = 100000
NO_MUSIC: Dict[str, Any] = {"startOffsetMs": 0, "cues": {}, "sections": {}}
# One frame at 30 fps: the app's CONSTANT_TEMPO_MAX_DRIFT_MS. A wider drift can't take one grid; under STEADY nothing needs saying.
MAX_GRID_DRIFT_MS = 33
STEADY_DRIFT_MS = 15
# Past two frames at 30 fps a fit that holds on its onsets can't be trusted on every bar.
BEAT_STRAY_NOTE_MS = 66
# A hit further than this from its 16th carries a +Nms nudge, so the position lands on the hit.
NUDGE_MIN_MS = 5
KEY_TRACKS = (("camera",), ("cameraRig",), ("lighting",), ("deviceTrack",))
COMPARE_KEY_TRACKS = (("compare", "b", "lighting"), ("compare", "track"))
POSITION_PLACES = (
    "the at beside tMs on camera, cameraRig, lighting, deviceTrack, compare.track and compare.b.lighting keys, "
    "the at beside startMs on device screen videos (devices[].media, coverMedia, compare.b) and media videos "
    "(media[].video), and cameraKicks and room keys"
)
POSITION_HELP = "bar:B[.beat[.16th]], cue:ID or section:ID (optionally +40ms or -40ms), or a time like 12.5s or 12500ms"
_TIME = re.compile(r"(-?\d+(?:\.\d+)?)(ms|s)?\Z", re.ASCII)
_RANGE = re.compile(r"(bars|beats):(-?\d+)(?:-(-?\d+))?\Z", re.ASCII)


def round3(value: float) -> float:
    """The app's round3: Math.round(v * 1000) / 1000."""
    return music.js_round(value * 1000) / 1000


def _finite(value: Any) -> bool:
    return is_number(value) and math.isfinite(value)


# ── project.json: sanitiseAudioMusic and projectMusicOf ──────────────────────


def value_problem(value: Any, grid: Optional[Dict[str, Any]]) -> Optional[str]:
    """Why a cue value or section bound can't stand (musicValueProblem), or None; a bar position without a grid stands."""
    if is_number(value):
        return None if math.isfinite(value) else "isn't finite"
    if not isinstance(value, str):
        return "isn't a position or ms"
    if not music.is_position(value):
        return f'"{value}" isn\'t a position'
    if value.startswith(("cue:", "section:")):
        return f'"{value}" can\'t point at another cue or section'
    r = music.resolve(value, {"grid": grid, "startOffsetMs": 0, "cues": {}, "sections": {}})
    return None if r["ok"] or r["code"] == "no-grid" else r["message"]


def _bound_ms(value: Any, grid: Optional[Dict[str, Any]]) -> Optional[float]:
    if is_number(value):
        return value
    r = music.resolve(str(value), {"grid": grid, "startOffsetMs": 0, "cues": {}, "sections": {}})
    return r["projectMs"] if r["ok"] else None


def sanitise_music(audio: Any) -> Tuple[Dict[str, Any], List[Tuple[str, str]]]:
    """The music fields the app keeps ({grid?, cues?, sections?}) and (path under audio, why) for each one it drops."""
    out: Dict[str, Any] = {}
    problems: List[Tuple[str, str]] = []
    if not isinstance(audio, dict):
        return out, problems
    grid: Optional[Dict[str, Any]] = None
    if "grid" in audio:
        g = audio["grid"] if isinstance(audio["grid"], dict) else {}
        bpm, offset = g.get("bpm"), g.get("offsetMs")
        per_bar = g.get("beatsPerBar")
        per_bar = 4 if per_bar is None else per_bar
        if not (_finite(bpm) and BPM_MIN <= bpm <= BPM_MAX):
            problems.append(("grid.bpm", f"must be {BPM_MIN}..{BPM_MAX}"))
        elif not _finite(offset):
            problems.append(("grid.offsetMs", "must be finite ms"))
        elif not (_finite(per_bar) and float(per_bar).is_integer() and 1 <= per_bar <= BEATS_PER_BAR_MAX):
            problems.append(("grid.beatsPerBar", f"must be an integer 1..{BEATS_PER_BAR_MAX}"))
        else:
            grid = {"bpm": bpm, "offsetMs": offset, "beatsPerBar": int(per_bar)}
            out["grid"] = dict(grid, source=g["source"]) if isinstance(g.get("source"), dict) else grid
    if "cues" in audio:
        if not isinstance(audio["cues"], dict):
            problems.append(("cues", "must be an object"))
        else:
            cues: Dict[str, Any] = {}
            for ident, value in audio["cues"].items():
                problem = value_problem(value, grid) if music.MUSIC_ID_PATTERN.match(ident) else "id must be lowercase letters, digits and dashes"
                if problem:
                    problems.append((f"cues.{ident}", problem))
                else:
                    cues[ident] = value
            if cues:
                out["cues"] = cues
    if "sections" in audio:
        if not isinstance(audio["sections"], list):
            problems.append(("sections", "must be an array"))
        else:
            sections: List[Dict[str, Any]] = []
            seen: set = set()
            for i, raw in enumerate(audio["sections"]):
                s = raw if isinstance(raw, dict) else {}
                ident = s["id"] if isinstance(s.get("id"), str) else ""
                if not music.MUSIC_ID_PATTERN.match(ident):
                    problem: Optional[str] = "needs an id of lowercase letters, digits and dashes"
                elif ident in seen:
                    problem = "repeats an id"
                else:
                    problem = value_problem(s.get("from"), grid) or value_problem(s.get("to"), grid)
                lo = None if problem else _bound_ms(s.get("from"), grid)
                hi = None if problem else _bound_ms(s.get("to"), grid)
                if problem:
                    problems.append((f"sections[{i}]", problem))
                elif lo is not None and hi is not None and lo >= hi:
                    problems.append((f"sections[{i}]", 'needs "from" before "to"'))
                else:
                    seen.add(ident)
                    section = {"id": ident, "from": s["from"], "to": s["to"]}
                    if isinstance(s.get("label"), str):
                        section["label"] = s["label"]
                    sections.append(section)
            if sections:
                out["sections"] = sections
    return out, problems


def project_music(manifest: Any) -> Optional[Dict[str, Any]]:
    """What positions resolve against (projectMusicOf over the sanitised block); None when it authors no grid, cues or sections."""
    audio = manifest.get("audio") if isinstance(manifest, dict) else None
    if not isinstance(audio, dict):
        return None
    spec, _ = sanitise_music(audio)
    if not spec:
        return None
    sections: Dict[str, Dict[str, Any]] = {}
    for s in spec.get("sections") or []:
        sections[s["id"]] = {k: s[k] for k in ("from", "to", "label") if k in s}
    offset = audio.get("startOffsetMs")
    out: Dict[str, Any] = {"startOffsetMs": offset if _finite(offset) else 0, "cues": dict(spec.get("cues") or {}), "sections": sections}
    if "grid" in spec:
        g = spec["grid"]
        out["grid"] = {"bpm": g["bpm"], "offsetMs": g["offsetMs"], "beatsPerBar": g["beatsPerBar"]}
    return out


def grid_of(m: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    return m.get("grid") if m else None


def bar_ms(grid: Dict[str, Any]) -> float:
    return grid["beatsPerBar"] * 60000 / grid["bpm"]


def resolve(text: str, m: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    return music.resolve(text, m or NO_MUSIC)


def resolve_local(text: str, m: Optional[Dict[str, Any]], start_ms: float) -> Dict[str, Any]:
    return music.resolve_scene_local(text, m or NO_MUSIC, start_ms)


# ── the timeline ──────────────────────────────────────────────────────────────


def slots_of(project: Project, manifest: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """The timeline (SceneSlot dicts plus `stem` and `file`) for this manifest, the project's own by default."""
    manifest = manifest if manifest is not None else project.manifest()
    return tl.manifest_slots(project, manifest, project_music(manifest))


def attribution_starts(slots: List[Dict[str, Any]]) -> List[float]:
    """attributionBoundaries: each scene's window opens halfway through its incoming overlap, strictly increasing."""
    starts: List[float] = []
    for i, slot in enumerate(slots):
        if i == 0:
            starts.append(0)
            continue
        t_in = slot.get("transitionIn")
        begin = slot["startMs"] + (t_in["durationMs"] if isinstance(t_in, dict) else 0) / 2
        starts.append(max(begin, starts[i - 1] + 1))
    return starts


def owner_index(slots: List[Dict[str, Any]], ms: float) -> int:
    """The scene a project time belongs to, as the editor attributes it (activeSceneIndex, the end of the film in the last scene)."""
    total = tl.timeline_total_ms(slots)
    if slots and ms >= total:
        return len(slots) - 1
    starts = attribution_starts(slots)
    found = 0
    for i in range(len(slots)):
        end = starts[i + 1] if i + 1 < len(slots) else total
        if starts[i] <= ms < end:
            found = i
    return found


def in_slot(slots: List[Dict[str, Any]], index: int, local_ms: float) -> bool:
    """Whether scene-local ms falls inside the scene (its end belongs to the next scene, except the film's end)."""
    duration = slots[index]["durationMs"]
    return 0 <= local_ms < duration or (index == len(slots) - 1 and local_ms == duration)


# ── grid beats (effectiveBeatGrid, nearestGridBeat) ──────────────────────────


def grid_beats(m: Dict[str, Any], end_ms: float) -> Tuple[List[float], List[Tuple[int, float]]]:
    """The authored grid's beats in project ms within 0..end_ms (the resolver's operation order) and its bar lines as (bar, ms)."""
    grid = m["grid"]
    beat_ms = 60000 / grid["bpm"]
    per_bar = grid["beatsPerBar"]
    beats: List[float] = []
    bars: List[Tuple[int, float]] = []
    k = math.ceil((m["startOffsetMs"] - grid["offsetMs"]) / beat_ms)
    while len(beats) < MAX_GRID_BEATS:
        t = grid["offsetMs"] + k * beat_ms - m["startOffsetMs"]
        if t > end_ms:
            break
        if t >= 0:
            beats.append(t)
            if k % per_bar == 0:
                bars.append((k // per_bar + 1, t))
        k += 1
    return beats, bars


def stray_note(fit: Any) -> Optional[str]:
    """Where the beat model's own beats leave a grid its onsets still fit: a slip in the song a line absorbs."""
    if not isinstance(fit, dict):
        return None
    ms, at = fit.get("beatStrayMs"), fit.get("beatStrayAtMs")
    if not _finite(ms) or not _finite(at) or ms <= BEAT_STRAY_NOTE_MS:
        return None
    return f"the song's beats stray up to {ms:g} ms from this grid near {at / 1000:.1f} s: check those bars by ear (./kb song hits stays exact)"


def drift_holds(fit: Any) -> bool:
    """Whether one grid holds for a fit: its max drift within a frame at 30 fps. The number decides, so a v2 copy that
    called a 19 ms fit drifting holds too; without one, the fit's own verdict stands."""
    if not isinstance(fit, dict):
        return False
    drift = fit.get("maxDriftMs")
    if _finite(drift):
        return drift <= MAX_GRID_DRIFT_MS
    return fit.get("constantTempo") is not False


def nearest_sixteenth(grid: Dict[str, Any], track_ms: float, compact: bool = False, nudge_min_ms: float = NUDGE_MIN_MS) -> Dict[str, Any]:
    """The 16th of the grid nearest a track time: { position, bar, beat, sixteenth, offMs }. position is bar:B.beat.16th
    (compact drops a trailing .1) with a +Nms nudge when the time sits further than nudge_min_ms off the 16th."""
    step = 60000 / grid["bpm"] / 4
    per_bar = grid["beatsPerBar"] * 4
    n = music.js_round((track_ms - grid["offsetMs"]) / step)
    bar = math.floor(n / per_bar) + 1
    rest = n - (bar - 1) * per_bar
    beat, sixteenth = rest // 4 + 1, rest % 4 + 1
    off = track_ms - (grid["offsetMs"] + n * step)
    if compact and sixteenth == 1:
        text = f"bar:{bar}" if beat == 1 else f"bar:{bar}.{beat}"
    else:
        text = f"bar:{bar}.{beat}.{sixteenth}"
    nudge = music.js_round(off)
    if abs(off) > nudge_min_ms and nudge:
        text += f"{nudge:+d}ms"
    return {"position": text, "bar": bar, "beat": beat, "sixteenth": sixteenth, "offMs": round(off, 1)}


def nearest_beat(m: Optional[Dict[str, Any]], project_ms: float) -> Optional[Dict[str, Any]]:
    """nearestGridBeat: the grid beat nearest a project time as { index, position, projectMs }; None without a grid."""
    grid = grid_of(m)
    if not grid:
        return None
    beat_ms = 60000 / grid["bpm"]
    index = music.js_round((project_ms + m["startOffsetMs"] - grid["offsetMs"]) / beat_ms)  # type: ignore[index]
    bar = math.floor(index / grid["beatsPerBar"]) + 1
    beat = index - (bar - 1) * grid["beatsPerBar"] + 1
    return {
        "index": index,
        "position": f"bar:{bar}" if beat == 1 else f"bar:{bar}.{beat}",
        "projectMs": grid["offsetMs"] + index * beat_ms - m["startOffsetMs"],  # type: ignore[index]
    }


# ── positions and times as kb arguments ──────────────────────────────────────


def position_error(text: str, r: Dict[str, Any], flag: str = "") -> KbError:
    """A failed resolution as the KbError a command raises: no grid exit 1 (no-grid), unknown ids exit 1, bad syntax exit 2."""
    where = f"{flag} " if flag else ""
    if r["code"] == "no-grid":
        return KbError(f'{where}"{text}" needs a beat grid, and this project has none', EXIT_PROBLEMS, kind="no-grid")
    if r["code"] in ("unknown", "nested"):
        return KbError(f'{where}"{text}": {r["message"]}', EXIT_PROBLEMS, kind="invalid", hint="list the cues and sections with ./kb beats")
    return KbError(f'{where}"{text}": {r["message"]}', EXIT_ENV, kind="usage", hint=f"positions are {POSITION_HELP}")


def is_time(text: str) -> bool:
    return isinstance(text, str) and (music.is_position(text) or _TIME.match(text) is not None)


def parse_time(text: str, m: Optional[Dict[str, Any]], flag: str = "") -> Dict[str, Any]:
    """A film time argument: a position, `12.5s`, `12500ms` or bare seconds, as { text, kind, projectMs } (projectMs unrounded)."""
    if music.is_position(text):
        r = resolve(text, m)
        if not r["ok"]:
            raise position_error(text, r, flag)
        return {"text": text, "kind": "position", "projectMs": r["projectMs"]}
    hit = _TIME.match(text or "")
    if hit is None:
        where = f"{flag} " if flag else ""
        raise KbError(f'{where}"{text}" isn\'t a time', EXIT_ENV, kind="usage", hint=f"use {POSITION_HELP}")
    value = float(hit.group(1))
    ms = value if hit.group(2) == "ms" else value * 1000
    return {"text": text, "kind": "ms" if hit.group(2) == "ms" else "seconds", "projectMs": ms}


def is_range(text: str) -> bool:
    return isinstance(text, str) and _RANGE.match(text) is not None


def expand_range(text: str, m: Optional[Dict[str, Any]], limit: Optional[int] = None) -> Optional[List[str]]:
    """`bars:A-B` (each downbeat) or `beats:A-B` (every beat of bars A to B) as positions, at most `limit` of them
    (the first `limit` when there are more); None when text is neither."""
    hit = _RANGE.match(text)
    if hit is None:
        return None
    grid = grid_of(m)
    if not grid:
        raise KbError(f'"{text}" needs a beat grid, and this project has none', EXIT_PROBLEMS, kind="no-grid")
    first = int(hit.group(2))
    last = int(hit.group(3)) if hit.group(3) is not None else first
    if last < first:
        raise KbError(f'"{text}": the last bar comes before the first', EXIT_ENV, kind="usage", hint="write bars:13-16 (first to last)")
    per = 1 if hit.group(1) == "bars" else grid["beatsPerBar"]
    if limit is not None:
        last = min(last, first + (limit + per - 1) // per - 1)
    out = [f"bar:{b}" if beat == 1 else f"bar:{b}.{beat}" for b in range(first, last + 1) for beat in range(1, per + 1)]
    return out[:limit] if limit is not None else out


# ── sidecar `at` fields: resolve and detach ───────────────────────────────────


class Slot(NamedTuple):
    """One sidecar time that may follow the music: the dict holding `at` and its time field (tMs or startMs)."""

    steps: Tuple[Any, ...]
    ident: Tuple[str, ...]
    where: str
    track: str
    id: Any
    field: str
    node: Dict[str, Any]
    rule: Optional[Callable[[int], Optional[str]]]


def _dig(doc: Any, path: Tuple[Any, ...]) -> Any:
    node = doc
    for part in path:
        node = node.get(part) if isinstance(node, dict) else None
    return node


def _node_at(doc: Any, steps: Tuple[Any, ...]) -> Dict[str, Any]:
    node = doc
    for part in steps:
        node = node[part]
    return node


def _key_id(key: Dict[str, Any], i: int) -> str:
    return key["id"] if isinstance(key.get("id"), str) else f"#{i}"


def _screen_rule(spec: Dict[str, Any]) -> Callable[[int], Optional[str]]:
    """deviceMediaRule: a screen's startMs is scene time only on a video not counted from a fold opening, and a parse
    drops inMs beside a negative one."""

    def rule(ms: int) -> Optional[str]:
        from ..video import repoint

        if spec.get("kind") != "video":
            return "only a video's start can follow the music"
        if spec.get("startOn") == "open":
            return "startOn open counts startMs from the fold opening"
        if ms < 0 and "inMs" in repoint.playback_timing(spec):
            return f"lands {-ms} ms before the scene starts, which can't combine with inMs"
        return None

    return rule


def timed_slots(doc: Any) -> List[Slot]:
    """Every field that may carry an `at`, in the app's order: camera, rig, lighting and device-track keys, device
    screens, media videos, then the comparison's side B lighting keys, side B screens and divider keys."""
    out: List[Slot] = []
    if not isinstance(doc, dict):
        return out

    def keys(path: Tuple[str, ...]) -> None:
        items = _dig(doc, path + ("keys",))
        track = ".".join(path)
        for i, key in enumerate(items if isinstance(items, list) else []):
            if isinstance(key, dict):
                out.append(Slot(path + ("keys", i), (track, _key_id(key, i)), f'{track} key "{key.get("id", i)}"', track, key.get("id"), "tMs", key, None))

    def screen(steps: Tuple[Any, ...], ident: Tuple[str, ...], where: str, track: str, sid: Any, spec: Any) -> None:
        if isinstance(spec, dict):
            out.append(Slot(steps, ident, where, track, sid, "startMs", spec, _screen_rule(spec)))

    for path in KEY_TRACKS:
        keys(path)
    devices = doc.get("devices")
    for i, d in enumerate(devices if isinstance(devices, list) else []):
        if isinstance(d, dict) and isinstance(d.get("id"), str) and isinstance(d.get("model"), str):
            for field in ("media", "coverMedia"):
                screen(("devices", i, field), ("devices", d["id"], field), f'device "{d["id"]}" {field}', f"devices.{field}", d["id"], d.get(field))
    media = doc.get("media")
    for i, e in enumerate(media if isinstance(media, list) else []):
        if isinstance(e, dict) and isinstance(e.get("id"), str) and e["id"] and e.get("kind") == "video" and isinstance(e.get("video"), dict):
            out.append(Slot(("media", i, "video"), ("media", e["id"]), f'media "{e["id"]}" video', "media.video", e["id"], "startMs", e["video"], None))
    keys(COMPARE_KEY_TRACKS[0])
    side = _dig(doc, ("compare", "b"))
    for field in ("media", "coverMedia"):
        overrides = side.get(field) if isinstance(side, dict) else None
        for ident, spec in (overrides.items() if isinstance(overrides, dict) else []):
            if isinstance(spec, dict) and isinstance(spec.get("src"), str) and spec["src"] and spec.get("kind") in ("video", "image"):
                screen(("compare", "b", field, ident), ("compare.b", field, ident), f'compare.b.{field} "{ident}"', f"compare.b.{field}", ident, spec)
    keys(COMPARE_KEY_TRACKS[1])
    return out


def has_at(doc: Any) -> bool:
    """Whether any field that may follow the music carries an `at` (else a write is the legacy one, untouched)."""
    return any("at" in s.node for s in timed_slots(doc))


def stored_ms(node: Dict[str, Any], field: str) -> Any:
    """The stored time; a media start defaults to 0, as playback reads it."""
    return node.get("startMs", 0) if field == "startMs" else node.get("tMs")


def slot_position(slot: Slot, m: Optional[Dict[str, Any]], start_ms: float) -> Dict[str, Any]:
    """The slot's `at` in scene-local integer ms, or a failure (code "rule" when it resolves but can't apply there)."""
    r = resolve_local(slot.node["at"], m, start_ms)
    problem = slot.rule(r["projectMs"]) if r["ok"] and slot.rule else None
    return {"ok": False, "code": "rule", "message": problem} if problem else r


def check_path(steps: Tuple[Any, ...]) -> str:
    """kb check's path for a slot: camera.keys[1], devices[0].media, compare.b.media["d1"]."""
    out = ""
    for i, part in enumerate(steps):
        if isinstance(part, int):
            out += f"[{part}]"
        elif i == 3 and steps[:3] in (("compare", "b", "media"), ("compare", "b", "coverMedia")):
            out += f'["{part}"]'
        else:
            out += f".{part}" if out else part
    return out


def doc_path(steps: Tuple[Any, ...]) -> str:
    """kb doc's dotted path for a slot: camera.keys.1, devices.0.media, compare.b.media.d1."""
    return ".".join(str(p) for p in steps)


def refresh_doc(doc: Any, m: Optional[Dict[str, Any]], start_ms: float) -> Tuple[Any, List[Dict[str, Any]], List[str]]:
    """resolveSceneDocMusic: every field with an `at` gets its time = the position in scene-local integer ms; an `at`
    that can't resolve or apply keeps its stored time. Returns (doc, or the same object when nothing moved;
    [{track, id, where, field, at, fromMs, toMs}]; issues)."""
    out = None
    changes: List[Dict[str, Any]] = []
    issues: List[str] = []
    for s in timed_slots(doc):
        at = s.node.get("at")
        if not isinstance(at, str):
            continue
        r = slot_position(s, m, start_ms)
        if not r["ok"]:
            issues.append(f'{s.where} "{at}": {r["message"]}')
            continue
        old = stored_ms(s.node, s.field)
        if is_number(old) and old == r["projectMs"]:
            continue
        if out is None:
            out = copy.deepcopy(doc)
        _node_at(out, s.steps)[s.field] = r["projectMs"]
        changes.append({"track": s.track, "id": s.id, "where": s.where, "field": s.field, "at": at, "fromMs": old, "toMs": r["projectMs"]})
    return (out if out is not None else doc), changes, issues


def _patch_node(patch: Any, steps: Tuple[Any, ...]) -> Any:
    node = patch
    for part in steps:
        if isinstance(part, int):
            node = node[part] if isinstance(node, list) and -len(node) <= part < len(node) else None
        else:
            node = node.get(part) if isinstance(node, dict) else None
        if node is None:
            return None
    return node


def _merged_at(before: Any, after: Any, patch: Dict[str, Any]) -> Tuple[Any, Set[str]]:
    """A merge patch replaces arrays whole, so a field it rewrites without naming `at` keeps the `at` it had, and an
    `"at": null` inside a replaced array removes it. Returns (doc, where each field whose time the patch wrote)."""
    prior: Dict[Tuple[str, ...], Dict[str, Any]] = {}
    for s in timed_slots(before):
        prior.setdefault(s.ident, s.node)
    doc = after
    timed: Set[str] = set()
    for s in timed_slots(after):
        node = _patch_node(patch, s.steps)
        if not isinstance(node, dict):
            continue
        if s.field in node:
            timed.add(s.where)
        if "at" in node:
            if node["at"] is None and "at" in s.node:
                doc = doc if doc is not after else copy.deepcopy(after)
                del _node_at(doc, s.steps)["at"]
            continue
        old = prior.get(s.ident)
        if isinstance(old, dict) and isinstance(old.get("at"), str) and "at" not in s.node:
            doc = doc if doc is not after else copy.deepcopy(after)
            _node_at(doc, s.steps)["at"] = old["at"]
    return doc, timed


def settle_written(before: Any, after: Any, m: Optional[Dict[str, Any]], start_ms: float, patch: Optional[Dict[str, Any]] = None) -> Tuple[Any, List[str]]:
    """The detach rule for a kb sidecar write: a field whose time this write moved (its `at` unchanged) loses its `at`,
    unless it moved exactly onto that position; then every remaining `at` refreshes its time. A merge `patch` never
    detaches: each `at` stays unless the patch nulls it, so its time follows the music. Returns (doc, notes)."""
    if not isinstance(after, dict):
        return after, []
    doc = after
    notes: List[str] = []
    timed: Set[str] = set()
    if patch is not None:
        doc, timed = _merged_at(before, after, patch)
    else:
        prior: Dict[Tuple[str, ...], Dict[str, Any]] = {}
        for s in timed_slots(before):
            prior.setdefault(s.ident, s.node)
        for s in timed_slots(after):
            at = s.node.get("at")
            old = prior.get(s.ident)
            if not isinstance(at, str) or old is None or old.get("at") != at:
                continue
            was, now = stored_ms(old, s.field), stored_ms(s.node, s.field)
            if not (is_number(was) and is_number(now)) or was == now:
                continue
            r = slot_position(s, m, start_ms)
            if r["ok"] and r["projectMs"] == now:
                continue
            if doc is after:
                doc = copy.deepcopy(after)
            del _node_at(doc, s.steps)["at"]
            notes.append(f'{s.where} moved to {js_json(now)} ms, so it no longer follows "{at}" (at dropped)')
    doc, changes, _issues = refresh_doc(doc, m, start_ms)
    for c in changes:
        notes.append(f'{c["where"]} {c["field"]} {js_json(c["fromMs"])} -> {c["toMs"]} from "{c["at"]}"')
    if any(c["where"] in timed for c in changes):
        notes.append("kb doc merge keeps each at, so its time follows the music; to move one off it, give \"at\": null in the patch or kb doc set its time")
    return doc, notes


def stray_positions(before: Any, after: Any) -> List[Tuple[str, Any]]:
    """(dotted path, value) for each string `at` this write adds or changes where the app takes no musical position."""
    allowed = {s.steps for s in timed_slots(after)}
    out: List[Tuple[str, Any]] = []

    def takes_position(steps: Tuple[Any, ...]) -> bool:
        if steps in allowed:
            return True
        return (len(steps) == 2 and steps[0] == "cameraKicks" and isinstance(steps[1], int)) or (
            len(steps) == 3 and steps[:2] == ("room", "keys") and isinstance(steps[2], int))

    def walk(node: Any, steps: Tuple[Any, ...]) -> None:
        if isinstance(node, dict):
            at = node.get("at")
            if isinstance(at, str) and not takes_position(steps):
                old = _patch_node(before, steps + ("at",))
                if old != at:
                    out.append((doc_path(steps + ("at",)), at))
            for key, child in node.items():
                if steps or key not in ("text", "textStyle"):
                    walk(child, steps + (key,))
        elif isinstance(node, list):
            for i, child in enumerate(node):
                walk(child, steps + (i,))

    walk(after, ())
    return out


def stray_error(stray: List[Tuple[str, Any]]) -> KbError:
    """The refusal for musical positions where only ms work: exit 2 usage, naming the places that take one."""
    path, value = stray[0]
    more = f" (and {len(stray) - 1} more)" if len(stray) > 1 else ""
    if path.startswith("taps."):
        hint = "taps take scene-local ms (./kb beats --scene S lists each bar's ms); to land a recording's tap on a beat, ./kb video align NAME --tap ID --beat N --scene S"
    else:
        hint = f"positions work on {POSITION_PLACES}; give this field ms (./kb beats --scene S lists each bar's ms)"
    return KbError(f'{path} = "{value}"{more}: this field takes plain ms, not a musical position', EXIT_ENV, kind="usage", hint=hint)


def scene_scope(project: Project, stem: str, manifest: Optional[Dict[str, Any]] = None) -> Tuple[Optional[Dict[str, Any]], float]:
    """(music, slot start) for one scene of the project; a scene that is not in project.json starts at 0."""
    manifest = manifest if manifest is not None else project.manifest()
    m = project_music(manifest)
    for slot in slots_of(project, manifest):
        if slot["stem"] == stem:
            return m, slot["startMs"]
    return m, 0


def refresh_sidecars(tx: Any, project: Project, manifest: Dict[str, Any], notes: List[str]) -> List[Dict[str, Any]]:
    """Plans, in tx, a rewrite of every sidecar whose `at` caches move under this manifest's music and slots. A sidecar
    leased to someone else is left (the app re-resolves it on load) with a note; an unreadable one is left alone.
    Returns [{scene, file, keys}]."""
    from .. import lock as lockmod

    m = project_music(manifest)
    moved: List[Dict[str, Any]] = []
    seen: set = set()
    for slot in slots_of(project, manifest):
        rel = f"scenes/{slot['stem']}.json"
        if rel in seen or not slot["stem"]:
            continue
        seen.add(rel)
        try:
            doc, _sha = tx.read_json(rel)
        except KbError:
            continue
        if not isinstance(doc, dict):
            continue
        new, changes, _issues = refresh_doc(doc, m, slot["startMs"])
        if new is doc:
            continue
        refused = lockmod.refusals(project, tx.caller, [rel])
        if refused:
            holder = refused[0].get("holder") if isinstance(refused[0].get("holder"), dict) else {}
            notes.append(f"{rel} is leased to {holder.get('name') or 'another agent'}, so its tMs caches stay as they are until the app re-resolves them on load")
            continue
        tx.write_json(rel, new)
        moved.append({"scene": slot["stem"], "file": rel, "keys": changes})
    return moved


def moved_notes(moved: List[Dict[str, Any]]) -> List[str]:
    out = []
    for item in moved:
        keys = ", ".join(f'{_change_label(k)} {js_json(k["fromMs"])} -> {k["toMs"]} ms' for k in item["keys"])
        out.append(f"{item['file']}: {keys}")
    return out


def _change_label(change: Dict[str, Any]) -> str:
    return f'{change["track"]} "{change["id"]}"' if change["field"] == "tMs" else change["where"]


def keys_following(project: Project, prefix: str) -> List[str]:
    """`scenes/<stem>.json: <where>` for every field whose `at` starts with prefix (cue:drop, section:outro)."""
    out = []
    for slot in slots_of(project):
        doc = None
        try:
            doc = project.load_sidecar(slot["stem"])
        except KbError:
            continue
        for s in timed_slots(doc):
            at = s.node.get("at")
            if isinstance(at, str) and (at == prefix or at.startswith(prefix + "+") or at.startswith(prefix + "-")):
                out.append(f'scenes/{slot["stem"]}.json: {s.where}')
    return out


# ── grid edits (musicGridEdit.ts) ─────────────────────────────────────────────


def detected_grid(analysis: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """detectedGrid: the analysis's fitted grid as an authored one with its provenance; None when there is no usable fit."""
    fit = analysis.get("fit") if isinstance(analysis, dict) else None
    if not isinstance(fit, dict) or not _finite(fit.get("bpm")) or not BPM_MIN <= fit["bpm"] <= BPM_MAX or not _finite(fit.get("offsetMs")):
        return None
    per_bar = fit.get("beatsPerBar")
    per_bar = per_bar if is_int(per_bar) and 1 <= per_bar <= BEATS_PER_BAR_MAX else 4
    source: Dict[str, Any] = {"sha256": analysis.get("sha256"), "analysisVersion": analysis.get("version"), "tracker": analysis.get("tracker")}  # type: ignore[union-attr]
    if fit.get("residualMs") is not None:
        source["residualMs"] = fit["residualMs"]
    return {"bpm": round3(fit["bpm"]), "offsetMs": round3(fit["offsetMs"]), "beatsPerBar": per_bar, "source": source}


def starting_grid(grid: Optional[Dict[str, Any]], analysis: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """startingGrid: the authored grid, else the analysis's fit, else its raw tempo estimate from the first downbeat."""
    if grid:
        return {"bpm": grid["bpm"], "offsetMs": grid["offsetMs"], "beatsPerBar": grid.get("beatsPerBar") or 4}
    detected = detected_grid(analysis)
    if detected:
        return {"bpm": detected["bpm"], "offsetMs": detected["offsetMs"], "beatsPerBar": detected["beatsPerBar"]}
    bpm = analysis.get("bpm") if isinstance(analysis, dict) else None
    if not _finite(bpm) or not BPM_MIN <= bpm <= BPM_MAX:
        return None
    from .cache import downbeat_times

    downs = downbeat_times(analysis)  # type: ignore[arg-type]
    return {"bpm": bpm, "offsetMs": downs[0] if downs else 0, "beatsPerBar": 4}


def downbeat_grid(raw_grid: Optional[Dict[str, Any]], analysis: Optional[Dict[str, Any]], track_ms: float, bar: Optional[int]) -> Optional[Dict[str, Any]]:
    """set-downbeat: without a bar, setDownbeatGrid (the nearest bar line moves to track_ms, every bar keeps its number);
    with one, track_ms becomes that bar's beat 1. The tempo is kept; a grid starts from the analysis when there is none."""
    base = starting_grid(raw_grid, analysis)
    if not base:
        return None
    length = base["beatsPerBar"] * 60000 / base["bpm"]
    if bar is None:
        k = music.js_round((track_ms - base["offsetMs"]) / length)
        offset = round3(track_ms - k * length)
    else:
        offset = round3(track_ms - (bar - 1) * length)
    out = dict(raw_grid if raw_grid else (detected_grid(analysis) or {}))
    out.update(bpm=round3(base["bpm"]), beatsPerBar=base["beatsPerBar"], offsetMs=offset)
    return js_json(out)


# ── pinned cuts (src/engine/sceneCuts.ts) ────────────────────────────────────


def manifest_durations(project: Project, manifest: Dict[str, Any]) -> List[float]:
    """Each scene's stored length: the manifest's durationMs, else its TSX literal, else kb's default."""
    return [tl.scene_duration(project, e if isinstance(e, dict) else {}) for e in manifest.get("scenes") or []]


def settle_cuts(project: Project, manifest: Dict[str, Any]) -> List[str]:
    """Writes every pinned scene's resolved length into its durationMs cache (a v2 manifest, in place). Returns notes."""
    entries = [e if isinstance(e, dict) else {} for e in manifest.get("scenes") or []]
    outgoing = tl.outgoing_transitions(dict(manifest, scenes=entries))
    durations = manifest_durations(project, manifest)
    cuts = tl.resolve_scene_cuts([
        {"durationMs": durations[i], "transition": outgoing[i], "cutAt": e.get("cutAt"), "align": e.get("align")} for i, e in enumerate(entries)
    ], project_music(manifest))
    notes = []
    for i in cuts["changed"]:
        entry = entries[i]
        was = entry.get("durationMs")
        entry["durationMs"] = cuts["durations"][i]
        how = "its transition centred on" if tl.cut_align(entry.get("align")) == "mid" else "ends at"
        notes.append(f'scene {i} {stem_of(entry.get("file") or "")}: durationMs {js_json(was)} -> {cuts["durations"][i]} ({how} {entry["cutAt"]})')
    return notes + cuts["issues"]


def unpin(entry: Dict[str, Any]) -> bool:
    """Drops a scene's pinned cut (an explicit length replaces it); True when there was one."""
    had = "cutAt" in entry
    entry.pop("cutAt", None)
    entry.pop("align", None)
    return had


# ── scene timing (kb scene set --duration-bars / --cut-at) ───────────────────


def bars_timing(bars: float) -> Callable[[Project, Dict[str, Any], int], Tuple[int, str]]:
    """A scene-set timing: N bars at the grid's tempo, in whole ms."""

    def timing(project: Project, manifest: Dict[str, Any], index: int) -> Tuple[int, str]:
        if not (bars > 0 and math.isfinite(bars)):
            raise KbError("--duration-bars must be a positive number of bars", EXIT_ENV, kind="usage")
        grid = grid_of(project_music(manifest))
        if not grid:
            raise KbError("--duration-bars needs a beat grid, and this project has none", EXIT_PROBLEMS, kind="no-grid")
        duration = music.js_round(bars * bar_ms(grid))
        return duration, f"durationMs = {duration} ({bars:g} bars at {grid['bpm']:g} bpm)"

    return timing


def cut_timing(text: str, align: str) -> Callable[[Project, Dict[str, Any], int], Tuple[int, str]]:
    """A scene-set timing: a position pins the cut (cutAt, align), so the length follows the grid and earlier transitions
    from then on; a plain time writes the length that ends the scene there (align end) or centres its outgoing
    transition on it (align mid), once."""

    def timing(project: Project, manifest: Dict[str, Any], index: int) -> Tuple[int, str]:
        m = project_music(manifest)
        target = parse_time(text, m, "--cut-at")["projectMs"]
        entry = manifest["scenes"][index]
        stem = stem_of(entry.get("file") or "")
        if music.is_position(text):
            entry["cutAt"] = text
            if align == "mid":
                entry["align"] = "mid"
            else:
                entry.pop("align", None)
            entries = manifest["scenes"]
            outgoing = tl.outgoing_transitions(manifest)
            durations = manifest_durations(project, manifest)
            cuts = tl.resolve_scene_cuts([
                {"durationMs": durations[i], "transition": outgoing[i], "cutAt": e.get("cutAt"), "align": e.get("align")} for i, e in enumerate(entries)
            ], m)
            head = f'scene {index + 1} cutAt "{text}"'
            failed = [issue[len(head):] for issue in cuts["issues"] if issue.startswith(head)]
            if failed:
                raise KbError(f'--cut-at "{text}"{failed[0]}', EXIT_PROBLEMS, kind="invalid", hint="cut at a later position; ./kb timeline lists each scene's bars")
            duration = cuts["durations"][index]
            where = "its transition centred on" if align == "mid" else "it ends at"
            return duration, f"durationMs = {duration} (pinned: {where} {text}, {music.js_round(target)} ms in the film; it follows the grid and earlier transitions)"
        unpin(entry)
        entries = manifest["scenes"]

        def placed(duration: Optional[int]) -> List[Dict[str, Any]]:
            if duration is None:
                return slots_of(project, manifest)
            scenes = [dict(e, durationMs=duration) if i == index and isinstance(e, dict) else e for i, e in enumerate(entries)]
            return slots_of(project, dict(manifest, scenes=scenes))

        slots = placed(None)
        duration: Optional[int] = None
        overlap = 0.0
        for _ in range(6):
            start = slots[index]["startMs"]
            nxt = slots[index + 1] if index + 1 < len(slots) else None
            overlap = nxt["transitionIn"]["durationMs"] if nxt and isinstance(nxt.get("transitionIn"), dict) else 0
            want = music.js_round(target + (overlap / 2 if align == "mid" else 0) - start)
            if want <= 0:
                raise KbError(
                    f'--cut-at "{text}" lands at {music.js_round(target)} ms, before scene {stem} starts ({js_json(start)} ms)',
                    EXIT_PROBLEMS, kind="invalid", hint="cut at a later position; ./kb timeline lists each scene's start",
                )
            if want == duration:
                break
            duration = want
            slots = placed(duration)
        assert duration is not None
        where = f"its transition centred on {text}" if align == "mid" and overlap else f"it ends at {text}"
        return duration, f"durationMs = {duration} ({where}, {music.js_round(target)} ms in the film; a time, so it stays put when the grid changes)"

    return timing
