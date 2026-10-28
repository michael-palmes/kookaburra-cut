"""The authored music in project.json (`audio.grid`, `audio.cues`, `audio.sections`) and the sidecar `at` keys it moves.

Mirrors the app: `sanitiseAudioMusic` and `projectMusicOf` (src/engine/project.ts), `resolveSceneDocMusic` and the
detach rule (src/engine/sceneDocMusic.ts), the grid edits (src/engine/musicGridEdit.ts), `effectiveBeatGrid` and
`nearestGridBeat` (src/engine/beatState.ts) and `activeSceneIndex` (src/engine/sceneTimeline.ts). Positions resolve
through kblib.music, the vector-pinned copy of musicTime.ts.
"""

from __future__ import annotations

import copy
import math
import re
from typing import Any, Callable, Dict, List, Optional, Tuple

from .. import music
from ..film import timeline as tl
from ..project import Project, stem_of
from ..util import EXIT_ENV, EXIT_PROBLEMS, KbError, is_int, is_number, js_json

BPM_MIN = 30
BPM_MAX = 300
BEATS_PER_BAR_MAX = 16
MAX_GRID_BEATS = 100000
NO_MUSIC: Dict[str, Any] = {"startOffsetMs": 0, "cues": {}, "sections": {}}
TIMED_TRACKS = (("camera",), ("cameraRig",), ("lighting",), ("compare", "b", "lighting"))
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


# ── sidecar `at` keys: resolve and detach ─────────────────────────────────────


def timed_tracks(doc: Any) -> List[Tuple[Tuple[str, ...], List[Any]]]:
    """(path, keys) for the camera, rig, lighting and comparison side B lighting tracks that have a keys list."""
    out = []
    for path in TIMED_TRACKS:
        node = doc
        for part in path:
            node = node.get(part) if isinstance(node, dict) else None
        keys = node.get("keys") if isinstance(node, dict) else None
        if isinstance(keys, list):
            out.append((path, keys))
    return out


def has_at(doc: Any) -> bool:
    """Whether any camera, rig or lighting key carries an `at` (else a write is the legacy one, untouched)."""
    return any(isinstance(k, dict) and "at" in k for _path, keys in timed_tracks(doc) for k in keys)


def _keys_at(doc: Any, path: Tuple[str, ...]) -> List[Any]:
    node = doc
    for part in path:
        node = node[part]
    return node["keys"]


def _key_id(key: Dict[str, Any], i: int) -> str:
    return key["id"] if isinstance(key.get("id"), str) else f"#{i}"


def _where(path: Tuple[str, ...], key: Dict[str, Any], i: int) -> str:
    return f'{".".join(path)} key "{key.get("id", i)}"'


def refresh_doc(doc: Any, m: Optional[Dict[str, Any]], start_ms: float) -> Tuple[Any, List[Dict[str, Any]], List[str]]:
    """resolveSceneDocMusic: every key with an `at` gets tMs = the position in scene-local integer ms; an `at` that can't
    resolve keeps its stored tMs. Returns (doc, or the same object when nothing moved; [{track, id, at, fromMs, toMs}]; issues)."""
    out = None
    changes: List[Dict[str, Any]] = []
    issues: List[str] = []
    for path, keys in timed_tracks(doc):
        for i, key in enumerate(keys):
            if not isinstance(key, dict) or not isinstance(key.get("at"), str):
                continue
            r = resolve_local(key["at"], m, start_ms)
            if not r["ok"]:
                issues.append(f'{_where(path, key, i)} "{key["at"]}": {r["message"]}')
                continue
            old = key.get("tMs")
            if is_number(old) and old == r["projectMs"]:
                continue
            if out is None:
                out = copy.deepcopy(doc)
            _keys_at(out, path)[i]["tMs"] = r["projectMs"]
            changes.append({"track": ".".join(path), "id": key.get("id"), "at": key["at"], "fromMs": old, "toMs": r["projectMs"]})
    return (out if out is not None else doc), changes, issues


def settle_written(before: Any, after: Any, m: Optional[Dict[str, Any]], start_ms: float) -> Tuple[Any, List[str]]:
    """The detach rule for a kb sidecar write: a key whose tMs this write moved (its `at` unchanged) loses its `at`, unless
    it moved exactly onto that position; then every remaining `at` refreshes its tMs. Returns (doc, notes)."""
    if not isinstance(after, dict):
        return after, []
    prior: Dict[Tuple[Tuple[str, ...], str], Dict[str, Any]] = {}
    for path, keys in timed_tracks(before):
        for i, key in enumerate(keys):
            if isinstance(key, dict):
                prior.setdefault((path, _key_id(key, i)), key)
    doc = after
    notes: List[str] = []
    for path, keys in timed_tracks(after):
        for i, key in enumerate(keys):
            if not isinstance(key, dict) or not isinstance(key.get("at"), str):
                continue
            old = prior.get((path, _key_id(key, i)))
            if old is None or old.get("at") != key["at"]:
                continue
            was, now = old.get("tMs"), key.get("tMs")
            if not (is_number(was) and is_number(now)) or was == now:
                continue
            r = resolve_local(key["at"], m, start_ms)
            if r["ok"] and r["projectMs"] == now:
                continue
            if doc is after:
                doc = copy.deepcopy(after)
            del _keys_at(doc, path)[i]["at"]
            notes.append(f'{_where(path, key, i)} moved to {js_json(now)} ms, so it no longer follows "{key["at"]}" (at dropped)')
    doc, changes, _issues = refresh_doc(doc, m, start_ms)
    for c in changes:
        notes.append(f'{c["track"]} key "{c["id"]}" tMs {js_json(c["fromMs"])} -> {c["toMs"]} from "{c["at"]}"')
    return doc, notes


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
        keys = ", ".join(f'{k["track"]} "{k["id"]}" {js_json(k["fromMs"])} -> {k["toMs"]} ms' for k in item["keys"])
        out.append(f"{item['file']}: {keys}")
    return out


def keys_following(project: Project, prefix: str) -> List[str]:
    """`scenes/<stem>.json: <track> "<id>"` for every key whose `at` starts with prefix (cue:drop, section:outro)."""
    out = []
    for slot in slots_of(project):
        doc = None
        try:
            doc = project.load_sidecar(slot["stem"])
        except KbError:
            continue
        for path, keys in timed_tracks(doc):
            for i, key in enumerate(keys):
                at = key.get("at") if isinstance(key, dict) else None
                if isinstance(at, str) and (at == prefix or at.startswith(prefix + "+") or at.startswith(prefix + "-")):
                    out.append(f'scenes/{slot["stem"]}.json: {_where(path, key, i)}')
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
