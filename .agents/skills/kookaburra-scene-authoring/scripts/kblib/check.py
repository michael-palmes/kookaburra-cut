"""Static checks: project.json, scene sidecars and scene TSX, as the contract lists them."""

from __future__ import annotations

import difflib
import json
import math
import os
import re
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from . import catalog as catmod
from . import fonts as fontmod
from . import music
from . import themes as thememod
from . import tsx as tsxmod
from .catalog import Catalog
from .project import MANIFEST, Project, stem_of
from .util import KbError, Report, exact_case_exists, is_int, is_number, js_json, read_text

SUPPORTED_ASSET_EXTS = {
    "png", "jpg", "jpeg", "webp", "gif",
    "mp4", "mov", "m4v", "webm",
    "mp3", "wav", "m4a", "aac", "flac", "ogg",
    "hdr", "exr", "csv", "tsv", "txt", "cube", "glb", "gltf",
}
AUDIO_EXTS = {"mp3", "wav", "m4a", "aac", "flac", "ogg"}
TEXT_STYLE_SUFFIXES = ("Color", "Font", "Size", "OffsetX", "OffsetY", "LineHeight", "RotationDeg", "Emphasis")
HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
# textStyle.<key>Emphasis: "<colour>" or "<colour>@<weight>" (toolkit/text/emphasis.ts).
EMPHASIS_RE = re.compile(r"^(text|muted|accent|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})(?:@(\d{1,4}))?$")
FALLBACK_BACKGROUND_TYPES = ["none", "color", "gradient", "image", "video", "scene3d", "shader"]
BACKDROP_TYPES = ["none", "floor", "gradient", "image"]
PATH_KEYS = {"src", "file", "poster"}
KEYED_TRACKS = [
    ("camera",), ("cameraRig",), ("deviceTrack",), ("lighting",), ("compare", "track"),
    ("chart", "track"), ("layeredScreenshot", "animation"),
]
# Toolkit calls taking an ease name, and the 0-based argument it sits in.
EASE_CALLS = {"ease": 0, "easeFn": 0, "ramp": 3}
EASE_CALL_RE = re.compile(r"(?<![\w$.])(ease|easeFn|ramp)\s*\(")
DECLARED_RE = re.compile(r"\b(?:function|const|let|var)\s+([\w$]+)")
# Device media keys and camera kicks (sceneDocSchema.ts parseDeviceMediaKeys, parseCameraKicks).
EDITOR_SPEEDS = (0.25, 6)
KICK_FIELDS = ("id", "at", "zoom", "offset", "rollDeg", "attackMs", "holdMs", "releaseMs", "ease")
KICK_ZOOM = (0.25, 4)
DEPTH_STAGE_RE = re.compile(r"<DepthStage\b")


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
        self.available_devices = Checker.heartbeat_devices(heartbeat)
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
        self.media_refs: List[Tuple[str, str, str]] = []

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
            original = conforming_original(self.project, rel)
            if original:
                self.report.info(file, path, f'"{rel}" is still conforming from {original}; rerun ./kb check when it lands')
                return
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
        self.media_refs.append((file, path, rel))
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
        if "brand" in m:
            brand = m["brand"]
            if not isinstance(brand, str) or not brand.startswith("ws:") or len(brand) < 4:
                rep.error(file, "brand", 'must be a workspace brand id "ws:<slug>" (kb brand list; kb brand use <name>)')
            elif not self.project.brand_file(brand).is_file():
                warn(file, "brand", f"{brand} is not in this workspace's brands/; the app shows no brand images or colours (kb brand list)")
            elif not (self.project.root / "BRAND.md").is_file():
                warn(file, "brand", f"BRAND.md is missing; kb brand use {brand} writes it")
        self.manifest_scenes(m, warn)
        if include_warnings:
            self.cut_warnings(m, warn)
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
                self.music_manifest(audio, warn, include_warnings)
        if "shared" in m and not isinstance(m["shared"], dict):
            rep.error(file, "shared", 'must be an object of constants, e.g. {"palette": {"accent": "#ff6a3d"}}; the app ignores anything else')
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
            cut = entry.get("cutAt")
            if "cutAt" in entry and not (isinstance(cut, str) and music.is_position(cut)):
                rep.error(file, f"{path}.cutAt", "must be a position like bar:9, bar:9.3, cue:drop or section:chorus (kb scene set S --cut-at POS)")
            if "align" in entry:
                if entry["align"] not in ("end", "mid"):
                    rep.error(file, f"{path}.align", 'must be "end" (the scene is gone at cutAt) or "mid" (its outgoing transition is centred on it)')
                elif "cutAt" not in entry:
                    warn(file, f"{path}.align", "has no cutAt to align, so it is inert")
            for key in entry:
                if key not in ("file", "durationMs", "transition", "effects", "cutAt", "align"):
                    warn(file, f"{path}.{key}", "unknown scene-entry key (ignored); entries hold file, durationMs, transition, effects, cutAt, align")

    def cut_warnings(self, m: Dict[str, Any], warn: Any) -> None:
        """Pinned cuts whose cached length is stale or can't resolve, TSX lengths that differ from project.json, and cuts
        that sat on a beat at the last checkpoint and no longer do."""
        from . import cuts as cutsmod
        from .beats import model
        from .film import timeline as tl

        scenes = m.get("scenes")
        if not isinstance(scenes, list) or not scenes or not all(isinstance(e, dict) for e in scenes):
            return
        try:
            durations = model.manifest_durations(self.project, m)
            outgoing = tl.outgoing_transitions(m)
            cuts = tl.resolve_scene_cuts([
                {"durationMs": durations[i], "transition": outgoing[i] if isinstance(outgoing[i], dict) else None,
                 "cutAt": e.get("cutAt") if music.is_position(e.get("cutAt")) else None, "align": e.get("align")}
                for i, e in enumerate(scenes)
            ], model.project_music(m))
        except (KbError, TypeError, ValueError):
            return
        for i in cuts["changed"]:
            warn(MANIFEST, f"scenes[{i}].durationMs", f'{js_json(scenes[i].get("durationMs"))} is stale: cutAt {scenes[i]["cutAt"]} lands this scene at {cuts["durations"][i]} ms, which is what plays; any kb scene or beats write refreshes it')
        for issue in cuts["issues"]:
            n = re.match(r"scene (\d+) ", issue)
            warn(MANIFEST, f"scenes[{int(n.group(1)) - 1}].cutAt" if n else "scenes", f"{issue}, so its stored durationMs plays")
        differ = []
        for e in scenes:
            dur, rel = e.get("durationMs"), e.get("file")
            if not is_number(dur) or not isinstance(rel, str):
                continue
            try:
                literal = tsxmod.defined_duration(self.project.read_tsx(stem_of(rel)))
            except (OSError, UnicodeDecodeError, KbError):
                continue
            if literal is not None and literal != dur:
                differ.append(f"{stem_of(rel)} ({js_json(literal)} in the TSX, {js_json(dur)} in project.json)")
        if differ:
            warn(MANIFEST, "scenes", f"project.json's durationMs is what plays, so the TSX durationMs of {', '.join(differ)} is ignored; change lengths with ./kb scene set or ./kb timeline apply, not in the TSX")
        for d in cutsmod.drift_from_checkpoint(self.project, m):
            warn(MANIFEST, f"scenes[{d['scene']}]", d["message"])

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
        src = spec.get("src")
        if spec.get("shape") == "image":
            if spec["type"] != "luma":
                self._mwarn(file, f"{path}.shape", 'shape "image" only applies to luma; this type ignores it')
            elif not isinstance(src, str) or not src:
                self.report.error(file, f"{path}.src", 'shape "image" needs "src": a png, jpg or webp under assets/ (without it the app renders the iris)')
            elif src.rsplit(".", 1)[-1].lower() not in ("png", "jpg", "jpeg", "webp"):
                self.report.error(file, f"{path}.src", f'"{src}" is not a supported mask image; use png (alpha), jpg or webp under assets/')
            else:
                self.asset(file, f"{path}.src", src)
        elif src is not None:
            self._mwarn(file, f"{path}.src", 'src is only read with "shape": "image" on luma, so it is ignored here')

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
        self.build_single_line(file, doc)
        self.text_look(file, "textLook", doc.get("textLook"))
        looks = doc.get("textLookOverrides")
        if isinstance(looks, dict):
            for key, spec in looks.items():
                self.text_look(file, f"textLookOverrides.{key}", spec)
        self.devices(file, doc)
        self.device_media(file, doc)
        self.camera_kicks(file, doc)
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
        self.music_keys(file, doc)
        self.motion_blur(file, "motionBlur", doc.get("motionBlur"))
        self.room(file, doc)
        self.taps(file, doc)
        self.mosaic(file, doc)
        self.window_shadow_colours(file, doc)
        stills = doc.get("stills")
        if isinstance(stills, dict) and "marksMs" in stills:
            marks = stills["marksMs"]
            if not isinstance(marks, list) or not all(is_int(t) and t >= 0 for t in marks) or marks != sorted(set(marks)):
                rep.error(file, "stills.marksMs", "must be ascending, unique, whole milliseconds >= 0")
        self.assets_in(file, "", doc)

    # ── music: audio.grid, cues, sections and `at` positions ──────────────

    def music_manifest(self, audio: Dict[str, Any], warn: Any, include_warnings: bool) -> None:
        """What the app's sanitiseAudioMusic drops (errors), bar: values with no grid, and a grid fitted to another file."""
        from .beats import cache as beatcache
        from .beats import model as beatmodel

        spec, problems = beatmodel.sanitise_music(audio)
        for path, why in problems:
            self.report.error(MANIFEST, f"audio.{path}", f"{why} (the app drops it)")
        grid = spec.get("grid")
        if grid is None:
            barred = [f"cues.{k}" for k, v in (spec.get("cues") or {}).items() if isinstance(v, str) and v.startswith("bar:")]
            barred += [f"sections {s['id']}" for s in spec.get("sections") or [] if any(isinstance(s[e], str) and s[e].startswith("bar:") for e in ("from", "to"))]
            if barred:
                warn(MANIFEST, "audio.grid", f"{', '.join(barred[:4])} use bar: positions, which resolve only once there is a grid: ./kb song analyse, then ./kb beats set-grid --from-analysis")
        source = grid.get("source") if grid else None
        if include_warnings and isinstance(source, dict) and isinstance(source.get("sha256"), str):
            rel = audio.get("file")
            path = self.project.root / rel if isinstance(rel, str) and tsxmod.is_project_asset_ref(rel) else None
            digest = beatcache.file_digest(path) if path is not None and path.is_file() else None
            if digest is not None and digest != source["sha256"]:
                warn(MANIFEST, "audio.grid.source.sha256", f"the grid was fitted to another file (its SHA-256 differs from {rel}); refit with ./kb song analyse --accept, or keep it if the music is the same")

    def music_keys(self, file: str, doc: Dict[str, Any]) -> None:
        """Positions on keys, screen and media video starts and camera kicks that can't resolve or apply, and `at` fields whose time cache is stale."""
        from .beats import model as beatmodel

        kicks = doc.get("cameraKicks") if isinstance(doc.get("cameraKicks"), list) else []
        if not beatmodel.has_at(doc) and not any(isinstance(k, dict) and isinstance(k.get("at"), str) for k in kicks):
            return
        scope = self._music_scope(file)
        if scope is None:
            return
        m, start = scope
        stem = stem_of(file[:-5] + ".tsx") if file.endswith(".json") else file
        for slot in beatmodel.timed_slots(doc):
            if "at" not in slot.node:
                continue
            path = beatmodel.check_path(slot.steps)
            where = f"{path}.at"
            at = slot.node["at"]
            if not isinstance(at, str):
                self.report.warn(file, where, 'must be a position string like "bar:13" (the app ignores it)')
                continue
            r = beatmodel.slot_position(slot, m, start)
            if not r["ok"]:
                effect = "the key stays at its stored tMs" if slot.field == "tMs" else "the video keeps its stored startMs"
                self.music_position_issue(file, where, at, r, effect)
                continue
            t = beatmodel.stored_ms(slot.node, slot.field)
            if is_number(t) and t != r["projectMs"]:
                self.report.warn(file, f"{path}.{slot.field}", f'{t} isn\'t where "{at}" lands ({r["projectMs"]} ms), so the app uses {r["projectMs"]}: fine after a grid or timing change (the app rewrites it on load); to keep {t}, ./kb doc {stem} unset {beatmodel.doc_path(slot.steps)}.at')
        for i, kick in enumerate(kicks):
            if isinstance(kick, dict) and isinstance(kick.get("at"), str):
                r = beatmodel.resolve_local(kick["at"], m, start)
                if not r["ok"]:
                    self.music_position_issue(file, f"cameraKicks[{i}].at", kick["at"], r, "the app drops the kick")

    def music_position_issue(self, file: str, where: str, at: str, r: Dict[str, Any], effect: str) -> None:
        if r["code"] == "no-grid":
            self.report.warn(file, where, f'"{at}" needs a beat grid, so {effect}: ./kb song analyse, then ./kb beats set-grid --from-analysis')
        elif r["code"] == "unknown":
            self.report.warn(file, where, f'"{at}": {r["message"]}, so {effect}. See ./kb beats')
        else:
            self.report.error(file, where, f'"{at}": {r["message"]} ({effect})')

    def _music_scope(self, file: str) -> Optional[Tuple[Any, float]]:
        """(the project's music, this sidecar's slot start), read once per check; None when project.json can't be read."""
        from .beats import model as beatmodel

        cached = getattr(self, "_music_cache", None)
        if cached is None:
            try:
                manifest = self.project.manifest()
                cached = (beatmodel.project_music(manifest), {s["stem"]: s["startMs"] for s in reversed(beatmodel.slots_of(self.project, manifest))})
            except Exception:
                cached = False
            self._music_cache = cached
        if not cached:
            return None
        stem = stem_of(file[:-5] + ".tsx") if file.endswith(".json") else file
        return cached[0], cached[1].get(stem, 0)

    def motion_blur(self, file: str, path: str, block: Any) -> None:
        """The scene override; a bad field is dropped by the app, so the scene follows the project instead."""
        if block is None:
            return
        rep = self.report
        if not isinstance(block, dict):
            rep.error(file, path, "must be an object { enabled, shutterDeg, camera, objects }")
            return
        for key in ("enabled", "camera", "objects"):
            if key in block and not isinstance(block[key], bool):
                rep.error(file, f"{path}.{key}", "must be true or false (the app drops it)")
        deg = block.get("shutterDeg")
        if deg is not None and (not is_number(deg) or not 0 <= deg <= 360):
            rep.error(file, f"{path}.shutterDeg", "must be 0..360 (Crisp 90, Film 180, Smooth 270, Smear 360)")
        if "samples" in block:
            rep.warn(file, f"{path}.samples", "samples is project-wide: set it in project.json render.motionBlur")

    # ── rooms ─────────────────────────────────────────────────────────────

    ROOM_KEY_FIELDS = ("at", "colour", "themeId", "lighting", "transition", "origin", "durationMs", "ease")
    ROOM_LIGHT_FIELDS = ("intensity", "color", "colorToken", "kelvin")
    ROOM_TOKENS = ("background", "text", "accent", "muted")
    # The fills text resolves through the palette (resolveTokenFill); anything else is a raw colour.
    TEXT_FILL_TOKENS = ("text", "muted", "accent")

    def room(self, file: str, doc: Dict[str, Any]) -> None:
        """The sidecar `room` track; a bad key is dropped by the app, a bad field falls back."""
        block = doc.get("room")
        if block is None:
            return
        rep = self.report
        if not isinstance(block, dict) or not isinstance(block.get("keys"), list) or not block["keys"]:
            rep.error(file, "room", "must be { keys: [...] } with at least one key (the app drops the block)")
            return
        for extra in block:
            if extra != "keys":
                rep.warn(file, f"room.{extra}", "not a room field (the app ignores it)")
        flood_ends: List[Tuple[float, float, str]] = []
        for i, key in enumerate(block["keys"]):
            path = f"room.keys[{i}]"
            if not isinstance(key, dict):
                rep.error(file, path, "must be an object (the app drops it)")
                continue
            for field in key:
                if field not in self.ROOM_KEY_FIELDS:
                    rep.warn(file, f"{path}.{field}", f"not a room key field (the app ignores it).{did_you_mean(field, self.ROOM_KEY_FIELDS)}")
            at = key.get("at")
            if isinstance(at, str):
                from . import music

                if music.is_position(at):
                    self.kick_position(file, f"{path}.at", at, "room key")
                else:
                    rep.error(file, f"{path}.at", 'must be scene-local ms or a position like "bar:13" or "cue:drop" (the app drops the key)')
            elif not is_number(at):
                rep.error(file, f"{path}.at", "must be scene-local ms (the app drops the key)")
            elif at < 0:
                rep.warn(file, f"{path}.at", "is below 0; the app plays the key from 0")
            colour = key.get("colour")
            if colour is not None and not (isinstance(colour, str) and (HEX_RE.match(colour) and len(colour) in (4, 7) or colour in self.ROOM_TOKENS)):
                rep.error(file, f"{path}.colour", f'must be a hex (#rgb or #rrggbb) or one of {", ".join(self.ROOM_TOKENS)}')
            theme_id = key.get("themeId")
            if theme_id is not None:
                if isinstance(theme_id, str) and theme_id:
                    self.theme_ref(file, f"{path}.themeId", theme_id)
                else:
                    rep.error(file, f"{path}.themeId", "must be a theme id; see kb theme list")
            transition = key.get("transition", "cut")
            if transition not in ("cut", "flood"):
                rep.error(file, f"{path}.transition", "must be cut or flood (the app uses cut)")
            origin = key.get("origin")
            if origin is not None and not (isinstance(origin, list) and len(origin) == 2 and all(is_number(v) for v in origin)):
                rep.error(file, f"{path}.origin", "must be [x, y] frame fractions: [0, 0] top-left, [1, 1] bottom-right")
            duration = key.get("durationMs")
            if duration is not None:
                if not is_number(duration) or duration <= 0:
                    rep.error(file, f"{path}.durationMs", "must be a positive number of ms (the app uses 800)")
                elif transition != "flood":
                    rep.warn(file, f"{path}.durationMs", "only a flood uses durationMs; a cut is instant")
            if "ease" in key:
                self.enum(file, f"{path}.ease", key["ease"], "eases", "ease")
            lighting = key.get("lighting")
            if lighting is not None:
                self.room_lighting(file, f"{path}.lighting", lighting, doc)
            if colour is None and theme_id is None and lighting is None:
                rep.error(file, path, "needs a colour, a themeId or lighting (the app drops the key)")
            if is_number(at) and at >= 0 and transition == "flood":
                span = duration if is_number(duration) and duration > 0 else 800
                flood_ends.append((at, at + span, path))
        starts = sorted(k["at"] for k in block["keys"] if isinstance(k, dict) and is_number(k.get("at")))
        for at, end, path in flood_ends:
            later = [t for t in starts if t > at]
            if later and end > later[0]:
                rep.warn(file, path, f"the flood runs past the next key at {later[0]}ms and is cut short there")
        if any(isinstance(k, dict) and ("lighting" in k or "themeId" in k) for k in block["keys"]):
            stem = file[len("scenes/"):-len(".json")] if file.startswith("scenes/") else ""
            tsx = self.ctx.all_tsx().get(f"scenes/{stem}.tsx")
            if tsx is not None and "SceneStage" not in tsx:
                rep.warn(file, "room", "only lights a <SceneStage> mounts follow a room; stage the scene for the lighting to change")

    # ── taps, mosaic, window shadow colour ────────────────────────────────

    TAP_FIELDS = ("at", "position", "screenUv", "device", "colour", "size")
    MOSAIC_FIELDS = ("tiles", "columns", "gap", "reveal")
    MOSAIC_TILE_FIELDS = ("src", "startMs", "loop", "colour")
    MOSAIC_REVEAL_FIELDS = ("at", "staggerMs", "durationMs", "order", "ease")
    MOSAIC_ORDERS = ("rows", "columns", "centre")
    MOSAIC_IMAGE_EXTS = {"png", "jpg", "jpeg", "webp"}
    MOSAIC_VIDEO_EXTS = {"mp4", "mov", "m4v", "webm"}

    def scene_colour(self, value: Any) -> bool:
        return isinstance(value, str) and (bool(re.match(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", value)) or value in self.ROOM_TOKENS)

    @staticmethod
    def numbers(value: Any, n: int) -> bool:
        return isinstance(value, list) and len(value) == n and all(is_number(v) for v in value)

    def taps(self, file: str, doc: Dict[str, Any]) -> None:
        """The sidecar `taps` list; a tap the app can't place is dropped, a bad optional field falls back."""
        taps = doc.get("taps")
        if taps is None:
            return
        rep = self.report
        if not isinstance(taps, list):
            rep.error(file, "taps", "must be an array of { at, position } or { at, screenUv, device } (the app drops the block)")
            return
        device_ids = {d.get("id") for d in doc.get("devices") or [] if isinstance(d, dict)}
        for i, tap in enumerate(taps):
            path = f"taps[{i}]"
            if not isinstance(tap, dict):
                rep.error(file, path, "must be an object (the app drops it)")
                continue
            for field in tap:
                if field not in self.TAP_FIELDS:
                    rep.warn(file, f"{path}.{field}", f"not a tap field (the app ignores it).{did_you_mean(field, self.TAP_FIELDS)}")
            at = tap.get("at")
            if not is_number(at) or at < 0:
                rep.error(file, f"{path}.at", "must be scene-local ms >= 0 (the app drops the tap)")
            on_screen = self.numbers(tap.get("screenUv"), 2) and isinstance(tap.get("device"), str) and bool(tap.get("device"))
            if on_screen:
                if "position" in tap:
                    rep.warn(file, path, "has screenUv and position; the app uses screenUv")
                if tap["device"] not in device_ids:
                    rep.warn(file, f"{path}.device", f'no sidecar device "{tap["device"]}" in this scene, so the tap draws nothing.{did_you_mean(tap["device"], [d for d in device_ids if isinstance(d, str)])}')
                if not all(0 <= v <= 1 for v in tap["screenUv"]):
                    rep.warn(file, f"{path}.screenUv", "is off the screen; u and v run 0..1 from the top-left")
            elif not self.numbers(tap.get("position"), 3):
                rep.error(file, path, "needs a position [x, y, z] or screenUv [u, v] with a device (the app drops it)")
            if "colour" in tap and not self.scene_colour(tap["colour"]):
                rep.error(file, f"{path}.colour", f'must be a hex (#rgb or #rrggbb) or one of {", ".join(self.ROOM_TOKENS)} (the app uses the accent)')
            if "size" in tap and not (is_number(tap["size"]) and tap["size"] > 0):
                rep.error(file, f"{path}.size", "must be a positive multiplier (the app uses 1)")

    def mosaic(self, file: str, doc: Dict[str, Any]) -> None:
        """The sidecar `mosaic` block; a bad tile is dropped, a bad field falls back to its default."""
        block = doc.get("mosaic")
        if block is None:
            return
        rep = self.report
        if not isinstance(block, dict) or not isinstance(block.get("tiles"), list):
            rep.error(file, "mosaic", "must be { tiles: [...] } (the app drops the block)")
            return
        for field in block:
            if field not in self.MOSAIC_FIELDS:
                rep.warn(file, f"mosaic.{field}", f"not a mosaic field (the app ignores it).{did_you_mean(field, self.MOSAIC_FIELDS)}")
        usable = 0
        for i, tile in enumerate(block["tiles"]):
            path = f"mosaic.tiles[{i}]"
            if not isinstance(tile, dict):
                rep.error(file, path, "must be an object (the app drops it)")
                continue
            for field in tile:
                if field not in self.MOSAIC_TILE_FIELDS:
                    rep.warn(file, f"{path}.{field}", f"not a tile field (the app ignores it).{did_you_mean(field, self.MOSAIC_TILE_FIELDS)}")
            src = tile.get("src")
            ext = src.rsplit(".", 1)[-1].lower() if isinstance(src, str) and "." in src else ""
            if src is not None and not (isinstance(src, str) and src.startswith("assets/") and ext in self.MOSAIC_IMAGE_EXTS | self.MOSAIC_VIDEO_EXTS):
                rep.error(file, f"{path}.src", "must be an assets/ image (png, jpg, jpeg, webp) or video (mp4, mov, m4v, webm) (the app drops the tile)")
                continue
            usable += 1
            if "startMs" in tile and not (is_number(tile["startMs"]) and tile["startMs"] >= 0):
                rep.error(file, f"{path}.startMs", "must be scene-local ms >= 0 (the app uses 0)")
            if "loop" in tile and not isinstance(tile["loop"], bool):
                rep.error(file, f"{path}.loop", "must be true or false")
            if ("startMs" in tile or "loop" in tile) and ext not in self.MOSAIC_VIDEO_EXTS:
                rep.warn(file, path, "startMs and loop only apply to a video tile")
            if "colour" in tile and not self.scene_colour(tile["colour"]):
                rep.error(file, f"{path}.colour", f'must be a hex (#rgb or #rrggbb) or one of {", ".join(self.ROOM_TOKENS)} (the app uses muted)')
            if "colour" in tile and src is not None:
                rep.warn(file, f"{path}.colour", "only a tile without src is a colour tile")
        if usable == 0:
            rep.error(file, "mosaic.tiles", "has no usable tile (the app drops the block)")
        columns = block.get("columns")
        if columns is not None:
            if not is_int(columns) or columns < 1:
                rep.error(file, "mosaic.columns", "must be a whole number from 1; leave it out to reflow per aspect")
            elif columns > usable > 0:
                rep.warn(file, "mosaic.columns", f"is more than the {usable} tiles; the app uses {usable}")
        gap = block.get("gap")
        if gap is not None and not (is_number(gap) and gap >= 0):
            rep.error(file, "mosaic.gap", "must be a fraction of the frame's short side >= 0 (the app uses 0.02)")
        reveal = block.get("reveal")
        if reveal is not None:
            if not isinstance(reveal, dict):
                rep.error(file, "mosaic.reveal", "must be { at, staggerMs, durationMs, order, ease }")
                return
            for field in reveal:
                if field not in self.MOSAIC_REVEAL_FIELDS:
                    rep.warn(file, f"mosaic.reveal.{field}", f"not a reveal field (the app ignores it).{did_you_mean(field, self.MOSAIC_REVEAL_FIELDS)}")
            for field in ("at", "staggerMs", "durationMs"):
                if field in reveal and not (is_number(reveal[field]) and reveal[field] >= 0):
                    rep.error(file, f"mosaic.reveal.{field}", "must be ms >= 0 (the app uses its default)")
            if "order" in reveal and reveal["order"] not in self.MOSAIC_ORDERS:
                rep.error(file, "mosaic.reveal.order", f'must be one of {", ".join(self.MOSAIC_ORDERS)}')
            if "ease" in reveal:
                self.enum(file, "mosaic.reveal.ease", reveal["ease"], "eases", "ease")

    def window_shadow_colours(self, file: str, doc: Dict[str, Any]) -> None:
        for i, entry in enumerate(doc.get("media") or []):
            colour = dig(entry, "window", "shadow", "colour")
            if colour is not None and not (isinstance(colour, str) and re.match(r"^#[0-9a-fA-F]{6}$", colour)):
                self.report.error(file, f"media[{i}].window.shadow.colour", "must be #rrggbb (the app draws the black shadow)")

    def room_lighting(self, file: str, path: str, lighting: Any, doc: Dict[str, Any]) -> None:
        rep = self.report
        if not isinstance(lighting, dict):
            rep.error(file, path, "must be { sun, ambient, ambientColor, lights } (the app drops it)")
            return
        for field in lighting:
            if field not in ("sun", "ambient", "ambientColor", "lights"):
                rep.warn(file, f"{path}.{field}", "rooms change sun, ambient, ambientColor and lights only (the app ignores it)")
        if "sun" in lighting:
            self.room_light(file, f"{path}.sun", lighting["sun"])
        ambient = lighting.get("ambient")
        if ambient is not None and (not is_number(ambient) or ambient < 0):
            rep.error(file, f"{path}.ambient", "must be a number >= 0")
        ambient_colour = lighting.get("ambientColor")
        if ambient_colour is not None and not (isinstance(ambient_colour, str) and (HEX_RE.match(ambient_colour) and len(ambient_colour) in (4, 7) or ambient_colour in self.ROOM_TOKENS)):
            rep.error(file, f"{path}.ambientColor", "must be a hex or a theme colour token")
        lights = lighting.get("lights")
        if lights is None:
            return
        if not isinstance(lights, dict):
            rep.error(file, f"{path}.lights", "must be an object keyed by light id")
            return
        ids = self.room_light_ids(doc)
        for light_id, entry in lights.items():
            if ids is not None and light_id not in ids:
                rep.warn(file, f"{path}.lights.{light_id}", f"no light with this id in the theme, project or sidecar lighting.{did_you_mean(light_id, sorted(ids))}")
            self.room_light(file, f"{path}.lights.{light_id}", entry)

    def room_light_ids(self, doc: Dict[str, Any]) -> Optional[Set[str]]:
        """Light ids a room can reach in this scene (theme, project and sidecar layers), or None when the theme's lights can't be read here (an unknown theme, or a variant whose base merges in)."""
        try:
            manifest = self.project.manifest()
        except Exception:
            return None
        theme_id = doc.get("themeId") or manifest.get("themeId")
        theme: Any = {}
        if isinstance(theme_id, str) and theme_id and not theme_id.startswith("ws:"):
            theme = next((e for e in self.cat.entries("themes") or [] if isinstance(e, dict) and e.get("id") == theme_id), None)
            if theme is None:
                return None
        elif isinstance(theme_id, str) and theme_id:
            path = self.project.theme_file(theme_id)
            if path is None or not path.is_file():
                return None
            try:
                theme = json.loads(read_text(path))
            except (OSError, ValueError):
                return None
            if not isinstance(theme, dict) or "extends" in theme:
                return None
        ids: Set[str] = set()
        for layer in (theme, manifest, doc):
            declared = dig(layer, "lighting", "lights")
            if isinstance(declared, list):
                ids.update(l["id"] for l in declared if isinstance(l, dict) and isinstance(l.get("id"), str))
        return ids

    def room_light(self, file: str, path: str, entry: Any) -> None:
        rep = self.report
        if not isinstance(entry, dict):
            rep.error(file, path, "must be { intensity, kelvin | colorToken | color }")
            return
        for field in entry:
            if field not in self.ROOM_LIGHT_FIELDS:
                rep.warn(file, f"{path}.{field}", f"rooms set intensity and colour only (the app ignores it).{did_you_mean(field, self.ROOM_LIGHT_FIELDS)}")
        if "intensity" in entry and (not is_number(entry["intensity"]) or entry["intensity"] < 0):
            rep.error(file, f"{path}.intensity", "must be a number >= 0")
        if "kelvin" in entry and not is_number(entry["kelvin"]):
            rep.error(file, f"{path}.kelvin", "must be a number (1000..20000)")
        if "colorToken" in entry and entry["colorToken"] not in self.ROOM_TOKENS:
            rep.error(file, f"{path}.colorToken", f'must be one of {", ".join(self.ROOM_TOKENS)}')
        color = entry.get("color")
        if color is not None and not (isinstance(color, str) and HEX_RE.match(color) and len(color) in (4, 7)):
            rep.error(file, f"{path}.color", "must be a hex (#rgb or #rrggbb)")

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
                    rep.error(file, path, 'must be a theme token (text, muted, accent) or a hex like "#ff5a36"')
                elif value not in self.TEXT_FILL_TOKENS and not HEX_RE.match(value):
                    rep.warn(file, path, f'"{value}" is not a theme token (text, muted, accent) or a #rgb or #rrggbb hex')
            elif suffix == "Size":
                if not is_number(value) or value <= 0:
                    rep.error(file, path, "must be a positive number (a multiplier; 1 = as designed)")
            elif suffix == "Emphasis":
                m = EMPHASIS_RE.match(value.strip()) if isinstance(value, str) else None
                if not m or (m.group(2) is not None and not 1 <= int(m.group(2)) <= 1000):
                    rep.error(file, path, 'must be "<colour>" or "<colour>@<weight>", e.g. "accent@700" (the app drops it)')
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
        if "buildShiftEm" in spec and not is_number(spec["buildShiftEm"]):
            self.report.error(file, f"{path}.buildShiftEm", "must be a number of em (the app drops it)")
        self.stagger_exact(file, path, spec)

    def build_single_line(self, file: str, doc: Dict[str, Any]) -> None:
        """build re-centres one growing line; copy with a line break plays a plain word fade instead."""
        text = doc.get("text") if isinstance(doc.get("text"), dict) else {}
        overrides = doc.get("textAnimationOverrides") if isinstance(doc.get("textAnimationOverrides"), dict) else {}
        scene_build = dig(doc, "textAnimation", "in") == "build"
        for key, value in text.items():
            spec = overrides.get(key)
            builds = dig(spec, "in") == "build" if isinstance(spec, dict) else scene_build
            if builds and isinstance(value, str) and "\n" in value:
                self.report.warn(file, f"text.{key}", "build is single line; this copy breaks lines, so it plays a plain word fade")

    def stagger_exact(self, file: str, path: str, spec: Any) -> None:
        """A spec's staggerMs 0 without staggerExact plays the granularity's default delay wherever the spec picks one."""
        if not isinstance(spec, dict) or not (is_number(spec.get("staggerMs")) and spec["staggerMs"] == 0):
            return
        if spec.get("staggerExact") is True:
            return
        granular = spec.get("delivery") in ("by-paragraph", "by-paragraph-group")
        if not granular:
            motion = {e.get("id"): e.get("granularity") for e in (self.cat.entries("textMotion") or [])}
            granular = any(motion.get(spec.get(field)) for field in ("in", "out"))
        if granular:
            self.report.warn(file, f"{path}.staggerMs", 'staggerMs 0 plays the default delay here; add "staggerExact": true for no stagger')

    def text_look(self, file: str, path: str, spec: Any) -> None:
        if spec is None:
            return
        if not isinstance(spec, dict) or "preset" not in spec:
            self.report.error(file, path, 'must be an object with a "preset"')
            return
        self.enum(file, f"{path}.preset", spec["preset"], "textLooks", "text look", extra=["none"])
        if "offsetDir" in spec and not is_number(spec["offsetDir"]):
            self.report.error(file, f"{path}.offsetDir", "must be degrees clockwise from up (the app drops it)")
        opacity = spec.get("offsetOpacity")
        if opacity is not None and (not is_number(opacity) or not 0 <= opacity <= 1):
            self.report.warn(file, f"{path}.offsetOpacity", "must be 0..1 (the app clamps it)")

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
            self.device_in_build(file, f"{path}.model", d["model"])
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

    # ── devices this build renders, and poses a deviceLayout owns ─────────

    DEVICE_TAG_RE = re.compile(r"<Device(?![\w$.])")
    DEVICE_MODEL_RE = re.compile(r"(?<![\w$.])model\s*=\s*\{?\s*([\"'])([\w-]+)\1")
    DEVICE_POSE_RE = re.compile(r"(?<![\w$.])(position|rotationDeg|ground)\s*[:,}]")

    @staticmethod
    def heartbeat_devices(heartbeat: Optional[Dict[str, Any]]) -> Optional[Set[str]]:
        """The device ids the running build renders with their own model (lastLoad.availableDevices), or None when unknown."""
        ids = dig(heartbeat, "lastLoad", "availableDevices")
        if isinstance(ids, list) and ids and all(isinstance(i, str) for i in ids):
            return set(ids)
        return None

    def device_in_build(self, file: str, path: str, model: Any) -> None:
        available = self.ctx.available_devices
        if available is None or not isinstance(model, str) or model in available:
            return
        if model not in (self.ctx.ids("devices") or []):
            return
        self.report.warn(file, path, f'"{model}" is not in this build of the app, so it renders as the android fallback: a different body, with the screen somewhere else. Pin overlays with DeviceScreenAnchor rather than positions measured off a capture, or use one of {", ".join(sorted(available))}')

    def device_tags(self, rel: str, text: str, code: str) -> None:
        """Each <Device ...> opening tag: a literal model this build lacks, and pose props a sidecar deviceLayout owns."""
        layout: Any = None
        try:
            layout = json.loads(read_text(self.project.sidecar_path(stem_of(rel)))).get("deviceLayout")
        except (OSError, ValueError, AttributeError, UnicodeDecodeError):
            pass
        seen: Set[Tuple[int, str]] = set()
        for m in self.DEVICE_TAG_RE.finditer(code):
            depth, end = 0, m.end()
            while end < len(code) and not (code[end] == ">" and depth == 0):
                depth += {"{": 1, "}": -1}.get(code[end], 0)
                end += 1
            for model in self.DEVICE_MODEL_RE.finditer(text, m.end(), end):
                self.device_in_build(rel, f"line {tsxmod.line_of(text, model.start())}", model.group(2))
            if not isinstance(layout, dict):
                continue
            for pose in self.DEVICE_POSE_RE.finditer(code, m.end(), end):
                key = (tsxmod.line_of(code, pose.start()), pose.group(1))
                if key in seen:
                    continue
                seen.add(key)
                self.report.warn(rel, f"line {key[0]}", f'passes {key[1]} to Device, but scenes/{stem_of(rel)}.json has a deviceLayout, which owns device poses, so this fights the layout. Remove {key[1]} here, or delete deviceLayout')

    # ── device media keys and camera kicks ────────────────────────────────

    def device_media(self, file: str, doc: Dict[str, Any]) -> None:
        """Every device screen spec (both displays, both comparison sides) under the app parser's source-timing rules."""
        specs: List[Tuple[str, Dict[str, Any]]] = []
        devices = doc.get("devices")
        for i, d in enumerate(devices if isinstance(devices, list) else []):
            if isinstance(d, dict) and isinstance(d.get("id"), str) and isinstance(d.get("model"), str):
                specs += [(f"devices[{i}].{field}", d[field]) for field in ("media", "coverMedia") if isinstance(d.get(field), dict)]
        side = dig(doc, "compare", "b")
        for field in ("media", "coverMedia"):
            overrides = side.get(field) if isinstance(side, dict) else None
            if isinstance(overrides, dict):
                specs += [(f'compare.b.{field}["{ident}"]', spec) for ident, spec in overrides.items() if isinstance(spec, dict)]
        known = catmod.device_media_keys(self.cat)
        for path, spec in specs:
            self.media_spec(file, path, spec, known)

    def media_spec(self, file: str, path: str, spec: Dict[str, Any], known: List[str]) -> None:
        from .video import repoint

        rep = self.report
        for key in spec:
            if key not in known:
                rep.warn(file, f"{path}.{key}", f"unknown media key (the app ignores it).{did_you_mean(key, known)} See kb catalog deviceMedia.keys")
        for key, why in repoint.media_key_problems(spec):
            rep.error(file, f"{path}.{key}", f"{why}, so the app drops it")
        timing = repoint.playback_timing(spec)
        speed = timing.get("speed")
        if speed is not None and not EDITOR_SPEEDS[0] <= speed <= EDITOR_SPEEDS[1]:
            rep.warn(file, f"{path}.speed", f"{speed:g}x is outside the editor's {EDITOR_SPEEDS[0]:g}x to {EDITOR_SPEEDS[1]:g}x, so the inspector can't show it")
        edit = edit_of_output(self.project, spec["src"]) if timing and isinstance(spec.get("src"), str) else None
        if edit and any(k in timing for k in ("inMs", "outMs", "speed")):
            rep.warn(file, path, f"retimes the render of edits/{edit}.json with {', '.join(k for k in ('inMs', 'outMs', 'speed') if k in timing)}, so two places now own its timing; trim and retime in the edit (./kb video trim {edit} ...), and kb video fit and align refuse this slot until then")
        start = spec.get("startMs")
        if "posterMs" in timing and not (is_number(start) and start > 0) and spec.get("startOn") is None:
            rep.warn(file, f"{path}.posterMs", "is inert: a poster shows only during a delay (startMs above 0) or before a fold opens (startOn)")
        duration = self.probed_duration_ms(spec.get("src")) if "inMs" in timing or "outMs" in timing else None
        if duration:
            if "inMs" in timing and timing["inMs"] >= duration:
                rep.error(file, f"{path}.inMs", f'{timing["inMs"]} ms is at or past the end of {spec.get("src")} ({duration} ms), so the screen shows only its last frame')
            if "outMs" in timing and timing["outMs"] > duration:
                rep.warn(file, f"{path}.outMs", f'{timing["outMs"]} ms is past the end of {spec.get("src")} ({duration} ms), so playback stops at the end')

    def probed_duration_ms(self, rel: Any) -> Optional[int]:
        """The video's length from kb video's probe cache (no app call: checks run in hooks), None when unprobed or changed since."""
        if not isinstance(rel, str) or not tsxmod.is_project_asset_ref(rel):
            return None
        try:
            st = (self.project.root / rel).stat()
        except OSError:
            return None
        cache = getattr(self, "_probe_cache", None)
        if cache is None:
            from .util import bridge_dir

            try:
                cache = json.loads((bridge_dir() / "video" / self.project.slug / "probe-cache.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                cache = {}
            self._probe_cache = cache if isinstance(cache, dict) else {}
            cache = self._probe_cache
        suffix = f"|{rel}|{st.st_size}|{st.st_mtime_ns}"
        for key, value in cache.items():
            if key.endswith(suffix) and isinstance(value, dict) and is_int(value.get("durationMs")) and value["durationMs"] > 0:
                return value["durationMs"]
        return None

    def camera_kicks(self, file: str, doc: Dict[str, Any]) -> None:
        """cameraKicks under the app parser's rules, positions that won't resolve, and orbit kicks that pull out past a DepthStage."""
        kicks = doc.get("cameraKicks")
        if kicks is None:
            return
        rep = self.report
        if not isinstance(kicks, list):
            rep.error(file, "cameraKicks", "must be an array of kicks like {\"at\": \"bar:13\", \"zoom\": 1.04, \"releaseMs\": 300} (the app drops it)")
            return
        from . import music

        eases = self.ctx.ids("eases")
        orbit = not (doc.get("cameraMode") == "rig" and isinstance(doc.get("cameraRig"), dict))
        for i, kick in enumerate(kicks):
            path = f"cameraKicks[{i}]"
            if not isinstance(kick, dict):
                rep.error(file, path, "must be an object {at, releaseMs, zoom | offset | rollDeg} (the app drops it)")
                continue
            for key in kick:
                if key not in KICK_FIELDS:
                    rep.warn(file, f"{path}.{key}", f"unknown kick field (the app ignores it).{did_you_mean(key, KICK_FIELDS)} Fields: {', '.join(KICK_FIELDS)}")
            at = kick.get("at")
            at_ok = (_finite(at) and at >= 0) or music.is_position(at)
            if not at_ok:
                rep.error(file, f"{path}.at", 'must be scene ms >= 0 or a position like "bar:13" or "cue:drop" (the app drops the kick)')
            if not (_finite(kick.get("releaseMs")) and kick["releaseMs"] >= 0):
                rep.error(file, f"{path}.releaseMs", "required: ms >= 0 the kick takes to ease back (the app drops the kick)")
            if "id" in kick and not isinstance(kick["id"], str):
                rep.error(file, f"{path}.id", "must be a string (the app drops it)")
            zoom = kick.get("zoom")
            zoom_ok = _finite(zoom) and KICK_ZOOM[0] <= zoom <= KICK_ZOOM[1]
            if "zoom" in kick and not zoom_ok:
                rep.error(file, f"{path}.zoom", f"must be a magnification {KICK_ZOOM[0]:g} to {KICK_ZOOM[1]:g} (1.04 pushes in 4%; the app drops it)")
            offset_ok = isinstance(kick.get("offset"), list) and len(kick["offset"]) == 3 and all(_finite(v) for v in kick["offset"])
            if "offset" in kick and not offset_ok:
                rep.error(file, f"{path}.offset", "must be three numbers [x, y, z] in camera space (the app drops it)")
            roll_ok = _finite(kick.get("rollDeg"))
            if "rollDeg" in kick and not roll_ok:
                rep.error(file, f"{path}.rollDeg", "must be a number of degrees (the app drops it)")
            for field in ("attackMs", "holdMs"):
                if field in kick and not (_finite(kick[field]) and kick[field] >= 0):
                    rep.error(file, f"{path}.{field}", "must be ms >= 0 (the app drops it)")
            if "ease" in kick and eases is not None:
                self.enum(file, f"{path}.ease", kick["ease"], "eases", "ease")
            if not (zoom_ok or offset_ok or roll_ok):
                rep.error(file, path, "has no valid zoom, offset or rollDeg, so the app drops the kick")
                continue
            if at_ok and isinstance(at, str):
                self.kick_position(file, f"{path}.at", at)
            pulls = (zoom_ok and zoom < 1) or (offset_ok and any(v != 0 for v in kick["offset"])) or (roll_ok and kick["rollDeg"] != 0)
            if orbit and pulls and self.stages_depth(file):
                rep.warn(file, path, "pulls the orbit camera out (zoom below 1, an offset or a roll) in a scene that stages a DepthStage; orbit kicks get no overscan, so band edges can show. Push in with zoom above 1, or kick a rig camera")

    def kick_position(self, file: str, path: str, at: str, what: str = "kick") -> None:
        from . import music

        stem = stem_of(file[:-5]) if file.endswith(".json") else None
        try:
            entries = self.project.scene_entries()
            index = next((i for i, e in enumerate(entries) if isinstance(e, dict) and e.get("file") == f"scenes/{stem}.tsx"), None)
            if index is None:
                return
            from .video import repoint

            start = repoint.scene_starts(self.project)[index]
            from .beats import model as beatmodel

            result = beatmodel.resolve_local(at, beatmodel.project_music(self.project.manifest()), start)
        except Exception:
            return
        if not result["ok"]:
            hint = " (./kb song analyse, then ./kb beats set-grid --from-analysis)" if result["code"] == "no-grid" else ""
            self.report.warn(file, path, f'"{at}" doesn\'t resolve: {result["message"]}, so the app drops this {what}{hint}')

    def stages_depth(self, file: str) -> bool:
        rel = f"{file[:-5]}.tsx" if file.endswith(".json") else file
        return bool(DEPTH_STAGE_RE.search(tsxmod.blank_comments_and_strings(self.ctx.all_tsx().get(rel, ""))))

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
            if "at" in k and path in ("chart.track", "layeredScreenshot.animation"):
                self.report.warn(file, f"{path}.keys[{i}].at", "this track takes plain tMs, so the app ignores at (./kb beats --scene S lists each bar's ms)")
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
        self.device_tags(rel, text, code)
        eases = self.cat.ids("eases")
        if eases is not None:
            declared = set(DECLARED_RE.findall(code))
            for line, name in ease_literals(text, code, toolkit_names - declared):
                if name not in eases:
                    rep.warn(rel, f"line {line}", f'unknown ease "{name}" falls back to the default ease, inOutQuad.{did_you_mean(name, eases)} See kb catalog eases')

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
        """The project's workspace theme, checked like kb theme set checks a write."""
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
        self.theme_doc(theme_id, theme)

    def theme_doc(self, theme_id: str, doc: Any, file: Optional[str] = None) -> None:
        """A workspace theme document: font strings, the shadow technique, gradient angles and extends."""
        file = file or (f"../themes/{theme_id[3:]}/theme.json" if theme_id.startswith("ws:") else theme_id)
        rep = self.report
        if not isinstance(doc, dict):
            rep.error(file, "", "a theme must be a JSON object; the app falls back to the default theme")
            return
        typography = doc.get("typography")
        if isinstance(typography, dict):
            for slot in ("headline", "body"):
                ref = typography.get(slot)
                if isinstance(ref, str):
                    self.font(file, f"typography.{slot}", ref)
                elif isinstance(ref, dict) and isinstance(ref.get("family"), str):
                    self.font(file, f"typography.{slot}", f"{ref['family']}@{ref.get('weight', 400)}")
                elif ref is not None:
                    rep.error(file, f"typography.{slot}", 'must be "Family", "Family@weight" or {"family": ..., "weight": ...}')
        gradients = doc.get("gradients")
        if isinstance(gradients, dict):
            for name, spec in gradients.items():
                self.theme_gradient(file, f"gradients.{name}", spec)
        for key in ("background", "backdrop"):
            block = doc.get(key)
            if isinstance(block, dict) and block.get("type") == "gradient" and "spec" in block:
                self.theme_gradient(file, f"{key}.spec", block["spec"], block.get("gradient"))
        shadow = dig(doc, "lighting", "shadow")
        if shadow is not None:
            if not isinstance(shadow, dict) or shadow.get("technique") not in ("map", "none"):
                rep.error(file, "lighting.shadow.technique", 'needs "map" or "none"; without it the shadow block drops')
            else:
                for key in ("softness", "opacity", "mapSize", "bias"):
                    if key in shadow and not is_number(shadow[key]):
                        rep.warn(file, f"lighting.shadow.{key}", "must be a number; the default is used")
        self.stagger_exact(file, "textAnimation", doc.get("textAnimation"))
        if "extends" in doc:
            self.theme_extends(file, theme_id, doc)

    def theme_gradient(self, file: str, path: str, spec: Any, fallback: Any = None) -> None:
        why = gradient_problem(spec)
        if why is None:
            return
        if isinstance(fallback, str) and fallback:
            self.report.warn(file, path, f'{why}, so the "{fallback}" gradient shows instead')
        else:
            self.report.error(file, path, f"{why}; the app drops it")

    def theme_extends(self, file: str, theme_id: str, doc: Dict[str, Any]) -> None:
        rep = self.report
        value = doc.get("extends")
        if not isinstance(value, str) or not value.strip():
            rep.error(file, "extends", "must be a theme id (ws:<slug> or a bundled id); see kb theme list")
            return
        if not is_number(doc.get("version")) or doc["version"] < thememod.EXTENDS_VERSION:
            rep.error(file, "extends", f'needs "version": {thememod.EXTENDS_VERSION}; below that the app ignores it')
            return
        bundled = self.ctx.ids("themes")

        def lookup(tid: str) -> Any:
            if tid == theme_id:
                return doc
            if tid.startswith("ws:"):
                path = self.project.theme_file(tid)
                if path is None or not path.is_file():
                    return None
                try:
                    return json.loads(read_text(path))
                except (OSError, ValueError):
                    return None
            return {"version": 2} if bundled is None or tid in bundled else None

        merged, problem = thememod.resolve_theme_document(doc, theme_id, lookup)
        walk = [theme_id]
        nxt = thememod.extends_of(doc)
        while nxt is not None and nxt not in walk and len(walk) <= thememod.MAX_CHAIN:
            walk.append(nxt)
            nxt = thememod.extends_of(lookup(nxt))
        if problem == "cycle":
            loop = " > ".join(walk + [nxt or theme_id])
            rep.error(file, "extends", f"loops back on itself ({loop}); the app falls back to the default theme")
        elif problem == "too-long":
            rep.error(file, "extends", f"chains through more than {thememod.MAX_CHAIN} themes; the app falls back to the default theme")
        elif problem == "missing":
            gone = walk[-1]
            hint = "" if gone.startswith("ws:") else did_you_mean(gone, bundled or [])
            rep.error(file, "extends", f'base theme "{gone}" can\'t be found; the app falls back to the default theme.{hint} See kb theme list')
        elif isinstance(merged, dict) and all(tid.startswith("ws:") for tid in walk):
            missing = theme_required_gaps(merged)
            if missing:
                rep.error(file, "", f"with its base merged it still lacks {', '.join(missing)}; the app falls back to the default theme")

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


def ease_literals(text: str, code: str, imported: Set[str]) -> List[Tuple[int, str]]:
    """String-literal ease names passed to the toolkit's ease, easeFn and ramp (`code` is `text` with comments and strings blanked)."""
    found: List[Tuple[int, str]] = []
    for m in EASE_CALL_RE.finditer(code):
        if m.group(1) not in imported:
            continue
        want, arg, depth, j = EASE_CALLS[m.group(1)], 0, 0, m.end()
        while arg < want and j < len(code):
            c = code[j]
            if c in "([{":
                depth += 1
            elif c in ")]}":
                if depth == 0:
                    break
                depth -= 1
            elif c == "," and depth == 0:
                arg += 1
            j += 1
        if arg < want:
            continue
        while j < len(code) and code[j] in " \t\r\n":
            j += 1
        if j < len(code) and code[j] in "\"'":
            end = code.find(code[j], j + 1)
            if end > j:
                found.append((tsxmod.line_of(text, j), text[j + 1:end]))
    return found


def gradient_problem(spec: Any) -> Optional[str]:
    """Why the app would drop a gradient spec, or None (src/theme/schema.ts parseGradient)."""
    if not isinstance(spec, dict):
        return "isn't a gradient object"
    if spec.get("type") not in ("linear", "radial"):
        return 'needs a "type" of linear or radial'
    if not is_number(spec.get("angleDeg")) and not (spec.get("type") == "radial" and "angleDeg" not in spec):
        return 'needs a numeric "angleDeg" (only a radial gradient may leave it out)'
    stops = spec.get("stops")
    if not isinstance(stops, list) or not all(isinstance(s, list) and len(s) >= 2 and isinstance(s[0], str) and s[0] and is_number(s[1]) for s in stops):
        return 'needs "stops" as ["colour", position] pairs'
    if len(stops) < 2:
        return "needs at least two stops"
    return None


def theme_required_gaps(doc: Dict[str, Any]) -> List[str]:
    """The required theme blocks a document lacks (src/theme/schema.ts parseThemeDoc)."""
    gaps: List[str] = [] if isinstance(doc.get("id"), str) and doc.get("id") else ["its own id"]
    colors = doc.get("colors")
    if not isinstance(colors, dict) or not all(isinstance(colors.get(k), str) and colors.get(k) for k in ("background", "text", "accent", "muted")):
        gaps.append("colors (background, text, accent, muted)")
    typography = doc.get("typography")
    if not isinstance(typography, dict) or not all(typography.get(k) for k in ("headline", "body")) or not is_number(typography.get("scale")):
        gaps.append("typography (headline, body, scale)")
    durations = dig(doc, "motion", "durations")
    easings = dig(doc, "motion", "easings")
    if not isinstance(durations, dict) or not all(is_number(durations.get(k)) for k in ("fast", "base", "slow")) or not isinstance(easings, dict) or not all(isinstance(easings.get(k), str) and easings.get(k) for k in ("standard", "emphasized")):
        gaps.append("motion (three durations, two easings)")
    return gaps


def edit_of_output(project: Project, rel: str) -> Optional[str]:
    """The edit whose render rel is (assets/<name>-edited.mp4 with edits/<name>.json present), else None."""
    if not rel.startswith("assets/") or not rel.endswith("-edited.mp4"):
        return None
    from .video import editdoc

    name = editdoc.name_of_output(rel)
    return name if name and editdoc.edit_path(project, name).is_file() else None


def conforming_original(project: Project, rel: str) -> Optional[str]:
    """The kept original a conform is still turning into rel, else None: the app's import and kb assets add land
    assets/<stem>.mp4 from assets/.originals/<stem>.<ext> and write assets/<stem>.timing.json last."""
    from .assets import ORIGINALS, TIMING_SUFFIX
    from .conform import CONFORMABLE_EXTS

    folder, _, name = rel.rpartition("/")
    if folder != "assets" or not name.endswith(".mp4") or (project.assets_dir / f"{name[:-4]}{TIMING_SUFFIX}").exists():
        return None
    try:
        names = sorted(os.listdir(project.root / ORIGINALS))
    except OSError:
        return None
    for kept in names:
        stem, _, ext = kept.rpartition(".")
        if stem == name[:-4] and ext.lower() in CONFORMABLE_EXTS and (project.root / ORIGINALS / kept).is_file():
            return f"{ORIGINALS}/{kept}"
    return None


def text_specs(doc: Any) -> List[Tuple[str, Dict[str, Any]]]:
    """A sidecar's or theme's text motion specs by dotted path."""
    if not isinstance(doc, dict):
        return []
    found: List[Tuple[str, Dict[str, Any]]] = []
    if isinstance(doc.get("textAnimation"), dict):
        found.append(("textAnimation", doc["textAnimation"]))
    overrides = doc.get("textAnimationOverrides")
    if isinstance(overrides, dict):
        found.extend((f"textAnimationOverrides.{k}", v) for k, v in overrides.items() if isinstance(v, dict))
    return found


def stamp_stagger_exact(old: Any, new: Any) -> Any:
    """A kb write that turns a text spec's staggerMs to 0 also writes staggerExact: true (the inspector's rule), so the 0 means no stagger."""
    before = dict(text_specs(old))
    out = json.loads(json.dumps(new))
    for path, spec in text_specs(out):
        zero = is_number(spec.get("staggerMs")) and spec["staggerMs"] == 0
        prior = before.get(path)
        was_zero = isinstance(prior, dict) and is_number(prior.get("staggerMs")) and prior["staggerMs"] == 0
        if zero and not was_zero and "staggerExact" not in spec:
            spec["staggerExact"] = True
    return out


def _finite(v: Any) -> bool:
    return is_number(v) and math.isfinite(v)


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
        from . import assets_check

        assets_check.run(checker)
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
