"""Scene presets: bundled ones in the app bundle, user ones in the workspace; inserted through the app or copied offline."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import bridge
from . import catalog as catmod
from . import lock as lockmod
from . import scenes as scenemod
from .project import Project
from .util import KbError, load_json


class Preset:
    def __init__(self, slug: str, scope: str, folder: Optional[Path], meta: Dict[str, Any], poster: Optional[Path]) -> None:
        self.slug = slug
        self.scope = scope
        self.folder = folder
        self.meta = meta
        self.poster = poster

    @property
    def ref(self) -> str:
        return self.slug if self.scope == "bundled" else f"ws-preset:{self.slug}"

    def as_dict(self) -> Dict[str, Any]:
        return {
            "id": self.ref,
            "name": self.meta.get("name") or self.meta.get("label") or self.slug,
            "tagline": self.meta.get("tagline") or self.meta.get("summary") or "",
            "category": self.meta.get("category"),
            "tags": self.meta.get("tags") or [],
            "status": self.meta.get("status"),
            "poster": str(self.poster) if self.poster else None,
            "folder": str(self.folder) if self.folder else None,
        }


CATEGORY_ORDER = ["starters", "openers", "features", "stats-charts", "devices", "closers"]


def category_rank(category: Any) -> int:
    return CATEGORY_ORDER.index(category) if category in CATEGORY_ORDER else len(CATEGORY_ORDER)


def _read_meta(folder: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(folder / "preset.json", "r", encoding="utf-8") as f:
            meta = json.load(f)
    except (OSError, ValueError):
        return None
    return meta if isinstance(meta, dict) else None


def discover(project: Optional[Project] = None) -> List[Preset]:
    hb = bridge.read_heartbeat()
    previews = bridge.preset_previews_dir(hb)
    found: Dict[str, Preset] = {}
    bundled_root = bridge.presets_dir(hb)
    if bundled_root.is_dir():
        for folder in sorted(bundled_root.iterdir()):
            meta = _read_meta(folder) if folder.is_dir() else None
            if meta is None:
                continue
            poster = folder / "poster.png"
            jpg = previews / f"{folder.name}.jpg"
            found[folder.name] = Preset(folder.name, "bundled", folder, meta, poster if poster.is_file() else (jpg if jpg.is_file() else None))
    if not found:
        for entry in catmod.load_catalog().entries("presets") or []:
            slug = str(entry["id"])
            jpg = previews / f"{slug}.jpg"
            found[slug] = Preset(slug, "bundled", None, entry, jpg if jpg.is_file() else None)
    out = sorted(found.values(), key=lambda p: (category_rank(p.meta.get("category")), p.meta.get("order") if isinstance(p.meta.get("order"), int) else 999, str(p.meta.get("name") or p.slug)))
    if project is not None:
        user_root = project.workspace_root / "presets"
        if user_root.is_dir():
            for folder in sorted(user_root.iterdir()):
                meta = _read_meta(folder) if folder.is_dir() else None
                if meta is None:
                    continue
                poster = folder / "poster.png"
                out.append(Preset(folder.name, "user", folder, meta, poster if poster.is_file() else None))
    return out


def find(ref: str, project: Optional[Project]) -> Preset:
    key = ref.strip()
    scope = None
    for prefix, s in (("ws-preset:", "user"), ("preset:", "bundled")):
        if key.startswith(prefix):
            key, scope = key[len(prefix):], s
    presets = discover(project)
    for p in presets:
        if p.slug == key and (scope is None or p.scope == scope):
            return p
    names = [p.ref for p in presets]
    import difflib

    close = difflib.get_close_matches(key, names, n=3, cutoff=0.5)
    hint = f" Did you mean {', '.join(close)}?" if close else ""
    where = bridge.presets_dir()
    if not presets:
        raise KbError(f"no presets found (looked in {where}); is Kookaburra Cut installed in /Applications?", 2)
    raise KbError(f'no preset "{ref}".{hint} List them with kb presets')


def describe(p: Preset) -> List[str]:
    d = p.as_dict()
    lines = [f"{d['id']}: {d['name']}" + (f" ({d['status']})" if d.get("status") and d["status"] != "stable" else "")]
    if d["tagline"]:
        lines.append(f"  {d['tagline']}")
    meta_bits = []
    if d.get("category"):
        meta_bits.append(f"category {d['category']}")
    if d["tags"]:
        meta_bits.append("tags " + ", ".join(str(t) for t in d["tags"]))
    if meta_bits:
        lines.append("  " + "; ".join(meta_bits))
    if p.folder is not None:
        manifest = _preset_manifest(p)
        entry = manifest["scenes"][0] if manifest else None
        if isinstance(entry, dict):
            stem = str(entry.get("file", "")).replace("scenes/", "").replace(".tsx", "")
            doc_path = p.folder / "scenes" / f"{stem}.json"
            keys: List[str] = []
            if doc_path.is_file():
                try:
                    doc = json.loads(doc_path.read_text(encoding="utf-8"))
                    keys = [k for k in doc if k not in ("version", "name")] if isinstance(doc, dict) else []
                except (OSError, ValueError):
                    keys = []
            lines.append(f"  scene {entry.get('file')} {entry.get('durationMs', '?')}ms" + (f"; sidecar sets {', '.join(keys)}" if keys else ""))
    lines.append(f"  poster: {d['poster'] or 'none'}")
    return lines


def _preset_manifest(p: Preset) -> Optional[Dict[str, Any]]:
    if p.folder is None:
        return None
    try:
        manifest = load_json(p.folder / "project.json", f"preset {p.slug}/project.json")
    except KbError:
        return None
    scenes = manifest.get("scenes") if isinstance(manifest, dict) else None
    if not isinstance(scenes, list) or len(scenes) != 1:
        return None
    return manifest


def insert_offline(
    project: Project,
    p: Preset,
    stem: Optional[str],
    name: Optional[str],
    position: Any,
    opts: Optional[lockmod.WriteOpts] = None,
    duration: Optional[int] = None,
) -> scenemod.Result:
    """copy_scene_to_project from a preset folder, without the app (position: a scenes.Place or a 0-based index)."""
    if p.folder is None:
        raise KbError(f"preset {p.ref} has no folder on disk (looked in {bridge.presets_dir()}); start the app or install it in /Applications", 2)
    manifest = _preset_manifest(p)
    if manifest is None:
        raise KbError(f"preset {p.ref} is malformed: a scene preset must contain exactly one scene")
    pool = bridge.samples_dir() if p.scope == "bundled" else None
    return scenemod.copy_into(project, p.folder, manifest["scenes"][0], stem, name, position, True, pool, opts=opts, duration=duration)


def insert_via_app(project: Project, p: Preset, name: Optional[str], position: Optional[int], timeout: float) -> scenemod.Result:
    body: Dict[str, Any] = {"project": project.project_id, "preset": p.ref}
    if position is not None:
        body["position"] = position
    if name:
        body["name"] = name
    resp = bridge.require_ok(bridge.request("insertPreset", body, timeout, "Inserting a preset"), "insertPreset")
    project.manifest(reload=True)
    index = resp.get("index") if isinstance(resp.get("index"), int) else -1
    return scenemod.Result(str(resp.get("file") or "?"), index, str(resp.get("id") or "?"), str(resp.get("name") or p.meta.get("name") or p.slug), ["inserted by the app"])
