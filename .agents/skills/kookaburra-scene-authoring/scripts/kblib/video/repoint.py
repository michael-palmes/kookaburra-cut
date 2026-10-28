"""Point a scene slot at an edit's render, on RAW sidecar JSON, exactly as the app's applyEditRepoint writes it.

Mirrors src/engine/sceneDoc.ts (applyEditRepoint, followMediaSlots, followMediaLengthMs, followMediaDurationMs),
src/engine/sceneMedia.ts (the legacy images/videoWindow promotion), src/engine/deviceScreens.ts (device and
comparison slots) and the parse defaults in src/engine/sceneDocSchema.ts (parseDeviceMediaKeys among them) that
the app's write bakes into the touched subtrees. Everything outside those subtrees stays as authored. Pinned by
fixtures/repoint-vectors.json.
"""

from __future__ import annotations

import copy
import math
from typing import Any, Dict, List, Optional, Tuple

from ..lock import mutate_json
from ..util import EXIT_PROBLEMS, KbError, is_int, js_json, load_json_text
from .editmath import js_round

SCENE_DOC_VERSION = 1
# kb slot name -> the app's EditRepointSlot
SLOTS = {
    "background": "background",
    "media": "media",
    "window": "videoWindow",
    "device": "device",
    "device-cover": "deviceCover",
    "compare-device": "compareDevice",
    "compare-device-cover": "compareDeviceCover",
}
SLOT_HELP = "background, media[:ID], window, device[:ID], device-cover[:ID], compare-device[:ID] or compare-device-cover[:ID]"
VIDEO_WINDOW_MEDIA_ID = "videoWindow"
DEFAULT_WINDOW_RADIUS = "macos"
DEFAULT_VIDEO_WINDOW_SCALE = 0.72
IMAGE_STAGE = {"position": [0, 0, 0], "size": 1, "rotationDeg": [0, 0, 0]}
IMAGE_OVERLAY = {"position": [0, 0], "size": 0.25, "rotationDeg": 0, "shape": "none", "layer": "above"}
VIDEO_STAGE = {"position": [0, 0, 0], "size": 5.3, "rotationDeg": [0, 0, 0]}
VIDEO_OVERLAY = {"position": [0, 0], "size": DEFAULT_VIDEO_WINDOW_SCALE, "rotationDeg": 0, "shape": "none", "layer": "below"}
IMAGE_MOTION_PRESETS = ("none", "turntable", "float", "tilt-reveal", "push-in")
MEDIA_MOTION_PRESETS = ("none", "turntable", "float", "tilt-reveal", "push-in", "drift")
RADIUS_PRESETS = ("sharp", "subtle", "macos", "rounded")
IMAGE_EXTS = {"png", "jpg", "jpeg", "webp"}
SCREEN_FIELD = {"main": "media", "cover": "coverMedia"}
KEYED_TRACKS = (("camera",), ("cameraRig",), ("deviceTrack",), ("lighting",), ("compare", "track"), ("chart", "track"), ("layeredScreenshot", "animation"))
# A device screen's source-timing keys (DeviceMediaSpec), in the parser's order.
PLAYBACK_KEYS = ("inMs", "outMs", "speed", "loop", "posterMs")
SPEED_MAX = 16
MIN_FOLLOW_MS = 17
RETIMED_HINT = "drop the slot's timing first (./kb doc S unset devices.N.media.inMs, and outMs, speed, loop, posterMs), or trim and retime the edit itself"


class Unparseable(KbError):
    pass


# ── JS-faithful predicates ────────────────────────────────────────────────────


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _rec(v: Any) -> bool:
    return isinstance(v, dict)


def _v3(v: Any) -> bool:
    return isinstance(v, list) and len(v) == 3 and all(_num(n) for n in v)


def _v2(v: Any) -> bool:
    return isinstance(v, list) and len(v) == 2 and all(_num(n) for n in v)


def _clamp(v: Any, lo: Any, hi: Any) -> Any:
    return min(hi, max(lo, v))


def normalise_deg(deg: Any) -> Any:
    if not _num(deg):
        return 0
    d = math.fmod(deg, 360)
    if d <= -180:
        d += 360
    elif d > 180:
        d -= 360
    return 0 if d == 0 else d


def project_asset_path(v: Any) -> bool:
    if not isinstance(v, str):
        return False
    parts = v.split("/")
    return parts[0] == "assets" and len(parts) >= 2 and not any(p in ("", ".", "..") for p in parts)


def scene_image_source(v: Any) -> bool:
    if not project_asset_path(v):
        return False
    return v.split("/")[-1].split(".")[-1].lower() in IMAGE_EXTS


def _spread(v: Any) -> Dict[str, Any]:
    """JavaScript object spread of any value."""
    if isinstance(v, dict):
        return dict(v)
    if isinstance(v, (list, str)):
        return {str(i): x for i, x in enumerate(v)}
    return {}


def _truthy(v: Any) -> bool:
    if isinstance(v, float) and math.isnan(v):
        return False
    return bool(v) or isinstance(v, (dict, list))


# ── the parse defaults the app's write bakes in ───────────────────────────────


def _stage(raw: Any, defaults: Dict[str, Any]) -> Dict[str, Any]:
    if not _rec(raw):
        return {"position": list(defaults["position"]), "size": defaults["size"], "rotationDeg": list(defaults["rotationDeg"])}
    return {
        "position": list(raw["position"]) if _v3(raw.get("position")) else list(defaults["position"]),
        "size": raw["size"] if _num(raw.get("size")) and raw["size"] > 0 else defaults["size"],
        "rotationDeg": [normalise_deg(d) for d in raw["rotationDeg"]] if _v3(raw.get("rotationDeg")) else list(defaults["rotationDeg"]),
    }


def _overlay(raw: Any, defaults: Dict[str, Any]) -> Dict[str, Any]:
    if not _rec(raw):
        return {k: (list(defaults[k]) if k == "position" else defaults[k]) for k in ("position", "size", "rotationDeg", "shape", "layer")}
    out = {
        "position": list(raw["position"]) if _v2(raw.get("position")) else list(defaults["position"]),
        "size": raw["size"] if _num(raw.get("size")) and raw["size"] > 0 else defaults["size"],
        "rotationDeg": normalise_deg(raw["rotationDeg"]) if _num(raw.get("rotationDeg")) else defaults["rotationDeg"],
        "shape": "circle" if raw.get("shape") == "circle" else "none",
        "layer": "below" if raw.get("layer") == "below" else "above",
    }
    if _num(raw.get("stackOrder")):
        out["stackOrder"] = raw["stackOrder"]
    return out


def _motion(raw: Any, presets: Tuple[str, ...]) -> Optional[Dict[str, Any]]:
    if not _rec(raw):
        return None
    out: Dict[str, Any] = {"preset": raw.get("preset") if raw.get("preset") in presets else presets[0]}
    for field in ("degPerSec", "amplitude", "hz", "durationMs"):
        if field not in raw:
            continue
        v = raw[field]
        if _num(v) and (field == "degPerSec" or (v > 0 if field == "durationMs" else v >= 0)):
            out[field] = v
    return out


def parse_images(raw: Any) -> Optional[List[Dict[str, Any]]]:
    if not isinstance(raw, list):
        return None
    images: List[Dict[str, Any]] = []
    seen = set()
    for entry in raw:
        if not _rec(entry) or not isinstance(entry.get("id"), str) or not entry["id"]:
            continue
        if entry["id"] in seen:
            continue
        if not scene_image_source(entry.get("src")):
            continue
        seen.add(entry["id"])
        image: Dict[str, Any] = {
            "id": entry["id"],
            "src": entry["src"],
            "host": "overlay" if entry.get("host") == "overlay" else "stage",
            "stage": _stage(entry.get("stage"), IMAGE_STAGE),
            "overlay": _overlay(entry.get("overlay"), IMAGE_OVERLAY),
        }
        if "motion" in entry:
            motion = _motion(entry["motion"], IMAGE_MOTION_PRESETS)
            if motion:
                image["motion"] = motion
        if isinstance(entry.get("castShadow"), bool):
            image["castShadow"] = entry["castShadow"]
        images.append(image)
    return images


def _radius(raw: Any) -> Any:
    if isinstance(raw, str) and raw in RADIUS_PRESETS:
        return raw
    if _rec(raw) and _num(raw.get("custom")):
        return {"custom": raw["custom"]}
    return DEFAULT_WINDOW_RADIUS


def _window(raw: Any) -> Optional[Dict[str, Any]]:
    if not _rec(raw):
        return None
    out: Dict[str, Any] = {"radius": _radius(raw.get("radius"))}
    if isinstance(raw.get("recording"), bool):
        out["recording"] = raw["recording"]
    if _rec(raw.get("border")):
        out["border"] = raw["border"]
    if _rec(raw.get("shadow")):
        out["shadow"] = raw["shadow"]
    return out


def _video(raw: Any) -> Dict[str, Any]:
    if not _rec(raw):
        return {}
    out: Dict[str, Any] = {}
    if _num(raw.get("startMs")):
        out["startMs"] = raw["startMs"]
    if isinstance(raw.get("loop"), bool):
        out["loop"] = raw["loop"]
    if _num(raw.get("aspect")) and raw["aspect"] > 0:
        out["aspect"] = raw["aspect"]
    return out


def _media_host(raw: Any, kind: str) -> str:
    if kind == "video":
        if raw == "stage":
            return "stage"
        return "overlay" if raw == "overlay" else "window"
    if raw == "window":
        return "overlay"
    return "overlay" if raw == "overlay" else "stage"


def parse_media(raw: Any) -> Optional[List[Dict[str, Any]]]:
    if not isinstance(raw, list):
        return None
    media: List[Dict[str, Any]] = []
    seen = set()
    for entry in raw:
        if not _rec(entry) or not isinstance(entry.get("id"), str) or not entry["id"]:
            continue
        if entry["id"] in seen:
            continue
        kind = "video" if entry.get("kind") == "video" else "image"
        video = kind == "video"
        src = entry.get("src")
        if not (project_asset_path(src) if video else scene_image_source(src)):
            continue
        seen.add(entry["id"])
        item: Dict[str, Any] = {
            "id": entry["id"],
            "kind": kind,
            "src": src,
            "host": _media_host(entry.get("host"), kind),
            "stage": _stage(entry.get("stage"), VIDEO_STAGE if video else IMAGE_STAGE),
            "overlay": _overlay(entry.get("overlay"), VIDEO_OVERLAY if video else IMAGE_OVERLAY),
        }
        if "motion" in entry:
            motion = _motion(entry["motion"], MEDIA_MOTION_PRESETS)
            if motion:
                item["motion"] = motion
        if isinstance(entry.get("castShadow"), bool):
            item["castShadow"] = entry["castShadow"]
        if "window" in entry:
            window = _window(entry["window"])
            if window:
                item["window"] = window
        if video:
            item["video"] = _video(entry.get("video"))
        media.append(item)
    return media


def _valid_video_window(raw: Any) -> bool:
    if not _rec(raw):
        return False
    media = raw.get("media")
    return _truthy(media) and _rec(media) and isinstance(media.get("src"), str) and len(media["src"]) > 0


def _from_image(image: Dict[str, Any]) -> Dict[str, Any]:
    entry: Dict[str, Any] = {
        "id": image["id"],
        "kind": "image",
        "src": image["src"],
        "host": image["host"],
        "stage": {"position": list(image["stage"]["position"]), "size": image["stage"]["size"], "rotationDeg": list(image["stage"]["rotationDeg"])},
        "overlay": dict(image["overlay"], position=list(image["overlay"]["position"])),
    }
    if image.get("motion"):
        entry["motion"] = dict(image["motion"])
    if "castShadow" in image:
        entry["castShadow"] = image["castShadow"]
    return entry


def _window_overlay(window: Dict[str, Any]) -> Dict[str, Any]:
    offset = window.get("offset") if _v2(window.get("offset")) else [0, 0]
    scale = window.get("scale")
    return {
        "position": [_clamp(offset[0], -1, 1) * 2, _clamp(offset[1], -1, 1) * 2],
        "size": _clamp(scale, 0.1, 1) if _num(scale) else DEFAULT_VIDEO_WINDOW_SCALE,
        "rotationDeg": 0,
        "shape": "none",
        "layer": "below",
    }


def _from_video_window(window: Dict[str, Any]) -> Dict[str, Any]:
    radius = window.get("radius")
    chrome: Dict[str, Any] = {"radius": DEFAULT_WINDOW_RADIUS if radius is None else radius}
    if "recording" in window:
        chrome["recording"] = window["recording"]
    if _truthy(window.get("border")):
        chrome["border"] = _spread(window["border"])
    if _truthy(window.get("shadow")):
        shadow = window["shadow"]
        offset = shadow.get("offset") if isinstance(shadow, dict) else None
        if not isinstance(offset, (list, str)):
            raise Unparseable("videoWindow.shadow.offset is not a list, so the app cannot read this sidecar; fix it with kb doc", EXIT_PROBLEMS)
        chrome["shadow"] = dict(_spread(shadow), offset=list(offset))
    media = window["media"]
    video: Dict[str, Any] = {}
    for key in ("startMs", "loop", "aspect"):
        if key in media:
            video[key] = media[key]
    entry: Dict[str, Any] = {
        "id": VIDEO_WINDOW_MEDIA_ID,
        "kind": "video",
        "src": media["src"],
        "host": "window",
        "stage": {"position": [0, 0, 0], "size": VIDEO_STAGE["size"], "rotationDeg": [0, 0, 0]},
        "overlay": _window_overlay(window),
        "window": chrome,
        "video": video,
    }
    if _truthy(window.get("motion")):
        entry["motion"] = _spread(window["motion"])
    return entry


def resolve_media(raw: Dict[str, Any]) -> List[Dict[str, Any]]:
    """resolveSceneDocMedia over the parsed doc: an authored media array wins, else the legacy blocks derive one."""
    authored = parse_media(raw["media"]) if "media" in raw else None
    if authored is not None:
        return authored
    images = parse_images(raw["images"]) if "images" in raw else None
    window = raw.get("videoWindow") if _valid_video_window(raw.get("videoWindow")) else None
    media = [_from_image(i) for i in images or []]
    if window is not None and _truthy((window.get("media") or {}).get("src")):
        media.append(_from_video_window(window))
    return media


def window_entry(media: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for m in media:
        if m.get("kind") == "video" and ("window" in m or m.get("id") == VIDEO_WINDOW_MEDIA_ID):
            return m
    return None


def parsed_devices(raw: Dict[str, Any]) -> List[Dict[str, Any]]:
    devices = raw.get("devices")
    if not isinstance(devices, list):
        return []
    return [d for d in devices if _rec(d) and isinstance(d.get("id"), str) and isinstance(d.get("model"), str)]


def _whole(v: Any) -> bool:
    """Number.isInteger: a finite number with no fraction (2.0 counts)."""
    return _num(v) and float(v).is_integer()


def media_key_problems(spec: Dict[str, Any]) -> List[Tuple[str, str]]:
    """parseDeviceMediaKeys: (key, why) for each source-timing key the app drops, in the parser's order."""
    if not any(k in spec for k in PLAYBACK_KEYS):
        return []
    if spec.get("kind") != "video":
        return [(k, "only applies to a video") for k in PLAYBACK_KEYS if k in spec]
    out: List[Tuple[str, str]] = []
    for key in ("inMs", "outMs", "posterMs"):
        if key in spec and not (_whole(spec[key]) and spec[key] >= 0):
            out.append((key, "isn't a whole number of ms, 0 or more"))
    if "speed" in spec and not (_num(spec["speed"]) and 0 < spec["speed"] <= SPEED_MAX):
        out.append(("speed", f"isn't a number above 0 and at most {SPEED_MAX}"))
    if "loop" in spec and not isinstance(spec["loop"], bool):
        out.append(("loop", "isn't a boolean"))
    dropped = {k for k, _ in out}
    start = spec.get("startMs")
    if "inMs" in spec and "inMs" not in dropped and _num(start) and start < 0:
        out.append(("inMs", "can't combine with a negative startMs (use inMs for a trim and startMs for a delay)"))
        dropped.add("inMs")
    in_ms = spec["inMs"] if "inMs" in spec and "inMs" not in dropped else 0
    if "outMs" in spec and "outMs" not in dropped and spec["outMs"] <= in_ms + 16:
        out.append(("outMs", "trims the whole video (it must pass inMs by more than 16 ms)"))
    return out


def parse_media_keys(spec: Dict[str, Any]) -> Dict[str, Any]:
    """The spec as the app's parse keeps it: bad source-timing keys gone, everything else verbatim (spec itself when nothing drops)."""
    drop = {k for k, _ in media_key_problems(spec)}
    return {k: v for k, v in spec.items() if k not in drop} if drop else spec


def has_playback_keys(spec: Dict[str, Any]) -> bool:
    """clipFrame.ts hasPlaybackKeys, on a parsed spec."""
    return any(k in spec for k in PLAYBACK_KEYS)


def playback_timing(spec: Any) -> Dict[str, Any]:
    """The source-timing keys a screen spec plays with (after the app's parse), {} for none."""
    if not _rec(spec):
        return {}
    parsed = parse_media_keys(spec)
    return {k: parsed[k] for k in PLAYBACK_KEYS if k in parsed}


def parsed_compare_map(raw: Dict[str, Any], field: str) -> Optional[Dict[str, Any]]:
    """compare.b.<media|coverMedia> as parseCompare keeps it (malformed overrides and bad timing keys dropped), or None."""
    compare = raw.get("compare")
    b = compare.get("b") if _rec(compare) else None
    m = b.get(field) if _rec(b) else None
    if not _rec(m):
        return None
    out = {}
    for k, spec in m.items():
        if _rec(spec) and isinstance(spec.get("src"), str) and spec["src"] and spec.get("kind") in ("video", "image"):
            out[k] = parse_media_keys(spec)
    return out or None


def parsed_video_background(raw: Any) -> Optional[Dict[str, Any]]:
    """parseBackgroundSpec for a video fill: {type, src, loop: false?, fit: "fit"?, parallax?}."""
    if not _rec(raw) or raw.get("type") != "video" or not isinstance(raw.get("src"), str) or not raw["src"]:
        return None
    out: Dict[str, Any] = {"type": "video", "src": raw["src"]}
    if raw.get("loop") is False:
        out["loop"] = False
    if raw.get("fit") == "fit":
        out["fit"] = "fit"
    if _num(raw.get("parallax")):
        out["parallax"] = min(0.5, max(0, raw["parallax"]))
    return out


def readable(raw: Any) -> bool:
    """parseSceneDoc accepts the doc at all (an object with version 1)."""
    return _rec(raw) and _num(raw.get("version")) and 1 <= raw["version"] <= SCENE_DOC_VERSION


# ── applyEditRepoint and followMediaSources on raw JSON ───────────────────────


def _repointed_device_media(media: Any, rel: str) -> Dict[str, Any]:
    """repointedDeviceMedia: the render owns the timing, so source-timing keys and a negative startMs go; a delay and startOn stay."""
    nxt = dict(_spread(media), src=rel, kind="video")
    for key in PLAYBACK_KEYS:
        nxt.pop(key, None)
    if _num(nxt.get("startMs")) and nxt["startMs"] < 0:
        del nxt["startMs"]
    return js_json(nxt)


def apply_raw(raw: Dict[str, Any], slot: str, rel: str, target_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """The sidecar after the app's applyEditRepoint(slot, rel, targetId), or None when the slot re-points nothing.
    slot is the app's EditRepointSlot (background, media, videoWindow, device, deviceCover, compareDevice, compareDeviceCover)."""
    nxt = copy.deepcopy(raw)
    if slot == "background":
        bg = parsed_video_background(nxt.get("background"))
        if bg is None:
            return None
        nxt["background"] = js_json(dict(bg, src=rel))
        return nxt
    if slot in ("media", "videoWindow"):
        entries = resolve_media(nxt)
        entry = next((e for e in entries if e["id"] == target_id), None) if target_id else window_entry(entries)
        if entry is None:
            return None
        entry["src"] = rel
        entry["kind"] = "video"
        video = _spread(entry.get("video"))
        video.pop("startMs", None)
        entry["video"] = video
        nxt.pop("images", None)
        nxt.pop("videoWindow", None)
        nxt["media"] = js_json(entries)
        return nxt
    if slot not in ("device", "deviceCover", "compareDevice", "compareDeviceCover"):
        raise ValueError(f"unknown repoint slot {slot}")
    devices = parsed_devices(nxt)
    device = next((d for d in devices if d["id"] == target_id), None) if target_id else (devices[0] if devices else None)
    if device is None:
        return None
    screen = "cover" if slot in ("deviceCover", "compareDeviceCover") else "main"
    field = SCREEN_FIELD[screen]
    if slot in ("compareDevice", "compareDeviceCover"):
        if not _rec(nxt.get("compare")):
            return None
        current = parsed_compare_map(nxt, field) or {}
        media = current.get(device["id"]) or device.get(field)
        if not _truthy(media):
            return None
        compare = nxt["compare"]
        if not _rec(compare.get("b")):
            compare["b"] = {}
        compare["b"][field] = js_json(dict(current, **{device["id"]: _repointed_device_media(media, rel)}))
        return nxt
    media = device.get(field)
    if not _truthy(media):
        return None
    device[field] = _repointed_device_media(media, rel)
    return nxt


def _device_videos(raw: Dict[str, Any], device: Dict[str, Any]) -> List[Dict[str, Any]]:
    """deviceVideoSlots: every video screen a device shows, each as the parsed spec that times it."""
    out: List[Dict[str, Any]] = []
    for screen in ("main", "cover"):
        field = SCREEN_FIELD[screen]
        override = (parsed_compare_map(raw, field) or {}).get(device["id"])
        for media in (device.get(field), override):
            if _rec(media) and media.get("kind") == "video":
                out.append(parse_media_keys(media))
    return out


def follow_media_slots(raw: Any) -> List[Dict[str, Any]]:
    """followMediaSlots: [{src, spec?}] for the videos a follow-media scene's length derives from; device screens carry their spec."""
    if not readable(raw):
        return []
    duration = raw.get("duration")
    if not _rec(duration) or duration.get("mode") != "follow-media":
        return []
    media = resolve_media(raw)
    if duration.get("source") in ("media", "videoWindow"):
        if duration["source"] == "media":
            entry = next((e for e in media if "sourceMediaId" in duration and e["id"] == duration["sourceMediaId"]), None)
        else:
            entry = window_entry(media)
        return [{"src": entry["src"]}] if entry and entry.get("kind") == "video" else []
    devices = parsed_devices(raw)
    pinned = next((d for d in devices if d["id"] == duration.get("sourceDeviceId")), None) if "sourceDeviceId" in duration else None
    videos = [{"src": spec.get("src"), "spec": spec} for d in ([pinned] if pinned else devices) for spec in _device_videos(raw, d)]
    if videos:
        return videos
    media_videos = [{"src": e["src"]} for e in media if e.get("kind") == "video"]
    if media_videos:
        return media_videos
    bg = parsed_video_background(raw.get("background"))
    return [{"src": bg["src"]}] if bg else []


def follow_media_sources(raw: Any) -> List[str]:
    """followMediaSources: the videos a follow-media scene's length derives from (the longest wins)."""
    return [slot["src"] for slot in follow_media_slots(raw)]


def follow_media_length_ms(spec: Optional[Dict[str, Any]], probed_ms: Any) -> Any:
    """followMediaLengthMs: a timed screen plays startMs + (min(outMs, probed) - inMs) / speed (one pass, at least 17 ms); anything else the probe."""
    if not spec or not has_playback_keys(spec):
        return probed_ms
    start = spec["startMs"] if _num(spec.get("startMs")) else 0
    end = min(spec["outMs"] if "outMs" in spec else probed_ms, probed_ms)
    in_ms = spec["inMs"] if "inMs" in spec else 0
    speed = spec["speed"] if "speed" in spec else 1
    return max(MIN_FOLLOW_MS, js_round(start + (end - in_ms) / speed))


def follow_media_duration_ms(slots: List[Dict[str, Any]], probed_ms: Dict[str, Any]) -> Any:
    """followMediaDurationMs: the longest slot; a source probed at 0 (or not at all) counts for nothing."""
    longest = 0
    for slot in slots:
        probed = probed_ms.get(slot["src"]) or 0
        if probed > 0:
            longest = max(longest, follow_media_length_ms(slot.get("spec"), probed))
    return longest


# ── slots in a scene ──────────────────────────────────────────────────────────


def slot_entries(raw: Any) -> List[Dict[str, Any]]:
    """Every slot that shows a media file: {slot (kb name), targetId, src, kind, startMs, fit, startOn, timing, retimed, repointable}.
    timing holds a device screen's source-timing keys as the app parses them; retimed says it has any."""
    if not readable(raw):
        return []
    out: List[Dict[str, Any]] = []
    bg = raw.get("background")
    if _rec(bg) and bg.get("type") in ("video", "image") and isinstance(bg.get("src"), str) and bg["src"]:
        out.append({"slot": "background", "targetId": None, "src": bg["src"], "kind": bg["type"], "startMs": None, "fit": bg.get("fit"), "startOn": None, "timing": {}, "retimed": False, "repointable": bg["type"] == "video"})
    media = resolve_media(raw)
    window = window_entry(media)
    for m in media:
        video = m.get("video") or {}
        out.append({"slot": "media", "targetId": m["id"], "src": m["src"], "kind": m["kind"], "startMs": video.get("startMs"), "fit": None, "startOn": None, "timing": {}, "retimed": False, "loop": video.get("loop") is True, "repointable": True, "window": m is window})
    for d in parsed_devices(raw):
        for screen, slot in (("main", "device"), ("cover", "device-cover")):
            media_spec = d.get(SCREEN_FIELD[screen])
            if _rec(media_spec) and isinstance(media_spec.get("src"), str):
                timing = playback_timing(media_spec)
                out.append({"slot": slot, "targetId": d["id"], "src": media_spec["src"], "kind": media_spec.get("kind"), "startMs": media_spec.get("startMs"), "fit": media_spec.get("fit"), "startOn": media_spec.get("startOn"), "timing": timing, "retimed": bool(timing), "repointable": True})
        for screen, slot in (("main", "compare-device"), ("cover", "compare-device-cover")):
            override = (parsed_compare_map(raw, SCREEN_FIELD[screen]) or {}).get(d["id"])
            if override:
                timing = playback_timing(override)
                out.append({"slot": slot, "targetId": d["id"], "src": override["src"], "kind": override.get("kind"), "startMs": override.get("startMs"), "fit": override.get("fit"), "startOn": override.get("startOn"), "timing": timing, "retimed": bool(timing), "repointable": True})
    return out


def slot_ref(slot: str, target_id: Optional[str]) -> str:
    return f"{slot}:{target_id}" if target_id is not None and slot not in ("background", "window") else slot


def parse_slot(text: str) -> Tuple[str, Optional[str]]:
    base, _, ident = str(text).strip().partition(":")
    base = base.lower()
    if base == "videowindow":
        base = "window"
    if base not in SLOTS:
        raise KbError(f'unknown slot "{text}"; one of {SLOT_HELP}', 2)
    if ident and base in ("background", "window"):
        raise KbError(f'slot {base} takes no id', 2)
    return base, ident or None


def _resolve_target(raw: Dict[str, Any], base: str, ident: Optional[str]) -> Optional[str]:
    """An id or a 0-based index to the id the app matches on."""
    if ident is None:
        return None
    if base == "media":
        items = resolve_media(raw)
    else:
        items = parsed_devices(raw)
    if any(i["id"] == ident for i in items):
        return ident
    if ident.isascii() and ident.isdigit():
        n = int(ident)
        if n < len(items):
            return items[n]["id"]
    known = ", ".join(i["id"] for i in items) or "none"
    raise KbError(f'no {"media entry" if base == "media" else "device"} "{ident}" in this scene (ids: {known}, or a 0-based index)')


# ── project-level reads and writes ────────────────────────────────────────────


def _read_sidecar(project: Any, stem: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    path = project.sidecar_path(stem)
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return None, None
    except OSError as e:
        raise KbError(f"cannot read scenes/{stem}.json: {e.strerror}") from None
    raw = load_json_text(data.decode("utf-8", "replace"), f"scenes/{stem}.json")
    if not isinstance(raw, dict):
        raise KbError(f"scenes/{stem}.json is not a JSON object")
    import hashlib

    return raw, hashlib.sha256(data).hexdigest()


def _scenes(project: Any) -> List[Tuple[int, str, Dict[str, Any]]]:
    out = []
    for i, entry in enumerate(project.scene_entries()):
        file = entry.get("file") if isinstance(entry, dict) else None
        if not isinstance(file, str) or not file.endswith(".tsx"):
            continue
        stem = file[len("scenes/"):-4] if file.startswith("scenes/") else file[:-4]
        try:
            raw, _sha = _read_sidecar(project, stem)
        except KbError:
            continue
        if raw is not None:
            out.append((i, stem, raw))
    return out


def usages(project: Any, rel: Any = None) -> List[Dict[str, Any]]:
    """Every scene slot showing a media file (or only those showing rel, a path or a list of paths)."""
    wanted = None if rel is None else ({rel} if isinstance(rel, str) else set(rel))
    out = []
    for index, stem, raw in _scenes(project):
        follows = set(follow_media_sources(raw))
        for e in slot_entries(raw):
            if wanted is not None and e["src"] not in wanted:
                continue
            out.append({
                "scene": stem, "index": index, "slot": e["slot"], "targetId": e["targetId"], "ref": slot_ref(e["slot"], e["targetId"]),
                "src": e["src"], "kind": e["kind"], "followsMedia": e["src"] in follows, "repointable": e["repointable"],
                "startMs": e.get("startMs"), "timing": e.get("timing") or {}, "retimed": bool(e.get("retimed")),
            })
    return out


def _entry_duration(entry: Any) -> Optional[int]:
    d = entry.get("durationMs") if isinstance(entry, dict) else None
    return d if is_int(d) else None


def transition_overlap(project: Any, index: int) -> int:
    """The outgoing transition's clamped overlap (ms) at the end of scene index."""
    manifest = project.manifest()
    entries = [e for e in project.scene_entries() if isinstance(e, dict)]
    if index + 1 >= len(entries):
        return 0
    legacy = not (is_int(manifest.get("version")) and manifest["version"] >= 2)
    spec = entries[index + 1].get("transition") if legacy else entries[index].get("transition")
    dur = _entry_duration(entries[index]) or 4000
    nxt = _entry_duration(entries[index + 1]) or 4000
    if isinstance(spec, dict) and isinstance(spec.get("durationMs"), (int, float)) and not isinstance(spec.get("durationMs"), bool):
        return int(max(0, min(int(spec["durationMs"]), dur, nxt)))
    return 0


def scene_starts(project: Any) -> List[int]:
    """Each scene's start on the project timeline (after transition overlaps), as Project.total_ms lays them out."""
    starts: List[int] = []
    end = 0
    for i, entry in enumerate(project.scene_entries()):
        dur = _entry_duration(entry) or 4000
        start = 0 if i == 0 else end - transition_overlap(project, i - 1)
        starts.append(start)
        end = start + dur
    return starts


def pick_slot(project: Any, scene: str, rels: List[str]) -> Tuple[str, Optional[str]]:
    """Auto-pick: the one slot in the scene that shows any of rels; KbError naming the choices otherwise."""
    idx, stem = project.resolve(scene)
    raw, _sha = _read_sidecar(project, stem)
    entries = [e for e in slot_entries(raw or {}) if e["repointable"]]
    hits = [e for e in entries if e["src"] in rels]
    if len(hits) == 1:
        return hits[0]["slot"], hits[0]["targetId"]
    shown = ", ".join(f"{slot_ref(e['slot'], e['targetId'])} ({e['src']})" for e in entries) or "no media slots"
    if not hits:
        raise KbError(f"scene {stem} shows none of {', '.join(rels)}; pick a slot with --slot ({shown})", 2)
    raise KbError(f"scene {stem} shows {rels[0]} in {len(hits)} slots; pick one with --slot ({', '.join(slot_ref(e['slot'], e['targetId']) for e in hits)})", 2)


def find_entry(raw: Dict[str, Any], base: str, target: Optional[str]) -> Optional[Dict[str, Any]]:
    """The slot entry the app would re-point (a comparison slot without its own media inherits the device's)."""
    entries = slot_entries(raw)
    if base == "background":
        return next((e for e in entries if e["slot"] == "background"), None)
    if base == "window" or (base == "media" and target is None):
        return next((e for e in entries if e["slot"] == "media" and e.get("window")), None)
    if base == "media":
        return next((e for e in entries if e["slot"] == "media" and e["targetId"] == target), None)
    if target is None:
        devices = parsed_devices(raw)
        target = devices[0]["id"] if devices else None
    hit = next((e for e in entries if e["slot"] == base and e["targetId"] == target), None)
    if hit is None and base.startswith("compare-"):
        inherited = next((e for e in entries if e["slot"] == base[len("compare-"):] and e["targetId"] == target), None)
        if inherited is not None:
            hit = dict(inherited, slot=base, inherited=True)
    return hit


def slot_info(project: Any, scene: str, slot: str) -> Dict[str, Any]:
    idx, stem = project.resolve(scene)
    raw, _sha = _read_sidecar(project, stem)
    if raw is None:
        raise KbError(f"scene {stem} has no sidecar (scenes/{stem}.json), so it shows no media slots")
    base, ident = parse_slot(slot)
    hit = find_entry(raw, base, _resolve_target(raw, base, ident))
    if hit is None:
        raise KbError(f"scene {stem} has no {slot} slot with media; see kb video usages")
    dur = _entry_duration(project.scene_entries()[idx])
    overlap = transition_overlap(project, idx)
    return {
        "scene": stem, "index": idx, "slot": base, "targetId": hit["targetId"], "ref": slot_ref(base, hit["targetId"]),
        "src": hit["src"], "kind": hit["kind"], "startMs": hit.get("startMs") or 0, "fit": hit.get("fit"), "startOn": hit.get("startOn"),
        "timing": hit.get("timing") or {}, "retimed": bool(hit.get("retimed")), "loop": bool(hit.get("loop") or (hit.get("timing") or {}).get("loop")),
        "followsMedia": hit["src"] in follow_media_sources(raw), "sceneDurationMs": dur,
        "transitionOutStartMs": (dur - overlap) if dur is not None else None,
        "sceneStartMs": scene_starts(project)[idx],
    }


def slot_media_ms(info: Dict[str, Any], scene_ms: float) -> float:
    """Scene-local ms to the ms of the video a slot plays (deviceClipFrameIndex's mapping before frames: the startMs
    delay, then inMs + elapsed * speed). KbError when the slot isn't playing a new frame then, or kb can't place it."""
    where = f"{info.get('ref') or info.get('slot')} in scene {info.get('scene')}"
    if info.get("slot") == "background":
        raise KbError(f"{where} is a video background, which loops with the scene; pick a device or media slot", 2, kind="usage")
    if info.get("startOn"):
        raise KbError(f"{where} starts when its fold opens, which kb can't place in scene time", 2, kind="usage", hint="give the timeline time with --until T instead")
    timing = info.get("timing") or {}
    if info.get("loop") or timing.get("loop"):
        raise KbError(f"{where} loops, so that scene time shows a moment on every pass", 2, kind="usage", hint="give the timeline time with --until T instead")
    start = info.get("startMs") if _num(info.get("startMs")) else 0
    elapsed = (scene_ms - start) * (timing.get("speed") or 1)
    if elapsed < 0:
        raise KbError(f"{where} starts {start / 1000:.3f}s into the scene, after {scene_ms / 1000:.3f}s", kind="invalid", hint="pick a later scene time, or move the video's start")
    media_ms = (timing.get("inMs") or 0) + elapsed
    out = timing.get("outMs")
    if out is not None and media_ms >= out:
        raise KbError(f"{where} stops at its outMs {out} ms before {scene_ms / 1000:.3f}s, so it holds its last frame then", kind="invalid", hint="pick an earlier scene time, or raise the slot's outMs")
    return media_ms


def slot_scene_ms(info: Dict[str, Any], media_ms: float) -> Optional[float]:
    """slot_media_ms backwards: the scene-local ms a slot first shows media_ms of its video, None outside [inMs, outMs)."""
    timing = info.get("timing") or {}
    in_ms = timing.get("inMs") or 0
    out = timing.get("outMs")
    if media_ms < in_ms or (out is not None and media_ms >= out):
        return None
    start = info.get("startMs") if _num(info.get("startMs")) else 0
    return start + (media_ms - in_ms) / (timing.get("speed") or 1)


def _validator(project: Any, label: str) -> Any:
    from .. import bridge
    from .. import check as checkmod

    def validate(doc: Any) -> Any:
        checker = checkmod.Checker(checkmod.Context(project, heartbeat=bridge.read_heartbeat()))
        checker.sidecar_doc(label, doc)
        return checker.report

    return validate


def _new_errors(before: Any, after: Any) -> List[Any]:
    old = {(i.path, i.message) for i in before.errors}
    return [i for i in after.errors if (i.path, i.message) not in old]


def _sidecar_doc(raw: Any, stem: str) -> Any:
    if raw is not None and not isinstance(raw, dict):
        raise KbError(f"scenes/{stem}.json is not a JSON object")
    return raw


def apply(project: Any, scene: str, slot: str, rel: str, target_id: Optional[str] = None, *, force: bool = False, dry_run: bool = False) -> Dict[str, Any]:
    """Re-point one slot of a scene at rel by compare-and-swap under the project lock; refuses a write that adds errors unless force."""
    base, ident = parse_slot(slot)
    if target_id is not None:
        ident = str(target_id)
    idx, stem = project.resolve(scene)
    label = f"scenes/{stem}.json"
    out: Dict[str, Any] = {}

    def fn(raw: Any) -> Any:
        raw = _sidecar_doc(raw, stem)
        if raw is None:
            raise KbError(f"scene {stem} has no sidecar ({label}), so it shows no media to re-point")
        if not readable(raw):
            raise KbError(f"{label} has no readable version, so the app ignores it; fix it first (kb check)")
        target = _resolve_target(raw, base, ident)
        app_slot = SLOTS[base]
        hit = find_entry(raw, base, target)
        before_src = hit["src"] if hit else None
        nxt = apply_raw(raw, app_slot, rel, target)
        if nxt is None:
            raise KbError(f"scene {stem} has no {slot_ref(base, target)} to re-point (see kb video usages); a background must already be a video")
        validate = _validator(project, label)
        fresh = _new_errors(validate(raw), validate(nxt))
        if fresh and not force:
            lines = "; ".join(f"{i.path}: {i.message}" if i.path else i.message for i in fresh)
            raise KbError(f"nothing written: re-pointing would add {len(fresh)} error(s) to {label}: {lines}. Fix them, or pass --force")
        shown = target if target is not None else (hit["targetId"] if hit else None)
        out.clear()
        out.update({
            "scene": stem, "index": idx, "file": label, "slot": base, "targetId": shown, "ref": slot_ref(base, shown),
            "from": before_src, "to": rel, "changed": nxt != raw, "written": False,
        })
        return None if nxt == raw else nxt

    mut = mutate_json(project, label, fn, op="kb video re-point", dry_run=dry_run)
    out["written"] = mut.written
    return out


def overhanging_keys(raw: Dict[str, Any], duration_ms: int) -> List[str]:
    """Keys past a new scene length: reported, never clamped (the app's background resync leaves them too)."""
    out: List[str] = []
    for keys in KEYED_TRACKS:
        node: Any = raw
        for k in keys:
            node = node.get(k) if isinstance(node, dict) else None
        items = node.get("keys") if isinstance(node, dict) else None
        if not isinstance(items, list):
            continue
        for key in items:
            if isinstance(key, dict) and _num(key.get("tMs")) and key["tMs"] > duration_ms:
                out.append(f"{'.'.join(keys)} key {key.get('id', '?')} at {key['tMs'] / 1000:.2f}s")
    stills = raw.get("stills")
    marks = stills.get("marksMs") if isinstance(stills, dict) else None
    if isinstance(marks, list):
        for m in marks:
            if _num(m) and m > duration_ms:
                out.append(f"stills mark at {m / 1000:.2f}s")
    return out


def resync_durations(project: Any, rels: Optional[List[str]] = None, *, write: bool = True) -> List[Dict[str, Any]]:
    """Follow-media scenes whose project.json length differs from their longest slot (follow_media_duration_ms over the
    app CLI's probes). rels limits it to scenes following one of those files. Writes project.json (hash-checked) unless write is False."""
    from . import appcli

    wanted = set(rels) if rels is not None else None
    changes: List[Dict[str, Any]] = []
    probed: Dict[str, Optional[int]] = {}
    for index, stem, raw in _scenes(project):
        slots = follow_media_slots(raw)
        srcs = [slot["src"] for slot in slots]
        if not srcs or (wanted is not None and not wanted.intersection(srcs)):
            continue
        missing = []
        for src in srcs:
            if src not in probed:
                try:
                    probed[src] = int(appcli.probe(project, src).get("durationMs") or 0)
                except KbError:
                    probed[src] = None
            if probed[src] is None and src not in missing:
                missing.append(src)
        longest = follow_media_duration_ms(slots, {k: v for k, v in probed.items() if v is not None})
        entry = project.scene_entries()[index]
        current = _entry_duration(entry)
        if longest > 0 and longest != current:
            changes.append({
                "scene": stem, "index": index, "fromMs": current, "toMs": longest, "sources": srcs, "missing": missing,
                "overhang": overhanging_keys(raw, longest) if current is None or longest < current else [],
            })
    if write and changes:
        _write_durations(project, changes)
    return changes


def _write_durations(project: Any, changes: List[Dict[str, Any]]) -> None:
    def fn(manifest: Any) -> Any:
        scenes = manifest.get("scenes") if isinstance(manifest, dict) else None
        if not isinstance(scenes, list):
            raise KbError('project.json has no "scenes" array; restore it with kb undo')
        for c in changes:
            entry = scenes[c["index"]] if c["index"] < len(scenes) else None
            if not isinstance(entry, dict) or entry.get("file") != f"scenes/{c['scene']}.tsx":
                raise KbError(f"project.json changed under kb (scene {c['index']} is no longer {c['scene']}); rerun kb video durations", kind="conflict")
            entry["durationMs"] = int(c["toMs"])
            entry.pop("cutAt", None)
            entry.pop("align", None)
        return manifest

    mutate_json(project, "project.json", fn, op="kb video durations")
    project.manifest(reload=True)



def follow_spec(ref: str) -> Dict[str, Any]:
    """The duration block that makes a scene's length follow the media in a slot."""
    base, ident = parse_slot(ref)
    if base == "background":
        return {"mode": "follow-media"}
    if base == "window":
        return {"mode": "follow-media", "source": "videoWindow"}
    if base == "media":
        if ident is None:
            return {"mode": "follow-media", "source": "videoWindow"}
        return {"mode": "follow-media", "source": "media", "sourceMediaId": ident}
    spec: Dict[str, Any] = {"mode": "follow-media"}
    if ident is not None:
        spec["sourceDeviceId"] = ident
    return spec


def set_follow(project: Any, scene: str, ref: str, *, force: bool = False) -> Dict[str, Any]:
    """Make a scene's length follow the media in one slot (compare-and-swap, validated like any sidecar write)."""
    idx, stem = project.resolve(scene)
    label = f"scenes/{stem}.json"
    out: Dict[str, Any] = {}

    def fn(raw: Any) -> Any:
        raw = _sidecar_doc(raw, stem)
        if raw is None or not readable(raw):
            raise KbError(f"{label} is missing or unreadable, so its length cannot follow media")
        base, ident = parse_slot(ref)
        target = _resolve_target(raw, base, ident) if base in ("media",) or base.endswith("device") or base.endswith("cover") else None
        spec = follow_spec(slot_ref(base, target) if target else ref)
        nxt = dict(raw, duration=spec)
        validate = _validator(project, label)
        fresh = _new_errors(validate(raw), validate(nxt))
        if fresh and not force:
            raise KbError(f"nothing written: following that media would add errors to {label}: " + "; ".join(i.message for i in fresh))
        out["spec"] = spec
        return None if nxt == raw else nxt

    mutate_json(project, label, fn, op="kb video follow")
    return out["spec"]


def set_start(project: Any, scene: str, slot: str, start_ms: int, *, force: bool = False) -> Dict[str, Any]:
    """Move when a slot's video starts in its scene (scene-local ms; 0 drops the field), hash-checked like any sidecar write.
    A negative start pre-rolls the video on the scene clock, so it is refused beside a device screen's inMs trim."""
    if not is_int(start_ms):
        raise KbError("a video start must be whole milliseconds", 2)
    base, ident = parse_slot(slot)
    if base == "background":
        raise KbError("a video background always starts with the scene; pick a device or media slot", 2)
    idx, stem = project.resolve(scene)
    label = f"scenes/{stem}.json"
    out: Dict[str, Any] = {}

    def fn(raw: Any) -> Any:
        raw = _sidecar_doc(raw, stem)
        if raw is None or not readable(raw):
            raise KbError(f"{label} is missing or unreadable")
        target = _resolve_target(raw, base, ident)
        nxt = copy.deepcopy(raw)
        before: Any = None
        if base in ("media", "window"):
            entries = resolve_media(nxt)
            entry = next((e for e in entries if e["id"] == target), None) if target else window_entry(entries)
            if entry is None or entry.get("kind") != "video":
                raise KbError(f"scene {stem} has no video in {slot_ref(base, target)}")
            video = _spread(entry.get("video"))
            before = video.get("startMs", 0)
            if start_ms:
                video["startMs"] = start_ms
            else:
                video.pop("startMs", None)
            entry["video"] = video
            nxt.pop("images", None)
            nxt.pop("videoWindow", None)
            nxt["media"] = js_json(entries)
        else:
            devices = parsed_devices(nxt)
            device = next((d for d in devices if d["id"] == target), None) if target else (devices[0] if devices else None)
            field = SCREEN_FIELD["cover" if base.endswith("cover") else "main"]
            if device is None:
                raise KbError(f"scene {stem} has no {slot_ref(base, target)}")
            if base.startswith("compare-"):
                override = (parsed_compare_map(nxt, field) or {}).get(device["id"])
                if override is None:
                    raise KbError(f"the After side of {device['id']} shows the Before media; re-point it first (kb video use)")
                media = nxt["compare"]["b"][field][device["id"]]
            else:
                media = device.get(field)
            if not _rec(media) or media.get("kind") != "video":
                raise KbError(f"scene {stem} has no video in {slot_ref(base, device['id'])}")
            if start_ms < 0 and "inMs" in playback_timing(media):
                raise KbError(
                    f"{slot_ref(base, device['id'])} in scene {stem} trims with inMs, so its start can't be negative (inMs is the trim, startMs the delay)",
                    kind="invalid",
                    hint="give a start of 0 or more, or move the trim with ./kb doc S set devices.N.media.inMs MS",
                )
            before = media.get("startMs", 0)
            if start_ms:
                media["startMs"] = start_ms
            else:
                media.pop("startMs", None)
        validate = _validator(project, label)
        fresh = _new_errors(validate(raw), validate(nxt))
        if fresh and not force:
            raise KbError(f"nothing written: that start would add errors to {label}: " + "; ".join(i.message for i in fresh))
        out.clear()
        out.update({"scene": stem, "index": idx, "slot": slot_ref(base, target), "fromMs": before, "toMs": start_ms})
        return None if nxt == raw else nxt

    mutate_json(project, label, fn, op="kb video start")
    return out
