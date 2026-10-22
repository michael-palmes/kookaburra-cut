"""Build, check and apply Kookaburra Cut brand packs (stdlib only, Python 3.9+).

Usage: python3 -I brand.py <command> [args]   (run with --help for each command)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
SVG2PNG = HERE / "svg2png.js"
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
    if src.is_file():
        return [src] if src.suffix.lower() in exts else []
    return sorted(p for p in src.rglob("*") if p.is_file() and p.suffix.lower() in exts)


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


def cmd_images(args: argparse.Namespace) -> int:
    root = workspace_root(args.root)
    out = brand_dir(root, args.slug) / "images"
    svg_jobs: List[str] = []
    copied = 0
    for mapping in args.mappings:
        if "=" not in mapping:
            raise BrandError(f"expected SOURCE=CATEGORY[/SUB], got {mapping!r}")
        src_text, dest_text = mapping.rsplit("=", 1)
        src = Path(src_text).expanduser()
        dest_parts = [slugify(p) for p in dest_text.split("/") if p]
        if not dest_parts:
            raise BrandError(f"no category in {mapping!r}")
        base = out.joinpath(*dest_parts)
        if args.clean and base.exists():
            shutil.rmtree(base)
        for path in iter_files(src, COPY_EXTS):
            rel = path.parent.relative_to(src) if src.is_dir() else Path()
            parts = [slugify(p) for p in rel.parts if p.lower() != "svg"]
            target_dir = base.joinpath(*[p for p in parts if p])
            target_dir.mkdir(parents=True, exist_ok=True)
            ext = ".jpg" if path.suffix.lower() == ".jpeg" else path.suffix.lower()
            target = target_dir / f"{slugify(path.stem) or 'image'}{ext}"
            shutil.copy2(path, target)
            copied += 1
            if ext == ".svg" and not path.with_suffix(".png").exists():
                svg_jobs += [str(target), str(target.with_suffix(".png"))]
    for i in range(0, len(svg_jobs), 80):
        subprocess.run(["osascript", "-l", "JavaScript", str(SVG2PNG), str(args.edge), *svg_jobs[i:i + 80]], check=True)
    print(f"Copied {copied} files into {out}; rasterised {len(svg_jobs) // 2} SVGs at {args.edge}px")
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
    project = Path(args.project).expanduser().resolve()
    manifest_path = project / "project.json"
    manifest = load_json(manifest_path)
    root = workspace_root(args.root) if args.root else project.parent
    if args.slug == "none":
        manifest.pop("brand", None)
        (project / "BRAND.md").unlink(missing_ok=True)
        write_json(manifest_path, manifest)
        print(f"Cleared the brand from {project.name}")
        return 0
    out = brand_dir(root, args.slug)
    brand = load_json(out / "brand.json")
    manifest["brand"] = f"ws:{args.slug}"
    if brand.get("defaultTheme"):
        manifest["themeId"] = brand["defaultTheme"]
    typography = brand.get("typography") or {}
    if typography.get("headline") or typography.get("body"):
        current = manifest.get("typography") if isinstance(manifest.get("typography"), dict) else {}
        current.update({k: v for k, v in typography.items() if k in ("headline", "body") and v})
        manifest["typography"] = current
    guide = out / brand.get("guidelines", "guidelines.md")
    if guide.is_file():
        shutil.copyfile(guide, project / "BRAND.md")
    write_json(manifest_path, manifest)
    print(f"Applied {brand.get('name')} to {project.name}: theme {manifest['themeId']}, BRAND.md written")
    return 0


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
    p = sub.add_parser("images", help="copy images as SOURCE=CATEGORY[/SUB]; SVGs also become PNGs")
    p.add_argument("slug")
    p.add_argument("mappings", nargs="+")
    p.add_argument("--edge", type=int, default=512, help="long edge in px for rasterised SVGs")
    p.add_argument("--clean", action="store_true", help="empty each target folder first")
    p.set_defaults(func=cmd_images)
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
    p = sub.add_parser("apply", help="apply a brand to a project folder (what the Project picker does), or 'none'")
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
