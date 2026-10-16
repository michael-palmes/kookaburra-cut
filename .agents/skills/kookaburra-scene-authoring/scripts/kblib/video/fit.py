"""Fit an edit to an exact length or scene and land moments on targets, on the render's cumulative frame grid (edit.rs build_render_args); pure."""

from __future__ import annotations

import importlib.util
import math
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from . import cleanup as cl

NORMAL_CAP = 4.0
HARD_CAP = 6.0
GUARD_CAP = 2.0
MIN_PIECE_MS = 400.0
MAX_STATIC_HOLD_MS = 2000.0
TAP_LEAD_MS = 83.0
SCENE_SHIFT_MAX_MS = 1500
WEIGHTS = {"black": 4.0, "idle": 4.0, "loading": 4.0, "active": 1.0, "typing": 0.5}
IDLE = ("idle", "black", "loading")


class FitError(Exception):
    def __init__(self, message: str, minimum_ms: Optional[float] = None, maximum_ms: Optional[float] = None) -> None:
        super().__init__(message)
        self.message = message
        self.minimum_ms = minimum_ms
        self.maximum_ms = maximum_ms


def target_frames(target_ms: float, fps: float) -> int:
    return cl.frame_at(target_ms, fps)


def aim_ms(n_frames: int, fps: float) -> float:
    """The centre of the half-frame window that renders exactly n frames."""
    return n_frames * 1000.0 / fps


def lands(clips: Sequence[Dict[str, Any]], n_frames: int, fps: float, images: Optional[set] = None) -> bool:
    return cl.total_frames(clips, fps, images) == n_frames


def snap_speed(s: float) -> float:
    """Ruling 8: 0.05x steps, but a menu value within 4% wins."""
    for m in cl.SPEED_MENU:
        if abs(s - m) <= 0.04 * m:
            return m
    return max(0.05, round(s * 20) / 20.0)


# ── labelling ────────────────────────────────────────────────────────────────


def _kind_of(iv: Dict[str, Any]) -> str:
    if iv["kind"] == "black":
        return "black"
    if iv["kind"] == "active":
        return "typing" if iv.get("sub") == "typing" else "active"
    if iv.get("sub") == "loading":
        return "loading"
    return "idle"


def label_ranges(source_ms: Tuple[float, float], analysis: Optional[Dict[str, Any]]) -> List[Tuple[float, float, str]]:
    """The source span split by analysis kind (no analysis: all active)."""
    a, b = source_ms
    if not analysis:
        return [(a, b, "active")]
    out: List[Tuple[float, float, str]] = []
    for iv in analysis.get("intervals") or []:
        x, y = max(a, iv["startMs"]), min(b, iv["endMs"])
        if y > x:
            k = _kind_of(iv)
            if out and out[-1][2] == k and abs(out[-1][1] - x) < 1e-6:
                out[-1] = (out[-1][0], y, k)
            else:
                out.append((x, y, k))
    if not out:
        return [(a, b, "active")]
    if out[0][0] > a:
        out.insert(0, (a, out[0][0], "active"))
    if out[-1][1] < b:
        out.append((out[-1][1], b, "active"))
    return out


def static_ranges(source_ms: Tuple[float, float], analysis: Optional[Dict[str, Any]]) -> List[Tuple[float, float]]:
    """Where nothing at all moves (a blink or a spinner would visibly stop under a hold)."""
    a, b = source_ms
    out = []
    for iv in (analysis or {}).get("intervals") or []:
        if iv["kind"] in ("idle", "lead-in", "lead-out") and iv.get("sub") in ("static", "freeze", None):
            x, y = max(a, iv["startMs"]), min(b, iv["endMs"])
            if y > x:
                out.append((x, y))
    return out


def kind_at(analysis: Optional[Dict[str, Any]], a: float, b: float) -> str:
    """'idle' only when every part of [a, b) is idle (static, blink, loading, lead) and none is black."""
    if b <= a:
        return "idle"
    kinds = {k for _, _, k in label_ranges((a, b), analysis)}
    return "idle" if kinds and kinds <= {"idle", "loading"} else ("black" if kinds == {"black"} else "active")


def guards(doc: Dict[str, Any], source_id: str, speed: float) -> List[Tuple[float, float]]:
    return [(t["sourceMs"] - 300.0, t["sourceMs"] + cl.TAP_DURATION_MS * max(1.0, speed)) for t in doc.get("taps") or [] if t.get("sourceId") == source_id]


class Segment:
    __slots__ = ("clip", "a", "b", "kind", "guard", "speed", "base")

    def __init__(self, clip: Dict[str, Any], a: float, b: float, kind: str, guard: bool) -> None:
        self.clip = clip
        self.a, self.b = a, b
        self.kind = kind
        self.guard = guard
        self.base = cl.eff_speed(clip.get("speed"))
        self.speed = self.base

    @property
    def span(self) -> float:
        return self.b - self.a


def segments_for(clip: Dict[str, Any], doc: Dict[str, Any], analysis: Optional[Dict[str, Any]]) -> List[Segment]:
    ranges = label_ranges((clip["inMs"], clip["outMs"]), analysis)
    g = guards(doc, clip["sourceId"], cl.eff_speed(clip.get("speed")))
    edges = sorted({x for a, b, _ in ranges for x in (a, b)} | {x for a, b in g for x in (a, b) if clip["inMs"] < x < clip["outMs"]})
    segs: List[Segment] = []
    for a, b in zip(edges, edges[1:]):
        mid = (a + b) / 2
        kind = next((k for x, y, k in ranges if x <= mid < y), "active")
        segs.append(Segment(clip, a, b, kind, any(x <= mid < y for x, y in g)))
    # Pieces under MIN_PIECE_MS fold into the calmer neighbour so the ramp never makes slivers.
    changed = True
    while changed and len(segs) > 1:
        changed = False
        for i, s in enumerate(segs):
            if s.span >= MIN_PIECE_MS:
                continue
            nbrs = [j for j in (i - 1, i + 1) if 0 <= j < len(segs)]
            j = min(nbrs, key=lambda j: (WEIGHTS[segs[j].kind] if not segs[j].guard else 0, -segs[j].span))
            other = segs[j]
            keep_kind = other.kind if WEIGHTS[other.kind] <= WEIGHTS[s.kind] else s.kind
            merged = Segment(clip, min(s.a, other.a), max(s.b, other.b), keep_kind, s.guard or other.guard)
            lo = min(i, j)
            segs[lo:lo + 2] = [merged]
            changed = True
            break
    return segs


def _assemble(doc: Dict[str, Any], plan: List[Any]) -> List[Dict[str, Any]]:
    """Plan items (clip dicts, or lists of Segments) back into a relaid clip list with stable ids."""
    images = cl.image_ids(doc)
    ids = [c["id"] for c in doc.get("clips") or []]
    for item in plan:
        ids.extend([item["id"]] if isinstance(item, dict) else [seg.clip["id"] for seg in item])
    out: List[Dict[str, Any]] = []
    for item in plan:
        if isinstance(item, dict):
            out.append(item)
            continue
        first = True
        pieces: List[Dict[str, Any]] = []
        for seg in item:
            sp = round(seg.speed, 6)
            if pieces and pieces[-1]["speed"] == sp and pieces[-1]["outMs"] == int(round(seg.a)):
                pieces[-1]["outMs"] = int(round(seg.b))
                continue
            pieces.append(dict(seg.clip, inMs=int(round(seg.a)), outMs=int(round(seg.b)), speed=sp))
        for p in pieces:
            if not first:
                p["id"] = cl.next_id("c", ids)
                ids.append(p["id"])
            first = False
            out.append(p)
    return cl.relayout(out, images)


# ── shorten ──────────────────────────────────────────────────────────────────


def _ramp(doc: Dict[str, Any], clips: List[Dict[str, Any]], analyses: Dict[str, Dict[str, Any]], aim: float, cap: float,
          uniform: bool = False) -> Tuple[List[Any], float]:
    """Speed every video segment by min(cap, base*(1 + lambda*weight)) with lambda solved so the length meets aim."""
    images = cl.image_ids(doc)
    plan: List[Any] = []
    fixed = 0.0
    movable: List[Segment] = []
    for c in clips:
        if c.get("holdMs") is not None or c.get("sourceId") in images:
            plan.append(c)
            fixed += cl.clip_ms(c, c.get("sourceId") in images)
            continue
        segs = [Segment(c, c["inMs"], c["outMs"], "active", False)] if uniform else segments_for(c, doc, analyses.get(c["sourceId"]))
        plan.append(segs)
        movable.extend(segs)

    def caps(s: Segment) -> float:
        return max(s.base, min(cap, GUARD_CAP) if s.guard else cap)

    def length(lam: float) -> float:
        total = fixed
        for s in movable:
            w = 1.0 if uniform else WEIGHTS[s.kind]
            total += s.span / min(caps(s), s.base * (1 + lam * w))
        return total

    floor = fixed + sum(s.span / caps(s) for s in movable)
    if floor > aim:
        return plan, floor
    lo, hi = 0.0, 1.0
    while length(hi) > aim and hi < 1e9:
        hi *= 2
    for _ in range(80):
        mid = (lo + hi) / 2
        if length(mid) > aim:
            lo = mid
        else:
            hi = mid
    for s in movable:
        w = 1.0 if uniform else WEIGHTS[s.kind]
        s.speed = snap_speed(min(caps(s), s.base * (1 + hi * w)))
    return plan, floor


def minimum_length(doc: Dict[str, Any], analyses: Dict[str, Dict[str, Any]]) -> float:
    """The shortest auto can go: a normal cleanup, then every piece at the hard cap (2x inside tap guards)."""
    after = cl.plan_cleanup(doc, analyses, preset="normal").doc or doc
    _, floor = _ramp(after, cl.relayout(after["clips"], cl.image_ids(after)), analyses, -1.0, HARD_CAP)
    return floor


# ── lengthen ─────────────────────────────────────────────────────────────────


def _freeze(clip: Dict[str, Any], src: int, hold: float, ids: List[str]) -> Dict[str, Any]:
    fid = cl.next_id("c", ids)
    ids.append(fid)
    return {"id": fid, "sourceId": clip["sourceId"], "inMs": int(src), "outMs": int(src), "speed": 1, "holdMs": int(round(hold)), "startMs": 0}


def _lengthen(doc: Dict[str, Any], clips: List[Dict[str, Any]], analyses: Dict[str, Dict[str, Any]], need: float,
              steps: List[str], strategy: str, at_end: bool, at_start: bool) -> List[Dict[str, Any]]:
    images = cl.image_ids(doc)
    sources = {s["id"]: s for s in doc.get("sources") or []}
    clips = [dict(c) for c in clips]
    ids = [c["id"] for c in doc.get("clips") or []] + [c["id"] for c in clips]

    def video(c: Dict[str, Any]) -> bool:
        return c.get("holdMs") is None and c.get("sourceId") not in images

    if strategy in ("auto", "trim") and at_end and clips and video(clips[-1]) and need > 0.5:
        c = clips[-1]
        dur = float(sources.get(c["sourceId"], {}).get("durationMs") or c["outMs"])
        room = dur - c["outMs"]
        an = analyses.get(c["sourceId"])
        black = [(iv["startMs"], iv["endMs"]) for iv in (an or {}).get("intervals") or [] if iv["kind"] == "black"]
        limit = min([b0 for b0, _ in black if b0 >= c["outMs"]] + [dur])
        add = min(need * cl.eff_speed(c.get("speed")), max(0.0, min(room, limit - c["outMs"])))
        if add >= 1:
            c["outMs"] = int(c["outMs"] + math.floor(add))
            need -= math.floor(add) / cl.eff_speed(c.get("speed"))
            steps.append(f"restored {math.floor(add):.0f} ms of trimmed tail on {c['id']}")
    if strategy in ("auto", "trim") and at_start and clips and video(clips[0]) and need > 0.5:
        c = clips[0]
        an = analyses.get(c["sourceId"])
        black_end = max([iv["endMs"] for iv in (an or {}).get("intervals") or [] if iv["kind"] == "black" and iv["endMs"] <= c["inMs"]] + [0])
        add = min(need * cl.eff_speed(c.get("speed")), c["inMs"] - black_end)
        if add >= 1:
            c["inMs"] = int(c["inMs"] - math.floor(add))
            need -= math.floor(add) / cl.eff_speed(c.get("speed"))
            steps.append(f"restored {math.floor(add):.0f} ms of trimmed head on {c['id']}")
    if strategy in ("auto", "trim") and need > 0.5:
        for i in range(len(clips) - 1):
            a, b = clips[i], clips[i + 1]
            if not (video(a) and video(b) and a["sourceId"] == b["sourceId"] and a["outMs"] < b["inMs"]):
                continue
            an = analyses.get(a["sourceId"])
            if kind_at(an, a["outMs"], b["inMs"]) != "idle":
                continue
            add = min(need * cl.eff_speed(a.get("speed")), b["inMs"] - a["outMs"])
            if add >= 1:
                a["outMs"] = int(a["outMs"] + math.floor(add))
                need -= math.floor(add) / cl.eff_speed(a.get("speed"))
                steps.append(f"narrowed the cut after {a['id']} by {math.floor(add):.0f} ms (static)")
            if need <= 0.5:
                break
    if strategy == "auto" and need > 0.5:
        for c in clips:
            s = cl.eff_speed(c.get("speed"))
            if not video(c) or s <= 1 or kind_at(analyses.get(c["sourceId"]), c["inMs"], c["outMs"]) != "idle":
                continue
            span = c["outMs"] - c["inMs"]
            want = span / (span / s + need)
            new = snap_speed(max(1.0, want))
            if new < s:
                need -= span / new - span / s
                steps.append(f"slowed {c['id']} from {s:g}x to {new:g}x (loading)")
                c["speed"] = new
            if need <= 0.5:
                break
    if strategy in ("auto", "hold") and need > 0.5:
        # Static stretches, longest first, each holding up to MAX_STATIC_HOLD_MS (a frozen frame of a still screen is invisible).
        spots = []
        for c in clips:
            if not video(c):
                continue
            for x, y in static_ranges((c["inMs"], c["outMs"]), analyses.get(c["sourceId"])):
                at = int(round((x + y) / 2))
                if y - x >= 600 and at - c["inMs"] >= cl.MIN_CLIP_SOURCE_MS and c["outMs"] - at >= cl.MIN_CLIP_SOURCE_MS:
                    spots.append((y - x, c["id"], at))
        chosen: Dict[str, List[Tuple[int, float]]] = {}
        for _, cid, at in sorted(spots, key=lambda s: -s[0]):
            if need < cl.MIN_HOLD_MS:
                break
            hold = min(need, MAX_STATIC_HOLD_MS)
            chosen.setdefault(cid, []).append((at, hold))
            need -= hold
        out: List[Dict[str, Any]] = []
        for c in clips:
            marks = sorted(chosen.get(c["id"], []))
            piece = c
            for at, hold in marks:
                left = dict(piece, outMs=at)
                right = dict(piece, id=cl.next_id("c", ids), inMs=at)
                ids.append(right["id"])
                out.extend([left, _freeze(piece, at, hold, ids)])
                steps.append(f"held a static frame {hold:.0f} ms at source {at / 1000:.2f}s")
                piece = right
            out.append(piece)
        clips = out
    if need >= cl.MIN_HOLD_MS and at_end and clips:
        last = clips[-1]
        if last.get("holdMs") is not None:
            last["holdMs"] = int(round(last["holdMs"] + need))
            steps.append(f"extended the end hold {last['id']} by {need:.0f} ms")
        elif video(last):
            fps = cl.doc_fps(doc)
            laid = cl.relayout(clips, images)[-1]
            end = laid["startMs"] + cl.clip_ms(laid)
            sample = max(laid["startMs"], end - 1000.0 / fps)
            src = int(cl.js_round(min(last["outMs"], last["inMs"] + (sample - laid["startMs"]) * cl.eff_speed(last.get("speed")))))
            hold = max(float(cl.MIN_HOLD_MS), need)
            clips.append(_freeze(last, src, hold, ids))
            steps.append(f"held the last frame {hold:.0f} ms")
        need = 0.0
    return cl.relayout(clips, images)


# ── exact landing ────────────────────────────────────────────────────────────


def absorb(doc: Dict[str, Any], clips: List[Dict[str, Any]], analyses: Dict[str, Dict[str, Any]], aim: float,
           steps: List[str], at_end: bool = True) -> List[Dict[str, Any]]:
    """Land the length on aim to the millisecond, most invisible first; window edges (anchors) never move."""
    images = cl.image_ids(doc)
    sources = {s["id"]: s for s in doc.get("sources") or []}
    clips = [dict(c) for c in clips]
    ids = [c["id"] for c in doc.get("clips") or []] + [c["id"] for c in clips]

    def video(c: Dict[str, Any]) -> bool:
        return c.get("holdMs") is None and c.get("sourceId") not in images

    for _ in range(12):
        clips = cl.relayout(clips, images)
        r = cl.total_ms(clips, images) - aim
        if abs(r) < 0.5:
            return clips
        if _absorb_hold(clips, r, steps) or _absorb_cut_edge(clips, r, analyses, steps, video) \
                or _absorb_speed_edge(clips, r, steps, video):
            continue
        last = next((c for c in reversed(clips) if video(c)), None)
        if at_end and last is not None:
            s = cl.eff_speed(last.get("speed"))
            k = int(round(r * s))
            dur = int(sources.get(last["sourceId"], {}).get("durationMs") or last["outMs"])
            new_out = min(dur, last["outMs"] - k)
            lo, hi = sorted((new_out, last["outMs"]))
            if new_out - last["inMs"] >= cl.MIN_CLIP_SOURCE_MS and new_out != last["outMs"] and kind_at(analyses.get(last["sourceId"]), lo, hi) == "idle":
                last["outMs"] = new_out
                steps.append(f"{'trimmed' if k > 0 else 'extended'} the idle tail of {last['id']} by {abs(k)} ms")
                continue
        grown = _micro_ramp(clips, r, analyses, ids, video)
        if grown is not None:
            clips = grown
            steps.append("eased one stretch by a few percent to land the length to the millisecond")
            continue
        if at_end and last is not None:
            s = cl.eff_speed(last.get("speed"))
            k = int(round(r * s))
            dur = int(sources.get(last["sourceId"], {}).get("durationMs") or last["outMs"])
            new_out = min(dur, last["outMs"] - k)
            if new_out - last["inMs"] >= cl.MIN_CLIP_SOURCE_MS and new_out != last["outMs"]:
                last["outMs"] = new_out
                steps.append(f"{'trimmed' if k > 0 else 'extended'} the tail of {last['id']} by {abs(k)} ms")
                continue
        break
    return cl.relayout(clips, images)


def _absorb_hold(clips: List[Dict[str, Any]], r: float, steps: List[str]) -> bool:
    """Lengthen the first hold, or shorten holds (each down to the floor) until r is used up."""
    holds = [c for c in clips if c.get("holdMs") is not None]
    if not holds:
        return False
    if r < 0:
        holds[0]["holdMs"] = int(round(holds[0]["holdMs"] - r))
        steps.append(f"set hold {holds[0]['id']} to {holds[0]['holdMs']} ms")
        return True
    moved = False
    for c in holds:
        take = min(r, c["holdMs"] - cl.MIN_HOLD_MS)
        if take >= 0.5:
            c["holdMs"] = int(round(c["holdMs"] - take))
            r -= take
            moved = True
            steps.append(f"set hold {c['id']} to {c['holdMs']} ms")
        if r < 0.5:
            break
    return moved


def _absorb_cut_edge(clips: List[Dict[str, Any]], r: float, analyses: Dict[str, Dict[str, Any]], steps: List[str], video: Callable[[Dict[str, Any]], bool]) -> bool:
    for i in range(len(clips) - 1):
        a, b = clips[i], clips[i + 1]
        if not (video(a) and video(b) and a["sourceId"] == b["sourceId"] and a["outMs"] < b["inMs"]):
            continue
        k = int(round(r * cl.eff_speed(a.get("speed"))))
        new_out = a["outMs"] - k
        if new_out - a["inMs"] < cl.MIN_CLIP_SOURCE_MS or new_out > b["inMs"] or k == 0:
            continue
        if kind_at(analyses.get(a["sourceId"]), min(new_out, a["outMs"]), max(new_out, a["outMs"])) != "idle":
            continue
        a["outMs"] = new_out
        steps.append(f"moved the static cut after {a['id']} by {-k:+d} ms")
        return True
    return False


def _absorb_speed_edge(clips: List[Dict[str, Any]], r: float, steps: List[str], video: Callable[[Dict[str, Any]], bool]) -> bool:
    for i in range(len(clips) - 1):
        a, b = clips[i], clips[i + 1]
        if not (video(a) and video(b) and a["sourceId"] == b["sourceId"] and a["outMs"] == b["inMs"]):
            continue
        sa, sb = cl.eff_speed(a.get("speed")), cl.eff_speed(b.get("speed"))
        gain = 1.0 / sa - 1.0 / sb
        if abs(gain) < 1e-9:
            continue
        d = int(round(-r / gain))
        x = a["outMs"] + d
        if d == 0 or x - a["inMs"] < cl.MIN_CLIP_SOURCE_MS or b["outMs"] - x < cl.MIN_CLIP_SOURCE_MS:
            continue
        a["outMs"], b["inMs"] = x, x
        steps.append(f"moved the {sa:g}x/{sb:g}x edge between {a['id']} and {b['id']} by {d:+d} ms")
        return True
    return False


def _micro_ramp(clips: List[Dict[str, Any]], r: float, analyses: Dict[str, Dict[str, Any]], ids: List[str],
                video: Callable[[Dict[str, Any]], bool]) -> Optional[List[Dict[str, Any]]]:
    """Split one piece and run part of it 0.05x faster (r > 0) or slower: exact to well under a millisecond."""
    best = None
    for i, c in enumerate(clips):
        if not video(c):
            continue
        s = cl.eff_speed(c.get("speed"))
        for step in range(1, 7):
            s2 = round(s + (0.05 if r > 0 else -0.05) * step, 2)
            if s2 <= 0.05 or s2 > HARD_CAP:
                break
            per_ms = 1.0 / s - 1.0 / s2
            span = int(round(r / per_ms))
            if span < cl.MIN_CLIP_SOURCE_MS or c["outMs"] - c["inMs"] - span < cl.MIN_CLIP_SOURCE_MS:
                continue
            idle = kind_at(analyses.get(c["sourceId"]), c["outMs"] - span, c["outMs"]) == "idle"
            score = (step, 0 if idle else 1, span)
            if best is None or score < best[0]:
                best = (score, i, s2, span)
            break
    if best is None:
        return None
    _, i, s2, span = best
    c = clips[i]
    x = c["outMs"] - span
    right = dict(c, id=cl.next_id("c", ids), inMs=x, speed=s2)
    ids.append(right["id"])
    return clips[:i] + [dict(c, outMs=x), right] + clips[i + 1:]


# ── whole-edit fit ───────────────────────────────────────────────────────────


class FitResult:
    def __init__(self, clips: List[Dict[str, Any]], steps: List[str], fps: float, target_ms: float, before_ms: float,
                 images: set) -> None:
        self.clips = clips
        self.steps = steps
        self.fps = fps
        self.target_ms = target_ms
        self.frames = cl.total_frames(clips, fps, images)
        self.target_frames = target_frames(target_ms, fps)
        self.ms = cl.total_ms(clips, images)
        self.before_ms = before_ms
        self.anchors: List[Dict[str, Any]] = []
        self.warnings: List[str] = []

    @property
    def exact(self) -> bool:
        return self.frames == self.target_frames

    def as_json(self) -> Dict[str, Any]:
        return {"targetMs": self.target_ms, "targetFrames": self.target_frames, "frames": self.frames, "exact": self.exact,
                "beforeMs": round(self.before_ms, 1), "afterMs": round(self.ms, 1), "fps": self.fps, "steps": self.steps,
                "anchors": self.anchors, "warnings": self.warnings,
                "clips": [{k: c.get(k) for k in ("id", "sourceId", "inMs", "outMs", "speed", "holdMs", "startMs")} for c in self.clips]}


def fit_window(doc: Dict[str, Any], clips: List[Dict[str, Any]], analyses: Dict[str, Dict[str, Any]], aim: float,
               strategy: str, steps: List[str], at_start: bool, at_end: bool,
               protect: Sequence[Tuple[str, float, float]] = ()) -> List[Dict[str, Any]]:
    """Fit one contiguous run of clips to aim ms."""
    images = cl.image_ids(doc)
    sub = dict(doc, clips=clips)
    length = cl.total_ms(clips, images)
    if abs(length - aim) < 0.5:
        return cl.relayout(clips, images)
    if length > aim:
        if strategy == "hold":
            holds = [c for c in clips if c.get("holdMs") is not None]
            spare = sum(c["holdMs"] - cl.MIN_HOLD_MS for c in holds)
            if spare < length - aim:
                raise FitError(f"--strategy hold can only shorten existing holds ({spare:.0f} ms to spare)", minimum_ms=length - spare)
            return absorb(doc, [dict(c) for c in clips], analyses, aim, steps, at_end)
        if strategy == "speed":
            plan, floor = _ramp(sub, clips, analyses, aim, HARD_CAP, uniform=True)
            if floor > aim + 0.5:
                raise FitError("too short even at 6x everywhere", minimum_ms=floor)
            steps.append("sped every clip up evenly")
            return absorb(doc, _assemble(sub, plan), analyses, aim, steps, at_end)
        pl = cl.plan_cleanup(sub, analyses, preset="normal", no_speed=strategy == "trim", keep=protect)
        options: List[List[Dict[str, Any]]] = [[]]
        if pl.ops and not pl.capped:
            after_ms = cl.total_ms(pl.doc["clips"], images)
            options = [list(pl.ops)] if after_ms >= aim else [list(pl.ops), _partial_ops(sub, pl, aim)]
        best: Optional[List[Dict[str, Any]]] = None
        best_steps: List[str] = []
        failure: Optional[FitError] = None
        for ops in options:
            trial: List[str] = []
            try:
                out = _shorten_with(doc, sub, clips, analyses, ops, aim, strategy, trial, at_end, images, length)
            except FitError as e:
                failure = failure or e
                continue
            if best is None or abs(cl.total_ms(out, images) - aim) < abs(cl.total_ms(best, images) - aim):
                best, best_steps = out, trial
            if abs(cl.total_ms(out, images) - aim) < 0.5:
                break
        if best is None:
            raise failure or FitError("could not shorten this edit")
        steps.extend(best_steps)
        return best
    if strategy == "speed":
        plan, _ = _ramp(sub, clips, analyses, aim, HARD_CAP, uniform=True)
        _uniform_slow(plan, length, aim, images)
        steps.append("slowed every clip down evenly")
        return absorb(doc, _assemble(sub, plan), analyses, aim, steps, at_end)
    grown = _lengthen(doc, clips, analyses, aim - length, steps, strategy, at_end, at_start)
    return absorb(doc, grown, analyses, aim, steps, at_end)


def _shorten_with(doc: Dict[str, Any], sub: Dict[str, Any], clips: List[Dict[str, Any]], analyses: Dict[str, Dict[str, Any]],
                  ops: List[Dict[str, Any]], aim: float, strategy: str, steps: List[str], at_end: bool, images: set,
                  length: float) -> List[Dict[str, Any]]:
    work = clips
    if ops:
        work = cl.simulate(sub, ops)["clips"]
        if not work:
            raise FitError("cleanup would remove every clip")
        steps.append(f"cleanup: {len(ops)} change{'s' if len(ops) != 1 else ''} ({length / 1000:.2f}s to {cl.total_ms(work, images) / 1000:.2f}s)")
    if cl.total_ms(work, images) > aim + 0.5:
        if strategy == "trim":
            raise FitError("cuts alone cannot make it this short; allow speed changes (--strategy auto)", minimum_ms=cl.total_ms(work, images))
        plan, floor = _ramp(sub, work, analyses, aim, NORMAL_CAP)
        if floor > aim + 0.5:
            plan, floor = _ramp(sub, work, analyses, aim, HARD_CAP)
            if floor > aim + 0.5:
                raise FitError("too long to fit: even at 6x (2x around taps) after cleanup", minimum_ms=floor)
            steps.append("speed ramp needed the 6x hard cap")
        work = _assemble(sub, plan)
        speeds = sorted({c.get("speed") for c in work if c.get("holdMs") is None})
        steps.append(f"speed ramp (idle fastest, typing slowest): {', '.join(f'{s:g}x' for s in speeds)}")
    return absorb(doc, [dict(c) for c in work], analyses, aim, steps, at_end)


def _uniform_slow(plan: List[Any], length: float, aim: float, images: set) -> None:
    fixed = sum(cl.clip_ms(c, c.get("sourceId") in images) for c in plan if isinstance(c, dict))
    moving = [s for item in plan if not isinstance(item, dict) for s in item]
    span_time = sum(s.span / s.base for s in moving)
    if span_time <= 0:
        return
    k = span_time / max(1.0, aim - fixed)
    for s in moving:
        s.speed = snap_speed(max(0.25, s.base * k))


def _partial_ops(doc: Dict[str, Any], pl: Any, aim: float) -> List[Dict[str, Any]]:
    """Cleanup overshoots: take its safest changes first and shrink the one that crosses the aim."""
    images = cl.image_ids(doc)
    order = sorted(pl.items, key=lambda it: (-it["confidence"], -it["savedMs"]))
    chosen: List[Dict[str, Any]] = []
    for it in order:
        op = next(o for o in pl.ops if o["sourceId"] == it["sourceId"] and o["fromMs"] == it["fromMs"] and o["toMs"] == it["toMs"])
        trial = chosen + [op]
        length = cl.total_ms(cl.simulate(doc, trial)["clips"], images)
        if length >= aim:
            chosen = trial
            continue
        over = aim - length
        if op["op"] == "cutSource":
            for shrunk in (dict(op, toMs=int(op["toMs"] - math.ceil(over))), dict(op, fromMs=int(op["fromMs"] + math.ceil(over)))):
                if shrunk["toMs"] - shrunk["fromMs"] >= cl.MIN_CLIP_SOURCE_MS and _no_slivers(doc, chosen + [shrunk]):
                    chosen.append(shrunk)
                    break
        break
    return chosen


def _no_slivers(doc: Dict[str, Any], ops: List[Dict[str, Any]]) -> bool:
    before = {(c.get("sourceId"), c["inMs"], c["outMs"]) for c in doc.get("clips") or []}
    for c in cl.simulate(doc, ops)["clips"]:
        if c.get("holdMs") is None and c["outMs"] - c["inMs"] < cl.MIN_CLIP_SOURCE_MS and (c.get("sourceId"), c["inMs"], c["outMs"]) not in before:
            return False
    return True


def fit(doc: Dict[str, Any], analyses: Dict[str, Dict[str, Any]], target_ms: float, *, strategy: str = "auto",
        anchors: Sequence[Tuple[str, float, float]] = ()) -> FitResult:
    """Fit the whole edit to target_ms (landing exactly frame_at(target) frames), with optional (sourceId, sourceMs, timelineMs) anchors."""
    images = cl.image_ids(doc)
    fps = cl.doc_fps(doc)
    clips = cl.relayout(doc.get("clips") or [], images)
    before = cl.total_ms(clips, images)
    steps: List[str] = []
    n = target_frames(target_ms, fps)
    if n < 1:
        raise FitError("the target is shorter than one frame", minimum_ms=1000.0 / fps)
    if not anchors:
        if cl.total_frames(clips, fps, images) == n and abs(before - aim_ms(n, fps)) <= 500.0 / fps:
            res = FitResult(clips, ["already lands on the target frame count"], fps, target_ms, before, images)
            return res
        out = fit_window(doc, clips, analyses, aim_ms(n, fps), strategy, steps, True, True)
        res = FitResult(out, steps, fps, target_ms, before, images)
        if not res.exact:
            raise FitError(f"could not land exactly {n} frames (got {res.frames}); try another --strategy")
        return res
    res = fit_anchored(doc, clips, analyses, n, anchors, strategy, steps)
    res.before_ms = before
    return res


def split_at_source(clips: List[Dict[str, Any]], source_id: str, source_ms: float, ids: List[str]) -> Tuple[List[Dict[str, Any]], int]:
    """Split the first clip showing source_ms there; returns (clips, index of the first clip after the split)."""
    for i, c in enumerate(clips):
        if c.get("sourceId") != source_id or c.get("holdMs") is not None or not c["inMs"] <= source_ms < c["outMs"]:
            continue
        x = int(round(source_ms))
        if x - c["inMs"] < cl.MIN_CLIP_SOURCE_MS:
            return clips, i
        if c["outMs"] - x < cl.MIN_CLIP_SOURCE_MS:
            return clips, i + 1
        right = dict(c, id=cl.next_id("c", ids), inMs=x)
        ids.append(right["id"])
        return clips[:i] + [dict(c, outMs=x), right] + clips[i + 1:], i + 1
    raise FitError(f"no clip shows {source_id} at {source_ms / 1000:.3f}s")


def anchor_time(clips: Sequence[Dict[str, Any]], source_id: str, source_ms: float) -> Optional[float]:
    occ = cl.occurrences(clips, source_id, source_ms)
    return cl.timeline_at(occ[0], source_ms) if occ else None


def fit_anchored(doc: Dict[str, Any], clips: List[Dict[str, Any]], analyses: Dict[str, Dict[str, Any]], n: int,
                 anchors: Sequence[Tuple[str, float, float]], strategy: str, steps: List[str],
                 keep_tail: bool = False) -> FitResult:
    """Piecewise: split at each anchor, fit each window so the anchor lands on its target, then the tail to the total."""
    images = cl.image_ids(doc)
    fps = cl.doc_fps(doc)
    ids = [c["id"] for c in clips]
    order = sorted(anchors, key=lambda a: a[2])
    for sid, ms, _ in order:
        clips, _ = split_at_source(cl.relayout(clips, images), sid, ms, ids)
    clips = cl.relayout(clips, images)
    bounds: List[int] = []
    for sid, ms, _ in order:
        k = next((i for i, c in enumerate(clips) if c.get("sourceId") == sid and c.get("holdMs") is None and abs(c["inMs"] - round(ms)) <= cl.MIN_CLIP_SOURCE_MS and c["inMs"] <= ms + cl.MIN_CLIP_SOURCE_MS), None)
        if k is None:
            raise FitError(f"could not find the anchor at {sid} {ms / 1000:.3f}s after splitting")
        bounds.append(k)
    guard = [(sid, ms - 1.0, ms + cl.TAP_DURATION_MS) for sid, ms, _ in order]
    out: List[Dict[str, Any]] = []
    prev_k, prev_t = 0, 0.0
    for (sid, ms, target), k in zip(order, bounds):
        window = clips[prev_k:k]
        head = clips[k]
        offset = (ms - head["inMs"]) / cl.eff_speed(head.get("speed"))
        aim = target - offset - prev_t
        if aim <= 0:
            raise FitError(f"the anchor at {ms / 1000:.3f}s cannot land at {target / 1000:.3f}s (it would need negative time before it)", minimum_ms=None)
        if not window:
            raise FitError(f"nothing comes before the anchor at {ms / 1000:.3f}s to stretch or shrink")
        out.extend(fit_window(doc, window, analyses, aim, strategy, steps, prev_k == 0, False, guard))
        prev_k, prev_t = k, target - offset
    tail = clips[prev_k:]
    total_aim = aim_ms(n, fps) - prev_t
    if keep_tail:
        out.extend(tail)
    else:
        if total_aim <= 0:
            raise FitError("the last anchor lands after the end of the target length")
        out.extend(fit_window(doc, tail, analyses, total_aim, strategy, steps, prev_k == 0, True, guard))
    final = cl.relayout(out, images)
    res = FitResult(final, steps, fps, n * 1000.0 / fps, cl.total_ms(clips, images), images)
    half = 500.0 / fps
    for sid, ms, target in order:
        t = anchor_time(final, sid, ms)
        landed = t is not None and abs(t - target) <= half
        res.anchors.append({"sourceId": sid, "sourceMs": ms, "targetMs": round(target, 1), "landedMs": round(t, 1) if t is not None else None, "ok": landed})
        if not landed:
            raise FitError(f"the anchor at {sid} {ms / 1000:.3f}s landed at {t if t is None else round(t / 1000, 3)}s, not {target / 1000:.3f}s")
    if not keep_tail and not res.exact:
        raise FitError(f"could not land exactly {n} frames (got {res.frames})")
    return res


# ── align ────────────────────────────────────────────────────────────────────


class AlignPlan:
    def __init__(self) -> None:
        self.side = "edit"
        self.start_ms: Optional[int] = None
        self.old_start_ms: Optional[int] = None
        self.fit: Optional[FitResult] = None
        self.moment_ms = 0.0
        self.target_ms = 0.0
        self.notes: List[str] = []

    def as_json(self) -> Dict[str, Any]:
        out = {"side": self.side, "momentTimelineMs": round(self.moment_ms, 1), "targetTimelineMs": round(self.target_ms, 1), "notes": self.notes}
        if self.side == "scene":
            out.update({"startMs": self.start_ms, "previousStartMs": self.old_start_ms})
        if self.fit:
            out["fit"] = self.fit.as_json()
        return out


def scene_shift(target_local: float, lead: float, moment_tl: float, slot: Optional[Dict[str, Any]]) -> Tuple[Optional[int], str]:
    """Ruling 9: the slot's startMs alone lands the moment when it stays in 0..1500 and the scene allows it."""
    if slot is None:
        return None, "no scene slot given"
    start = int(round(target_local - lead - moment_tl))
    if not 0 <= start <= SCENE_SHIFT_MAX_MS:
        return None, f"it would need startMs {start} (only 0 to {SCENE_SHIFT_MAX_MS} is allowed)"
    if slot.get("followsMedia") and start != int(slot.get("startMs") or 0):
        return None, "the scene follows this video's length, which ignores startMs and would hide its last frames"
    out_start = slot.get("transitionOutStartMs")
    if isinstance(out_start, (int, float)) and target_local > out_start:
        return None, "the target sits inside the outgoing transition"
    return start, ""


def align(doc: Dict[str, Any], analyses: Dict[str, Dict[str, Any]], source_id: str, source_ms: float, *, target_tl: Optional[float] = None,
          target_local: Optional[float] = None, slot: Optional[Dict[str, Any]] = None, lead: float = 0.0, prefer: str = "auto",
          keep_length: bool = False, strategy: str = "auto") -> AlignPlan:
    images = cl.image_ids(doc)
    fps = cl.doc_fps(doc)
    clips = cl.relayout(doc.get("clips") or [], images)
    moment = anchor_time(clips, source_id, source_ms)
    if moment is None:
        raise FitError(f"no clip shows source {source_id} at {source_ms / 1000:.3f}s (it was cut, or is inside a freeze)")
    plan = AlignPlan()
    plan.moment_ms = moment
    start_now = int((slot or {}).get("startMs") or 0)
    if target_local is not None:
        if prefer in ("auto", "scene"):
            start, why = scene_shift(target_local, lead, moment, slot)
            if start is not None:
                plan.side = "scene"
                plan.start_ms, plan.old_start_ms = start, start_now
                plan.target_ms = moment
                plan.notes.append(f"moved the video's start in the scene from {start_now} to {start} ms; the edit is unchanged")
                return plan
            if prefer == "scene":
                raise FitError(f"the scene side cannot land it: {why}")
            plan.notes.append(f"edit side, because {why}")
        target_tl = target_local - lead - start_now
    elif target_tl is not None:
        target_tl = target_tl - lead
    if target_tl is None:
        raise FitError("give a target: --at, --scene-at, --beat or --moment")
    plan.target_ms = target_tl
    if abs(moment - target_tl) <= 500.0 / fps:
        plan.notes.append("already lands within half a frame")
        plan.fit = FitResult(clips, [], fps, cl.total_ms(clips, images), cl.total_ms(clips, images), images)
        return plan
    total = cl.total_ms(clips, images)
    steps: List[str] = []
    if keep_length:
        n = cl.total_frames(clips, fps, images)
        plan.fit = fit_anchored(doc, clips, analyses, n, [(source_id, source_ms, target_tl)], strategy, steps)
    else:
        n = target_frames(total + (target_tl - moment), fps)
        plan.fit = fit_anchored(doc, clips, analyses, n, [(source_id, source_ms, target_tl)], strategy, steps, keep_tail=True)
    plan.fit.before_ms = total
    return plan


# ── beats ────────────────────────────────────────────────────────────────────


def _beats_module() -> Any:
    path = Path(__file__).resolve().parents[2] / "beats.py"
    spec = importlib.util.spec_from_file_location("kb_beats", str(path))
    if spec is None or spec.loader is None:
        raise FitError("beats.py is missing from the kit")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def scene_beats(root: Path, scene_index: int, load_json: Callable[[Path], Any], cache_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Scene-local grid beats and key moments, exactly as kb beats --json reports them."""
    import hashlib

    beats = _beats_module()
    manifest = load_json(root / "project.json")
    audio = manifest.get("audio") or {}
    if not audio.get("file"):
        raise FitError("this project has no soundtrack, so it has no beats")
    audio_path = root / audio["file"]
    if not audio_path.is_file():
        raise FitError(f"the soundtrack {audio['file']} is missing")
    digest = hashlib.sha256(audio_path.read_bytes()).hexdigest()
    cache = (cache_dir or beats.CACHE_DIR) / f"{digest}.json"
    if not cache.is_file():
        raise FitError("no beat analysis yet: ask the user to open the project in Kookaburra Cut once, then rerun")
    analysis = load_json(cache)
    slots = beats.build_slots(manifest.get("scenes", []))
    if not 0 <= scene_index < len(slots):
        raise FitError(f"scene {scene_index} is out of range")
    total = slots[-1]["endMs"] if slots else 0
    offset = audio.get("startOffsetMs", 0) or 0
    grid = [t - offset for t in analysis.get("beats", []) if 0 <= t - offset <= total]
    moments, _ = beats.effective_key_moments(analysis, audio.get("markers"), offset, total)
    s = slots[scene_index]
    return {
        "beats": [t - s["startMs"] for t in grid if s["startMs"] <= t <= s["endMs"]],
        "moments": [m["tMs"] - s["startMs"] for m in moments if s["startMs"] <= m["tMs"] <= s["endMs"]],
        "windowStartMs": s["windowStartMs"], "windowEndMs": s["windowEndMs"], "transitionOutStartMs": s["transitionOutStartMs"],
        "durationMs": s["durationMs"],
    }


def pick_beat(info: Dict[str, Any], kind: str, n: int) -> float:
    items = info["beats"] if kind == "beat" else info["moments"]
    if not 1 <= n <= len(items):
        raise FitError(f"this scene has {len(items)} {'grid beats' if kind == 'beat' else 'key moments'}; pick 1 to {len(items)}")
    return float(items[n - 1])

