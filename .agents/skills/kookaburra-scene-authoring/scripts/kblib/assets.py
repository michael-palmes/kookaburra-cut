"""Project media: list with usage, copy in (never overwrite; a flagged video is conformed through the app, a still is checked and cleaned by kblib/imagefile.py), probe."""

from __future__ import annotations

import filecmp
import json
import os
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from . import lock as lockmod
from . import reach
from . import tsx as tsxmod
from .check import SUPPORTED_ASSET_EXTS
from .project import Project
from .scenes import collect_json_asset_refs, free_sibling_name
from .util import EXIT_ENV, EXIT_PROBLEMS, KbError, read_text

KINDS = {
    "image": {"png", "jpg", "jpeg", "webp", "gif"},
    "video": {"mp4", "mov", "m4v", "webm"},
    "audio": {"mp3", "wav", "m4a", "aac", "flac", "ogg"},
    "environment": {"hdr", "exr"},
    "data": {"csv", "tsv", "txt"},
    "lut": {"cube"},
    "model": {"glb", "gltf"},
}
META_REL = "assets/_meta.json"
TIMING_SUFFIX = ".timing.json"
ORIGINALS = "assets/.originals"
KNOWN_EXTS = SUPPORTED_ASSET_EXTS | {"svg", "tif", "tiff", "heic", "heif", "bmp", "avif", "jxl"}
MIN_MAX_SIZE = 16


def kind_of(name: str) -> str:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    for kind, exts in KINDS.items():
        if ext in exts:
            return kind
    return "other"


def ext_of(name: str) -> str:
    base = name.rsplit("/", 1)[-1]
    return base.rsplit(".", 1)[-1].lower() if "." in base else ""


def human_size(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{n} B"


def is_companion(rel: str) -> bool:
    """The provenance record and conform timing records sit in assets/ but are not media."""
    return rel == META_REL or rel.endswith(TIMING_SUFFIX)


def resolve(project: Project, ref: str, must_exist: bool = True) -> str:
    """ASSET as an assets/ path (a bare name means assets/<name>); exit 1 when it is not a file there."""
    text = ref.strip()
    if text.startswith("./"):
        text = text[2:]
    path = Path(text).expanduser()
    if path.is_absolute():
        try:
            text = path.resolve().relative_to(project.root.resolve()).as_posix()
        except ValueError:
            raise KbError(f"{ref} is outside this project; copy it in with ./kb assets add {ref}", EXIT_PROBLEMS, kind="invalid") from None
    rel = text if text.startswith("assets/") else f"assets/{text}"
    if not tsxmod.is_project_asset_ref(rel) or any(p.startswith(".") for p in rel.split("/")[1:]):
        raise KbError(f'"{ref}" is not a clean assets/ path', EXIT_ENV, kind="usage")
    if must_exist and not (project.root / rel).is_file():
        raise KbError(f"{rel} does not exist", EXIT_PROBLEMS, kind="invalid", hint="./kb assets list")
    return rel


def usage(project: Project) -> Dict[str, List[str]]:
    """assets/... path -> scene stems (and project.json) that reference it."""
    used: Dict[str, List[str]] = {}
    try:
        manifest = project.manifest()
    except KbError:
        manifest = {}
    for rel in collect_json_asset_refs(manifest):
        used.setdefault(rel, []).append("project.json")
    if project.scenes_dir.is_dir():
        for path in sorted(project.scenes_dir.iterdir()):
            try:
                text = read_text(path)
            except (OSError, UnicodeDecodeError):
                continue
            if path.suffix == ".tsx":
                refs = tsxmod.scan_asset_refs(text)
            elif path.suffix == ".json":
                try:
                    refs = collect_json_asset_refs(json.loads(text))
                except ValueError:
                    continue
            else:
                continue
            for rel in refs:
                if path.stem not in used.setdefault(rel, []):
                    used[rel].append(path.stem)
    edits = project.root / "edits"
    if edits.is_dir():
        for path in sorted(edits.glob("*.json")):
            if path.name.startswith(("_", ".")):
                continue
            try:
                doc = json.loads(read_text(path))
            except (OSError, ValueError, UnicodeDecodeError):
                continue
            sources = doc.get("sources") if isinstance(doc, dict) else None
            for s in sources if isinstance(sources, list) else []:
                rel = s.get("rel") if isinstance(s, dict) else None
                label = f"edits/{path.name}"
                if isinstance(rel, str) and label not in used.setdefault(rel, []):
                    used[rel].append(label)
    return used


def timing_rel_of(rel: str) -> str:
    """conform.rs timing_rel_of: assets/<dir>/<stem>.timing.json beside rel."""
    folder, _, name = rel.rpartition("/")
    stem = name.rsplit(".", 1)[0] if "." in name.lstrip(".") else name
    return f"{folder}/{stem}{TIMING_SUFFIX}"


def timing_record(project: Project, rel: str) -> Optional[Dict[str, Any]]:
    """rel's conform timing record, only when it names rel as its mezzanine (media.rs timing_record_for)."""
    path = project.root / timing_rel_of(rel)
    try:
        doc = json.loads(read_text(path))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    mezzanine = doc.get("mezzanine") if isinstance(doc, dict) else None
    return doc if isinstance(mezzanine, dict) and mezzanine.get("path") == rel else None


def timing_summary(rel: str, doc: Dict[str, Any]) -> Dict[str, Any]:
    source = doc.get("source") if isinstance(doc.get("source"), dict) else {}
    mezzanine = doc.get("mezzanine") if isinstance(doc.get("mezzanine"), dict) else {}
    holds = doc.get("holds") if isinstance(doc.get("holds"), list) else []
    return {
        "file": timing_rel_of(rel),
        "original": source.get("original"),
        "verdict": source.get("verdict"),
        "reasons": source.get("reasons") or [],
        "frames": mezzanine.get("frames"),
        "fps": mezzanine.get("fps"),
        "durationMs": mezzanine.get("durationMs"),
        "holds": len(holds),
    }


def _sha_memo(project: Project) -> Optional[Path]:
    """kb video's content-hash memo (by path, size and mtime), so a large file hashes once."""
    try:
        from .video import cache as cachemod

        return cachemod.root() / project.slug / "analysis" / "shas.json"
    except ImportError:
        return None


def list_assets(project: Project) -> List[Dict[str, Any]]:
    """Every media file under assets/ (never dot files, the provenance record or timing records), with who uses it,
    a conformed video's timing and the provenance origin."""
    from . import asset_meta

    out: List[Dict[str, Any]] = []
    root = project.assets_dir
    if not root.is_dir():
        return out
    used = usage(project)
    try:
        records = asset_meta.read(project.root)["assets"]
    except KbError:
        records = {}
    memo = _sha_memo(project) if records else None
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            path = Path(dirpath) / name
            rel = path.relative_to(project.root).as_posix()
            if is_companion(rel):
                continue
            item: Dict[str, Any] = {"path": rel, "kind": kind_of(name), "bytes": path.stat().st_size, "usedBy": used.get(rel, [])}
            if item["kind"] == "video":
                timing = timing_record(project, rel)
                if timing is not None:
                    item["timing"] = timing_summary(rel, timing)
            record = records.get(rel)
            if isinstance(record, dict):
                if isinstance(record.get("origin"), dict):
                    item["origin"] = record["origin"]
                if record.get("licence") is not None:
                    item["licence"] = record["licence"]
                item["stale"] = asset_meta.is_stale(record, asset_meta.file_hash(project.root, rel, memo))
            out.append(item)
    return out


# ── add ───────────────────────────────────────────────────────────────────────


def _free_conform_stem(project: Project, base: str, ext: str) -> str:
    """media.rs free_conform_stem: the first stem whose mezzanine, timing record and original are all free."""
    assets = project.assets_dir

    def taken(stem: str) -> bool:
        return (assets / f"{stem}.mp4").exists() or (assets / f"{stem}{TIMING_SUFFIX}").exists() or (project.root / ORIGINALS / f"{stem}.{ext}").exists()

    stem, n = base, 1
    while taken(stem):
        n += 1
        stem = f"{base}-{n}"
    return stem


def _same_file(a: Path, b: Path) -> bool:
    try:
        return a.resolve() == b.resolve() or filecmp.cmp(str(a), str(b), shallow=False)
    except OSError:
        return False


def _identical_sibling(src: Path, dest_dir: Path, name: str) -> Optional[Path]:
    """The name-2, name-3 ... free_sibling_name made earlier, if one already holds these bytes: a rerun lands nothing twice."""
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        stem, ext = name, ""
    n = 2
    while True:
        other = dest_dir / (f"{stem}-{n}.{ext}" if ext else f"{stem}-{n}")
        if not other.exists():
            return None
        if _same_file(src, other):
            return other
        n += 1


def _plain_writes(rel: str) -> List[Dict[str, Any]]:
    return [{"path": rel, "action": "create", "base": lockmod.ABSENT}]


def _copy_plain(project: Project, src: Path, dest_dir: Path, final_name: str, dry_run: bool) -> Dict[str, Any]:
    dest = dest_dir / final_name
    note = None
    if dest.exists():
        if _same_file(src, dest):
            return {"path": dest.relative_to(project.root).as_posix(), "copied": False, "note": "identical file already in assets/", "writes": [], "dryRun": dry_run}
        twin = _identical_sibling(src, dest_dir, final_name)
        if twin:
            return {"path": twin.relative_to(project.root).as_posix(), "copied": False, "note": f"identical file already in assets/ as {twin.name}", "writes": [], "dryRun": dry_run}
        free = free_sibling_name(dest_dir, final_name)
        note = f"{final_name} already exists with different content, so this copy is {free}"
        dest = dest_dir / free
    rel = dest.relative_to(project.root).as_posix()
    if dry_run:
        return {"path": rel, "copied": False, "note": note, "kind": kind_of(dest.name), "bytes": src.stat().st_size, "writes": _plain_writes(rel), "dryRun": True}
    dest_dir.mkdir(parents=True, exist_ok=True)
    tmp = dest_dir / f".{dest.name}.kbtmp"
    shutil.copyfile(str(src), str(tmp))
    os.replace(str(tmp), str(dest))
    return {"path": rel, "copied": True, "note": note, "kind": kind_of(dest.name), "bytes": dest.stat().st_size, "writes": _plain_writes(rel), "dryRun": False}


def final_name_of(source_name: str, name: Optional[str]) -> Tuple[str, Optional[str]]:
    """The name a file lands under, and a note when --name was overruled: --name keeps the source's extension, since a
    new name doesn't change the bytes. `hero` on a .png is hero.png, and hero.jpg on a .png is still a .png."""
    if not name:
        return source_name, None
    if "/" in name or "\\" in name or name.startswith("."):
        raise KbError("--name must be a plain file name (no folders, not hidden)", 2)
    from .imagefile import SAME_FORMAT

    ext = ext_of(source_name)
    head, dot, tail = name.rpartition(".")
    given = tail.lower() if dot and head and tail.lower() in KNOWN_EXTS else ""
    if not ext:
        return name, None
    if not given:
        return f"{name}.{ext}", None
    if SAME_FORMAT.get(given, given) == SAME_FORMAT.get(ext, ext):
        return name, None
    if ext == "svg":
        return f"{head}.svg", None
    return f"{head}.{ext}", f"--name said .{given} but the file is .{ext}, so it lands as {head}.{ext}"


def clean_subdir(project: Project, subdir: Optional[str]) -> Path:
    """--dir as a folder under assets/: relative, never hidden (assets/.originals is the app's), and no link out."""
    if not subdir:
        return project.assets_dir
    if not tsxmod.is_project_asset_ref(f"assets/{subdir}/x") or any(p.startswith(".") for p in subdir.split("/")):
        raise KbError("--dir must be a plain relative folder under assets/", 2)
    folder = project.assets_dir / subdir
    resolved = reach.resolve(str(folder))
    assets = reach.resolve(str(project.assets_dir))
    if assets not in resolved.parents and resolved != assets:
        raise KbError(f"--dir {subdir} leads outside assets/ through a link", 2, kind="usage")
    return folder


def check_max_size(max_size: Optional[int]) -> None:
    from .imagefile import MAX_EDGE

    if max_size is not None and not MIN_MAX_SIZE <= max_size <= MAX_EDGE:
        raise KbError(f"--max-size is the long edge in pixels, from {MIN_MAX_SIZE} to {MAX_EDGE}", 2, kind="usage")


def refusal(e: Any, source_name: str) -> KbError:
    """An imagefile.Refused as kb's error: the file is the problem (exit 1) unless this machine has no decoder (exit 2)."""
    if e.code == "no-decoder":
        return KbError(e.message, EXIT_ENV, kind="env", hint=e.hint, data={"refused": e.code, "file": source_name})
    return KbError(e.message, EXIT_PROBLEMS, kind="too-large" if e.code == "too-large" else "invalid", hint=e.hint, data={"refused": e.code, "file": source_name})


def add(
    project: Project,
    source: str,
    name: Optional[str],
    subdir: Optional[str],
    dry_run: bool = False,
    *,
    conform: bool = True,
    opts: Any = None,
    progress: Optional[Callable[[str], None]] = None,
    max_size: Optional[int] = None,
    allow_blank: bool = False,
) -> Dict[str, Any]:
    """Copy a file into assets/ (never overwriting). A video the probe flags (VFR, an edit list, P3 and so on) lands
    the way the app's import lands it: the original in assets/.originals/<stem>.<ext>, the conformed assets/<stem>.mp4
    and its timing record, with provenance in assets/_meta.json. A still is checked and cleaned (_add_image). conform=False,
    or no app, copies as before."""
    src = reach.guard_read(project, source, "the source")
    if not src.is_file():
        raise KbError(f"{source} is not a file")
    return add_file(project, src, Path(source).expanduser().name, name, subdir, dry_run, conform=conform, opts=opts, progress=progress, max_size=max_size, allow_blank=allow_blank)


def add_file(
    project: Project,
    src: Path,
    source_name: str,
    name: Optional[str],
    subdir: Optional[str],
    dry_run: bool = False,
    *,
    conform: bool = True,
    opts: Any = None,
    progress: Optional[Callable[[str], None]] = None,
    max_size: Optional[int] = None,
    allow_blank: bool = False,
    records: Optional[List[Dict[str, Any]]] = None,
    raster: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """add() past the reach check. records collects provenance for a batch to write at once; raster is an SVG a batch
    already rasterised ({ png, note, edge })."""
    from . import imagefile

    final_name, name_note = final_name_of(source_name, name)
    if "/" in final_name or final_name.startswith("."):
        raise KbError("--name must be a plain file name (no folders, not hidden)", 2)
    check_max_size(max_size)
    real = imagefile.sniff_file(src)
    if not ext_of(final_name) and real in imagefile.EXT_OF:
        final_name = f"{final_name}.{imagefile.EXT_OF[str(real)]}"
    ext = ext_of(final_name)
    image = ext == "svg" or ext in KINDS["image"]
    if ext != "svg" and ext not in SUPPORTED_ASSET_EXTS:
        raise KbError(f'".{ext}" is not a media type the app reads; convert it to png/jpg/webp, mp4/mov/webm or mp3/wav/m4a first', 1)
    if final_name == "_meta.json" or final_name.endswith(TIMING_SUFFIX):
        raise KbError(f"{final_name} is a name kb keeps for its own records; pick another --name", 2, kind="usage")
    dest_dir = clean_subdir(project, subdir)
    if max_size is not None and not image:
        raise KbError(f"--max-size caps images; {final_name} is a {kind_of(final_name)} file and keeps its size", 2, kind="usage")
    from . import conform as conformmod

    warnings: List[str] = [name_note] if name_note else []
    if image:
        return _add_image(project, src, source_name, final_name, dest_dir, dry_run, real, conform, max_size, allow_blank, warnings, opts, records, raster)
    if not conform or ext not in conformmod.CONFORMABLE_EXTS:
        result = _copy_plain(project, src, dest_dir, final_name, dry_run)
        result.update({"conformed": False, "checked": False, "probe": None, "warnings": warnings})
        return result
    plain = dest_dir / final_name
    if plain.exists() and _same_file(src, plain):
        result = _copy_plain(project, src, dest_dir, final_name, dry_run)
        probe_block = None
        checked = False
        if timing_record(project, result["path"]) is None and not _decoded_clean(project, result["path"]):
            decision = conformmod.import_decision(src, say=progress)
            checked, probe_block = decision["checked"], decision["probe"]
            _remember_decision(project, result["path"], decision, dry_run)
            if decision["conform"]:
                warnings.append(f"{result['path']} is already in assets/, but it only looks conformed ({', '.join(decision['probe']['why'])}): ./kb assets conform {result['path']}")
        result.update({"conformed": False, "checked": checked, "probe": probe_block, "warnings": warnings})
        return result
    base = final_name.rsplit(".", 1)[0]
    kept = project.root / ORIGINALS / f"{base}.{ext}"
    mezzanine = f"assets/{base}.mp4"
    if kept.is_file() and _same_file(src, kept) and timing_record(project, mezzanine) is not None and (project.root / mezzanine).is_file():
        return {"path": mezzanine, "copied": False, "note": f"identical file already conformed (its original is {ORIGINALS}/{kept.name})", "writes": [],
                "dryRun": dry_run, "conformed": True, "checked": True, "probe": None, "warnings": warnings}
    decision = conformmod.import_decision(src, say=progress)
    if not decision["checked"]:
        warnings.append(f"{src.name} was not checked for conforming ({decision['why']}); ./kb assets probe it --deep once that is fixed")
    if decision.get("refused"):
        warnings.append(f"not conformed: {decision['refused'].get('hint')}")
    if not decision["conform"]:
        if not decision["checked"] and decision["probe"].get("recommended"):
            warnings.append(f"its container says it needs conforming ({', '.join(decision['probe']['why'])}): ./kb assets conform it once the app is installed")
        result = _copy_plain(project, src, dest_dir, final_name, dry_run)
        _remember_decision(project, result["path"], decision, dry_run)
        result.update({"conformed": False, "checked": decision["checked"], "probe": decision["probe"], "warnings": warnings})
        return result
    if subdir:
        warnings.append("--dir does not apply to a conformed video: the app's conform writes it flat in assets/")
    stem = _free_conform_stem(project, base, ext)
    original_rel = f"{ORIGINALS}/{stem}.{ext}"
    target_rel = f"assets/{stem}.mp4"
    timing_rel = f"assets/{stem}{TIMING_SUFFIX}"
    meta_base = lockmod.current_hash(project.root / META_REL)
    writes = [
        {"path": original_rel, "action": "create", "base": lockmod.ABSENT},
        {"path": target_rel, "action": "create", "base": lockmod.ABSENT},
        {"path": timing_rel, "action": "create", "base": lockmod.ABSENT},
        {"path": META_REL, "action": "create" if meta_base == lockmod.ABSENT else "modify", "base": meta_base},
    ]
    note = f"{base}.mp4 was taken, so this video is {stem}.mp4" if stem != base else None
    common = {"note": note, "kind": "video", "original": original_rel, "timing": timing_rel, "checked": True, "probe": decision["probe"], "warnings": warnings}
    if dry_run:
        return dict(common, path=target_rel, copied=False, conformed=False, bytes=src.stat().st_size, writes=writes, dryRun=True)
    (project.root / ORIGINALS).mkdir(parents=True, exist_ok=True)
    if not lockmod.copy_if_absent(src, project.root / original_rel):
        raise KbError(f"{original_rel} appeared while kb copied the video in; rerun ./kb assets add", 3, kind="conflict", retry_after_ms=1000)
    try:
        done = conformmod.media_conform(decision["cli"], project.root, original_rel, name=stem, keep="move", on_event=_progress_printer(target_rel, progress))
    except KeyboardInterrupt:
        _give_back(project, original_rel, dest_dir, final_name)
        raise
    except KbError as e:
        back = _give_back(project, original_rel, dest_dir, final_name)
        warnings.append(f"the conform failed ({getattr(e, 'cli_code', e.kind)}: {e.message}), so {back} is the file as it was")
        return dict(common, path=back, copied=True, conformed=False, original=None, timing=None, bytes=(project.root / back).stat().st_size,
                    writes=_plain_writes(back), dryRun=False)
    from . import asset_meta

    try:
        asset_meta.record_origin(project, target_rel, asset_meta.origin("import", "kb assets add", source=original_rel, source_name=src.name),
                                 list(conformmod.TRANSFORMS), opts=opts)
    except KbError as e:
        warnings.append(f"the provenance record was not written: {e.message}")
    return dict(common, path=target_rel, copied=True, conformed=True, bytes=int(done.get("bytes") or (project.root / target_rel).stat().st_size),
                frames=done.get("frames"), durationMs=done.get("durationMs"), verdict=done.get("verdict"), reasons=done.get("reasons") or [],
                writes=writes, dryRun=False)


def _remember_decision(project: Project, rel: str, decision: Dict[str, Any], dry_run: bool) -> None:
    """A clip both decoders have read needs no second decode while its bytes stay the same, and kb check can use the verdict."""
    if not dry_run and decision.get("checks"):
        remember_verdict(project, rel, {"verdict": decision["probe"].get("verdict"), "reasons": decision["probe"].get("reasons"), "checks": decision["checks"]})


def _decoded_clean(project: Project, rel: str) -> bool:
    known = known_verdict(project, rel)
    return bool(known) and "decode" in (known.get("checks") or []) and known.get("verdict") == "ok" and not set(known.get("reasons") or []) - {"b-frames"}


def _rasterise_svg(src: Path, stage: Path, edge: int, source_name: str) -> Tuple[Path, Optional[str]]:
    """The rasteriser only ever sees the sanitised copy."""
    from . import imagefile, svgsafe

    try:
        data = src.read_bytes()
    except OSError as e:
        raise imagefile.Refused("unreadable", f"{source_name} can't be read: {e.strerror}") from None
    clean, dropped = svgsafe.sanitise(data, source_name)
    svg, png = stage / "clean.svg", stage / "raster.png"
    svg.write_bytes(clean)
    svgsafe.rasterise([(svg, png)], edge)
    if not png.is_file():
        raise imagefile.Refused("unreadable", f"{source_name} did not rasterise: macOS could not draw it", "export it again as a PNG")
    return png, svgsafe.dropped_note(source_name, dropped)


def _add_image(
    project: Project,
    src: Path,
    source_name: str,
    final_name: str,
    dest_dir: Path,
    dry_run: bool,
    real: Optional[str],
    conform: bool,
    max_size: Optional[int],
    allow_blank: bool,
    warnings: List[str],
    opts: Any,
    records: Optional[List[Dict[str, Any]]],
    raster: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """A still, or an SVG rasterised through the brand rasteriser: what it really is decides its extension, whatever would
    draw wrong is baked out (imagefile.prepare), and a result that draws nothing is refused. Provenance only when kb changed the bytes."""
    from . import asset_meta, imagefile, svgsafe

    stem = final_name.rsplit(".", 1)[0]
    try:
        with tempfile.TemporaryDirectory(prefix="kb-import-") as tmp:
            stage = Path(tmp)
            if real == "svg" or ext_of(final_name) == "svg":
                edge = max_size or svgsafe.DEFAULT_EDGE
                if raster is not None:
                    png, svg_note = Path(raster["png"]), raster.get("note")
                else:
                    png, svg_note = _rasterise_svg(src, stage, edge, source_name)
                if svg_note:
                    warnings.append(svg_note)
                g = imagefile.facts(png)
                done: Dict[str, Any] = {"path": png, "facts": g, "ext": "png", "conformed": [], "resized": False, "transforms": [{"op": "rasterise", "longEdge": edge}]}
                final_name = f"{stem}.png"
            else:
                done = imagefile.prepare(src, stage, max_edge=max_size, conform=conform)
                g = done["facts"]
                if imagefile.SAME_FORMAT.get(ext_of(final_name)) != g["format"]:
                    corrected = f"{stem}.{done['ext']}"
                    if not done["transforms"]:
                        warnings.append(f"{source_name} is really a {g['format'].upper()}, so it lands as {corrected}")
                    final_name = corrected
                if not conform:
                    skipped = imagefile.needs_conform(g)
                    if skipped:
                        warnings.append(f"copied as it is with --no-conform; it will draw wrong in a frame ({', '.join(skipped)})")
            if not allow_blank:
                imagefile.refuse_blank(Path(done["path"]), g, source_name)
            if max(g["width"], g["height"]) > imagefile.LARGE_EDGE and not max_size:
                warnings.append(f"{source_name} is {g['width']}x{g['height']}, more than a 4K frame shows: --max-size 3840 keeps a smaller copy")
            if g.get("animated"):
                warnings.append(f"{source_name} is animated, but only its first frame draws")
            transforms = done["transforms"]
            sha = lockmod.file_sha256(src) if transforms else None
            result = _land_image(project, Path(done["path"]), dest_dir, final_name, dry_run, sha, transforms)
    except imagefile.Refused as e:
        raise refusal(e, source_name) from None
    if done["conformed"]:
        result["note"] = "; ".join(filter(None, [result.get("note"), f"converted for the stage ({', '.join(done['conformed'])})"]))
    if done["resized"]:
        result["note"] = "; ".join(filter(None, [result.get("note"), f"resized from a longer edge to {g['width']}x{g['height']}"]))
    result.update({
        "conformed": bool(done["conformed"]),
        "checked": True,
        "probe": {"verdict": "ok", "reasons": list(done["conformed"]), "recommended": bool(done["conformed"]), "why": list(done["conformed"]), "refused": None},
        "warnings": warnings,
        "image": {k: g.get(k) for k in ("format", "width", "height", "alpha", "profile")},
        "transforms": transforms,
    })
    if transforms and result["copied"]:
        record = {"rel": result["path"], "origin": asset_meta.origin("import", "kb assets add", source_name=source_name.replace("/", "_").replace("\\", "_"), source_sha256=sha), "transforms": transforms}
        if records is not None:
            records.append(record)
        else:
            try:
                asset_meta.record_origins(project, [record], opts=opts)
            except KbError as e:
                warnings.append(f"the provenance record was not written: {e.message}")
    return result


def _land_image(project: Project, out: Path, dest_dir: Path, final_name: str, dry_run: bool, source_sha: Optional[str], transforms: List[Dict[str, Any]]) -> Dict[str, Any]:
    """_copy_plain, but a converted file that came from these same bytes the same way is the file already here."""
    from . import asset_meta

    dest = dest_dir / final_name
    if source_sha and dest.is_file():
        rel = dest.relative_to(project.root).as_posix()
        try:
            record = asset_meta.read(project.root)["assets"].get(rel)
        except KbError:
            record = None
        origin = record.get("origin") if isinstance(record, dict) else None
        if isinstance(origin, dict) and origin.get("sourceSha256") == source_sha and record.get("transforms") == transforms and not asset_meta.is_stale(record, asset_meta.file_hash(project.root, rel)):
            return {"path": rel, "copied": False, "note": "the same file was already imported this way", "kind": "image", "bytes": dest.stat().st_size, "writes": [], "dryRun": dry_run}
    result = _copy_plain(project, out, dest_dir, final_name, dry_run)
    if transforms and result["writes"]:
        meta_base = lockmod.current_hash(project.root / META_REL)
        result["writes"].append({"path": META_REL, "action": "create" if meta_base == lockmod.ABSENT else "modify", "base": meta_base})
    return result


def _give_back(project: Project, original_rel: str, dest_dir: Path, final_name: str) -> str:
    """media.rs restore_import: a failed import conform puts the original back as a plain file under a free name."""
    kept = project.root / original_rel
    dest = dest_dir / final_name
    if dest.exists():
        dest = dest_dir / free_sibling_name(dest_dir, final_name)
    dest_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(str(kept), str(dest))
    except OSError:
        return original_rel
    return dest.relative_to(project.root).as_posix()


def _progress_printer(rel: str, say: Optional[Callable[[str], None]]) -> Callable[[Dict[str, Any]], None]:
    state = {"step": -1}

    def on_event(event: Dict[str, Any]) -> None:
        if say is None:
            return
        total = int(event.get("total") or 0)
        frame = int(event.get("frame") or 0)
        if event.get("event") == "start":
            say(f"conforming {rel} ({total} frames at 60 fps)")
            return
        step = frame * 5 // total if total else 0
        if step > state["step"] and 0 < step < 5:
            state["step"] = step
            say(f"conforming {rel}: {frame}/{total} frames")

    return on_event


# ── probe ─────────────────────────────────────────────────────────────────────


def ffprobe_path() -> Optional[str]:
    from . import conform as conformmod

    return conformmod.find_tool("ffprobe")


def probe(project: Project, ref: str, deep: bool = False) -> Dict[str, Any]:
    """Duration, size, rate and codecs; a video also gets `decode`, the conform verdict (kblib/conform.py)."""
    rel = ref if ref.startswith("assets/") else f"assets/{ref}"
    path = project.root / rel
    if not path.is_file():
        raise KbError(f"{rel} does not exist; see kb assets list")
    info: Dict[str, Any] = {"path": rel, "kind": kind_of(path.name), "bytes": path.stat().st_size}
    exe = ffprobe_path()
    if exe:
        try:
            proc = subprocess.run(
                [exe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
                capture_output=True, text=True, timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired) as e:
            raise KbError(f"ffprobe failed to run: {e}", EXIT_ENV) from None
        if proc.returncode != 0 and info["kind"] != "video":
            raise KbError(f"ffprobe could not read {rel}: {proc.stderr.strip()[:300]}")
        data = json.loads(proc.stdout or "{}") if proc.returncode == 0 else {}
        fmt = data.get("format") or {}
        if fmt.get("duration"):
            try:
                info["durationMs"] = int(round(float(fmt["duration"]) * 1000))
            except ValueError:
                pass
        for stream in data.get("streams") or []:
            if stream.get("codec_type") == "video" and "width" not in info:
                info["width"], info["height"] = stream.get("width"), stream.get("height")
                info["videoCodec"] = stream.get("codec_name")
                rate = stream.get("avg_frame_rate") or stream.get("r_frame_rate")
                if isinstance(rate, str) and "/" in rate:
                    num, den = rate.split("/", 1)
                    try:
                        if float(den):
                            info["fps"] = round(float(num) / float(den), 3)
                    except ValueError:
                        pass
            elif stream.get("codec_type") == "audio" and "audioCodec" not in info:
                info["audioCodec"] = stream.get("codec_name")
                info["sampleRate"] = stream.get("sample_rate")
        if info["kind"] == "image":
            info.pop("durationMs", None)
        info["probe"] = exe
    elif info["kind"] != "video":
        dims = image_size(path)
        if dims:
            info["width"], info["height"] = dims
            info["probe"] = "built-in image reader"
            if info["kind"] == "image":
                _image_facts(path, info)
            return info
        raise KbError("no ffprobe found (the app bundle's Contents/MacOS/ffprobe is missing); only png/jpg sizes can be read without it", EXIT_ENV)
    else:
        info["probe"] = "built-in container reader"
    if info["kind"] == "video":
        _video_facts(project, rel, path, info, deep)
    elif info["kind"] == "image":
        _image_facts(path, info)
    return info


def _image_facts(path: Path, info: Dict[str, Any]) -> None:
    """What a still really is, whether it would draw wrong, and whether it draws anything."""
    from . import imagefile

    try:
        f = imagefile.facts(path)
        seen = imagefile.look(path, f)
    except imagefile.Refused as e:
        info["image"] = {"refused": e.code, "error": e.message}
        return
    info["image"] = dict({k: f.get(k) for k in ("format", "width", "height", "bits", "alpha", "space", "profile", "orientation", "animated")},
                         blank=seen["blank"], conform=imagefile.needs_conform(f))


def _video_facts(project: Project, rel: str, path: Path, info: Dict[str, Any], deep: bool) -> None:
    from . import conform as conformmod

    timing = timing_record(project, rel)
    command = f"./kb assets conform {rel}" if timing is None else None
    decode = conformmod.video_verdict(path, deep=deep, command=command)
    if timing is not None:
        decode["conform"].update(recommended=False, command=None)
        info["timing"] = timing_summary(rel, timing)
    container = decode.get("container") or {}
    for key in ("width", "height"):
        if info.get(key) is None and container.get(key) is not None:
            info[key] = container[key]
    if "durationMs" not in info and container.get("durationMs"):
        info["durationMs"] = int(round(container["durationMs"]))
    info["decode"] = decode
    remember_verdict(project, rel, decode)


def verdict_cache(project: Project) -> Optional[Path]:
    """Probe verdicts for kb check: scratch under the bridge folder (never .kb/), beside kb video's probe cache."""
    try:
        from .video import cache as cachemod

        return cachemod.root() / project.slug / "asset-verdicts.json"
    except ImportError:
        return None


def _stat_key(project: Project, rel: str) -> Optional[str]:
    try:
        st = (project.root / rel).stat()
    except OSError:
        return None
    return f"{rel}|{st.st_size}|{st.st_mtime_ns}"


def remember_verdict(project: Project, rel: str, decode: Dict[str, Any]) -> None:
    """Keep the verdict for kb check, keyed by the file's size and mtime (scratch under the bridge folder, never .kb/)."""
    path = verdict_cache(project)
    key = _stat_key(project, rel)
    if path is None or key is None:
        return
    try:
        store = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        store = {}
    if not isinstance(store, dict):
        store = {}
    store = {k: v for k, v in store.items() if not k.startswith(f"{rel}|")}
    store[key] = {"verdict": decode.get("verdict"), "reasons": decode.get("reasons") or [], "checks": decode.get("checks") or []}
    if len(store) > 500:
        store = dict(list(store.items())[-400:])
    try:
        from .util import atomic_write_text

        atomic_write_text(path, json.dumps(store))
    except OSError:
        pass


def known_verdict(project: Project, rel: str) -> Optional[Dict[str, Any]]:
    path = verdict_cache(project)
    key = _stat_key(project, rel)
    if path is None or key is None:
        return None
    try:
        store = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    hit = store.get(key) if isinstance(store, dict) else None
    return hit if isinstance(hit, dict) else None


def image_size(path: Path) -> Optional[tuple]:
    try:
        with open(path, "rb") as f:
            head = f.read(64 * 1024)
    except OSError:
        return None
    if head[:8] == b"\x89PNG\r\n\x1a\n" and len(head) >= 24:
        return struct.unpack(">II", head[16:24])
    if head[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(head):
            if head[i] != 0xFF:
                i += 1
                continue
            marker = head[i + 1]
            length = struct.unpack(">H", head[i + 2:i + 4])[0]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", head[i + 5:i + 9])
                return (w, h)
            i += 2 + length
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP" and head[12:16] == b"VP8X" and len(head) >= 30:
        w = 1 + int.from_bytes(head[24:27], "little")
        h = 1 + int.from_bytes(head[27:30], "little")
        return (w, h)
    return None


def unused(project: Project) -> Set[str]:
    return {a["path"] for a in list_assets(project) if not a["usedBy"]}
