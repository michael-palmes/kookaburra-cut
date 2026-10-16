"""The kb video grammar (times, ranges, selectors) and plans: lists of ops applied all or nothing.

Times: bare numbers are SECONDS; 2500ms, 2.5s, 1:02.5, f150 (output frames), end, end-2s. Plans use the editOps
schema (keys ending in Ms are integer ms) plus three source-range ops: cutSource, speedSource and keep.
"""

from __future__ import annotations

import copy
import math
import re
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..util import KbError
from . import editmath as em
from .editops import OpError, apply_op

USAGE = 2
NUM = r"(?:\d+(?:\.\d*)?|\.\d+)"
_MS = re.compile(rf"^({NUM})ms$", re.ASCII)
_S = re.compile(rf"^({NUM})s$", re.ASCII)
_BARE = re.compile(rf"^({NUM})$", re.ASCII)
_FRAME = re.compile(r"^f(\d+)$", re.ASCII)
_CLOCK = re.compile(rf"^(?:(\d+):)?(\d+):({NUM})$", re.ASCII)
_SPEED = re.compile(rf"^({NUM})x?$", re.ASCII)
RANGE_OPS = ("cutSource", "speedSource", "keep")

TIME_HELP = "times are seconds (2.5), 2500ms, 2.5s, 1:02.5, f150 (output frame), end or end-2s"


class PlanError(KbError):
    def __init__(self, index: int, op: Any, code: str, message: str) -> None:
        name = op.get("op") if isinstance(op, dict) else "?"
        super().__init__(f"op {index} ({name}): {message} [{code}]; nothing was changed")
        self.index = index
        self.op = op
        self.op_code = code


# ── times ─────────────────────────────────────────────────────────────────────


def _plain_ms(text: str, fps: Optional[float], what: str) -> float:
    t = text.strip()
    m = _MS.match(t)
    if m:
        return float(m.group(1))
    m = _S.match(t) or _BARE.match(t)
    if m:
        return float(m.group(1)) * 1000.0
    m = _FRAME.match(t)
    if m:
        if not fps or fps <= 0:
            raise KbError(f'{what} "{text}": a frame time needs the edit\'s fps', USAGE)
        return int(m.group(1)) * 1000.0 / fps
    m = _CLOCK.match(t)
    if m:
        hours = int(m.group(1)) if m.group(1) else 0
        return ((hours * 60 + int(m.group(2))) * 60 + float(m.group(3))) * 1000.0
    raise KbError(f'{what} "{text}" is not a time; {TIME_HELP}', USAGE)


def parse_time(text: Any, *, fps: Optional[float] = None, total_ms: Optional[float] = None, what: str = "time") -> float:
    """A time to ms (float)."""
    if isinstance(text, (int, float)) and not isinstance(text, bool):
        return float(text) * 1000.0
    t = str(text).strip().lower()
    if t == "end" or t.startswith("end-"):
        if total_ms is None:
            raise KbError(f'{what} "{text}": end needs a known length here', USAGE)
        if t == "end":
            return float(total_ms)
        back = _plain_ms(t[4:], fps, what)
        if back > total_ms:
            raise KbError(f'{what} "{text}" is before the start ({total_ms / 1000:.2f}s long)', USAGE)
        return float(total_ms) - back
    ms = _plain_ms(t, fps, what)
    if not math.isfinite(ms):
        raise KbError(f'{what} "{text}" is not finite', USAGE)
    return ms


def parse_range(text: str, *, fps: Optional[float] = None, total_ms: Optional[float] = None, what: str = "range") -> Tuple[float, float]:
    """"A-B" (or "A..B") to (a, b) ms with a < b; each side is a time."""
    t = str(text).strip()
    splits: List[Tuple[str, str]] = []
    if ".." in t:
        a, b = t.split("..", 1)
        splits.append((a, b))
    for i, c in enumerate(t):
        if c == "-" and 0 < i < len(t) - 1:
            splits.append((t[:i], t[i + 1:]))
    for a_text, b_text in splits:
        try:
            a = parse_time(a_text, fps=fps, total_ms=total_ms, what=what)
            b = parse_time(b_text, fps=fps, total_ms=total_ms, what=what)
        except KbError:
            continue
        if b <= a:
            raise KbError(f'{what} "{text}" ends before it starts', USAGE)
        return a, b
    raise KbError(f'{what} "{text}" is not A-B; e.g. 2.5-4, 1:02-1:05, 3s-end. {TIME_HELP}', USAGE)


def parse_speed(text: Any) -> float:
    if isinstance(text, (int, float)) and not isinstance(text, bool):
        value = float(text)
    else:
        m = _SPEED.match(str(text).strip().lower())
        if not m:
            raise KbError(f'speed "{text}" is not a number like 2 or 0.5x', USAGE)
        value = float(m.group(1))
    if not math.isfinite(value) or value <= 0:
        raise KbError(f"speed {text} must be above 0", USAGE)
    return value


def parse_pair(text: str, what: str, n: int = 2) -> List[float]:
    parts = [p for p in re.split(r"[,\s]+", str(text).strip()) if p]
    try:
        values = [float(p) for p in parts]
    except ValueError:
        values = []
    if len(values) != n or not all(math.isfinite(v) for v in values):
        example = "0.5,0.4" if n == 2 else "0.1,0.2,0.3,0.1"
        raise KbError(f'{what} "{text}" needs {n} comma-separated numbers, e.g. {example}', USAGE)
    return values


# ── selectors ─────────────────────────────────────────────────────────────────


def total_ms(doc: Dict[str, Any]) -> Any:
    return em.timeline_duration_ms(doc.get("clips") or [])


def _ids(items: List[Dict[str, Any]]) -> str:
    return ", ".join(i["id"] for i in items) or "none"


def select_clip(doc: Dict[str, Any], sel: Any) -> Dict[str, Any]:
    """c3 | 0-based index | @<time> | first | last."""
    clips = doc.get("clips") or []
    s = str(sel).strip()
    if not clips:
        raise KbError("this edit has no clips")
    for c in clips:
        if c["id"] == s:
            return c
    low = s.lower()
    if low == "first":
        return clips[0]
    if low == "last":
        return clips[-1]
    if s.isascii() and s.isdigit():
        i = int(s)
        if i < len(clips):
            return clips[i]
        raise KbError(f"no clip at index {i}; the edit has {len(clips)} (0-{len(clips) - 1})")
    if s.startswith("@"):
        t = parse_time(s[1:], fps=em.output_fps(doc), total_ms=total_ms(doc))
        laid = em.relayout(clips)
        i = em.clip_index_at(laid, t)
        if i < 0 and laid and abs(t - total_ms(doc)) < 1e-6:
            i = len(laid) - 1
        if i < 0:
            raise KbError(f"no clip at {t / 1000:.3f}s; the timeline is {total_ms(doc) / 1000:.3f}s")
        return clips[i]
    raise KbError(f'no clip "{s}"; use an id ({_ids(clips)}), a 0-based index, @<time>, first or last')


def _select_by_id(items: List[Dict[str, Any]], sel: Any, what: str, prefix: str) -> Dict[str, Any]:
    s = str(sel).strip()
    for item in items:
        if item["id"] == s:
            return item
    if s.isascii() and s.isdigit() and int(s) < len(items):
        return items[int(s)]
    raise KbError(f'no {what} "{s}"; use an id ({_ids(items)}) or a 0-based index')


def select_tap(doc: Dict[str, Any], sel: Any) -> Dict[str, Any]:
    return _select_by_id(doc.get("taps") or [], sel, "tap", "t")


def select_mask(doc: Dict[str, Any], sel: Any) -> Dict[str, Any]:
    return _select_by_id(doc.get("masks") or [], sel, "mask", "m")


def select_source(doc: Dict[str, Any], sel: Any = None) -> Dict[str, Any]:
    sources = doc.get("sources") or []
    if sel is None or str(sel).strip() == "":
        if len(sources) == 1:
            return sources[0]
        raise KbError(f"this edit has {len(sources)} sources; name one ({_ids(sources)}), e.g. s2@1.5")
    s = str(sel).strip()
    for src in sources:
        if src["id"] == s or src.get("rel") == s:
            return src
    return _select_by_id(sources, s, "source", "s")


def source_fps(doc: Dict[str, Any], source: Dict[str, Any]) -> float:
    fps = source.get("fps")
    return fps if isinstance(fps, (int, float)) and fps > 0 else em.output_fps(doc)


def parse_src(doc: Dict[str, Any], text: str) -> Tuple[str, int]:
    """"[SID@]T" to (sourceId, integer source ms)."""
    sid, _, rest = str(text).rpartition("@")
    source = select_source(doc, sid or None)
    ms = parse_time(rest, fps=source_fps(doc, source), total_ms=source.get("durationMs"), what="source time")
    return source["id"], em.js_round(ms)


def parse_src_range(doc: Dict[str, Any], text: str) -> Dict[str, Any]:
    """"[SID:]A-B[@Nx]" to {sourceId, fromMs, toMs, speed?}."""
    t = str(text).strip()
    speed = None
    if "@" in t:
        t, _, sp = t.rpartition("@")
        speed = parse_speed(sp)
    sid = None
    m = re.match(r"^([A-Za-z_][\w.-]*):(.+)$", t)
    if m and not re.match(r"^\d", m.group(1)):
        sid, t = m.group(1), m.group(2)
    source = select_source(doc, sid)
    a, b = parse_range(t, fps=source_fps(doc, source), total_ms=source.get("durationMs"), what="source range")
    out: Dict[str, Any] = {"sourceId": source["id"], "fromMs": em.js_round(a), "toMs": em.js_round(b)}
    if speed is not None:
        out["speed"] = speed
    return out


def first_occurrence(doc: Dict[str, Any], source_id: str, source_ms: float) -> Optional[float]:
    """The timeline time where a source moment first plays (None when it is cut, or only on freezes)."""
    for clip in em.relayout(doc.get("clips") or []):
        if em.is_freeze(clip) or clip["sourceId"] != source_id:
            continue
        if clip["inMs"] <= source_ms < clip["outMs"]:
            return clip["startMs"] + (source_ms - clip["inMs"]) / em.effective_speed(clip.get("speed"))
    for clip in em.relayout(doc.get("clips") or []):
        if em.is_freeze(clip) and clip["sourceId"] == source_id and clip["inMs"] == source_ms:
            return float(clip["startMs"])
    return None


# ── source-range ops ──────────────────────────────────────────────────────────


def _fmt(ms: float) -> str:
    return f"{ms / 1000:.3f}s"


def _range_args(doc: Dict[str, Any], op: Dict[str, Any]) -> Tuple[str, int, int]:
    sid = op.get("sourceId")
    if not isinstance(sid, str) or not any(s["id"] == sid for s in doc.get("sources") or []):
        raise OpError("unknown-source", f"no source {sid} (sources: {_ids(doc.get('sources') or [])})")
    a, b = op.get("fromMs"), op.get("toMs")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (a, b)):
        raise OpError("bad-arg", f"{op.get('op')} needs numbers fromMs and toMs")
    a, b = em.js_round(a), em.js_round(b)
    if b <= a or a < 0:
        raise OpError("bad-arg", f"{op.get('op')} range {a}-{b} ms is empty")
    return sid, a, b


def _snap(clip: Dict[str, Any], a: int, b: int, notes: List[str], verb: str) -> Tuple[int, int]:
    """A range edge that would leave a sliver under the floor beside a clip edge moves onto that edge."""
    lo, hi = max(a, clip["inMs"]), min(b, clip["outMs"])
    floor = em.MIN_CLIP_SOURCE_MS
    if lo > clip["inMs"] and lo - clip["inMs"] < floor:
        notes.append(f"{verb} start in {clip['id']} snapped from {_fmt(lo)} to the clip edge {_fmt(clip['inMs'])} (under {floor} ms would be left)")
        lo = clip["inMs"]
    if hi < clip["outMs"] and clip["outMs"] - hi < floor:
        notes.append(f"{verb} end in {clip['id']} snapped from {_fmt(hi)} to the clip edge {_fmt(clip['outMs'])} (under {floor} ms would be left)")
        hi = clip["outMs"]
    return lo, hi


def _targets(doc: Dict[str, Any], sid: str, clip_id: Optional[str]) -> List[int]:
    return [i for i, c in enumerate(doc["clips"]) if c["sourceId"] == sid and not em.is_freeze(c) and (clip_id is None or c["id"] == clip_id)]


def _rebuild(doc: Dict[str, Any], pieces_by_index: Dict[int, List[Dict[str, Any]]]) -> Dict[str, Any]:
    clips: List[Dict[str, Any]] = []
    taken = [c["id"] for c in doc["clips"]]
    for i, clip in enumerate(doc["clips"]):
        if i not in pieces_by_index:
            clips.append(clip)
            continue
        for j, piece in enumerate(pieces_by_index[i]):
            if j > 0:
                piece = dict(piece, id=em.next_prefixed_id("c", taken))
                taken.append(piece["id"])
            clips.append(piece)
    return dict(doc, clips=em.relayout(clips))


def cut_source(doc: Dict[str, Any], op: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    sid, a, b = _range_args(doc, op)
    clip_id = op.get("clipId")
    notes: List[str] = []
    pieces: Dict[int, List[Dict[str, Any]]] = {}
    for i in _targets(doc, sid, clip_id):
        clip = doc["clips"][i]
        if min(b, clip["outMs"]) <= max(a, clip["inMs"]):
            continue
        lo, hi = _snap(clip, a, b, notes, "cut")
        kept = []
        if lo > clip["inMs"]:
            kept.append(dict(clip, outMs=lo))
        if hi < clip["outMs"]:
            kept.append(dict(clip, inMs=hi))
        if not kept:
            notes.append(f"removed {clip['id']} (the cut covers all of it)")
        pieces[i] = kept
    if not pieces:
        raise OpError("no-clip", f"no clip plays {sid} {_fmt(a)}-{_fmt(b)}")
    out = _rebuild(doc, pieces)
    if not out["clips"]:
        raise OpError("bad-arg", "the cut would leave no clips")
    return out, notes


def speed_source(doc: Dict[str, Any], op: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    sid, a, b = _range_args(doc, op)
    speed = op.get("speed")
    if not isinstance(speed, (int, float)) or isinstance(speed, bool) or not math.isfinite(speed) or speed <= 0:
        raise OpError("bad-arg", "speedSource needs a speed above 0")
    clip_id = op.get("clipId")
    notes: List[str] = []
    pieces: Dict[int, List[Dict[str, Any]]] = {}
    for i in _targets(doc, sid, clip_id):
        clip = doc["clips"][i]
        if min(b, clip["outMs"]) <= max(a, clip["inMs"]):
            continue
        lo, hi = _snap(clip, a, b, notes, "speed range")
        parts = []
        if lo > clip["inMs"]:
            parts.append(dict(clip, outMs=lo))
        parts.append(dict(clip, inMs=lo, outMs=hi, speed=speed))
        if hi < clip["outMs"]:
            parts.append(dict(clip, inMs=hi))
        pieces[i] = parts
    if not pieces:
        raise OpError("no-clip", f"no clip plays {sid} {_fmt(a)}-{_fmt(b)}")
    return _rebuild(doc, pieces), notes


def keep_ranges(doc: Dict[str, Any], op: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    ranges = op.get("ranges")
    if not isinstance(ranges, list) or not ranges:
        raise OpError("bad-arg", "keep needs ranges: [{sourceId, fromMs, toMs, speed?}]")
    by_source: Dict[str, List[Tuple[int, int, Optional[float]]]] = {}
    for r in ranges:
        if not isinstance(r, dict):
            raise OpError("bad-arg", "each keep range is {sourceId, fromMs, toMs, speed?}")
        sid, a, b = _range_args(doc, dict(r, op="keep"))
        speed = r.get("speed")
        if speed is not None and (not isinstance(speed, (int, float)) or isinstance(speed, bool) or not math.isfinite(speed) or speed <= 0):
            raise OpError("bad-arg", "a keep range speed must be above 0")
        by_source.setdefault(sid, []).append((a, b, speed))
    notes: List[str] = []
    pieces: Dict[int, List[Dict[str, Any]]] = {}
    for i, clip in enumerate(doc["clips"]):
        rs = sorted(by_source.get(clip["sourceId"], []), key=lambda r: r[0])
        if clip["sourceId"] not in by_source:
            continue
        if em.is_freeze(clip):
            if not any(a <= clip["inMs"] <= b for a, b, _s in rs):
                pieces[i] = []
                notes.append(f"removed freeze {clip['id']} (its frame {_fmt(clip['inMs'])} is outside every kept range)")
            continue
        parts = []
        for a, b, speed in rs:
            if min(b, clip["outMs"]) <= max(a, clip["inMs"]):
                continue
            lo, hi = _snap(clip, a, b, notes, "keep")
            if hi - lo < em.MIN_CLIP_SOURCE_MS:
                notes.append(f"dropped {_fmt(lo)}-{_fmt(hi)} of {clip['id']} (under the {em.MIN_CLIP_SOURCE_MS} ms clip minimum)")
                continue
            if parts and lo < parts[-1]["outMs"]:
                lo = parts[-1]["outMs"]
                if hi <= lo:
                    continue
            parts.append(dict(clip, inMs=lo, outMs=hi, speed=speed if speed is not None else clip.get("speed")))
        if not parts:
            notes.append(f"removed {clip['id']} (no kept range touches it)")
        pieces[i] = parts
    out = _rebuild(doc, pieces)
    if not out["clips"]:
        raise OpError("bad-arg", "keep would leave no clips")
    return out, notes


RANGE_HANDLERS = {"cutSource": cut_source, "speedSource": speed_source, "keep": keep_ranges}


def timeline_ranges_to_source(doc: Dict[str, Any], ranges: List[Tuple[float, float]], op_name: str = "cutSource", speed: Optional[float] = None) -> List[Dict[str, Any]]:
    """Timeline ranges (as the doc stands now) to per-clip source-range ops; a later range on one clip goes first so ids hold."""
    laid = em.relayout(doc.get("clips") or [])
    per_clip: Dict[str, List[Dict[str, Any]]] = {}
    order: List[str] = []
    freeze_ops: List[Dict[str, Any]] = []
    for a, b in ranges:
        for clip in laid:
            start = clip["startMs"]
            end = start + em.clip_timeline_ms(clip)
            lo, hi = max(a, start), min(b, end)
            if hi <= lo:
                continue
            if em.is_freeze(clip):
                if op_name != "cutSource":
                    continue
                left = clip["holdMs"] - (hi - lo)
                if left < em.MIN_HOLD_MS:
                    freeze_ops.append({"op": "removeClip", "clipId": clip["id"]})
                else:
                    freeze_ops.append({"op": "setHold", "clipId": clip["id"], "holdMs": em.js_round(left)})
                continue
            src_a = em.js_round(em.timeline_to_source(clip, lo))
            src_b = em.js_round(em.timeline_to_source(clip, hi))
            if src_b <= src_a:
                continue
            op: Dict[str, Any] = {"op": op_name, "sourceId": clip["sourceId"], "fromMs": src_a, "toMs": src_b, "clipId": clip["id"]}
            if speed is not None:
                op["speed"] = speed
            if clip["id"] not in per_clip:
                order.append(clip["id"])
            per_clip.setdefault(clip["id"], []).append(op)
    ops: List[Dict[str, Any]] = []
    for cid in order:
        ops.extend(sorted(per_clip[cid], key=lambda o: -o["fromMs"]))
    return ops + freeze_ops


# ── plans ─────────────────────────────────────────────────────────────────────

def _substitute(op: Dict[str, Any], labels: Dict[str, str], index: int) -> Dict[str, Any]:
    out = {}
    for k, v in op.items():
        if isinstance(v, str) and v.startswith("$"):
            if v[1:] not in labels:
                raise PlanError(index, op, "bad-arg", f'{k} "{v}" names no earlier op labelled with "as"')
            v = labels[v[1:]]
        out[k] = v
    return out


def _resolve_selectors(doc: Dict[str, Any], op: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(op)
    cid = out.get("clipId")
    if isinstance(cid, (str, int)) and not isinstance(cid, bool) and op.get("op") not in RANGE_OPS:
        if not any(c["id"] == cid for c in doc.get("clips") or []):
            try:
                out["clipId"] = select_clip(doc, cid)["id"]
            except KbError:
                pass
    return out


def normalise_plan(plan: Any) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """A plan is a list of ops or {"baseHash"?, "ops": [...]}; returns (ops, baseHash)."""
    base = None
    if isinstance(plan, dict):
        base = plan.get("baseHash")
        if base is not None and not isinstance(base, str):
            raise KbError("plan baseHash must be a string", USAGE)
        plan = plan.get("ops")
    if not isinstance(plan, list) or not all(isinstance(o, dict) for o in plan):
        raise KbError('a plan is a JSON list of ops, or {"baseHash": "...", "ops": [...]}; each op is {"op": "split", "atMs": 2500, ...}', USAGE)
    return plan, base


def run_plan(doc: Dict[str, Any], ops: List[Dict[str, Any]], *, probe: Optional[Callable[[str], Dict[str, Any]]] = None) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Apply every op in order against the doc as it stands; one failure raises PlanError and nothing changes."""
    current = copy.deepcopy(doc)
    current = dict(current, clips=em.relayout(current.get("clips") or []))
    labels: Dict[str, str] = {}
    reports: List[Dict[str, Any]] = []
    for index, raw in enumerate(ops):
        op = _substitute({k: v for k, v in raw.items() if k != "as"}, labels, index)
        name = op.get("op")
        if name in ("addClip", "insertClip") and isinstance(op.get("source"), str):
            if probe is None:
                raise PlanError(index, raw, "bad-arg", "source as a path needs the app's probe; pass a SourceMeta object")
            try:
                op["source"] = probe(op["source"])
            except KbError as e:
                raise PlanError(index, raw, "bad-arg", e.message) from None
        try:
            op = _resolve_selectors(current, op)
            if name in RANGE_HANDLERS:
                nxt, notes = RANGE_HANDLERS[name](current, op)
                result_doc, pruned = _pruned(nxt)
                label, created = {"cutSource": "cut", "speedSource": "change speed", "keep": "keep"}[name], None
            else:
                res = apply_op(current, op)
                result_doc, label, created, pruned, notes = res.doc, res.label, res.created, list(res.pruned), []
        except OpError as e:
            raise PlanError(index, raw, e.code, e.message) from None
        alias = raw.get("as")
        if alias is not None:
            if not isinstance(alias, str) or not alias:
                raise PlanError(index, raw, "bad-arg", '"as" must be a non-empty string')
            if created is None:
                raise PlanError(index, raw, "bad-arg", f'"as": {name} creates nothing to label')
            labels[alias] = created
        current = result_doc
        reports.append({"index": index, "op": name, "label": label, "detail": describe(op), "created": created, "pruned": list(pruned), "notes": notes, "as": alias})
    return current, reports


def describe(op: Dict[str, Any]) -> str:
    """A short human reading of one op's arguments."""
    name = op.get("op")

    def t(key: str) -> str:
        v = op.get(key)
        return _fmt(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else "?"

    if name in ("split", "addTap", "retimeTap", "addMaskKey", "removeMaskKey", "setMaskRect"):
        target = op.get("tapId") or op.get("maskId")
        return " ".join(x for x in (target, f"at {t('atMs')}") if x)
    if name == "freeze":
        return f"at {t('atMs')} for {_fmt(op.get('holdMs', em.DEFAULT_HOLD_MS))}"
    if name == "addMask":
        return f"at {t('atMs')}"
    if name == "setSpeed":
        return f"{op.get('clipId')} to {op.get('speed')}x"
    if name in ("trimIn", "trimOut"):
        key = "inMs" if name == "trimIn" else "outMs"
        return f"{op.get('clipId')} to source {t(key)}"
    if name == "setHold":
        return f"{op.get('clipId')} to {t('holdMs')}"
    if name in ("removeClip",):
        return str(op.get("clipId"))
    if name == "moveClip":
        return f"from index {op.get('from')} to {op.get('to')}"
    if name in ("addClip", "insertClip"):
        src = op.get("source")
        rel = src.get("rel") if isinstance(src, dict) else src
        return f"{rel}" + (f" at {t('atMs')}" if "atMs" in op else (f" at index {op['index']}" if op.get("index") is not None else ""))
    if name == "addTapAtSource":
        return f"at {op.get('sourceId')}@{t('sourceMs')}"
    if name in ("moveTap", "removeTap"):
        return str(op.get("tapId"))
    if name in ("offsetMask", "setMaskLook", "removeMask"):
        return str(op.get("maskId"))
    if name == "retimeMaskEdge":
        return f"{op.get('maskId')} {op.get('edge')} to source {t('sourceMs')}"
    if name in ("cutSource", "speedSource"):
        where = f" in {op['clipId']}" if op.get("clipId") else ""
        speed = f" at {op.get('speed')}x" if name == "speedSource" else ""
        return f"{op.get('sourceId')} {t('fromMs')}-{t('toMs')}{where}{speed}"
    if name == "keep":
        return ", ".join(f"{r.get('sourceId')} {_fmt(r.get('fromMs', 0))}-{_fmt(r.get('toMs', 0))}" + (f"@{r['speed']}x" if r.get("speed") else "") for r in op.get("ranges") or [] if isinstance(r, dict))
    return ""


def _pruned(doc: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    if not doc.get("masks"):
        return doc, []
    kept = em.prune_orphan_masks(doc["clips"], doc["masks"], doc["sources"])
    if kept is doc["masks"]:
        return doc, []
    ids = {m["id"] for m in kept}
    return dict(doc, masks=list(kept)), [m["id"] for m in doc["masks"] if m["id"] not in ids]
