"""A stand-in for `<app>/Contents/MacOS/kookaburra-cut edit ...` (docs/agent-video-contract.md section 1), for kb's tests.

Probes come from `<asset>.probe.json` beside the file (or a fake render's own JSON bytes, or a PNG header). Knobs:
FAKE_CLI_FAIL=cmd[,cmd] fails those commands, FAKE_CLI_SLEEP=s between render progress lines, FAKE_CLI_LOG=path
appends each argv as a JSON line, FAKE_CLI_CAPS={json} overrides caps fields, FAKE_CLI_MALFORMED=cmd prints junk,
FAKE_CLI_NOISE=1 mixes junk lines into render output, FAKE_CLI_RACE=marker makes the first save find the doc changed underneath it (a racing editor), FAKE_CLI_RAN=path
is touched on every run. `check flashes` answers FAKE_CLI_FLASH_REPORT (a JSON file), else a clean report. `song
analyse` answers FAKE_CLI_SONG (a JSON analysis), else a steady 120 bpm click; FAKE_CLI_SONG_CACHED=1 says it was cached.
`media probe|conform` mirror cli_media.rs (caps lists `media` only when FAKE_CLI_CAPS adds MEDIA_CAPS);
FAKE_CLI_FAIL=media-probe or media-conform fails them.
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import struct
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

SCRIPTS = Path(__file__).resolve().parent.parent
sys.path.append(str(SCRIPTS))

from kblib.video import editdoc, editmath as em  # noqa: E402

STAGING: List[Path] = []


def emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(code: str, message: str, exit_code: int = 1, event: bool = False, **extra: Any) -> None:
    body = {"ok": False, "code": code, "error": message}
    body.update(extra)
    if event:
        body["event"] = "error"
    emit(body)
    sys.exit(exit_code)


def flags(argv: List[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if not a.startswith("--"):
            fail("usage", f"unexpected argument {a}", 2)
        key = a[2:]
        if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
            out[key] = argv[i + 1]
            i += 2
        else:
            out[key] = True
            i += 1
    return out


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def project_of(f: Dict[str, Any]) -> Path:
    p = f.get("project")
    if not isinstance(p, str) or not os.path.isabs(p) or not (Path(p) / "project.json").is_file():
        fail("usage", "--project must be an absolute project folder holding project.json", 2)
    return Path(p)


def asset_path(project: Path, rel: str) -> Path:
    clean = rel[2:] if rel.startswith("./") else rel
    if not clean.startswith("assets/") or ".." in clean.split("/"):
        fail("usage", f"not a project asset path: {rel}", 2)
    return project / clean


def probe_abs(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        fail("missing", f"source not found: {path.name}")
    side = Path(str(path) + ".probe.json")
    info: Optional[Dict[str, Any]] = None
    if side.is_file():
        info = json.loads(side.read_text(encoding="utf-8"))
    else:
        data = path.read_bytes()
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            w, h = struct.unpack(">II", data[16:24])
            info = {"kind": "image", "width": w, "height": h, "fps": 0, "durationMs": 0, "vfr": False}
        else:
            try:
                fake = json.loads(data.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                fake = None
            if isinstance(fake, dict) and fake.get("fakeRender"):
                info = {"kind": "video", "width": fake["width"], "height": fake["height"], "fps": fake["fps"], "durationMs": fake["durationMs"], "vfr": False, "nbFrames": fake["frames"]}
    if info is None:
        fail("invalid", f"{path.name} is not media the fake can probe (add {side.name})")
    fps = info.get("fps") or 0
    vfr = bool(info.get("vfr"))
    w, h = info.get("width", 0), info.get("height", 0)
    out = {"ok": True, "kind": info["kind"], "width": w, "height": h, "fps": fps, "rFps": info.get("rFps", fps), "avgFps": info.get("avgFps", fps),
           "durationMs": info.get("durationMs", 0), "vfr": vfr, "rotation": info.get("rotation", 0), "nbFrames": info.get("nbFrames"),
           "editFps": 60.0 if vfr or fps <= 0 else fps, "evenSize": [w - w % 2, h - h % 2]}
    return out


def write_doc(path: Path, doc: Dict[str, Any]) -> bytes:
    stamped = dict(doc, version=editdoc.stamped_version(doc))
    data = (json.dumps(stamped, indent=2) + "\n").encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return data


def cmd_caps(f: Dict[str, Any]) -> None:
    caps = {
        "ok": True, "cli": 1, "appVersion": "0.19.0-fake", "build": "dev", "exe": sys.argv[0],
        "commands": ["caps", "probe", "create", "validate", "save", "render"],
        "docVersion": {"read": 3, "write": [1, 2, 3]},
        "ffmpeg": {"path": "/usr/bin/false", "ok": True}, "ffprobe": {"path": "/usr/bin/false", "ok": True},
        "filters": ["blackdetect", "freezedetect", "scdet", "tile"], "hardwareVideo": True,
        "tap": {"styles": ["target", "glow", "dot", "ring"], "colors": ["blue", "light", "dark", "red", "terracotta"], "sizeRange": [0.25, 4], "defaultSize": 1.25, "durationMs": 550, "defaultStyle": "target", "defaultColor": "blue"},
        "mask": {"styles": ["solid", "blur", "pixelate"], "defaultStrength": 0.5, "defaultColor": "#000000", "fades": True}, "crop": True, "zoom": True,
        "limits": {"minClipSourceMs": 100, "minHoldMs": 100, "defaultHoldMs": 2000, "defaultFps": 60},
    }
    caps.update(json.loads(os.environ.get("FAKE_CLI_CAPS") or "{}"))
    emit(caps)


def cmd_probe(f: Dict[str, Any]) -> None:
    project = project_of(f)
    if isinstance(f.get("file"), str):
        emit(probe_abs(Path(f["file"])))
    else:
        emit(probe_abs(asset_path(project, str(f.get("source")))))


def create_doc(project: Path, name: str, rel: str) -> Dict[str, Any]:
    p = probe_abs(asset_path(project, rel))
    image = p["kind"] == "image"
    width, height = (p["evenSize"] if image else [p["width"], p["height"]])
    clip: Dict[str, Any] = {"id": "c1", "sourceId": "s1", "inMs": 0, "outMs": p["durationMs"], "speed": 1.0, "startMs": 0}
    if image:
        clip["holdMs"] = 2000
    doc: Dict[str, Any] = {
        "version": 1, "name": name,
        "sources": [{"id": "s1", "rel": rel, "kind": p["kind"], "width": p["width"], "height": p["height"], "fps": p["fps"], "durationMs": p["durationMs"]}],
        "settings": {"width": width, "height": height, "fps": p["editFps"]},
        "clips": [clip],
    }
    doc.update(editdoc.read_tap_prefs(project))
    return editdoc.parse(json.dumps(doc))


def cmd_create(f: Dict[str, Any]) -> None:
    project = project_of(f)
    rel = str(f.get("source"))
    name = f.get("name") if isinstance(f.get("name"), str) else editdoc.default_name(rel)
    if not editdoc.validate_slug(name) or name.startswith("_"):
        fail("invalid", f"invalid edit name: {name!r}")
    path = editdoc.edit_path(project, name)
    if path.is_file():
        data = path.read_bytes()
        try:
            existing = editdoc.parse(data)
        except editdoc.DocError:
            existing = None
        if f.get("reuse") and existing is not None:
            emit({"ok": True, "created": False, "name": name, "path": str(path), "hash": sha(data), "doc": existing})
            return
        if not f.get("force"):
            fail("exists", f"edits/{name}.json already exists", name=name, path=str(path), hash=sha(data), sourceRel=(existing or {"sources": [{}]})["sources"][0].get("rel"))
        os.replace(path, path.with_suffix(".json.bak"))
    doc = create_doc(project, name, rel)
    data = write_doc(path, doc)
    emit({"ok": True, "created": True, "name": name, "path": str(path), "hash": sha(data), "doc": json.loads(data)})


def read_doc_arg(f: Dict[str, Any], project: Path) -> Any:
    if f.get("doc") == "-":
        text = sys.stdin.read()
        name = None
    else:
        name = str(f.get("name"))
        path = editdoc.edit_path(project, name)
        if not path.is_file():
            fail("missing", f"no edit named {name}")
        text = path.read_text(encoding="utf-8")
    try:
        return editdoc.parse(text), text, name
    except editdoc.DocError as e:
        fail("version" if e.kind == "version" else "corrupt", e.message)
    return None, None, None


def layout(doc: Dict[str, Any]) -> Dict[str, Any]:
    fps = em.output_fps(doc)
    ordered = sorted(doc["clips"], key=lambda c: c["startMs"])
    frames = em.clip_frames(ordered, fps)
    total = sum(n for _s, n in frames)
    clips = [{"id": c["id"], "startMs": c["startMs"], "endMs": c["startMs"] + em.clip_timeline_ms(c), "startFrame": s, "frames": n} for c, (s, n) in zip(ordered, frames)]
    taps = [{"id": t["id"], "windows": em.tap_windows(em.relayout(doc["clips"]), t, 550)} for t in doc.get("taps") or []]
    return {"totalFrames": max(1, total) if doc["clips"] else 0, "durationMs": em.timeline_duration_ms(doc["clips"]), "fps": fps, "clips": clips, "taps": taps}


def cmd_validate(f: Dict[str, Any]) -> None:
    project = project_of(f)
    if f.get("doc") == "-":
        text, name = sys.stdin.read(), None
    else:
        name = str(f.get("name"))
        path = editdoc.edit_path(project, name)
        if not path.is_file():
            fail("missing", f"no edit named {name}")
        text = path.read_text(encoding="utf-8")
    try:
        doc = editdoc.parse(text)
    except editdoc.DocError as e:
        emit({"ok": False, "hash": sha(text.encode("utf-8")), "version": None, "totalFrames": None, "durationMs": None, "fps": None, "width": None, "height": None,
              "clips": [], "taps": [], "errors": [{"code": "version" if e.kind == "version" else "corrupt", "message": e.message}], "warnings": []})
        return
    issues = editdoc.static_issues(doc, name, project)
    out = {"ok": not editdoc.errors_of(issues), "hash": sha(text.encode("utf-8")), "version": editdoc.stamped_version(doc), "width": doc["settings"]["width"], "height": doc["settings"]["height"]}
    out.update(layout(doc))
    out["errors"] = [{"code": i["code"], "message": i["message"]} for i in issues if i["severity"] == "error"]
    out["warnings"] = [{"code": i["code"], "message": i["message"]} for i in issues if i["severity"] == "warning"]
    emit(out)


def cmd_save(f: Dict[str, Any]) -> None:
    project = project_of(f)
    name = str(f.get("name"))
    if f.get("doc") != "-":
        fail("usage", "save needs --doc -", 2)
    text = sys.stdin.read()
    try:
        doc = editdoc.parse(text)
    except editdoc.DocError as e:
        fail("corrupt", e.message)
    if doc["name"] != name:
        fail("invalid", f'the doc is named "{doc["name"]}", not {name}')
    path = editdoc.edit_path(project, name)
    race = os.environ.get("FAKE_CLI_RACE")
    if race and not Path(race).exists() and path.is_file():
        other = json.loads(path.read_text(encoding="utf-8"))
        other["tapSize"] = 2.5
        write_doc(path, editdoc.parse(json.dumps(other)))
        Path(race).write_text("raced", encoding="utf-8")
    base = f.get("base")
    current = sha(path.read_bytes()) if path.is_file() else None
    if (base == "absent" and current is not None) or (base != "absent" and base != current):
        fail("conflict", f"conflict: edits/{name}.json changed outside the editor", hash=current)
    data = write_doc(path, doc)
    prefs = {k: doc[k] for k in ("tapStyle", "tapColor", "tapSize") if k in doc}
    if prefs:
        merged = dict(editdoc.read_tap_prefs(project), **prefs)
        (project / "edits" / "_tap_prefs.json").write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
    emit({"ok": True, "name": name, "path": str(path), "hash": sha(data), "bytes": len(data)})


def cleanup(signum: int, _frame: Any) -> None:
    for p in STAGING:
        try:
            p.unlink()
        except OSError:
            pass
    fail("interrupted", "render interrupted", 130, event=True)


def cmd_render(f: Dict[str, Any]) -> None:
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)
    project = project_of(f)
    out_arg = f.get("out")
    if (f.get("draft") or f.get("scale")) and not out_arg:
        fail("usage", "--draft and --scale need --out (a canonical render is always full size)", 2, event=True)
    if f.get("expect-hash") and f.get("doc") == "-":
        fail("usage", "--expect-hash goes with --name", 2, event=True)
    doc, text, name = read_doc_arg(f, project)
    if name is not None and f.get("expect-hash") and f["expect-hash"] != sha(text.encode("utf-8")):
        fail("conflict", f"edits/{name}.json changed since kb read it", event=True)
    review = out_arg is not None
    if review:
        if not isinstance(out_arg, str) or not os.path.isabs(out_arg):
            fail("usage", "--out must be an absolute .mp4 path", 2, event=True)
        if str(Path(out_arg).resolve()).startswith(str((project / "assets").resolve()) + os.sep):
            fail("usage", "--out may not be under the project's assets/", 2, event=True)
        final = Path(out_arg)
    elif name is None:
        fail("usage", "--doc - needs --out ABS.mp4", 2, event=True)
    else:
        final = project / "assets" / f"{name}-edited.mp4"
    lay = layout(doc)
    total = lay["totalFrames"]
    width, height = doc["settings"]["width"], doc["settings"]["height"]
    scale = 0.5 if f.get("draft") else float(f["scale"]) if isinstance(f.get("scale"), str) else 1.0
    if scale != 1.0:
        width, height = int(width * scale) // 2 * 2, int(height * scale) // 2 * 2
    lane = "software" if f.get("software") or f.get("draft") else "hardware"
    emit({"event": "start", "lane": lane, "total": total, "out": str(final)})
    staged = final.parent / ".kc-render" / f"{os.getpid()}-1-{final.name}"
    staged.parent.mkdir(parents=True, exist_ok=True)
    STAGING.append(staged)
    staged.write_bytes(b"partial")
    step = max(1, total // 10)
    pause = float(os.environ.get("FAKE_CLI_SLEEP") or 0)
    noisy = bool(os.environ.get("FAKE_CLI_NOISE"))
    for frame in range(step, total + 1, step):
        if pause:
            time.sleep(pause)
        if noisy:
            sys.stdout.write("frame=12 fps=30 not json\n[\"a list\"]\n")
        emit({"event": "progress", "frame": min(frame, total), "total": total})
    if "render" in (os.environ.get("FAKE_CLI_FAIL") or "").split(","):
        staged.unlink()
        fail("ffmpeg", "ffmpeg exited with 1: Invalid argument", event=True)
    duration = em.js_round(total * 1000 / lay["fps"])
    body = {"fakeRender": True, "frames": total, "durationMs": duration, "width": width, "height": height, "fps": lay["fps"], "docHash": sha(text.encode("utf-8"))}
    staged.write_bytes(json.dumps(body).encode("utf-8"))
    final.parent.mkdir(parents=True, exist_ok=True)
    os.replace(staged, final)
    STAGING.clear()
    rel = None
    if name is not None and not review:
        rel = f"assets/{name}-edited.mp4"
        record = {"docHash": body["docHash"], "output": rel, "lane": lane, "frames": total, "durationMs": duration, "width": width, "height": height, "fps": lay["fps"], "atMs": int(time.time() * 1000)}
        rec = editdoc.record_path(project, name)
        rec.parent.mkdir(parents=True, exist_ok=True)
        rec.write_text(json.dumps(record), encoding="utf-8")
    emit({"event": "done", "ok": True, "rel": rel, "path": str(final), "lane": lane, "frames": total, "durationMs": duration, "bytes": final.stat().st_size, "elapsedMs": 5, "docHash": body["docHash"], "width": width, "height": height, "fps": lay["fps"]})


COMMANDS = {"caps": cmd_caps, "probe": cmd_probe, "create": cmd_create, "validate": cmd_validate, "save": cmd_save, "render": cmd_render}

# ── media (cli_media.rs): probe answers <file>.media.json when present, else derives from <file>.probe.json ──

MEDIA_CAPS = {"version": 1, "commands": ["probe", "conform"]}
ORIGINALS = "assets/.originals"


def media_report(path: Path, pts: bool) -> Dict[str, Any]:
    canned = Path(str(path) + ".media.json")
    if canned.is_file():
        report = json.loads(canned.read_text(encoding="utf-8"))
    else:
        p = probe_abs(path)
        vfr = bool(p.get("vfr"))
        why = ["vfr"] if vfr else []
        report = {
            "ffmpeg": {"container": "mov", "codec": "h264", "width": p["width"], "height": p["height"], "vfr": vfr, "bframes": 0, "discardedPackets": 0},
            "avfoundation": {"codec": "avc1", "width": p["width"], "height": p["height"], "durationMs": p["durationMs"], "editList": [], "colour": {}},
            "verdict": "ok", "reasons": list(why), "conform": {"recommended": bool(why), "why": why, "refused": None},
        }
    if pts and isinstance(report.get("ffmpeg"), dict):
        report["ffmpeg"].setdefault("decode", {"frames": 1, "firstPtsMs": 0.0, "lastPtsMs": 0.0})
    return dict(report, ok=True, file=str(path), kind="video")


def media_plan(f: Dict[str, Any]) -> Dict[str, Any]:
    """conform.rs plan: in place unless --name differs or the source sits in assets/.originals/."""
    source = str(f.get("source") or "")
    source = source[2:] if source.startswith("./") else source
    if not source.startswith("assets/") or any(p in ("", "..") for p in source.split("/")):
        fail("usage", f"--source must be a file under assets/, not {source!r}", 2)
    name_part = source.rsplit("/", 1)[-1]
    stem, _, ext = name_part.rpartition(".")
    if ext.lower() not in ("mp4", "mov", "m4v"):
        fail("invalid", f"{source} is not an MP4, MOV or M4V video AVFoundation can conform")
    name = f.get("name") if isinstance(f.get("name"), str) else None
    from_originals = source.startswith(ORIGINALS + "/")
    in_place = not from_originals and (name is None or name == stem)
    target = source if in_place else f"assets/{name or stem}.mp4"
    keep = f.get("keep-original") or "move"
    if keep not in ("move", "copy"):
        fail("usage", f"--keep-original takes move or copy, not {keep!r}", 2)
    if keep == "copy" and target == source:
        fail("usage", "--keep-original copy needs a mezzanine with another name: give --name", 2)
    tdir, _, tname = target.rpartition("/")
    return {"source": source, "target": target, "original": source if from_originals else f"{ORIGINALS}/{name_part}",
            "timing": f"{tdir}/{tname.rpartition('.')[0]}.timing.json", "keep": keep, "inPlace": in_place}


def cmd_media(argv: List[str]) -> None:
    if not argv or argv[0] not in ("caps", "probe", "conform", "ocr"):
        fail("usage", "give a media command: caps, probe, conform, ocr", 2)
    f = flags(argv[1:])
    if f"media-{argv[0]}" in (os.environ.get("FAKE_CLI_FAIL") or "").split(",") and argv[0] != "conform":
        fail("invalid", f"fake media {argv[0]} failure")
    if argv[0] == "ocr":
        folder = f.get("dir")
        if not isinstance(folder, str) or not os.path.isabs(folder):
            fail("usage", "--dir must be an absolute path", 2)
        canned = os.environ.get("FAKE_CLI_OCR")
        lines = json.loads(Path(canned).read_text(encoding="utf-8")) if canned else [{"text": "Launch day", "confidence": 0.9}]
        emit({"ok": True, "engine": "vision", "frames": [{"file": name, "lines": lines} for name in sorted(os.listdir(folder)) if name.endswith((".png", ".jpg"))]})
        return
    if argv[0] == "caps":
        emit({"ok": True, "cli": 1, "commands": ["caps", "probe", "conform"], "timingVersion": 1, "fps": 60, "keepOriginal": ["move", "copy"],
              "exitCodes": {"ok": 0, "failed": 1, "usage": 2, "interrupted": 130}})
        return
    if argv[0] == "probe":
        raw = f.get("file")
        if not isinstance(raw, str) or not os.path.isabs(raw):
            fail("usage", "--file must be an absolute path", 2)
        if not Path(raw).is_file():
            fail("missing", f"no file at {raw}")
        emit(media_report(Path(raw), bool(f.get("pts"))))
        return
    project = project_of(f)
    plan = media_plan(f)
    src, target, original, timing = (project / plan[k] for k in ("source", "target", "original", "timing"))
    if not src.is_file():
        fail("missing", f"no video at {plan['source']}")
    if plan["original"] != plan["source"] and original.exists():
        fail("exists", f"{plan['original']} already holds an original: move it aside first")
    if timing.exists() and not f.get("force"):
        fail("exists", f"{plan['timing']} already exists: pass --force to replace it")
    if not plan["inPlace"] and target.exists() and not f.get("force"):
        fail("exists", f"{plan['target']} already exists: pass --name for another name or --force to replace it")
    if plan["keep"] == "move" and not plan["inPlace"] and plan["source"] != plan["original"]:
        from kblib.asset_refs import AssetRefs

        used = AssetRefs.of(project).references(plan["source"])
        if used:
            fail("in-use", f"{plan['source']} is used by {', '.join(used)}: re-point them to {plan['target']} first", files=used)
    info = probe_abs(src)
    frames = max(1, -(-int(info.get("durationMs") or 0) * 60 // 1000))
    emit({"event": "start", "total": frames, "out": str(target)})
    emit({"event": "progress", "frame": frames // 2, "total": frames})
    kept = False
    if not original.exists():
        original.parent.mkdir(parents=True, exist_ok=True)
        original.write_bytes(src.read_bytes())
        side = Path(str(src) + ".probe.json")
        if side.is_file():
            Path(str(original) + ".probe.json").write_bytes(side.read_bytes())
        kept = True
    if "media-conform" in (os.environ.get("FAKE_CLI_FAIL") or "").split(","):
        if kept:
            original.unlink()
        fail("ffmpeg", "ffmpeg exited with 1: Invalid argument", event=True)
    duration = em.js_round(frames * 1000 / 60)
    body = {"fakeRender": True, "conformed": True, "frames": frames, "durationMs": duration, "width": info["width"], "height": info["height"], "fps": 60}
    target.write_bytes(json.dumps(body).encode("utf-8"))
    for stale in (Path(str(target) + ".probe.json"),):
        if stale.exists():
            stale.unlink()
    if plan["keep"] == "move" and not plan["inPlace"] and plan["source"] != plan["original"]:
        src.unlink()
    report = media_report(original, False)
    record = {"version": 1, "kind": "conform",
              "source": {"original": plan["original"], "sha256": sha(original.read_bytes()), "verdict": report["verdict"], "reasons": report["reasons"]},
              "mezzanine": {"path": plan["target"], "sha256": sha(target.read_bytes()), "fps": 60, "frames": frames, "durationMs": duration},
              "slots": [[0, 0]], "holds": [{"fromMs": 0, "toMs": 100, "slots": [0, 5], "source": 0}]}
    timing.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    emit({"event": "done", "ok": True, "rel": plan["target"], "path": str(target), "original": plan["original"], "timing": plan["timing"],
          "inPlace": plan["inPlace"], "frames": frames, "durationMs": duration, "bytes": target.stat().st_size, "elapsedMs": 5,
          "verdict": report["verdict"], "reasons": report["reasons"]})


def cmd_check(argv: List[str]) -> None:
    if argv[:1] != ["flashes"]:
        fail("usage", "unknown check", 2)
    f = flags(argv[1:])
    if not isinstance(f.get("file"), str) or not Path(f["file"]).is_file():
        fail("missing", f"no file at {f.get('file')}")
    canned = os.environ.get("FAKE_CLI_FLASH_REPORT")
    report = json.loads(Path(canned).read_text(encoding="utf-8")) if canned else {
        "version": 1, "approximate": True, "standards": ["wcag-2.3.1", "itu-bt1702"], "source": "file", "fps": 60.0,
        "frames": 0, "grid": [64, 36], "ok": True, "issues": []}
    emit({"ok": True, "file": f["file"], "report": report})


def fake_analysis(bpm: float = 120.0, offset: float = 250.0) -> Dict[str, Any]:
    """A v3 song analysis of a steady click: 4/4 at bpm with bar 1 at offset ms, a fill in bar 8, a breakdown in bars 9-12
    and music that stops at 30 s."""
    period = 60000 / bpm
    beats = [{"ms": round(offset + k * period, 3), "bar": k // 4 + 1, "beat": k % 4 + 1, "conf": 0.9} for k in range(64)]
    return {
        "version": 3, "sha256": "", "decoder": {"name": "ffmpeg", "version": "fake", "sampleRate": 48000, "channels": 1},
        "tracker": "nn", "model": {"name": "beat_this_small", "sha256": "fake"}, "fallbackReason": None, "durationMs": 32000,
        "fit": {"bpm": bpm, "offsetMs": offset, "beatsPerBar": 4, "periodMs": period, "phaseMs": 0.5, "residualMs": 0.9,
                "maxDriftMs": 1.4, "constantTempo": True},
        "beats": beats, "energy": None, "sections": [{"fromBar": 1, "toBar": 9, "novelty": 0.4}, {"fromBar": 9, "toBar": 17, "novelty": 0.7}],
        "breaths": [{"fromMs": 16000, "toMs": 16400, "kind": "silence"}], "stabs": {"per16th": [1.0] + [0.1] * 15},
        "hits": {"full": [[offset, 1.0], [round(offset + period, 1), 0.4], [round(offset + 28 * period + period / 4, 1), 0.8]],
                 "low": [[offset, 1.0]], "mid": [[round(offset + 28 * period + period / 4 + 12, 1), 0.7]], "high": []},
        "ending": {"audibleEndMs": 30000.0, "trailingSilenceMs": 2000.0, "lastHitMs": 29750.0, "lastHitStrength": 0.8},
        "form": {
            "phrase": {"bars": 4, "startBar": 1, "detected": True},
            "bars": [{"bar": b, "lufs": -14.0, "onsets": 8, "quiet": 0.0} for b in range(1, 16)],
            "parts": [{"id": "peak-1", "label": "Peak 1", "kind": "peak", "fromBar": 1, "toBar": 9},
                      {"id": "breakdown-1", "label": "Breakdown 1", "kind": "breakdown", "fromBar": 9, "toBar": 13},
                      {"id": "peak-2", "label": "Peak 2", "kind": "peak", "fromBar": 13, "toBar": 16}],
            "moments": [{"id": "fill-1", "kind": "fill", "ms": round(offset + 30 * period, 1), "bar": 8, "toBar": 9, "band": "mid"},
                        {"id": "final-hit", "kind": "final", "ms": 29750.0, "bar": 15, "toBar": 16, "band": None}],
        },
        "lyrics": None, "keyMoments": [{"tMs": 4250, "strength": 0.9}], "envelope": {"hopMs": 21.333, "values": []},
    }


def cmd_song(argv: List[str]) -> None:
    """`song caps|analyse --file ABS [--force] [--tracker nn|dsp]`: FAKE_CLI_SONG names a JSON analysis to answer with
    (its sha256 becomes the file's), else fake_analysis(); FAKE_CLI_FAIL=song fails the analysis."""
    if argv[:1] == ["caps"]:
        emit({"ok": True, "commands": ["caps", "analyse"], "analysisVersion": 3, "trackers": ["nn", "dsp"],
              "model": {"name": "beat_this_small", "available": True, "dir": "/tmp"}})
        return
    if argv[:1] != ["analyse"]:
        fail("usage", "unknown song command", 2)
    f = flags(argv[1:])
    path = f.get("file")
    if not isinstance(path, str) or not os.path.isabs(path):
        fail("usage", "--file must be an absolute path", 2)
    if not Path(path).is_file():
        fail("missing", f"no file at {path}")
    if "song" in (os.environ.get("FAKE_CLI_FAIL") or "").split(","):
        fail("ffmpeg", "ffmpeg exited with 1: Invalid data found when processing input")
    digest = sha(Path(path).read_bytes())
    canned = os.environ.get("FAKE_CLI_SONG")
    analysis = json.loads(Path(canned).read_text(encoding="utf-8")) if canned else fake_analysis()
    analysis["sha256"] = digest
    if isinstance(f.get("tracker"), str):
        analysis["tracker"] = f["tracker"]
    emit({"ok": True, "file": path, "cached": not f.get("force") and bool(os.environ.get("FAKE_CLI_SONG_CACHED")),
          "cachePath": f"/tmp/fake-beats/{digest}-v3.json", "analysis": analysis})


def load_behaviour() -> None:
    """The FAKE_CLI_* knobs helpers.fake_cli stored for the shim that ran us (FAKE_CLI_SHIM is its $0)."""
    shim, folder = os.environ.get("FAKE_CLI_SHIM"), os.environ.get("FAKE_CLI_BEHAVIOUR")
    if not shim or not folder:
        return
    path = Path(folder) / f"{hashlib.sha256(os.path.realpath(shim).encode('utf-8')).hexdigest()}.json"
    try:
        os.environ.update(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass


def main() -> None:
    load_behaviour()
    argv = sys.argv[1:]
    ran = os.environ.get("FAKE_CLI_RAN")
    if ran:
        with open(ran, "a", encoding="utf-8") as fh:
            fh.write(" ".join(argv) + "\n")
    log = os.environ.get("FAKE_CLI_LOG")
    if log:
        with open(log, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(argv) + "\n")
    if argv[:1] == ["check"]:
        cmd_check(argv[1:])
        return
    if argv[:1] == ["song"]:
        cmd_song(argv[1:])
        return
    if argv[:1] == ["media"]:
        cmd_media(argv[1:])
        return
    if len(argv) < 2 or argv[0] != "edit" or argv[1] not in COMMANDS:
        fail("usage", f"usage: kookaburra-cut edit <{'|'.join(COMMANDS)}>", 2)
    command = argv[1]
    if os.environ.get("FAKE_CLI_MALFORMED") == command:
        sys.stdout.write("this is not json\n")
        sys.exit(0)
    if command in (os.environ.get("FAKE_CLI_FAIL") or "").split(",") and command != "render":
        fail("env", f"fake {command} failure", 2)
    COMMANDS[command](flags(argv[2:]))


if __name__ == "__main__":
    main()
