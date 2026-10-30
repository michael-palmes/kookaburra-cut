"""Build, check and apply Kookaburra Cut brand packs (stdlib only, Python 3.9+).

Usage: python3 -I brand.py <command> [args]   (run with --help for each command)
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
KB = HERE.parent.parent / "kookaburra-scene-authoring" / "scripts" / "kb.py"
TEMPLATE = HERE.parent / "reference" / "guidelines-template.md"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
COPY_EXTS = IMAGE_EXTS | {".svg"}
FONT_EXTS = {".ttf", ".otf"}
HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
STYLE_WEIGHTS = [
    (("thin", "hairline"), 100),
    (("extralight", "extra light", "ultralight", "ultra light"), 200),
    (("semibold", "semi bold", "demibold", "demi bold"), 600),
    (("extrabold", "extra bold", "ultrabold", "ultra bold"), 800),
    (("light",), 300),
    (("medium",), 500),
    (("heavy", "black"), 900),
    (("bold",), 700),
]


class BrandError(Exception):
    pass


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:64].rstrip("-")


def workspace_root(arg: Optional[str]) -> Path:
    if arg:
        return Path(arg).expanduser()
    env = os.environ.get("KOOKABURRA_WORKSPACE_ROOT")
    if env:
        return Path(env).expanduser()
    if (Path.cwd() / "project.json").is_file():
        return Path.cwd().parent
    return Path.home() / "Kookaburra Cut"


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise BrandError(f"missing {path}")
    except json.JSONDecodeError as e:
        raise BrandError(f"{path} is not valid JSON: {e}")


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def brand_dir(root: Path, slug: str) -> Path:
    if not SLUG.match(slug):
        raise BrandError(f"brand slug must be lowercase kebab-case: {slug!r}")
    return root / "brands" / slug


def font_info(path: Path) -> Dict[str, Any]:
    """Family, style, PostScript name, OS/2 embedding and italic flag straight from the sfnt tables."""
    data = path.read_bytes()
    if data[:4] == b"ttcf":
        raise BrandError(f"{path.name}: font collections are not supported, export single faces")
    count = struct.unpack(">H", data[4:6])[0]
    tables = {}
    for i in range(count):
        tag, _, off, length = struct.unpack(">4sLLL", data[12 + 16 * i:28 + 16 * i])
        tables[tag.decode("latin-1")] = (off, length)
    if "name" not in tables or "OS/2" not in tables:
        raise BrandError(f"{path.name}: no name or OS/2 table")
    off = tables["name"][0]
    _, n, string_off = struct.unpack(">HHH", data[off:off + 6])
    names: Dict[int, str] = {}
    for i in range(n):
        pid, _eid, _lid, nid, length, o = struct.unpack(">HHHHHH", data[off + 6 + 12 * i:off + 18 + 12 * i])
        raw = data[off + string_off + o:off + string_off + o + length]
        text = raw.decode("utf-16-be", "replace") if pid in (0, 3) else raw.decode("latin-1")
        if nid not in names or pid == 3:
            names[nid] = text
    os2 = tables["OS/2"][0]
    fs_type = struct.unpack(">H", data[os2 + 8:os2 + 10])[0]
    fs_selection = struct.unpack(">H", data[os2 + 62:os2 + 64])[0]
    style = names.get(17) or names.get(2) or "Regular"
    lowered = style.lower()
    weight = next((w for keys, w in STYLE_WEIGHTS if any(k in lowered for k in keys)), 400)
    return {
        "file": path.name,
        "family": names.get(16) or names.get(1) or path.stem,
        "style": style,
        "postscript": names.get(6) or path.stem,
        "weight": weight,
        "italic": bool(fs_selection & 1) or "italic" in lowered or "oblique" in lowered,
        "restricted": bool(fs_type & 0x0002),
        "variable": "fvar" in tables,
    }


def iter_files(src: Path, exts: set) -> List[Path]:
    """A brand folder is untrusted: a link inside it could point anywhere, so links are never followed."""
    if src.is_file():
        return [src] if src.suffix.lower() in exts else []
    found: List[Path] = []
    for dirpath, dirnames, filenames in os.walk(src, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and not (Path(dirpath) / d).is_symlink())
        for name in filenames:
            path = Path(dirpath) / name
            if not name.startswith(".") and path.suffix.lower() in exts and not path.is_symlink() and path.is_file():
                found.append(path)
    return sorted(found)


def kit() -> Tuple[Any, Any, Any, Any]:
    """The checks kb assets add runs on an import (kblib, beside this skill), so a brand can't take in what a project wouldn't."""
    if not KB.is_file():
        raise BrandError(f"no kookaburra-scene-authoring kit beside this skill ({KB}); open the project in the app once")
    sys.dont_write_bytecode = True
    if str(KB.parent) not in sys.path:
        sys.path.append(str(KB.parent))
    from kblib import brandlib, imagefile, reach, svgsafe

    return brandlib, imagefile, reach, svgsafe


# ── commands ───────────────────────────────────────────────────────────────


def cmd_list(args: argparse.Namespace) -> int:
    root = workspace_root(args.root)
    brands = sorted((root / "brands").glob("*/brand.json")) if (root / "brands").is_dir() else []
    if not brands:
        print(f"No brands under {root / 'brands'}")
    for path in brands:
        doc = load_json(path)
        images = len(iter_files(path.parent / "images", IMAGE_EXTS)) if (path.parent / "images").is_dir() else 0
        print(f"ws:{path.parent.name}  {doc.get('name', '?')}  theme {doc.get('defaultTheme', '-')}  {len(doc.get('colors', []))} colours  {images} images")
    return 0


def cmd_scan(args: argparse.Namespace) -> int:
    src = Path(args.source).expanduser()
    if not src.is_dir():
        raise BrandError(f"not a folder: {src}")
    print(f"Source {src}")
    for top in sorted(p for p in src.iterdir() if p.is_dir()):
        counts: Dict[str, int] = {}
        size = 0
        for f in top.rglob("*"):
            if f.is_file() and not f.name.startswith("."):
                ext = f.suffix.lower() or "(none)"
                counts[ext] = counts.get(ext, 0) + 1
                size += f.stat().st_size
        subs = sorted(p.name for p in top.iterdir() if p.is_dir())
        summary = ", ".join(f"{n} {e}" for e, n in sorted(counts.items()))
        print(f"  {top.name}/  {size / 1e6:.1f} MB  {summary}" + (f"  subfolders: {', '.join(subs)}" if subs else ""))
    pdfs = [p for p in src.rglob("*.pdf")] + [p for p in src.parent.glob("*.pdf")]
    for pdf in sorted(set(pdfs)):
        print(f"  guidelines candidate: {pdf}")
    fonts = iter_files(src, FONT_EXTS)
    if fonts:
        print("Fonts:")
    for f in fonts:
        try:
            i = font_info(f)
        except BrandError as e:
            print(f"  {f.relative_to(src)}: {e}")
            continue
        flags = [k for k in ("italic", "variable", "restricted") if i[k]]
        print(f"  {i['family']}@{i['weight']} ({i['style']}) {f.relative_to(src)}" + (f"  [{', '.join(flags)}]" if flags else ""))
    return 0


def cmd_init(args: argparse.Namespace) -> int:
    root = workspace_root(args.root)
    out = brand_dir(root, args.slug)
    if (out / "brand.json").exists() and not args.force:
        raise BrandError(f"{out / 'brand.json'} exists (use --force to reset it)")
    (out / "images").mkdir(parents=True, exist_ok=True)
    write_json(out / "brand.json", {
        "version": 1,
        "name": args.name,
        "description": "",
        "guidelines": "guidelines.md",
        "themes": [],
        "defaultTheme": "",
        "typography": {},
        "fonts": [],
        "colors": [],
        "gradients": [],
    })
    guide = out / "guidelines.md"
    if not guide.exists() and TEMPLATE.is_file():
        guide.write_text(TEMPLATE.read_text(encoding="utf-8").replace("{{name}}", args.name), encoding="utf-8")
    print(f"Created {out} (id ws:{args.slug})")
    return 0


def cmd_fonts(args: argparse.Namespace) -> int:
    root = workspace_root(args.root)
    out = brand_dir(root, args.slug)
    brand = load_json(out / "brand.json")
    fonts_dir = root / "fonts"
    fonts_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = fonts_dir / "fonts.json"
    manifest = load_json(manifest_path) if manifest_path.exists() else {"version": 1, "fonts": []}
    have = {(f["family"], f["weight"]) for f in manifest["fonts"]}
    listed = {(f["family"], f["weight"]) for f in brand.get("fonts", [])}
    for src in args.files:
        for path in iter_files(Path(src).expanduser(), FONT_EXTS):
            info = font_info(path)
            key = (info["family"], info["weight"])
            if info["italic"]:
                print(f"  skip {path.name}: italic (fonts are keyed by family and weight)")
                continue
            if info["variable"]:
                print(f"  skip {path.name}: variable font, install its static faces instead")
                continue
            note = "  (restricted embedding: exports work here, packs carry the name only)" if info["restricted"] else ""
            if key in have:
                print(f"  have {info['family']}@{info['weight']}{note}")
            else:
                shutil.copy2(path, fonts_dir / path.name)
                manifest["fonts"].append({"family": info["family"], "weight": info["weight"], "postscript": info["postscript"], "file": path.name, "path": ""})
                have.add(key)
                print(f"  installed {info['family']}@{info['weight']} ({path.name}){note}")
            listed.add(key)
    write_json(manifest_path, manifest)
    brand["fonts"] = [{"family": f, "weight": w} for f, w in sorted(listed)]
    write_json(out / "brand.json", brand)
    return 0


def split_tags(raw: Optional[str]) -> List[str]:
    return [tag for tag in (slugify(part) for part in (raw or "").split(",")) if tag]


def cmd_images(args: argparse.Namespace) -> int:
    brandlib, imagefile, reach, svgsafe = kit()
    root = workspace_root(args.root)
    home = brand_dir(root, args.slug)
    out = home / "images"
    edge = args.edge
    svg_jobs: List[Tuple[Path, Path]] = []
    copied = 0
    converted = 0
    refused: List[str] = []
    landed: List[Path] = []
    taken: set = set()
    extra = split_tags(args.tags)
    for mapping in args.mappings:
        if "=" not in mapping:
            raise BrandError(f"expected SOURCE=CATEGORY[/SUB], got {mapping!r}")
        src_text, dest_text = mapping.rsplit("=", 1)
        src = Path(src_text).expanduser()
        denied = reach.denied_reason(reach.resolve(str(src)))
        if denied:
            raise BrandError(f"{src} is not read: {denied}")
        dest_parts = [slugify(p) for p in dest_text.split("/") if p]
        if not dest_parts:
            raise BrandError(f"no category in {mapping!r}")
        base = out.joinpath(*dest_parts)
        if args.clean and base.exists():
            shutil.rmtree(base)
        for path in iter_files(src, COPY_EXTS):
            if reach.denied_reason(path):
                continue
            rel = path.parent.relative_to(src) if src.is_dir() else Path()
            parts = [slugify(p) for p in rel.parts if p.lower() != "svg"]
            target_dir = base.joinpath(*[p for p in parts if p])
            target_dir.mkdir(parents=True, exist_ok=True)
            ext = ".jpg" if path.suffix.lower() == ".jpeg" else path.suffix.lower()
            stem = slugify(path.stem) or "image"
            with tempfile.TemporaryDirectory(prefix="brand-image-") as tmp:
                try:
                    if ext == ".svg":
                        clean, dropped = svgsafe.sanitise(path.read_bytes(), path.name)
                        note = svgsafe.dropped_note(path.name, dropped)
                        if note:
                            print(f"  {note}")
                        target = _free_target(target_dir, stem, ext, taken)
                        target.write_bytes(clean)
                    else:
                        done = imagefile.prepare(path, Path(tmp))
                        if not args.allow_blank:
                            imagefile.refuse_blank(Path(done["path"]), done["facts"], path.name)
                        target = _free_target(target_dir, stem, f".{done['ext']}", taken)
                        shutil.copy2(done["path"], target)
                        converted += 1 if done["conformed"] else 0
                except imagefile.Refused as e:
                    refused.append(f"{path.name}: {e.message}")
                    continue
            copied += 1
            if ext == ".svg":
                if not path.with_suffix(".png").exists():
                    svg_jobs.append((target, target.with_suffix(".png")))
            else:
                landed.append(target)
    if svg_jobs:
        try:
            svgsafe.rasterise(svg_jobs, edge)
        except imagefile.Refused as e:
            raise BrandError(e.message)
    rastered = 0
    for svg, png in svg_jobs:
        if not png.is_file():
            refused.append(f"{svg.name}: did not rasterise; macOS could not draw it")
            continue
        try:
            if not args.allow_blank:
                imagefile.refuse_blank(png)
        except imagefile.Refused as e:
            png.unlink(missing_ok=True)
            refused.append(f"{svg.name}: {e.message}")
            continue
        rastered += 1
        landed.append(png)
    print(f"Copied {copied} files into {out}; rasterised {rastered} SVGs at {edge}px; converted {converted} for the stage")
    tags = {p.relative_to(out).as_posix(): extra for p in landed} if extra else {}
    problems = build_library(home, args.scene_edge, tags)
    for line in refused + problems:
        print(f"REFUSED {line}")
    return 1 if refused or problems else 0


def _free_target(folder: Path, stem: str, ext: str, taken: set) -> Path:
    target, n = folder / f"{stem}{ext}", 2
    while target in taken:
        target, n = folder / f"{stem}-{n}{ext}", n + 1
    taken.add(target)
    return target


def build_library(home: Path, scene_edge: Optional[int], new_tags: Optional[Dict[str, List[str]]] = None) -> List[str]:
    """library.json for every image the brand holds: what surface each suits, its light and dark partner, and a copy under
    scene/ when it is larger than a scene needs. A person's tags and the last --scene-edge survive a rebuild. Returns what couldn't be read."""
    brandlib, imagefile, _reach, _svgsafe = kit()
    library = brandlib.read_library(home)
    old = library["images"]
    scene_edge = scene_edge or library.get("sceneEdge") or brandlib.DEFAULT_SCENE_EDGE
    images: Dict[str, Dict[str, Any]] = {}
    problems: List[str] = []
    surfaces: Dict[str, Optional[str]] = {}
    keep_scene: set = set()
    scene_root = home / brandlib.SCENE
    if scene_root.is_symlink():
        raise BrandError(f"{scene_root} is a link, and kb writes and removes files in it; make it a real folder or remove it")
    brand_root = os.path.realpath(home) + os.sep
    for rel in brandlib.walk_images(home):
        path = home / brandlib.IMAGES / rel
        try:
            f = imagefile.facts(path)
            seen = imagefile.look(path, f)
        except imagefile.Refused as e:
            problems.append(f"{rel}: {e.message}")
            continue
        named = brandlib.surface_from_name(rel)
        record: Dict[str, Any] = {"width": f["width"], "height": f["height"]}
        tags = list(dict.fromkeys(list((old.get(rel) or {}).get("tags") or []) + list((new_tags or {}).get(rel) or [])))
        if tags:
            record["tags"] = tags
        surface = imagefile.surface_of(seen) or named
        if surface:
            record["surface"] = surface
        surfaces[rel] = surface
        if max(f["width"], f["height"]) > scene_edge:
            copy = scene_root / rel if f["format"] in ("png", "jpeg") else (scene_root / rel).with_suffix(".png")
            if not os.path.realpath(copy).startswith(brand_root):
                problems.append(f"{rel}: no copy for scenes: a link in {brandlib.SCENE}/ leads out of the brand")
                images[rel] = record
                continue
            try:
                fresh = copy.is_file() and copy.stat().st_mtime >= path.stat().st_mtime and max(_size(imagefile.facts(copy))) == scene_edge
                if not fresh:
                    copy.parent.mkdir(parents=True, exist_ok=True)
                    with tempfile.TemporaryDirectory(prefix="brand-scene-") as tmp:
                        shutil.copy2(imagefile.prepare(path, Path(tmp), max_edge=scene_edge)["path"], copy)
                record["scene"] = copy.relative_to(home).as_posix()
                keep_scene.add(copy)
            except imagefile.Refused as e:
                problems.append(f"{rel}: no copy for scenes: {e.message}")
        images[rel] = record
    for rel, other in brandlib.infer_pairs(surfaces).items():
        if rel in images:
            images[rel]["pair"] = other
    if scene_root.is_dir():
        for stale in [p for p in scene_root.rglob("*") if p.is_file() and p not in keep_scene]:
            stale.unlink()
    write_json(home / brandlib.LIBRARY, {"version": brandlib.VERSION, "sceneEdge": scene_edge, "images": dict(sorted(images.items()))})
    pairs = sum(1 for r in images.values() if r.get("pair")) // 2
    print(f"Library: {len(images)} images, light and dark pairs {pairs}, copies for scenes {len(keep_scene)} (past {scene_edge}px)")
    return problems


def _size(f: Dict[str, Any]) -> Tuple[int, int]:
    return f["width"], f["height"]


def cmd_library(args: argparse.Namespace) -> int:
    root = workspace_root(args.root)
    problems = build_library(brand_dir(root, args.slug), args.scene_edge)
    for line in problems:
        print(f"PROBLEM {line}")
    return 1 if problems else 0


def cmd_tag(args: argparse.Namespace) -> int:
    brandlib, _imagefile, _reach, _svgsafe = kit()
    home = brand_dir(workspace_root(args.root), args.slug)
    if not (home / brandlib.LIBRARY).is_file():
        raise BrandError(f"{args.slug} has no {brandlib.LIBRARY} yet; run brand.py library {args.slug} first")
    tags = split_tags(args.tags)
    if not tags:
        raise BrandError("give at least one tag, comma-separated")
    doc = load_json(home / brandlib.LIBRARY)
    images = doc.get("images") if isinstance(doc, dict) and isinstance(doc.get("images"), dict) else {}
    hits = [rel for rel, record in images.items() if isinstance(record, dict) and fnmatch.fnmatchcase(rel, args.pattern)]
    if not hits:
        raise BrandError(f"no image in the library matches {args.pattern!r} (paths are relative to images/)")
    for rel in hits:
        record = images[rel]
        have = [t for t in (record.get("tags") or []) if isinstance(t, str)]
        record["tags"] = [t for t in have if t not in tags] if args.remove else list(dict.fromkeys(have + tags))
        if not record["tags"]:
            del record["tags"]
    write_json(home / brandlib.LIBRARY, doc)
    print(f"{'Untagged' if args.remove else 'Tagged'} {len(hits)} image(s): {', '.join(tags)}")
    return 0


def cmd_gradient(args: argparse.Namespace) -> int:
    root = workspace_root(args.root)
    out = brand_dir(root, args.slug)
    brand = load_json(out / "brand.json")
    stops = []
    for stop in args.stops.split(","):
        colour, _, pos = stop.strip().partition("@")
        if not HEX.match(colour):
            raise BrandError(f"bad stop colour {colour!r} (use #RRGGBB@position)")
        stops.append([colour.upper(), float(pos or (0 if not stops else 1))])
    if len(stops) < 2:
        raise BrandError("a gradient needs at least two stops")
    gslug = slugify(args.gradient)
    write_json(root / "gradients" / f"{gslug}.json", {
        "version": 1,
        "name": args.name or args.gradient,
        "spec": {"type": args.type, "angleDeg": args.angle, "space": "oklch", "stops": stops},
    })
    if gslug not in brand.setdefault("gradients", []):
        brand["gradients"].append(gslug)
    write_json(out / "brand.json", brand)
    print(f"Wrote gradients/{gslug}.json and listed it in the brand")
    return 0


def bundled_families() -> set:
    catalog = HERE.parent.parent / "kookaburra-scene-authoring" / "catalog.json"
    try:
        return {e["id"] for e in json.loads(catalog.read_text(encoding="utf-8"))["fonts"]["bundled"]}
    except (OSError, ValueError, KeyError, TypeError):
        return set()


def check_brand(root: Path, slug: str) -> Tuple[List[str], List[str]]:
    out = brand_dir(root, slug)
    problems: List[str] = []
    notes: List[str] = []
    brand = load_json(out / "brand.json")
    if brand.get("version") != 1:
        problems.append("version must be 1")
    if not isinstance(brand.get("name"), str) or not brand["name"].strip():
        problems.append("name is required")
    themes = brand.get("themes", [])
    for theme in themes:
        if theme.startswith("ws:") and not (root / "themes" / theme[3:] / "theme.json").is_file():
            problems.append(f"theme {theme} is not in {root / 'themes'}")
    default = brand.get("defaultTheme")
    if default and default not in themes:
        problems.append(f"defaultTheme {default} is not in themes")
    pinned = set()
    manifest_path = root / "fonts" / "fonts.json"
    if manifest_path.is_file():
        pinned = {(f["family"], f["weight"]) for f in load_json(manifest_path).get("fonts", [])}
    bundled = bundled_families()
    for f in brand.get("fonts", []):
        if (f.get("family"), f.get("weight")) not in pinned and f.get("family") not in bundled:
            problems.append(f"font {f.get('family')}@{f.get('weight')} is not installed (brand.py fonts)")
    for slot, ref in (brand.get("typography") or {}).items():
        family, _, weight = str(ref).partition("@")
        if (family, int(weight or 400)) not in pinned and family not in bundled:
            problems.append(f"typography.{slot} {ref} is not installed or bundled")
    for i, colour in enumerate(brand.get("colors", [])):
        if not HEX.match(str(colour.get("hex", ""))) or not colour.get("name"):
            problems.append(f"colors[{i}] needs a name and a #RRGGBB hex")
    for g in brand.get("gradients", []):
        path = root / "gradients" / f"{g}.json"
        if not path.is_file():
            problems.append(f"gradient {g} is not in {root / 'gradients'}")
            continue
        spec = load_json(path).get("spec", {})
        if spec.get("type") not in ("linear", "radial") or len(spec.get("stops", [])) < 2:
            problems.append(f"gradient {g} needs a linear or radial spec with two or more stops")
    guide = out / brand.get("guidelines", "guidelines.md")
    text = guide.read_text(encoding="utf-8") if guide.is_file() else ""
    if not text.strip():
        problems.append(f"{guide.name} is missing or empty")
    elif "not hard rules" not in text and "not rules" not in text:
        problems.append(f"{guide.name} must say near the top that it is guidance, not hard rules")
    if "{{" in text:
        problems.append(f"{guide.name} still has template placeholders")
    images = out / "images"
    if images.is_dir():
        counts: Dict[str, int] = {}
        for p in iter_files(images, IMAGE_EXTS):
            category = p.relative_to(images).parts[0] if len(p.relative_to(images).parts) > 1 else "(loose)"
            counts[category] = counts.get(category, 0) + 1
        orphans = [p for p in iter_files(images, {".svg"}) if not p.with_suffix(".png").exists()]
        notes.append("images: " + (", ".join(f"{c} {n}" for c, n in sorted(counts.items())) or "none"))
        if "(loose)" in counts:
            problems.append("images must sit in a category folder (images/<category>/...)")
        if orphans:
            problems.append(f"{len(orphans)} SVGs have no PNG beside them (the Library lists png/jpg/webp only)")
        brandlib, _imagefile, _reach, _svgsafe = kit()
        if (out / brandlib.LIBRARY).is_file():
            load_json(out / brandlib.LIBRARY)
            indexed = brandlib.read_library(out)["images"]
            listed = set(brandlib.walk_images(out))
            gone = sorted(set(indexed) - listed)
            if gone:
                problems.append(f"{brandlib.LIBRARY} lists {len(gone)} images that are gone, like {gone[0]} (brand.py library {slug})")
            missing_scene = sorted(rel for rel, r in indexed.items() if r.get("scene") and not (out / str(r["scene"])).is_file())
            if missing_scene:
                problems.append(f"{len(missing_scene)} copies for scenes are missing, like {missing_scene[0]} (brand.py library {slug})")
            notes.append(f"library: {len(indexed)} of {len(listed)} images indexed")
            if len(indexed) < len(listed):
                notes.append(f"run brand.py library {slug} to index the rest")
        elif counts:
            notes.append(f"no {brandlib.LIBRARY} yet: brand.py library {slug} adds tags, pairs and copies for scenes")
    else:
        notes.append("images: none")
    return problems, notes


def cmd_check(args: argparse.Namespace) -> int:
    problems, notes = check_brand(workspace_root(args.root), args.slug)
    for n in notes:
        print(n)
    for p in problems:
        print(f"PROBLEM {p}")
    print("OK" if not problems else f"{len(problems)} problem(s)")
    return 1 if problems else 0


def cmd_apply(args: argparse.Namespace) -> int:
    """The project's own kb applies it (`kb brand use`), the one terminal path that mirrors the Project picker."""
    if not KB.is_file():
        raise BrandError(f"no kookaburra-scene-authoring kit beside this skill ({KB}); open the project in the app once")
    if args.slug != "none":
        brand_dir(Path("."), args.slug)
    op = ["brand", "clear"] if args.slug == "none" else ["brand", "use", f"ws:{args.slug}"]
    return subprocess.run([sys.executable, "-I", str(KB), "-C", str(Path(args.project).expanduser()), *op]).returncode


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="brand.py", description="Kookaburra Cut brand packs")
    parser.add_argument("--root", help="workspace root (default: the project's parent, else ~/Kookaburra Cut)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="brands in this workspace").set_defaults(func=cmd_list)
    p = sub.add_parser("scan", help="inventory a source brand folder: folders, file types, fonts, PDFs")
    p.add_argument("source")
    p.set_defaults(func=cmd_scan)
    p = sub.add_parser("init", help="create brands/<slug>/ with brand.json and a guidelines template")
    p.add_argument("slug")
    p.add_argument("--name", required=True)
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_init)
    p = sub.add_parser("fonts", help="install upright static faces into the workspace and list them in the brand")
    p.add_argument("slug")
    p.add_argument("files", nargs="+", help="font files or folders")
    p.set_defaults(func=cmd_fonts)
    p = sub.add_parser("images", help="copy images as SOURCE=CATEGORY[/SUB], checked as kb assets add checks them; SVGs also become PNGs; updates library.json")
    p.add_argument("slug")
    p.add_argument("mappings", nargs="+")
    p.add_argument("--edge", type=int, default=512, help="long edge in px for rasterised SVGs")
    p.add_argument("--clean", action="store_true", help="empty each target folder first")
    p.add_argument("--tags", help="comma-separated tags for everything this call brings in")
    p.add_argument("--scene-edge", type=int, help="images longer than this get a copy at this size under scene/ (default: the library's, else 2048)")
    p.add_argument("--allow-blank", action="store_true", help="take fully transparent or one-colour images")
    p.set_defaults(func=cmd_images)
    p = sub.add_parser("library", help="rebuild library.json: surfaces, light and dark pairs and copies for scenes; tags are kept")
    p.add_argument("slug")
    p.add_argument("--scene-edge", type=int, help="images longer than this get a copy at this size under scene/ (default: the library's, else 2048)")
    p.set_defaults(func=cmd_library)
    p = sub.add_parser("tag", help="add tags to the images whose path (relative to images/) matches a pattern, or --remove them")
    p.add_argument("slug")
    p.add_argument("pattern", help="a path or glob like icons/*wallet*")
    p.add_argument("tags", help="comma-separated tags")
    p.add_argument("--remove", action="store_true")
    p.set_defaults(func=cmd_tag)
    p = sub.add_parser("gradient", help="write a workspace gradient and list it in the brand")
    p.add_argument("slug")
    p.add_argument("gradient", help="gradient slug, e.g. acme-ink-glow")
    p.add_argument("--stops", required=True, help="#RRGGBB@0,#RRGGBB@0.5,#RRGGBB@1")
    p.add_argument("--angle", type=float, default=180, help="degrees; 180 starts at the top, 135 at the top left")
    p.add_argument("--type", choices=["linear", "radial"], default="linear")
    p.add_argument("--name")
    p.set_defaults(func=cmd_gradient)
    p = sub.add_parser("check", help="validate a brand: themes, fonts, gradients, colours, guidelines, images")
    p.add_argument("slug")
    p.set_defaults(func=cmd_check)
    p = sub.add_parser("apply", help="apply a brand to a project folder through its kb (what the Project picker does), or 'none'")
    p.add_argument("project")
    p.add_argument("slug")
    p.set_defaults(func=cmd_apply)
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except BrandError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
