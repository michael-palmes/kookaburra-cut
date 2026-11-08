"""The song's shape for pacing and planning: the bars the film counts in, the song's parts as project bars (quiet or
peak), the final hit and fills, and how long each part lets the frame sit still (DESIGN.md, "Pacing")."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

from ..project import Project
from ..util import KbError, is_number
from ..video.editmath import js_round
from . import model

# Beats a part lets the frame sit still: something new every bar in quiet parts, every 2 beats in peaks, every beat in a burst.
PULSE_BEATS = {"quiet": 4, "peak": 2, "burst": 1}
STILL_CAP_MS = 2400
NO_MUSIC_BAR_MS = 2000
READ_WORD_MS = 200
READ_SETTLE_MS = 600
_PEAK = ("peak", "chorus", "drop", "climax")
_QUIET = ("intro", "build", "breakdown", "bridge", "verse", "outro", "break", "pre")


def part_kind(text: Any) -> Optional[str]:
    """peak for a peak, chorus or drop; quiet for an intro, build, breakdown or outro; None for a story name (reveal)."""
    t = text.lower() if isinstance(text, str) else ""
    if t.startswith(_PEAK):
        return "peak"
    if t.startswith(_QUIET):
        return "quiet"
    return None


def reading_ms(words: int, lines: int, beat_ms: Optional[float] = None) -> int:
    """How long text needs once it lands: 0.2 s a word plus 0.6 s a line, rounded up to the beat."""
    if words <= 0:
        return 0
    ms = float(READ_WORD_MS * words + READ_SETTLE_MS * max(1, lines))
    if beat_ms:
        ms = math.ceil(ms / beat_ms - 1e-9) * beat_ms
    return int(math.ceil(ms - 1e-9))


def pulse_words(beats: float, beats_per_bar: int) -> str:
    if beats >= beats_per_bar:
        return "every bar"
    return "every beat" if beats <= 1 else f"every {beats:g} beats"


def _analysis(project: Project, manifest: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    from . import cache
    from .commands import load_analysis

    try:
        analysis = load_analysis(project, manifest)[0]
    except KbError:
        return None
    return analysis if isinstance(analysis, dict) and analysis.get("version") in cache.FITTED_VERSIONS else None


def song_shape(project: Project, manifest: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The bars the film counts in (the authored grid, else the analysis's fit; without either a bar is 2 s), the song's
    parts in project bars and ms (musically named sections first, else the analysis's), the final hit, fills and the
    audible end in project ms. Analysis bars convert through time, since its bar 1 need not be the grid's."""
    from .commands import start_offset

    manifest = project.manifest() if manifest is None else manifest
    m = model.project_music(manifest)
    grid = model.grid_of(m)
    analysis = _analysis(project, manifest)
    fit = model.detected_grid(analysis)
    use = grid or fit
    offset = start_offset(manifest)
    audio = manifest.get("audio") if isinstance(manifest.get("audio"), dict) else {}
    shape: Dict[str, Any] = {
        "soundtrack": audio.get("file") if isinstance(audio.get("file"), str) else None, "analysed": analysis is not None,
        "grid": None, "gridSource": None, "beatsPerBar": 4, "beatMs": NO_MUSIC_BAR_MS / 4, "barMs": float(NO_MUSIC_BAR_MS),
        "parts": [], "partsSource": None, "finalHitMs": None, "finalHit": None, "fills": [], "audibleEndMs": None,
        "startOffsetMs": offset,
    }
    if analysis is not None:
        ending = analysis.get("ending") if isinstance(analysis.get("ending"), dict) else {}
        if is_number(ending.get("audibleEndMs")):
            shape["audibleEndMs"] = ending["audibleEndMs"] - offset
    if not use:
        return shape
    beat = 60000.0 / use["bpm"]
    bar = beat * use["beatsPerBar"]
    shape.update(grid={k: use[k] for k in ("bpm", "offsetMs", "beatsPerBar")}, gridSource="authored" if grid else "analysis",
                 beatsPerBar=use["beatsPerBar"], beatMs=beat, barMs=bar)

    def bar_at(project_ms: float) -> int:
        return js_round((project_ms + offset - use["offsetMs"]) / bar) + 1

    def ms_of(b: int) -> float:
        return use["offsetMs"] + (b - 1) * bar - offset

    parts: List[Dict[str, Any]] = []
    sections = (m or {}).get("sections") or {}
    # Sections are the song's parts only when every one is named like a part; story sections (a reveal, a lockup) leave the analysis's.
    if sections and all(part_kind(ident) for ident in sections):
        for ident, s in sections.items():
            lo = model.resolve(f"section:{ident}", m)
            to = s.get("to")
            hi = model.resolve(to, m) if isinstance(to, str) else {"ok": is_number(to), "projectMs": to}
            if lo["ok"] and hi["ok"]:
                parts.append({"id": ident, "label": s.get("label") or ident, "kind": part_kind(ident), "fromMs": lo["projectMs"], "toMs": hi["projectMs"]})
    source = "sections" if parts else None
    form = analysis.get("form") if analysis is not None and isinstance(analysis.get("form"), dict) else {}
    if not parts and fit:
        fit_bar = 60000.0 / fit["bpm"] * fit["beatsPerBar"]
        for p in form.get("parts") or []:
            if isinstance(p, dict) and is_number(p.get("fromBar")) and is_number(p.get("toBar")):
                kind = part_kind(p.get("kind")) or part_kind(p.get("id")) or "quiet"
                ident = p["id"] if isinstance(p.get("id"), str) else kind
                parts.append({"id": ident, "label": p["label"] if isinstance(p.get("label"), str) else ident, "kind": kind,
                              "fromMs": fit["offsetMs"] + (p["fromBar"] - 1) * fit_bar - offset,
                              "toMs": fit["offsetMs"] + (p["toBar"] - 1) * fit_bar - offset})
        source = "analysis" if parts else None
    for p in parts:
        p["fromBar"], p["toBar"] = bar_at(p["fromMs"]), bar_at(p["toMs"])
        p["fromMs"], p["toMs"] = ms_of(p["fromBar"]), ms_of(p["toBar"])
    shape["parts"] = sorted((p for p in parts if p["toBar"] > p["fromBar"]), key=lambda p: p["fromBar"])
    shape["partsSource"] = source

    cues = (m or {}).get("cues") or {}
    moments = [x for x in form.get("moments") or [] if isinstance(x, dict) and is_number(x.get("ms"))]
    final: Optional[float] = None
    if "final-hit" in cues:
        r = model.resolve("cue:final-hit", m)
        final = r["projectMs"] if r["ok"] else None
    if final is None:
        final = next((x["ms"] - offset for x in moments if x.get("id") == "final-hit"), None)
    if final is not None:
        shape["finalHitMs"], shape["finalHit"] = final, position(shape, final)
    fills = []
    for ident in sorted(c for c in cues if c.startswith("fill")):
        r = model.resolve(f"cue:{ident}", m)
        if r["ok"]:
            fills.append({"id": ident, "ms": r["projectMs"]})
    if not fills:
        fills = [{"id": x.get("id") or "fill", "ms": x["ms"] - offset} for x in moments if x.get("kind") == "fill"]
    shape["fills"] = [dict(f, bar=bar_at(f["ms"])) for f in fills]
    return shape


def position(shape: Dict[str, Any], project_ms: float) -> Optional[str]:
    """The nearest beat as bar:B.beat (bar:B on a downbeat), or None without a grid."""
    grid = shape.get("grid")
    if not grid:
        return None
    index = js_round((project_ms + shape.get("startOffsetMs", 0) - grid["offsetMs"]) / shape["beatMs"])
    per = grid["beatsPerBar"]
    b = math.floor(index / per) + 1
    beat = index - (b - 1) * per + 1
    return f"bar:{b}" if beat == 1 else f"bar:{b}.{beat}"


def part_at(shape: Dict[str, Any], project_ms: float) -> Optional[Dict[str, Any]]:
    return next((p for p in shape["parts"] if p["fromMs"] <= project_ms < p["toMs"]), None)


def pulse_at(shape: Dict[str, Any], project_ms: float) -> Dict[str, Any]:
    """How long the frame may sit still at a moment: { kind: quiet, peak or end, part, beats, allowedMs }. After the
    final hit it may hold a bar; elsewhere the part's pulse, never past 2.4 s."""
    final = shape.get("finalHitMs")
    if final is not None and project_ms >= final:
        return {"kind": "end", "part": None, "beats": shape["beatsPerBar"], "allowedMs": shape["barMs"]}
    part = part_at(shape, project_ms)
    kind = part["kind"] if part else "quiet"
    beats = PULSE_BEATS.get(kind, 4) if shape.get("grid") else shape["beatsPerBar"]
    return {"kind": kind, "part": part["id"] if part else None, "beats": beats, "allowedMs": min(beats * shape["beatMs"], STILL_CAP_MS)}
