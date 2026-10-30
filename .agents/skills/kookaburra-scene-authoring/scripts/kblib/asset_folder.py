"""kb assets add-folder: a whole folder of logos, icons and screenshots into assets/, one file's trouble never stopping the rest.

The folder is outside the project and untrusted: reach guards it, the walk never follows a link, and file count, depth and
size are capped before a byte is copied. Files land through assets.add_file, so each gets the checks a single add gets.
"""

from __future__ import annotations

import os
import re
import shutil
import tempfile
import unicodedata
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import assets as assetmod
from . import reach
from .check import SUPPORTED_ASSET_EXTS
from .project import Project
from .util import EXIT_ENV, EXIT_PROBLEMS, KbError

DEFAULT_LIMIT = 500
MAX_LIMIT = 2000
MAX_SCAN = 20000
MAX_DEPTH = 12
MAX_FILE_BYTES = 16 * 1024 ** 3
MAX_TOTAL_BYTES = 32 * 1024 ** 3
FREE_MARGIN_BYTES = 256 * 1024 ** 2
IGNORED_NAMES = {"__MACOSX", "Thumbs.db", "desktop.ini"}
MIN_THUMB = 16
MAX_THUMB = 1024
SEPARATORS = re.compile(r"[^\w]+|_+", re.UNICODE)
THUMB_SIZE = re.compile(r"^(\d{1,5})[xX](\d{1,5})$")


def slug(text: str) -> str:
    """Lowercase, kebab-case, any script: names a scene can reference without surprises."""
    return SEPARATORS.sub("-", unicodedata.normalize("NFC", text).lower()).strip("-")


def parse_thumbs(raw: Optional[str]) -> Optional[Tuple[int, int]]:
    if raw is None:
        return None
    match = THUMB_SIZE.match(raw.strip())
    if not match or not all(MIN_THUMB <= int(v) <= MAX_THUMB for v in match.groups()):
        raise KbError(f"--thumbs takes WxH, each side {MIN_THUMB} to {MAX_THUMB} px, like 240x160; not {raw!r}", EXIT_ENV, kind="usage")
    return int(match.group(1)), int(match.group(2))


def guard_folder(project: Project, raw: str) -> Path:
    """reach's read guard for the folder, and never the project's own tree: that would import assets into themselves."""
    folder = reach.guard_read(project, raw, "the folder")
    if not folder.is_dir():
        raise KbError(f"{raw} is not a folder", EXIT_ENV, kind="usage", hint="./kb assets add takes a single file")
    root = reach.resolve(str(project.root))
    if folder == root or folder in root.parents:
        raise KbError(f"{raw} holds this project, so it can't be imported into it", EXIT_ENV, kind="usage", hint="name the folder that holds just the media")
    assets = reach.resolve(str(project.assets_dir))
    if folder == assets or assets in folder.parents:
        raise KbError(f"{raw} is already inside assets/", EXIT_ENV, kind="usage")
    return folder


def _importable(name: str) -> bool:
    ext = assetmod.ext_of(name)
    return ext == "svg" or (ext in SUPPORTED_ASSET_EXTS and ext not in ("txt", "csv", "tsv"))


def scan(folder: Path) -> Dict[str, Any]:
    """Every importable file under folder, sorted, and what was passed over and why. Links are never followed, in or out;
    a walk past MAX_SCAN entries or MAX_DEPTH levels is refused rather than cut short."""
    files: List[Dict[str, Any]] = []
    skipped: List[Dict[str, str]] = []
    other = 0
    entries = 0
    stack: List[Tuple[Path, int]] = [(folder, 0)]
    while stack:
        current, depth = stack.pop()
        try:
            listing = sorted(os.scandir(current), key=lambda e: e.name)
        except OSError as e:
            skipped.append({"file": current.relative_to(folder).as_posix() or ".", "why": f"can't be read: {e.strerror}"})
            continue
        for entry in listing:
            entries += 1
            if entries > MAX_SCAN:
                raise KbError(f"{folder} holds more than {MAX_SCAN} files and folders, so kb stopped walking it", EXIT_PROBLEMS, kind="too-large", hint="name the folder that holds just the media")
            rel = Path(entry.path).relative_to(folder).as_posix()
            if entry.name.startswith(".") or entry.name in IGNORED_NAMES:
                continue
            if entry.is_symlink():
                skipped.append({"file": rel, "why": "a link; kb never follows links out of the folder"})
                continue
            if entry.is_dir(follow_symlinks=False):
                if depth + 1 > MAX_DEPTH:
                    raise KbError(f"{rel} is more than {MAX_DEPTH} folders deep, so kb stopped walking it", EXIT_PROBLEMS, kind="too-large", hint="name a folder nearer the media")
                stack.append((Path(entry.path), depth + 1))
                continue
            if not entry.is_file(follow_symlinks=False):
                skipped.append({"file": rel, "why": "not a regular file"})
                continue
            denied = reach.denied_reason(Path(entry.path))
            if denied:
                skipped.append({"file": rel, "why": f"not read: {denied}"})
                continue
            if not _importable(entry.name):
                other += 1
                continue
            try:
                size = entry.stat(follow_symlinks=False).st_size
            except OSError as e:
                skipped.append({"file": rel, "why": f"can't be read: {e.strerror}"})
                continue
            files.append({"rel": rel, "path": Path(entry.path), "bytes": size})
    files.sort(key=lambda f: f["rel"])
    return {"files": files, "skipped": skipped, "other": other}


def _dest_of(rel: str, subdir: Optional[str]) -> Tuple[Optional[str], str]:
    """Where a file lands: the folder's own shape under --dir, slugged. Returns (subdir, name)."""
    parts = rel.split("/")
    dirs = [slug(p) or "folder" for p in parts[:-1]]
    stem, dot, ext = parts[-1].rpartition(".")
    name = f"{slug(stem) or 'file'}.{ext.lower()}" if dot and stem else (slug(parts[-1]) or "file")
    joined = "/".join(([subdir.strip("/")] if subdir else []) + dirs)
    return joined or None, name


class Duplicates:
    """Bytes already in assets/, a conform's kept originals and what earlier imports were made from, found by hash. Files
    are only hashed when their size could match, so a folder of large clips costs nothing it doesn't need."""

    def __init__(self, project: Project) -> None:
        from . import asset_meta

        self.memo = assetmod._sha_memo(project)
        self.seen: Dict[str, str] = {}
        self.sized: Dict[int, List[Tuple[Path, str]]] = {}
        root = project.assets_dir
        if root.is_dir():
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames if not d.startswith(".") or d == ".originals"]
                inside = Path(dirpath).name == ".originals"
                for name in filenames:
                    path = Path(dirpath) / name
                    if name.startswith(".") or path.is_symlink():
                        continue
                    rel = path.relative_to(project.root).as_posix()
                    if assetmod.is_companion(rel):
                        continue
                    if inside:
                        rel = f"assets/{name.rsplit('.', 1)[0]}.mp4"
                        if not (project.root / rel).is_file():
                            continue
                    try:
                        self.sized.setdefault(path.stat().st_size, []).append((path, rel))
                    except OSError:
                        continue
        try:
            records = asset_meta.read(project.root)["assets"]
        except KbError:
            records = {}
        for rel, record in records.items():
            origin = record.get("origin") if isinstance(record, dict) else None
            if isinstance(origin, dict) and isinstance(origin.get("sourceSha256"), str) and (project.root / rel).is_file():
                self.seen[origin["sourceSha256"]] = rel

    def of(self, path: Path, size: int) -> Tuple[str, Optional[str]]:
        """(this file's hash, the asset that already holds its bytes). An asset's hash is memoised, a source's never is."""
        from . import lock as lockmod
        from .video import passes

        sha = lockmod.file_sha256(path)
        if sha in self.seen:
            return sha, self.seen[sha]
        for other, rel in self.sized.get(size, []):
            try:
                if passes.file_sha256(other, self.memo) == sha:
                    self.seen[sha] = rel
                    return sha, rel
            except OSError:
                continue
        return sha, None


def _rasterise_batch(files: List[Dict[str, Any]], stage: Path, edge: int) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Any]]:
    """Every SVG sanitised and rasterised in one osascript, not one process each: { rel: { png, note, edge } }, { rel: Refused }."""
    from . import imagefile, svgsafe

    done: Dict[str, Dict[str, Any]] = {}
    failed: Dict[str, Any] = {}
    jobs: List[Tuple[Path, Path]] = []
    pending: List[Tuple[str, Path, Optional[str]]] = []
    for i, f in enumerate(x for x in files if assetmod.ext_of(x["rel"]) == "svg"):
        try:
            clean, dropped = svgsafe.sanitise(Path(f["path"]).read_bytes(), f["rel"])
        except imagefile.Refused as e:
            failed[f["rel"]] = e
            continue
        except OSError as e:
            failed[f["rel"]] = imagefile.Refused("unreadable", f"{f['rel']} can't be read: {e.strerror}")
            continue
        svg, png = stage / f"{i}.svg", stage / f"{i}.png"
        svg.write_bytes(clean)
        jobs.append((svg, png))
        pending.append((f["rel"], png, svgsafe.dropped_note(f["rel"], dropped)))
    if jobs:
        svgsafe.rasterise(jobs, edge)
    for rel, png, note in pending:
        if png.is_file():
            done[rel] = {"png": png, "note": note, "edge": edge}
        else:
            failed[rel] = imagefile.Refused("unreadable", f"{rel} did not rasterise: macOS could not draw it", "export it again as a PNG")
    return done, failed


def add_folder(
    project: Project,
    raw: str,
    *,
    dedupe: bool = False,
    thumbs: Optional[Tuple[int, int]] = None,
    limit: Optional[int] = None,
    subdir: Optional[str] = None,
    max_size: Optional[int] = None,
    conform: bool = True,
    allow_blank: bool = False,
    dry_run: bool = False,
    opts: Any = None,
    progress: Optional[Callable[[str], None]] = None,
    agent: Optional[str] = None,
) -> Dict[str, Any]:
    from . import asset_meta, imagefile, svgsafe

    folder = guard_folder(project, raw)
    assetmod.clean_subdir(project, subdir)
    assetmod.check_max_size(max_size)
    if limit is not None and not 1 <= limit <= MAX_LIMIT:
        raise KbError(f"--limit is 1 to {MAX_LIMIT} files", EXIT_ENV, kind="usage")
    found = scan(folder)
    files = found["files"]
    total = len(files)
    if limit is None and total > DEFAULT_LIMIT:
        raise KbError(f"{folder.name} holds {total} media files, over the {DEFAULT_LIMIT} kb takes unasked; nothing was copied", EXIT_PROBLEMS, kind="too-large",
                      hint=f"pass --limit N (up to {MAX_LIMIT}) or name a smaller folder")
    chosen = files if limit is None else files[:limit]
    refused: List[Dict[str, Any]] = []
    kept: List[Dict[str, Any]] = []
    for f in chosen:
        if f["bytes"] > MAX_FILE_BYTES:
            refused.append({"file": f["rel"], "code": "too-large", "error": f"{f['rel']} is {f['bytes'] // 1024 ** 3} GB, over the {MAX_FILE_BYTES // 1024 ** 3} GB one file may be"})
        else:
            kept.append(f)
    size = sum(f["bytes"] for f in kept)
    if size > MAX_TOTAL_BYTES:
        raise KbError(f"{folder.name} holds {assetmod.human_size(size)} of media, over the {assetmod.human_size(MAX_TOTAL_BYTES)} kb takes in one go; nothing was copied", EXIT_PROBLEMS, kind="too-large",
                      hint="import the part you need, or pass --limit N")
    free = shutil.disk_usage(project.root).free
    if not dry_run and size + FREE_MARGIN_BYTES > free:
        raise KbError(f"{folder.name} needs {assetmod.human_size(size)}, but only {assetmod.human_size(free)} is free; nothing was copied", EXIT_ENV, kind="env", hint="free some disk, or import part of the folder with --limit N")
    items: List[Dict[str, Any]] = []
    duplicates: List[Dict[str, str]] = []
    warnings: List[str] = []
    records: List[Dict[str, Any]] = []
    writes: Dict[str, Dict[str, Any]] = {}
    dups = Duplicates(project) if dedupe else None
    edge = max_size or svgsafe.DEFAULT_EDGE
    with tempfile.TemporaryDirectory(prefix="kb-folder-") as tmp:
        to_add = []
        first_with: Dict[str, str] = {}
        twins: List[Tuple[str, str]] = []
        for f in kept:
            sha = None
            if dups is not None:
                try:
                    sha, same = dups.of(Path(f["path"]), f["bytes"])
                except OSError as e:
                    refused.append({"file": f["rel"], "code": "unreadable", "error": f"{f['rel']} can't be read: {e.strerror}"})
                    continue
                if same:
                    duplicates.append({"file": f["rel"], "of": same})
                    continue
                if sha in first_with:
                    twins.append((f["rel"], first_with[sha]))
                    continue
                first_with[sha] = f["rel"]
            to_add.append(f)
        try:
            rasters, failed = _rasterise_batch(to_add, Path(tmp), edge)
        except imagefile.Refused as e:
            raise assetmod.refusal(e, folder.name) from None
        try:
            for n, f in enumerate(to_add, 1):
                rel = f["rel"]
                if rel in failed:
                    e = failed[rel]
                    refused.append({"file": rel, "code": e.code, "error": e.message})
                    continue
                dest, name = _dest_of(rel, subdir)
                if progress is not None and total > 20 and n % 50 == 0:
                    progress(f"{n} of {len(to_add)} files")
                try:
                    res = assetmod.add_file(project, Path(f["path"]), Path(rel).name, name, dest, dry_run, conform=conform, opts=opts, progress=progress,
                                            max_size=max_size if assetmod.kind_of(name) == "image" or name.endswith(".svg") else None,
                                            allow_blank=allow_blank, records=records, raster=rasters.get(rel))
                except KbError as e:
                    refused.append({"file": rel, "code": (e.data or {}).get("refused") or e.kind, "error": e.message})
                    continue
                except OSError as e:
                    refused.append({"file": rel, "code": "unreadable", "error": f"{rel} could not be copied: {e.strerror}"})
                    continue
                warnings += res.get("warnings") or []
                writes.update((w["path"], w) for w in res.get("writes") or [])
                items.append({"file": rel, "path": res["path"], "kind": res.get("kind") or assetmod.kind_of(res["path"]), "copied": bool(res.get("copied")), "bytes": res.get("bytes"),
                              "conformed": bool(res.get("conformed")), "note": res.get("note")})
        finally:
            if records and not dry_run:
                try:
                    asset_meta.record_origins(project, records, opts=opts)
                except KbError as e:
                    warnings.append(f"the provenance records were not written: {e.message}")
    landed = {i["file"]: i["path"] for i in items}
    duplicates += [{"file": rel, "of": landed.get(first, first)} for rel, first in twins]
    out: Dict[str, Any] = {
        "folder": str(folder), "items": items, "copied": sum(1 for i in items if i["copied"]), "duplicates": duplicates, "refused": refused,
        "skipped": found["skipped"], "otherFiles": found["other"], "remaining": total - len(chosen), "warnings": list(dict.fromkeys(warnings)), "dryRun": dry_run,
        "writes": list(writes.values()),
    }
    if thumbs is not None and items and not dry_run:
        out["thumbs"] = write_thumbs(project, items, thumbs, agent)
    return out


def write_thumbs(project: Project, items: List[Dict[str, Any]], box: Tuple[int, int], agent: Optional[str] = None) -> Dict[str, Any]:
    """One contact sheet to Read, a cell per imported image or video, in .kb/thumbs/ (git and packs never see it)."""
    from . import contact, imagefile
    from . import conform as conformmod

    folder = contact.new_folder(project, agent or "add-folder")
    ffmpeg = conformmod.find_tool("ffmpeg")
    cells: List[Dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="kb-thumbs-") as tmp:
        for n, item in enumerate(items, 1):
            source = project.root / item["path"]
            cell: Dict[str, Any] = {"label": f"{n} {item['path'][len('assets/'):]}"}
            if item["kind"] == "image":
                try:
                    f = imagefile.facts(source)
                    cell["surface"] = imagefile.surface_of(imagefile.look(source, f))
                    cell["image"] = source
                except imagefile.Refused:
                    pass
            elif item["kind"] == "video":
                still = Path(tmp) / f"{n}.png"
                if contact.video_frame(ffmpeg, source, still, box):
                    try:
                        cell["rgba"] = imagefile.thumb(still, Path(tmp) / f"{n}-t.png", box)
                    except imagefile.Refused:
                        pass
            if item["kind"] in ("image", "video"):
                cells.append(cell)
        sheets, fitted = contact.write_sheets(cells, folder, box)
    return {"dir": str(folder), "sheets": [str(s) for s in sheets], "size": f"{box[0]}x{box[1]}", "shown": fitted, "more": len(cells) - fitted}
