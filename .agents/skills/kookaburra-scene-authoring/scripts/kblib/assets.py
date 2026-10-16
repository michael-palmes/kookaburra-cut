"""Project media: list with usage, copy in (never overwrite), probe with the app's bundled ffprobe."""

from __future__ import annotations

import filecmp
import json
import os
import shutil
import struct
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from . import bridge
from . import tsx as tsxmod
from .check import SUPPORTED_ASSET_EXTS
from .project import Project
from .scenes import collect_json_asset_refs, free_sibling_name
from .util import EXIT_ENV, KbError, read_text

KINDS = {
    "image": {"png", "jpg", "jpeg", "webp", "gif"},
    "video": {"mp4", "mov", "m4v", "webm"},
    "audio": {"mp3", "wav", "m4a", "aac", "flac", "ogg"},
    "environment": {"hdr", "exr"},
    "data": {"csv", "tsv", "txt"},
    "lut": {"cube"},
    "model": {"glb", "gltf"},
}


def kind_of(name: str) -> str:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    for kind, exts in KINDS.items():
        if ext in exts:
            return kind
    return "other"


def human_size(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{n} B"


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


def list_assets(project: Project) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    root = project.assets_dir
    if not root.is_dir():
        return out
    used = usage(project)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            path = Path(dirpath) / name
            rel = path.relative_to(project.root).as_posix()
            out.append({"path": rel, "kind": kind_of(name), "bytes": path.stat().st_size, "usedBy": used.get(rel, [])})
    return out


def add(project: Project, source: str, name: Optional[str], subdir: Optional[str]) -> Dict[str, Any]:
    src = Path(source).expanduser()
    if not src.is_file():
        raise KbError(f"{source} is not a file")
    final_name = name or src.name
    if "/" in final_name or final_name.startswith("."):
        raise KbError("--name must be a plain file name (no folders, not hidden)", 2)
    ext = final_name.rsplit(".", 1)[-1].lower() if "." in final_name else ""
    if ext not in SUPPORTED_ASSET_EXTS:
        raise KbError(f'".{ext}" is not a media type the app reads; convert it to png/jpg/webp, mp4/mov/webm or mp3/wav/m4a first', 1)
    dest_dir = project.assets_dir / subdir if subdir else project.assets_dir
    if subdir and not tsxmod.is_project_asset_ref(f"assets/{subdir}/x"):
        raise KbError("--dir must be a plain relative folder under assets/", 2)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / final_name
    note = None
    if dest.exists():
        try:
            if src.resolve() == dest.resolve() or filecmp.cmp(str(src), str(dest), shallow=False):
                return {"path": dest.relative_to(project.root).as_posix(), "copied": False, "note": "identical file already in assets/"}
        except OSError:
            pass
        free = free_sibling_name(dest_dir, final_name)
        note = f"{final_name} already exists with different content, so this copy is {free}"
        dest = dest_dir / free
    tmp = dest_dir / f".{dest.name}.kbtmp"
    shutil.copyfile(str(src), str(tmp))
    os.replace(str(tmp), str(dest))
    return {"path": dest.relative_to(project.root).as_posix(), "copied": True, "note": note, "kind": kind_of(dest.name), "bytes": dest.stat().st_size}


def ffprobe_path() -> Optional[str]:
    bundled = bridge.resources_dir().parent / "MacOS" / "ffprobe"
    if bundled.is_file() and os.access(str(bundled), os.X_OK):
        return str(bundled)
    return shutil.which("ffprobe")


def probe(project: Project, ref: str) -> Dict[str, Any]:
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
        if proc.returncode != 0:
            raise KbError(f"ffprobe could not read {rel}: {proc.stderr.strip()[:300]}")
        data = json.loads(proc.stdout or "{}")
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
        return info
    dims = image_size(path)
    if dims:
        info["width"], info["height"] = dims
        info["probe"] = "built-in image reader"
        return info
    raise KbError("no ffprobe found (the app bundle's Contents/MacOS/ffprobe is missing); only png/jpg sizes can be read without it", EXIT_ENV)


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
