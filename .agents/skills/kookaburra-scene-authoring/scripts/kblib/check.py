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
                self.music_manifest(audio, warn, include_warnings)
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
        """Positions on camera, rig and lighting keys and camera kicks that can't resolve, and `at` keys whose tMs cache is stale."""
        from .beats import model as beatmodel

        kicks = doc.get("cameraKicks") if isinstance(doc.get("cameraKicks"), list) else []
        if not beatmodel.has_at(doc) and not any(isinstance(k, dict) and isinstance(k.get("at"), str) for k in kicks):
            return
        scope = self._music_scope(file)
        if scope is None:
            return
        m, start = scope
        stem = stem_of(file[:-5] + ".tsx") if file.endswith(".json") else file
        for path, keys in beatmodel.timed_tracks(doc):
            dotted = ".".join(path)
            for i, key in enumerate(keys):
                if not isinstance(key, dict) or "at" not in key:
                    continue
                where = f"{dotted}.keys[{i}].at"
                at = key["at"]
                if not isinstance(at, str):
                    self.report.warn(file, where, 'must be a position string like "bar:13" (the app ignores it)')
                    continue
                r = beatmodel.resolve_local(at, m, start)
                if not r["ok"]:
                    self.music_position_issue(file, where, at, r, "the key stays at its stored tMs")
                    continue
                t = key.get("tMs")
                if is_number(t) and t != r["projectMs"]:
                    self.report.warn(file, f"{dotted}.keys[{i}].tMs", f'{t} isn\'t where "{at}" lands ({r["projectMs"]} ms), so the app uses {r["projectMs"]}: fine after a grid or timing change (the app rewrites it on load); to keep {t}, ./kb doc {stem} unset {dotted}.keys.{i}.at')
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

    def kick_position(self, file: str, path: str, at: str) -> None:
        from . import music

        stem = stem_of(file[:-5]) if file.endswith(".json") else None
        try:
            entries = self.project.scene_entries()
            index = next((i for i, e in enumerate(entries) if isinstance(e, dict) and e.get("file") == f"scenes/{stem}.tsx"), None)
            if index is None:
                return
            from .video import repoint

            start = repoint.scene_starts(self.project)[index]
            result = music.resolve_scene_local(at, project_music(self.project.manifest()), start)
        except Exception:
            return
        if not result["ok"]:
            hint = " (./kb song analyse, then ./kb beats set-grid --from-analysis)" if result["code"] == "no-grid" else ""
            self.report.warn(file, path, f'"{at}" doesn\'t resolve: {result["message"]}, so the app drops this kick{hint}')

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


def _finite(v: Any) -> bool:
    return is_number(v) and math.isfinite(v)


def project_music(manifest: Any) -> Dict[str, Any]:
    """What kicks' positions resolve against (music.resolve's mapping), from project.json audio: a grid only when
    sanitiseAudioMusic would keep it; cue and section values as authored (a bad one fails to resolve, which warns)."""
    audio = manifest.get("audio") if isinstance(manifest, dict) else None
    audio = audio if isinstance(audio, dict) else {}
    grid = audio.get("grid")
    music: Dict[str, Any] = {"grid": None, "startOffsetMs": audio["startOffsetMs"] if _finite(audio.get("startOffsetMs")) else 0, "cues": {}, "sections": {}}
    if isinstance(grid, dict):
        per_bar = grid.get("beatsPerBar", 4)
        if _finite(grid.get("bpm")) and 30 <= grid["bpm"] <= 300 and _finite(grid.get("offsetMs")) and is_int(per_bar) and 1 <= per_bar <= 16:
            music["grid"] = {"bpm": grid["bpm"], "offsetMs": grid["offsetMs"], "beatsPerBar": per_bar}
    cues = audio.get("cues")
    if isinstance(cues, dict):
        music["cues"] = {k: v for k, v in cues.items() if isinstance(v, (str, int, float)) and not isinstance(v, bool)}
    sections = audio.get("sections")
    for s in sections if isinstance(sections, list) else []:
        if isinstance(s, dict) and isinstance(s.get("id"), str) and "from" in s:
            music["sections"].setdefault(s["id"], {"from": s["from"], "to": s.get("to")})
    return music


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
