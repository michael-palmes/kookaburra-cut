"""Project discovery and IO: project.json, scene files, sidecars, the workspace around them."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .util import EXIT_ENV, KbError, atomic_write_json, is_int, load_json, read_text

MANIFEST = "project.json"
KIT_REL = ".claude/skills/kookaburra-scene-authoring"
APP_OWNED_DIRS = ("exports", "edits")
DEFAULT_SCENE_DURATION_MS = 4000


def find_root(start: Optional[Path] = None, explicit: Optional[str] = None) -> Path:
    """The project folder: --project-dir, else the cwd or a parent holding project.json, else $CLAUDE_PROJECT_DIR."""
    if explicit:
        root = Path(explicit).expanduser().resolve()
        if not (root / MANIFEST).is_file():
            raise KbError(f"{root} has no project.json; pass a Kookaburra Cut project folder", EXIT_ENV)
        return root
    here = (start or Path.cwd()).resolve()
    for candidate in [here] + list(here.parents):
        if (candidate / MANIFEST).is_file():
            return candidate
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env and (Path(env) / MANIFEST).is_file():
        return Path(env).resolve()
    script_project = Path(__file__).resolve().parents[5] if len(Path(__file__).resolve().parents) > 5 else None
    if script_project and (script_project / MANIFEST).is_file():
        return script_project
    raise KbError("no project.json in this folder or its parents; run kb from a Kookaburra Cut project folder", EXIT_ENV)


def stem_of(file: str) -> str:
    name = file[len("scenes/"):] if file.startswith("scenes/") else file
    return name[:-4] if name.endswith(".tsx") else name


def numeric_prefix(stem: str) -> Optional[int]:
    head = stem.split("-", 1)[0]
    if head and head.isascii() and head.isdigit():
        return int(head)
    return None


def slugify(name: str) -> str:
    """scene_doc.rs slugify: ascii alnum lowercased, spaces/hyphens/underscores collapse to one hyphen."""
    out: List[str] = []
    for c in name:
        if c.isascii() and c.isalnum():
            out.append(c.lower())
        elif c in " -_" and not (out and out[-1] == "-"):
            out.append("-")
    slug = "".join(out).strip("-")
    return slug or "scene"


def humanise(stem: str) -> str:
    base = stem.split("-", 1)[1] if numeric_prefix(stem) is not None and "-" in stem else stem
    words = base.replace("-", " ").replace("_", " ").strip()
    return words[:1].upper() + words[1:] if words else "Scene"


class Project:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.slug = root.name
        self._manifest: Optional[Dict[str, Any]] = None

    @property
    def project_id(self) -> str:
        return f"ws:{self.slug}"

    @property
    def manifest_path(self) -> Path:
        return self.root / MANIFEST

    @property
    def scenes_dir(self) -> Path:
        return self.root / "scenes"

    @property
    def assets_dir(self) -> Path:
        return self.root / "assets"

    @property
    def workspace_root(self) -> Path:
        return self.root.parent

    @property
    def kit_dir(self) -> Path:
        return self.root / KIT_REL

    def manifest(self, reload: bool = False) -> Dict[str, Any]:
        if self._manifest is None or reload:
            data = load_json(self.manifest_path, "project.json")
            if not isinstance(data, dict):
                raise KbError("project.json must be a JSON object; restore it with kb undo")
            self._manifest = data
        return self._manifest

    def scene_entries(self) -> List[Dict[str, Any]]:
        scenes = self.manifest().get("scenes")
        if not isinstance(scenes, list):
            raise KbError('project.json has no "scenes" array; restore it with kb undo')
        return scenes

    def save_manifest(self, manifest: Dict[str, Any]) -> None:
        atomic_write_json(self.manifest_path, manifest)
        self._manifest = manifest

    def scene_files(self) -> List[str]:
        out: List[str] = []
        for entry in self.scene_entries():
            file = entry.get("file") if isinstance(entry, dict) else None
            out.append(file if isinstance(file, str) else "")
        return out

    def stems(self) -> List[str]:
        return [stem_of(f) for f in self.scene_files()]

    def resolve(self, selector: str) -> Tuple[int, str]:
        """A scene index (0-based) or file stem (also scenes/<stem>.tsx or .json) to (index, stem)."""
        sel = selector.strip()
        stems = self.stems()
        if sel.isascii() and sel.isdigit():
            idx = int(sel)
            if idx < len(stems):
                return idx, stems[idx]
            raise KbError(f'no scene at index {idx}; the project has {len(stems)} (0-{len(stems) - 1}). List them with kb scenes')
        sel = sel[len("scenes/"):] if sel.startswith("scenes/") else sel
        for suffix in (".tsx", ".json"):
            if sel.endswith(suffix):
                sel = sel[: -len(suffix)]
        if sel in stems:
            return stems.index(sel), sel
        close = [s for s in stems if sel.lower() in s.lower()]
        hint = f" Did you mean {', '.join(close[:3])}?" if close else " List them with kb scenes"
        raise KbError(f'no scene "{selector}" in project.json.{hint}')

    def sidecar_path(self, stem: str) -> Path:
        return self.scenes_dir / f"{stem}.json"

    def tsx_path(self, stem: str) -> Path:
        return self.scenes_dir / f"{stem}.tsx"

    def load_sidecar(self, stem: str) -> Optional[Dict[str, Any]]:
        path = self.sidecar_path(stem)
        if not path.is_file():
            return None
        data = load_json(path, f"scenes/{stem}.json")
        if not isinstance(data, dict):
            raise KbError(f"scenes/{stem}.json must be a JSON object")
        return data

    def read_tsx(self, stem: str) -> str:
        return read_text(self.tsx_path(stem))

    def all_tsx(self) -> Dict[str, str]:
        out: Dict[str, str] = {}
        if not self.scenes_dir.is_dir():
            return out
        for path in sorted(self.scenes_dir.iterdir()):
            if path.suffix == ".tsx" and path.is_file():
                try:
                    if path.stat().st_size <= 512 * 1024:
                        out[f"scenes/{path.name}"] = read_text(path)
                except (OSError, UnicodeDecodeError):
                    continue
        return out

    def next_prefix(self) -> int:
        """scene_doc.rs next_prefix: one past the largest numeric prefix under scenes/."""
        best = 0
        if self.scenes_dir.is_dir():
            for path in self.scenes_dir.iterdir():
                n = numeric_prefix(path.name)
                if n is not None and n < 2 ** 32:
                    best = max(best, n)
        return best + 1

    def theme_file(self, theme_id: str) -> Optional[Path]:
        if theme_id.startswith("ws:"):
            return self.workspace_root / "themes" / theme_id[3:] / "theme.json"
        return None

    def persistent_file(self) -> Optional[str]:
        value = self.manifest().get("persistent")
        return value if isinstance(value, str) else None

    def total_ms(self) -> int:
        """Timeline length: durations minus each outgoing transition's clamped overlap."""
        entries = [e for e in self.scene_entries() if isinstance(e, dict)]
        legacy = not (is_int(self.manifest().get("version")) and self.manifest()["version"] >= 2)
        total = 0
        prev_end = 0
        prev_dur = 0
        for i, entry in enumerate(entries):
            dur = entry.get("durationMs") if is_int(entry.get("durationMs")) else DEFAULT_SCENE_DURATION_MS
            if i == 0:
                start = 0
            else:
                spec = entries[i].get("transition") if legacy else entries[i - 1].get("transition")
                overlap = 0
                if isinstance(spec, dict) and isinstance(spec.get("durationMs"), (int, float)):
                    overlap = max(0, min(int(spec["durationMs"]), prev_dur, dur))
                start = prev_end - overlap
            prev_end = start + dur
            prev_dur = dur
            total = prev_end
        return total


def scene_name(doc: Optional[Dict[str, Any]], stem: str) -> str:
    if doc and isinstance(doc.get("name"), str) and doc["name"].strip():
        return doc["name"]
    return humanise(stem)


SAFE_SESSION = re.compile(r"[^A-Za-z0-9._-]")
