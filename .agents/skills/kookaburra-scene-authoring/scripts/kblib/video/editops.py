"""Mirror of src/engine/editOps.ts: one pure op per EditorApp handler, then commitDoc's pruneOrphanMasks.

apply_op relays the doc's clips out first and never mutates its input. Check order: argument shape (bad-arg), then
lookups (unknown-*), then the handler's own refusals; where a handler silently does nothing the op raises OpError
with the contract's code. Times named atMs are timeline ms (may be fractional); source times are integers. Pinned
by fixtures/edit-vectors.json.
"""

from __future__ import annotations

import math
import re
from collections import namedtuple
from typing import Any, Dict, List, Optional, Tuple

from . import editmath as em

OP_NAMES = (
    "addClip", "insertClip", "split", "freeze", "removeClip", "moveClip", "setSpeed", "trimIn", "trimOut", "setHold",
    "setClipCrop", "addTap", "addTapAtSource", "moveTap", "retimeTap", "removeTap", "setTapLook",
    "addMask", "setMaskRect", "offsetMask", "addMaskKey", "removeMaskKey", "retimeMaskEdge", "setMaskLook", "setMaskFade",
    "removeMask",
)
ERROR_CODES = (
    "no-clip", "no-split", "no-freeze", "unknown-clip", "unknown-tap", "unknown-mask", "unknown-source",
    "source-mismatch", "image-source", "no-change", "bad-arg",
)
MASK_STYLES = ("solid", "blur", "pixelate")
HEX_COLOUR = re.compile(r"#[0-9a-fA-F]{6}", re.ASCII)
TAP_LABELS = {"style": "change tap style", "color": "change tap colour", "size": "resize tap"}
MASK_LABELS = {"style": "change mask style", "strength": "change mask strength", "color": "change mask colour"}

OpResult = namedtuple("OpResult", "doc label created pruned", defaults=(None, ()))


class OpError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


Doc = Dict[str, Any]


def edit_fps(doc: Doc) -> Any:
    return em.output_fps(doc)


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _integer(v: Any) -> bool:
    """Number.isInteger: any finite number with no fraction (2.0 counts)."""
    return _num(v) and float(v).is_integer()


def _id(v: Any) -> bool:
    return isinstance(v, str) and len(v) > 0


def _given(op: Dict[str, Any], key: str) -> bool:
    return op.get(key) is not None


def _pos(v: Any) -> bool:
    return isinstance(v, list) and len(v) == 2 and all(_num(n) and 0 <= n <= 1 for n in v)


def _rect(v: Any) -> bool:
    return isinstance(v, list) and len(v) == 4 and all(_num(n) for n in v)


def _crop(v: Any) -> bool:
    return _rect(v) and v[2] > 0 and v[3] > 0


def _same_rect(a: Any, b: Any) -> bool:
    return a is b or (a is not None and b is not None and all(x == y for x, y in zip(a, b)))


def _fade_problem(op: Dict[str, Any], key: str) -> Optional[str]:
    v = op.get(key)
    return None if v is None or (_num(v) and v >= 0) else f"{key} must be 0 or more ms"


def _fmt(v: Any) -> str:
    return f"{v:g}" if _num(v) else str(v)


def _source_problem(s: Any) -> Optional[str]:
    if not isinstance(s, dict):
        return "source must be an object"
    if not _id(s.get("rel")):
        return "source.rel must be a project-relative path"
    if s.get("kind") not in ("video", "image"):
        return 'source.kind must be "video" or "image"'
    for key in ("width", "height", "durationMs"):
        if not _integer(s.get(key)) or s[key] < 0:
            return f"source.{key} must be a whole number"
    if not _num(s.get("fps")) or s["fps"] < 0:
        return "source.fps must be a number"
    return None


def _look_problem(op: Dict[str, Any]) -> Optional[str]:
    if _given(op, "style") and op["style"] not in MASK_STYLES:
        return "style must be solid, blur or pixelate"
    if _given(op, "strength") and not (_num(op["strength"]) and 0 <= op["strength"] <= 1):
        return "strength must be 0 to 1"
    if _given(op, "color") and not (isinstance(op["color"], str) and HEX_COLOUR.fullmatch(op["color"])):
        return "color must be #rrggbb"
    return None


def _at_problem(op: Dict[str, Any]) -> Optional[str]:
    return None if _num(op.get("atMs")) else "atMs must be a finite number"


def _bad(problem: Optional[str]) -> None:
    if problem:
        raise OpError("bad-arg", problem)


def _find(items: List[Dict[str, Any]], ident: Any, what: str, example: str) -> Dict[str, Any]:
    if not _id(ident):
        raise OpError("bad-arg", f"{what}Id must be a {what} id like {example}")
    for item in items:
        if item["id"] == ident:
            return item
    raise OpError(f"unknown-{what}", f"No {what} {ident} in this edit.")


def _clip(doc: Doc, ident: Any) -> Dict[str, Any]:
    return _find(doc["clips"], ident, "clip", "c1")


def _tap(doc: Doc, ident: Any) -> Dict[str, Any]:
    return _find(doc.get("taps") or [], ident, "tap", "t1")


def _mask(doc: Doc, ident: Any) -> Dict[str, Any]:
    return _find(doc.get("masks") or [], ident, "mask", "m1")


def _no_moment(at: Any) -> OpError:
    return OpError("no-clip", f"Nothing plays at {_fmt(at)}ms: move onto a clip of the timeline.")


def _no_tap_moment(at: Any) -> OpError:
    return OpError("no-clip", f"No tap moment at {_fmt(at)}ms: it is off the timeline or on a freeze or still, which have no moment to anchor a tap.")


def _mismatch(mask: Dict[str, Any], source_id: str) -> OpError:
    return OpError("source-mismatch", f"{mask['id']} is on {mask['sourceId']} but that frame shows {source_id}: pick a frame of {mask['sourceId']}.")


def _hold_clip(clip: Dict[str, Any]) -> OpError:
    return OpError("bad-arg", f"{clip['id']} is a freeze or still: set its hold instead.")


def _mask_moment(doc: Doc, at: Any) -> Optional[Dict[str, Any]]:
    moment = em.source_moment_at(doc["clips"], at)
    if moment is None:
        return None
    source = next((s for s in doc["sources"] if s["id"] == moment["sourceId"]), None)
    return {
        "moment": moment,
        "tolMs": em.key_tolerance_ms(edit_fps(doc), 1 if moment["hold"] else moment["clip"].get("speed")),
        "image": bool(source is not None and source.get("kind") == "image"),
    }


def _splice_source(doc: Doc, meta: Dict[str, Any]) -> Tuple[Doc, Dict[str, Any]]:
    """spliceClip: reuse the source by rel, else add it; the clip takes the probe's kind and length."""
    existing = next((s for s in doc["sources"] if s["rel"] == meta["rel"]), None)
    source_id = existing["id"] if existing else em.next_source_id(doc["sources"])
    sources = doc["sources"] if existing else list(doc["sources"]) + [{
        "id": source_id, "rel": meta["rel"], "kind": meta["kind"], "width": meta["width"], "height": meta["height"],
        "fps": meta["fps"], "durationMs": meta["durationMs"],
    }]
    if meta["kind"] == "image":
        clip = em.image_clip(doc["clips"], source_id, em.DEFAULT_HOLD_MS)
    else:
        clip = {"id": em.next_clip_id(doc["clips"]), "sourceId": source_id, "inMs": 0, "outMs": meta["durationMs"], "speed": 1, "startMs": 0}
    return dict(doc, sources=sources), clip


def _with_mask(doc: Doc, mask: Dict[str, Any]) -> Doc:
    return dict(doc, masks=em.replace_mask(doc.get("masks") or [], mask))


def _without(mask: Dict[str, Any], key: str) -> Dict[str, Any]:
    out = dict(mask)
    out.pop(key, None)
    return out


def _done(draft: Doc, label: str, created: Optional[str] = None) -> OpResult:
    """commitDoc: a mask no clip shows any more goes with the edit that orphaned it."""
    masks = draft.get("masks")
    if masks is None:
        return OpResult(draft, label, created, ())
    kept = em.prune_orphan_masks(draft["clips"], masks, draft["sources"])
    if kept is masks:
        return OpResult(draft, label, created, ())
    ids = {m["id"] for m in kept}
    return OpResult(dict(draft, masks=list(kept)), label, created, tuple(m["id"] for m in masks if m["id"] not in ids))


def _int(v: Any) -> Any:
    return int(v) if isinstance(v, float) and v.is_integer() else v


def apply_op(input_doc: Doc, op: Any) -> OpResult:
    """applyEditOp: one editor op; raises OpError and leaves the doc untouched when the editor would do nothing."""
    if not isinstance(op, dict):
        raise OpError("bad-arg", "An op must be an object.")
    doc = dict(input_doc, clips=em.relayout(input_doc["clips"]))
    name = op.get("op")
    clips = doc["clips"]

    if name == "addClip":
        _bad(_source_problem(op.get("source")))
        if _given(op, "index") and not _integer(op["index"]):
            raise OpError("bad-arg", "index must be a whole clip position")
        with_source, clip = _splice_source(doc, op["source"])
        nxt = list(with_source["clips"])
        index = int(op["index"]) if _given(op, "index") else len(nxt)
        nxt.insert(max(0, min(len(nxt), index)), clip)
        return _done(dict(with_source, clips=em.relayout(nxt)), "add clip", clip["id"])

    if name == "insertClip":
        _bad(_source_problem(op.get("source")) or _at_problem(op))
        with_source, clip = _splice_source(doc, op["source"])
        return _done(dict(with_source, clips=em.insert_clip_at(with_source["clips"], op["atMs"], clip)), "insert clip", clip["id"])

    if name == "split":
        _bad(_at_problem(op))
        if em.clip_index_at(clips, op["atMs"]) < 0:
            raise _no_moment(op["atMs"])
        new_id = em.next_clip_id(clips)
        out = em.split_at(clips, op["atMs"], new_id)
        if out is None:
            raise OpError("no-split", f"Can't split at {_fmt(op['atMs'])}ms: it is on a freeze or still, or a half would be under 100ms of source.")
        return _done(dict(doc, clips=out), "split clip", new_id)

    if name == "freeze":
        hold = op["holdMs"] if _given(op, "holdMs") else em.DEFAULT_HOLD_MS
        _bad(_at_problem(op) or (None if _num(hold) and hold > 0 else "holdMs must be > 0"))
        if not clips:
            raise _no_moment(op["atMs"])
        fps = edit_fps(doc)
        at_end = abs(op["atMs"] - em.timeline_duration_ms(clips)) <= 500 / fps
        if not at_end and em.clip_index_at(clips, op["atMs"]) < 0:
            raise _no_moment(op["atMs"])
        new_id = em.next_clip_id(clips)
        out = em.freeze_at_end(clips, fps, hold) if at_end else em.freeze_at(clips, op["atMs"], hold)
        if out is None:
            raise OpError("no-freeze", f"Can't freeze at {_fmt(op['atMs'])}ms: that frame is already a hold.")
        return _done(dict(doc, clips=out), "freeze frame", new_id)

    if name == "removeClip":
        clip = _clip(doc, op.get("clipId"))
        return _done(dict(doc, clips=em.remove_clip(clips, clip["id"])), "remove clip")

    if name == "moveClip":
        frm, to = op.get("from"), op.get("to")
        if not _integer(frm) or not _integer(to):
            raise OpError("bad-arg", "from and to must be whole clip positions")
        frm, to = int(frm), int(to)
        if frm < 0 or frm >= len(clips):
            raise OpError("bad-arg", f"from must be a clip position, 0 to {len(clips) - 1}")
        return _done(dict(doc, clips=list(em.move_clip(clips, frm, to))), "reorder clip")

    if name == "setSpeed":
        if not _num(op.get("speed")) or op["speed"] <= 0:
            raise OpError("bad-arg", "speed must be > 0")
        clip = _clip(doc, op.get("clipId"))
        if "holdMs" in clip:
            raise _hold_clip(clip)
        return _done(dict(doc, clips=em.set_clip_speed(clips, clip["id"], op["speed"])), "change clip speed")

    if name == "trimIn":
        if not _num(op.get("inMs")):
            raise OpError("bad-arg", "inMs must be a number")
        clip = _clip(doc, op.get("clipId"))
        if "holdMs" in clip:
            raise _hold_clip(clip)
        return _done(dict(doc, clips=em.trim_clip_in(clips, clip["id"], op["inMs"])), "trim clip start")

    if name == "trimOut":
        if not _num(op.get("outMs")):
            raise OpError("bad-arg", "outMs must be a number")
        clip = _clip(doc, op.get("clipId"))
        if "holdMs" in clip:
            raise _hold_clip(clip)
        source = next((s for s in doc["sources"] if s["id"] == clip["sourceId"]), None)
        limit = source["durationMs"] if source is not None and source.get("durationMs") is not None else clip["outMs"]
        return _done(dict(doc, clips=em.trim_clip_out(clips, clip["id"], op["outMs"], limit)), "trim clip end")

    if name == "setHold":
        if not _num(op.get("holdMs")) or op["holdMs"] <= 0:
            raise OpError("bad-arg", "holdMs must be > 0")
        clip = _clip(doc, op.get("clipId"))
        if "holdMs" not in clip:
            raise OpError("bad-arg", f"{clip['id']} is not a freeze or still: change its speed or trim it instead.")
        return _done(dict(doc, clips=em.set_clip_hold(clips, clip["id"], op["holdMs"])), "retime freeze")

    if name == "setClipCrop":
        reset = "crop" in op and op["crop"] is None
        if not reset and not _crop(op.get("crop")):
            raise OpError("bad-arg", "crop must be [x, y, w, h] numbers with w and h > 0, or null")
        clip = _clip(doc, op.get("clipId"))
        source = next((s for s in doc["sources"] if s["id"] == clip["sourceId"]), None)
        if source is None:
            raise OpError("unknown-source", f"No source {clip['sourceId']} in this edit.")
        if reset:
            if not clip.get("crop"):
                raise OpError("no-change", f"{clip['id']} has no crop.")
            return _done(dict(doc, clips=em.set_clip_crop(clips, clip["id"], None)), "reset crop")
        if source["width"] < 2 or source["height"] < 2:
            raise OpError("bad-arg", f"{source['id']} has no pixel size to crop against.")
        crop = em.snap_crop_rect(op["crop"], source)
        if _same_rect(crop, clip.get("crop")):
            raise OpError("no-change", f"{clip['id']} already has that crop.")
        return _done(dict(doc, clips=em.set_clip_crop(clips, clip["id"], crop)), "crop clip")

    if name == "addTap":
        _bad(_at_problem(op) or (None if _pos(op.get("pos")) else "pos must be [x, y] in 0..1"))
        at = em.output_to_source(clips, op["atMs"])
        if at is None:
            raise _no_tap_moment(op["atMs"])
        taps = doc.get("taps") or []
        tap_id = em.next_tap_id(taps)
        return _done(dict(doc, taps=em.add_tap(taps, {"id": tap_id, "sourceId": at["sourceId"], "sourceMs": at["sourceMs"], "pos": list(op["pos"])})), "add tap", tap_id)

    if name == "addTapAtSource":
        if not _id(op.get("sourceId")):
            raise OpError("bad-arg", "sourceId must be a source id like s1")
        if not _integer(op.get("sourceMs")) or op["sourceMs"] < 0:
            raise OpError("bad-arg", "sourceMs must be a whole number of source ms")
        if not _pos(op.get("pos")):
            raise OpError("bad-arg", "pos must be [x, y] in 0..1")
        source = next((s for s in doc["sources"] if s["id"] == op["sourceId"]), None)
        if source is None:
            raise OpError("unknown-source", f"No source {op['sourceId']} in this edit.")
        if source.get("kind") == "image":
            raise OpError("image-source", f"{source['id']} is a still: a tap needs a video moment.")
        taps = doc.get("taps") or []
        tap_id = em.next_tap_id(taps)
        return _done(dict(doc, taps=em.add_tap(taps, {"id": tap_id, "sourceId": source["id"], "sourceMs": _int(op["sourceMs"]), "pos": list(op["pos"])})), "add tap", tap_id)

    if name == "moveTap":
        if not _pos(op.get("pos")):
            raise OpError("bad-arg", "pos must be [x, y] in 0..1")
        tap = _tap(doc, op.get("tapId"))
        return _done(dict(doc, taps=em.move_tap(doc.get("taps") or [], tap["id"], op["pos"])), "move tap")

    if name == "retimeTap":
        _bad(_at_problem(op))
        tap = _tap(doc, op.get("tapId"))
        at = em.output_to_source(clips, op["atMs"])
        if at is None:
            raise _no_tap_moment(op["atMs"])
        return _done(dict(doc, taps=em.retime_tap(doc.get("taps") or [], tap["id"], at["sourceId"], at["sourceMs"])), "retime tap")

    if name == "removeTap":
        tap = _tap(doc, op.get("tapId"))
        return _done(dict(doc, taps=em.remove_tap(doc.get("taps") or [], tap["id"])), "delete tap")

    if name == "setTapLook":
        fields = [k for k in ("style", "color", "size") if _given(op, k)]
        if not fields:
            raise OpError("bad-arg", "Give a style, color or size.")
        if _given(op, "style") and not _id(op["style"]):
            raise OpError("bad-arg", "style must be a tap style id")
        if _given(op, "color") and not _id(op["color"]):
            raise OpError("bad-arg", "color must be a tap colour id")
        if _given(op, "size") and not (_num(op["size"]) and op["size"] > 0):
            raise OpError("bad-arg", "size must be > 0")
        nxt = dict(doc)
        if _given(op, "style"):
            nxt["tapStyle"] = op["style"]
        if _given(op, "color"):
            nxt["tapColor"] = op["color"]
        if _given(op, "size"):
            nxt["tapSize"] = op["size"]
        return _done(nxt, TAP_LABELS[fields[0]] if len(fields) == 1 else "change tap look")

    if name == "addMask":
        _bad(_at_problem(op) or (None if _rect(op.get("rect")) else "rect must be [x, y, w, h] numbers") or _look_problem(op))
        at = _mask_moment(doc, op["atMs"])
        if at is None:
            raise _no_moment(op["atMs"])
        source = next((s for s in doc["sources"] if s["id"] == at["moment"]["sourceId"]), None)
        if source is None:
            raise OpError("unknown-source", f"No source {at['moment']['sourceId']} in this edit.")
        masks = doc.get("masks") or []
        rng = {"startMs": 0, "endMs": 0} if at["image"] else em.default_mask_range(at["moment"], source)
        mask: Dict[str, Any] = {
            "id": em.next_mask_id(masks),
            "sourceId": source["id"],
            "style": "solid",
            "startMs": rng["startMs"],
            "endMs": rng["endMs"],
            "keys": [{"sourceMs": 0 if at["image"] else at["moment"]["sourceMs"], "rect": em.clamp_rect(op["rect"])}],
        }
        for key in ("style", "strength", "color"):
            if _given(op, key):
                mask = dict(mask, **{key: op[key]})
        return _done(dict(doc, masks=list(masks) + [mask]), "add mask", mask["id"])

    if name == "setMaskRect":
        _bad(_at_problem(op) or (None if _rect(op.get("rect")) else "rect must be [x, y, w, h] numbers"))
        mask = _mask(doc, op.get("maskId"))
        at = _mask_moment(doc, op["atMs"])
        if at is None:
            raise _no_moment(op["atMs"])
        if at["moment"]["sourceId"] != mask["sourceId"]:
            raise _mismatch(mask, at["moment"]["sourceId"])
        return _done(_with_mask(doc, em.upsert_mask_key(mask, at["moment"]["sourceMs"], op["rect"], at["tolMs"], at["image"])), "move mask")

    if name == "offsetMask":
        if not _num(op.get("dx")) or not _num(op.get("dy")):
            raise OpError("bad-arg", "dx and dy must be numbers")
        mask = _mask(doc, op.get("maskId"))
        return _done(_with_mask(doc, em.offset_mask_keys(mask, op["dx"], op["dy"])), "move mask path")

    if name in ("addMaskKey", "removeMaskKey"):
        _bad(_at_problem(op))
        mask = _mask(doc, op.get("maskId"))
        at = _mask_moment(doc, op["atMs"])
        if at is None:
            raise _no_moment(op["atMs"])
        adding = name == "addMaskKey"
        if adding and at["image"]:
            raise OpError("image-source", "A mask on a still is one static box: it has no keys to add.")
        if at["moment"]["sourceId"] != mask["sourceId"]:
            raise _mismatch(mask, at["moment"]["sourceId"])
        sms = at["moment"]["sourceMs"]
        nxt = em.add_hold_key(mask, sms, at["tolMs"]) if adding else em.remove_mask_key(mask, sms, at["tolMs"])
        if nxt is mask:
            raise OpError("no-change", f"{mask['id']} already has a key at {_fmt(op['atMs'])}ms." if adding else f"{mask['id']} has no key at {_fmt(op['atMs'])}ms to delete, or only one key left.")
        return _done(_with_mask(doc, nxt), "add mask key" if adding else "delete mask key")

    if name == "retimeMaskEdge":
        if op.get("edge") not in ("start", "end"):
            raise OpError("bad-arg", 'edge must be "start" or "end"')
        if not _num(op.get("sourceMs")):
            raise OpError("bad-arg", "sourceMs must be a number")
        mask = _mask(doc, op.get("maskId"))
        source = next((s for s in doc["sources"] if s["id"] == mask["sourceId"]), None)
        if source is not None and source.get("kind") == "image":
            raise OpError("image-source", "A mask on a still covers every frame: it has no span.")
        duration = source["durationMs"] if source is not None and source.get("durationMs") is not None else 0
        return _done(_with_mask(doc, em.retime_mask_edge(mask, op["edge"], op["sourceMs"], duration)), "retime mask")

    if name == "setMaskLook":
        fields = [k for k in ("style", "strength", "color") if (_given(op, k) if k == "style" else k in op)]
        if not fields:
            raise OpError("bad-arg", "Give a style, strength or color.")
        _bad(_look_problem(op))
        mask = _mask(doc, op.get("maskId"))
        if fields == ["style"] and op["style"] == mask.get("style"):
            raise OpError("no-change", f"{mask['id']} is already {mask.get('style')}.")
        nxt = mask
        if _given(op, "style"):
            nxt = dict(nxt, style=op["style"])
        for key in ("strength", "color"):
            if key not in op:
                continue
            nxt = _without(nxt, key) if op[key] is None else dict(nxt, **{key: op[key]})
        return _done(_with_mask(doc, nxt), MASK_LABELS[fields[0]] if len(fields) == 1 else "change mask look")

    if name == "setMaskFade":
        if "fadeInMs" not in op and "fadeOutMs" not in op:
            raise OpError("bad-arg", "Give a fadeInMs or fadeOutMs.")
        _bad(_fade_problem(op, "fadeInMs") or _fade_problem(op, "fadeOutMs"))
        mask = _mask(doc, op.get("maskId"))
        source = next((s for s in doc["sources"] if s["id"] == mask["sourceId"]), None)
        if source is not None and source.get("kind") == "image":
            raise OpError("image-source", "A mask on a still covers every frame: it has no span to fade.")

        def pick(key: str) -> Any:
            if key not in op:
                return mask.get(key) or 0
            return 0 if op[key] is None else em.js_round(op[key])

        fade_in, fade_out = pick("fadeInMs"), pick("fadeOutMs")
        span = mask["endMs"] - mask["startMs"]
        if fade_in + fade_out > span:
            raise OpError("bad-arg", f"Fades of {_fmt(fade_in)} + {_fmt(fade_out)}ms don't fit {mask['id']}'s {_fmt(span)}ms span.")
        if fade_in == (mask.get("fadeInMs") or 0) and fade_out == (mask.get("fadeOutMs") or 0):
            raise OpError("no-change", f"{mask['id']} already fades like that.")
        return _done(_with_mask(doc, em.with_mask_fades(mask, fade_in, fade_out)), "change mask fade")

    if name == "removeMask":
        mask = _mask(doc, op.get("maskId"))
        return _done(dict(doc, masks=[m for m in doc.get("masks") or [] if m["id"] != mask["id"]]), "delete mask")

    raise OpError("bad-arg", f"Unknown op {name}.")
