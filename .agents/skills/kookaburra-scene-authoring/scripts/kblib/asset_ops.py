"""kb assets conform, replace, unused, restore and meta: the operations behind kblib/assets_cli.py.

Long work (the app's conform) runs outside the project lock; every write to project.json, scenes/** and .kb/** then
lands in one kblib.lock transaction, re-checked under the lock. Old files go to .kb/archive/ (kblib/archive.py).
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import archive
from . import asset_meta
from . import assets as assetmod
from . import lock as lockmod
from . import tsx as tsxmod
from .asset_refs import AssetRefs, asset_files, glob_matches
from .project import Project
from .scenes import free_sibling_name, rewrite_json_asset_refs
from .util import EXIT_ENV, EXIT_PROBLEMS, EXIT_TRANSIENT, KbError

Warn = Callable[[str], None]
SAMPLE_EXTS = ("png", "jpg", "jpeg", "webp", "mp4", "mov", "m4a")
EXPORT_POLL_S = 2.0


def _opts(opts: Any) -> Tuple[bool, Optional[float], Any]:
    return bool(getattr(opts, "dry_run", False)), getattr(opts, "wait", None), getattr(opts, "caller", None)


# ── shared guards ─────────────────────────────────────────────────────────────


def export_guard(project: Project, rels: List[str], wait: Optional[float], what: str) -> None:
    """Refuse (exit 3, app-busy), or wait up to `wait` s, while the app exports this project and it uses one of rels."""
    from . import bridge

    deadline = time.monotonic() + (wait or 0)
    while True:
        hb = bridge.live_heartbeat(project)
        busy = bool(hb and hb.get("exporting") and hb.get("openProject") == project.project_id)
        if busy:
            refs = AssetRefs.of(project.root)
            busy = any(refs.references(r) for r in rels)
        if not busy:
            return
        if wait is None or time.monotonic() >= deadline:
            raise KbError(
                f"the app is exporting {project.project_id}, which uses {rels[0]}; {what} now would change the export mid-way",
                EXIT_TRANSIENT,
                kind="app-busy",
                hint="rerun after the export finishes, or pass --wait SECONDS",
                retry_after_ms=10000,
            )
        time.sleep(EXPORT_POLL_S)


def _edited_output(rel: str) -> Optional[str]:
    from .video import editdoc

    return editdoc.name_of_output(rel)


def _app_probe_ok() -> bool:
    from .video import appcli

    try:
        appcli.locate()
        return True
    except KbError:
        return False


def resync(project: Project, rels: List[str], warn: Warn) -> List[Dict[str, Any]]:
    """Follow-media scenes of rels take their (new) video length (repoint.resync_durations); needs the app's CLI."""
    from .video import repoint

    try:
        following = [stem for _i, stem, raw in repoint._scenes(project) if set(rels) & set(repoint.follow_media_sources(raw))]
    except KbError:
        following = []
    if not following:
        return []
    if not _app_probe_ok():
        warn(f"{', '.join(following)} follow{'s' if len(following) == 1 else ''} this video's length, which was not re-synced (no app CLI to probe with): ./kb video durations once the app is installed")
        return []
    try:
        return repoint.resync_durations(project, rels)
    except KbError as e:
        warn(f"follow-media scene lengths were not updated: {e.message}")
        return []


def notify(project: Project, rels: List[str]) -> None:
    """mediaChanged to the running app (it refreshes those files now); without one it picks them up on its next load."""
    from . import bridge

    body = {"project": project.project_id, "projectPath": str(project.root.resolve()), "paths": rels}
    bridge.notify("mediaChanged", body, timeout=30)


def _basic(path: Path) -> Dict[str, Any]:
    """Width, height and durationMs from ffprobe (or the image reader); empty when unreadable."""
    import subprocess

    out: Dict[str, Any] = {}
    exe = assetmod.ffprobe_path()
    if exe:
        try:
            proc = subprocess.run([exe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)], capture_output=True, text=True, timeout=30)
            data = json.loads(proc.stdout or "{}") if proc.returncode == 0 else {}
        except (OSError, subprocess.TimeoutExpired, ValueError):
            data = {}
        video = next((s for s in data.get("streams") or [] if isinstance(s, dict) and s.get("codec_type") == "video"), None)
        if video:
            out["width"], out["height"] = video.get("width"), video.get("height")
        try:
            if (data.get("format") or {}).get("duration") and assetmod.kind_of(path.name) != "image":
                out["durationMs"] = int(round(float(data["format"]["duration"]) * 1000))
        except (TypeError, ValueError):
            pass
    if "width" not in out:
        dims = assetmod.image_size(path)
        if dims:
            out["width"], out["height"] = dims
    return out


def _meta_in(tx: lockmod.Txn) -> Tuple[Optional[Dict[str, Any]], str]:
    """assets/_meta.json read inside tx, or (None, hash) when it is missing, unreadable or another version: provenance
    is a side record, so a broken one never blocks moving media."""
    try:
        doc, sha = tx.read_json(asset_meta.META_REL)
    except KbError:
        return None, tx.hash(asset_meta.META_REL)
    ok = isinstance(doc, dict) and doc.get("version") == asset_meta.META_VERSION and isinstance(doc.get("assets"), dict)
    return (doc if ok else None), sha


# ── re-pointing literals ──────────────────────────────────────────────────────


def _count_standalone(text: str, needle: str) -> int:
    n, i = 0, 0
    while True:
        pos = text.find(needle, i)
        if pos < 0:
            return n
        end = pos + len(needle)
        if (pos == 0 or not tsxmod._path_byte(text[pos - 1])) and (end == len(text) or not tsxmod._path_byte(text[end])):
            n += 1
        i = end


def _count_json(value: Any, targets: Tuple[str, ...]) -> int:
    if isinstance(value, str):
        return int(value in targets)
    if isinstance(value, list):
        return sum(_count_json(v, targets) for v in value)
    if isinstance(value, dict):
        return sum(_count_json(v, targets) for v in value.values())
    return 0


def _project_files(project: Project) -> List[str]:
    out = ["project.json"]
    scenes = project.scenes_dir
    for dirpath, dirnames, filenames in os.walk(scenes):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith(".") or not name.endswith((".json", ".tsx")):
                continue
            out.append((Path(dirpath) / name).relative_to(project.root).as_posix())
    return out


def plan_repoint(tx: lockmod.Txn, project: Project, old: str, new: str) -> Dict[str, Any]:
    """Re-point exact JSON strings and TSX literals from old to new inside tx (scenes.py's rewrite_*_asset_refs).
    Template-literal and concatenation hits, edit documents and workspace themes are reported, never rewritten."""
    pairs = [(old, new), (f"./{old}", f"./{new}")]
    rewrites: List[Dict[str, Any]] = []
    for rel in _project_files(project):
        data, sha = tx.read(rel)
        if data is None:
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if old not in text:
            continue
        if rel.endswith(".json"):
            try:
                doc = json.loads(text)
            except ValueError:
                continue
            count = _count_json(doc, (old, f"./{old}"))
            if count:
                tx.write_json(rel, rewrite_json_asset_refs(doc, pairs), base=sha)
                rewrites.append({"file": rel, "count": count})
        else:
            count = _count_standalone(text, old) + _count_standalone(text, f"./{old}")
            fresh = tsxmod.rewrite_text_asset_refs(text, pairs)
            if fresh != text:
                tx.write_text(rel, fresh, base=sha)
                rewrites.append({"file": rel, "count": count})
    refs = AssetRefs.of(project.root)
    patterns = [{"file": f, "pattern": g} for g, f in refs.pattern_hits(old)]
    elsewhere = [{"file": f.display, "kind": f.kind} for f in refs.substring_hits(old) if f.kind in ("edit", "theme")]
    return {"rewrites": rewrites, "patterns": patterns, "elsewhere": elsewhere}


# ── conform ───────────────────────────────────────────────────────────────────


def conform_asset(project: Project, ref: str, *, repoint: bool, opts: Any, warn: Warn, progress: Optional[Callable[[str], None]] = None) -> Dict[str, Any]:
    """Conform an asset in place (same name and container, as the app's Conform), or with repoint a non-mp4 into
    assets/<stem>.mp4 with every literal re-pointed. The original goes to assets/.originals/."""
    from . import conform as conformmod
    from . import git as gitmod

    dry_run, wait, caller = _opts(opts)
    rel = assetmod.resolve(project, ref)
    ext = assetmod.ext_of(rel)
    if ext not in conformmod.CONFORMABLE_EXTS:
        raise KbError(f"{rel} is not an MP4, MOV or M4V video AVFoundation can conform", EXIT_PROBLEMS, kind="invalid")
    edit = _edited_output(rel)
    if edit:
        raise KbError(f"{rel} is the video editor's render of edits/{edit}.json, already constant-rate", EXIT_PROBLEMS, kind="invalid", hint=f"./kb video render {edit}")
    if assetmod.timing_record(project, rel) is not None:
        raise KbError(f"{rel} is already conformed (its timing record is {assetmod.timing_rel_of(rel)})", EXIT_PROBLEMS, kind="invalid")
    name = rel.rsplit("/", 1)[-1]
    stem = name.rsplit(".", 1)[0]
    original_rel = f"{assetmod.ORIGINALS}/{name}"
    moving = repoint and ext != "mp4"
    if repoint and not moving:
        warn(f"{rel} is already an MP4, so it is conformed in place and nothing needs re-pointing")
    target = f"assets/{stem}.mp4" if moving else rel
    timing = assetmod.timing_rel_of(target)
    if (project.root / original_rel).exists():
        raise KbError(f"{original_rel} already holds an original: move it aside first", EXIT_PROBLEMS, kind="invalid")
    if moving:
        for taken in (target, timing):
            if (project.root / taken).exists():
                raise KbError(f"{taken} already exists, so {rel} can't be conformed to {target}", EXIT_PROBLEMS, kind="invalid",
                              hint=f"./kb assets conform {rel} (in place, keeping the .{ext})")
        if "/" in rel[len("assets/"):]:
            warn(f"the app's conform writes {target} flat in assets/, not beside {rel}")
    export_guard(project, [rel], wait, "conforming it")
    probe = conformmod.import_decision(project.root / rel).get("probe")
    if probe and probe.get("refused"):
        raise KbError(f"{rel} can't be conformed: {probe['refused'].get('hint')}", EXIT_PROBLEMS, kind="invalid")
    if probe and not probe.get("recommended"):
        warn(f"the probe found no reason to conform {rel}; conforming it anyway as asked")
    preview = None
    if moving:
        preview = lockmod.Txn(project, "kb assets conform", dry_run=True, caller=caller)
        plan_repoint(preview, project, rel, target)
        preview.commit()
        if preview.refusals:
            first = preview.refusals[0]
            raise KbError(f"{first['path']} can't be re-pointed: {first['error']}", EXIT_PROBLEMS, kind="leased", data={"refusals": preview.refusals})
    meta_base = lockmod.current_hash(project.root / asset_meta.META_REL)
    writes = [
        {"path": original_rel, "action": "create", "base": lockmod.ABSENT},
        {"path": target, "action": "create" if moving else "modify", "base": lockmod.ABSENT if moving else lockmod.current_hash(project.root / rel)},
        {"path": timing, "action": "create", "base": lockmod.ABSENT},
        {"path": asset_meta.META_REL, "action": "create" if meta_base == lockmod.ABSENT else "modify", "base": meta_base},
    ]
    if preview is not None:
        writes += [w for w in preview.writes]
        writes.append({"path": rel, "action": "trash", "base": lockmod.current_hash(project.root / rel)})
    out: Dict[str, Any] = {"path": target, "source": rel, "original": original_rel, "timing": timing, "inPlace": not moving, "probe": probe}
    if dry_run:
        return dict(out, writes=writes, dryRun=True)
    cli = conformmod.require_media_cli("conform")
    say = assetmod._progress_printer(target, progress)
    if moving:
        (project.root / assetmod.ORIGINALS).mkdir(parents=True, exist_ok=True)
        if not lockmod.link_if_unchanged(project.root / rel, project.root / original_rel, lockmod.ABSENT):
            raise KbError(f"{original_rel} appeared while kb kept the original; rerun", EXIT_TRANSIENT, kind="conflict", retry_after_ms=1000)
        try:
            done = conformmod.media_conform(cli, project.root, original_rel, name=stem, keep="move", on_event=say)
        except BaseException:
            try:
                (project.root / original_rel).unlink()
            except OSError:
                pass
            raise
    else:
        done = conformmod.media_conform(cli, project.root, rel, keep="move", on_event=say)
    try:
        asset_meta.record_origin(project, target, asset_meta.origin("derived", "kb assets conform", source=original_rel, source_name=name),
                                 list(conformmod.TRANSFORMS), opts=opts)
    except KbError as e:
        warn(f"the provenance record was not written: {e.message}")
    out.update(frames=done.get("frames"), durationMs=done.get("durationMs"), bytes=done.get("bytes"), verdict=done.get("verdict"), reasons=done.get("reasons") or [])
    if moving:
        def fn(tx: lockmod.Txn) -> Dict[str, Any]:
            found = plan_repoint(tx, project, rel, target)
            still = found["patterns"] or found["elsewhere"]
            if not still:
                tx.trash(rel, gitmod.trash)
            return found

        found, tx = lockmod.transact(project, "kb assets conform", fn, caller=caller, wait=wait)
        out.update(rewrites=found["rewrites"], patterns=found["patterns"], elsewhere=found["elsewhere"])
        if found["patterns"] or found["elsewhere"]:
            out["kept"] = rel
            warn(f"{rel} stays: {', '.join(sorted({h['file'] for h in found['patterns'] + found['elsewhere']}))} still name it (not rewritten)")
        writes = writes[:4] + tx.writes
    out["durations"] = resync(project, [target], warn)
    notify(project, sorted({rel, target, timing}))
    return dict(out, writes=writes, dryRun=False)


# ── replace ───────────────────────────────────────────────────────────────────


def replace_asset(project: Project, ref: str, file: str, *, keep_old: str, as_new: bool, opts: Any, warn: Warn) -> Dict[str, Any]:
    """Replace an asset's bytes in place (the old file to .kb/archive/, the Trash or nowhere), or with as_new copy the
    new file in beside it and re-point every literal."""
    dry_run, wait, caller = _opts(opts)
    rel = assetmod.resolve(project, ref)
    src = Path(file).expanduser()
    if not src.is_file():
        raise KbError(f"{file} is not a file", EXIT_PROBLEMS, kind="invalid")
    if assetmod.is_companion(rel):
        raise KbError(f"{rel} is kb's own record, not an asset", EXIT_ENV, kind="usage")
    edit = _edited_output(rel)
    if edit:
        raise KbError(f"{rel} is the video editor's render of edits/{edit}.json; change the edit and render it instead", EXIT_PROBLEMS, kind="invalid",
                      hint=f"./kb video render {edit}")
    if assetmod.ext_of(src.name) != assetmod.ext_of(rel):
        raise KbError(f"{src.name} is a .{assetmod.ext_of(src.name) or '?'} and {rel} a .{assetmod.ext_of(rel)}: a replace keeps the name, so it keeps the type",
                      EXIT_PROBLEMS, kind="invalid", hint=f"./kb assets add {file}, then point the scenes at the path it prints")
    new_sha = lockmod.file_sha256(src)
    old_sha = lockmod.current_hash(project.root / rel)
    if new_sha == old_sha:
        return {"path": rel, "bytes": src.stat().st_size, "old": {"to": None}, "probe": None, "durations": [], "writes": [], "unchanged": True,
                "note": "identical file, nothing to replace", "dryRun": dry_run}
    if not as_new:
        export_guard(project, [rel], wait, "replacing it")
    used = assetmod.usage(project).get(rel, [])
    sources = [u for u in used if u.startswith("edits/")]
    if sources:
        warn(f"{rel} is a source of {', '.join(sources)}: its taps, masks and cuts were timed to the old footage")
    was = _basic(project.root / rel)
    now = _basic(src)
    if was.get("width") and now.get("width") and (was.get("width"), was.get("height")) != (now.get("width"), now.get("height")):
        warn(f"the new file is {now['width']}x{now['height']}, the old one {was['width']}x{was['height']}: check the scenes that frame it")
    probe = {"durationMs": now.get("durationMs"), "was": was.get("durationMs"), "width": now.get("width"), "height": now.get("height"),
             "wasWidth": was.get("width"), "wasHeight": was.get("height")}
    if as_new:
        return _replace_as_new(project, rel, src, probe, opts, warn)
    ident = archive.new_id(project.root)
    timing = assetmod.timing_rel_of(rel) if assetmod.timing_record(project, rel) is not None else None
    if timing:
        warn(f"{rel} was a conformed video; its timing record goes with the old file")
    from . import git as gitmod

    def fn(tx: lockmod.Txn) -> Dict[str, Any]:
        base = tx.hash(rel)
        moved: List[Tuple[str, str, str]] = []
        if keep_old in ("archive", "trash"):
            for r in [rel] + ([timing] if timing else []):
                dest = archive.dest_for(ident, r)
                sha = base if r == rel else tx.hash(r)
                tx.move(r, dest, base=sha)
                moved.append((r, dest, sha))
        elif timing:
            tx.trash(timing, gitmod.trash)
        tx.copy_over(rel, src, base=base)
        doc, meta_sha = _meta_in(tx)
        record = None
        if doc is not None and isinstance(doc["assets"].get(rel), dict):
            record = json.loads(json.dumps(doc["assets"][rel]))
            fresh = dict(doc["assets"][rel], sha256=new_sha, origin=asset_meta.origin("import", "kb assets replace", source_name=src.name), transforms=[])
            doc["assets"][rel] = fresh
            if timing:
                doc["assets"].pop(timing, None)
            tx.write_json(asset_meta.META_REL, doc, base=meta_sha)
        if keep_old == "archive":
            archive.plan_append(tx, [archive.line(ident, "replace", r, d, s, tx.caller, meta=record if r == rel else None) for r, d, s in moved])
        return {"moved": moved}

    result, tx = lockmod.transact(project, "kb assets replace", fn, dry_run=dry_run, caller=caller, wait=wait)
    old_to: Optional[str] = archive.dest_for(ident, rel) if keep_old == "archive" else None
    out: Dict[str, Any] = {"path": rel, "bytes": src.stat().st_size, "probe": probe}
    if dry_run:
        return dict(out, old={"to": old_to if keep_old != "trash" else "Trash"}, durations=[], writes=tx.writes, dryRun=True)
    if keep_old == "trash":
        old_to = _trash_archived(project, ident, result["moved"], warn)
    out["old"] = {"to": old_to}
    out["durations"] = resync(project, [rel], warn)
    notify(project, [rel])
    return dict(out, writes=tx.writes, dryRun=False)


def _trash_archived(project: Project, ident: str, moved: List[Tuple[str, str, str]], warn: Warn) -> Optional[str]:
    """--keep-old trash: what the transaction moved into .kb/archive/<id>/ goes on to the Trash."""
    from . import git as gitmod

    first: Optional[str] = None
    left: List[Tuple[str, str, str]] = []
    for rel, dest, sha in moved:
        try:
            landed = gitmod.trash(project.root / dest)
            first = first or str(landed)
        except OSError as e:
            warn(f"{rel}'s old version could not go to the Trash ({e}); it stays at {dest}")
            left.append((rel, dest, sha))
    if left:
        lockmod.transact(project, "kb assets replace", lambda tx: archive.plan_append(tx, [archive.line(ident, "replace", r, d, s, tx.caller) for r, d, s in left]))
    folder = project.root / archive.ARCHIVE_DIR / ident
    for dirpath, _dirs, _files in sorted(os.walk(folder), key=lambda t: -len(t[0])):
        try:
            os.rmdir(dirpath)
        except OSError:
            pass
    return first


def _replace_as_new(project: Project, rel: str, src: Path, probe: Dict[str, Any], opts: Any, warn: Warn) -> Dict[str, Any]:
    dry_run, wait, caller = _opts(opts)
    folder = (project.root / rel).parent
    name = free_sibling_name(folder, rel.rsplit("/", 1)[-1])
    new_rel = (folder / name).relative_to(project.root).as_posix()

    def fn(tx: lockmod.Txn) -> Dict[str, Any]:
        tx.copy_in(new_rel, src)
        return plan_repoint(tx, project, rel, new_rel)

    found, tx = lockmod.transact(project, "kb assets replace", fn, dry_run=dry_run, caller=caller, wait=wait)
    if found["patterns"] or found["elsewhere"]:
        warn(f"{', '.join(sorted({h['file'] for h in found['patterns'] + found['elsewhere']}))} still name {rel} (not rewritten)")
    out: Dict[str, Any] = {"path": new_rel, "replaced": rel, "bytes": src.stat().st_size, "old": {"to": None}, "probe": probe,
                           "rewrites": found["rewrites"], "patterns": found["patterns"], "elsewhere": found["elsewhere"]}
    if dry_run:
        return dict(out, durations=[], writes=tx.writes, dryRun=True)
    out["durations"] = resync(project, [new_rel], warn)
    notify(project, [new_rel])
    return dict(out, writes=tx.writes, dryRun=False)


# ── unused, archive, restore ──────────────────────────────────────────────────


def sample_pool() -> List[str]:
    """The restored sample pool's names: catalog.json samplePool (offline), else the app bundle's projects/_samples/."""
    from . import bridge
    from . import catalog as catmod

    entries = catmod.load_catalog().entries("samplePool")
    if entries is not None:
        return [str(e["id"]) for e in entries]
    folder = bridge.samples_dir()
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    return sorted(n for n in names if not n.startswith(".") and assetmod.ext_of(n) in SAMPLE_EXTS and (folder / n).is_file())


def unused_assets(project: Project, kind: Optional[str] = None) -> Dict[str, Any]:
    """{ items: [{ path, kind, bytes }], kept: [{ path, reason, pattern?, file? }], totalBytes, notes } by the shared rule."""
    refs = AssetRefs.of(project.root)
    files = asset_files(project.root)
    pool = sample_pool()
    items: List[Dict[str, Any]] = []
    kept: List[Dict[str, Any]] = []
    for rel in files:
        why = refs.kept(rel, files, pool)
        size = (project.root / rel).stat().st_size
        k = "data" if assetmod.is_companion(rel) else assetmod.kind_of(rel)
        if kind and k != kind:
            continue
        if why is not None:
            kept.append(dict(why, kind=k, bytes=size))
        elif not refs.in_use(rel, files):
            items.append({"path": rel, "kind": k, "bytes": size})
    notes: List[str] = []
    media = [f for f in files if not assetmod.is_companion(f)]
    for glob in refs.patterns():
        if media and all(glob_matches(glob, f) for f in media):
            where = sorted({d for f in media[:1] for g, d in refs.pattern_hits(f) if g == glob})
            notes.append(f'the pattern "{glob}" in {", ".join(where)} covers every file in assets/, so none can be reported unused')
    return {"items": items, "kept": kept, "totalBytes": sum(i["bytes"] for i in items), "notes": notes}


def archive_unused(project: Project, kind: Optional[str], folder: Optional[str], opts: Any) -> Dict[str, Any]:
    """Move every unused file (recomputed under the lock) to .kb/archive/<id>/ (or <folder>/<id>/), with index lines."""
    dry_run, wait, caller = _opts(opts)
    ident = archive.new_id(project.root)
    custom = _archive_folder(project, folder) if folder else None

    def fn(tx: lockmod.Txn) -> Dict[str, Any]:
        found = unused_assets(project, kind)
        doc, meta_sha = _meta_in(tx)
        records = doc["assets"] if doc is not None else {}
        lines = []
        moved = []
        for item in found["items"]:
            rel = item["path"]
            dest = archive.dest_for(ident, rel, custom)
            sha = tx.hash(rel)
            tx.move(rel, dest, base=sha)
            record = records.get(rel)
            lines.append(archive.line(ident, "unused", rel, dest, sha, tx.caller, meta=record))
            moved.append({"from": rel, "to": dest, "bytes": item["bytes"]})
        if doc is not None and any(m["from"] in records for m in moved):
            for m in moved:
                doc["assets"].pop(m["from"], None)
            tx.write_json(asset_meta.META_REL, doc, base=meta_sha)
        archive.plan_append(tx, lines)
        return dict(found, moved=moved)

    found, tx = lockmod.transact(project, "kb assets unused --archive", fn, dry_run=dry_run, caller=caller, wait=wait)
    moved = found.pop("moved")
    found["archived"] = {"id": ident, "dir": custom or archive.ARCHIVE_DIR, "count": len(moved), "bytes": sum(m["bytes"] for m in moved), "items": moved}
    if moved and not dry_run:
        notify(project, [m["from"] for m in moved])
    return dict(found, writes=tx.writes, dryRun=dry_run)


def _archive_folder(project: Project, folder: str) -> str:
    """A custom archive folder: outside assets/; project-relative when inside the project, else absolute."""
    path = Path(folder).expanduser()
    path = path if path.is_absolute() else (Path.cwd() / path)
    path = Path(os.path.abspath(str(path)))
    assets = Path(os.path.abspath(str(project.assets_dir)))
    if path == assets or assets in path.parents:
        raise KbError(f"{folder} is inside assets/; archive somewhere else (the default is {archive.ARCHIVE_DIR}/)", EXIT_ENV, kind="usage")
    root = Path(os.path.abspath(str(project.root)))
    if path == root:
        raise KbError("the project folder itself can't be the archive", EXIT_ENV, kind="usage")
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def restore(project: Project, ident: Optional[str], opts: Any) -> Dict[str, Any]:
    """Put a batch back: each file to its old path; a different file there now is archived first (a "displaced" batch,
    itself restorable), so a restore never loses bytes."""
    dry_run, wait, caller = _opts(opts)
    batch = archive.pick(project.root, ident)
    new = archive.new_id(project.root)

    def fn(tx: lockmod.Txn) -> Dict[str, Any]:
        lines = []
        restored: List[Dict[str, Any]] = []
        displaced: List[Dict[str, Any]] = []
        skipped: List[Dict[str, Any]] = []
        records: Dict[str, Any] = {}
        for item in batch["items"]:
            source, to, sha = str(item["from"]), str(item["to"]), str(item.get("sha256") or "")
            if not item["present"]:
                skipped.append({"path": source, "why": f"{to} is gone"})
                continue
            current = tx.hash(source)
            if current == sha:
                skipped.append({"path": source, "why": "already back"})
                lines.append(archive.line(new, "restore", to, source, sha, tx.caller, restores=batch["id"]))
                continue
            if current == lockmod.ABSENT:
                tx.move(to, source)
            else:
                aside = archive.dest_for(new, source)
                tx.move(source, aside, base=current)
                tx.move(to, source, dest_base=current)
                lines.append(archive.line(new, "displaced", source, aside, current, tx.caller))
                displaced.append({"path": source, "to": aside})
            lines.append(archive.line(new, "restore", to, source, sha, tx.caller, restores=batch["id"]))
            restored.append({"path": source, "from": to})
            if item.get("meta") is not None:
                records[source] = item["meta"]
        if records:
            doc, meta_sha = _meta_in(tx)
            if doc is None and meta_sha == lockmod.ABSENT:
                doc = {"version": asset_meta.META_VERSION, "assets": {}}
            if doc is not None:
                doc["assets"].update(records)
                tx.write_json(asset_meta.META_REL, doc, base=meta_sha)
        archive.plan_append(tx, lines)
        return {"restored": restored, "displaced": displaced, "skipped": skipped}

    found, tx = lockmod.transact(project, "kb assets restore", fn, dry_run=dry_run, caller=caller, wait=wait)
    if found["restored"] and not dry_run:
        notify(project, [r["path"] for r in found["restored"]])
    return dict(found, id=batch["id"], displacedId=new if found["displaced"] else None, writes=tx.writes, dryRun=dry_run)


# ── meta ──────────────────────────────────────────────────────────────────────


def parse_sets(pairs: List[str]) -> List[Tuple[str, Any]]:
    out = []
    for pair in pairs:
        key, sep, raw = pair.partition("=")
        if not sep or not key.strip():
            raise KbError(f"--set takes KEY=VALUE, not {pair!r}", EXIT_ENV, kind="usage")
        try:
            value = json.loads(raw)
        except ValueError:
            value = raw
        out.append((key.strip(), value))
    return out


def meta(project: Project, ref: str, sets: List[str], opts: Any) -> Dict[str, Any]:
    rel = assetmod.resolve(project, ref, must_exist=False)
    changes = parse_sets(sets)
    writes: List[Dict[str, Any]] = []
    if changes:
        if not (project.root / rel).is_file() and rel not in asset_meta.read(project.root)["assets"]:
            raise KbError(f"{rel} does not exist", EXIT_PROBLEMS, kind="invalid", hint="./kb assets list")
        mut = asset_meta.set_fields(project, rel, changes, opts)
        writes = mut.writes
    if getattr(opts, "dry_run", False) and changes:
        record = mut.after["assets"].get(rel) if isinstance(mut.after, dict) else None
        current = asset_meta.file_hash(project.root, rel)
        return {"path": rel, "record": record, "stale": record is not None and asset_meta.is_stale(record, current), "sha256": current, "writes": writes, "dryRun": True}
    out = asset_meta.record_of(project.root, rel)
    return dict(out, writes=writes, dryRun=bool(getattr(opts, "dry_run", False)))
