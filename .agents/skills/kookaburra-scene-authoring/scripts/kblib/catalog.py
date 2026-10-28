"""catalog.json access: generated from the app's registries, read defensively (any key may be missing)."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SKILL_DIR = Path(__file__).resolve().parent.parent.parent

# Fallbacks mirror the app source; the catalogue always wins when it has the family.
FALLBACK_TRANSITIONS = [
    "crossfade", "dip", "slide", "wipe", "blur", "push", "zoom", "whip", "luma", "glitch",
    "slice", "dissolve", "warp", "inkbleed", "flowmorph", "shockwave", "glasssweep",
    "rackfocus", "halftone", "lightsweep", "shatter", "pixelstretch", "chromasplit",
    "datamosh", "prism", "spinblur",
]
FALLBACK_ASPECTS = ["16:9", "9:16", "1:1", "4:5", "5:4", "3:2", "2:3", "phone", "phone-landscape"]
TRANSITION_EASES = ["linear", "smooth", "snappy"]
MANAGED_TEXT_TYPES = ["title", "subtitle", "bullets", "icon"]
FALLBACK_BULLET_MARKERS = ["dot", "dash", "tick", "number", "none"]
ANIMATED_TRACKS = ["camera", "layeredScreenshot", "compare", "chart", "lighting"]
AUDIO_FADE_CURVES = ["smooth", "linear", "scurve", "exponential", "logarithmic"]

FALLBACK_SCENE_DOC_KEYS = [
    "version", "name", "duration", "text", "textLayout", "textStyle", "headerIcon", "managedText",
    "devices", "media", "images", "deviceLayout", "deviceTrack", "objects", "camera", "cameraMode",
    "cameraRig", "cameraKicks", "themeId", "backdrop", "background", "textAnimation", "textAnimationForce",
    "textAnimationOverrides", "textLook", "textLookForce", "textLookOverrides", "lighting", "frame",
    "layeredScreenshot", "videoWindow", "compare", "chart", "terminal", "website", "animatedTrack",
    "stills", "motionBlur", "room", "taps", "mosaic",
]
FALLBACK_MANIFEST_KEYS = [
    "id", "name", "group", "audio", "themeId", "typography", "formats", "version", "scenes",
    "camera", "persistent", "frame", "render", "lighting", "appliedBackground", "defaultTransition",
    "shared", "brand",
]
FALLBACK_DEVICE_MEDIA_KEYS = ["src", "kind", "startMs", "fit", "rotateDeg", "startOn", "inMs", "outMs", "speed", "loop", "posterMs"]
SCENE_DOC_VERSION = 1
MANIFEST_VERSION = 2


def catalog_path() -> Path:
    override = os.environ.get("KB_CATALOG")
    if override:
        return Path(override)
    return SKILL_DIR / "catalog.json"


class Catalog:
    def __init__(self, data: Optional[Dict[str, Any]], path: Path, error: Optional[str] = None) -> None:
        self.data = data or {}
        self.path = path
        self.error = error

    @property
    def present(self) -> bool:
        return bool(self.data)

    def get(self, dotted: str) -> Any:
        node: Any = self.data
        for part in dotted.split("."):
            if isinstance(node, dict) and part in node:
                node = node[part]
            else:
                return None
        return node

    def entries(self, dotted: str) -> Optional[List[Dict[str, Any]]]:
        """A family as a list of entry dicts (each with an `id`), or None when the catalogue lacks it."""
        return as_entries(self.get(dotted))

    def ids(self, dotted: str, fallback: Optional[List[str]] = None) -> Optional[List[str]]:
        entries = self.entries(dotted)
        if entries is None:
            return list(fallback) if fallback is not None else None
        return [str(e["id"]) for e in entries if "id" in e]

    def families(self) -> List[Tuple[str, int]]:
        out: List[Tuple[str, int]] = []
        for key, value in self.data.items():
            entries = as_entries(value)
            if entries is not None:
                out.append((key, len(entries)))
            elif isinstance(value, dict):
                for sub, subvalue in value.items():
                    sub_entries = as_entries(subvalue)
                    if sub_entries is not None:
                        out.append((f"{key}.{sub}", len(sub_entries)))
        return out


def as_entries(value: Any) -> Optional[List[Dict[str, Any]]]:
    if isinstance(value, list):
        out: List[Dict[str, Any]] = []
        for item in value:
            if isinstance(item, dict) and "id" in item:
                out.append(item)
            elif isinstance(item, str):
                out.append({"id": item})
            elif isinstance(item, dict) and "family" in item:
                out.append(dict(item, id=item["family"]))
        if value and not out:
            return None
        return out
    if isinstance(value, dict) and value and all(isinstance(v, dict) for v in value.values()):
        if any(k in value for k in ("ids", "entries", "items")):
            for k in ("entries", "items", "ids"):
                if k in value:
                    return as_entries(value[k])
        return [dict(v, id=v.get("id", k)) for k, v in value.items()]
    if isinstance(value, dict):
        for k in ("entries", "items", "ids"):
            if k in value:
                return as_entries(value[k])
    return None


_cache: Dict[str, Catalog] = {}


def load_catalog() -> Catalog:
    path = catalog_path()
    key = str(path)
    if key in _cache:
        return _cache[key]
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            data = raw
        else:
            error = "catalog.json is not an object"
    except FileNotFoundError:
        error = "catalog.json is missing (the kit is incomplete; ask the user to reopen the project in Kookaburra Cut)"
    except (OSError, ValueError) as e:
        error = f"catalog.json is unreadable ({e})"
    cat = Catalog(data, path, error)
    _cache[key] = cat
    return cat


def reset_cache() -> None:
    _cache.clear()


def scene_doc_version(cat: Catalog) -> int:
    v = cat.get("sceneDoc.version")
    return v if isinstance(v, int) and not isinstance(v, bool) else SCENE_DOC_VERSION


def manifest_version(cat: Catalog) -> int:
    v = cat.get("projectManifest.version")
    return v if isinstance(v, int) and not isinstance(v, bool) else MANIFEST_VERSION


def scene_doc_keys(cat: Catalog) -> List[str]:
    return cat.ids("sceneDoc.keys", FALLBACK_SCENE_DOC_KEYS) or FALLBACK_SCENE_DOC_KEYS


def manifest_keys(cat: Catalog) -> List[str]:
    return cat.ids("projectManifest.keys", FALLBACK_MANIFEST_KEYS) or FALLBACK_MANIFEST_KEYS


def device_media_keys(cat: Catalog) -> List[str]:
    return cat.ids("deviceMedia.keys", FALLBACK_DEVICE_MEDIA_KEYS) or FALLBACK_DEVICE_MEDIA_KEYS


def entry_line(entry: Dict[str, Any]) -> str:
    label = entry.get("label")
    summary = entry.get("summary")
    parts = [str(entry.get("id"))]
    if label and str(label) != str(entry.get("id")):
        parts.append(f"({label})")
    if summary:
        parts.append(f"- {summary}")
    if entry.get("hidden") is True:
        parts.append("[retired: still renders, hidden from pickers]")
    parts.extend(screen_notes(entry))
    return " ".join(parts)


# ── device screens ────────────────────────────────────────────────────────────


def screen_rect_note(label: str, rect: Any) -> Optional[str]:
    """One measured screen rect (fitted units at scale 1, UV u right and v down) as a short phrase."""
    if not isinstance(rect, dict) or not all(isinstance(rect.get(k), (int, float)) for k in ("width", "height", "z")):
        return None
    centre = rect.get("centre") if isinstance(rect.get("centre"), list) else [0, 0]
    note = f"{label} {rect['width']} x {rect['height']} at ({', '.join(str(c) for c in centre)}, {rect['z']})"
    if isinstance(rect.get("cornerRadius"), (int, float)):
        note += f" r {rect['cornerRadius']}"
    frame = rect.get("frame")
    if isinstance(frame, dict):
        note += "".join(f" at {k[:-3]} {v}" for k, v in frame.items() if k.endswith("Deg"))
    return note


def screen_notes(entry: Dict[str, Any]) -> List[str]:
    """`kb catalog devices` lines carry each display's rect: anchor with DeviceScreenAnchor, never measure by capture."""
    notes = [screen_rect_note("screen", entry.get("screen")), screen_rect_note("cover", entry.get("coverScreen"))]
    return [f"[{n}]" for n in notes if n]
