"""Dead-time cleanup planned as source-range ops, plus the timeline model fit and review share (clip lengths, relayout, the render's frame grid, an op simulator)."""

from __future__ import annotations

import copy
import math
import re
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

MIN_CLIP_SOURCE_MS = 100
MIN_HOLD_MS = 100
DEFAULT_HOLD_MS = 2000
TAP_DURATION_MS = 550
SPEED_MENU = (0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 4.0, 6.0)
LOADING_MIN_CONFIDENCE = 0.6
CANDIDATE_ANCHOR_CONFIDENCE = 0.7

PRESETS: Dict[str, Dict[str, float]] = {
    "gentle": {"minConfidence": 0.9, "padAfter": 800, "readingPad": 1500, "padBefore": 500, "leadInKeep": 600,
               "leadOutKeep": 1500, "minRemoval": 700, "loadingCap": 2, "loadingOutCap": 2000, "tapBefore": 600,
               "tapAfter": 900, "minKept": 600, "seamSpacing": 1500, "removalCap": 0.60},
    "normal": {"minConfidence": 0.8, "padAfter": 500, "readingPad": 1000, "padBefore": 300, "leadInKeep": 400,
               "leadOutKeep": 1000, "minRemoval": 400, "loadingCap": 4, "loadingOutCap": 1000, "tapBefore": 400,
               "tapAfter": 700, "minKept": 400, "seamSpacing": 1000, "removalCap": 0.80},
    "aggressive": {"minConfidence": 0.6, "padAfter": 300, "readingPad": 600, "padBefore": 200, "leadInKeep": 250,
                   "leadOutKeep": 600, "minRemoval": 200, "loadingCap": 6, "loadingOutCap": 600, "tapBefore": 300,
                   "tapAfter": 600, "minKept": 250, "seamSpacing": 600, "removalCap": 0.92},
}


# ── timeline model (mirrors editMath.ts and edit.rs build_render_args) ───────


def eff_speed(speed: Any) -> float:
    return float(speed) if isinstance(speed, (int, float)) and not isinstance(speed, bool) and speed > 0 else 1.0


def js_round(x: float) -> int:
    """JavaScript Math.round (half up), which relayout uses for startMs."""
    return int(math.floor(x + 0.5))


def frame_at(ms: float, fps: float) -> int:
    """edit.rs frame_at: ((ms / 1000) * fps).round(), Rust rounding (half away from zero), floored at 0."""
    x = (ms / 1000.0) * fps
    if x <= 0:
        return 0
    f = math.floor(x)
    return int(f + (1 if x - f >= 0.5 else 0))


def doc_fps(doc: Dict[str, Any]) -> float:
    fps = (doc.get("settings") or {}).get("fps")
    return float(fps) if isinstance(fps, (int, float)) and fps > 0 else 60.0


def image_ids(doc: Dict[str, Any]) -> Set[str]:
    return {s["id"] for s in doc.get("sources") or [] if s.get("kind") == "image"}


def clip_ms(clip: Dict[str, Any], image: bool = False) -> float:
    """A clip's timeline length; Rust gives an image clip without a hold the default beat."""
    hold = clip.get("holdMs")
    if image:
        return float(hold if hold is not None else DEFAULT_HOLD_MS)
    if hold is not None:
        return float(max(0, hold))
    return max(0, clip["outMs"] - clip["inMs"]) / eff_speed(clip.get("speed"))


def relayout(clips: Sequence[Dict[str, Any]], images: Optional[Set[str]] = None) -> List[Dict[str, Any]]:
    """editMath.relayout: startMs is the rounded running sum (images always carry a hold there)."""
    t = 0.0
    out = []
    for c in clips:
        laid = dict(c)
        laid["startMs"] = js_round(t)
        t += clip_ms(c)
        out.append(laid)
    return out


def total_ms(clips: Sequence[Dict[str, Any]], images: Optional[Set[str]] = None) -> float:
    images = images or set()
    return sum(clip_ms(c, c.get("sourceId") in images) for c in clips)


def frame_grid(clips: Sequence[Dict[str, Any]], fps: float, images: Optional[Set[str]] = None) -> List[Tuple[int, int, float, float]]:
    """Per clip (startFrame, frames, cursorStartMs, cursorEndMs) on the render's cumulative grid."""
    images = images or set()
    out = []
    cursor = 0.0
    for c in clips:
        start_frame = frame_at(cursor, fps)
        a = cursor
        cursor += clip_ms(c, c.get("sourceId") in images)
        frames = max(1, frame_at(cursor, fps) - start_frame)
        out.append((start_frame, frames, a, cursor))
    return out


def total_frames(clips: Sequence[Dict[str, Any]], fps: float, images: Optional[Set[str]] = None) -> int:
    return max(1, sum(g[1] for g in frame_grid(clips, fps, images)))


def next_id(prefix: str, ids: Iterable[str]) -> str:
    taken = set(ids)
    pattern = re.compile(rf"^{re.escape(prefix)}(\d+)$", re.ASCII)
    top = max([int(m.group(1)) for m in (pattern.match(i) for i in taken) if m] + [0])
    n = top + 1
    while f"{prefix}{n}" in taken:
        n += 1
    return f"{prefix}{n}"


def timeline_at(clip: Dict[str, Any], source_ms: float) -> float:
    return clip["startMs"] + (source_ms - clip["inMs"]) / eff_speed(clip.get("speed"))


def occurrences(clips: Sequence[Dict[str, Any]], source_id: str, source_ms: float) -> List[Dict[str, Any]]:
    """Every non-freeze clip whose source span holds this moment (a duplicated segment holds it twice)."""
    return [c for c in clips if c.get("sourceId") == source_id and c.get("holdMs") is None and c["inMs"] <= source_ms < c["outMs"]]


def simulate(doc: Dict[str, Any], ops: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Apply cutSource/speedSource per clip occurrence as kb's plan does (the planners never leave a piece under the floor)."""
    out = copy.deepcopy(doc)
    images = image_ids(doc)
    clips = relayout(out.get("clips") or [], images)
    by_source: Dict[str, List[Dict[str, Any]]] = {}
    for op in ops:
        by_source.setdefault(op["sourceId"], []).append(op)
    ids = [c["id"] for c in clips]
    result: List[Dict[str, Any]] = []
    for clip in clips:
        rel = by_source.get(clip.get("sourceId"))
        if not rel or clip.get("holdMs") is not None or clip.get("sourceId") in images:
            result.append(clip)
            continue
        cuts = sorted({clip["inMs"], clip["outMs"]} | {x for op in rel for x in (op["fromMs"], op["toMs"]) if clip["inMs"] < x < clip["outMs"]})
        pieces = []
        for a, b in zip(cuts, cuts[1:]):
            mid = (a + b) / 2.0
            hit = next((op for op in rel if op["fromMs"] <= mid < op["toMs"]), None)
            if hit and hit["op"] == "cutSource":
                continue
            speed = hit["speed"] if hit else clip.get("speed", 1)
            if pieces and pieces[-1]["outMs"] == a and pieces[-1]["speed"] == speed:
                pieces[-1]["outMs"] = b
                continue
            pieces.append(dict(clip, inMs=a, outMs=b, speed=speed))
        for k, piece in enumerate(pieces):
            if k > 0:
                piece["id"] = next_id("c", ids)
                ids.append(piece["id"])
            result.append(piece)
    out["clips"] = relayout(result, images)
    return out


def merge_ops(ops: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Touching ops of one kind (and speed) become one, so kb's plan makes exactly the pieces simulate() does."""
    out: List[Dict[str, Any]] = []
    for op in ops:
        last = out[-1] if out else None
        if last and last["op"] == op["op"] and last["sourceId"] == op["sourceId"] and last["toMs"] == op["fromMs"] and last.get("speed") == op.get("speed"):
            out[-1] = dict(last, toMs=op["toMs"])
        else:
            out.append(dict(op))
    return out


def seams(clips: Sequence[Dict[str, Any]]) -> List[Tuple[float, int]]:
    """Timeline points where the picture jumps (another source, or a non-contiguous source span): (ms, index after)."""
    out = []
    for i in range(1, len(clips)):
        a, b = clips[i - 1], clips[i]
        contiguous = a.get("sourceId") == b.get("sourceId") and a.get("holdMs") is None and b.get("holdMs") is None and a["outMs"] == b["inMs"]
        if not contiguous:
            out.append((float(b["startMs"]), i))
    return out


def speed_class(clip: Dict[str, Any], images: Set[str]) -> str:
    if clip.get("holdMs") is not None or clip.get("sourceId") in images:
        return "hold"
    s = eff_speed(clip.get("speed"))
    return "1x" if abs(s - 1) < 1e-9 else ("faster" if s > 1 else "slower")


# ── range helpers ────────────────────────────────────────────────────────────


def subtract(ranges: List[Tuple[float, float]], holes: Sequence[Tuple[float, float]]) -> List[Tuple[float, float, bool, bool]]:
    """ranges minus holes -> (a, b, a_from_hole, b_from_hole)."""
    out = [(a, b, False, False) for a, b in ranges]
    for ha, hb in holes:
        nxt = []
        for a, b, la, rb in out:
            if hb <= a or ha >= b:
                nxt.append((a, b, la, rb))
                continue
            if ha > a:
                nxt.append((a, ha, la, True))
            if hb < b:
                nxt.append((hb, b, True, rb))
        out = nxt
    return out


def overlaps(a: float, b: float, spans: Sequence[Tuple[float, float]]) -> bool:
    return any(x < b and a < y for x, y in spans)


# ── the planner ──────────────────────────────────────────────────────────────


class Candidate:
    __slots__ = ("source", "action", "a", "b", "speed", "interval", "kind", "sub", "confidence", "reasons", "free")

    def __init__(self, source: str, action: str, a: float, b: float, interval: Dict[str, Any], speed: float = 1.0) -> None:
        self.source = source
        self.action = action
        self.a = a
        self.b = b
        self.speed = speed
        self.interval = interval
        self.kind = interval.get("kind")
        self.sub = interval.get("sub")
        self.confidence = interval.get("confidence", 0)
        self.reasons: List[str] = []
        self.free: Tuple[float, float] = (a, b)

    @property
    def saved(self) -> float:
        span = self.b - self.a
        return span if self.action == "cut" else span - span / self.speed

    def op(self) -> Dict[str, Any]:
        if self.action == "cut":
            return {"op": "cutSource", "sourceId": self.source, "fromMs": int(self.a), "toMs": int(self.b)}
        return {"op": "speedSource", "sourceId": self.source, "fromMs": int(self.a), "toMs": int(self.b), "speed": self.speed}


def loading_speed(span: float, cap: float, out_cap: float) -> float:
    """The smallest menu speed that brings span under out_cap, never past cap."""
    for s in SPEED_MENU:
        if 1 < s <= cap and span / s <= out_cap:
            return s
    return max(s for s in SPEED_MENU if s <= cap)


def eligible(clip: Dict[str, Any], images: Set[str]) -> bool:
    return clip.get("holdMs") is None and clip.get("sourceId") not in images and abs(eff_speed(clip.get("speed")) - 1) < 1e-9


def anchors_for(source_id: str, analysis: Dict[str, Any], doc: Dict[str, Any], clips: Sequence[Dict[str, Any]],
                p: Dict[str, float], keep: Sequence[Tuple[str, float, float]]) -> List[Tuple[float, float, str]]:
    out: List[Tuple[float, float, str]] = []
    for iv in analysis.get("intervals") or []:
        if iv["kind"] == "active":
            out.append((iv.get("exactStartMs", iv["startMs"]) - p["padBefore"], iv.get("exactEndMs", iv["endMs"]) + p["padAfter"], f"activity {iv['id']}"))
    for sc in analysis.get("screenChanges") or []:
        if not sc.get("fromBlack"):
            out.append((sc["tMs"] - p["padBefore"], sc["tMs"] + p["readingPad"], "screen change"))
    for tap in doc.get("taps") or []:
        if tap.get("sourceId") != source_id:
            continue
        occ = occurrences(clips, source_id, tap["sourceMs"])
        speed = max([eff_speed(c.get("speed")) for c in occ] or [1.0])
        out.append((tap["sourceMs"] - p["tapBefore"], tap["sourceMs"] + max(p["tapAfter"], TAP_DURATION_MS * speed), f"tap {tap['id']}"))
    for cand in analysis.get("tapCandidates") or []:
        if cand.get("confidence", 0) >= CANDIDATE_ANCHOR_CONFIDENCE:
            out.append((cand["sourceMs"] - p["tapBefore"], cand["sourceMs"] + p["tapAfter"], f"tap candidate {cand['id']}"))
    for sid, a, b in keep:
        if sid == source_id:
            out.append((a, b, "--keep"))
    return out


class CleanupPlan:
    def __init__(self) -> None:
        self.ops: List[Dict[str, Any]] = []
        self.items: List[Dict[str, Any]] = []
        self.skipped: List[Dict[str, Any]] = []
        self.protected_taps: List[Dict[str, Any]] = []
        self.masks: List[Dict[str, Any]] = []
        self.clips_skipped: List[Dict[str, Any]] = []
        self.before: Dict[str, Any] = {}
        self.after: Dict[str, Any] = {}
        self.doc: Optional[Dict[str, Any]] = None
        self.seams: List[float] = []
        self.preset = "normal"
        self.capped: Optional[str] = None

    def as_json(self) -> Dict[str, Any]:
        return {
            "preset": self.preset, "ops": self.ops, "changes": self.items, "skipped": self.skipped,
            "protectedTaps": self.protected_taps, "masks": self.masks, "clipsSkipped": self.clips_skipped,
            "before": self.before, "after": self.after, "seamsMs": [round(s, 1) for s in self.seams],
            "removalCapExceeded": self.capped,
        }


def plan_cleanup(doc: Dict[str, Any], analyses: Dict[str, Dict[str, Any]], *, preset: str = "normal",
                 keep: Sequence[Tuple[str, float, float]] = (), skip: Sequence[str] = (), cuts_only: bool = False,
                 no_speed: bool = False) -> CleanupPlan:
    """Plan the cleanup of every speed-1 video clip; nothing reorders, and a second run plans nothing."""
    p = PRESETS[preset]
    plan = CleanupPlan()
    plan.preset = preset
    images = image_ids(doc)
    fps = doc_fps(doc)
    slot = 1000.0 / fps
    clips = relayout(doc.get("clips") or [], images)
    sources = {s["id"]: s for s in doc.get("sources") or []}
    for c in clips:
        if not eligible(c, images):
            why = "a freeze frame" if c.get("holdMs") is not None else ("a still image" if c.get("sourceId") in images else f"retimed to {eff_speed(c.get('speed')):g}x")
            plan.clips_skipped.append({"clip": c["id"], "reason": why})
    skip_set = set(skip)
    candidates: List[Candidate] = []
    for sid, src in sources.items():
        analysis = analyses.get(sid)
        if analysis is None or src.get("kind") == "image":
            continue
        own = [c for c in clips if c.get("sourceId") == sid]
        good = [c for c in own if eligible(c, images)]
        if not good:
            continue
        duration = float(src.get("durationMs") or analysis.get("durationMs") or 0)
        anchors = anchors_for(sid, analysis, doc, clips, p, keep)
        holes = [(a, b) for a, b, _ in anchors]
        blocked = [(c["inMs"], c["outMs"]) for c in own if not eligible(c, images) and c.get("holdMs") is None]
        raw: List[Tuple[Candidate, Tuple[float, float]]] = []
        for iv in analysis.get("intervals") or []:
            tag = f"{sid}:{iv['id']}"
            a, b = float(iv.get("exactStartMs", iv["startMs"])), float(iv.get("exactEndMs", iv["endMs"]))
            if iv["id"] in skip_set or tag in skip_set:
                plan.skipped.append({"interval": iv["id"], "sourceId": sid, "kind": iv["kind"], "sub": iv.get("sub"), "reason": "--skip", "rangeMs": [a, b]})
                continue
            kind, sub, conf = iv["kind"], iv.get("sub"), iv.get("confidence", 0)
            if kind == "active":
                continue
            if sub == "loading" and kind == "idle":
                if no_speed or cuts_only:
                    plan.skipped.append({"interval": iv["id"], "sourceId": sid, "kind": kind, "sub": sub, "reason": "speed changes are off", "rangeMs": [a, b]})
                    continue
                if conf < LOADING_MIN_CONFIDENCE:
                    plan.skipped.append({"interval": iv["id"], "sourceId": sid, "kind": kind, "sub": sub, "reason": f"confidence {conf:.2f} below {LOADING_MIN_CONFIDENCE}", "rangeMs": [a, b]})
                    continue
                raw.append((Candidate(sid, "speed", a, b, iv), (a, b)))
                continue
            if conf < p["minConfidence"]:
                plan.skipped.append({"interval": iv["id"], "sourceId": sid, "kind": kind, "sub": sub, "reason": f"confidence {conf:.2f} below {p['minConfidence']}", "rangeMs": [a, b]})
                continue
            if cuts_only and (a <= 0 or b >= duration):
                plan.skipped.append({"interval": iv["id"], "sourceId": sid, "kind": kind, "sub": sub, "reason": "--cuts-only keeps the head and tail", "rangeMs": [a, b]})
                continue
            if kind == "lead-in":
                if cuts_only:
                    plan.skipped.append({"interval": iv["id"], "sourceId": sid, "kind": kind, "sub": sub, "reason": "--cuts-only keeps the head", "rangeMs": [a, b]})
                    continue
                raw.append((Candidate(sid, "cut", a, b - p["leadInKeep"], iv), (a, b)))
            elif kind == "lead-out":
                if cuts_only:
                    plan.skipped.append({"interval": iv["id"], "sourceId": sid, "kind": kind, "sub": sub, "reason": "--cuts-only keeps the tail", "rangeMs": [a, b]})
                    continue
                raw.append((Candidate(sid, "cut", a + p["leadOutKeep"], b, iv), (a, b)))
            else:
                raw.append((Candidate(sid, "cut", a, b, iv), (a, b)))
        # Contiguous cuts (black then lead-in) become one, so no edge lands between them.
        merged: List[Tuple[Candidate, Tuple[float, float]]] = []
        for cand, span in sorted(raw, key=lambda x: x[0].a):
            if merged and cand.action == "cut" and merged[-1][0].action == "cut" and abs(merged[-1][0].b - cand.a) < 1e-6:
                prev, pspan = merged[-1]
                prev.b = cand.b
                prev.reasons.append(f"joined with {cand.interval['id']}")
                merged[-1] = (prev, (pspan[0], span[1]))
                continue
            merged.append((cand, span))
        for cand, span in merged:
            if cand.b <= cand.a:
                continue
            for a, b, from_left, from_right in subtract([(cand.a, cand.b)], holes + blocked):
                part = Candidate(sid, cand.action, a, b, cand.interval)
                part.reasons = list(cand.reasons)
                part.free = span
                if part.action == "cut":
                    if not from_left and a > 0 and abs(a - span[0]) < 1e-6:
                        a += 2 * slot
                    if not from_right and b < duration and abs(b - span[1]) < 1e-6:
                        b -= 2 * slot
                part.a, part.b = float(math.ceil(a - 1e-6)), float(math.floor(b + 1e-6))
                if part.action == "speed":
                    part.speed = loading_speed(part.b - part.a, p["loadingCap"], p["loadingOutCap"])
                why = _too_small(part, p)
                if why:
                    plan.skipped.append({"interval": part.interval["id"], "sourceId": sid, "kind": part.kind, "sub": part.sub, "reason": why, "rangeMs": [part.a, part.b]})
                    continue
                candidates.append(part)
        for c in candidates:
            if c.source == sid:
                _fit_to_clips(c, good, holes, p)
        _close_gaps([c for c in candidates if c.source == sid], holes, p)

    for c in candidates:
        if c.action == "speed" and c.b > c.a:
            c.speed = loading_speed(c.b - c.a, p["loadingCap"], p["loadingOutCap"])
    live = [c for c in clips if eligible(c, images)]
    # A range no eligible clip shows any more was applied by an earlier run: nothing to do, so reruns are no-ops.
    candidates = [c for c in candidates if c.b - c.a > 0 and not _too_small(c, p)
                  and any(x.get("sourceId") == c.source and x["inMs"] < c.b and c.a < x["outMs"] for x in live)]
    accepted = _density(doc, clips, candidates, p, plan, images)
    plan.ops = merge_ops([c.op() for c in sorted(accepted, key=lambda c: (c.source, c.a))])
    after = simulate(doc, plan.ops)
    plan.doc = after
    before_ms = total_ms(clips, images)
    after_ms = total_ms(after["clips"], images)
    plan.before = {"ms": round(before_ms, 1), "frames": total_frames(clips, fps, images), "clips": len(clips)}
    plan.after = {"ms": round(after_ms, 1), "frames": total_frames(after["clips"], fps, images), "clips": len(after["clips"])}
    plan.seams = [s for s, _ in seams(after["clips"])]
    eligible_ms = sum(clip_ms(c) for c in clips if eligible(c, images))
    removed = before_ms - after_ms
    if eligible_ms > 0 and removed / eligible_ms > p["removalCap"]:
        plan.capped = f"this would remove {removed / eligible_ms:.0%} of the eligible footage (the {preset} cap is {p['removalCap']:.0%}): likely a false positive, rerun with --gentle or --keep A-B"
    for c in sorted(accepted, key=lambda c: (c.source, c.a)):
        occ = [x for x in clips if x.get("sourceId") == c.source and eligible(x, images) and x["inMs"] < c.b and c.a < x["outMs"]]
        first = occ[0] if occ else None
        plan.items.append({
            "action": c.action, "sourceId": c.source, "fromMs": int(c.a), "toMs": int(c.b),
            "speed": c.speed if c.action == "speed" else None, "interval": c.interval["id"], "kind": c.kind, "sub": c.sub,
            "confidence": c.confidence, "savedMs": round(c.saved, 1), "clips": [x["id"] for x in occ],
            "timelineMs": [round(timeline_at(first, max(c.a, first["inMs"])), 1), round(timeline_at(first, min(c.b, first["outMs"])), 1)] if first else None,
            "notes": c.reasons,
        })
    for tap in doc.get("taps") or []:
        plan.protected_taps.append({"tap": tap["id"], "sourceId": tap["sourceId"], "sourceMs": tap["sourceMs"]})
    for m in doc.get("masks") or []:
        hit = [o for o in plan.ops if o["sourceId"] == m.get("sourceId") and o["fromMs"] < m.get("endMs", 0) and m.get("startMs", 0) < o["toMs"]]
        if hit:
            plan.masks.append({"mask": m["id"], "sourceId": m["sourceId"], "spanMs": [m.get("startMs"), m.get("endMs")], "touchedBy": len(hit)})
    return plan


def _too_small(c: Candidate, p: Dict[str, float]) -> Optional[str]:
    span = c.b - c.a
    if span < MIN_CLIP_SOURCE_MS:
        return "too short once the pads are kept"
    if c.action == "cut" and span < p["minRemoval"]:
        return f"would remove only {span:.0f} ms (the minimum is {p['minRemoval']:.0f})"
    if c.action == "speed" and (c.saved < p["minRemoval"] or c.speed <= 1):
        return f"would save only {c.saved:.0f} ms"
    return None


def _fit_to_clips(c: Candidate, clips: Sequence[Dict[str, Any]], holes: Sequence[Tuple[float, float]], p: Dict[str, float]) -> None:
    """No kept sliver under minKept between an op and a clip edge: take it when it is free dead time, else back off."""
    for clip in clips:
        if not (clip["inMs"] < c.b and c.a < clip["outMs"]):
            continue
        overlap = min(c.b, clip["outMs"]) - max(c.a, clip["inMs"])
        if c.action == "speed" and overlap < max(MIN_CLIP_SOURCE_MS, p["minKept"]):
            # A speed range must not leave a sped sliver in a clip it barely touches.
            if c.a > clip["inMs"] and clip["outMs"] < c.b:
                c.a = float(clip["outMs"])
            elif c.b < clip["outMs"] and clip["inMs"] > c.a:
                c.b = float(clip["inMs"])
            continue
        left = c.a - clip["inMs"]
        if 0 < left < p["minKept"]:
            if c.free[0] <= clip["inMs"] and not overlaps(clip["inMs"], c.a, holes):
                c.a = float(clip["inMs"])
            else:
                c.a = float(clip["inMs"] + p["minKept"])
        right = clip["outMs"] - c.b
        if 0 < right < p["minKept"]:
            if c.free[1] >= clip["outMs"] and not overlaps(c.b, clip["outMs"], holes):
                c.b = float(clip["outMs"])
            else:
                c.b = float(clip["outMs"] - p["minKept"])


def _close_gaps(cands: List[Candidate], holes: Sequence[Tuple[float, float]], p: Dict[str, float]) -> None:
    """Two ops closer than minKept: join them over free dead time, else push the smaller one back."""
    cands.sort(key=lambda c: c.a)
    for x, y in zip(cands, cands[1:]):
        gap = y.a - x.b
        if gap < 0 or gap >= p["minKept"] or x.b - x.a <= 0 or y.b - y.a <= 0:
            continue
        if not overlaps(x.b, y.a, holes):
            if y.action == "speed":
                y.a = x.b
            else:
                x.b = y.a
        elif x.saved < y.saved:
            x.b = y.a - p["minKept"]
        else:
            y.a = x.b + p["minKept"]


def _density(doc: Dict[str, Any], clips: List[Dict[str, Any]], cands: List[Candidate], p: Dict[str, float],
             plan: CleanupPlan, images: Set[str]) -> List[Candidate]:
    """Drop cuts until every seam is at least seamSpacing from the next and every kept piece between cuts holds minKept."""
    accepted = sorted(cands, key=lambda c: (c.source, c.a))
    while True:
        after = simulate(doc, [c.op() for c in accepted])
        laid = after["clips"]
        marks = []
        for t, i in seams(laid):
            prev, cur = laid[i - 1], laid[i]
            owner = next((c for c in accepted if c.action == "cut" and c.source == cur.get("sourceId") and abs(c.b - cur["inMs"]) < 0.5
                          and prev.get("sourceId") == c.source and abs(prev["outMs"] - c.a) < 0.5), None)
            marks.append((t, owner))
        victim: Optional[Candidate] = None
        reason = ""
        for (t1, o1), (t2, o2) in zip(marks, marks[1:]):
            if t2 - t1 < p["seamSpacing"] and (o1 or o2):
                owned = [o for o in (o1, o2) if o]
                victim = min(owned, key=lambda c: c.saved)
                reason = f"seam within {p['seamSpacing'] / 1000:g}s of another"
                break
        if victim is None:
            # Overlapping occurrences can still leave a sliver under the source floor: drop the op that made it.
            originals = [(o.get("sourceId"), o["inMs"], o["outMs"]) for o in clips if o.get("holdMs") is None]
            for c in laid:
                if c.get("holdMs") is not None or c["outMs"] - c["inMs"] >= MIN_CLIP_SOURCE_MS:
                    continue
                if any(sid == c.get("sourceId") and a <= c["inMs"] and c["outMs"] <= b and b - a < MIN_CLIP_SOURCE_MS for sid, a, b in originals):
                    continue
                touching = [o for o in accepted if o.source == c.get("sourceId")
                            and (abs(o.b - c["inMs"]) < 0.5 or abs(o.a - c["outMs"]) < 0.5 or (o.a <= c["inMs"] and c["outMs"] <= o.b))]
                if touching:
                    victim = min(touching, key=lambda x: x.saved)
                    reason = f"would leave a {c['outMs'] - c['inMs']} ms sliver of {c['id']}"
                    break
        if victim is None:
            for c in laid:
                if c.get("holdMs") is not None:
                    continue
                span = c["outMs"] - c["inMs"]
                bordered = [o for (t, o) in marks if o and (abs(t - c["startMs"]) < 0.5 or abs(t - (c["startMs"] + clip_ms(c))) < 1.0)]
                if bordered and span < p["minKept"]:
                    victim = min(bordered, key=lambda x: x.saved)
                    reason = f"would leave a {span:.0f} ms piece between cuts"
                    break
        if victim is None:
            break
        accepted.remove(victim)
        plan.skipped.append({"interval": victim.interval["id"], "sourceId": victim.source, "kind": victim.kind, "sub": victim.sub,
                             "reason": reason, "rangeMs": [victim.a, victim.b]})
    return accepted


def tap_suggestions(doc: Dict[str, Any], analyses: Dict[str, Dict[str, Any]], min_confidence: float = 0.0) -> List[Dict[str, Any]]:
    """Tap candidates on the timeline, minus any within 300 ms of a tap the doc already has."""
    clips = relayout(doc.get("clips") or [], image_ids(doc))
    have = [(t["sourceId"], t["sourceMs"]) for t in doc.get("taps") or []]
    out = []
    for sid, analysis in analyses.items():
        for k in analysis.get("tapCandidates") or []:
            if k.get("confidence", 0) < min_confidence:
                continue
            if any(s == sid and abs(ms - k["sourceMs"]) < 300 for s, ms in have):
                continue
            for clip in occurrences(clips, sid, k["sourceMs"]):
                out.append(dict(k, sourceId=sid, clip=clip["id"], speed=eff_speed(clip.get("speed")),
                                timelineMs=round(timeline_at(clip, k["sourceMs"]), 1)))
    return sorted(out, key=lambda x: x["timelineMs"])
