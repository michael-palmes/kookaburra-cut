"""Workspace brands (brands/<slug>/brand.json): listing, matching a user's words to one, and what applying it changes."""

from __future__ import annotations

import contextlib
import json
import re
import shutil
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from . import brandlib
from .project import BRAND_GUIDE, Project
from .util import EXIT_OK, KbError, emit

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
MIN_CELL = 32
MAX_CELL = 512


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


def cmd_icons(ctx: Any) -> int:
    """kb brand icons: find a picture in the brand's library by name or tag, and look at the results on a contact sheet."""
    a = ctx.args
    project = ctx.project
    manifest = project.manifest()
    current = manifest.get("brand") if isinstance(manifest.get("brand"), str) else None
    if not a.brand and not current:
        raise KbError("this project has no brand; kb brand list shows the installed ones", 2, kind="usage", hint="./kb brand use NAME, or pass --brand NAME")
    if a.limit is not None and a.limit < 1:
        raise KbError("--limit is at least 1", 2, kind="usage")
    if not MIN_CELL <= a.cell <= MAX_CELL:
        raise KbError(f"--cell is {MIN_CELL} to {MAX_CELL} px", 2, kind="usage")
    brand = match(project, a.brand or current)
    folder = brands_root(project) / brand["slug"]
    scoped = brandlib.scope(brandlib.entries(folder), a.category, a.all)
    items = brandlib.search(scoped, a.search)
    shown = items[:a.limit] if a.limit else items
    payload: Dict[str, Any] = {"brand": brand["id"], "search": a.search, "total": len(items), "items": shown}
    if a.sheet and shown:
        from . import contact

        cells = [{"label": f"{n} {row['name']}", "image": Path(row["path"]), "surface": row.get("surface")} for n, row in enumerate(shown, 1)]
        out = contact.new_folder(project, f"{brand['slug']}-{a.search or 'icons'}")
        sheets, fitted = contact.write_sheets(cells, out, (a.cell, a.cell))
        payload.update(sheets=[str(s) for s in sheets], shownOnSheets=fitted)
    if ctx.json:
        ctx.out(payload)
        return EXIT_OK
    if not items:
        emit(f"nothing in {brand['name']}'s library matches{' ' + repr(a.search) if a.search else ''}" + ("" if a.all else "; --all looks past the icon folders"))
        return EXIT_OK
    for n, row in enumerate(shown, 1):
        parts = [row["rel"]] + ([f"{row['width']}x{row['height']}"] if row.get("width") else [])
        parts += [f"[{row['surface']}]"] if row.get("surface") else []
        parts += [f"pair: {row['pair']}"] if row.get("pair") else []
        parts += [f"tags: {', '.join(row['tags'])}"] if row["tags"] else []
        emit(f"{n:>3}  " + "  ".join(parts))
    if len(shown) < len(items):
        emit(f"{len(items) - len(shown)} more past --limit {a.limit}")
    for sheet in payload.get("sheets") or []:
        emit(f"sheet to Read: {sheet}")
    if a.sheet and len(shown) > payload.get("shownOnSheets", len(shown)):
        emit(f"the sheets show the first {payload['shownOnSheets']}; narrow it with --search")
    first = shown[0]["path"]
    emit(f'bring one in: ./kb assets add "{first}"')
    return EXIT_OK


def register_icons(bsub: Any, common: Any, Formatter: Any) -> None:
    y = bsub.add_parser("icons", help="find pictures in the brand's library by name or tag, and write a contact sheet to look at", parents=[common], formatter_class=Formatter,
                        epilog="  ./kb brand icons --search wallet --sheet\n"
                        "Searches the name, tags and path; every word must match. Without --all or --category it looks in\n"
                        "the icon-like folders (icons, glyphs, pictograms, symbols), or everywhere when the brand has none.\n"
                        "Each cell sits on the surface the picture is made for. Paths are the size-limited copy for scenes\n"
                        "when the brand has one.")
    y.add_argument("--search", metavar="TERM", help="words to find in the name, tags and path")
    y.add_argument("--sheet", action="store_true", help="write contact sheets to .kb/thumbs/ and print their paths to Read")
    y.add_argument("--brand", metavar="NAME", help="another installed brand (default: this project's)")
    y.add_argument("--category", metavar="C", help="only this folder of the library")
    y.add_argument("--all", action="store_true", help="every image, not just the icon folders")
    y.add_argument("--limit", type=int, metavar="N", help="at most N results")
    y.add_argument("--cell", type=int, default=120, metavar="PX", help="contact sheet cell size (default 120)")
    y.set_defaults(fn=cmd_icons)
