"""Manifest-safe scene operations, mirroring the app's Rust commands (scene_doc.rs)."""

from __future__ import annotations

import copy
import filecmp
import os
import shutil
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from . import lock as lockmod
from . import tsx as tsxmod
from .project import DEFAULT_SCENE_DURATION_MS, MANIFEST, Project, humanise, numeric_prefix, slugify, stem_of
from .util import EXIT_PROBLEMS, KbError, is_int, load_json, read_text

TEXT_STYLE_SUFFIXES = ("Color", "Font", "Size", "OffsetX", "OffsetY", "LineHeight", "RotationDeg")
FRAME_SHAPES = {"rect", "rounded-rect", "squircle", "circle", "capsule", "none"}
SCENE_DOC_VERSION = 1

BLANK_TSX = """import {{ defineScene, SceneStage, TitleBlock, useFormat, useSceneText }} from "@kookaburra/toolkit";

export default defineScene({{
  id: "{id}",
  durationMs: {duration},
  Scene() {{
    const format = useFormat();
    const textWidth = format.frame.width - format.safe.left - format.safe.right;
    const title = useSceneText("title", {title});
    return (
      <SceneStage>
        <TitleBlock title={{title}} maxWidth={{textWidth}} />
      </SceneStage>
    );
  }},
}});
"""


# ── manifest helpers ──────────────────────────────────────────────────────────


def transition_is_valid(spec: Any) -> bool:
    return isinstance(spec, dict) and isinstance(spec.get("type"), str)


def project_default_transition(manifest: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if "defaultTransition" in manifest:
        spec = manifest["defaultTransition"]
        if spec is None:
            return None
        if transition_is_valid(spec):
            return copy.deepcopy(spec)
    return {"type": "crossfade", "durationMs": 600}


def migrate_manifest_transitions(manifest: Dict[str, Any]) -> bool:
    """Legacy (unversioned) manifests store each transition on the INCOMING scene; v2 on the outgoing one."""
    version = manifest.get("version")
    if is_int(version) and version >= 2:
        return False
    scenes = manifest.get("scenes")
    if isinstance(scenes, list):
        for i in range(len(scenes)):
            nxt = scenes[i + 1].get("transition") if i + 1 < len(scenes) and isinstance(scenes[i + 1], dict) else None
            if isinstance(scenes[i], dict):
                if nxt is not None:
                    scenes[i]["transition"] = copy.deepcopy(nxt)
                else:
                    scenes[i].pop("transition", None)
    manifest["version"] = 2
    return True


def seed_inserted_scene_transitions(scenes: List[Dict[str, Any]], at: int, default: Optional[Dict[str, Any]]) -> None:
    if default is None:
        return
    appended = at + 1 == len(scenes)
    if appended and at > 0 and "transition" not in scenes[at - 1]:
        scenes[at - 1]["transition"] = copy.deepcopy(default)
    if not appended and "transition" not in scenes[at]:
        scenes[at]["transition"] = copy.deepcopy(default)


def entry_duration(entry: Dict[str, Any]) -> int:
    d = entry.get("durationMs")
    return d if is_int(d) and d >= 0 else DEFAULT_SCENE_DURATION_MS


# ── id re-minting (remint_scene_doc_ids) ──────────────────────────────────────


def _mint(entry: Any, prefix: str, counter: List[int], mapping: Dict[str, str]) -> None:
    if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
        return
    old = entry["id"]
    counter[0] += 1
    new = f"{prefix}{counter[0]}"
    entry["id"] = new
    mapping.setdefault(old, new)


def renumber_ids(array: Any, prefix: str) -> Dict[str, str]:
    mapping: Dict[str, str] = {}
    counter = [0]
    if isinstance(array, list):
        for entry in array:
            _mint(entry, prefix, counter, mapping)
    return mapping


def remap_field(value: Any, field: str, mapping: Dict[str, str]) -> None:
    if isinstance(value, dict) and isinstance(value.get(field), str) and value[field] in mapping:
        value[field] = mapping[value[field]]


def remap_keys(value: Any, mapping: Dict[str, str]) -> None:
    if not isinstance(value, dict):
        return
    moved = [k for k in value if k in mapping]
    taken = [(mapping[k], value.pop(k)) for k in moved]
    for new, entry in taken:
        value[new] = entry


def _get(value: Any, *keys: str) -> Any:
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def renumber_track(track: Any) -> None:
    if not isinstance(track, dict):
        return
    keys = renumber_ids(track.get("keys"), "k")
    segments = track.get("segments")
    if isinstance(segments, list):
        for seg in segments:
            remap_field(seg, "from", keys)
            remap_field(seg, "to", keys)


def renumber_layered_screenshot(block: Any) -> Dict[str, str]:
    items: Dict[str, str] = {}
    if not isinstance(block, dict):
        return items
    renumber_ids(block.get("layers"), "l")
    layers = block.get("layers")
    if not isinstance(layers, list):
        return items
    counter = [0]
    for layer in layers:
        lst = layer.get("items") if isinstance(layer, dict) else None
        if isinstance(lst, list):
            for item in lst:
                _mint(item, "i", counter, items)
    for layer in layers:
        lst = layer.get("items") if isinstance(layer, dict) else None
        if isinstance(lst, list):
            for item in lst:
                if isinstance(item, dict):
                    remap_field(item.get("attach"), "to", items)
    return items


def remap_layered_text_keys(doc: Dict[str, Any], items: Dict[str, str]) -> None:
    if not items:
        return
    text: Dict[str, str] = {}
    style: Dict[str, str] = {}
    for old, new in items.items():
        o, n = f"ls-{old}", f"ls-{new}"
        for suffix in TEXT_STYLE_SUFFIXES:
            style[o + suffix] = n + suffix
        text[o] = n
    remap_keys(doc.get("text"), text)
    remap_keys(doc.get("textStyle"), style)


def remint_scene_doc_ids(doc: Dict[str, Any]) -> None:
    devices = renumber_ids(doc.get("devices"), "d")
    renumber_ids(doc.get("images"), "img")
    renumber_ids(doc.get("objects"), "o")
    remap_field(doc.get("duration"), "sourceDeviceId", devices)
    remap_keys(_get(doc, "deviceLayout", "devices"), devices)
    for field in ("media", "coverMedia"):
        remap_keys(_get(doc, "compare", "b", field), devices)
    remap_keys(_get(doc, "compare", "b", "deviceAppearance"), devices)
    rig_keys = _get(doc, "cameraRig", "keys")
    if isinstance(rig_keys, list):
        for key in rig_keys:
            aim = _get(key, "pose", "aim")
            if isinstance(aim, dict) and aim.get("mode") == "object" and isinstance(aim.get("id"), str) and aim["id"] in devices:
                aim["id"] = devices[aim["id"]]
    dev_keys = _get(doc, "deviceTrack", "keys")
    if isinstance(dev_keys, list):
        for key in dev_keys:
            if isinstance(key, dict):
                remap_keys(key.get("pose"), devices)
    renumber_track(doc.get("camera"))
    renumber_track(doc.get("cameraRig"))
    renumber_track(doc.get("deviceTrack"))
    renumber_track(doc.get("lighting"))
    renumber_track(_get(doc, "compare", "track"))
    renumber_track(_get(doc, "chart", "track"))
    renumber_track(_get(doc, "layeredScreenshot", "animation"))
    renumber_ids(_get(doc, "chart", "data", "series"), "s")
    renumber_ids(_get(doc, "frame", "decorations"), "dec")
    items = renumber_layered_screenshot(doc.get("layeredScreenshot"))
    remap_layered_text_keys(doc, items)


# ── preset context (inherit_preset_context) ───────────────────────────────────


def _valid_frame(value: Any) -> Optional[Dict[str, Any]]:
    if isinstance(value, dict) and isinstance(value.get("cutout"), dict) and value["cutout"].get("shape") in FRAME_SHAPES:
        return value
    return None


def _first_bool(*values: Any) -> Optional[bool]:
    for v in values:
        if isinstance(v, bool):
            return v
    return None


def resolved_claimed_frame_icon(doc: Dict[str, Any], deck_frame: Any) -> Optional[str]:
    deck = _valid_frame(deck_frame)
    scene = doc.get("frame") if isinstance(doc.get("frame"), dict) else None
    if _valid_frame(doc.get("frame")) is None and deck is None:
        return None
    enabled = _first_bool(_get(scene, "enabled"), _get(deck, "enabled"))
    if enabled is False:
        return None
    claims = _first_bool(_get(scene, "claimsSceneText"), _get(deck, "claimsSceneText"))
    if claims is False:
        return None
    for candidate in (_get(scene, "icon"), _get(deck, "icon")):
        if isinstance(candidate, str):
            return candidate
    return ""


def inherit_preset_context(doc: Optional[Dict[str, Any]], manifest: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    stamp = manifest.get("appliedBackground") if isinstance(manifest.get("appliedBackground"), dict) else None
    if doc is None and stamp is not None and ("background" in stamp or "backdrop" in stamp):
        doc = {"version": SCENE_DOC_VERSION}
    if not isinstance(doc, dict):
        return doc
    if stamp is not None and "background" not in doc and "backdrop" not in doc:
        if "background" in stamp:
            doc["background"] = copy.deepcopy(stamp["background"])
        if "backdrop" in stamp:
            doc["backdrop"] = copy.deepcopy(stamp["backdrop"])
    icon = resolved_claimed_frame_icon(doc, manifest.get("frame"))
    if icon is None:
        return doc
    items = _get(doc, "managedText", "items")
    if isinstance(items, list) and not any(isinstance(i, dict) and i.get("key") == "frameIcon" for i in items):
        items.insert(0, {"key": "frameIcon", "type": "icon", "icon": icon})
    return doc


# ── assets (copy_scene_assets) ────────────────────────────────────────────────


def collect_json_asset_refs(value: Any, found: Optional[List[str]] = None) -> List[str]:
    found = [] if found is None else found
    if isinstance(value, str):
        if tsxmod.is_project_asset_ref(value) and value not in found:
            found.append(value)
    elif isinstance(value, list):
        for v in value:
            collect_json_asset_refs(v, found)
    elif isinstance(value, dict):
        for v in value.values():
            collect_json_asset_refs(v, found)
    return found


def rewrite_json_asset_refs(value: Any, replacements: List[Tuple[str, str]]) -> Any:
    if isinstance(value, str):
        for source, replacement in replacements:
            if value == source:
                return replacement
        return value
    if isinstance(value, list):
        return [rewrite_json_asset_refs(v, replacements) for v in value]
    if isinstance(value, dict):
        return {k: rewrite_json_asset_refs(v, replacements) for k, v in value.items()}
    return value


def free_sibling_name(directory: Path, name: str) -> str:
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        stem, ext = name, ""
    n = 1
    while True:
        n += 1
        candidate = f"{stem}-{n}.{ext}" if ext else f"{stem}-{n}"
        if not (directory / candidate).exists():
            return candidate


def copy_scene_assets(
    source_root: Path,
    dest_root: Path,
    tsx_text: str,
    doc: Optional[Dict[str, Any]],
    entry: Dict[str, Any],
    sample_pool: Optional[Path],
    tx: Optional[lockmod.Txn] = None,
) -> Tuple[str, Optional[Dict[str, Any]], Dict[str, Any], List[str]]:
    """Copy every referenced asset (planned on tx when given); a name clash with different bytes gets a -2 sibling and the refs follow."""
    refs = tsxmod.scan_asset_refs(tsx_text)
    for rel in collect_json_asset_refs(entry) + (collect_json_asset_refs(doc) if doc is not None else []):
        if rel not in refs:
            refs.append(rel)
    replacements: List[Tuple[str, str]] = []
    copied: List[str] = []
    for rel in refs:
        local = source_root / rel
        src = local
        if not local.is_file() and sample_pool is not None:
            name = rel[len("assets/"):]
            if "/" not in name:
                src = sample_pool / name
        if not src.is_file():
            continue
        dir_rel, _, name = rel.rpartition("/")
        dir_rel = dir_rel or "assets"
        dest_dir = dest_root / dir_rel
        dest = dest_dir / name
        if dest.is_file():
            try:
                same = filecmp.cmp(str(src), str(dest), shallow=False)
            except OSError:
                same = False
            if same:
                continue
            free = free_sibling_name(dest_dir, name)
            replacements.append((rel, f"{dir_rel}/{free}"))
            dest = dest_dir / free
        if tx is not None:
            tx.copy_in(dest.relative_to(dest_root).as_posix(), src)
        else:
            dest_dir.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(str(src), str(dest))
            os.utime(str(dest), None)
        copied.append(str(dest.relative_to(dest_root)))
    if replacements:
        tsx_text = tsxmod.rewrite_text_asset_refs(tsx_text, replacements)
        if doc is not None:
            doc = rewrite_json_asset_refs(doc, replacements)
        entry = rewrite_json_asset_refs(entry, replacements)
    return tsx_text, doc, entry, copied


# ── stems and ids ─────────────────────────────────────────────────────────────


def taken_scene_ids(project: Project) -> Set[str]:
    return {sid for sid in (tsxmod.scene_id(t) for t in project.all_tsx().values()) if sid is not None}


def free_scene_id(base: str, taken: Set[str]) -> str:
    if base not in taken:
        return base
    n = 1
    while True:
        n += 1
        candidate = f"{base}-{n}"
        if candidate not in taken:
            return candidate


def stem_taken(project: Project, stem: str) -> bool:
    return (project.scenes_dir / f"{stem}.tsx").exists() or (project.scenes_dir / f"{stem}.json").exists()


def mint_stem(project: Project, requested: str) -> str:
    """Keep a free numbered stem as given; otherwise number it with the project's next prefix."""
    requested = stem_of(requested.strip())
    if numeric_prefix(requested) is not None and "-" in requested:
        slug = requested.split("-", 1)[1]
        cleaned = f"{requested.split('-', 1)[0]}-{slugify(slug)}"
        if not stem_taken(project, cleaned):
            return cleaned
        base = slugify(slug)
    else:
        base = slugify(requested)
    return f"{project.next_prefix():02d}-{base}"


def base_id_for(stem: str) -> str:
    if numeric_prefix(stem) is not None and "-" in stem:
        rest = stem.split("-", 1)[1]
        if rest:
            return slugify(rest)
    return slugify(stem)


def position_from(project: Project, after: Optional[str], at: Optional[int], count: int) -> Optional[int]:
    if after is not None and at is not None:
        raise KbError("pass --after or --at, not both", 2, kind="usage")
    if after is not None:
        idx, _ = project.resolve(after)
        return idx + 1
    if at is not None:
        if at < 0 or at > count:
            raise KbError(f"--at {at} is out of range; use 0-{count} (0 = first, {count} = last)", 2, kind="usage")
        return at
    return None


# ── operations ────────────────────────────────────────────────────────────────
# Each plans its writes from a fresh project.json on a kblib.lock transaction, rebuilt when someone saved meanwhile.


class Result:
    def __init__(self, file: str, index: int, scene_id: str, name: str, notes: Optional[List[str]] = None) -> None:
        self.file = file
        self.index = index
        self.scene_id = scene_id
        self.name = name
        self.notes = notes or []
        self.writes: List[Dict[str, Any]] = []
        self.dry_run = False

    def as_dict(self) -> Dict[str, Any]:
        return {"file": self.file, "index": self.index, "id": self.scene_id, "name": self.name, "notes": self.notes, "writes": self.writes, "dryRun": self.dry_run}


class Pins:
    """Scenes addressed by index: a rebuild on a newer project.json refuses when the index now names another scene."""

    def __init__(self) -> None:
        self.seen: Dict[str, str] = {}

    def resolve(self, view: Project, selector: str) -> Tuple[int, str]:
        idx, stem = view.resolve(selector)
        key = selector.strip()
        if key.isascii() and key.isdigit():
            first = self.seen.setdefault(key, stem)
            if first != stem:
                raise KbError(
                    f"scene {key} is now {stem}, not {first}: project.json changed while kb wrote it. Nothing was written",
                    EXIT_PROBLEMS,
                    kind="conflict",
                    hint=f"address the scene by its stem ({first}) and rerun",
                )
        return idx, stem


class Place:
    """Where a new scene goes (--after S or --at N), resolved against the manifest each attempt reads."""

    def __init__(self, after: Optional[str] = None, at: Optional[int] = None) -> None:
        if after is not None and at is not None:
            raise KbError("pass --after or --at, not both", 2, kind="usage")
        self.after = after
        self.at = at

    @property
    def given(self) -> bool:
        return self.after is not None or self.at is not None

    def index(self, view: Project, count: int, pins: Pins) -> Optional[int]:
        if self.after is not None:
            idx, _ = pins.resolve(view, self.after)
            return idx + 1
        if self.at is not None:
            if self.at < 0 or self.at > count:
                raise KbError(f"--at {self.at} is out of range; use 0-{count} (0 = first, {count} = last)", 2, kind="usage")
            return self.at
        return None


def _place(place: Any) -> Place:
    return place if isinstance(place, Place) else Place(at=place)


def _view(project: Project, manifest: Dict[str, Any]) -> Project:
    """A Project over a manifest this attempt read, so selectors resolve against the same bytes it writes back."""
    view = Project(project.root)
    view._manifest = manifest
    return view


def _manifest_for_edit(tx: lockmod.Txn) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """(as read, migrated for editing)."""
    raw, _sha = tx.read_json(MANIFEST, "project.json")
    if raw is None:
        raise KbError("project.json does not exist")
    if not isinstance(raw, dict):
        raise KbError("project.json must be a JSON object; restore it with kb undo")
    if not isinstance(raw.get("scenes"), list):
        raise KbError('project.json has no "scenes" array; restore it with kb undo')
    manifest = copy.deepcopy(raw)
    migrate_manifest_transitions(manifest)
    return raw, manifest


def _run(project: Project, op: str, build: Callable[[lockmod.Txn], Any], opts: Optional[lockmod.WriteOpts]) -> Tuple[Any, lockmod.Txn]:
    opts = opts or lockmod.WriteOpts()
    result, tx = lockmod.transact(project, op, build, dry_run=opts.dry_run, caller=opts.caller, wait=opts.wait)
    if tx.committed and tx.planned(MANIFEST):
        project.manifest(reload=True)
    if isinstance(result, Result):
        result.writes = tx.writes
        result.dry_run = tx.dry_run
    return result, tx


def _read_text(tx: lockmod.Txn, rel: str) -> str:
    data, _sha = tx.read(rel)
    if data is None:
        raise KbError(f"cannot read {rel}: it does not exist")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise KbError(f"{rel} is not UTF-8 text") from None


def add_blank(project: Project, stem: str, name: Optional[str], duration: Optional[int], place: Any = None, opts: Optional[lockmod.WriteOpts] = None) -> Result:
    where = _place(place)
    pins = Pins()

    def build(tx: lockmod.Txn) -> Result:
        _raw, manifest = _manifest_for_edit(tx)
        view = _view(project, manifest)
        scenes: List[Dict[str, Any]] = manifest["scenes"]
        requested = stem_of(stem.strip())
        existing = project.scenes_dir / f"{requested}.tsx"
        listed = [e.get("file") for e in scenes if isinstance(e, dict)]
        notes: List[str] = []
        if existing.is_file():
            if f"scenes/{requested}.tsx" in listed:
                raise KbError(f"scenes/{requested}.tsx is already scene {listed.index(f'scenes/{requested}.tsx')}; use kb scene duplicate to copy it")
            return _register_existing(tx, project, manifest, requested, duration, where.index(view, len(scenes), pins))
        position = where.index(view, len(scenes), pins)
        final = mint_stem(project, requested)
        display = name or humanise(final)
        sid = free_scene_id(base_id_for(final), taken_scene_ids(project))
        dur = duration or 3000
        tx.write_text(f"scenes/{final}.tsx", BLANK_TSX.format(id=sid, duration=dur, title=_js_string(display)), create_only=True)
        tx.write_json(f"scenes/{final}.json", {"version": SCENE_DOC_VERSION, "name": display, "text": {"title": display}}, create_only=True)
        entry = {"file": f"scenes/{final}.tsx", "durationMs": dur}
        at = len(scenes) if position is None else min(position, len(scenes))
        scenes.insert(at, entry)
        seed_inserted_scene_transitions(scenes, at, project_default_transition(manifest))
        tx.write_json(MANIFEST, manifest)
        if final != requested:
            notes.append(f'stem "{requested}" became "{final}" (numbered and unique)')
        return Result(entry["file"], at, sid, display, notes)

    return _run(project, "kb scene add", build, opts)[0]


def _register_existing(tx: lockmod.Txn, project: Project, manifest: Dict[str, Any], stem: str, duration: Optional[int], position: Optional[int]) -> Result:
    """Adopt a scenes/<stem>.tsx that exists on disk but is not in project.json."""
    scenes: List[Dict[str, Any]] = manifest["scenes"]
    rel = f"scenes/{stem}.tsx"
    text = _read_text(tx, rel)
    notes = [f"registered the existing {rel}"]
    sid = tsxmod.scene_id(text)
    others = {f: t for f, t in project.all_tsx().items() if f != rel}
    taken = {tsxmod.scene_id(t) for t in others.values()} - {None}
    if sid is not None and sid in taken:
        new_id = free_scene_id(base_id_for(stem), taken)  # type: ignore[arg-type]
        rewritten = tsxmod.rewrite_scene_id(text, new_id)
        if rewritten is not None:
            tx.write_text(rel, rewritten)
            notes.append(f'its id "{sid}" was taken, so it is now "{new_id}"')
            sid = new_id
    dur = duration or _tsx_duration(text) or 3000
    entry = {"file": rel, "durationMs": dur}
    at = len(scenes) if position is None else min(position, len(scenes))
    scenes.insert(at, entry)
    seed_inserted_scene_transitions(scenes, at, project_default_transition(manifest))
    tx.write_json(MANIFEST, manifest)
    doc = project.load_sidecar(stem)
    name = doc.get("name") if isinstance(doc, dict) and isinstance(doc.get("name"), str) else humanise(stem)
    return Result(entry["file"], at, sid or "?", name, notes)


def _tsx_duration(text: str) -> Optional[int]:
    import re

    m = re.search(r"\bdurationMs\s*:\s*(\d+)", text)
    return int(m.group(1)) if m else None


def _js_string(value: str) -> str:
    import json

    return json.dumps(value, ensure_ascii=False)


def _copy(
    tx: lockmod.Txn,
    project: Project,
    manifest: Dict[str, Any],
    source_root: Path,
    source_entry: Dict[str, Any],
    stem: Optional[str],
    name: Optional[str],
    position: Optional[int],
    is_preset: bool,
    sample_pool: Optional[Path],
    duplicate_naming: bool,
    duration: Optional[int],
) -> Result:
    """copy_scene_between / duplicate_scene: fresh stem and id, sidecar ids re-minted, assets carried."""
    file = source_entry.get("file")
    if not isinstance(file, str) or not file.startswith("scenes/") or ".." in file:
        raise KbError(f"invalid scene path in the source: {file!r}")
    tsx_path = source_root / file
    try:
        tsx_text = read_text(tsx_path)
    except OSError as e:
        raise KbError(f"cannot read {tsx_path}: {e.strerror}") from None
    doc_path = source_root / (file[:-4] + ".json")
    doc: Optional[Dict[str, Any]] = None
    if doc_path.is_file():
        loaded = load_json(doc_path, str(doc_path))
        doc = loaded if isinstance(loaded, dict) else None
    entry = copy.deepcopy(source_entry)
    same_project = source_root.resolve() == project.root.resolve()
    copied: List[str] = []
    if not same_project:
        tsx_text, doc, entry, copied = copy_scene_assets(source_root, project.root, tsx_text, doc, entry, sample_pool, tx)
    if is_preset:
        doc = inherit_preset_context(doc, manifest)
    default_transition = project_default_transition(manifest) if is_preset else None
    stem_src = stem_of(file)
    source_name = doc.get("name") if isinstance(doc, dict) and isinstance(doc.get("name"), str) else None
    fallback_name = stem_src.split("-", 1)[1].replace("-", " ") if "-" in stem_src else stem_src
    if duplicate_naming:
        base_name = f"{source_name or fallback_name} copy"
        final = f"{project.next_prefix():02d}-{slugify(base_name)}" if stem is None else mint_stem(project, stem)
    else:
        base_name = name or source_name or fallback_name
        final = mint_stem(project, stem) if stem else f"{project.next_prefix():02d}-{slugify(base_name)}"
    sid = free_scene_id(base_id_for(final) if stem else slugify(base_name), taken_scene_ids(project))
    rewritten = tsxmod.rewrite_scene_id(tsx_text, sid)
    notes: List[str] = []
    if rewritten is None:
        notes.append(f"{file} has no readable defineScene id, so the copy keeps the source's")
        sid = tsxmod.scene_id(tsx_text) or "?"
    else:
        tsx_text = rewritten
    tx.write_text(f"scenes/{final}.tsx", tsx_text, create_only=True)
    if doc is not None:
        if duplicate_naming and source_name is not None:
            doc["name"] = f"{source_name} copy"
        if name:
            doc["name"] = name
        remint_scene_doc_ids(doc)
        tx.write_json(f"scenes/{final}.json", doc, create_only=True)
    scenes: List[Dict[str, Any]] = manifest["scenes"]
    new_entry: Dict[str, Any] = {"file": f"scenes/{final}.tsx", "durationMs": duration if duration is not None else entry_duration(entry)}
    if duplicate_naming and "transition" in entry:
        new_entry["transition"] = entry["transition"]
    if not duplicate_naming and "effects" in entry:
        new_entry["effects"] = entry["effects"]
    at = len(scenes) if position is None else min(position, len(scenes))
    scenes.insert(at, new_entry)
    seed_inserted_scene_transitions(scenes, at, default_transition)
    tx.write_json(MANIFEST, manifest)
    if copied:
        notes.append(f"{'would copy' if tx.dry_run else 'copied'} {', '.join(copied)}")
    display = doc.get("name") if isinstance(doc, dict) and isinstance(doc.get("name"), str) else humanise(final)
    return Result(new_entry["file"], at, sid, display, notes)


def copy_into(
    project: Project,
    source_root: Path,
    source_entry: Dict[str, Any],
    stem: Optional[str],
    name: Optional[str],
    position: Any,
    is_preset: bool,
    sample_pool: Optional[Path],
    duplicate_naming: bool = False,
    opts: Optional[lockmod.WriteOpts] = None,
    duration: Optional[int] = None,
) -> Result:
    """A scene from another folder (a preset): position is a Place or a 0-based index; duration overrides its length."""
    where = _place(position)
    pins = Pins()

    def build(tx: lockmod.Txn) -> Result:
        _raw, manifest = _manifest_for_edit(tx)
        at = where.index(_view(project, manifest), len(manifest["scenes"]), pins)
        return _copy(tx, project, manifest, source_root, source_entry, stem, name, at, is_preset, sample_pool, duplicate_naming, duration)

    return _run(project, "kb scene add", build, opts)[0]


def duplicate(project: Project, selector: str, position: Any = None, opts: Optional[lockmod.WriteOpts] = None) -> Result:
    where = _place(position)
    pins = Pins()

    def build(tx: lockmod.Txn) -> Result:
        raw, manifest = _manifest_for_edit(tx)
        view = _view(project, raw)
        idx, _stem = pins.resolve(view, selector)
        at = where.index(view, len(manifest["scenes"]), pins) if where.given else idx + 1
        return _copy(tx, project, manifest, project.root, raw["scenes"][idx], None, None, at, False, None, True, None)

    return _run(project, "kb scene duplicate", build, opts)[0]


def copy_scene(project: Project, selector: str, stem: str, name: Optional[str], position: Any = None, opts: Optional[lockmod.WriteOpts] = None, duration: Optional[int] = None) -> Result:
    where = _place(position)
    pins = Pins()

    def build(tx: lockmod.Txn) -> Result:
        raw, manifest = _manifest_for_edit(tx)
        view = _view(project, raw)
        idx, _ = pins.resolve(view, selector)
        at = where.index(view, len(manifest["scenes"]), pins)
        return _copy(tx, project, manifest, project.root, raw["scenes"][idx], stem, name, at, False, None, True, duration)

    return _run(project, "kb scene add", build, opts)[0]


def move(project: Project, selector: str, to: Optional[int] = None, after: Optional[str] = None, opts: Optional[lockmod.WriteOpts] = None) -> Tuple[int, int, List[Dict[str, Any]]]:
    """(from, to, writes); --after S places it right after S."""
    pins = Pins()

    def build(tx: lockmod.Txn) -> Tuple[int, int]:
        _raw, manifest = _manifest_for_edit(tx)
        view = _view(project, manifest)
        scenes = manifest["scenes"]
        idx, _ = pins.resolve(view, selector)
        if after is not None:
            dst, _ = pins.resolve(view, after)
            target = dst if idx < dst else dst + 1
        else:
            target = int(to) if to is not None else idx
        if target < 0 or target >= len(scenes):
            raise KbError(f"--to {target} is out of range; use 0-{len(scenes) - 1}", 2, kind="usage")
        if idx != target:
            entry = scenes.pop(idx)
            scenes.insert(target, entry)
        tx.write_json(MANIFEST, manifest)
        return idx, target

    (frm, target), tx = _run(project, "kb scene move", build, opts)
    return frm, target, tx.writes


def remove(project: Project, selector: str, trash_fn: Any, opts: Optional[lockmod.WriteOpts] = None) -> Tuple[int, List[str], List[Dict[str, Any]]]:
    """(index, trashed files, writes): project.json first, then the scene's own files go to the Trash."""
    pins = Pins()
    removed_stem: List[str] = []

    def build(tx: lockmod.Txn) -> Tuple[int, List[str]]:
        _raw, manifest = _manifest_for_edit(tx)
        scenes = manifest["scenes"]
        idx, stem = pins.resolve(_view(project, manifest), selector)
        removed_stem[:] = [stem]
        if len(scenes) <= 1:
            raise KbError("a project needs at least one scene; add another before removing this one")
        removed = scenes.pop(idx)
        tx.write_json(MANIFEST, manifest)
        trashed: List[str] = []
        file = removed.get("file") if isinstance(removed, dict) else None
        still_used = {e.get("file") for e in scenes if isinstance(e, dict)}
        if isinstance(file, str) and file.startswith("scenes/") and ".." not in file and file not in still_used:
            for rel in (file, file[:-4] + ".json"):
                if (project.root / rel).is_file():
                    tx.trash(rel, trash_fn)
                    trashed.append(rel)
        return idx, trashed

    (idx, trashed), tx = _run(project, "kb scene remove", build, opts)
    if tx.committed and removed_stem:
        from . import leases

        leases.release_removed(project, removed_stem[0], tx.caller)
    return idx, trashed, tx.writes


def set_scene(
    project: Project,
    selector: str,
    duration: Optional[int],
    transition: Optional[str],
    ease: Optional[str],
    name: Optional[str],
    opts: Optional[lockmod.WriteOpts] = None,
) -> Dict[str, Any]:
    """{ index, stem, changes, writes, dryRun }."""
    pins = Pins()

    def build(tx: lockmod.Txn) -> Dict[str, Any]:
        changes: List[str] = []
        _raw, manifest = _manifest_for_edit(tx)
        idx, stem = pins.resolve(_view(project, manifest), selector)
        if duration is not None or transition is not None or ease is not None:
            scenes = manifest["scenes"]
            entry = scenes[idx]
            if duration is not None:
                if duration <= 0:
                    raise KbError("--duration must be a positive number of milliseconds", 2, kind="usage")
                entry["durationMs"] = duration
                changes.append(f"durationMs = {duration}")
            if transition is not None or ease is not None:
                if idx + 1 >= len(scenes) and (transition not in (None, "none", "cut")):
                    raise KbError("the last scene has no outgoing transition (nothing follows it); set it on the scene before")
                spec = entry.get("transition") if isinstance(entry.get("transition"), dict) else None
                if transition in ("none", "cut"):
                    entry.pop("transition", None)
                    changes.append("transition removed (hard cut)")
                else:
                    if transition is not None:
                        kind, _, ms = transition.partition(":")
                        if not kind:
                            raise KbError('--transition needs TYPE or TYPE:MS, e.g. crossfade:600, or "none"', 2, kind="usage")
                        keep = dict(spec) if spec and spec.get("type") == kind else {}
                        keep["type"] = kind
                        if ms:
                            try:
                                keep["durationMs"] = int(ms)
                            except ValueError:
                                raise KbError(f'--transition "{transition}": the part after ":" must be milliseconds', 2, kind="usage") from None
                        elif "durationMs" not in keep:
                            keep["durationMs"] = int(spec.get("durationMs", 600)) if spec and is_int(spec.get("durationMs")) else 600
                        spec = keep
                    if spec is None:
                        raise KbError("this scene has no transition to ease; pass --transition TYPE[:MS] too", 2, kind="usage")
                    if ease is not None:
                        if ease == "linear":
                            spec.pop("ease", None)
                        else:
                            spec["ease"] = ease
                    entry["transition"] = spec
                    changes.append(f"transition = {spec}")
            tx.write_json(MANIFEST, manifest)
        if name is not None:
            rel = f"scenes/{stem}.json"
            doc, _sha = tx.read_json(rel)
            if doc is not None and not isinstance(doc, dict):
                raise KbError(f"{rel} must be a JSON object")
            doc = doc or {"version": SCENE_DOC_VERSION}
            doc["name"] = name
            tx.write_json(rel, doc)
            changes.append(f'name = "{name}"')
        return {"index": idx, "stem": stem, "changes": changes}

    out, tx = _run(project, "kb scene set", build, opts)
    return dict(out, writes=tx.writes, dryRun=tx.dry_run)
