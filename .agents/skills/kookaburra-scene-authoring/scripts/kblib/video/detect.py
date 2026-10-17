"""Pure classification of passes.collect() series into intervals (black, lead-in/out, idle, active) and events (screen changes, tap candidates), in source ms."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

BLACK_YMAX = 40.0
BLACK_MIN_MS = 100.0
STATIC_GAP_MS = 500.0
SLIVER_MS = 50.0
SCREEN_P20 = 2e-5
CAMERA_DB_RANGE = (-55.0, -30.0)

LOADING_MAX_AREA = 0.08
LOADING_UNION_AREA = 0.10
LOADING_MAX_GAP_MS = 200.0
LOADING_MEDIAN_GAP_MS = 125.0
LOADING_MIN_MS = 1000.0
BLINK_MAX_AREA = 0.005
BLINK_GAP_MS = (300.0, 1700.0)
BLINK_MAX_CV = 0.35
BLINK_MIN_EVENTS = 3
TYPING_MAX_AREA = 0.01
TYPING_MAX_GAP_MS = 400.0
TYPING_MIN_MS = 1000.0
TYPING_RATE = (3.0, 7.5)

TAP_PRIOR_STATIC_MS = 300.0
TAP_MAX_AREA = 0.12
TAP_FOLLOW_MS = 700.0
TAP_FOLLOW_AREA = 0.40
TAP_LEAD_MS = 33
TAP_COMPACT_AREA = 0.02
KEYBOARD_TOP = 0.62
KEYBOARD_TYPING_MS = 1500.0

CONF_PACKET = 0.99
CONF_BLACK = 0.98
CONF_FROZEN = 0.95
CONF_NEAR_FROZEN = 0.85
CONF_STATIC = 0.75
CONF_BLINK = 0.9

GLYPHS = " .:-=+*#%@"


def percentile(values: Sequence[float], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def _cv(gaps: Sequence[float]) -> float:
    if len(gaps) < 2:
        return 0.0
    mean = sum(gaps) / len(gaps)
    if mean <= 0:
        return 1.0
    var = sum((g - mean) ** 2 for g in gaps) / len(gaps)
    return math.sqrt(var) / mean


class Event:
    __slots__ = ("t", "yavg", "ymax", "bbox", "area", "cx", "cy", "run")

    def __init__(self, t: float, yavg: float, ymax: float, bbox: Optional[Sequence[int]], sw: int, sh: int) -> None:
        self.t = t
        self.yavg = yavg
        self.ymax = ymax
        self.bbox = list(bbox) if bbox else None
        if self.bbox:
            x1, y1, x2, y2 = self.bbox
            self.area = ((x2 - x1 + 1) * (y2 - y1 + 1)) / float(sw * sh)
            self.cx = (x1 + x2 + 1) / 2.0 / sw
            self.cy = (y1 + y2 + 1) / 2.0 / sh
        else:
            self.area, self.cx, self.cy = 0.0, 0.5, 0.5
        self.run: Optional[Dict[str, Any]] = None


def choose_profile(raw: Dict[str, Any], requested: str = "auto") -> Tuple[str, str]:
    info = raw.get("info") or {}
    if requested in ("screen", "camera"):
        return requested, "asked for"
    if info.get("vfr"):
        return "screen", "variable frame rate (a frame per screen change)"
    f = [s[3] / 255.0 for s in (raw.get("samples") or [])[1:]]
    p20 = percentile(f, 0.2)
    if p20 < SCREEN_P20:
        return "screen", f"most frames repeat exactly (p20 change {p20:.1e})"
    return "camera", f"every frame changes (p20 change {p20:.1e}), so only black and true freezes count"


def _black_intervals(raw: Dict[str, Any], events: List[Event]) -> List[List[float]]:
    duration = float((raw.get("info") or {}).get("durationMs") or 0)
    samples = raw.get("samples") or []
    out: List[List[float]] = []
    for a, b in raw.get("black") or []:
        run_start: Optional[float] = None
        inside = [s for s in samples if a - 1 <= s[0] < b]
        for i, s in enumerate(inside):
            dark = s[2] <= BLACK_YMAX
            if dark and run_start is None:
                run_start = max(a, s[0]) if i == 0 else s[0]
            if run_start is not None and (not dark or i == len(inside) - 1):
                end = s[0] if not dark else b
                out.append([run_start, min(end, b)])
                run_start = None
    snapped: List[List[float]] = []
    for a, b in out:
        if b - a < BLACK_MIN_MS:
            continue
        b = _snap(events, b, before=100.0) if b < duration else b
        a = _snap(events, a, before=100.0) if a > 0 else 0.0
        if b - a >= BLACK_MIN_MS:
            snapped.append([a, b])
    return snapped


def _snap(events: List[Event], t: float, before: float) -> float:
    """A 10 fps edge to the exact native change that caused it (the biggest in the preceding sample slot)."""
    near = [e for e in events if t - before - 1e-6 < e.t <= t + 1e-6]
    if not near:
        return t
    return max(near, key=lambda e: e.yavg).t


def _in_any(t: float, spans: Sequence[Sequence[float]], pad: float = 0.0) -> bool:
    return any(a - pad <= t < b + pad for a, b in spans)


def _mark_runs(events: List[Event], frame_area: float) -> List[Dict[str, Any]]:
    runs: List[Dict[str, Any]] = []

    def close(kind: str, members: List[Event], **extra: Any) -> None:
        gaps = [b.t - a.t for a, b in zip(members, members[1:])]
        run = {"kind": kind, "start": members[0].t, "last": members[-1].t, "count": len(members),
               "period": percentile(gaps, 0.5) if gaps else 0.0, "cv": _cv(gaps)}
        run.update(extra)
        for e in members:
            e.run = run
        runs.append(run)

    # Loading: fast, regular, small and stationary.
    i = 0
    while i < len(events):
        e = events[i]
        if e.run or e.area <= 0 or e.area > LOADING_MAX_AREA:
            i += 1
            continue
        members = [e]
        ux1, uy1, ux2, uy2 = e.bbox  # type: ignore[misc]
        j = i + 1
        while j < len(events):
            n = events[j]
            if n.run or n.area <= 0 or n.area > LOADING_MAX_AREA or n.t - members[-1].t > LOADING_MAX_GAP_MS:
                break
            nx1, ny1, nx2, ny2 = n.bbox  # type: ignore[misc]
            cand = (min(ux1, nx1), min(uy1, ny1), max(ux2, nx2), max(uy2, ny2))
            if (cand[2] - cand[0] + 1) * (cand[3] - cand[1] + 1) / frame_area > LOADING_UNION_AREA:
                break
            ux1, uy1, ux2, uy2 = cand
            members.append(n)
            j += 1
        gaps = [b.t - a.t for a, b in zip(members, members[1:])]
        if members[-1].t - members[0].t >= LOADING_MIN_MS and gaps and percentile(gaps, 0.5) <= LOADING_MEDIAN_GAP_MS:
            close("loading", members, regularity=max(0.0, 1.0 - min(1.0, _cv(gaps))))
            i = j
        else:
            i += 1

    # Blink: one tiny spot toggling on a slow regular period, nothing else changing between.
    free = [e for e in events if e.run is None]
    i = 0
    while i < len(free):
        e = free[i]
        if e.area <= 0 or e.area > BLINK_MAX_AREA:
            i += 1
            continue
        members = [e]
        j = i + 1
        while j < len(free):
            n = free[j]
            gap = n.t - members[-1].t
            if n.area <= 0 or n.area > BLINK_MAX_AREA or abs(n.cx - e.cx) > 0.02 or abs(n.cy - e.cy) > 0.02:
                break
            if not BLINK_GAP_MS[0] <= gap <= BLINK_GAP_MS[1]:
                break
            members.append(n)
            j += 1
        gaps = [b.t - a.t for a, b in zip(members, members[1:])]
        if len(members) >= BLINK_MIN_EVENTS and _cv(gaps) <= BLINK_MAX_CV:
            close("blink", members)
            i = j
        else:
            i += 1

    # Typing: tiny changes that move along, a few per second.
    free = [e for e in events if e.run is None]
    i = 0
    while i < len(free):
        e = free[i]
        if e.area <= 0 or e.area > TYPING_MAX_AREA:
            i += 1
            continue
        members = [e]
        j = i + 1
        while j < len(free):
            n = free[j]
            if n.area <= 0 or n.area > TYPING_MAX_AREA or n.t - members[-1].t > TYPING_MAX_GAP_MS:
                break
            members.append(n)
            j += 1
        span = members[-1].t - members[0].t
        xs = [m.cx for m in members]
        rate = (len(members) - 1) / (span / 1000.0) if span > 0 else 0.0
        if span >= TYPING_MIN_MS and TYPING_RATE[0] <= rate <= TYPING_RATE[1] and max(xs) - min(xs) >= 0.01:
            close("typing", members, rate=rate)
            i = j
        else:
            i += 1
    return runs


def _static_confidence(raw: Dict[str, Any], a: float, b: float) -> float:
    for ga, gb in raw.get("packetGaps") or []:
        if abs(ga - a) <= 2 and abs(gb - b) <= 2:
            return CONF_PACKET
    inner = [s[3] / 255.0 for s in raw.get("samples") or [] if a + 100 <= s[0] < b]
    worst = max(inner) if inner else 0.0
    if worst <= 1e-5:
        return CONF_FROZEN
    if worst <= 1e-4:
        return CONF_NEAR_FROZEN
    return CONF_STATIC


def _absorb_into_runs(pieces: List[Dict[str, Any]]) -> None:
    """A period-long hold before a blink run, or a one-frame sliver before a loading run, belongs to that run."""
    for i in range(len(pieces) - 1):
        p, n = pieces[i], pieces[i + 1]
        run = n.get("run")
        if not run:
            continue
        length = p["endMs"] - p["startMs"]
        if p.get("sub") == "static" and n.get("sub") == "blink" and length <= max(1.5 * run["period"], run["period"] + 200):
            pieces[i] = dict(n, startMs=p["startMs"], endMs=p["endMs"])
        elif p["kind"] == "active" and p.get("sub") is None and n.get("sub") == "loading" and length <= SLIVER_MS:
            pieces[i] = dict(n, startMs=p["startMs"], endMs=p["endMs"])


def _merge(pieces: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for p in pieces:
        if p["endMs"] <= p["startMs"]:
            continue
        last = out[-1] if out else None
        # Each static piece is one screen state; two in a row are different screens.
        same = last and last["kind"] == p["kind"] and last.get("sub") == p.get("sub") and p.get("sub") != "static"
        if same and abs(last["endMs"] - p["startMs"]) < 1e-6:
            last["endMs"] = p["endMs"]
            last["confidence"] = min(last["confidence"], p["confidence"])
            if p.get("run") is not None and last.get("run") is None:
                last["run"] = p["run"]
            continue
        out.append(dict(p))
    return out


def _screen_changes(raw: Dict[str, Any], events: List[Event]) -> List[Dict[str, Any]]:
    scores = {round(s[0]): s[4] for s in raw.get("samples") or []}
    out: List[Dict[str, Any]] = []
    for t in raw.get("scd") or []:
        exact = _snap(events, t, before=1000.0 / 10)
        if out and abs(exact - out[-1]["tMs"]) < 150:
            continue
        out.append({"kind": "screen-change", "tMs": exact, "score": round(float(scores.get(round(t), 0.0)), 2)})
    return out


def _tap_candidates(events: List[Event], changes: List[Dict[str, Any]], black: List[List[float]], aspect: float,
                    runs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    typing = [r for r in runs if r["kind"] == "typing"]
    out: List[Dict[str, Any]] = []
    for i, e in enumerate(events):
        if e.run is not None or e.area <= 0 or e.area > TAP_MAX_AREA or i == 0:
            continue
        if e.t - events[i - 1].t < TAP_PRIOR_STATIC_MS or _in_any(e.t, black, pad=1.0):
            continue
        if aspect > 1.4 and e.cy > KEYBOARD_TOP and any(r["start"] - KEYBOARD_TYPING_MS <= e.t <= r["last"] + KEYBOARD_TYPING_MS for r in typing):
            continue
        follows_change = any(e.t < c["tMs"] <= e.t + TAP_FOLLOW_MS for c in changes)
        follows_big = any(e.t < n.t <= e.t + TAP_FOLLOW_MS and n.area > TAP_FOLLOW_AREA for n in events[i + 1:i + 60])
        if not (follows_change or follows_big):
            continue
        x1, y1, x2, y2 = e.bbox  # type: ignore[misc]
        bw, bh = (x2 - x1 + 1), (y2 - y1 + 1)
        compact = e.area <= TAP_COMPACT_AREA and 0.5 <= bw / max(1, bh) <= 2.0
        conf = 0.5 + (0.3 if follows_change else 0.0) + (0.15 if compact else 0.0)
        out.append({
            "kind": "tap-candidate", "tMs": e.t, "sourceMs": int(round(e.t - TAP_LEAD_MS)),
            "pos": [round(e.cx, 4), round(e.cy, 4)], "bboxPx": [x1, y1, bw, bh],
            "confidence": round(conf, 2), "followedBy": "screen change" if follows_change else "large change",
        })
    return out


def _lead_labels(intervals: List[Dict[str, Any]], changes: List[Dict[str, Any]]) -> None:
    """Idle before the first activity is lead-in, idle after the last is lead-out; a change out of black is not activity."""
    acts = [iv for iv in intervals if iv["kind"] == "active"]
    marks = [iv["startMs"] for iv in acts] + [c["tMs"] for c in changes if not c.get("fromBlack")]
    ends = [iv["endMs"] for iv in acts] + [c["tMs"] for c in changes if not c.get("fromBlack")]
    if not marks:
        return
    first, last = min(marks), max(ends)
    for iv in intervals:
        if iv["kind"] != "idle":
            continue
        if iv["endMs"] <= first + 1e-6:
            iv["kind"], iv["sub"] = "lead-in", iv.get("sub")
        elif iv["startMs"] >= last - 1e-6:
            iv["kind"], iv["sub"] = "lead-out", iv.get("sub")


def _merge_leads(intervals: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for iv in intervals:
        last = out[-1] if out else None
        if last and iv["kind"] in ("lead-in", "lead-out") and last["kind"] == iv["kind"]:
            last["endMs"] = iv["endMs"]
            last["confidence"] = min(last["confidence"], iv["confidence"])
            if last.get("sub") != iv.get("sub"):
                last["sub"] = "mixed"
            continue
        out.append(iv)
    return out


def _note(iv: Dict[str, Any]) -> str:
    run = iv.get("run") or {}
    sub = iv.get("sub")
    if sub == "blink":
        return f"cursor blink every {run.get('period', 0) / 1000:.2f}s"
    if sub == "loading":
        return f"loading, regularity {run.get('regularity', 0):.2f}"
    if sub == "typing":
        return f"typing, {run.get('rate', 0):.1f} changes/s"
    if iv["kind"] == "black":
        return "black"
    if sub == "static" or iv["kind"] in ("lead-in", "lead-out"):
        return "nothing changes" if iv["confidence"] >= CONF_FROZEN else "nothing visible changes"
    if sub == "freeze":
        return "frozen picture"
    return ""


def analyse(raw: Dict[str, Any], profile: str = "auto") -> Dict[str, Any]:
    info = dict(raw.get("info") or {})
    duration = float(info.get("durationMs") or 0)
    sw, sh = (raw.get("scaled") or [360, 360])[:2]
    chosen, why = choose_profile(raw, profile)
    events = [Event(c[0], c[1], c[2], c[3], sw, sh) for c in raw.get("changes") or [] if c[0] < duration]
    black = _black_intervals(raw, events)
    events = [e for e in events if not _in_any(e.t, black, pad=0.5)]
    changes = _screen_changes(raw, events)
    for c in changes:
        c["fromBlack"] = any(abs(c["tMs"] - b) <= 1.0 for _, b in black)
    taps: List[Dict[str, Any]] = []
    runs: List[Dict[str, Any]] = []
    floor_db = None

    if chosen == "screen":
        runs = _mark_runs(events, float(sw * sh))
        cuts = sorted({0.0, duration} | {e.t for e in events} | {x for span in black for x in span})
        pieces: List[Dict[str, Any]] = []
        by_t = {e.t: e for e in events}
        for a, b in zip(cuts, cuts[1:]):
            if _in_any(a, black):
                pieces.append({"kind": "black", "sub": None, "startMs": a, "endMs": b, "confidence": CONF_BLACK})
                continue
            e = by_t.get(a)
            run = e.run if e else None
            length = b - a
            if run and length <= max(1.5 * run["period"], run["period"] + 200):
                kind = "active" if run["kind"] == "typing" else "idle"
                conf = CONF_BLINK if run["kind"] == "blink" else (0.6 + 0.2 * run.get("regularity", 0) if run["kind"] == "loading" else 1.0)
                pieces.append({"kind": kind, "sub": run["kind"], "startMs": a, "endMs": b, "confidence": round(conf, 3), "run": run})
            elif length >= STATIC_GAP_MS:
                pieces.append({"kind": "idle", "sub": "static", "startMs": a, "endMs": b, "confidence": _static_confidence(raw, a, b)})
            else:
                pieces.append({"kind": "active", "sub": None, "startMs": a, "endMs": b, "confidence": 1.0})
        _absorb_into_runs(pieces)
        intervals = _merge(pieces)
        taps = _tap_candidates(events, changes, black, sh / float(sw), runs)
    else:
        f = [s[3] / 255.0 for s in (raw.get("samples") or [])[1:] if not _in_any(s[0], black)]
        p10 = percentile(f, 0.1)
        target = 20 * math.log10(4 * p10) if p10 > 0 else -1e9
        target = max(CAMERA_DB_RANGE[0], min(CAMERA_DB_RANGE[1], target))
        bank = sorted(int(k) for k in (raw.get("cameraFreezes") or {}))
        floor_db = max([db for db in bank if db <= target + 1e-9] or [bank[0] if bank else -55])
        conf = 0.9 if floor_db <= CAMERA_DB_RANGE[0] else 0.8
        freezes = [list(x) for x in (raw.get("cameraFreezes") or {}).get(str(floor_db), [])]
        marks = sorted({0.0, duration} | {x for span in black + freezes for x in span})
        pieces = []
        for a, b in zip(marks, marks[1:]):
            if _in_any(a, black):
                pieces.append({"kind": "black", "sub": None, "startMs": a, "endMs": b, "confidence": CONF_BLACK})
            elif _in_any(a, freezes):
                pieces.append({"kind": "idle", "sub": "freeze", "startMs": a, "endMs": b, "confidence": conf})
            else:
                pieces.append({"kind": "active", "sub": None, "startMs": a, "endMs": b, "confidence": 1.0})
        intervals = _merge(pieces)

    _lead_labels(intervals, changes)
    intervals = _merge_leads(intervals)
    out_intervals = []
    for n, iv in enumerate(intervals, 1):
        out_intervals.append({
            "id": f"i{n}", "kind": iv["kind"], "sub": iv.get("sub"),
            "startMs": int(round(iv["startMs"])), "endMs": int(round(iv["endMs"])),
            "exactStartMs": round(iv["startMs"], 3), "exactEndMs": round(iv["endMs"], 3),
            "confidence": round(float(iv["confidence"]), 3), "note": _note(iv),
            "period": round(iv["run"]["period"], 1) if iv.get("run") else None,
        })
    for n, tap in enumerate(taps, 1):
        tap["id"] = f"k{n}"
    return {
        "version": raw.get("version"),
        "profile": chosen,
        "profileReason": why,
        "cameraFloorDb": floor_db,
        "durationMs": int(round(duration)),
        "width": info.get("width"),
        "height": info.get("height"),
        "fps": info.get("fps"),
        "editFps": info.get("editFps"),
        "vfr": bool(info.get("vfr")),
        "intervals": out_intervals,
        "screenChanges": [{"tMs": round(c["tMs"], 3), "score": c["score"], "fromBlack": c["fromBlack"]} for c in changes],
        "tapCandidates": taps,
        "activity": activity_series(raw, chosen, duration),
    }


def activity_series(raw: Dict[str, Any], profile: str, duration: float, bin_ms: float = 100.0) -> List[float]:
    """Max change per 100 ms bin (fraction of full scale)."""
    n = max(1, int(math.ceil(duration / bin_ms)))
    out = [0.0] * n
    if profile == "screen":
        for c in raw.get("changes") or []:
            k = int(c[0] // bin_ms)
            if 0 <= k < n:
                out[k] = max(out[k], c[1] / 255.0)
    else:
        for s in (raw.get("samples") or [])[1:]:
            k = int(s[0] // bin_ms)
            if 0 <= k < n:
                out[k] = max(out[k], s[3] / 255.0)
    return [round(v, 7) for v in out]


def strip(activity: Sequence[float], width: int = 72) -> str:
    """One glyph per column, levels log-spaced from 1e-6 to 1e-1."""
    if not activity:
        return ""
    cols = min(width, len(activity))
    out = []
    for c in range(cols):
        a = int(c * len(activity) / cols)
        b = max(a + 1, int((c + 1) * len(activity) / cols))
        v = max(activity[a:b])
        if v <= 1e-6:
            out.append(GLYPHS[0])
            continue
        level = (math.log10(v) + 6) / 5 * (len(GLYPHS) - 2)
        out.append(GLYPHS[1 + max(0, min(len(GLYPHS) - 2, int(level)))])
    return "".join(out)


KIND_GLYPH = {"black": "B", "lead-in": "<", "lead-out": ">", "active": "#"}
SUB_GLYPH = {"static": ".", "blink": "|", "loading": "~", "typing": "=", "freeze": ".", "mixed": "."}


def kind_strip(intervals: Sequence[Dict[str, Any]], duration: float, width: int = 72) -> str:
    if duration <= 0:
        return ""
    cols = min(width, max(1, int(duration // 100)))
    out = []
    for c in range(cols):
        t = (c + 0.5) * duration / cols
        iv = next((i for i in intervals if i["startMs"] <= t < i["endMs"]), None)
        if iv is None:
            out.append(" ")
        elif iv["kind"] == "active":
            out.append("=" if iv.get("sub") == "typing" else "#")
        elif iv["kind"] == "idle":
            out.append(SUB_GLYPH.get(iv.get("sub") or "static", "."))
        else:
            out.append(KIND_GLYPH.get(iv["kind"], "?"))
    return "".join(out)


def project(clips: Sequence[Dict[str, Any]], analyses: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Each interval and event as it lands on the edit's timeline, per clip occurrence (freezes and stills skipped)."""
    out: List[Dict[str, Any]] = []
    for clip in clips:
        result = analyses.get(clip.get("sourceId"))
        if result is None or clip.get("holdMs") is not None:
            continue
        speed = clip.get("speed") or 1
        speed = speed if speed > 0 else 1
        cin, cout, start = clip["inMs"], clip["outMs"], clip.get("startMs", 0)
        for iv in result.get("intervals") or []:
            a, b = max(cin, iv["startMs"]), min(cout, iv["endMs"])
            if b <= a:
                continue
            out.append({"clip": clip["id"], "interval": iv["id"], "kind": iv["kind"], "sub": iv.get("sub"),
                        "confidence": iv["confidence"], "sourceMs": [a, b],
                        "timelineMs": [start + (a - cin) / speed, start + (b - cin) / speed], "speed": speed})
        for c in result.get("screenChanges") or []:
            if cin <= c["tMs"] < cout:
                out.append({"clip": clip["id"], "kind": "screen-change", "sourceMs": c["tMs"],
                            "timelineMs": start + (c["tMs"] - cin) / speed, "score": c["score"]})
        for k in result.get("tapCandidates") or []:
            if cin <= k["sourceMs"] < cout:
                out.append({"clip": clip["id"], "kind": "tap-candidate", "id": k["id"], "sourceMs": k["sourceMs"],
                            "timelineMs": start + (k["sourceMs"] - cin) / speed, "pos": k["pos"], "confidence": k["confidence"]})
    return out
