"""kb scene split, renumber and import: housekeeping that used to take hand edits, each one planned on a kblib.lock
transaction like the rest of kblib.scenes."""

from __future__ import annotations

import copy
import json
import math
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import lock as lockmod
from . import music as musicmod
from . import reach
from . import scenes as scenemod
from . import tsx as tsxmod
from .project import DEFAULT_SCENE_DURATION_MS, MANIFEST, Project, numeric_prefix, scene_name, slugify, stem_of
from .scenes import ImportedFiles, Pins, Place, Result, SCENE_DOC_VERSION
from .util import EXIT_ENV, EXIT_PROBLEMS, KbError, is_int, is_number, load_json, read_text, safe_rel

# ── split ─────────────────────────────────────────────────────────────────────

KEYED_TRACKS = (
    ("camera",),
    ("cameraRig",),
    ("lighting",),
    ("deviceTrack",),
    ("compare", "track"),
    ("compare", "b", "lighting"),
    ("chart", "track"),
    ("layeredScreenshot", "animation"),
)
KEY_ONLY = ("id", "tMs", "at", "still")
MIN_PART_MS = 34
RESTARTS = "The second part's own code and any text or chart build-in restart at its first frame: check it with ./kb capture"


def _ease_in(family: str, t: float) -> float:
    if family == "Sine":
        return 1 - math.cos(t * math.pi / 2)
    if family == "Expo":
        return 0.0 if t == 0 else 2 ** (10 * t - 10)
    if family == "Circ":
        return 1 - math.sqrt(max(0.0, 1 - t * t))
    if family == "Back":
        return 2.70158 * t ** 3 - 1.70158 * t ** 2
    return t ** {"Quad": 2, "Cubic": 3, "Quart": 4, "Quint": 5}.get(family, 2)


def ease(name: Any, t: float) -> float:
    """src/engine/ease.ts over t in [0, 1], for the pose a move has reached at a cut; an unknown name is the app's default."""
    t = min(1.0, max(0.0, t))
    text = name if isinstance(name, str) else "inOutQuad"
    if text == "linear":
        return t
    if text == "jump":
        return 1.0 if t >= 1 else 0.0
    m = re.fullmatch(r"(inOut|in|out)(Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back)", text)
    if m is None:
        return ease("inOutQuad", t)
    way, family = m.group(1), m.group(2)
    if way == "in":
        return _ease_in(family, t)
    if way == "out":
        return 1 - _ease_in(family, 1 - t)
    if family == "Back":
        k = 1.70158 * 1.525
        if t < 0.5:
            return ((2 * t) ** 2 * ((k + 1) * 2 * t - k)) / 2
        return ((2 * t - 2) ** 2 * ((k + 1) * (2 * t - 2) + k) + 2) / 2
    return _ease_in(family, 2 * t) / 2 if t < 0.5 else 1 - _ease_in(family, 2 - 2 * t) / 2


def _mix(a: Any, b: Any, p: float) -> Any:
    """a toward b: numbers (lists and objects by element) move, anything else holds a."""
    if is_number(a) and is_number(b):
        return a + (b - a) * p
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        return [_mix(x, y, p) for x, y in zip(a, b)]
    if isinstance(a, dict) and isinstance(b, dict):
        return {k: _mix(v, b[k], p) if k in b else copy.deepcopy(v) for k, v in a.items()}
    return copy.deepcopy(a)


def _dig(doc: Any, path: Tuple[str, ...]) -> Any:
    node = doc
    for part in path:
        node = node.get(part) if isinstance(node, dict) else None
    return node


def _time_keys(track: Dict[str, Any]) -> List[Dict[str, Any]]:
    keys = track.get("keys")
    return sorted((k for k in keys if isinstance(k, dict) and is_number(k.get("tMs"))) if isinstance(keys, list) else [], key=lambda k: k["tMs"])


def _payload(key: Dict[str, Any]) -> Dict[str, Any]:
    return {k: copy.deepcopy(v) for k, v in key.items() if k not in KEY_ONLY}


def split_track(track: Dict[str, Any], t: int) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]], Optional[str]]:
    """(the part before the cut, the part after it with its times moved back, the move the cut landed inside). Keys on one
    side stay; a move across the cut becomes two moves that meet on the pose it has reached there; a held pose carries over.
    A part with no keys is None."""
    keys = _time_keys(track)
    by_id = {k.get("id"): k for k in keys}
    segments = [s for s in track.get("segments") or [] if isinstance(s, dict)]
    across = next((s for s in segments if s.get("from") in by_id and s.get("to") in by_id and by_id[s["from"]]["tMs"] < t < by_id[s["to"]]["tMs"]), None)
    on_cut = any(k["tMs"] == t for k in keys)

    first = copy.deepcopy({k: v for k, v in track.items() if k not in ("keys", "segments", "presentLoop")})
    second = copy.deepcopy(first)
    first["keys"] = [copy.deepcopy(k) for k in keys if k["tMs"] <= t]
    second["keys"] = [dict(copy.deepcopy(k), tMs=k["tMs"] - t) for k in keys if k["tMs"] >= t]
    first["segments"] = [copy.deepcopy(s) for s in segments if s is not across and s.get("to") in by_id and by_id[s["to"]]["tMs"] <= t]
    second["segments"] = [copy.deepcopy(s) for s in segments if s is not across and s.get("from") in by_id and by_id[s["from"]]["tMs"] >= t]
    if "presentLoop" in track:
        second["presentLoop"] = copy.deepcopy(track["presentLoop"])

    moved: Optional[str] = None
    if across is not None:
        a, b = by_id[across["from"]], by_id[across["to"]]
        p = ease(across.get("ease"), (t - a["tMs"]) / (b["tMs"] - a["tMs"]))
        pose = _mix(_payload(a), _payload(b), p)
        first["keys"].append(dict(copy.deepcopy(pose), id="split-a", tMs=t))
        first["segments"].append(dict(copy.deepcopy(across), to="split-a"))
        second["keys"].insert(0, dict(copy.deepcopy(pose), id="split-b", tMs=0))
        second["segments"].insert(0, dict(copy.deepcopy(across), **{"from": "split-b"}))
        moved = f'{a.get("id")} to {b.get("id")}'
    elif not on_cut:
        held = [k for k in keys if k["tMs"] < t]
        if held:
            second["keys"].insert(0, dict(_payload(held[-1]), id="split-b", tMs=0))
        elif keys:
            # A track holds its first key until it arrives, so the first part still needs that pose.
            first["keys"].append(dict(_payload(keys[0]), id="split-a", tMs=0))
    for part in (first, second):
        scenemod.renumber_track(part)
    return (first if first["keys"] else None, second if second["keys"] else None, moved)


def _set_track(doc: Dict[str, Any], path: Tuple[str, ...], value: Optional[Dict[str, Any]]) -> None:
    node = _dig(doc, path[:-1])
    if not isinstance(node, dict):
        return
    if value is None:
        node.pop(path[-1], None)
    else:
        node[path[-1]] = value


def _advance_screen(spec: Any, t: int, where: str, notes: List[str]) -> None:
    """A device screen or media video as the second part needs it: a delay shrinks, a clip already playing carries on from
    the frame it had reached (a head trim, or inMs where the spec has source timing)."""
    if not isinstance(spec, dict) or spec.get("kind", "video") != "video":
        return
    if spec.get("startOn") == "open":
        notes.append(f"{where} starts when the fold opens, so it counts from the second part's own opening")
        return
    start = spec["startMs"] if is_number(spec.get("startMs")) else 0
    timed = any(k in spec for k in ("inMs", "outMs", "speed", "posterMs"))
    if start >= t or not timed:
        left = start - t
        if left == 0:
            spec.pop("startMs", None)
        else:
            spec["startMs"] = left
        return
    speed = spec["speed"] if is_number(spec.get("speed")) and spec["speed"] > 0 else 1
    spec["inMs"] = musicmod.js_round((spec["inMs"] if is_number(spec.get("inMs")) else 0) + (t - start) * speed)
    spec.pop("startMs", None)
    spec.pop("at", None)
    spec.pop("posterMs", None)
    if spec.get("loop"):
        notes.append(f"{where} loops: its loop now starts at the cut")
    if is_number(spec.get("outMs")) and spec["inMs"] >= spec["outMs"] - 16:
        spec["inMs"] = max(0, spec["outMs"] - 17)


def _screens(doc: Dict[str, Any]) -> List[Tuple[str, Any]]:
    out: List[Tuple[str, Any]] = []
    for i, device in enumerate(doc.get("devices") or []):
        if isinstance(device, dict):
            out += [(f"devices[{i}].{field}", device.get(field)) for field in ("media", "coverMedia") if field in device]
    for i, entry in enumerate(doc.get("media") or []):
        if isinstance(entry, dict) and entry.get("kind") == "video":
            video = entry.setdefault("video", {}) if isinstance(entry.get("video", {}), dict) else None
            out.append((f"media[{i}].video", video))
    legacy = _dig(doc, ("videoWindow", "media"))
    if legacy is not None:
        out.append(("videoWindow.media", legacy))
    side = _dig(doc, ("compare", "b"))
    for field in ("media", "coverMedia"):
        overrides = side.get(field) if isinstance(side, dict) else None
        for ident, spec in (overrides.items() if isinstance(overrides, dict) else []):
            out.append((f"compare.b.{field}.{ident}", spec))
    return out


def _item_time(item: Any, music: Optional[Dict[str, Any]], start: float) -> Any:
    """A kick's or room key's scene-local ms, or None when its `at` can't resolve."""
    from .beats import model as beats

    at = item.get("at") if isinstance(item, dict) else None
    if is_number(at):
        return at
    if isinstance(at, str):
        r = beats.resolve_local(at, music, start)
        return r["projectMs"] if r.get("ok") else None
    return None


def _room_carry(keys: List[Any], t: int, music: Optional[Dict[str, Any]], start: float, notes: List[str]) -> Optional[Dict[str, Any]]:
    """The room as it stands at the cut, as a key at the second part's first frame: every earlier key's colour, theme and
    lighting, latest first, arriving by a cut. A flood still spreading there finishes at once, which the notes say."""
    timed = [(_item_time(k, music, start), k) for k in keys]
    before = sorted(((at, k) for at, k in timed if is_number(at) and at < t), key=lambda pair: pair[0])
    if not before or any(is_number(at) and at == t for at, _k in timed):
        return None
    carry: Dict[str, Any] = {"at": 0, "transition": "cut"}
    for _at, key in before:
        carry.update({f: copy.deepcopy(key[f]) for f in ("colour", "themeId", "lighting") if f in key})
    at, last = before[-1]
    length = last.get("durationMs") if is_number(last.get("durationMs")) else 800
    if last.get("transition") == "flood" and at + length > t:
        notes.append("room: the cut lands inside a flood, so the second part starts with it finished")
    return carry


def _timed_list(items: Any, t: int, music: Optional[Dict[str, Any]], start: float, second: bool) -> List[Any]:
    """cameraKicks or room keys on one side of the cut. A number moves with the scene; a position still means the same bar."""
    out: List[Any] = []
    for item in items if isinstance(items, list) else []:
        at = item.get("at") if isinstance(item, dict) else None
        local = _item_time(item, music, start)
        if local is None:
            if not second:
                out.append(copy.deepcopy(item))
            continue
        if (local >= t) != second:
            continue
        kept = copy.deepcopy(item)
        if second and is_number(at):
            kept["at"] = at - t
        out.append(kept)
    return out


def split_doc(doc: Dict[str, Any], t: int, music: Optional[Dict[str, Any]], start: float) -> Tuple[Dict[str, Any], Dict[str, Any], List[str]]:
    """The sidecar as two scenes, each on its own clock; the notes say what could not stay exact."""
    first, second = copy.deepcopy(doc), copy.deepcopy(doc)
    notes: List[str] = []
    for path in KEYED_TRACKS:
        track = _dig(doc, path)
        if not isinstance(track, dict) or not isinstance(track.get("keys"), list):
            continue
        before, after, moved = split_track(track, t)
        _set_track(first, path, before)
        _set_track(second, path, after)
        if moved:
            notes.append(f"{'.'.join(path)}: the cut lands inside the move {moved}, so both parts meet on its pose there and each eases on its own")
    for where, spec in _screens(second):
        _advance_screen(spec, t, where, notes)
    if "cameraKicks" in doc:
        for part, is_second in ((first, False), (second, True)):
            kept = _timed_list(doc["cameraKicks"], t, music, start, is_second)
            if kept:
                part["cameraKicks"] = kept
            else:
                part.pop("cameraKicks", None)
    room_keys = _dig(doc, ("room", "keys"))
    if isinstance(room_keys, list):
        carry = _room_carry(room_keys, t, music, start, notes)
        for part, is_second in ((first, False), (second, True)):
            kept = _timed_list(room_keys, t, music, start, is_second)
            if is_second and carry is not None:
                kept.insert(0, carry)
            if kept:
                part["room"]["keys"] = kept
            else:
                part.pop("room", None)
    marks = _dig(doc, ("stills", "marksMs"))
    if isinstance(marks, list):
        first["stills"]["marksMs"] = [m for m in marks if is_number(m) and m < t]
        second["stills"]["marksMs"] = [m - t for m in marks if is_number(m) and m >= t]
    if isinstance(_dig(doc, ("duration",)), dict) and doc["duration"].get("mode") == "follow-media":
        first["duration"] = {"mode": "manual"}
        second["duration"] = {"mode": "manual"}
        notes.append("both parts now have a manual length, since each plays only part of its video")
    if _dig(doc, ("background", "type")) == "video":
        notes.append("the video background restarts in the second part")
    return first, second, notes


def split(project: Project, selector: str, at_text: str, name: Optional[str], opts: Optional[lockmod.WriteOpts] = None) -> Result:
    """Two scenes from one, meeting on a hard cut at --at. Later scenes stay exactly where they are: the first part keeps
    the stem and id; the second part takes the outgoing transition, any pinned cut and a fresh stem and id."""
    from .beats import model as beats
    from .film import timeline as tl

    pins = Pins()

    def build(tx: lockmod.Txn) -> Result:
        _raw, manifest = scenemod._manifest_for_edit(tx)
        view = scenemod._view(project, manifest)
        idx, stem = pins.resolve(view, selector)
        scenes = manifest["scenes"]
        entry = scenes[idx]
        music = beats.project_music(manifest)
        slots = tl.manifest_slots(project, manifest, music)
        slot = slots[idx]
        parsed = beats.parse_time(at_text, music, "--at")
        local = parsed["projectMs"] - slot["startMs"] if parsed["kind"] == "position" else parsed["projectMs"]
        t = musicmod.js_round(local)
        duration = musicmod.js_round(slot["durationMs"])
        incoming = (slot.get("transitionIn") or {}).get("durationMs") or 0
        outgoing = 0
        if idx + 1 < len(slots):
            outgoing = (slots[idx + 1].get("transitionIn") or {}).get("durationMs") or 0
        if not (0 < t < duration):
            raise KbError(f'--at {at_text} is scene time {t} ms, outside {stem} (0 to {duration} ms)', EXIT_PROBLEMS, kind="invalid", hint=f"./kb timeline lists where {stem} starts and ends")
        if t < incoming + MIN_PART_MS or duration - t < outgoing + MIN_PART_MS:
            raise KbError(f"--at {at_text} lands inside {stem}'s transition, so a part would be too short to hold it and later scenes would move", EXIT_PROBLEMS, kind="invalid",
                          hint=f"cut between {incoming + MIN_PART_MS} and {duration - outgoing - MIN_PART_MS} ms, or change the transition first")
        rel = f"scenes/{stem}.tsx"
        text = scenemod._read_text(tx, rel)
        doc_rel = f"scenes/{stem}.json"
        doc, _sha = tx.read_json(doc_rel)
        if doc is not None and not isinstance(doc, dict):
            raise KbError(f"{doc_rel} must be a JSON object")
        base = name or f"{scene_name(doc, stem)} part 2"
        second_stem = f"{project.next_prefix():02d}-{slugify(base)}"
        sid = scenemod.free_scene_id(slugify(base), scenemod.taken_scene_ids(project))
        rewritten = tsxmod.rewrite_scene_id(text, sid)
        if rewritten is None:
            raise KbError(f"{rel} has no readable defineScene id, so the second part would share it", EXIT_PROBLEMS, kind="invalid", hint="give the scene a literal id, then rerun")
        rewritten = tsxmod.rewrite_defined_duration(rewritten, duration - t)
        notes: List[str] = [f"later scenes keep their times: {stem} now ends at {t} ms on a hard cut"]
        doc_a: Optional[Dict[str, Any]] = None
        doc_b: Optional[Dict[str, Any]] = None
        if doc is not None:
            doc_a, doc_b, doc_notes = split_doc(doc, t, music, slot["startMs"])
            notes += doc_notes
            doc_b["name"] = base
        elif name:
            doc_b = {"version": SCENE_DOC_VERSION, "name": base}
        second_entry: Dict[str, Any] = {"file": f"scenes/{second_stem}.tsx", "durationMs": duration - t}
        for field in ("transition", "cutAt", "align", "effects"):
            if field in entry:
                second_entry[field] = copy.deepcopy(entry[field])
        entry["durationMs"] = t
        beats.unpin(entry)
        entry.pop("transition", None)
        if parsed["kind"] == "position":
            entry["cutAt"] = at_text
        scenes.insert(idx + 1, second_entry)
        notes += scenemod.settle_cuts(project, manifest)
        tx.write_text(second_entry["file"], rewritten, create_only=True)
        tx.write_text(rel, tsxmod.rewrite_defined_duration(text, t))
        if doc_b is not None:
            tx.write_json(f"scenes/{second_stem}.json", doc_b, create_only=True)
        if doc_a is not None:
            tx.write_json(doc_rel, doc_a)
        tx.write_json(MANIFEST, manifest)
        moved: List[str] = []
        moved_notes = beats.refresh_sidecars(tx, project, manifest, moved)
        notes += [f"refreshed tMs caches in {line}" for line in beats.moved_notes(moved_notes)] + moved
        notes.append(RESTARTS)
        return Result(second_entry["file"], idx + 1, sid, base, notes)

    return scenemod._run(project, "kb scene split", build, opts)[0]


# ── renumber ──────────────────────────────────────────────────────────────────


def renumbered_stem(stem: str, number: int) -> str:
    rest = stem.split("-", 1)[1] if numeric_prefix(stem) is not None and "-" in stem else stem
    return f"{number:02d}-{rest}"


def renumber(project: Project, start: int = 1, step: int = 1, opts: Optional[lockmod.WriteOpts] = None) -> Dict[str, Any]:
    """Number the scene files in film order. Only stems change: the scene ids in the code and everything in the sidecars
    stay, so the film renders the same."""
    if start < 0 or step < 1:
        raise KbError("--start must be 0 or more and --step 1 or more", EXIT_ENV, kind="usage")

    def build(tx: lockmod.Txn) -> Dict[str, Any]:
        _raw, manifest = scenemod._manifest_for_edit(tx)
        entries = manifest["scenes"]
        listed = [stem_of(e.get("file") or "") if isinstance(e, dict) else "" for e in entries]
        if not all(listed):
            raise KbError("project.json has a scene with no file; fix that first (kb check)", EXIT_PROBLEMS, kind="invalid")
        if len(set(listed)) != len(listed):
            raise KbError("project.json lists one scene file twice, which a rename can't keep apart; fix that first (kb check)", EXIT_PROBLEMS, kind="invalid")
        targets = [renumbered_stem(stem, start + i * step) for i, stem in enumerate(listed)]
        if len(set(targets)) != len(targets):
            raise KbError("two scenes would land on one stem; rename one first", EXIT_PROBLEMS, kind="invalid")
        moves = [(old, new) for old, new in zip(listed, targets) if old != new]
        sources = {f"scenes/{old}{ext}" for old, _new in moves for ext in (".tsx", ".json") if (project.root / f"scenes/{old}{ext}").is_file()}
        contents = {rel: tx.read(rel)[0] for rel in sorted(sources)}
        written: List[str] = []
        for old, new in moves:
            for ext in (".tsx", ".json"):
                rel, dest = f"scenes/{old}{ext}", f"scenes/{new}{ext}"
                if os.path.lexists(project.root / dest) and dest not in sources:
                    raise KbError(f"{dest} is already there and is not one of the scenes being renumbered", EXIT_PROBLEMS, kind="invalid",
                                  hint=f"register it with ./kb scene add {new}, or move it out of scenes/")
                if rel not in contents:
                    continue
                tx.write_bytes(dest, contents[rel] or b"", base=lockmod.current_hash(project.root / dest))
                written.append(dest)
            entries[listed.index(old)]["file"] = f"scenes/{new}.tsx"
        for rel in sources:
            if rel not in written:
                tx.remove(rel)
        if moves:
            tx.write_json(MANIFEST, manifest)
        return {"renamed": [{"from": old, "to": new} for old, new in moves]}

    out, tx = scenemod._run(project, "kb scene renumber", build, opts)
    if tx.committed:
        from . import leases

        for row in out["renamed"]:
            leases.rename_scene(project, row["from"], row["to"])
    return dict(out, writes=tx.writes, dryRun=tx.dry_run)


# ── import ────────────────────────────────────────────────────────────────────

TSX_MAX_BYTES = 512 * 1024
DOC_MAX_BYTES = 4 * 1024 * 1024
MANIFEST_MAX_BYTES = 4 * 1024 * 1024
CONFIRM_TIMEOUT_S = 300
ABS_PATH = re.compile(r"^(?:~/|file:|/(?:Users|home|private|tmp|var|etc|Volumes|Applications|Library|System|opt|usr|bin)(?:/|$)|[A-Za-z]:[\\/])", re.I)
REMOTE_SRC = re.compile(r"\b(?:src|href|url|map|texture|file|image|path)\s*[=:]\s*\{?\s*[\"'`]https?:", re.I)
REMOTE = re.compile(r"^https?:", re.I)
HOST_REACH = re.compile(
    r"(?<![\w$.])(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|eval|Function|globalThis|window|document|self|navigator|localStorage|sessionStorage|indexedDB|postMessage|require)(?![\w$])"
    r"|__TAURI|(?<![\w$.])import\s*\("
)
COPY_FIELDS = ("text", "managedText", "name", "textStyle")
COPY_PATHS = ("terminal.snapshot.grid", "chart.data")
COPY_LEAVES = ("text", "label", "title", "subtitle")
STRIPPED = (("terminal", "startCommand"), ("terminal", "startPath"), ("website", "url"), ("website", "requestedOrigins"), ("website", "capture", "sourceOrigin"))


def refused(message: str, hint: Optional[str] = None, data: Optional[Dict[str, Any]] = None) -> KbError:
    return KbError(message, EXIT_PROBLEMS, kind="invalid", hint=hint or "nothing was written; fix it in the source project, or ask the person", data=data)


def resolve_source(project: Project, source: str) -> Path:
    """A project folder (a path, or a slug or ws:<slug> in this workspace), through kb reach: credentials are refused, and
    a read from outside the workspace is announced."""
    text = source.strip()
    if text.startswith("ws:"):
        text = text[3:]
    named = text if ("/" in text or text.startswith(("~", "."))) else str(project.workspace_root / text)
    path = reach.guard_read_at(project.root, named, "the source project")
    if not (path / MANIFEST).is_file():
        raise KbError(f"{source} is not a Kookaburra Cut project (it has no {MANIFEST})", EXIT_ENV, kind="usage", hint="pass a project folder, or a project's name in this workspace")
    if path == reach.resolve(str(project.root)):
        raise KbError("that is this project", EXIT_ENV, kind="usage", hint="use ./kb scene duplicate to copy a scene within a project")
    return path


def require_allowed(source: Path) -> None:
    """The F-001 gate, as `copy_scene_to_project` applies it: scene code leaves only a project the person has allowed with
    this exact content. Anything that can't say so refuses."""
    from .video import appcli

    hint = f"ask the person to open {source.name} once in Kookaburra Cut, then rerun"
    try:
        allowed = appcli.trust_allowed(str(source))
    except KbError as e:
        raise KbError(f"kb can't tell whether {source.name} is allowed: {e.message}", EXIT_ENV, kind="needs-trust", hint=hint) from None
    if not allowed:
        raise KbError(f"{source.name} has code the person has not allowed (it is new to Kookaburra Cut, or changed since it was last opened), so kb won't copy from it", EXIT_ENV, kind="needs-trust", hint=hint)


def confirm_source(project: Project, source: Path) -> None:
    """The person's own yes, the dialog every other reach into another project shows: injected text must not pull one
    client's scene into another's film. It lives in the app, so no app or no answer refuses."""
    from . import bridge

    hint = "ask the person to open Kookaburra Cut and allow it, or to copy what they want themselves"
    if source.parent != reach.resolve(str(project.workspace_root)):
        raise KbError(f"{source.name} is outside this workspace, so the app can't ask the person about it", EXIT_ENV, kind="declined", hint=hint)
    resp = bridge.request("confirmImport", {"project": f"ws:{source.name}", "projectPath": str(source)}, CONFIRM_TIMEOUT_S, "kb scene import")
    if resp.get("ok") is not True or resp.get("allowed") is not True:
        raise KbError(str(resp.get("error") or f"the person did not allow copying from {source.name}"), EXIT_ENV, kind="declined", hint=hint)


def regular_file(root: Path, rel: str, what: str) -> Path:
    """rel under root with no symlink anywhere on the way, and a plain file at the end, so a planted link can't bring a
    file from elsewhere on the Mac along with the scene."""
    if not safe_rel(rel):
        raise refused(f"{what} {rel!r} is not a path inside the source project")
    here = root
    for part in rel.split("/"):
        here = here / part
        try:
            os.lstat(here)
        except OSError as e:
            raise refused(f"{what} {rel} cannot be read: {e.strerror or e}") from None
        if os.path.islink(here):
            raise refused(f"{what} {rel} is a symbolic link; kb only copies plain files out of another project")
    if not here.is_file():
        raise refused(f"{what} {rel} is not a file")
    reason = reach.denied_reason(here)
    if reason:
        raise refused(f"{what} {rel} is not read: {reason}")
    return here


def _capped_text(path: Path, rel: str, limit: int) -> str:
    if path.stat().st_size > limit:
        raise refused(f"{rel} is {path.stat().st_size} bytes, more than a scene file can be ({limit})")
    try:
        return read_text(path)
    except (OSError, UnicodeDecodeError) as e:
        raise refused(f"{rel} cannot be read as text: {e}") from None


def _walk_strings(value: Any, path: str = "") -> Any:
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, list):
        for i, item in enumerate(value):
            yield from _walk_strings(item, f"{path}[{i}]")
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from _walk_strings(item, f"{path}.{key}" if path else str(key))


def vet_tsx(rel: str, text: str) -> None:
    code = tsxmod.blank_comments_and_strings(text)
    hit = HOST_REACH.search(code)
    if hit:
        raise refused(f"{rel} line {tsxmod.line_of(code, hit.start())} uses {hit.group(0).strip()}, which reaches outside a scene; kb won't bring that in")
    bare = tsxmod.strip_comments(text)
    for m in re.finditer(r"([\"'`])((?:\\.|(?!\1).)*)\1", bare):
        if ABS_PATH.match(m.group(2)):
            raise refused(f"{rel} names an absolute path ({m.group(2)[:80]}); assets belong in the project's assets/ folder")
    hit = REMOTE_SRC.search(bare)
    if hit:
        raise refused(f"{rel} loads something from the web ({hit.group(0)[:80]}); assets belong in the project's assets/ folder")


def vet_doc(rel: str, doc: Dict[str, Any], notes: List[str]) -> Dict[str, Any]:
    """The sidecar as it may arrive: shell commands, folders and web origins off, musical positions off (they mean another
    song's bars), and no absolute path or remote file left anywhere outside on-screen copy."""
    from .beats import model as beats

    out = copy.deepcopy(doc)
    for path in STRIPPED:
        node = _dig(out, path[:-1])
        if isinstance(node, dict) and path[-1] in node:
            node.pop(path[-1])
            notes.append(f"left out {'.'.join(path)}: an imported scene brings no commands, folders or web origins")
    for slot in beats.timed_slots(out):
        if "at" in slot.node:
            slot.node.pop("at")
            notes.append(f"{slot.where} keeps its time but no longer follows the source's music")
    for name, items in (("cameraKicks", out.get("cameraKicks")), ("room.keys", _dig(out, ("room", "keys")))):
        if not isinstance(items, list):
            continue
        kept = [item for item in items if not (isinstance(item, dict) and isinstance(item.get("at"), str))]
        if len(kept) != len(items):
            notes.append(f"left out {len(items) - len(kept)} of {name}: each sits on the source's music (add it again with ./kb doc)")
            if name == "cameraKicks":
                out[name] = kept
            else:
                out["room"]["keys"] = kept
    for key, value in out.items():
        if key in COPY_FIELDS:
            continue
        for path, text in _walk_strings(value, key):
            if path.startswith(COPY_PATHS) or re.sub(r"\[\d+\]$", "", path).rsplit(".", 1)[-1] in COPY_LEAVES:
                continue
            if ABS_PATH.match(text) or REMOTE.match(text):
                raise refused(f"{rel} {path} names {text[:80]}; assets belong in the project's assets/ folder")
    return out


def asset_guard(source: Path) -> Any:
    from .check import SUPPORTED_ASSET_EXTS

    def guard(rel: str) -> None:
        if not tsxmod.is_project_asset_ref(rel):
            raise refused(f"asset {rel!r} is not under assets/")
        if rel.startswith("assets/.originals/") or rel == "assets/_meta.json" or rel.endswith(".timing.json"):
            raise refused(f"{rel} is the source project's own record, not media")
        if not (source / rel).exists() and not os.path.islink(source / rel):
            return
        ext = rel.rsplit(".", 1)[-1].lower() if "." in rel.rsplit("/", 1)[-1] else ""
        if ext not in SUPPORTED_ASSET_EXTS:
            raise refused(f'{rel} has an extension kb does not copy (".{ext}")')
        regular_file(source, rel, "asset")

    return guard


def load_source(source: Path) -> Project:
    """The other project's manifest, capped and shape-checked before anything trusts it."""
    path = regular_file(source, MANIFEST, "manifest")
    if path.stat().st_size > MANIFEST_MAX_BYTES:
        raise refused(f"{source.name}/{MANIFEST} is too large to be a project manifest")
    other = Project(source)
    manifest = load_json(path, f"{source.name}/{MANIFEST}")
    if not isinstance(manifest, dict) or not isinstance(manifest.get("scenes"), list):
        raise refused(f"{source.name}/{MANIFEST} has no scene list")
    other._manifest = manifest
    return other


def roster_of(source: Path) -> List[Dict[str, Any]]:
    other = load_source(source)
    rows: List[Dict[str, Any]] = []
    for i, entry in enumerate(other.scene_entries()):
        file = entry.get("file") if isinstance(entry, dict) else None
        stem = stem_of(file) if isinstance(file, str) else "?"
        doc: Any = None
        try:
            path = regular_file(source, f"scenes/{stem}.json", "sidecar")
            if path.stat().st_size <= DOC_MAX_BYTES:
                doc = json.loads(read_text(path))
        except (KbError, OSError, ValueError, UnicodeDecodeError):
            doc = None
        rows.append({"index": i, "stem": stem, "name": scene_name(doc if isinstance(doc, dict) else None, stem), "durationMs": entry.get("durationMs") if isinstance(entry, dict) else None})
    return rows


def _static_issues(other: Project, rel: str, stem: str) -> List[str]:
    from . import check as checkmod

    checker = checkmod.Checker(checkmod.Context(other))
    checker.tsx(rel)
    checker.sidecar(stem)
    return [i.line() for i in checker.report.errors]


def import_scene(project: Project, source: str, selector: str, name: Optional[str], place: Place, duration: Optional[int], opts: Optional[lockmod.WriteOpts] = None) -> Result:
    """Bring one scene in from another project: its code, sidecar and the assets they name, nothing else. Everything read
    is untrusted: refused unless the person allowed that project's current content, every file plain and inside it, the
    code free of host reach and the sidecar free of commands and absolute paths."""
    root = resolve_source(project, source)
    require_allowed(root)
    confirm_source(project, root)
    other = load_source(root)
    idx, stem = other.resolve(selector)
    entry = other.scene_entries()[idx]
    if not isinstance(entry, dict):
        raise refused(f"{root.name} scene {idx} is not an object")
    rel = f"scenes/{stem}.tsx"
    if entry.get("file") != rel:
        raise refused(f"{root.name} scene {idx} points at {entry.get('file')!r}, not a file under scenes/")
    text = _capped_text(regular_file(root, rel, "scene"), rel, TSX_MAX_BYTES)
    doc_rel = f"scenes/{stem}.json"
    doc: Optional[Dict[str, Any]] = None
    notes: List[str] = [f"from {root}: its hooks, permissions, commands and other files stay behind"]
    if os.path.lexists(root / doc_rel):
        try:
            loaded = json.loads(_capped_text(regular_file(root, doc_rel, "sidecar"), doc_rel, DOC_MAX_BYTES))
        except ValueError as e:
            raise refused(f"{doc_rel} in {root.name} is not valid JSON: {e}") from None
        if not isinstance(loaded, dict):
            raise refused(f"{doc_rel} in {root.name} is not a JSON object")
        doc = vet_doc(doc_rel, loaded, notes)
    vet_tsx(rel, text)
    issues = _static_issues(other, rel, stem)
    if issues:
        raise refused(f"{root.name}'s {stem} has {len(issues)} problem(s): {'; '.join(issues[:4])}", data={"issues": issues[:16]})
    source_shared = other.manifest().get("shared")
    shared_in: Dict[str, Any] = source_shared if isinstance(source_shared, dict) else {}
    vet_doc(MANIFEST, {"shared": shared_in}, [])
    clean_entry = {k: copy.deepcopy(entry[k]) for k in ("file", "durationMs", "effects") if k in entry}
    if not is_int(clean_entry.get("durationMs")) or clean_entry["durationMs"] <= 0:
        clean_entry["durationMs"] = DEFAULT_SCENE_DURATION_MS
    vet_doc(MANIFEST, {"entry": clean_entry}, [])
    pins = Pins()
    guard = asset_guard(root)

    def build(tx: lockmod.Txn) -> Result:
        _raw, manifest = scenemod._manifest_for_edit(tx)
        at = place.index(scenemod._view(project, manifest), len(manifest["scenes"]), pins)
        have = manifest.get("shared", {})
        missing = {k: v for k, v in shared_in.items() if k not in have} if isinstance(have, dict) else {}
        outside = ImportedFiles(text, doc, missing, guard)
        result = scenemod._copy(tx, project, manifest, root, clean_entry, None, name, at, False, None, False, duration, place.transition, outside)
        result.notes = notes + result.notes
        if missing:
            result.notes.append(f"added shared constants the scene may read: {', '.join(sorted(missing)[:6])}")
        return result

    return scenemod._run(project, "kb scene import", build, opts)[0]
