"""A brand's image library: brands/<slug>/library.json, built by brand.py and read by kb brand icons.

{ version, sceneEdge, images: { rel: { tags, surface, pair, width, height, scene } } }. rel is relative to images/. A brand
travels in packs, so the file is untrusted: entries are read leniently and every path must stay inside the brand's own
images/ or scene/. A brand with no library still lists and searches, by what its names and folders say.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

LIBRARY = "library.json"
IMAGES = "images"
SCENE = "scene"
VERSION = 1
DEFAULT_SCENE_EDGE = 2048
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
ICON_CATEGORY = re.compile(r"^(icon|glyph|pictogram|symbol)", re.IGNORECASE)
CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
TOKEN = re.compile(r"[^\w]+|_+", re.UNICODE)
ON_DARK_WORDS = {"white", "reversed", "reverse", "negative", "knockout", "inverse", "inverted"}
ON_LIGHT_WORDS = {"black", "positive"}
VARIANT_WORDS = ON_DARK_WORDS | ON_LIGHT_WORDS | {"dark", "light", "on", "for", "bg", "background"}
MAX_TAGS = 32
MAX_TAG_CHARS = 48
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def tokens(text: str) -> List[str]:
    return [t for t in TOKEN.split(CAMEL.sub(" ", text).lower()) if t]


def surface_from_name(rel: str) -> Optional[str]:
    """What a name says outright. "dark" alone says nothing: a dark logo and a logo for dark backgrounds both get called that."""
    words = tokens(rel.rsplit(".", 1)[0])
    pairs = set(zip(words, words[1:]))
    if ("on", "dark") in pairs or ("for", "dark") in pairs or ("dark", "bg") in pairs or ("dark", "background") in pairs:
        return "on-dark"
    if ("on", "light") in pairs or ("for", "light") in pairs or ("light", "bg") in pairs or ("light", "background") in pairs:
        return "on-light"
    if ON_DARK_WORDS & set(words):
        return "on-dark"
    if ON_LIGHT_WORDS & set(words):
        return "on-light"
    return None


def safe_rel(rel: Any) -> bool:
    return isinstance(rel, str) and bool(rel) and "\\" not in rel and not rel.startswith("/") and all(p not in ("", ".", "..") and not p.startswith(".") for p in rel.split("/"))


def read_library(folder: Path) -> Dict[str, Any]:
    """The library as far as it can be trusted: bad entries are dropped, never fatal; { version, sceneEdge, images }."""
    try:
        doc = json.loads((folder / LIBRARY).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": VERSION, "images": {}}
    images: Dict[str, Dict[str, Any]] = {}
    raw = doc.get("images") if isinstance(doc, dict) else None
    for rel, record in (raw.items() if isinstance(raw, dict) else []):
        if not safe_rel(rel) or not isinstance(record, dict):
            continue
        clean: Dict[str, Any] = {}
        tags = record.get("tags")
        if isinstance(tags, list):
            clean["tags"] = [t[:MAX_TAG_CHARS] for t in tags if isinstance(t, str) and t.strip()][:MAX_TAGS]
        if record.get("surface") in ("on-light", "on-dark"):
            clean["surface"] = record["surface"]
        if safe_rel(record.get("pair")):
            clean["pair"] = record["pair"]
        scene = record.get("scene")
        if safe_rel(scene) and str(scene).startswith(f"{SCENE}/"):
            clean["scene"] = scene
        for key in ("width", "height"):
            if isinstance(record.get(key), int) and not isinstance(record.get(key), bool) and record[key] > 0:
                clean[key] = record[key]
        images[rel] = clean
    edge = doc.get("sceneEdge") if isinstance(doc, dict) else None
    return {"version": VERSION, "sceneEdge": edge if isinstance(edge, int) and not isinstance(edge, bool) else DEFAULT_SCENE_EDGE, "images": images}


def walk_images(folder: Path) -> List[str]:
    """Every listable image under images/, by the rules brands.rs walk_images keeps: no hidden names, no links."""
    base = folder / IMAGES
    found: List[str] = []
    stack = [base]
    while stack:
        current = stack.pop()
        try:
            listing = list(os.scandir(current))
        except OSError:
            continue
        for entry in listing:
            if entry.name.startswith(".") or entry.is_symlink():
                continue
            if entry.is_dir(follow_symlinks=False):
                stack.append(Path(entry.path))
            elif entry.is_file(follow_symlinks=False) and Path(entry.name).suffix.lower() in IMAGE_EXTS:
                found.append(Path(entry.path).relative_to(base).as_posix())
    return sorted(found)


def _pair_key(rel: str) -> Tuple[Tuple[str, ...], ...]:
    parts = rel.rsplit(".", 1)[0].split("/")
    kept = (tuple(t for t in tokens(p) if t not in VARIANT_WORDS) for p in parts[:-1])
    return tuple(k for k in kept if k) + (tuple(t for t in tokens(parts[-1]) if t not in VARIANT_WORDS),)


def infer_pairs(surfaces: Dict[str, Optional[str]]) -> Dict[str, str]:
    """rel to rel: the same picture for a light and for a dark background, told apart only by words like white or on-dark."""
    groups: Dict[Tuple[Tuple[str, ...], ...], List[str]] = {}
    for rel in sorted(surfaces):
        groups.setdefault(_pair_key(rel), []).append(rel)
    pairs: Dict[str, str] = {}
    for rels in groups.values():
        lights = [r for r in rels if surfaces[r] == "on-light"]
        darks = [r for r in rels if surfaces[r] == "on-dark"]
        for a, b in zip(lights, darks):
            pairs[a], pairs[b] = b, a
    return pairs


def category_of(rel: str) -> str:
    parts = rel.split("/")
    return parts[0] if len(parts) > 1 else ""


def _scene_copy(folder: Path, scene: Any) -> Optional[Path]:
    """The record's copy, only if it is really a file inside the brand folder: a link never takes a project elsewhere."""
    if not isinstance(scene, str):
        return None
    copy = folder / scene
    if copy.is_symlink() or not copy.is_file():
        return None
    root = os.path.realpath(folder)
    return copy if os.path.realpath(copy).startswith(root + os.sep) else None


def entries(folder: Path) -> List[Dict[str, Any]]:
    """Every image with what is known about it: the library's record where there is one, its name's where not."""
    lib = read_library(folder)["images"]
    rels = walk_images(folder)
    present = set(rels)
    surfaces: Dict[str, Optional[str]] = {}
    for rel in rels:
        record = lib.get(rel) or {}
        surfaces[rel] = record.get("surface") or surface_from_name(rel)
    named_pairs = infer_pairs(surfaces)
    out: List[Dict[str, Any]] = []
    for rel in rels:
        record = lib.get(rel) or {}
        path = folder / IMAGES / rel
        ready = _scene_copy(folder, record.get("scene")) or path
        pair = record.get("pair") if record.get("pair") in present else named_pairs.get(rel)
        out.append({
            "rel": rel,
            "category": category_of(rel),
            "name": Path(rel).stem,
            "tags": list(record.get("tags") or []),
            "surface": surfaces[rel],
            "pair": pair,
            "width": record.get("width"),
            "height": record.get("height"),
            "path": str(ready),
            "original": str(path),
        })
    return out


def is_icon_category(category: str) -> bool:
    return bool(ICON_CATEGORY.match(category))


def scope(items: Iterable[Dict[str, Any]], category: Optional[str], everything: bool) -> List[Dict[str, Any]]:
    """--category, --all, or the icon-like folders; a brand with none of those shows everything rather than nothing."""
    rows = list(items)
    if category:
        wanted = "-".join(tokens(category))
        return [r for r in rows if "-".join(tokens(r["category"])) == wanted]
    if everything:
        return rows
    icons = [r for r in rows if is_icon_category(r["category"])]
    return icons or rows


def _score(item: Dict[str, Any], words: List[str], phrase: str) -> float:
    name = tokens(item["name"])
    tags = [w for tag in item["tags"] for w in tokens(tag)]
    path = tokens(item["rel"])
    if "-".join(name) == phrase:
        return float("inf")
    total = 0.0
    for word in words:
        if word in name:
            total += 3.0
        elif any(w.startswith(word) for w in name):
            total += 2.0
        elif word in tags:
            total += 2.0
        elif any(word in w for w in name):
            total += 1.5
        elif any(w.startswith(word) for w in tags):
            total += 1.0
        elif any(word in w for w in path):
            total += 0.5
        else:
            return 0.0
    return total


def search(items: Iterable[Dict[str, Any]], term: Optional[str]) -> List[Dict[str, Any]]:
    """Every word must hit the name, a tag or the path; name matches first, then by path. No term keeps the order."""
    rows = list(items)
    words = tokens(term or "")
    if not words:
        return rows
    phrase = "-".join(words)
    scored = [(_score(r, words, phrase), r) for r in rows]
    return [r for s, r in sorted((x for x in scored if x[0] > 0), key=lambda x: (-x[0], x[1]["rel"]))]


def folder_of(workspace_root: Path, brand_id: Any) -> Optional[Path]:
    """A project's `brand` value as a folder in this workspace; project.json is untrusted, so never one that climbs out."""
    if not isinstance(brand_id, str) or not brand_id.startswith("ws:") or not SLUG.match(brand_id[3:]):
        return None
    return Path(workspace_root) / "brands" / brand_id[3:]


def counts_by_category(folder: Path) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for rel in walk_images(folder):
        category = category_of(rel) or "other"
        counts[category] = counts.get(category, 0) + 1
    return counts


def status_hint(folder: Path) -> Optional[str]:
    """The kb status line's clause when the brand has a library worth searching."""
    counts = counts_by_category(folder)
    if not counts:
        return None
    biggest = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:4]
    what = ", ".join(f"{n} {c}" for c, n in biggest)
    more = "" if len(counts) <= 4 else f" and {len(counts) - 4} more folders"
    return f"its library has {what}{more}: ./kb brand icons --search TERM --sheet finds one to look at"
