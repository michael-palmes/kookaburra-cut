"""Static checks: project.json, scene sidecars and scene TSX, as the contract lists them."""

from __future__ import annotations

import difflib
import json
import math
import re
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from . import catalog as catmod
from . import fonts as fontmod
from . import tsx as tsxmod
from .catalog import Catalog
from .project import MANIFEST, Project, stem_of
from .util import Report, exact_case_exists, is_int, is_number, read_text

SUPPORTED_ASSET_EXTS = {
    "png", "jpg", "jpeg", "webp", "gif",
    "mp4", "mov", "m4v", "webm",
    "mp3", "wav", "m4a", "aac", "flac", "ogg",
    "hdr", "exr", "csv", "tsv", "txt", "cube", "glb", "gltf",
}
AUDIO_EXTS = {"mp3", "wav", "m4a", "aac", "flac", "ogg"}
TEXT_STYLE_SUFFIXES = ("Color", "Font", "Size", "OffsetX", "OffsetY", "LineHeight", "RotationDeg")
HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
FALLBACK_BACKGROUND_TYPES = ["none", "color", "gradient", "image", "video", "scene3d", "shader"]
BACKDROP_TYPES = ["none", "floor", "gradient", "image"]
PATH_KEYS = {"src", "file", "poster"}
KEYED_TRACKS = [
    ("camera",), ("cameraRig",), ("deviceTrack",), ("lighting",), ("compare", "track"),
    ("chart", "track"), ("layeredScreenshot", "animation"),
]


def dig(value: Any, *keys: Any) -> Any:
    for key in keys:
        if isinstance(value, dict) and isinstance(key, str):
            value = value.get(key)
        elif isinstance(value, list) and isinstance(key, int) and -len(value) <= key < len(value):
            value = value[key]
        else:
            return None
    return value


def did_you_mean(value: str, options: Iterable[str]) -> str:
    close = difflib.get_close_matches(value, list(options), n=3, cutoff=0.5)
    return f" Did you mean {', '.join(repr(c) for c in close)}?" if close else ""


class Context:
    """What every check needs once: the catalogue, font verdicts and the app's last load for this project."""

    def __init__(self, project: Project, cat: Optional[Catalog] = None, heartbeat: Optional[Dict[str, Any]] = None) -> None:
        self.project = project
        self.cat = cat or catmod.load_catalog()
        self.verdicts = fontmod.load_verdicts()
        self.font_issues: List[Dict[str, Any]] = []
        last = heartbeat.get("lastLoad") if isinstance(heartbeat, dict) else None
        if isinstance(last, dict) and last.get("project") == project.project_id:
            issues = last.get("fontIssues")
            if isinstance(issues, list):
                self.font_issues = [i for i in issues if isinstance(i, dict)]
        self._tsx: Optional[Dict[str, str]] = None

    def ids(self, family: str, fallback: Optional[List[str]] = None) -> Optional[List[str]]:
        return self.cat.ids(family, fallback)

    def all_tsx(self) -> Dict[str, str]:
        if self._tsx is None:
            self._tsx = self.project.all_tsx()
        return self._tsx


class Checker:
    def __init__(self, ctx: Context, report: Optional[Report] = None) -> None:
        self.ctx = ctx
        self.project = ctx.project
        self.cat = ctx.cat
        self.report = report or Report()
        self._mwarn: Any = self.report.warn
        self._fonts: Dict[Tuple[str, str, str], Any] = {}
        self.outputs: List[Tuple[str, str, str, str]] = []

    # ── shared ────────────────────────────────────────────────────────────

    def enum(self, file: str, path: str, value: Any, family: str, label: str, fallback: Optional[List[str]] = None, extra: Iterable[str] = ()) -> None:
        options = self.ctx.ids(family, fallback)
        if options is None:
            return
        allowed = list(options) + list(extra)
        if not isinstance(value, str):
            self.report.error(file, path, f"{label} must be a string id; see kb catalog {family}")
            return
        if value not in allowed:
            self.report.error(file, path, f'unknown {label} "{value}".{did_you_mean(value, allowed)} See kb catalog {family}')

    def font(self, file: str, path: str, value: Any) -> None:
        if not isinstance(value, str) or not value.strip():
            self.report.error(file, path, 'a font must be a non-empty "Family" or "Family@weight" string')
            return
        verdict = fontmod.static_verdict(value, self.cat, self.ctx.verdicts, self.ctx.font_issues)
        if verdict.severity is None:
            return
        key = (file, verdict.severity, verdict.message)
        seen = self._fonts.get(key)
        if seen is not None:
            seen.path = f"{seen.path}, {path}"
            return
        if verdict.severity == "error":
            self.report.error(file, path, verdict.message)
        else:
            self.report.warn(file, path, verdict.message)
        self._fonts[key] = self.report.issues[-1]

    def asset(self, file: str, path: str, rel: str, missing_is_error: bool = True) -> None:
        if not tsxmod.is_project_asset_ref(rel):
            self.report.error(file, path, f'"{rel}" is not a clean assets/ path (no "..", "." or empty segments)')
            return
        problem = exact_case_exists(self.project.root, rel)
        edit = edit_of_output(self.project, rel)
        if problem == "missing":
            msg = f'"{rel}" does not exist; copy the file in with kb assets add <file> and use the path it prints'
            if edit:
                msg = f'"{rel}" is not rendered yet (edits/{edit}.json exists): kb video render {edit}'
            if missing_is_error:
                self.report.error(file, path, msg)
            else:
                self.report.warn(file, path, msg)
            return
        if problem:
            self.report.error(file, path, f'"{rel}": {problem}; paths are case-sensitive in exports, match the file name exactly')
            return
        if not (self.project.root / rel).is_file():
            self.report.error(file, path, f'"{rel}" is a folder, not a file')
            return
        if edit:
            self.outputs.append((file, path, rel, edit))
        ext = rel.rsplit(".", 1)[-1].lower() if "." in rel.rsplit("/", 1)[-1] else ""
        if ext not in SUPPORTED_ASSET_EXTS:
            self.report.warn(file, path, f'"{rel}" has an unsupported extension ".{ext}"; use png/jpg/webp images, mp4/mov/webm video, mp3/wav/m4a audio')

    # ── project.json ──────────────────────────────────────────────────────

    def manifest(self, include_warnings: bool = True, data: Any = None) -> Optional[Dict[str, Any]]:
        file = MANIFEST
        rep = self.report
        warn = rep.warn if include_warnings else (lambda *a: None)
        self._mwarn = warn
        if data is not None:
            m = data
        else:
            try:
                text = read_text(self.project.manifest_path)
            except OSError as e:
                rep.error(file, "", f"cannot read project.json ({e.strerror})")
                return None
            try:
                m = json.loads(text)
            except json.JSONDecodeError as e:
                rep.error(file, "", f"not valid JSON (line {e.lineno} column {e.colno}: {e.msg}); the project cannot open until this is fixed (kb undo restores the last checkpoint)")
                return None
        if not isinstance(m, dict):
            rep.error(file, "", "must be a JSON object")
            return None
        known = catmod.manifest_keys(self.cat)
        for key in m:
            if key not in known:
                warn(file, key, f"unknown key (the app ignores it).{did_you_mean(key, known)}")
        version = m.get("version")
        current = catmod.manifest_version(self.cat)
        if version is None:
            warn(file, "version", "missing: a legacy v1 manifest (transitions sit on the INCOMING scene); kb scene commands migrate it to version 2")
        elif not is_int(version) or version < 1:
            rep.error(file, "version", f"must be a positive integer (current: {current})")
        elif version > current:
            rep.error(file, "version", f"{version} is newer than this kit understands ({current}); the user needs the latest Kookaburra Cut")
        for key, fallback in (("id", "the folder name"), ("name", "the folder name"), ("themeId", "the default theme")):
            if key not in m:
                warn(file, key, f'missing; the app uses {fallback}. Set it with kb project set {key} "..."')
            elif not isinstance(m.get(key), str) or not m.get(key):
                rep.error(file, key, f'must be a non-empty string (kb project set {key} "...")')
        if isinstance(m.get("id"), str) and m["id"] != self.project.slug:
            warn(file, "id", f'"{m["id"]}" differs from the folder name "{self.project.slug}"; the app identifies the project by its folder')
        formats = m.get("formats")
        if not isinstance(formats, list) or not formats or not all(isinstance(f, str) for f in formats):
            rep.error(file, "formats", f'required: a non-empty array of aspect ids, e.g. ["16:9", "9:16"]; see kb catalog aspects')
        else:
            aspects = self.ctx.ids("aspects", catmod.FALLBACK_ASPECTS) or []
            for i, f in enumerate(formats):
                if f not in aspects:
                    rep.error(file, f"formats[{i}]", f'unknown aspect "{f}".{did_you_mean(f, aspects)} One of: {", ".join(aspects)}')
            if len(set(formats)) != len(formats):
                warn(file, "formats", "lists an aspect twice")
        if isinstance(m.get("themeId"), str) and m["themeId"]:
            self.theme_ref(file, "themeId", m["themeId"], warn)
        self.manifest_scenes(m, warn)
        if "defaultTransition" in m and m["defaultTransition"] is not None:
            self.transition(file, "defaultTransition", m["defaultTransition"])
        typography = m.get("typography")
        if typography is not None:
            if not isinstance(typography, dict):
                rep.error(file, "typography", 'must be an object like {"headline": "Inter@600"}')
            else:
                for slot, value in typography.items():
                    if slot not in ("headline", "body", "chart"):
                        warn(file, f"typography.{slot}", "unknown slot; use headline, body or chart")
                        continue
                    self.font(file, f"typography.{slot}", value)
        audio = m.get("audio")
        if audio is not None:
            if not isinstance(audio, dict) or not isinstance(audio.get("file"), str):
                rep.error(file, "audio", 'must be an object with a string "file" (assets/...)')
            else:
                rel = audio["file"]
                self.asset(file, "audio.file", rel)
                ext = rel.rsplit(".", 1)[-1].lower()
                if ext not in AUDIO_EXTS:
                    rep.error(file, "audio.file", f'"{rel}" is not audio; use mp3, wav, m4a, aac, flac or ogg')
                curve = audio.get("fadeOutCurve")
                if curve is not None and curve not in catmod.AUDIO_FADE_CURVES:
                    warn(file, "audio.fadeOutCurve", f'unknown curve "{curve}" (renders as smooth); one of {", ".join(catmod.AUDIO_FADE_CURVES)}')
                for key in ("gainDb", "fadeInMs", "fadeOutMs", "startOffsetMs"):
                    if key in audio and not is_number(audio[key]):
                        rep.error(file, f"audio.{key}", "must be a number")
        persistent = m.get("persistent")
        if persistent is not None:
            if not isinstance(persistent, str) or not persistent.startswith("scenes/") or not persistent.endswith(".tsx"):
                rep.error(file, "persistent", 'must be a "scenes/<stem>.tsx" path')
            elif exact_case_exists(self.project.root, persistent):
                rep.error(file, "persistent", f'"{persistent}" does not exist; the whole project fails to load')
        return m

    def manifest_scenes(self, m: Dict[str, Any], warn: Any) -> None:
        file = MANIFEST
        rep = self.report
        scenes = m.get("scenes")
        if not isinstance(scenes, list) or not scenes:
            rep.error(file, "scenes", "required: a non-empty array of scene entries; the project cannot open without one")
            return
        legacy = not (is_int(m.get("version")) and m["version"] >= 2)
        seen: Dict[str, int] = {}
        for i, entry in enumerate(scenes):
            path = f"scenes[{i}]"
            if not isinstance(entry, dict):
                rep.error(file, path, 'each scene entry must be an object {"file": "scenes/<stem>.tsx", "durationMs": 3000}')
                continue
            f = entry.get("file")
            if not isinstance(f, str) or not f.startswith("scenes/") or not f.endswith(".tsx") or ".." in f or "/" in f[len("scenes/"):]:
                rep.error(file, f"{path}.file", 'must be "scenes/<stem>.tsx" (one flat file under scenes/)')
            else:
                problem = exact_case_exists(self.project.root, f)
                if problem == "missing":
                    rep.error(file, f"{path}.file", f'"{f}" does not exist; the whole project fails to load. Remove the entry (kb scene remove {i}) or restore the file (kb undo)')
                elif problem:
                    rep.error(file, f"{path}.file", f'"{f}": {problem}')
                norm = f.lstrip("./")
                if norm in seen:
                    rep.error(file, f"{path}.file", f'"{f}" is already scene {seen[norm]}; each entry needs its own file (kb scene duplicate {seen[norm]})')
                else:
                    seen[norm] = i
            dur = entry.get("durationMs")
            if dur is None:
                warn(file, f"{path}.durationMs", "missing; the scene's TSX durationMs is used (set it with kb scene set)")
            elif not is_number(dur) or dur <= 0 or (isinstance(dur, float) and not math.isfinite(dur)):
                rep.error(file, f"{path}.durationMs", "must be a positive number of milliseconds")
            elif not is_int(dur):
                warn(file, f"{path}.durationMs", "should be a whole number of milliseconds")
            if "transition" in entry:
                self.transition(file, f"{path}.transition", entry["transition"])
                if not legacy and i == len(scenes) - 1:
                    warn(file, f"{path}.transition", "the last scene has nothing to exit into, so this transition is inert")
            effects = entry.get("effects")
            if effects is not None and not isinstance(effects, dict):
                rep.error(file, f"{path}.effects", "must be an object")
            for key in entry:
                if key not in ("file", "durationMs", "transition", "effects"):
                    warn(file, f"{path}.{key}", "unknown scene-entry key (ignored); entries hold file, durationMs, transition, effects")

    def transition(self, file: str, path: str, spec: Any) -> None:
        if not isinstance(spec, dict) or not isinstance(spec.get("type"), str):
            self.report.error(file, path, 'must be an object with a string "type", e.g. {"type": "crossfade", "durationMs": 600}')
            return
        self.enum(file, f"{path}.type", spec["type"], "transitions", "transition", catmod.FALLBACK_TRANSITIONS)
        dur = spec.get("durationMs")
        if dur is not None and (not is_number(dur) or dur < 0):
            self.report.error(file, f"{path}.durationMs", "must be a number of milliseconds >= 0")
        elif dur is None:
            self._mwarn(file, f"{path}.durationMs", "missing; set the overlap length in ms")
        ease = spec.get("ease")
        eases = self.ctx.ids("transitionEases", catmod.TRANSITION_EASES) or catmod.TRANSITION_EASES
        if ease is not None and ease not in eases:
            self.report.error(file, f"{path}.ease", f'unknown ease "{ease}"; one of {", ".join(eases)} (absent = linear)')

    def theme_ref(self, file: str, path: str, theme_id: str, warn: Any = None) -> None:
        if theme_id.startswith("ws:"):
            theme_path = self.project.theme_file(theme_id)
            if theme_path is None or not theme_path.is_file():
                (warn or self.report.warn)(file, path, f'workspace theme "{theme_id}" not found at {theme_path}; the app falls back to the default theme. See kb theme list')
            return
        self.enum(file, path, theme_id, "themes", "theme")

    # ── sidecars ──────────────────────────────────────────────────────────

    def sidecar(self, stem: str) -> None:
        file = f"scenes/{stem}.json"
        path = self.project.sidecar_path(stem)
        try:
            text = read_text(path)
        except FileNotFoundError:
            return
        except (OSError, UnicodeDecodeError) as e:
            self.report.error(file, "", f"unreadable ({e})")
            return
        try:
            doc = json.loads(text)
        except json.JSONDecodeError as e:
            self.report.error(file, "", f"not valid JSON (line {e.lineno} column {e.colno}: {e.msg}); the app ignores the whole sidecar until it parses")
            return
        self.sidecar_doc(file, doc)

    def sidecar_doc(self, file: str, doc: Any) -> None:
        rep = self.report
        if not isinstance(doc, dict):
            rep.error(file, "", "must be a JSON object")
            return
        version = doc.get("version")
        current = catmod.scene_doc_version(self.cat)
        if not is_number(version) or version < 1:
            rep.error(file, "version", f"required: {current}; without it the app ignores the whole sidecar")
        elif version > current:
            rep.error(file, "version", f"{version} is newer than the app understands ({current}); the app ignores the whole sidecar")
        known = catmod.scene_doc_keys(self.cat)
        for key in doc:
            if key not in known:
                rep.warn(file, key, f"unknown key (the app ignores it).{did_you_mean(key, known)}")
        if "name" in doc and not isinstance(doc["name"], str):
            rep.error(file, "name", "must be a string")
        text = doc.get("text")
        if text is not None:
            if not isinstance(text, dict):
                rep.error(file, "text", "must be an object of key -> string")
            else:
                for key, value in text.items():
                    if not isinstance(value, str):
                        rep.error(file, f"text.{key}", "must be a string (the app drops it)")
        self.text_style(file, doc.get("textStyle"))
        self.managed_text(file, doc.get("managedText"))
        align = dig(doc, "textLayout", "align")
        if align is not None and align not in ("left", "center", "right"):
            rep.error(file, "textLayout.align", "must be left, center or right")
        if "themeId" in doc:
            if isinstance(doc["themeId"], str) and doc["themeId"]:
                self.theme_ref(file, "themeId", doc["themeId"])
            else:
                rep.error(file, "themeId", "must be a non-empty theme id; see kb theme list")
        self.background(file, "background", doc.get("background"))
        if "backdrop" in doc:
            bd = doc["backdrop"]
            kinds = self.ctx.ids("backgrounds.backdrops", BACKDROP_TYPES) or BACKDROP_TYPES
            if not isinstance(bd, dict) or bd.get("type") not in kinds:
                rep.error(file, "backdrop.type", f'must be one of {", ".join(kinds)}')
        self.text_animation(file, "textAnimation", doc.get("textAnimation"))
        overrides = doc.get("textAnimationOverrides")
        if isinstance(overrides, dict):
            for key, spec in overrides.items():
                self.text_animation(file, f"textAnimationOverrides.{key}", spec)
        self.text_look(file, "textLook", doc.get("textLook"))
        looks = doc.get("textLookOverrides")
        if isinstance(looks, dict):
            for key, spec in looks.items():
                self.text_look(file, f"textLookOverrides.{key}", spec)
        self.devices(file, doc)
        layout = doc.get("deviceLayout")
        if isinstance(layout, dict) and "preset" in layout:
            self.enum(file, "deviceLayout.preset", layout["preset"], "deviceLayouts", "device layout")
        objects = doc.get("objects")
        if objects is not None:
            if not isinstance(objects, list):
                rep.error(file, "objects", "must be an array")
            else:
                for i, obj in enumerate(objects):
                    if not isinstance(obj, dict) or not isinstance(obj.get("id"), str) or not isinstance(obj.get("objectId"), str):
                        rep.error(file, f"objects[{i}]", 'needs string "id" and "objectId" (the app drops it)')
        mode = doc.get("cameraMode")
        if mode is not None and mode not in ("orbit", "rig"):
            rep.error(file, "cameraMode", "must be orbit or rig")
        track = doc.get("animatedTrack")
        if track is not None and track not in catmod.ANIMATED_TRACKS:
            rep.error(file, "animatedTrack", f'must be one of {", ".join(catmod.ANIMATED_TRACKS)}')
        chart = doc.get("chart")
        if isinstance(chart, dict):
            if "type" in chart and self.ctx.ids("charts.types") is not None:
                self.enum(file, "chart.type", chart["type"], "charts.types", "chart type")
            if "font" in chart:
                self.font(file, "chart.font", chart["font"])
        decorations = dig(doc, "frame", "decorations")
        if isinstance(decorations, list):
            for i, deco in enumerate(decorations):
                if isinstance(deco, dict) and "font" in deco:
                    self.font(file, f"frame.decorations[{i}].font", deco["font"])
        for keys in KEYED_TRACKS:
            self.keyed_track(file, ".".join(keys), dig(doc, *keys), allow_jump=keys[0] in ("camera", "cameraRig"))
        stills = doc.get("stills")
        if isinstance(stills, dict) and "marksMs" in stills:
            marks = stills["marksMs"]
            if not isinstance(marks, list) or not all(is_int(t) and t >= 0 for t in marks) or marks != sorted(set(marks)):
                rep.error(file, "stills.marksMs", "must be ascending, unique, whole milliseconds >= 0")
        self.assets_in(file, "", doc)

    def text_style(self, file: str, style: Any) -> None:
        if style is None:
            return
        rep = self.report
        if not isinstance(style, dict):
            rep.error(file, "textStyle", "must be an object keyed <textKey><Suffix>")
            return
        for key, value in style.items():
            path = f"textStyle.{key}"
            suffix = next((s for s in TEXT_STYLE_SUFFIXES if key.endswith(s) and len(key) > len(s)), None)
            if suffix is None:
                rep.error(file, path, f"not a <textKey>{'|'.join(TEXT_STYLE_SUFFIXES)} key (the app drops it)")
                continue
            if suffix == "Font":
                self.font(file, path, value)
            elif suffix == "Color":
                if not isinstance(value, str) or not value:
                    rep.error(file, path, 'must be a hex colour string like "#ff5a36"')
                elif not HEX_RE.match(value):
                    rep.warn(file, path, f'"{value}" is not a #rgb or #rrggbb hex')
            elif suffix == "Size":
                if not is_number(value) or value <= 0:
                    rep.error(file, path, "must be a positive number (a multiplier; 1 = as designed)")
            elif not is_number(value):
                rep.error(file, path, "must be a finite number")

    def managed_text(self, file: str, block: Any) -> None:
        if block is None:
            return
        rep = self.report
        if not isinstance(block, dict) or not isinstance(block.get("items"), list):
            rep.error(file, "managedText", 'needs an "items" array (the app drops the whole block)')
            return
        if "layout" in block and block["layout"] != "template":
            rep.error(file, "managedText.layout", 'must be "template" or absent')
        markers = self.ctx.ids("bulletMarkers", catmod.FALLBACK_BULLET_MARKERS) or catmod.FALLBACK_BULLET_MARKERS
        keys: Set[str] = set()
        for i, item in enumerate(block["items"]):
            path = f"managedText.items[{i}]"
            if not isinstance(item, dict) or not isinstance(item.get("key"), str) or not item["key"].strip():
                rep.error(file, path, "needs a non-empty string key (the app drops it)")
                continue
            if item.get("type") not in catmod.MANAGED_TEXT_TYPES:
                rep.error(file, f"{path}.type", f'must be one of {", ".join(catmod.MANAGED_TEXT_TYPES)} (the app drops the item)')
            if item["key"] in keys:
                rep.error(file, f"{path}.key", f'duplicate key "{item["key"]}" (the app drops the second)')
            keys.add(item["key"])
            for field in ("text", "icon"):
                if field in item and not isinstance(item[field], str):
                    rep.error(file, f"{path}.{field}", "must be a string")
            if "marker" in item and item["marker"] not in markers:
                rep.error(file, f"{path}.marker", f'unknown marker "{item["marker"]}"; one of {", ".join(markers)}')
            points = item.get("points")
            if points is not None:
                if not isinstance(points, list):
                    rep.error(file, f"{path}.points", "must be an array of {key, text}")
                else:
                    pkeys: Set[str] = set()
                    for j, point in enumerate(points):
                        if not isinstance(point, dict) or not isinstance(point.get("key"), str) or not isinstance(point.get("text"), str) or point.get("key") in pkeys:
                            rep.error(file, f"{path}.points[{j}]", "needs a unique string key and string text (the app drops it)")
                            continue
                        pkeys.add(point["key"])
        groups = block.get("groups")
        if isinstance(groups, list):
            for i, group in enumerate(groups):
                if not isinstance(group, dict) or not isinstance(group.get("itemKeys"), list):
                    rep.error(file, f"managedText.groups[{i}]", "needs a key and an itemKeys array")
                    continue
                for k in group["itemKeys"]:
                    if k not in keys:
                        rep.warn(file, f"managedText.groups[{i}].itemKeys", f'"{k}" matches no item key')

    def background(self, file: str, path: str, bg: Any) -> None:
        if bg is None:
            return
        if not isinstance(bg, dict) or not isinstance(bg.get("type"), str):
            self.report.error(file, path, 'must be an object with a "type"; see kb catalog backgrounds.types')
            return
        self.enum(file, f"{path}.type", bg["type"], "backgrounds.types", "background type", FALLBACK_BACKGROUND_TYPES)
        kind = bg["type"]
        if kind == "scene3d":
            self.enum(file, f"{path}.look", bg.get("look"), "backgrounds.scene3d", "3D background look")
            if "backing" in bg:
                self.background(file, f"{path}.backing", bg["backing"])
        elif kind == "shader":
            self.enum(file, f"{path}.shader", bg.get("shader"), "backgrounds.shaders", "shader")
        elif kind in ("image", "video"):
            src = bg.get("src")
            if not isinstance(src, str) or not src:
                self.report.error(file, f"{path}.src", "required: assets/<file> (or kookaburra:<name> for a bundled image)")
            elif src.startswith("kookaburra:"):
                images = self.ctx.ids("backgrounds.images")
                name = src[len("kookaburra:"):]
                if images is not None and name not in images and src not in images:
                    self.report.error(file, f"{path}.src", f'unknown bundled image "{src}"; see kb catalog backgrounds.images')
            elif not src.startswith("assets/"):
                self.report.error(file, f"{path}.src", f'"{src}" must be a project path under assets/ (no absolute paths or URLs)')
        elif kind == "color" and not (isinstance(bg.get("color"), str) and HEX_RE.match(bg["color"])):
            self.report.error(file, f"{path}.color", 'required: a hex colour like "#101418"')

    def text_animation(self, file: str, path: str, spec: Any) -> None:
        if spec is None:
            return
        if not isinstance(spec, dict):
            self.report.error(file, path, 'must be an object {"in", "out", "staggerMs"}')
            return
        for field in ("in", "out"):
            if field in spec:
                self.enum(file, f"{path}.{field}", spec[field], "textMotion", "text motion")

    def text_look(self, file: str, path: str, spec: Any) -> None:
        if spec is None:
            return
        if not isinstance(spec, dict) or "preset" not in spec:
            self.report.error(file, path, 'must be an object with a "preset"')
            return
        self.enum(file, f"{path}.preset", spec["preset"], "textLooks", "text look", extra=["none"])

    def devices(self, file: str, doc: Dict[str, Any]) -> None:
        devices = doc.get("devices")
        if devices is None:
            return
        rep = self.report
        if not isinstance(devices, list):
            rep.error(file, "devices", "must be an array")
            return
        ids: Set[str] = set()
        for i, d in enumerate(devices):
            path = f"devices[{i}]"
            if not isinstance(d, dict) or not isinstance(d.get("id"), str) or not isinstance(d.get("model"), str):
                rep.error(file, path, 'needs string "id" and "model" (the app drops it)')
                continue
            if d["id"] in ids:
                rep.error(file, f"{path}.id", f'duplicate device id "{d["id"]}"')
            ids.add(d["id"])
            self.enum(file, f"{path}.model", d["model"], "devices", "device model")
            if "colour" in d:
                self.device_colour(file, f"{path}.colour", d["model"], d["colour"])
            if "shadow" in d:
                self.enum(file, f"{path}.shadow", d["shadow"], "deviceShadows", "device shadow")
            preset = dig(d, "motion", "preset")
            if preset is not None:
                self.enum(file, f"{path}.motion.preset", preset, "deviceMotion", "device motion")

    def device_colour(self, file: str, path: str, model: str, colour: Any) -> None:
        entry = next((e for e in self.cat.entries("devices") or [] if e.get("id") == model), None)
        colours = entry.get("colours") if isinstance(entry, dict) else None
        if not isinstance(colours, list):
            return
        ids = [str(c.get("id")) for c in colours if isinstance(c, dict)]
        if isinstance(colour, str) and (colour in ids or re.match(r"^custom:#[0-9a-fA-F]{6}$", colour)):
            return
        self.report.error(file, path, f'"{colour}" is not a {model} colour; one of {", ".join(ids)} or custom:#rrggbb')

    def keyed_track(self, file: str, path: str, track: Any, allow_jump: bool) -> None:
        if not isinstance(track, dict):
            return
        keys = track.get("keys")
        segments = track.get("segments")
        if keys is None and segments is None:
            return
        if not isinstance(keys, list) or not isinstance(segments, list):
            if path in ("camera", "cameraRig"):
                self.report.error(file, path, 'needs both "keys" and "segments" arrays (the app drops the track)')
            return
        ids = [k.get("id") for k in keys if isinstance(k, dict)]
        seen: Set[Any] = set()
        for i, k in enumerate(keys):
            if not isinstance(k, dict) or not isinstance(k.get("id"), str) or not is_number(k.get("tMs")):
                self.report.error(file, f"{path}.keys[{i}]", 'needs a string "id" and a numeric "tMs"')
                continue
            if k["id"] in seen:
                self.report.error(file, f"{path}.keys[{i}].id", f'duplicate key id "{k["id"]}"')
            seen.add(k["id"])
        eases = self.ctx.ids("eases")
        for i, seg in enumerate(segments):
            if not isinstance(seg, dict):
                self.report.error(file, f"{path}.segments[{i}]", "must be an object {from, to, ease}")
                continue
            for end in ("from", "to"):
                if seg.get(end) not in ids:
                    self.report.error(file, f"{path}.segments[{i}].{end}", f'"{seg.get(end)}" matches no key id ({", ".join(str(x) for x in ids) or "no keys"})')
            for field in ("ease", "easeDof"):
                if field in seg and eases is not None:
                    self.enum(file, f"{path}.segments[{i}].{field}", seg[field], "eases", "ease", extra=["jump"])

    def assets_in(self, file: str, path: str, value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                child_path = f"{path}.{key}" if path else key
                if isinstance(child, str) and key in PATH_KEYS and (child.startswith("/") or "://" in child or child.startswith("~")):
                    self.report.error(file, child_path, f'"{child}" must be a project path under assets/ (copy it in with kb assets add)')
                    continue
                self.assets_in(file, child_path, child)
        elif isinstance(value, list):
            for i, child in enumerate(value):
                self.assets_in(file, f"{path}[{i}]", child)
        elif isinstance(value, str) and value.startswith("assets/"):
            informational = path.endswith("chart.data.source")
            self.asset(file, path, value, missing_is_error=not informational)

    # ── TSX ───────────────────────────────────────────────────────────────

    def tsx(self, rel: str, text: Optional[str] = None) -> None:
        rep = self.report
        if text is None:
            try:
                text = read_text(self.project.root / rel)
            except FileNotFoundError:
                return
            except (OSError, UnicodeDecodeError) as e:
                rep.error(rel, "", f"unreadable ({e})")
                return
        code = tsxmod.blank_comments_and_strings(text)
        persistent = self.project_persistent() == rel
        toolkit_names: Set[str] = set()
        exports = self.cat.ids("toolkit.exports")
        if exports is not None:
            exports = exports + (self.cat.ids("toolkit.types") or [])
        for imp in tsxmod.parse_imports(text):
            if imp.specifier == tsxmod.TOOLKIT:
                toolkit_names.update(imp.names)
                if exports is not None and not imp.type_only:
                    for name in imp.names:
                        if name not in exports:
                            rep.error(rel, f"line {imp.line}", f'"{name}" is not exported by @kookaburra/toolkit, so the scene fails to load.{did_you_mean(name, exports)} See kb catalog toolkit.exports')
            elif imp.specifier == tsxmod.JSX_RUNTIME:
                rep.warn(rel, f"line {imp.line}", "react/jsx-runtime is emitted by the compiler; remove this import")
            elif imp.specifier.startswith("."):
                rep.error(rel, f"line {imp.line}", f'import "{imp.specifier}": scenes are single files; inline the code (only @kookaburra/toolkit resolves)')
            else:
                rep.error(rel, f"line {imp.line}", f'import "{imp.specifier}" does not resolve; scenes may import only @kookaburra/toolkit (no react, three, drei, anime.js)')
        for m in tsxmod.DYNAMIC_IMPORT_RE.finditer(code):
            rep.error(rel, f"line {tsxmod.line_of(code, m.start())}", f"{m.group(1)}() is not available in scenes; import from @kookaburra/toolkit only")
        if not persistent:
            count = len(tsxmod.EXPORT_DEFAULT_RE.findall(code))
            if count == 0:
                other = tsxmod.ANY_EXPORT_DEFAULT_RE.search(code)
                why = "the default export is not defineScene(...)" if other else "no default export"
                rep.error(rel, "", f"{why}; a scene must be exactly one export default defineScene({{ id, durationMs, Scene }})")
            elif count > 1:
                rep.error(rel, "", f"{count} export default defineScene calls; keep exactly one per file")
            if count and "defineScene" not in toolkit_names:
                rep.error(rel, "", 'defineScene is not imported; add it to the import from "@kookaburra/toolkit"')
            sid = tsxmod.scene_id(text)
            if sid is None and count:
                rep.error(rel, "defineScene.id", 'needs a literal string id as its first key, e.g. id: "pricing" (no template ${}, no variables)')
            elif sid is not None:
                order = self.heal_order()
                rank = order.index(rel) if rel in order else len(order)
                owners = [f for f in order[:rank] if tsxmod.scene_id(self.ctx.all_tsx().get(f, "")) == sid]
                if owners:
                    taken = {tsxmod.scene_id(t) for t in self.ctx.all_tsx().values()}
                    rep.error(rel, "defineScene.id", f'"{sid}" is already the id of {owners[0]}; ids must be unique per project (the app would rename this one on load). Use "{free_id(sid, taken)}"')
        for line, token, why in tsxmod.banned_uses(code):
            rep.error(rel, f"line {line}", f"{token}: {why}")
        local = tsxmod.local_bindings(text)
        flagged: Set[str] = set()
        for line, name in tsxmod.hook_calls(code):
            if name in local or name in flagged:
                continue
            flagged.add(name)
            if name in tsxmod.REACT_HOOKS:
                rep.error(rel, f"line {line}", f"{name} is not available: the toolkit does not export React hooks. Compute values inline (the scene re-renders every frame) and drive motion from useTimeline()")
            elif exports and name in exports:
                rep.error(rel, f"line {line}", f'{name} is not imported; add it to the import from "@kookaburra/toolkit"')
            else:
                hint = did_you_mean(name, exports) if exports else ""
                rep.error(rel, f"line {line}", f"{name} is not imported from @kookaburra/toolkit.{hint}")
        for line, ref in tsxmod.literal_asset_refs(text):
            self.asset(rel, f"line {line}", ref)

    def heal_order(self) -> List[str]:
        """The app's id-healing order: manifest scenes first, then stray scenes/*.tsx by name; the first sighting keeps its id."""
        try:
            order = [f for f in self.project.scene_files() if f]
        except Exception:
            order = []
        strays = sorted(f for f in self.ctx.all_tsx() if f not in order)
        return list(dict.fromkeys(order + strays))

    def project_persistent(self) -> Optional[str]:
        try:
            return self.project.persistent_file()
        except Exception:
            return None

    # ── whole project ─────────────────────────────────────────────────────

    def strays(self) -> None:
        try:
            listed = set(self.project.scene_files())
        except Exception:
            return
        persistent = self.project_persistent()
        if not self.project.scenes_dir.is_dir():
            return
        for path in sorted(self.project.scenes_dir.iterdir()):
            rel = f"scenes/{path.name}"
            if path.name.startswith("."):
                continue
            if path.suffix == ".tsx" and rel not in listed and rel != persistent:
                self.report.warn(rel, "", f"not in project.json, so the app never shows it. Register it with kb scene add {path.stem}, or move it out of scenes/")
            elif path.suffix == ".json" and f"scenes/{path.stem}.tsx" not in listed and not (self.project.scenes_dir / f"{path.stem}.tsx").exists():
                self.report.warn(rel, "", "sidecar without a scene file; delete it or restore the .tsx")

    def theme_fonts(self) -> None:
        try:
            theme_id = self.project.manifest().get("themeId")
        except Exception:
            return
        if not isinstance(theme_id, str) or not theme_id.startswith("ws:"):
            return
        path = self.project.theme_file(theme_id)
        if path is None or not path.is_file():
            return
        try:
            theme = json.loads(read_text(path))
        except (OSError, ValueError):
            self.report.error(f"../themes/{theme_id[3:]}/theme.json", "", "not valid JSON; the app falls back to the default theme")
            return
        typography = theme.get("typography") if isinstance(theme, dict) else None
        if not isinstance(typography, dict):
            return
        for slot, ref in typography.items():
            if isinstance(ref, dict) and isinstance(ref.get("family"), str):
                weight = ref.get("weight", 400)
                self.font(f"../themes/{theme_id[3:]}/theme.json", f"typography.{slot}", f'{ref["family"]}@{weight}')


    # ── video edits (full check only) ─────────────────────────────────────

    def edits(self) -> None:
        """Edit docs the app's video editor and kb video read, and scenes that play a stale render."""
        from .video import editdoc

        for file, path, rel, name in self.outputs:
            if editdoc.render_state(self.project, name) == "stale":
                self.report.warn(file, path, f'"{rel}" is older than edits/{name}.json, so the scene still shows the previous cut: kb video render {name}')
        for name in editdoc.list_names(self.project):
            label = f"edits/{name}.json"
            try:
                doc, _sha = editdoc.load(self.project, name)
            except editdoc.DocError as e:
                message = e.message[len(label) + 2:] if e.message.startswith(label + ": ") else e.message
                self.report.error(label, "", message)
                continue
            for issue in editdoc.static_issues(doc, name, self.project):
                where = ".".join(f"{k} {issue[k]}" for k in ("clip", "tap", "mask") if k in issue)
                severity = issue["severity"]
                if issue["code"] in ("no-clips", "past-source"):
                    severity = "warning"
                if issue["code"] in ("not-laid-out", "short-clip", "short-hold"):
                    continue
                (self.report.error if severity == "error" else self.report.warn)(label, where, issue["message"])


def edit_of_output(project: Project, rel: str) -> Optional[str]:
    """The edit whose render rel is (assets/<name>-edited.mp4 with edits/<name>.json present), else None."""
    if not rel.startswith("assets/") or not rel.endswith("-edited.mp4"):
        return None
    from .video import editdoc

    name = editdoc.name_of_output(rel)
    return name if name and editdoc.edit_path(project, name).is_file() else None


def free_id(base: str, taken: Set[Any]) -> str:
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


def check_project(project: Project, files: Optional[List[str]] = None, heartbeat: Optional[Dict[str, Any]] = None, ctx: Optional[Context] = None) -> Report:
    """Full check, or one scoped to `files` (project-relative) plus the manifest's errors."""
    ctx = ctx or Context(project, heartbeat=heartbeat)
    checker = Checker(ctx)
    scoped = files is not None
    want_manifest_warnings = not scoped or MANIFEST in (files or [])
    manifest = checker.manifest(include_warnings=want_manifest_warnings)
    if not want_manifest_warnings:
        checker.report.issues = [i for i in checker.report.issues if not (i.file == MANIFEST and i.severity == "warning")]
    listed: List[str] = []
    if manifest is not None and isinstance(manifest.get("scenes"), list):
        listed = [e.get("file") for e in manifest["scenes"] if isinstance(e, dict) and isinstance(e.get("file"), str)]
    if not scoped:
        for f in listed:
            if (project.root / f).is_file():
                checker.tsx(f)
            checker.sidecar(stem_of(f))
        persistent = checker.project_persistent()
        if persistent and (project.root / persistent).is_file():
            checker.tsx(persistent)
        checker.strays()
        checker.theme_fonts()
        checker.edits()
        return checker.report
    for f in files or []:
        if f == MANIFEST:
            continue
        if f.startswith("scenes/") and f.endswith(".tsx"):
            checker.tsx(f)
            if f not in listed and f != checker.project_persistent():
                checker.report.warn(f, "", f"not in project.json yet, so the app never shows it. Register it with kb scene add {stem_of(f)}")
        elif f.startswith("scenes/") and f.endswith(".json"):
            checker.sidecar(stem_of(f[:-5]))
        elif f.startswith("assets/"):
            continue
    return checker.report
