"""Edit documents (edits/<name>.json): strict parse like the app's serde types, names, render state, and mutate().

Rust is the only writer of edit docs: mutate() changes the parsed doc in Python, then saves through the app's CLI with
the content hash it read, retrying on a conflict.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..lock import RETRY_AFTER_MS, FileLock
from ..util import EXIT_ENV, EXIT_PROBLEMS, EXIT_TRANSIENT, KbError, exact_case_exists
from . import editmath as em

EDITS_DIR = "edits"
RENDERS_DIR = ".renders"
OUTPUT_RE = re.compile(r"^assets/(.+)-edited\.mp4$")
VERSION = 1
VERSION_MASKS = 2
VERSION_CROP = 3
VERSION_READ_MAX = 3
U32_MAX = 2 ** 32 - 1
U64_MAX = 2 ** 64 - 1
I64_MIN, I64_MAX = -(2 ** 63), 2 ** 63 - 1
LOCK_WAIT_S = 10.0
SAVE_RETRIES = 3
TAP_SIZE_RANGE = (0.25, 4.0)
HEX6 = re.compile(r"^#[0-9A-Fa-f]{6}$", re.ASCII)
ZOOM_EASES = ("linear", "smooth")
UPDATE_HINT = "ask the user to update Kookaburra Cut"


class DocError(KbError):
    """The doc cannot be read: kind is "missing", "corrupt" or "version"."""

    def __init__(self, message: str, kind: str, code: int = EXIT_PROBLEMS) -> None:
        super().__init__(message, code)
        self.kind = kind


# ── names ─────────────────────────────────────────────────────────────────────


def _root(project: Any) -> Path:
    return Path(project) if isinstance(project, (str, os.PathLike)) else project.root


def slugify(name: str) -> str:
    """workspace.rs slugify: trim, lowercase, ascii alphanumerics kept, any other run becomes one hyphen."""
    out: List[str] = []
    last_hyphen = True
    for c in name.strip().lower():
        if c.isascii() and c.isalnum():
            out.append(c)
            last_hyphen = False
        elif not last_hyphen:
            out.append("-")
            last_hyphen = True
    while out and out[-1] == "-":
        out.pop()
    return "".join(out)


def validate_slug(name: str) -> bool:
    """workspace.rs validate_slug: non-empty, no leading dot, ascii alphanumerics, '-' and '_' only."""
    return bool(name) and not name.startswith(".") and all((c.isascii() and c.isalnum()) or c in "-_" for c in name)


def check_name(name: str) -> str:
    if not validate_slug(name) or name.startswith("_"):
        raise KbError(f'"{name}" is not a valid edit name: use letters, digits, - and _ (not leading _ or .), e.g. {slugify(name) or "demo"}', 2)
    return name


def default_name(source_rel: str) -> str:
    """edit.rs: the slugified source stem (the file name without its last extension), else "edit"."""
    base = source_rel.rstrip("/").rsplit("/", 1)[-1]
    stem = base.rsplit(".", 1)[0] if "." in base[1:] else base
    return slugify(stem) or "edit"


def output_rel(name: str) -> str:
    return f"assets/{name}-edited.mp4"


def name_of_output(rel: str) -> Optional[str]:
    m = OUTPUT_RE.match(rel or "")
    return m.group(1) if m else None


def edits_dir(project: Any) -> Path:
    return _root(project) / EDITS_DIR


def edit_path(project: Any, name: str) -> Path:
    return edits_dir(project) / f"{name}.json"


def record_path(project: Any, name: str) -> Path:
    return edits_dir(project) / RENDERS_DIR / f"{name}.json"


def list_names(project: Any) -> List[str]:
    """Saved edits: edits/*.json files, skipping editor sidecars (_*) and dot files."""
    folder = edits_dir(project)
    try:
        entries = os.listdir(folder)
    except OSError:
        return []
    out = []
    for entry in entries:
        if not entry.endswith(".json") or entry.startswith(("_", ".")):
            continue
        if (folder / entry).is_file():
            out.append(entry[: -len(".json")])
    return sorted(out)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha(path: Path) -> Optional[str]:
    try:
        return sha256_hex(path.read_bytes())
    except OSError:
        return None


# ── strict parse (the serde types in src-tauri/src/edit.rs) ───────────────────


class _Corrupt(Exception):
    pass


class _Obj(dict):
    dups: Tuple[str, ...] = ()


def _pairs(pairs: List[Tuple[str, Any]]) -> _Obj:
    obj = _Obj()
    dups: List[str] = []
    for k, v in pairs:
        if k in obj:
            dups.append(k)
        obj[k] = v
    obj.dups = tuple(dups)
    return obj


def _no_constants(name: str) -> Any:
    raise _Corrupt(f"{name} is not valid JSON")


def _kind(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return f"boolean `{str(v).lower()}`"
    if isinstance(v, int):
        return f"integer `{v}`"
    if isinstance(v, float):
        return f"floating point `{v}`"
    if isinstance(v, str):
        return f"string {json.dumps(v)}"
    if isinstance(v, list):
        return "sequence"
    return "map"


def _at(path: str) -> str:
    return f" at {path}" if path else ""


class _Struct:
    def __init__(self, raw: Any, name: str, path: str) -> None:
        if not isinstance(raw, dict):
            raise _Corrupt(f"invalid type: {_kind(raw)}, expected struct {name}{_at(path)}")
        self.raw = raw
        self.path = path
        dups = getattr(raw, "dups", ())
        self.dups = set(dups)

    def _field(self, key: str) -> str:
        return f"{self.path}.{key}" if self.path else key

    def has(self, key: str) -> bool:
        if key in self.dups:
            raise _Corrupt(f"duplicate field `{key}`{_at(self.path)}")
        return key in self.raw

    def req(self, key: str) -> Any:
        if not self.has(key):
            raise _Corrupt(f"missing field `{key}`{_at(self.path)}")
        return self.raw[key]

    def opt(self, key: str) -> Any:
        return self.raw[key] if self.has(key) else None


def _uint(v: Any, path: str, top: int, label: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        raise _Corrupt(f"invalid type: {_kind(v)}, expected {label}{_at(path)}")
    if v < 0 or v > top:
        raise _Corrupt(f"invalid value: integer `{v}`, expected {label}{_at(path)}")
    return v


def _u32(v: Any, path: str) -> int:
    return _uint(v, path, U32_MAX, "u32")


def _u64(v: Any, path: str) -> int:
    return _uint(v, path, U64_MAX, "u64")


def _i64(v: Any, path: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        raise _Corrupt(f"invalid type: {_kind(v)}, expected i64{_at(path)}")
    if v < I64_MIN or v > I64_MAX:
        raise _Corrupt(f"invalid value: integer `{v}`, expected i64{_at(path)}")
    return v


def _f64(v: Any, path: str) -> Any:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or (isinstance(v, float) and not math.isfinite(v)):
        raise _Corrupt(f"invalid type: {_kind(v)}, expected f64{_at(path)}")
    return v


def _str(v: Any, path: str) -> str:
    if not isinstance(v, str):
        raise _Corrupt(f"invalid type: {_kind(v)}, expected a string{_at(path)}")
    return v


def _array(v: Any, path: str, n: int) -> List[Any]:
    if not isinstance(v, list):
        raise _Corrupt(f"invalid type: {_kind(v)}, expected an array of length {n}{_at(path)}")
    if len(v) != n:
        raise _Corrupt(f"invalid length {len(v)}, expected an array of length {n}{_at(path)}")
    return [_f64(x, f"{path}[{i}]") for i, x in enumerate(v)]


def _seq(v: Any, path: str) -> List[Any]:
    if not isinstance(v, list):
        raise _Corrupt(f"invalid type: {_kind(v)}, expected a sequence{_at(path)}")
    return v


def _enum(v: Any, path: str, variants: Tuple[str, ...]) -> str:
    if not isinstance(v, str):
        raise _Corrupt(f"invalid type: {_kind(v)}, expected one of {', '.join(variants)}{_at(path)}")
    if v not in variants:
        raise _Corrupt(f"unknown variant `{v}`, expected one of {', '.join(f'`{x}`' for x in variants)}{_at(path)}")
    return v


def _source(raw: Any, path: str) -> Dict[str, Any]:
    s = _Struct(raw, "EditSource", path)
    out: Dict[str, Any] = {"id": _str(s.req("id"), s._field("id")), "rel": _str(s.req("rel"), s._field("rel"))}
    out["kind"] = _enum(s.req("kind"), s._field("kind"), ("video", "image")) if s.has("kind") else "video"
    out["width"] = _u32(s.req("width"), s._field("width"))
    out["height"] = _u32(s.req("height"), s._field("height"))
    out["fps"] = _f64(s.req("fps"), s._field("fps"))
    out["durationMs"] = _u64(s.req("durationMs"), s._field("durationMs"))
    return out


def _clip(raw: Any, path: str) -> Dict[str, Any]:
    s = _Struct(raw, "EditClip", path)
    out: Dict[str, Any] = {
        "id": _str(s.req("id"), s._field("id")),
        "sourceId": _str(s.req("sourceId"), s._field("sourceId")),
        "inMs": _u64(s.req("inMs"), s._field("inMs")),
        "outMs": _u64(s.req("outMs"), s._field("outMs")),
        "speed": _f64(s.req("speed"), s._field("speed")),
        "startMs": _u64(s.req("startMs"), s._field("startMs")),
    }
    hold = s.opt("holdMs")
    if hold is not None:
        out["holdMs"] = _u64(hold, s._field("holdMs"))
    crop = s.opt("crop")
    if crop is not None:
        out["crop"] = _array(crop, s._field("crop"), 4)
    zoom = s.opt("zoom")
    if zoom is not None:
        zs = _Struct(zoom, "EditZoom", s._field("zoom"))
        keys = []
        for i, k in enumerate(_seq(zs.req("keys"), zs._field("keys"))):
            ks = _Struct(k, "EditZoomKey", f"{zs._field('keys')}[{i}]")
            key: Dict[str, Any] = {"tMs": _i64(ks.req("tMs"), ks._field("tMs")), "rect": _array(ks.req("rect"), ks._field("rect"), 4)}
            ease = ks.opt("ease")
            if ease is not None:
                key["ease"] = _enum(ease, ks._field("ease"), ZOOM_EASES)
            keys.append(key)
        out["zoom"] = {"keys": keys}
    return out


def _settings(raw: Any, path: str) -> Dict[str, Any]:
    s = _Struct(raw, "EditSettings", path)
    return {
        "width": _u32(s.req("width"), s._field("width")),
        "height": _u32(s.req("height"), s._field("height")),
        "fps": _f64(s.req("fps"), s._field("fps")),
    }


def _tap(raw: Any, path: str) -> Dict[str, Any]:
    s = _Struct(raw, "EditTap", path)
    return {
        "id": _str(s.req("id"), s._field("id")),
        "sourceId": _str(s.req("sourceId"), s._field("sourceId")),
        "sourceMs": _u64(s.req("sourceMs"), s._field("sourceMs")),
        "pos": _array(s.req("pos"), s._field("pos"), 2),
    }


def _mask(raw: Any, path: str) -> Dict[str, Any]:
    s = _Struct(raw, "EditMask", path)
    out: Dict[str, Any] = {"id": _str(s.req("id"), s._field("id")), "sourceId": _str(s.req("sourceId"), s._field("sourceId"))}
    out["style"] = _enum(s.req("style"), s._field("style"), ("solid", "blur", "pixelate")) if s.has("style") else "solid"
    strength = s.opt("strength")
    if strength is not None:
        out["strength"] = _f64(strength, s._field("strength"))
    color = s.opt("color")
    if color is not None:
        out["color"] = _str(color, s._field("color"))
    out["startMs"] = _u64(s.req("startMs"), s._field("startMs")) if s.has("startMs") else 0
    out["endMs"] = _u64(s.req("endMs"), s._field("endMs")) if s.has("endMs") else 0
    for key in ("fadeInMs", "fadeOutMs"):
        fade = s.opt(key)
        if fade is not None:
            out[key] = _u64(fade, s._field(key))
    keys = []
    for i, k in enumerate(_seq(s.req("keys"), s._field("keys"))):
        ks = _Struct(k, "EditMaskKey", f"{s._field('keys')}[{i}]")
        keys.append({"sourceMs": _u64(ks.req("sourceMs"), ks._field("sourceMs")), "rect": _array(ks.req("rect"), ks._field("rect"), 4)})
    out["keys"] = keys
    return out


def _doc(raw: Any) -> Dict[str, Any]:
    s = _Struct(raw, "EditDoc", "")
    doc: Dict[str, Any] = {
        "version": _u32(s.req("version"), "version"),
        "name": _str(s.req("name"), "name"),
        "sources": [_source(x, f"sources[{i}]") for i, x in enumerate(_seq(s.req("sources"), "sources"))],
        "settings": _settings(s.req("settings"), "settings"),
        "clips": [_clip(x, f"clips[{i}]") for i, x in enumerate(_seq(s.req("clips"), "clips"))],
    }
    taps = [_tap(x, f"taps[{i}]") for i, x in enumerate(_seq(s.req("taps"), "taps"))] if s.has("taps") else []
    if taps:
        doc["taps"] = taps
    for key in ("tapStyle", "tapColor"):
        value = s.opt(key)
        if value is not None:
            doc[key] = _str(value, key)
    size = s.opt("tapSize")
    if size is not None:
        doc["tapSize"] = _f64(size, "tapSize")
    masks = [_mask(x, f"masks[{i}]") for i, x in enumerate(_seq(s.req("masks"), "masks"))] if s.has("masks") else []
    if masks:
        doc["masks"] = masks
    ref = s.opt("reference")
    if ref is not None:
        rs = _Struct(ref, "EditReference", "reference")
        doc["reference"] = {"rel": _str(rs.req("rel"), "reference.rel"), "offsetMs": _i64(rs.req("offsetMs"), "reference.offsetMs") if rs.has("offsetMs") else 0}
    return doc


def parse(data: Any) -> Dict[str, Any]:
    """Bytes or text to the doc exactly as the app's serde types read it (defaults filled, unknown fields dropped)."""
    try:
        text = data.decode("utf-8") if isinstance(data, (bytes, bytearray)) else data
    except UnicodeDecodeError:
        raise DocError("edit is corrupt: stream did not contain valid UTF-8", "corrupt") from None
    try:
        raw = json.loads(text, object_pairs_hook=_pairs, parse_constant=_no_constants)
        doc = _doc(raw)
    except json.JSONDecodeError as e:
        raise DocError(f"edit is corrupt: {e.msg} at line {e.lineno} column {e.colno}", "corrupt") from None
    except _Corrupt as e:
        raise DocError(f"edit is corrupt: {e}", "corrupt") from None
    except RecursionError:
        raise DocError("edit is corrupt: recursion limit exceeded", "corrupt") from None
    if doc["version"] > VERSION_READ_MAX:
        raise DocError(f"this edit uses document version {doc['version']} and needs a newer Kookaburra Cut", "version")
    return doc


def read_bytes(project: Any, name: str) -> bytes:
    path = edit_path(project, name)
    try:
        return path.read_bytes()
    except FileNotFoundError:
        known = list_names(project)
        hint = f" (edits: {', '.join(known)})" if known else " (no edits yet: kb video new assets/<file>)"
        raise DocError(f"no edit named {name}{hint}", "missing") from None
    except OSError as e:
        raise DocError(f"cannot read edits/{name}.json: {e.strerror}", "missing") from None


def load(project: Any, name: str) -> Tuple[Dict[str, Any], str]:
    data = read_bytes(project, name)
    try:
        doc = parse(data)
    except DocError as e:
        hint = f"; kb video reset {name} --yes rebuilds it from its source (the broken file is kept as .json.bak)" if e.kind == "corrupt" else "; ask the user to update Kookaburra Cut"
        raise DocError(f"edits/{name}.json: {e.message}{hint}", e.kind) from None
    return doc, sha256_hex(data)


def stamped_version(doc: Dict[str, Any]) -> int:
    """edit.rs doc_version: the lowest version that carries everything in the doc (a crop or zoom needs 3)."""
    if any("crop" in c or "zoom" in c for c in doc.get("clips") or []):
        return VERSION_CROP
    return VERSION_MASKS if doc.get("masks") else VERSION


FEATURE_LABELS = {"mask.fades": "mask fades", "crop": "a crop", "zoom": "zoom keys"}


def needs(doc: Dict[str, Any]) -> List[str]:
    """What an app's edit CLI must serve to save doc without dropping part of it (keys of FEATURE_LABELS)."""
    out = []
    if any(m.get("fadeInMs") or m.get("fadeOutMs") for m in doc.get("masks") or []):
        out.append("mask.fades")
    clips = doc.get("clips") or []
    for feature in ("crop", "zoom"):
        if any(feature in c for c in clips):
            out.append(feature)
    return out


def caps_supports(caps: Dict[str, Any], feature: str) -> bool:
    """Whether an `edit caps` answer serves a needs() feature: mask.fades, or crop and zoom with doc version 3 writes."""
    if feature == "mask.fades":
        mask = caps.get("mask")
        return isinstance(mask, dict) and mask.get("fades") is True
    written = (caps.get("docVersion") or {}).get("write") if isinstance(caps.get("docVersion"), dict) else None
    return caps.get(feature) is True and isinstance(written, list) and VERSION_CROP in written


def require_caps(caps: Dict[str, Any], features: List[str], what: str) -> None:
    """Refuse (exit 2) before an older app CLI saves a doc it would silently strip, or is asked for what it lacks."""
    missing = [f for f in features if not caps_supports(caps, f)]
    if missing:
        labels = " and ".join(FEATURE_LABELS.get(f, f) for f in missing)
        raise KbError(
            f"{what} needs {labels}, which Kookaburra Cut {caps.get('appVersion') or '?'}'s edit CLI doesn't support (it would drop them on save)",
            EXIT_ENV,
            kind="env",
            hint=UPDATE_HINT,
        )


U64_PATHS = {
    "sources": ("durationMs",),
    "clips": ("inMs", "outMs", "startMs", "holdMs"),
    "taps": ("sourceMs",),
    "masks": ("startMs", "endMs", "fadeInMs", "fadeOutMs"),
}


def u64_problems(doc: Dict[str, Any]) -> List[str]:
    """Every integer field the app stores as u64/u32 must be a non-negative int, never a float like 1.0."""
    bad: List[str] = []

    def check(v: Any, where: str, top: int = U64_MAX) -> None:
        if isinstance(v, bool) or not isinstance(v, int) or v < 0 or v > top:
            bad.append(f"{where} = {v!r}")

    check(doc.get("version"), "version", U32_MAX)
    for key in ("width", "height"):
        check((doc.get("settings") or {}).get(key), f"settings.{key}", U32_MAX)
    for group, fields in U64_PATHS.items():
        for i, item in enumerate(doc.get(group) or []):
            for f in fields:
                if f in item:
                    check(item[f], f"{group}[{i}].{f}")
            if group == "sources":
                check(item.get("width"), f"sources[{i}].width", U32_MAX)
                check(item.get("height"), f"sources[{i}].height", U32_MAX)
            if group == "masks":
                for j, k in enumerate(item.get("keys") or []):
                    check(k.get("sourceMs"), f"masks[{i}].keys[{j}].sourceMs")
            if group == "clips" and isinstance(item.get("zoom"), dict):
                for j, k in enumerate(item["zoom"].get("keys") or []):
                    t = k.get("tMs")
                    if isinstance(t, bool) or not isinstance(t, int) or not I64_MIN <= t <= I64_MAX:
                        bad.append(f"clips[{i}].zoom.keys[{j}].tMs = {t!r}")
    return bad


# ── static issues (the CLI's validate, minus what needs ffmpeg) ───────────────


def _issue(severity: str, code: str, message: str, **where: Any) -> Dict[str, Any]:
    out = {"severity": severity, "code": code, "message": message}
    out.update({k: v for k, v in where.items() if v is not None})
    return out


def valid_hex(colour: Any) -> bool:
    return isinstance(colour, str) and bool(HEX6.match(colour))


def mask_errors(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
    """edit_masks.rs validate_masks: fail closed on a mask that cannot render as drawn."""
    out = []
    for mask in doc.get("masks") or []:
        source = next((s for s in doc["sources"] if s["id"] == mask["sourceId"]), None)
        if source is None:
            continue
        if "color" in mask and not valid_hex(mask["color"]):
            out.append(_issue("error", "bad-mask", f"mask colour must be #rrggbb, got {json.dumps(mask['color'])}", mask=mask["id"]))
        if not mask.get("keys"):
            out.append(_issue("error", "bad-mask", f"mask {mask['id']} has no keyframes", mask=mask["id"]))
        if source.get("kind", "video") == "video" and mask["endMs"] <= mask["startMs"]:
            out.append(_issue("error", "bad-mask", f"mask {mask['id']} has an empty time span", mask=mask["id"]))
        elif source.get("kind", "video") == "video" and (mask.get("fadeInMs") or 0) + (mask.get("fadeOutMs") or 0) > mask["endMs"] - mask["startMs"]:
            out.append(_issue("error", "bad-mask", f"mask {mask['id']} fades for longer than its span", mask=mask["id"]))
        for k in mask.get("keys") or []:
            r = k.get("rect") or []
            if len(r) != 4 or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in r) or r[2] <= 0 or r[3] <= 0:
                out.append(_issue("error", "bad-mask", f"mask {mask['id']} has an invalid box", mask=mask["id"]))
                break
    return out


def _rect_inside(r: Any) -> bool:
    """edit.rs rect_inside: a real normalised box inside the frame."""
    return (
        isinstance(r, list) and len(r) == 4 and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in r)
        and r[2] > 0 and r[3] > 0 and r[0] >= 0 and r[1] >= 0 and r[0] + r[2] <= 1 + 1e-9 and r[1] + r[3] <= 1 + 1e-9
    )


def crop_errors(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
    """edit.rs validate_crops (crop_problem, zoom_problem): fail closed on a crop or zoom that cannot render as drawn."""
    out = []
    fps = em.output_fps(doc)
    sources = {s["id"]: s for s in doc.get("sources") or []}
    for clip in doc.get("clips") or []:
        source = sources.get(clip.get("sourceId"))
        if source is None:
            continue
        cid = clip["id"]
        tiny = source.get("width", 0) < 2 or source.get("height", 0) < 2
        problem = None
        if "crop" in clip:
            if not _rect_inside(clip["crop"]):
                problem = f"clip {cid} has a crop outside its source frame"
            elif tiny:
                problem = f"clip {cid} crops a source with no pixel size"
        if problem is None and "zoom" in clip:
            keys = clip["zoom"].get("keys") or []
            frames = [em.js_round(k["tMs"] * fps / 1000) for k in keys]
            if "crop" in clip:
                problem = f"clip {cid} has both a crop and zoom keys"
            elif not keys:
                problem = f"clip {cid} has a zoom with no keys"
            elif not all(_rect_inside(k.get("rect")) for k in keys):
                problem = f"clip {cid} has a zoom key outside its source frame"
            elif tiny:
                problem = f"clip {cid} zooms a source with no pixel size"
            elif any(b <= a for a, b in zip(frames, frames[1:])):
                problem = f"clip {cid} has zoom keys out of order or two on one output frame"
        if problem:
            out.append(_issue("error", "bad-crop", problem, clip=cid))
            break
    return out


def static_issues(doc: Dict[str, Any], name: Optional[str] = None, project: Any = None, caps: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Errors and warnings the app's validate reports, from the doc alone (plus source files when project is given)."""
    issues: List[Dict[str, Any]] = []
    sources = {s["id"]: s for s in doc.get("sources") or []}
    fps = em.output_fps(doc)
    if name is not None and doc.get("name") != name:
        issues.append(_issue("error", "name", f'the doc is named "{doc.get("name")}" but lives in edits/{name}.json'))
    clips = doc.get("clips") or []
    if not clips:
        issues.append(_issue("error", "no-clips", "this edit has no clips to render; add one with kb video append NAME assets/<file>"))
    if project is not None:
        used_sources = {c.get("sourceId") for c in clips}
        for s in doc.get("sources") or []:
            problem = exact_case_exists(_root(project), s["rel"]) if isinstance(s.get("rel"), str) else "missing"
            if problem:
                severity = "error" if s["id"] in used_sources else "warning"
                issues.append(_issue(severity, "source-missing", f"source {s['id']} {s.get('rel')}: {'the file is missing' if problem == 'missing' else problem}"))
    laid = em.relayout(clips) if all("inMs" in c and "outMs" in c for c in clips) else clips
    for c, l in zip(clips, laid):
        cid = c.get("id")
        source = sources.get(c.get("sourceId"))
        if source is None:
            issues.append(_issue("error", "unknown-source", f"clip {cid} references unknown source {c.get('sourceId')}", clip=cid))
            continue
        if c["inMs"] > c["outMs"]:
            issues.append(_issue("error", "bad-span", f"clip {cid} starts after it ends (inMs {c['inMs']} > outMs {c['outMs']})", clip=cid))
        if source.get("kind", "video") == "video" and "holdMs" not in c and source.get("durationMs", 0) > 0:
            frame = 1000 / (source["fps"] if source.get("fps", 0) > 0 else fps)
            if c["outMs"] > source["durationMs"] + frame:
                issues.append(_issue("error", "past-source", f"clip {cid} ends at {c['outMs']} ms, past its source's {source['durationMs']} ms", clip=cid))
        speed = c.get("speed")
        if "holdMs" not in c and (not isinstance(speed, (int, float)) or isinstance(speed, bool) or not math.isfinite(speed) or speed <= 0):
            issues.append(_issue("error", "bad-speed", f"clip {cid} has speed {speed!r}; use a positive number", clip=cid))
        if "holdMs" in c and c["holdMs"] < em.MIN_HOLD_MS:
            issues.append(_issue("warning", "short-hold", f"clip {cid} holds {c['holdMs']} ms, under the {em.MIN_HOLD_MS} ms minimum", clip=cid))
        if "holdMs" not in c and 0 <= c["outMs"] - c["inMs"] < em.MIN_CLIP_SOURCE_MS:
            issues.append(_issue("warning", "short-clip", f"clip {cid} spans {c['outMs'] - c['inMs']} ms of source, under {em.MIN_CLIP_SOURCE_MS} ms", clip=cid))
        if c.get("startMs") != l.get("startMs"):
            issues.append(_issue("warning", "not-laid-out", f"clip {cid} startMs {c.get('startMs')} is not laid out (should be {l.get('startMs')})", clip=cid))
    issues.extend(mask_errors(doc))
    issues.extend(crop_errors(doc))
    used = {c.get("sourceId") for c in clips}
    for mask in doc.get("masks") or []:
        if mask["sourceId"] not in used:
            issues.append(_issue("warning", "mask-unused-source", f"mask {mask['id']} hides part of {mask['sourceId']}, which no clip uses", mask=mask["id"]))
    for tap in doc.get("taps") or []:
        if not all(0 <= v <= 1 for v in tap.get("pos") or []):
            issues.append(_issue("warning", "tap-pos", f"tap {tap['id']} sits outside the frame at ({tap['pos'][0]:g}, {tap['pos'][1]:g}); positions are 0..1", tap=tap["id"]))
        if not em.tap_windows(laid, tap, em.TAP_DURATION_MS):
            issues.append(_issue("warning", "tap-hidden", f"tap {tap['id']} at {tap['sourceId']}@{tap['sourceMs']} ms is never on screen (its moment was cut, or sits on a freeze)", tap=tap["id"]))
    tap_caps = (caps or {}).get("tap") or {}
    if doc.get("tapStyle") is not None and tap_caps.get("styles") and doc["tapStyle"] not in tap_caps["styles"]:
        issues.append(_issue("warning", "tap-style", f'unknown tap style "{doc["tapStyle"]}" renders as {tap_caps.get("defaultStyle") or tap_caps["styles"][0]}; one of {", ".join(tap_caps["styles"])}'))
    if doc.get("tapColor") is not None and tap_caps.get("colors") and doc["tapColor"] not in tap_caps["colors"]:
        issues.append(_issue("warning", "tap-color", f'unknown tap colour "{doc["tapColor"]}" renders as {tap_caps.get("defaultColor") or tap_caps["colors"][0]}; one of {", ".join(tap_caps["colors"])}'))
    size = doc.get("tapSize")
    lo, hi = tap_caps.get("sizeRange") or TAP_SIZE_RANGE
    if isinstance(size, (int, float)) and not isinstance(size, bool) and not (lo <= size <= hi):
        issues.append(_issue("warning", "tap-size", f"tapSize {size} renders clamped to {min(hi, max(lo, size))} ({lo}-{hi})"))
    return issues


def errors_of(issues: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [i for i in issues if i["severity"] == "error"]


# ── tap prefs, render record and state ────────────────────────────────────────


def read_tap_prefs(project: Any) -> Dict[str, Any]:
    try:
        data = json.loads((edits_dir(project) / "_tap_prefs.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    out: Dict[str, Any] = {}
    for key in ("tapStyle", "tapColor"):
        if isinstance(data.get(key), str):
            out[key] = data[key]
    if isinstance(data.get("tapSize"), (int, float)) and not isinstance(data.get("tapSize"), bool):
        out["tapSize"] = data["tapSize"]
    return out


def render_record(project: Any, name: str) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(record_path(project, name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def render_state(project: Any, name: str) -> str:
    """"none" (no render), "fresh" (the render matches the doc) or "stale" (the doc changed since)."""
    root = _root(project)
    out = root / output_rel(name)
    doc = edit_path(project, name)
    try:
        out_stat = out.stat()
    except OSError:
        return "none"
    record = render_record(project, name)
    if record is not None and isinstance(record.get("docHash"), str):
        sha = file_sha(doc)
        if sha is None:
            return "fresh"
        return "fresh" if sha == record["docHash"] else "stale"
    try:
        doc_mtime = doc.stat().st_mtime
    except OSError:
        return "fresh"
    return "stale" if doc_mtime > out_stat.st_mtime + 1.0 else "fresh"


# ── per-edit lock ─────────────────────────────────────────────────────────────

class EditLock(FileLock):
    """flock on bridge/video/<slug>/locks/<name>.lock, reentrant within this process (kblib.lock.FileLock)."""

    default_op = "a kb video command"

    def __init__(self, project: Any, name: str, op: str, wait: Optional[float] = None) -> None:
        from .. import identity
        from . import cache

        super().__init__(cache.subdir(project, "locks") / f"{name}.lock", op, LOCK_WAIT_S if wait is None else wait, identity.current().name)
        self.name = name

    def busy(self, holder: str) -> KbError:
        return KbError(
            f"edits/{self.name}.json is busy: {holder}. Wait for it to finish, or rerun with --wait SECONDS",
            EXIT_TRANSIENT,
            kind="locked",
            hint="another kb video command holds this edit; rerun in a moment",
            retry_after_ms=RETRY_AFTER_MS,
            data={"holder": self.holder_info()},
        )


def edit_lock(project: Any, name: str, op: str, wait: Optional[float] = None) -> EditLock:
    return EditLock(project, name, op, wait)


# ── mutate ────────────────────────────────────────────────────────────────────


class Mutation:
    """The outcome of mutate(): the saved doc, the hashes either side, and whether it was rebased on a newer doc."""

    def __init__(self, doc: Dict[str, Any], before: Dict[str, Any], before_sha: str, after_sha: str, rebased: bool, pruned: List[str], saved: bool, issues: List[Dict[str, Any]]) -> None:
        self.doc = doc
        self.before = before
        self.before_sha = before_sha
        self.after_sha = after_sha
        self.rebased = rebased
        self.pruned = pruned
        self.saved = saved
        self.issues = issues

    @property
    def changed(self) -> bool:
        return self.doc != self.before

    def as_dict(self) -> Dict[str, Any]:
        return {"beforeHash": self.before_sha, "hash": self.after_sha, "rebased": self.rebased, "pruned": self.pruned, "saved": self.saved, "changed": self.changed}


def conflict_message(name: str, base: str, current: str) -> str:
    return (
        f"edits/{name}.json changed since {base[:12]} (it is now {current[:12]}): someone (the editor, or another kb command) saved it. "
        f"Nothing was written; re-read it with kb video show {name} and run again"
    )


def finish(doc: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    """The editor's commit normalisation: relaid clips and orphan masks dropped."""
    laid = dict(doc, clips=em.relayout(doc.get("clips") or []))
    if laid.get("masks"):
        kept = em.prune_orphan_masks(laid["clips"], laid["masks"], laid.get("sources") or [])
        if kept is not laid["masks"]:
            ids = {m["id"] for m in kept}
            pruned = [m["id"] for m in laid["masks"] if m["id"] not in ids]
            return dict(laid, masks=list(kept)), pruned
    return laid, []


def mutate(
    project: Any,
    name: str,
    fn: Callable[[Dict[str, Any]], Dict[str, Any]],
    *,
    base: Optional[str] = None,
    label: str = "kb",
    wait: Optional[float] = None,
    dry_run: bool = False,
    caps: Optional[Dict[str, Any]] = None,
) -> Mutation:
    """Lock, read + hash, relayout, fn, static validate, then the app's CLI save --base; a conflict re-runs fn (up to 3 times)
    unless the caller pinned base, which fails at once. fn gets a fresh copy each attempt and must not keep state across calls."""
    check_name(name)

    def attempt(rebased: bool) -> Optional[Mutation]:
        data = read_bytes(project, name)
        sha = sha256_hex(data)
        if base is not None and base != sha:
            raise KbError(conflict_message(name, base, sha), EXIT_PROBLEMS, kind="conflict")
        try:
            before = parse(data)
        except DocError as e:
            raise DocError(f"edits/{name}.json: {e.message}; kb video reset {name} --yes rebuilds it", e.kind) from None
        laid = dict(before, clips=em.relayout(before["clips"]))
        result = fn(json.loads(json.dumps(laid)))
        if not isinstance(result, dict):
            raise KbError("internal: the edit function did not return a doc")
        after, pruned = finish(result)
        before_keys = {(i["code"], i["message"]) for i in errors_of(static_issues(laid, name, project, caps))}
        issues = static_issues(after, name, project, caps)
        fresh = [i for i in errors_of(issues) if (i["code"], i["message"]) not in before_keys]
        if fresh:
            lines = "; ".join(i["message"] for i in fresh)
            raise KbError(f"nothing saved: the change would add {len(fresh)} error(s) to edits/{name}.json: {lines}")
        bad = u64_problems(after)
        if bad:
            raise KbError(f"internal: refusing to save non-integer ms fields ({', '.join(bad[:4])})")
        if dry_run or after == before:
            return Mutation(after, before, sha, sha, rebased, pruned, False, issues)
        from . import appcli

        features = needs(after)
        if features:
            require_caps(caps or appcli.caps(), features, f"edits/{name}.json")
        try:
            saved = appcli.save(project, name, after, sha)
        except appcli.CliError as e:
            if e.cli_code == "conflict":
                if base is not None:
                    raise KbError(conflict_message(name, base, str(e.data.get("hash") or "?")), EXIT_PROBLEMS, kind="conflict") from None
                return None
            raise
        return Mutation(after, before, sha, str(saved.get("hash") or ""), rebased, pruned, True, issues)

    def run() -> Mutation:
        for n in range(SAVE_RETRIES + 1):
            outcome = attempt(n > 0)
            if outcome is not None:
                return outcome
        raise KbError(
            f"edits/{name}.json kept changing while kb saved it ({SAVE_RETRIES + 1} tries); the editor may be autosaving. Rerun in a moment",
            EXIT_TRANSIENT,
            kind="conflict",
            retry_after_ms=RETRY_AFTER_MS,
        )

    if dry_run:
        return run()
    with edit_lock(project, name, label, wait):
        return run()
