"""The footage log, pure: held states, visible changes, scrolls and their speed, money frames, notes aligned to the
recording, and two takes paired by their held states. Input is passes.profile_pass: full-rate gray small frames, row
profiles and each frame's pts. Times are source ms; a frame shows from its pts until the next frame's."""

from __future__ import annotations

import bisect
import json
import math
import operator
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

LOG_VERSION = 1
HOLD_MAD = 0.25
CHANGE_MAD = 0.8
HOLD_MIN_MS = 250.0
CHANGE_GAP_MS = 40.0
PIXEL_DELTA = 12
STRONG_DELTA = 24
SCROLL_MAX_SHIFT = 40
SCROLL_MIN_FRAMES = 6
SCROLL_MIN_HEIGHT = 0.25
SCROLL_ACCEPT = 0.5
SCROLL_TAIL_ROWS = 0.1
SCROLL_GAP_MS = 250.0
BLINK_MAX_AREA = 0.005
BLINK_NEAR = 0.02
BLINK_GAP_MS = (300.0, 1700.0)
BLINK_MAX_CV = 0.35
BLINK_MIN_EVENTS = 3
VELOCITY_BIN_MS = 50.0
VELOCITY_MAX_BINS = 40
MONEY_SETTLE_MS = 500.0
MONEY_TYPING_HOLD_MS = 1000.0
NOTE_BEFORE_MS = 250.0
NOTE_AFTER_MS = 4000.0
NOTE_NEAR_MS = 1500.0
SIG_SIZE = (18, 40)
SIG_KEEP = 0.9
PAIR_GAP = 6.0
PAIR_MAX_COST = 6.0
QUIET_KINDS = ("blink", "loading", "black")


def round_ms(x: float) -> int:
    """Half up, the kit's ms rule (Python's round is half-even)."""
    return int(math.floor(float(x) + 0.5))


# ── frames ───────────────────────────────────────────────────────────────────


class Frames:
    """One recording's decoded frames: gray small frames (sw x sh), row profiles (pw x ph), pts and the display size."""

    def __init__(self, small: bytes, sw: int, sh: int, rows: bytes, pw: int, ph: int, pts: Sequence[float], end_ms: float,
                 width: int, height: int) -> None:
        self.sw, self.sh, self.pw, self.ph = sw, sh, pw, ph
        self.n = min(len(pts), len(small) // (sw * sh), len(rows) // (pw * ph) if pw * ph else 0)
        self._small, self._rows = small, rows
        self.pts = [0.0] + [float(p) for p in pts[1:self.n]] if self.n else []
        self.end_ms = max(float(end_ms), self.pts[-1] if self.pts else 0.0)
        self.width, self.height = int(width), int(height)
        self.step = nominal_step(self.pts)

    @classmethod
    def from_profile(cls, prof: Dict[str, Any]) -> "Frames":
        info = prof.get("info") or {}
        sw, sh = prof["small"]
        pw, ph = prof["rows"]
        return cls(prof["smallData"], sw, sh, prof["rowData"], pw, ph, prof["ptsMs"], prof.get("endMs") or 0.0,
                   int(info.get("width") or sw), int(info.get("height") or sh))

    def small(self, i: int) -> bytes:
        size = self.sw * self.sh
        return self._small[i * size:(i + 1) * size]

    def rows(self, i: int) -> bytes:
        size = self.pw * self.ph
        return self._rows[i * size:(i + 1) * size]

    def start(self, i: int) -> float:
        return self.pts[i] if i < self.n else self.end_ms

    def slot_end(self, i: int) -> float:
        """Where frame i's own slot ends: the next frame, but never past one nominal frame (a variable-rate hold)."""
        return min(self.start(i + 1), self.pts[i] + self.step)

    def at(self, ms: float) -> int:
        """The frame on screen at ms."""
        return max(0, min(self.n - 1, bisect.bisect_right(self.pts, ms + 1e-6) - 1))


def nominal_step(pts: Sequence[float]) -> float:
    """One frame's length: the lower quartile of the gaps between frames (exact for constant rate), 4 to 100 ms."""
    gaps = sorted(b - a for a, b in zip(pts, pts[1:]) if b - a > 1e-6)
    if not gaps:
        return 1000.0 / 60
    return min(100.0, max(4.0, gaps[(len(gaps) - 1) // 4]))


def mad(a: bytes, b: bytes) -> float:
    """Mean absolute difference, 0-255."""
    if a == b:
        return 0.0
    return sum(map(abs, map(operator.sub, a, b))) / float(len(a) or 1)


def strong_pixels(a: bytes, b: bytes, w: int, h: int, delta: int = STRONG_DELTA) -> int:
    """How many small-frame pixels moved by delta or more (a cursor, a keystroke or a tap ring the frame mean misses)."""
    n = 0
    for r in range(h):
        ra, rb = a[r * w:(r + 1) * w], b[r * w:(r + 1) * w]
        if ra != rb:
            n += sum(1 for x, y in zip(ra, rb) if x - y >= delta or y - x >= delta)
    return n


class Motion:
    """Each frame against the one before: the mean difference, whether it repeats the picture (held) and whether the change
    shows (visible: CHANGE_MAD overall, or a pixel moving STRONG_DELTA). A frame that drifted visibly from the picture's first
    frame (a slow fade) is a visible change too. Frame 0 is held."""

    def __init__(self, fr: Frames) -> None:
        n = fr.n
        self.diffs = [0.0] * n
        self.held = [True] * n
        self.visible = [False] * n
        prev = anchor = fr.small(0) if n else b""
        for i in range(1, n):
            cur = fr.small(i)
            if cur != prev:
                d = mad(prev, cur)
                local = d < CHANGE_MAD and strong_pixels(prev, cur, fr.sw, fr.sh) > 0
                held = d < HOLD_MAD and not local
                drift = held and (mad(anchor, cur) >= CHANGE_MAD or strong_pixels(anchor, cur, fr.sw, fr.sh) > 0)
                self.diffs[i] = d
                self.held[i] = held and not drift
                self.visible[i] = d >= CHANGE_MAD or local or drift
                if not self.held[i]:
                    anchor = cur
            prev = cur


def diff_box(a: bytes, b: bytes, w: int, h: int, delta: int = PIXEL_DELTA) -> Optional[Tuple[int, int, int, int]]:
    """Inclusive (x0, y0, x1, y1) of the small-frame pixels that moved by delta or more, or None."""
    x0 = y0 = None
    x1 = y1 = -1
    for r in range(h):
        ra, rb = a[r * w:(r + 1) * w], b[r * w:(r + 1) * w]
        if ra == rb:
            continue
        cols = [c for c in range(w) if abs(ra[c] - rb[c]) >= delta]
        if not cols:
            continue
        y0 = r if y0 is None else y0
        y1 = r
        x0 = cols[0] if x0 is None else min(x0, cols[0])
        x1 = max(x1, cols[-1])
    if x0 is None or y0 is None:
        return None
    return (x0, y0, x1, y1)


def union_box(boxes: Sequence[Optional[Tuple[int, int, int, int]]]) -> Optional[Tuple[int, int, int, int]]:
    got = [b for b in boxes if b is not None]
    if not got:
        return None
    return (min(b[0] for b in got), min(b[1] for b in got), max(b[2] for b in got), max(b[3] for b in got))


def norm_box(box: Optional[Tuple[int, int, int, int]], w: int, h: int) -> List[float]:
    """[x, y, w, h] as fractions of the frame; the whole frame when nothing crossed the pixel threshold."""
    if box is None:
        return [0.0, 0.0, 1.0, 1.0]
    x0, y0, x1, y1 = box
    return [round(x0 / w, 3), round(y0 / h, 3), round((x1 - x0 + 1) / w, 3), round((y1 - y0 + 1) / h, 3)]


# ── holds and changes ────────────────────────────────────────────────────────


def segments(fr: Frames, mo: Motion) -> List[Tuple[int, int]]:
    """Runs of frames showing one picture, as (first, end) frame indices (end exclusive): each frame that is not held starts one."""
    if not fr.n:
        return []
    starts = [0] + [i for i in range(1, fr.n) if not mo.held[i]]
    return list(zip(starts, starts[1:] + [fr.n]))


def holds_of(fr: Frames, segs: Sequence[Tuple[int, int]]) -> List[Dict[str, Any]]:
    """Pictures on screen for HOLD_MIN_MS or more: from the moment the picture first shows until the next one."""
    out = []
    for a, b in segs:
        s, e = fr.start(a), fr.start(b)
        if e - s + 1e-6 >= HOLD_MIN_MS:
            out.append({"first": a, "end": b, "startMs": s, "endMs": e})
    for n, h in enumerate(out, 1):
        h["id"] = f"h{n}"
    return out


def change_runs(fr: Frames, mo: Motion) -> List[Tuple[int, int]]:
    """(first, last) frames of each change: frames that are not held, runs closer than CHANGE_GAP_MS merged (a repeated frame
    mid-motion), kept when one of their frames is visible (so a scroll over flat content stays one change)."""
    runs: List[List[int]] = []
    for i in range(1, fr.n):
        if mo.held[i]:
            continue
        if runs and fr.start(i) - fr.slot_end(runs[-1][1]) <= CHANGE_GAP_MS:
            runs[-1][1] = i
        else:
            runs.append([i, i])
    return [(a, b) for a, b in runs if any(mo.visible[a:b + 1])]


# ── scrolls ──────────────────────────────────────────────────────────────────


def row_means(profile: bytes, pw: int, ph: int) -> List[int]:
    """Per row, the sum of the middle columns (the edges carry scroll bars and rounded corners)."""
    lo, hi = (1, pw - 1) if pw > 2 else (0, pw)
    return [sum(profile[r * pw + lo:r * pw + hi]) for r in range(ph)]


def best_shift(a: Sequence[int], b: Sequence[int], lo: int = 0, hi: Optional[int] = None,
               max_shift: int = SCROLL_MAX_SHIFT) -> Tuple[float, float, float]:
    """The row shift s (content at row r of a sits at row r - s of b; positive moves up) within rows lo..hi, refined to a
    fraction of a row; returns (shift, error at that shift, error unshifted)."""
    hi = len(a) if hi is None else hi
    span = hi - lo
    need = max(16, span // 2)
    errs: Dict[int, float] = {}
    for s in range(-max_shift, max_shift + 1):
        r0, r1 = lo + max(0, s), hi + min(0, s)
        n = r1 - r0
        if n < need:
            continue
        errs[s] = sum(map(abs, map(operator.sub, a[r0:r1], b[r0 - s:r1 - s]))) / n
    if not errs:
        return 0.0, 0.0, 0.0
    best = min(errs, key=lambda s: (errs[s], abs(s)))
    zero = errs.get(0, 0.0)
    shift = float(best)
    if best - 1 in errs and best + 1 in errs:
        e0, e1, e2 = errs[best - 1], errs[best], errs[best + 1]
        # Equal-slope (V) fit: a sum of absolute differences rises linearly either side of its minimum.
        rise = max(e0, e2) - e1
        if rise > 0:
            shift += 0.5 * (e0 - e2) / rise
    return shift, errs[best], zero


def scrolls_of(fr: Frames, mo: Motion, runs: Sequence[Tuple[int, int]],
               boxes: Dict[int, Optional[Tuple[int, int, int, int]]]) -> List[Dict[str, Any]]:
    """Inside each change tall enough to scroll, consecutive frames whose rows moved by one shared offset (SCROLL_MIN_FRAMES
    or more, one direction). Speeds are source pixels of the display height."""
    px_per_row = fr.height / float(fr.ph)
    spans: List[List[Tuple[int, float, float]]] = []
    cache: Dict[int, List[int]] = {}

    def means(i: int) -> List[int]:
        if i not in cache:
            cache[i] = row_means(fr.rows(i), fr.pw, fr.ph)
        return cache[i]

    for a, b in runs:
        box = union_box([boxes.get(i) for i in range(a, b + 1)])
        if box is None or (box[3] - box[1] + 1) / float(fr.sh) < SCROLL_MIN_HEIGHT:
            continue
        lo = int(math.floor(box[1] / float(fr.sh) * fr.ph))
        hi = int(math.ceil((box[3] + 1) / float(fr.sh) * fr.ph))
        found: List[Tuple[int, float, float, bool]] = []
        prev = a - 1
        for i in range(a, b + 1):
            if mo.held[i]:
                continue
            s, err, zero = best_shift(means(prev), means(i), lo, hi)
            found.append((i, s, fr.start(i) - fr.start(prev), abs(s) >= 0.5 and zero > 0 and err < SCROLL_ACCEPT * zero))
            prev = i
        for lo_k, hi_k in _scroll_spans(found):
            spans.append([(i, s, dt) for i, s, dt, _strict in found[lo_k:hi_k]])
    merged: List[List[Tuple[int, float, float]]] = []
    for samples in spans:
        last = merged[-1] if merged else None
        # One gesture split by a still-looking stretch: a jump after it means repeated frames (the gap counts), else unmeasured motion.
        if last and (samples[0][1] > 0) == (last[0][1] > 0) and fr.start(samples[0][0]) - fr.slot_end(last[-1][0]) <= SCROLL_GAP_MS:
            i, s, dt = samples[0]
            typical = median([abs(x) for _j, x, _d in last[-5:]]) or 0.0
            last.append((i, s, fr.start(i) - fr.start(last[-1][0]) if abs(s) > 1.5 * typical else dt))
            last.extend(samples[1:])
        else:
            merged.append(list(samples))
    out = [_scroll(fr, samples, px_per_row, boxes) for samples in merged if len(samples) >= SCROLL_MIN_FRAMES]
    for n, sc in enumerate(out, 1):
        sc["id"] = f"sc{n}"
    return out


def _scroll_spans(found: Sequence[Tuple[int, float, float, bool]]) -> List[Tuple[int, int]]:
    """Runs of clear shifts in one direction, each grown over its slower neighbours (a fling's start and tail, under half a row
    a frame) that lean the same way: (lo, hi) indices into found."""
    spans: List[Tuple[int, int]] = []
    k, n = 0, len(found)
    while k < n:
        if not found[k][3]:
            k += 1
            continue
        up = found[k][1] > 0
        j = k
        while j < n and found[j][3] and (found[j][1] > 0) == up:
            j += 1
        lo, hi = k, j
        floor = spans[-1][1] if spans else 0
        while lo > floor and abs(found[lo - 1][1]) >= SCROLL_TAIL_ROWS and (found[lo - 1][1] > 0) == up:
            lo -= 1
        while hi < n and abs(found[hi][1]) >= SCROLL_TAIL_ROWS and (found[hi][1] > 0) == up:
            hi += 1
        spans.append((lo, hi))
        k = hi
    return spans


def _scroll(fr: Frames, samples: Sequence[Tuple[int, float, float]], px_per_row: float,
            boxes: Dict[int, Optional[Tuple[int, int, int, int]]]) -> Dict[str, Any]:
    first, last = samples[0][0], samples[-1][0]
    total_px = sum(s for _i, s, _dt in samples) * px_per_row
    total_ms = sum(dt for _i, _s, dt in samples)
    start = fr.start(first)
    width = VELOCITY_BIN_MS * max(1, math.ceil((fr.start(last) - start) / (VELOCITY_BIN_MS * VELOCITY_MAX_BINS)))
    bins: Dict[int, List[float]] = {}
    for i, s, dt in samples:
        k = int((fr.start(i) - start) // width)
        acc = bins.setdefault(k, [0.0, 0.0])
        acc[0] += s * px_per_row
        acc[1] += dt
    velocity = [[round_ms(start + (k + 0.5) * width), round_ms(abs(px) / dt * 1000.0) if dt > 0 else 0]
                for k, (px, dt) in sorted(bins.items())]
    speed = abs(total_px) / total_ms * 1000.0 if total_ms > 0 else 0.0
    return {
        "startMs": start, "endMs": fr.slot_end(last), "first": first, "last": last,
        "direction": "up" if total_px > 0 else "down",
        "pxPerS": round_ms(speed),
        "pxPerFrame": round(speed * fr.step / 1000.0, 1),
        "region": norm_box(union_box([boxes.get(i) for i, _s, _dt in samples]), fr.sw, fr.sh),
        "velocity": velocity,
    }


# ── classification and money frames ─────────────────────────────────────────


def context_from(analysis: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The spans and events of detect.analyse that name a change's kind."""
    ctx: Dict[str, Any] = {"black": [], "blink": [], "loading": [], "typing": [], "screens": [], "fromBlack": [], "taps": []}
    if not analysis:
        return ctx
    for iv in analysis.get("intervals") or []:
        span = [float(iv.get("exactStartMs", iv["startMs"])), float(iv.get("exactEndMs", iv["endMs"]))]
        if iv.get("kind") == "black":
            ctx["black"].append(span)
        elif iv.get("sub") in ("blink", "loading", "typing"):
            ctx[iv["sub"]].append(span)
    for c in analysis.get("screenChanges") or []:
        ctx["fromBlack" if c.get("fromBlack") else "screens"].append(float(c["tMs"]))
    ctx["taps"] = [float(k["tMs"]) for k in analysis.get("tapCandidates") or []]
    return ctx


def _inside(t: float, spans: Sequence[Sequence[float]], pad: float = 0.0) -> bool:
    return any(a - pad <= t < b + pad for a, b in spans)


def classify(change: Dict[str, Any], scrolls: Sequence[Dict[str, Any]], ctx: Dict[str, Any], step: float) -> str:
    """scroll, black (into or out of black), blink, loading, typing, tap, screen (a cut to a new screen) or motion."""
    s, e = change["startMs"], change["endMs"]
    if any(sc["startMs"] < e and s < sc["endMs"] for sc in scrolls):
        return "scroll"
    if _inside(s, ctx["black"], pad=step + 1) or any(abs(t - s) <= 50 for t in ctx["fromBlack"]):
        return "black"
    for kind in ("blink", "loading", "typing"):
        if _inside(s, ctx[kind], pad=1.0):
            return kind
    if any(s - 50 <= t <= e + 50 for t in ctx["taps"]):
        return "tap"
    _x, _y, w, h = change["box"]
    if any(s - 120 <= t <= e + 20 for t in ctx["screens"]) or (w * h >= 0.5 and e - s <= 3 * step + 1):
        return "screen"
    return "motion"


def changes_of(fr: Frames, mo: Motion, runs: Sequence[Tuple[int, int]], boxes: Dict[int, Optional[Tuple[int, int, int, int]]],
               scrolls: Sequence[Dict[str, Any]], ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    out = []
    for n, (a, b) in enumerate(runs, 1):
        ch = {"id": f"ch{n}", "first": a, "last": b, "startMs": fr.start(a), "endMs": fr.slot_end(b),
              "peak": round(max(mo.diffs[a:b + 1]), 1), "box": norm_box(union_box([boxes.get(i) for i in range(a, b + 1)]), fr.sw, fr.sh)}
        ch["kind"] = classify(ch, scrolls, ctx, fr.step)
        out.append(ch)
    mark_blinks(out)
    return out


def _centre(change: Dict[str, Any]) -> Tuple[float, float]:
    x, y, w, h = change["box"]
    return x + w / 2.0, y + h / 2.0


def mark_blinks(changes: List[Dict[str, Any]]) -> None:
    """A small spot changing in one place on a steady beat (a text cursor) is a blink, even where detect saw none."""
    def spot(c: Dict[str, Any]) -> bool:
        return c["kind"] == "motion" and c["box"][2] * c["box"][3] <= BLINK_MAX_AREA

    i = 0
    while i < len(changes):
        if not spot(changes[i]):
            i += 1
            continue
        cx, cy = _centre(changes[i])
        members = [changes[i]]
        j = i + 1
        while j < len(changes):
            c = changes[j]
            gap = c["startMs"] - members[-1]["startMs"]
            nx, ny = _centre(c)
            if not spot(c) or abs(nx - cx) > BLINK_NEAR or abs(ny - cy) > BLINK_NEAR or not BLINK_GAP_MS[0] <= gap <= BLINK_GAP_MS[1]:
                break
            members.append(c)
            j += 1
        gaps = [b["startMs"] - a["startMs"] for a, b in zip(members, members[1:])]
        mean = sum(gaps) / len(gaps) if gaps else 0.0
        spread = math.sqrt(sum((g - mean) ** 2 for g in gaps) / len(gaps)) / mean if mean > 0 else 1.0
        if len(members) >= BLINK_MIN_EVENTS and spread <= BLINK_MAX_CV:
            for c in members:
                c["kind"] = "blink"
            i = j
        else:
            i += 1


def money_frames(fr: Frames, holds: Sequence[Dict[str, Any]], changes: Sequence[Dict[str, Any]], ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Per hold after a change: the hold's start plus min(half the hold, MONEY_SETTLE_MS). Skips holds led in by a blink,
    loading or black, short holds between keystrokes, and moments inside black or loading."""
    out = []
    firsts = [ch["first"] for ch in changes]
    for h in holds:
        k = h["first"]
        if k == 0:
            continue
        j = bisect.bisect_right(firsts, k) - 1
        lead = changes[j] if j >= 0 and changes[j]["endMs"] >= fr.start(k) - 100 else None
        if lead is None or lead["kind"] in QUIET_KINDS:
            continue
        length = h["endMs"] - h["startMs"]
        if lead["kind"] == "typing" and length < MONEY_TYPING_HOLD_MS:
            continue
        at = settle_ms(h)
        if _inside(at, ctx["black"]) or _inside(at, ctx["loading"]):
            continue
        area = lead["box"][2] * lead["box"][3]
        score = 0.6 * min(1.0, length / 2000.0) + 0.4 * min(1.0, area / 0.5)
        out.append({"atMs": at, "frame": fr.at(at), "hold": h["id"], "change": lead["id"], "kind": lead["kind"], "score": round(score, 2)})
    for n, m in enumerate(out, 1):
        m["id"] = f"mf{n}"
    return out


def settle_ms(state: Dict[str, Any]) -> float:
    """The moment a held picture has settled: its start plus min(half its length, MONEY_SETTLE_MS)."""
    return state["startMs"] + min((state["endMs"] - state["startMs"]) / 2.0, MONEY_SETTLE_MS)


def best_money(items: Sequence[Dict[str, Any]], count: Optional[int]) -> List[Dict[str, Any]]:
    """The count highest scores (earlier wins a tie), back in time order."""
    if count is None or count >= len(items):
        return list(items)
    keep = sorted(items, key=lambda m: (-m["score"], m["atMs"]))[:max(0, count)]
    return sorted(keep, key=lambda m: m["atMs"])


# ── the log ──────────────────────────────────────────────────────────────────


def analyse(fr: Frames, analysis: Optional[Dict[str, Any]] = None, scroll: bool = True) -> Dict[str, Any]:
    """Holds, changes, scrolls and money frames of one recording (detect.analyse's result names the kinds)."""
    ctx = context_from(analysis)
    mo = Motion(fr)
    holds = holds_of(fr, segments(fr, mo))
    runs = change_runs(fr, mo)
    boxes: Dict[int, Optional[Tuple[int, int, int, int]]] = {}
    for a, b in runs:
        for i in range(a, b + 1):
            if not mo.held[i]:
                boxes[i] = diff_box(fr.small(i - 1), fr.small(i), fr.sw, fr.sh)
    scrolls = scrolls_of(fr, mo, runs, boxes) if scroll else []
    changes = changes_of(fr, mo, runs, boxes, scrolls, ctx)
    money = money_frames(fr, holds, changes, ctx)
    return {"holds": holds, "changes": changes, "scrolls": scrolls, "moneyFrames": money}


def overlaps(item: Dict[str, Any], rng: Optional[Tuple[float, float]]) -> bool:
    if rng is None:
        return True
    a, b = rng
    s, e = item.get("startMs", item.get("atMs")), item.get("endMs", item.get("atMs"))
    return s < b and e > a if e > s else a <= s < b


def public(item: Dict[str, Any], keys: Sequence[str]) -> Dict[str, Any]:
    """The JSON shape: integer ms, internal frame bookkeeping dropped."""
    out = {}
    for k in keys:
        v = item.get(k)
        out[k] = round_ms(v) if k.endswith("Ms") and isinstance(v, float) else v
    return out


HOLD_KEYS = ("id", "startMs", "endMs", "frames", "frame")
CHANGE_KEYS = ("id", "startMs", "endMs", "peak", "box", "kind")
SCROLL_KEYS = ("id", "startMs", "endMs", "direction", "pxPerS", "pxPerFrame", "region", "velocity")
MONEY_KEYS = ("id", "atMs", "frame", "hold", "change", "kind", "score")


def report(result: Dict[str, Any], rng: Optional[Tuple[float, float]] = None, money: Optional[int] = None) -> Dict[str, Any]:
    """analyse()'s result as the log's JSON lists, inside rng when given, money frames cut to the best `money`."""
    holds = [dict(h, frames=h["end"] - h["first"], frame=h["first"]) for h in result["holds"] if overlaps(h, rng)]
    return {
        "holds": [public(h, HOLD_KEYS) for h in holds],
        "changes": [public(c, CHANGE_KEYS) for c in result["changes"] if overlaps(c, rng)],
        "scrolls": [public(s, SCROLL_KEYS) for s in result["scrolls"] if overlaps(s, rng)],
        "moneyFrames": [public(m, MONEY_KEYS) for m in best_money([m for m in result["moneyFrames"] if overlaps(m, rng)], money)],
    }


# ── notes ────────────────────────────────────────────────────────────────────


_NOTE_RE = re.compile(r"^(?:[-*+\u2022]\s*|\d+[.)]\s+)?\[?(?:(\d+):)?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds)?\]?(?=[\s\-:|)\]\u2013\u2014]|$)\s*[-:|)\]\u2013\u2014]*\s*(.*)$")
_TIME_RE = re.compile(r"^(?:(\d+):)?(\d+(?:\.\d+)?)\s*s?$")


class NotesError(ValueError):
    pass


def note_time(value: Any) -> float:
    """Seconds as a number, or (m:)ss(.s)[s] text, to ms."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(float(value)) or value < 0:
            raise NotesError(f"{value} is not a time")
        return float(value) * 1000.0
    m = _TIME_RE.match(str(value).strip())
    if not m:
        raise NotesError(f'"{value}" is not a time: use 12.5, 12.5s or 1:02.5')
    return ((int(m.group(1)) * 60 if m.group(1) else 0) + float(m.group(2))) * 1000.0


def parse_notes(text: str) -> Tuple[List[Dict[str, Any]], List[int]]:
    """Notes as [{ line, label, noteMs }] in time order, plus the lines that held no time. Plain lines or markdown bullets
    "- 1:02.5 label" (# lines are comments), or JSON { notes: [{ t, label }] }."""
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            data = json.loads(stripped)
        except ValueError as e:
            raise NotesError(f"notes JSON does not parse: {e}") from None
        items = data.get("notes") if isinstance(data, dict) else data
        if not isinstance(items, list):
            raise NotesError('notes JSON needs { "notes": [{ "t": 12.5, "label": "..." }] }')
        out = []
        for n, item in enumerate(items, 1):
            if not isinstance(item, dict) or "t" not in item:
                raise NotesError(f"note {n} needs a t (seconds)")
            out.append({"line": n, "label": str(item.get("label") or "").strip(), "noteMs": note_time(item["t"])})
        return sorted(out, key=lambda x: (x["noteMs"], x["line"])), []
    out, skipped = [], []
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("<!--"):
            continue
        m = _NOTE_RE.match(line)
        if not m:
            skipped.append(n)
            continue
        ms = ((int(m.group(1)) * 60 if m.group(1) else 0) + float(m.group(2))) * 1000.0
        out.append({"line": n, "label": m.group(4).strip(), "noteMs": ms})
    return sorted(out, key=lambda x: (x["noteMs"], x["line"])), skipped


def median(values: Sequence[float]) -> Optional[float]:
    s = sorted(values)
    if not s:
        return None
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2.0


def align_notes(notes: Sequence[Dict[str, Any]], changes: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Each note to the change it describes. First the first change in [note - 0.25 s, note + 4 s]; then, around the median
    offset of those, the nearest change within 1.5 s, keeping the notes' order. Blinks, loading and black never match."""
    cands = sorted((c for c in changes if c.get("kind") not in QUIET_KINDS), key=lambda c: c["startMs"])
    starts = [c["startMs"] for c in cands]
    first: List[Optional[Dict[str, Any]]] = []
    for note in notes:
        t = note["noteMs"]
        j = bisect.bisect_left(starts, t - NOTE_BEFORE_MS - 1e-6)
        first.append(cands[j] if j < len(cands) and cands[j]["startMs"] <= t + NOTE_AFTER_MS + 1e-6 else None)
    offset = median([c["startMs"] - n["noteMs"] for n, c in zip(notes, first) if c is not None])
    items = []
    floor = -math.inf
    for note, guess in zip(notes, first):
        t = note["noteMs"]
        pick: Optional[Dict[str, Any]] = None
        conf = 0.0
        if offset is not None:
            want = t + offset
            near = [c for c in cands if abs(c["startMs"] - want) <= NOTE_NEAR_MS and c["startMs"] > floor]
            if near:
                pick = min(near, key=lambda c: (abs(c["startMs"] - want), c["startMs"]))
                conf = max(0.05, 1.0 - abs(pick["startMs"] - want) / NOTE_NEAR_MS)
            elif guess is not None and guess["startMs"] > floor:
                pick, conf = guess, 0.3
        if pick is not None:
            floor = pick["startMs"]
        items.append({"line": note["line"], "label": note["label"], "noteMs": round_ms(t),
                      "changeMs": round_ms(pick["startMs"]) if pick else None, "change": pick["id"] if pick else None,
                      "offsetMs": round_ms(pick["startMs"] - t) if pick else None, "confidence": round(conf, 2)})
    return {"medianOffsetMs": round_ms(offset) if offset is not None else None, "items": items}


# ── pairing ──────────────────────────────────────────────────────────────────


def _weights(src: int, dst: int) -> List[List[Tuple[int, float]]]:
    """Area weights mapping src cells onto dst cells."""
    k = src / float(dst)
    out = []
    for j in range(dst):
        a, b = j * k, (j + 1) * k
        cells = []
        i = int(math.floor(a))
        while i < src and i < b:
            w = min(b, i + 1) - max(a, i)
            if w > 1e-9:
                cells.append((i, w))
            i += 1
        out.append(cells)
    return out


def signature(frame: bytes, w: int, h: int, size: Optional[Tuple[int, int]] = None) -> List[float]:
    """The frame area-averaged to 18 x 40 (40 x 18 when landscape), its median removed so a brightness change, or a bar
    painted over part of one take, does not shift the rest."""
    tw, th = size or (SIG_SIZE if h >= w else (SIG_SIZE[1], SIG_SIZE[0]))
    wx, wy = _weights(w, tw), _weights(h, th)
    area = (w / float(tw)) * (h / float(th))
    out = []
    for cells_y in wy:
        line = [0.0] * w
        for y, fy in cells_y:
            row = frame[y * w:(y + 1) * w]
            for x in range(w):
                line[x] += row[x] * fy
        for cells_x in wx:
            out.append(sum(line[x] * fx for x, fx in cells_x) / area)
    centre = median(out) or 0.0
    return [round(v - centre, 2) for v in out]


def sig_cost(a: Sequence[float], b: Sequence[float]) -> float:
    """Mean absolute difference over the closest SIG_KEEP of the cells: what one take adds over a few cells is not counted."""
    if not a or len(a) != len(b):
        return math.inf
    d = sorted(map(abs, map(operator.sub, a, b)))
    keep = max(1, int(len(d) * SIG_KEEP))
    return sum(d[:keep]) / keep


def states_of(fr: Frames, holds: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Each hold as a state to pair: its span, whether it touches either end of the clip, and its signature."""
    out = []
    for h in holds:
        mid = h["first"] + (h["end"] - h["first"]) // 2
        out.append({"id": h["id"], "startMs": h["startMs"], "endMs": h["endMs"], "atStart": h["first"] == 0, "atEnd": h["end"] >= fr.n,
                    "sig": signature(fr.small(mid), fr.sw, fr.sh)})
    return out


def align_states(a: Sequence[Dict[str, Any]], b: Sequence[Dict[str, Any]]) -> List[Tuple[int, int, float]]:
    """Monotone alignment (a skipped state costs PAIR_GAP; a match above PAIR_MAX_COST is barred): [(i, j, cost)]."""
    n, m = len(a), len(b)
    cost = [[sig_cost(x["sig"], y["sig"]) if len(x["sig"]) == len(y["sig"]) else math.inf for y in b] for x in a]
    big = math.inf
    d = [[0.0] * (m + 1) for _ in range(n + 1)]
    back = [[""] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        d[i][0], back[i][0] = i * PAIR_GAP, "a"
    for j in range(1, m + 1):
        d[0][j], back[0][j] = j * PAIR_GAP, "b"
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            c = cost[i - 1][j - 1]
            options = [(d[i - 1][j - 1] + c if c <= PAIR_MAX_COST else big, "m"), (d[i - 1][j] + PAIR_GAP, "a"), (d[i][j - 1] + PAIR_GAP, "b")]
            d[i][j], back[i][j] = min(options, key=lambda o: (o[0], "mab".index(o[1])))
    pairs = []
    i, j = n, m
    while i > 0 or j > 0:
        step = back[i][j]
        if step == "m":
            pairs.append((i - 1, j - 1, cost[i - 1][j - 1]))
            i, j = i - 1, j - 1
        elif step == "a":
            i -= 1
        else:
            j -= 1
    pairs.reverse()
    return pairs


def drift_fit(points: Sequence[Tuple[float, float]]) -> Optional[float]:
    """Least-squares slope of offset ms against A's seconds, after dropping points far off the median."""
    if len(points) < 2:
        return 0.0 if points else None
    mid = median([o for _t, o in points]) or 0.0
    spread = median([abs(o - mid) for _t, o in points]) or 0.0
    keep = [(t, o) for t, o in points if abs(o - mid) <= max(50.0, 3 * spread)]
    if len(keep) < 2:
        return 0.0
    mt = sum(t for t, _o in keep) / len(keep)
    mo = sum(o for _t, o in keep) / len(keep)
    var = sum((t - mt) ** 2 for t, _o in keep)
    if var <= 1e-9:
        return 0.0
    return sum((t - mt) * (o - mo) for t, o in keep) / var


def pair(states_a: Sequence[Dict[str, Any]], states_b: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Two takes aligned by their held states. A pair's startOffsetMs is B's state start minus A's (None where either state
    starts its clip), endOffsetMs the same for the ends; medianOffsetMs and driftMsPerS (ms per second of A) come from those."""
    matched = align_states(states_a, states_b)
    pairs, points = [], []
    for i, j, c in matched:
        x, y = states_a[i], states_b[j]
        start = y["startMs"] - x["startMs"] if not (x["atStart"] or y["atStart"]) else None
        end = y["endMs"] - x["endMs"] if not (x["atEnd"] or y["atEnd"]) else None
        pairs.append({"a": x["id"], "b": y["id"], "aMs": round_ms(x["startMs"]), "bMs": round_ms(y["startMs"]),
                      "aEndMs": round_ms(x["endMs"]), "bEndMs": round_ms(y["endMs"]),
                      "startOffsetMs": round_ms(start) if start is not None else None,
                      "endOffsetMs": round_ms(end) if end is not None else None, "score": round(c, 2)})
        if start is not None:
            points.append((x["startMs"] / 1000.0, start))
        elif end is not None:
            points.append((x["endMs"] / 1000.0, end))
    used_a, used_b = {i for i, _j, _c in matched}, {j for _i, j, _c in matched}
    mid = median([o for _t, o in points])
    drift = drift_fit(points)
    return {
        "pairs": pairs,
        "medianOffsetMs": round_ms(mid) if mid is not None else None,
        "driftMsPerS": round(drift, 3) if drift is not None else None,
        "unmatchedA": [{"id": s["id"], "startMs": round_ms(s["startMs"]), "endMs": round_ms(s["endMs"])} for k, s in enumerate(states_a) if k not in used_a],
        "unmatchedB": [{"id": s["id"], "startMs": round_ms(s["startMs"]), "endMs": round_ms(s["endMs"])} for k, s in enumerate(states_b) if k not in used_b],
    }
