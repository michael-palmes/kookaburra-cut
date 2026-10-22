"""Workspace brands (brands/<slug>/brand.json): listing, matching a user's words to one, and what applying it changes."""

from __future__ import annotations

import contextlib
import json
import re
import shutil
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from .project import BRAND_GUIDE, Project
from .util import KbError

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def brands_root(project: Project) -> Path:
    return project.workspace_root / "brands"


def load(folder: Path) -> Optional[Dict[str, Any]]:
    try:
        doc = json.loads((folder / "brand.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict) or not isinstance(doc.get("name"), str):
        return None
    doc["id"] = f"ws:{folder.name}"
    doc["slug"] = folder.name
    return doc


def all_brands(project: Project) -> List[Dict[str, Any]]:
    root = brands_root(project)
    if not root.is_dir():
        return []
    found = [load(folder) for folder in sorted(root.iterdir()) if folder.is_dir()]
    return sorted((b for b in found if b), key=lambda b: b["name"].lower())


def image_counts(project: Project, slug: str) -> Dict[str, int]:
    images = brands_root(project) / slug / "images"
    counts: Dict[str, int] = {}
    if images.is_dir():
        for path in images.rglob("*"):
            if path.is_file() and path.suffix.lower() in IMAGE_EXTS and not path.name.startswith("."):
                parts = path.relative_to(images).parts
                category = parts[0] if len(parts) > 1 else "other"
                counts[category] = counts.get(category, 0) + 1
    return counts


FILLER = {"the", "a", "an", "our", "my", "brand", "brands", "pack", "use"}


def normalise(text: str) -> str:
    """Lowercase alphanumerics with filler words dropped, so "the Acme brand" matches a brand named Acme."""
    words = [w for w in re.split(r"[^a-z0-9]+", text.lower()) if w]
    kept = [w for w in words if w not in FILLER]
    return "".join(kept or words)


def match(project: Project, query: str) -> Dict[str, Any]:
    """A brand by id, slug or name, case and punctuation ignored; a unique prefix also matches."""
    brands = all_brands(project)
    if not brands:
        raise KbError(f"no brands in {brands_root(project)}; build one with the kookaburra-brand-packs skill", 2, kind="usage")
    wanted = normalise(query[3:] if query.startswith("ws:") else query)
    for b in brands:
        if wanted in (normalise(b["slug"]), normalise(b["name"])):
            return b
    partial = [b for b in brands if normalise(b["slug"]).startswith(wanted) or normalise(b["name"]).startswith(wanted)]
    if len(partial) == 1 and wanted:
        return partial[0]
    names = ", ".join(f"{b['name']} ({b['id']})" for b in brands)
    raise KbError(f'no single brand matches "{query}"; installed: {names}', 2, kind="usage")


def applied(manifest: Dict[str, Any], brand: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    """The manifest with the brand applied as the Project picker applies it, and what changed."""
    out = dict(manifest)
    changes = [f"brand {manifest.get('brand') or 'none'} -> {brand['id']}"] if manifest.get("brand") != brand["id"] else []
    out["brand"] = brand["id"]
    default = brand.get("defaultTheme")
    if isinstance(default, str) and default and default != manifest.get("themeId"):
        changes.append(f"themeId {manifest.get('themeId')} -> {default}")
        out["themeId"] = default
    typography = brand.get("typography") if isinstance(brand.get("typography"), dict) else {}
    current = dict(manifest["typography"]) if isinstance(manifest.get("typography"), dict) else {}
    for slot in ("headline", "body"):
        ref = typography.get(slot)
        if isinstance(ref, str) and ref and current.get(slot) != ref:
            changes.append(f"typography.{slot} {current.get(slot) or 'theme'} -> {ref}")
            current[slot] = ref
    if current:
        out["typography"] = current
    return out, changes


def cleared(manifest: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    out = {k: v for k, v in manifest.items() if k != "brand"}
    return out, ([f"brand {manifest['brand']} -> none"] if "brand" in manifest else [])


def sync_guide(project: Project, brand: Optional[Dict[str, Any]]) -> Optional[str]:
    """Copy the brand's guidelines to BRAND.md (or remove it when clearing); returns what happened."""
    target = project.root / BRAND_GUIDE
    if brand is None:
        if target.exists():
            target.unlink()
            return f"removed {BRAND_GUIDE}"
        return None
    name = brand.get("guidelines") if isinstance(brand.get("guidelines"), str) else "guidelines.md"
    folder = brands_root(project) / brand["slug"]
    source = (folder / name).resolve()
    if folder.resolve() not in source.parents or not source.is_file():
        source = folder / "guidelines.md"
    if not source.is_file():
        if target.exists():
            target.unlink()
        return f"the brand has no guidelines; no {BRAND_GUIDE}"
    shutil.copyfile(source, target)
    return f"wrote {BRAND_GUIDE}"


@contextlib.contextmanager
def guide_staged(project: Project, brand: Optional[Dict[str, Any]], write: bool = True) -> Iterator[Optional[str]]:
    """Sync BRAND.md before the manifest write validates (so it never reports it missing), restoring it if the write fails."""
    target = project.root / BRAND_GUIDE
    previous = target.read_bytes() if target.is_file() else None
    note = sync_guide(project, brand) if write else None
    try:
        yield note
    except BaseException:
        if write:
            if previous is None:
                target.unlink(missing_ok=True)
            else:
                target.write_bytes(previous)
        raise
