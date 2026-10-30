"""kb assets: list, add and add-folder (conforming flagged videos through the app, checking stills), probe, conform, replace, unused, restore, meta."""

from __future__ import annotations

import argparse
import json
from typing import Any, Dict, List, Optional

from .util import EXIT_OK, emit, emit_err

EPILOG = """\
  ./kb assets list                                every file in assets/ and who uses it
  ./kb assets add ~/Desktop/rec.mov               copy in; a VFR, edit-listed or P3 video is conformed
  ./kb assets add ~/Desktop/rec.mov --no-conform  copy it as it is
  ./kb assets add ~/Desktop/hero.png --name cover --max-size 3840
                                                  assets/cover.png, its long edge capped at 3840 px
  ./kb assets add ~/Desktop/logo.svg              rasterised to assets/logo.png (2048 px, or --max-size)
  ./kb assets add-folder ~/Desktop/launch --dedupe --thumbs 240x160 --dir launch
                                                  the whole folder, duplicates once, and a sheet to Read
  ./kb assets probe assets/rec.mov [--deep]       size, rate and the conform verdict
  ./kb assets conform assets/rec.mov              conform in place (same name, the original kept)
  ./kb assets conform assets/rec.mov --repoint    into assets/rec.mp4, every scene re-pointed
  ./kb assets replace assets/logo.png ~/new.png   new bytes, same name; the old file to .kb/archive/
  ./kb assets unused [--kind video] [--archive]   what nothing uses (--archive moves it aside)
  ./kb assets restore [ID | --list]               put an archived batch back
  ./kb assets meta assets/rec.mp4 [--set licence.id=CC-BY-4.0]

Videos conform through the app's media CLI: the original goes to assets/.originals/, the
constant-rate mezzanine keeps the name scenes reference, and assets/<stem>.timing.json
records which source frame every frame shows. Provenance lives in assets/_meta.json.

Stills are decoded on the way in. A file that isn't what its name says lands under its real
extension; a colour profile, CMYK pixels or an EXIF turn, which the stage ignores, are baked
into plain sRGB pixels; a fully transparent or one-colour result is refused (--allow-blank)."""


def _warn(ctx: Any) -> Any:
    sink: List[str] = []

    def warn(text: str) -> None:
        sink.append(text)
        emit_err(f"kb: {text}")

    warn.sink = sink  # type: ignore[attr-defined]
    return warn


def _writes(res: Dict[str, Any]) -> None:
    for w in res.get("writes") or []:
        tail = f" (from {w['from']})" if w.get("from") else (f" (to {w['to']})" if w.get("to") else "")
        emit(f"  {w['action']:<6} {w['path']}{tail}")


def cmd_list(ctx: Any) -> int:
    from . import assets as assetmod

    items = assetmod.list_assets(ctx.project)
    if ctx.json:
        ctx.out({"assets": items})
        return EXIT_OK
    if not items:
        emit("assets/ is empty; copy media in with ./kb assets add <file>")
        return EXIT_OK
    for item in items:
        used = ", ".join(item["usedBy"]) if item["usedBy"] else "unused"
        extra = []
        timing = item.get("timing")
        if timing:
            extra.append(f"conformed from {timing.get('original')}: {timing.get('frames')} frames, {timing.get('holds')} holds")
        origin = item.get("origin")
        if origin and not timing:
            extra.append(f"{origin.get('kind')} via {origin.get('tool')}")
        if item.get("stale"):
            extra.append("provenance stale")
        tail = f"  [{'; '.join(extra)}]" if extra else ""
        emit(f"{item['path']}  {item['kind']}  {assetmod.human_size(item['bytes'])}  ({used}){tail}")
    return EXIT_OK


def cmd_add(ctx: Any) -> int:
    from . import assets as assetmod

    a = ctx.args
    warn = _warn(ctx)
    res = assetmod.add(ctx.project, a.file, a.name, a.dir, dry_run=ctx.dry_run, conform=not a.no_conform, opts=ctx.opts, progress=lambda t: emit_err(f"kb: {t}"),
                       max_size=a.max_size, allow_blank=a.allow_blank)
    for text in res.get("warnings") or []:
        warn(text)
    if ctx.json:
        ctx.out(res)
        return EXIT_OK
    if ctx.dry_run:
        if res["writes"]:
            what = "conform" if res.get("original") else "copy"
            emit(f"dry run, nothing written: would {what} {a.file} into {res['path']}")
            _writes(res)
        else:
            emit(f"{res['path']} ({res.get('note') or 'already in assets/'})")
    else:
        emit(res["path"])
        if res.get("conformed") and res.get("copied") and res.get("original"):
            why = ", ".join((res.get("probe") or {}).get("why") or []) or "flagged"
            emit_err(f"kb: conformed ({why}); the original is kept at {res['original']}")
    if res.get("note"):
        emit_err(f"kb: {res['note']}")
    if not ctx.dry_run and res.get("kind") in ("video", "audio"):
        emit_err(f"kb: ./kb assets probe {res['path']} gives its duration for durationMs")
    return EXIT_OK


def cmd_add_folder(ctx: Any) -> int:
    from . import asset_folder
    from . import assets as assetmod

    a = ctx.args
    res = asset_folder.add_folder(ctx.project, a.folder, dedupe=a.dedupe, thumbs=asset_folder.parse_thumbs(a.thumbs), limit=a.limit, subdir=a.dir, max_size=a.max_size,
                                  conform=not a.no_conform, allow_blank=a.allow_blank, dry_run=ctx.dry_run, opts=ctx.opts, progress=lambda t: emit_err(f"kb: {t}"), agent=ctx.caller.name)
    for text in res["warnings"]:
        emit_err(f"kb: {text}")
    if not ctx.json:
        verb = "would add" if ctx.dry_run else "added"
        for item in res["items"]:
            state = "" if item["copied"] or ctx.dry_run else "  (already here)"
            emit(f"{item['path']}  <- {item['file']}{state}")
        for d in res["duplicates"]:
            emit(f"duplicate {d['file']}: same bytes as {d['of']}")
        for s in res["skipped"]:
            emit(f"skipped {s['file']}: {s['why']}")
        for r in res["refused"]:
            emit(f"refused {r['file']}: {r['error']}")
        landing = sum(1 for w in res["writes"] if w["path"] != assetmod.META_REL) if ctx.dry_run else res["copied"]
        emit(f"{verb} {landing} of {len(res['items']) + len(res['duplicates']) + len(res['refused'])} media files from {res['folder']}"
             + (f"; left alone: {res['otherFiles']} other file(s)" if res["otherFiles"] else ""))
        if res["remaining"]:
            emit(f"{res['remaining']} more past --limit {a.limit}")
        thumbs = res.get("thumbs") or {}
        for sheet in thumbs.get("sheets") or []:
            emit(f"sheet to Read: {sheet}")
        if thumbs.get("more"):
            emit(f"{thumbs['more']} more imported than the sheets show")
    if res["refused"]:
        from .util import EXIT_PROBLEMS, KbError

        raise KbError(f"{len(res['refused'])} of the folder's files were refused and the rest landed; fix those and rerun, nothing lands twice", EXIT_PROBLEMS, kind="invalid",
                      hint="./kb assets add-folder prints each one with its reason", data=res)
    if ctx.json:
        ctx.out(res)
    return EXIT_OK


def cmd_probe(ctx: Any) -> int:
    from . import assets as assetmod

    info = assetmod.probe(ctx.project, ctx.args.asset, deep=ctx.args.deep)
    decode = info.get("decode") or {}
    if decode.get("verdict") == "ffmpeg-misdecodes":
        emit_err(f"kb: warning: ffmpeg misdecodes {info['path']} ({', '.join(decode.get('reasons') or [])}): previews and exports show the wrong frames; ./kb assets conform {info['path']}")
    if ctx.json:
        ctx.out(info)
        return EXIT_OK
    image = info.get("image") or {}
    if image.get("blank"):
        emit_err(f"kb: warning: {info['path']} draws nothing useful ({image['blank']})")
    if image.get("conform"):
        emit_err(f"kb: warning: {info['path']} will draw wrong in a frame ({', '.join(image['conform'])}); add its source again so kb converts it")
    for key, value in info.items():
        if key == "decode":
            continue
        emit(f"{key}: {json.dumps(value) if isinstance(value, (dict, list)) else value}")
    if decode:
        conform = decode.get("conform") or {}
        emit(f"verdict: {decode.get('verdict')} ({', '.join(decode.get('reasons') or []) or 'no findings'}; checked: {', '.join(decode.get('checks') or []) or 'nothing'})")
        if decode.get("editList"):
            emit("editList: " + ", ".join(f"{e.get('mediaTimeMs')} ms for {e.get('durationMs')} ms at {e.get('rate')}x" for e in decode["editList"]))
        colour = decode.get("colour") or {}
        emit(f"colour: {colour.get('primaries') or '?'}/{colour.get('transfer') or '?'}/{colour.get('matrix') or '?'}" + (" (needs converting)" if colour.get("needsConvert") else ""))
        if conform.get("refused"):
            emit(f"conform: refused ({conform['refused'].get('code')}): {conform['refused'].get('hint')}")
        elif conform.get("recommended"):
            emit(f"conform: recommended ({', '.join(conform.get('why') or [])}): {conform.get('command')}")
        else:
            emit("conform: not needed")
        if decode.get("appNote"):
            emit(f"note: {decode['appNote']}")
    return EXIT_OK


def cmd_conform(ctx: Any) -> int:
    from . import asset_ops

    warn = _warn(ctx)
    res = asset_ops.conform_asset(ctx.project, ctx.args.asset, repoint=ctx.args.repoint, opts=ctx.opts, warn=warn, progress=lambda t: emit_err(f"kb: {t}"))
    res["warnings"] = list(warn.sink)
    if ctx.json:
        ctx.out(res)
        return EXIT_OK
    if res.get("dryRun"):
        emit(f"dry run, nothing written: would conform {res['source']} into {res['path']}")
        _writes(res)
        return EXIT_OK
    emit(res["path"])
    emit_err(f"kb: conformed {res['source']}: {res.get('frames')} frames; the original is kept at {res['original']}")
    for r in res.get("rewrites") or []:
        emit_err(f"kb: re-pointed {r['count']} reference(s) in {r['file']}")
    for d in res.get("durations") or []:
        emit_err(f"kb: scene {d['scene']} now lasts {d['toMs']} ms (was {d['fromMs']})")
    return EXIT_OK


def cmd_replace(ctx: Any) -> int:
    from . import asset_ops
    from .util import EXIT_ENV, KbError

    a = ctx.args
    if a.as_new and a.keep_old is not None:
        raise KbError("--keep-old has no effect with --as-new (the old file stays where it is)", EXIT_ENV, kind="usage")
    warn = _warn(ctx)
    res = asset_ops.replace_asset(ctx.project, a.name, a.file, keep_old=a.keep_old or "archive", as_new=a.as_new, opts=ctx.opts, warn=warn)
    res["warnings"] = list(warn.sink)
    if ctx.json:
        ctx.out(res)
        return EXIT_OK
    if res.get("unchanged"):
        emit(f"{res['path']} (identical file, nothing to replace)")
        return EXIT_OK
    if res.get("dryRun"):
        emit(f"dry run, nothing written: would replace {res.get('replaced') or res['path']}")
        _writes(res)
        return EXIT_OK
    emit(res["path"])
    if res.get("replaced"):
        for r in res.get("rewrites") or []:
            emit_err(f"kb: re-pointed {r['count']} reference(s) in {r['file']}")
    elif (res.get("old") or {}).get("to"):
        emit_err(f"kb: the old version is at {res['old']['to']}" + (" (./kb assets restore puts it back)" if not str(res["old"]["to"]).startswith("/") else ""))
    for d in res.get("durations") or []:
        emit_err(f"kb: scene {d['scene']} now lasts {d['toMs']} ms (was {d['fromMs']})")
    return EXIT_OK


def cmd_unused(ctx: Any) -> int:
    from . import asset_ops
    from . import assets as assetmod

    a = ctx.args
    if a.archive is None:
        res = asset_ops.unused_assets(ctx.project, a.kind)
    else:
        res = asset_ops.archive_unused(ctx.project, a.kind, a.archive or None, ctx.opts)
    if ctx.json:
        ctx.out(res)
        return EXIT_OK
    for note in res.get("notes") or []:
        emit_err(f"kb: {note}")
    if not res["items"]:
        emit("nothing in assets/ is unused" + (f" (of kind {a.kind})" if a.kind else ""))
    for item in res["items"]:
        emit(f"{item['path']}  {item['kind']}  {assetmod.human_size(item['bytes'])}")
    if res["items"]:
        emit(f"{len(res['items'])} unused, {assetmod.human_size(res['totalBytes'])}")
    for k in res.get("kept") or []:
        why = {"sample": "a bundled sample the app restores", "companion": "a record that belongs to " + str(k.get("file") or "the project"),
               "theme": f"used by {k.get('file')}", "pattern": f"matches {k.get('pattern')} in {k.get('file')}"}.get(k["reason"], k["reason"])
        emit(f"  kept {k['path']}: {why}")
    archived = res.get("archived")
    if archived:
        verb = "would move" if res.get("dryRun") else "moved"
        emit(f"{verb} {archived['count']} file(s) ({assetmod.human_size(archived['bytes'])}) to {archived['dir']}/{archived['id']}/" + ("" if res.get("dryRun") else f"; ./kb assets restore {archived['id']} puts them back"))
    return EXIT_OK


def cmd_restore(ctx: Any) -> int:
    from . import archive
    from . import asset_ops

    a = ctx.args
    if a.list:
        found = archive.batches(ctx.project.root)
        if ctx.json:
            ctx.out({"batches": found})
            return EXIT_OK
        if not found:
            emit("nothing in .kb/archive/")
        for b in found:
            state = "restored" if b["restored"] else f"{b['present']} of {len(b['items'])} file(s) archived"
            emit(f"{b['id']}  {b['op']}  {state}  " + ", ".join(i["from"] for i in b["items"][:4]) + (" ..." if len(b["items"]) > 4 else ""))
        return EXIT_OK
    res = asset_ops.restore(ctx.project, a.id, ctx.opts)
    if ctx.json:
        ctx.out(res)
        return EXIT_OK
    verb = "would restore" if res.get("dryRun") else "restored"
    for r in res["restored"]:
        emit(f"{verb} {r['path']}")
    for d in res["displaced"]:
        emit_err(f"kb: the file that was at {d['path']} is now at {d['to']} (./kb assets restore {res['displacedId']})")
    for s in res["skipped"]:
        emit_err(f"kb: skipped {s['path']}: {s['why']}")
    return EXIT_OK


def cmd_meta(ctx: Any) -> int:
    from . import asset_ops

    res = asset_ops.meta(ctx.project, ctx.args.name, ctx.args.set or [], ctx.opts)
    if ctx.json:
        ctx.out(res)
        return EXIT_OK
    if res.get("dryRun"):
        emit("dry run, nothing written:")
        _writes(res)
    if res["record"] is None:
        emit(f"{res['path']}: no provenance record (./kb assets meta {res['path']} --set licence.id=... starts one)")
        return EXIT_OK
    emit(json.dumps(res["record"], indent=2, ensure_ascii=False))
    if res["stale"]:
        emit(f"stale: {res['path']} changed since this record was written (its sha256 no longer matches)")
    return EXIT_OK


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """kb assets and its operations on kb's top-level subparsers."""
    structural = argparse.ArgumentParser(add_help=False)
    structural.add_argument("--dry-run", action="store_true", help="list the files this would change; write nothing")
    structural.add_argument("--wait", type=float, nargs="?", const=600.0, default=None, metavar="SECONDS",
                            help="wait for another kb write (default 10 s) and, where it matters, for the app's export")
    writes = [common, structural]
    s = sub.add_parser("assets", help="media in assets/: list, add, add-folder, probe, conform, replace, unused, restore, meta",
                       description="media in assets/: list, add, add-folder, probe, conform, replace, unused, restore and provenance",
                       epilog=EPILOG, formatter_class=Formatter, parents=[common])
    asub = s.add_subparsers(dest="op", metavar="OP")
    asub.required = True

    def op(name: str, help_: str, parents: List[argparse.ArgumentParser], epilog: Optional[str] = None) -> argparse.ArgumentParser:
        return asub.add_parser(name, help=help_, description=help_, epilog=epilog, formatter_class=Formatter, parents=parents)

    y = op("list", "every file under assets/ and who uses it, with a conformed video's timing and its provenance", [common])
    y.set_defaults(fn=cmd_list)
    y = op("add", "copy a file into assets/ (never overwrites; a flagged video is conformed; prints the path to use)", writes,
           epilog="A video the app's probe flags (VFR, an edit list, P3 colour, a decoder disagreement) lands as\n"
           "assets/<stem>.mp4 with its original in assets/.originals/ and a timing record. HDR and 10-bit\n"
           "videos are copied as they are. Without the app the file is copied and kb says it wasn't checked.\n"
           "A clip the static probe passes is decoded by both decoders before kb skips its conform.\n"
           "A still lands under its real extension, in plain sRGB and upright, and never blank; an SVG is\n"
           "stripped of anything that reaches outside the file and rasterised to a PNG.")
    y.add_argument("file", metavar="FILE")
    y.add_argument("--name", help="file name inside assets/; the source's extension is kept")
    y.add_argument("--dir", help="subfolder of assets/")
    y.add_argument("--no-conform", action="store_true", help="copy a video or still as it is, even when the probe flags it")
    y.add_argument("--max-size", type=int, metavar="N", help="cap an image's long edge at N px (an SVG rasterises to exactly N; default 2048)")
    y.add_argument("--allow-blank", action="store_true", help="take a fully transparent or one-colour image, which is otherwise refused")
    y.set_defaults(fn=cmd_add)
    y = op("add-folder", "copy a whole folder of media into assets/, keeping its shape under kebab-case names", writes,
           epilog="Every file gets what kb assets add gives it, and one file's trouble never stops the rest; rerun\n"
           "after fixing it, since nothing lands twice. Links, hidden files and other file types are passed\n"
           "over. Reads outside the workspace are announced, and credentials are refused. Past 500 files kb\n"
           "stops and asks for --limit (2000 at most).")
    y.add_argument("folder", metavar="DIR")
    y.add_argument("--dedupe", action="store_true", help="the same bytes land once: in the folder, in assets/, or imported before")
    y.add_argument("--thumbs", metavar="WxH", help="write contact sheets of what landed to .kb/thumbs/, each picture fitted in WxH, and print their paths")
    y.add_argument("--limit", type=int, metavar="N", help="take the first N files in name order")
    y.add_argument("--dir", help="subfolder of assets/ to mirror the folder under")
    y.add_argument("--no-conform", action="store_true", help="copy videos and stills as they are")
    y.add_argument("--max-size", type=int, metavar="N", help="cap each image's long edge at N px (SVGs rasterise to exactly N; default 2048)")
    y.add_argument("--allow-blank", action="store_true", help="take fully transparent or one-colour images")
    y.set_defaults(fn=cmd_add_folder)
    y = op("probe", "duration, size, fps and codecs; for a video the conform verdict (ok, suspect, ffmpeg-misdecodes)", [common],
           epilog="The container's edit list and sample tables are read without the app; with the app (or --deep)\n"
           "AVFoundation's view is added. --deep also decodes the video and compares the two decoders.")
    y.add_argument("asset", metavar="ASSET")
    y.add_argument("--deep", action="store_true", help="decode the video and compare what ffmpeg shows with the true timeline")
    y.set_defaults(fn=cmd_probe)
    y = op("conform", "conform a video through the app: in place (name and container kept), or --repoint into <stem>.mp4", writes,
           epilog="The original goes to assets/.originals/; assets/<stem>.timing.json records the frame map. With\n"
           "--repoint a .mov becomes assets/<stem>.mp4 and JSON strings and TSX literals follow it; template\n"
           "literals, edit documents and themes that name it are reported (and the old file stays).")
    y.add_argument("asset", metavar="ASSET")
    y.add_argument("--repoint", action="store_true", help="a non-MP4 becomes assets/<stem>.mp4 and every literal is re-pointed")
    y.set_defaults(fn=cmd_conform)
    y = op("replace", "new bytes under the same name (the old file to .kb/archive/), or --as-new beside it", writes,
           epilog="Refuses another extension, an editor render (*-edited.mp4) and a running export of a project\n"
           "using it (unless --wait). Follow-media scene lengths re-sync and the running app refreshes.")
    y.add_argument("name", metavar="NAME", help="the asset to replace (assets/... or a name in assets/)")
    y.add_argument("file", metavar="FILE", help="the new file")
    y.add_argument("--keep-old", choices=["archive", "trash", "none"], default=None, help="where the old file goes (default archive: .kb/archive/)")
    y.add_argument("--as-new", action="store_true", help="keep both: copy FILE in under a new name and re-point the literals")
    y.set_defaults(fn=cmd_replace)
    y = op("unused", "files nothing uses, by the app's in-use rule (samples, timing records, patterns and themes kept)", writes,
           epilog="--archive moves them to .kb/archive/<id>/ (or DIR/<id>/, outside assets/); restore brings them back.")
    y.add_argument("--kind", choices=["image", "video", "audio", "environment", "data", "lut", "model", "other"], help="only this kind")
    y.add_argument("--archive", nargs="?", const="", default=None, metavar="DIR", help="move them aside (default .kb/archive/)")
    y.set_defaults(fn=cmd_unused)
    y = op("restore", "put an archived batch back (default: the newest one not restored)", writes)
    y.add_argument("id", nargs="?", metavar="ID", help="the batch id (./kb assets restore --list)")
    y.add_argument("--list", action="store_true", help="list the archive's batches")
    y.set_defaults(fn=cmd_restore)
    y = op("meta", "an asset's provenance record in assets/_meta.json (origin, licence, transforms)", writes,
           epilog="  ./kb assets meta assets/rec.mp4\n"
           "  ./kb assets meta assets/rec.mp4 --set licence.id=CC-BY-4.0 --set licence.holder=\"Studio\"\n"
           "VALUE is JSON when it parses, else a string; null removes the key. sha256 is kb's to keep.")
    y.add_argument("name", metavar="NAME")
    y.add_argument("--set", action="append", metavar="KEY=VALUE", help="set a dotted key in the record (repeatable)")
    y.set_defaults(fn=cmd_meta)
