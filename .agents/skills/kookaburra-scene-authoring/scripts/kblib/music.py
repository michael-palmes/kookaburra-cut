"""Musical positions (bar:13.3, cue:drop, section:outro, with an optional +40ms nudge) resolved to project ms.

A line-for-line mirror of the app's src/engine/musicTime.ts, pinned by
tests/fixtures/music-vectors.json: same grammar, same operation order, same
rounding (js_round), so a position lands on the same ms in kb and in the app.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Mapping

from .video.editmath import js_round

MAX_BAR = 100000

MUSIC_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,39}\Z", re.ASCII)

_POSITION = re.compile(
    r"(?:bar:(-?\d+)(?:\.(\d+)(?:\.(\d+))?)?|cue:([a-z0-9][a-z0-9-]{0,39})|section:([a-z0-9][a-z0-9-]{0,39}))"
    r"(?:([+-])(\d+(?:\.\d+)?)ms)?\Z",
    re.ASCII,
)

_MISSING = object()


def is_position(text: Any) -> bool:
    return isinstance(text, str) and _POSITION.match(text) is not None


def _fail(code: str, message: str) -> Dict[str, Any]:
    return {"ok": False, "code": code, "message": message}


def resolve(text: str, music: Mapping[str, Any]) -> Dict[str, Any]:
    """{"ok": True, "projectMs": float} or {"ok": False, "code", "message"}.

    music: {"grid": {"bpm", "offsetMs", "beatsPerBar"} | None, "startOffsetMs", "cues", "sections"}
    with cues {id: position | ms} and sections {id: {"from", "to"}}.
    """
    return _resolve(text, music, 0)


def _lookup(music: Mapping[str, Any], is_cue: bool, ident: str) -> Any:
    if is_cue:
        cues = music.get("cues") or {}
        return cues[ident] if ident in cues else _MISSING
    section = (music.get("sections") or {}).get(ident)
    if not isinstance(section, dict) or "from" not in section:
        return _MISSING
    return section["from"]


def _resolve(text: str, music: Mapping[str, Any], depth: int) -> Dict[str, Any]:
    m = _POSITION.match(text) if isinstance(text, str) else None
    if not m:
        return _fail("syntax", f'"{text}" isn\'t bar:B[.beat[.16th]], cue:ID or section:ID')
    nudge = ((-1 if m.group(6) == "-" else 1) * float(m.group(7))) if m.group(6) else 0
    if m.group(1) is not None:
        grid = music.get("grid")
        if not grid:
            return _fail("no-grid", "the project has no audio.grid")
        bar = int(m.group(1))
        beat = 1 if m.group(2) is None else int(m.group(2))
        sixteenth = 1 if m.group(3) is None else int(m.group(3))
        if abs(bar) > MAX_BAR:
            return _fail("range", f"bar {m.group(1)} is outside -{MAX_BAR}..{MAX_BAR}")
        per_bar = grid["beatsPerBar"]
        if beat < 1 or beat > per_bar:
            return _fail("range", f"beat {beat} is outside 1..{per_bar}")
        if sixteenth < 1 or sixteenth > 4:
            return _fail("range", f"sixteenth {sixteenth} is outside 1..4")
        beat_ms = 60000 / grid["bpm"]
        beats = (bar - 1) * per_bar + (beat - 1) + (sixteenth - 1) / 4
        base = grid["offsetMs"] + beats * beat_ms - music.get("startOffsetMs", 0)
    else:
        if depth > 0:
            return _fail("nested", "a cue or section can't point at another cue or section")
        is_cue = m.group(4) is not None
        ident = m.group(4) if is_cue else m.group(5)
        kind = "cue" if is_cue else "section"
        raw = _lookup(music, is_cue, ident)
        if raw is _MISSING:
            return _fail("unknown", f'no {kind} "{ident}"')
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            base = raw
        elif isinstance(raw, str):
            inner = _resolve(raw, music, depth + 1)
            if not inner["ok"]:
                return inner
            base = inner["projectMs"]
        else:
            return _fail("syntax", f'{kind} "{ident}" isn\'t a position or ms')
    return {"ok": True, "projectMs": base + nudge}


def round_ms(ms: float) -> int:
    """The app's roundMs (Math.round)."""
    return js_round(ms)


def resolve_scene_local(text: str, music: Mapping[str, Any], scene_start_ms: float) -> Dict[str, Any]:
    """A position as scene-local integer ms for a scene starting at scene_start_ms (project ms)."""
    r = resolve(text, music)
    if not r["ok"]:
        return r
    return {"ok": True, "projectMs": round_ms(r["projectMs"] - scene_start_ms)}
