"""Exact mirror of src/engine/editMath.ts and src/engine/editMasks.ts (snake_case, same evaluation order).

Docs are the raw camelCase dicts. A clip is a freeze when "holdMs" is a key (null is dropped on parse). Nothing here
mutates its inputs; every mutator returns new dicts and lists. Rounding is JavaScript's Math.round (js_round), never
Python's round(), and sums are plain left folds (Python 3.12's sum() compensates and would drift from JS).
"""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

Clip = Dict[str, Any]
Tap = Dict[str, Any]
Mask = Dict[str, Any]
Rect = List[float]

MIN_CLIP_SOURCE_MS = 100
MIN_HOLD_MS = 100
DEFAULT_HOLD_MS = 2000
TAP_DURATION_MS = 550
DEFAULT_FPS = 60

MASK_DEFAULT_SPAN_MS = 3000
MIN_MASK_SPAN_MS = 100
MIN_MASK_SIZE = 0.01
DEFAULT_MASK_COLOR = "#000000"
DEFAULT_MASK_STRENGTH = 0.5
MASK_BLUR_MIN = 0.008
MASK_BLUR_MAX = 0.04
MASK_BLOCK_MIN = 0.025
MASK_BLOCK_MAX = 0.1
MIN_CROP_SIZE = 0.05


def js_round(x: Any) -> Any:
    """Math.round: half rounds toward +infinity; finite results are ints."""
    if not isinstance(x, (int, float)) or isinstance(x, bool):
        return x
    if isinstance(x, int):
        return x
    if not math.isfinite(x):
        return x
    f = math.floor(x)
    return int(f) + (1 if x - f >= 0.5 else 0)


def _finite(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def effective_speed(speed: Any) -> Any:
    return speed if isinstance(speed, (int, float)) and not isinstance(speed, bool) and speed > 0 else 1


def clamp(v: Any, lo: Any, hi: Any) -> Any:
    return min(hi, max(lo, v))


def is_freeze(clip: Clip) -> bool:
    return "holdMs" in clip


def output_fps(doc: Dict[str, Any]) -> Any:
    fps = (doc.get("settings") or {}).get("fps")
    return fps if _finite(fps) and fps > 0 else DEFAULT_FPS


def frame_at(ms: float, fps: float) -> int:
    """The output frame at timeline ms on the render's cumulative grid (edit.rs frame_at; half rounds up)."""
    return max(0, js_round((ms / 1000.0) * fps))


# ── editMath.ts ───────────────────────────────────────────────────────────────


def clip_timeline_ms(clip: Clip) -> Any:
    if "holdMs" in clip:
        return max(0, clip["holdMs"])
    return max(0, clip["outMs"] - clip["inMs"]) / effective_speed(clip.get("speed"))


def relayout(clips: Sequence[Clip]) -> List[Clip]:
    t: Any = 0
    out: List[Clip] = []
    for clip in clips:
        laid = dict(clip)
        laid["startMs"] = js_round(t)
        out.append(laid)
        t += clip_timeline_ms(clip)
    return out


def timeline_duration_ms(clips: Sequence[Clip]) -> Any:
    total: Any = 0
    for clip in clips:
        total = total + clip_timeline_ms(clip)
    return total


def clip_index_at(clips: Sequence[Clip], t_ms: float) -> int:
    start: Any = 0
    for i, clip in enumerate(clips):
        end = start + clip_timeline_ms(clip)
        if t_ms >= start and t_ms < end:
            return i
        start = end
    return -1


def timeline_to_source(clip: Clip, t_ms: float) -> Any:
    if "holdMs" in clip:
        return clip["inMs"]
    offset = (t_ms - clip["startMs"]) * effective_speed(clip.get("speed"))
    return min(clip["outMs"], max(clip["inMs"], clip["inMs"] + offset))


def split_at(clips: Sequence[Clip], t_ms: float, new_id: str) -> Optional[List[Clip]]:
    i = clip_index_at(clips, t_ms)
    if i < 0:
        return None
    clip = clips[i]
    if "holdMs" in clip:
        return None
    src_split = js_round(clip["inMs"] + (t_ms - clip["startMs"]) * effective_speed(clip.get("speed")))
    if src_split - clip["inMs"] < MIN_CLIP_SOURCE_MS or clip["outMs"] - src_split < MIN_CLIP_SOURCE_MS:
        return None
    left = dict(clip, outMs=src_split)
    right = dict(clip, id=new_id, inMs=src_split)
    return relayout(list(clips[:i]) + [left, right] + list(clips[i + 1:]))


def remove_clip(clips: Sequence[Clip], clip_id: str) -> List[Clip]:
    return relayout([c for c in clips if c["id"] != clip_id])


def move_clip(clips: Sequence[Clip], frm: int, to: int) -> Sequence[Clip]:
    if frm == to or frm < 0 or frm >= len(clips):
        return clips
    nxt = list(clips)
    lifted = nxt.pop(frm)
    nxt.insert(max(0, min(len(nxt), to)), lifted)
    return relayout(nxt)


def set_clip_speed(clips: Sequence[Clip], clip_id: str, speed: Any) -> List[Clip]:
    return relayout([dict(c, speed=effective_speed(speed)) if c["id"] == clip_id and "holdMs" not in c else c for c in clips])


def trim_clip_in(clips: Sequence[Clip], clip_id: str, in_ms: float) -> List[Clip]:
    return relayout([
        dict(c, inMs=max(0, min(js_round(in_ms), c["outMs"] - MIN_CLIP_SOURCE_MS))) if c["id"] == clip_id and "holdMs" not in c else c
        for c in clips
    ])


def trim_clip_out(clips: Sequence[Clip], clip_id: str, out_ms: float, source_duration_ms: Any) -> List[Clip]:
    return relayout([
        dict(c, outMs=min(source_duration_ms, max(js_round(out_ms), c["inMs"] + MIN_CLIP_SOURCE_MS)))
        if c["id"] == clip_id and "holdMs" not in c
        else c
        for c in clips
    ])


def image_clip(clips: Sequence[Clip], source_id: str, hold_ms: float) -> Clip:
    return {
        "id": next_clip_id(clips),
        "sourceId": source_id,
        "inMs": 0,
        "outMs": 0,
        "speed": 1,
        "holdMs": max(MIN_HOLD_MS, js_round(hold_ms)),
        "startMs": 0,
    }


def _freeze_of(clip: Clip, clip_id: str, src: int, hold_ms: float) -> Clip:
    """freezeOf: the clip's source frame at src, framed by the clip's crop."""
    freeze = {"id": clip_id, "sourceId": clip["sourceId"], "inMs": src, "outMs": src, "speed": 1, "holdMs": max(MIN_HOLD_MS, js_round(hold_ms)), "startMs": 0}
    return dict(freeze, crop=clip["crop"]) if clip.get("crop") else freeze


def freeze_at(clips: Sequence[Clip], t_ms: float, hold_ms: float) -> Optional[List[Clip]]:
    i = clip_index_at(clips, t_ms)
    if i < 0:
        return None
    clip = clips[i]
    if "holdMs" in clip:
        return None
    src = js_round(timeline_to_source(clip, t_ms))
    freeze = _freeze_of(clip, next_clip_id(clips), src, hold_ms)
    if src - clip["inMs"] < MIN_CLIP_SOURCE_MS:
        return relayout(list(clips[:i]) + [freeze] + list(clips[i:]))
    if clip["outMs"] - src < MIN_CLIP_SOURCE_MS:
        return relayout(list(clips[: i + 1]) + [freeze] + list(clips[i + 1:]))
    left = dict(clip, outMs=src)
    right = dict(clip, id=next_clip_id(list(clips) + [freeze]), inMs=src)
    return relayout(list(clips[:i]) + [left, freeze, right] + list(clips[i + 1:]))


def freeze_at_end(clips: Sequence[Clip], fps_out: Any, hold_ms: float) -> Optional[List[Clip]]:
    if not clips:
        return None
    clip = clips[-1]
    if "holdMs" in clip:
        return None
    fps = fps_out if fps_out > 0 else 60
    end_ms = clip["startMs"] + clip_timeline_ms(clip)
    sample_ms = max(clip["startMs"], end_ms - 1000 / fps)
    src = js_round(timeline_to_source(clip, sample_ms))
    return relayout(list(clips) + [_freeze_of(clip, next_clip_id(clips), src, hold_ms)])


def insert_clip_at(clips: Sequence[Clip], t_ms: float, new_clip: Clip) -> List[Clip]:
    i = clip_index_at(clips, t_ms)
    if i < 0:
        return relayout(list(clips) + [new_clip])
    clip = clips[i]
    if "holdMs" in clip:
        before = t_ms - clip["startMs"] < clip_timeline_ms(clip) / 2
        at = i if before else i + 1
        return relayout(list(clips[:at]) + [new_clip] + list(clips[at:]))
    src = js_round(timeline_to_source(clip, t_ms))
    start_short = src - clip["inMs"] < MIN_CLIP_SOURCE_MS
    end_short = clip["outMs"] - src < MIN_CLIP_SOURCE_MS
    if start_short and (not end_short or src - clip["inMs"] <= clip["outMs"] - src):
        return relayout(list(clips[:i]) + [new_clip] + list(clips[i:]))
    if end_short:
        return relayout(list(clips[: i + 1]) + [new_clip] + list(clips[i + 1:]))
    left = dict(clip, outMs=src)
    right = dict(clip, id=next_clip_id(list(clips) + [new_clip]), inMs=src)
    return relayout(list(clips[:i]) + [left, new_clip, right] + list(clips[i + 1:]))


def set_clip_hold(clips: Sequence[Clip], clip_id: str, hold_ms: float) -> List[Clip]:
    return relayout([dict(c, holdMs=max(MIN_HOLD_MS, js_round(hold_ms))) if c["id"] == clip_id and "holdMs" in c else c for c in clips])


def edge_targets_ms(clips: Sequence[Clip]) -> List[Any]:
    targets: List[Any] = [0]
    t: Any = 0
    for clip in clips:
        t += clip_timeline_ms(clip)
        targets.append(t)
    return targets


def snap_ms(t_ms: float, targets: Sequence[float], threshold_ms: float) -> Any:
    best: Any = t_ms
    best_distance = threshold_ms
    for target in targets:
        distance = abs(target - t_ms)
        if distance <= best_distance:
            best_distance = distance
            best = target
    return best


def next_prefixed_id(prefix: str, ids: Sequence[str]) -> str:
    pattern = re.compile(f"^{re.escape(prefix)}(\\d+)$", re.ASCII)
    best = 0
    for i in ids:
        m = pattern.match(i) if isinstance(i, str) else None
        if m and m.end() == len(i):
            best = max(best, int(m.group(1)))
    taken = set(ids)
    n = best + 1
    while f"{prefix}{n}" in taken:
        n += 1
    return f"{prefix}{n}"


def next_clip_id(clips: Sequence[Clip]) -> str:
    return next_prefixed_id("c", [c["id"] for c in clips])


def next_source_id(sources: Sequence[Dict[str, Any]]) -> str:
    return next_prefixed_id("s", [s["id"] for s in sources])


def output_to_source(clips: Sequence[Clip], t_ms: float) -> Optional[Dict[str, Any]]:
    """outputToSource plus the clip it landed in (TS returns only sourceId and sourceMs)."""
    i = clip_index_at(clips, t_ms)
    if i < 0:
        return None
    clip = clips[i]
    if "holdMs" in clip:
        return None
    return {"sourceId": clip["sourceId"], "sourceMs": js_round(timeline_to_source(clip, t_ms)), "clip": clip}


def tap_windows(clips: Sequence[Clip], tap: Tap, tap_duration_ms: float = TAP_DURATION_MS) -> List[Dict[str, Any]]:
    windows: List[Dict[str, Any]] = []
    for clip in clips:
        if "holdMs" in clip:
            continue
        if clip["sourceId"] != tap["sourceId"]:
            continue
        if tap["sourceMs"] < clip["inMs"] or tap["sourceMs"] >= clip["outMs"]:
            continue
        if clip.get("crop") and not pos_in_crop(tap["pos"], clip["crop"]):
            continue
        start = clip["startMs"] + (tap["sourceMs"] - clip["inMs"]) / effective_speed(clip.get("speed"))
        clip_end = clip["startMs"] + clip_timeline_ms(clip)
        windows.append({"startMs": start, "endMs": min(start + tap_duration_ms, clip_end)})
    return windows


def add_tap(taps: Sequence[Tap], tap: Tap) -> List[Tap]:
    return list(taps) + [tap]


def move_tap(taps: Sequence[Tap], tap_id: str, pos: Sequence[float]) -> List[Tap]:
    return [dict(t, pos=list(pos)) if t["id"] == tap_id else t for t in taps]


def retime_tap(taps: Sequence[Tap], tap_id: str, source_id: str, source_ms: Any) -> List[Tap]:
    return [dict(t, sourceId=source_id, sourceMs=source_ms) if t["id"] == tap_id else t for t in taps]


def remove_tap(taps: Sequence[Tap], tap_id: str) -> List[Tap]:
    return [t for t in taps if t["id"] != tap_id]


def next_tap_id(taps: Sequence[Tap]) -> str:
    return next_prefixed_id("t", [t["id"] for t in taps])


def crop_pixels(crop: Sequence[float], source: Dict[str, Any]) -> List[int]:
    """Even source pixels [x, y, w, h] inside the frame (edit.rs crop_px)."""

    def axis(pos: float, length: float, size: int) -> Tuple[int, int]:
        mx = size - (size % 2)
        ln = clamp(2 * js_round((length * size) / 2), min(2, mx), mx)
        return clamp(2 * js_round((pos * size) / 2), 0, mx - ln), ln

    x, w = axis(crop[0], crop[2], source["width"])
    y, h = axis(crop[1], crop[3], source["height"])
    return [x, y, w, h]


def snap_crop_rect(rect: Sequence[float], source: Dict[str, Any]) -> List[float]:
    w = clamp(rect[2], MIN_CROP_SIZE, 1)
    h = clamp(rect[3], MIN_CROP_SIZE, 1)
    x, y, pw, ph = crop_pixels([clamp(rect[0], 0, 1 - w), clamp(rect[1], 0, 1 - h), w, h], source)
    return [x / source["width"], y / source["height"], pw / source["width"], ph / source["height"]]


def aspect_crop_rect(source: Dict[str, Any], aspect: float, centre: Sequence[float] = (0.5, 0.5)) -> List[float]:
    frame = source["width"] / source["height"]
    w = 1 if aspect >= frame else aspect / frame
    h = frame / aspect if aspect >= frame else 1
    return snap_crop_rect([centre[0] - w / 2, centre[1] - h / 2, w, h], source)


def pos_in_crop(pos: Sequence[float], crop: Sequence[float]) -> bool:
    return pos[0] >= crop[0] and pos[0] <= crop[0] + crop[2] and pos[1] >= crop[1] and pos[1] <= crop[1] + crop[3]


def tap_pos_in_crop(pos: Sequence[float], crop: Sequence[float], source: Dict[str, Any]) -> Optional[List[float]]:
    if not pos_in_crop(pos, crop):
        return None
    x, y, w, h = crop_pixels(crop, source)
    return [clamp((pos[0] * source["width"] - x) / w, 0, 1), clamp((pos[1] * source["height"] - y) / h, 0, 1)]


def set_clip_crop(clips: Sequence[Clip], clip_id: str, crop: Optional[Sequence[float]]) -> List[Clip]:
    out: List[Clip] = []
    for c in clips:
        if c["id"] != clip_id:
            out.append(c)
        elif crop:
            out.append(dict(c, crop=list(crop)))
        else:
            out.append({k: v for k, v in c.items() if k != "crop"})
    return relayout(out)


# ── editMasks.ts ──────────────────────────────────────────────────────────────


def _strength_of(mask: Mask) -> Any:
    s = mask.get("strength")
    return DEFAULT_MASK_STRENGTH if s is None or not _finite(s) else clamp(s, 0, 1)


def mask_blur_sigma_px(mask: Mask, source: Dict[str, Any]) -> Any:
    frac = MASK_BLUR_MIN + _strength_of(mask) * (MASK_BLUR_MAX - MASK_BLUR_MIN)
    return js_round(frac * min(source["width"], source["height"]) * 100) / 100


def mask_block_px(mask: Mask, source: Dict[str, Any]) -> Any:
    frac = MASK_BLOCK_MIN + _strength_of(mask) * (MASK_BLOCK_MAX - MASK_BLOCK_MIN)
    return max(2, 2 * js_round((frac * min(source["width"], source["height"])) / 2))


def clamp_rect(rect: Sequence[float]) -> Rect:
    w = clamp(rect[2], MIN_MASK_SIZE, 1)
    h = clamp(rect[3], MIN_MASK_SIZE, 1)
    return [clamp(rect[0], 0, 1 - w), clamp(rect[1], 0, 1 - h), w, h]


def rect_from_corners(a: Sequence[float], b: Sequence[float]) -> Rect:
    x0 = clamp(min(a[0], b[0]), 0, 1)
    y0 = clamp(min(a[1], b[1]), 0, 1)
    x1 = clamp(max(a[0], b[0]), 0, 1)
    y1 = clamp(max(a[1], b[1]), 0, 1)
    return clamp_rect([x0, y0, x1 - x0, y1 - y0])


def default_mask_rect(pos: Sequence[float], source: Dict[str, Any]) -> Rect:
    short = min(source["width"], source["height"])
    w = (0.35 * short) / source["width"] if source["width"] > 0 else 0.35
    h = (0.12 * short) / source["height"] if source["height"] > 0 else 0.12
    return clamp_rect([pos[0] - w / 2, pos[1] - h / 2, w, h])


def sample_mask_rect(keys: Sequence[Dict[str, Any]], source_ms: float) -> Optional[Rect]:
    if len(keys) == 0:
        return None
    if source_ms <= keys[0]["sourceMs"]:
        return keys[0]["rect"]
    for i in range(1, len(keys)):
        b = keys[i]
        if source_ms < b["sourceMs"]:
            a = keys[i - 1]
            t = (source_ms - a["sourceMs"]) / (b["sourceMs"] - a["sourceMs"])
            return [a["rect"][j] + (b["rect"][j] - a["rect"][j]) * t for j in range(4)]
    return keys[-1]["rect"]


def source_moment_at(clips: Sequence[Clip], t_ms: float) -> Optional[Dict[str, Any]]:
    """{clip, index, sourceId, sourceMs, hold}: the frame on screen at t, clamped like the preview."""
    total = timeline_duration_ms(clips)
    if total <= 0:
        return None
    t = clamp(t_ms, 0, max(0, total - 1))
    index = clip_index_at(clips, t)
    if index < 0:
        return None
    clip = clips[index]
    hold = "holdMs" in clip
    if hold:
        source_ms = clip["inMs"]
    else:
        source_ms = js_round(min(clip["outMs"], clip["inMs"] + (t - clip["startMs"]) * effective_speed(clip.get("speed"))))
    return {"clip": clip, "index": index, "sourceId": clip["sourceId"], "sourceMs": source_ms, "hold": hold}


def mask_active_at(mask: Mask, source_ms: float, image: bool) -> bool:
    return bool(image) or (source_ms >= mask["startMs"] and source_ms < mask["endMs"])


def mask_opacity_at(mask: Mask, source_ms: float, image: bool) -> Any:
    if image:
        return 1
    if not mask_active_at(mask, source_ms, False):
        return 0
    fade_in = mask.get("fadeInMs") or 0
    fade_out = mask.get("fadeOutMs") or 0
    a: Any = 1
    if fade_in > 0:
        a = min(a, (source_ms - mask["startMs"]) / fade_in)
    if fade_out > 0:
        a = min(a, (mask["endMs"] - source_ms) / fade_out)
    return clamp(a, 0, 1)


def with_mask_fades(mask: Mask, fade_in_ms: float, fade_out_ms: float) -> Mask:
    out = {k: v for k, v in mask.items() if k not in ("fadeInMs", "fadeOutMs")}
    fade_in = max(0, js_round(fade_in_ms))
    fade_out = max(0, js_round(fade_out_ms))
    if fade_in > 0:
        out["fadeInMs"] = fade_in
    if fade_out > 0:
        out["fadeOutMs"] = fade_out
    return out


def _fit_mask_fades(mask: Mask, moved: str) -> Mask:
    """fitMaskFades: fades that outgrow a shortened span give way, the moved edge's first."""
    fade_in = mask.get("fadeInMs") or 0
    fade_out = mask.get("fadeOutMs") or 0
    span = mask["endMs"] - mask["startMs"]
    if fade_in + fade_out <= span:
        return mask
    if moved == "start":
        out = min(fade_out, span)
        return with_mask_fades(mask, span - out, out)
    keep = min(fade_in, span)
    return with_mask_fades(mask, keep, span - keep)


def mask_windows(clips: Sequence[Clip], mask: Mask, image: bool) -> List[Dict[str, Any]]:
    windows: List[Dict[str, Any]] = []
    for clip in clips:
        if clip["sourceId"] != mask["sourceId"]:
            continue
        span = clip_timeline_ms(clip)
        if image or "holdMs" in clip:
            if not mask_active_at(mask, clip["inMs"], image):
                continue
            windows.append({
                "maskId": mask["id"], "clipId": clip["id"], "startMs": clip["startMs"], "endMs": clip["startMs"] + span,
                "startEdge": False, "endEdge": False, "hold": True,
            })
            continue
        a = max(clip["inMs"], mask["startMs"])
        b = min(clip["outMs"], mask["endMs"])
        if b <= a:
            continue
        speed = effective_speed(clip.get("speed"))
        windows.append({
            "maskId": mask["id"], "clipId": clip["id"],
            "startMs": clip["startMs"] + (a - clip["inMs"]) / speed,
            "endMs": clip["startMs"] + (b - clip["inMs"]) / speed,
            "startEdge": mask["startMs"] >= clip["inMs"], "endEdge": mask["endMs"] <= clip["outMs"], "hold": False,
        })
    return windows


def pack_mask_rows(windows_by_mask: Any) -> Dict[str, int]:
    """Accepts a dict (insertion order) or a list of [id, windows] pairs, like the TS Map."""
    entries = list(windows_by_mask.items()) if isinstance(windows_by_mask, dict) else [(e[0], e[1]) for e in windows_by_mask]
    order = sorted([e for e in entries if len(e[1]) > 0], key=lambda e: e[1][0]["startMs"])
    rows: List[List[Dict[str, Any]]] = []
    out: Dict[str, int] = {}
    for mask_id, windows in order:
        row = -1
        for r, taken in enumerate(rows):
            if all(all(w["endMs"] <= o["startMs"] or w["startMs"] >= o["endMs"] for o in taken) for w in windows):
                row = r
                break
        if row < 0:
            row = len(rows)
            rows.append([])
        rows[row].extend(windows)
        out[mask_id] = row
    return out


def _find_source(sources: Sequence[Dict[str, Any]], source_id: str) -> Optional[Dict[str, Any]]:
    for s in sources:
        if s.get("id") == source_id:
            return s
    return None


def prune_orphan_masks(clips: Sequence[Clip], masks: Sequence[Mask], sources: Sequence[Dict[str, Any]]) -> Sequence[Mask]:
    """Returns the same list object when nothing was dropped (the TS identity check)."""
    kept = []
    for mask in masks:
        source = _find_source(sources, mask["sourceId"])
        if source is None:
            continue
        if len(mask_windows(clips, mask, source.get("kind") == "image")) > 0:
            kept.append(mask)
    return masks if len(kept) == len(masks) else kept


def default_mask_range(moment: Dict[str, Any], source: Dict[str, Any]) -> Dict[str, int]:
    speed = 1 if moment["hold"] else effective_speed(moment["clip"].get("speed"))
    limit = source["durationMs"] if source["durationMs"] > 0 else moment["clip"]["outMs"] + MASK_DEFAULT_SPAN_MS
    end_ms = min(limit, js_round(moment["sourceMs"] + MASK_DEFAULT_SPAN_MS * speed))
    start_ms = max(0, min(moment["sourceMs"], end_ms - MIN_MASK_SPAN_MS))
    return {"startMs": start_ms, "endMs": max(end_ms, start_ms + MIN_MASK_SPAN_MS)}


def key_tolerance_ms(fps_out: Any, speed: Any) -> Any:
    return (500 / (fps_out if fps_out > 0 else 60)) * effective_speed(speed)


def key_index_at(keys: Sequence[Dict[str, Any]], source_ms: float, tol_ms: float) -> int:
    best = -1
    best_dist = math.inf
    for i, k in enumerate(keys):
        d = abs(k["sourceMs"] - source_ms)
        if d <= tol_ms and d < best_dist:
            best = i
            best_dist = d
    return best


def upsert_mask_key(mask: Mask, source_ms: float, rect: Sequence[float], tol_ms: float, image: bool) -> Mask:
    clamped = clamp_rect(rect)
    if image:
        return dict(mask, keys=[{"sourceMs": 0, "rect": clamped}])
    ms = max(0, js_round(source_ms))
    hit = key_index_at(mask["keys"], ms, tol_ms)
    if hit >= 0:
        return dict(mask, keys=[dict(k, rect=clamped) if i == hit else k for i, k in enumerate(mask["keys"])])
    keys = sorted(list(mask["keys"]) + [{"sourceMs": ms, "rect": clamped}], key=lambda k: k["sourceMs"])
    return dict(mask, keys=keys)


def add_hold_key(mask: Mask, source_ms: float, tol_ms: float) -> Mask:
    """Returns the same dict when a key is already there (the TS no-op)."""
    if key_index_at(mask["keys"], source_ms, tol_ms) >= 0:
        return mask
    rect = sample_mask_rect(mask["keys"], source_ms)
    if not rect:
        return mask
    return upsert_mask_key(mask, source_ms, rect, tol_ms, False)


def remove_mask_key(mask: Mask, source_ms: float, tol_ms: float) -> Mask:
    if len(mask["keys"]) <= 1:
        return mask
    hit = key_index_at(mask["keys"], source_ms, tol_ms)
    if hit < 0:
        return mask
    return dict(mask, keys=[k for i, k in enumerate(mask["keys"]) if i != hit])


def offset_mask_keys(mask: Mask, dx: float, dy: float) -> Mask:
    keys = mask["keys"]
    if len(keys) == 0:
        return mask
    min_dx = max(-k["rect"][0] for k in keys)
    max_dx = min(1 - k["rect"][0] - k["rect"][2] for k in keys)
    min_dy = max(-k["rect"][1] for k in keys)
    max_dy = min(1 - k["rect"][1] - k["rect"][3] for k in keys)
    ox = clamp(dx, min(0, min_dx), max(0, max_dx))
    oy = clamp(dy, min(0, min_dy), max(0, max_dy))
    return dict(mask, keys=[dict(k, rect=[k["rect"][0] + ox, k["rect"][1] + oy, k["rect"][2], k["rect"][3]]) for k in keys])


def timeline_to_source_unclamped(clip: Clip, t_ms: float) -> Any:
    if "holdMs" in clip:
        return clip["inMs"]
    return clip["inMs"] + (t_ms - clip["startMs"]) * effective_speed(clip.get("speed"))


def retime_mask_edge(mask: Mask, edge: str, source_ms: float, source_duration_ms: Any) -> Mask:
    ms = js_round(source_ms)
    if edge == "start":
        return _fit_mask_fades(dict(mask, startMs=clamp(ms, 0, mask["endMs"] - MIN_MASK_SPAN_MS)), edge)
    limit = source_duration_ms if source_duration_ms > 0 else math.inf
    return _fit_mask_fades(dict(mask, endMs=clamp(ms, mask["startMs"] + MIN_MASK_SPAN_MS, limit)), edge)


def next_mask_id(masks: Sequence[Mask]) -> str:
    return next_prefixed_id("m", [m["id"] for m in masks])


def replace_mask(masks: Sequence[Mask], nxt: Mask) -> List[Mask]:
    return [nxt if m["id"] == nxt["id"] else m for m in masks]


# ── helpers kb builds on (not in the TS modules) ──────────────────────────────


def clip_frames(clips: Sequence[Clip], fps: float) -> List[Tuple[int, int]]:
    """(startFrame, frames) per clip in timeline order on the render's cumulative grid (edit.rs build_render_args)."""
    out: List[Tuple[int, int]] = []
    cursor: Any = 0
    for clip in sorted(clips, key=lambda c: c["startMs"]):
        start = frame_at(cursor, fps)
        cursor = cursor + clip_timeline_ms(clip)
        out.append((start, max(1, frame_at(cursor, fps) - start)))
    return out


def total_frames(clips: Sequence[Clip], fps: float) -> int:
    return max(1, sum(f for _, f in clip_frames(clips, fps))) if clips else 0
