"""kb capture and kb debug: frames from the running app (sized, probed, and copied into the project's .kb/captures/), the GPU and WebGL diagnostics, and the capture-service lines in kb status (docs/agent-kit.md, "The capture service")."""

from __future__ import annotations

import argparse
import math
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import bridge
from . import catalog as catmod
from . import music, queue, reach
from .film import timeline as tl
from .util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, emit, emit_err, now_ms

CAPTURES = "captures"
KEEP_FOLDERS = 40
MAX_CAPTURE_BYTES = 1024 ** 3
MIN_AGE_S = 3600
MAX_PROBES = 64
EXPORT_FPS = 60
SHEET_LONG_EDGE = 1280
MIN_CAPTURE_EDGE = 64
DEFAULT_AROUND = 5
DIFF_THRESHOLD = 8
DIFF_GAIN = 4
FFMPEG_TIMEOUT_S = 120
# Mirror of CAPTURE_FORMATS in src-tauri/src/capture_service.rs, for a catalogue without sizes.
FALLBACK_SIZES = {"16:9": (3840, 2160), "9:16": (2160, 3840), "1:1": (2160, 2160), "4:5": (2160, 2700), "5:4": (2700, 2160),
                  "3:2": (3240, 2160), "2:3": (2160, 3240), "phone": (1206, 2622), "phone-landscape": (2622, 1206)}
STAMP_RE = re.compile(r"^\d{8}-\d{6}")
UNSAFE_RE = re.compile(r"[^A-Za-z0-9._@-]+")

CAPTURE_EPILOG = """\
  kb capture                          the editor's playhead (this project must be open)
  kb capture --scene 03-x --at 1.5    one frame at its native size (3840x2160 for 16:9)
  kb capture --scene 2 --aspect 9:16
  kb capture --frames 0@1,3@2.5 --sheet   several frames (1280 px long edge) plus one contact sheet
  kb capture --scene 2 --scale 0.5    half size; --width 960 sets the width in pixels
  kb capture --scene 2 --scale 0.5 --probe 100,200,0.5,0.5   exact pixels: native px (ints) or fractions, any scale
  ./kb capture --at bar:13                 the frame at a musical position, in the scene that owns it
  ./kb capture --frames bars:13-16 --sheet   each downbeat of bars 13 to 16 (beats:13-14 for every beat)
  ./kb capture --scene 2 --around 1.5 --count 8 --sheet   8 consecutive frames (60 fps) centred on 1.5 s
  ./kb capture --scene 2 --at 1.5 --crop 0.6,0.1,0.3,0.3   a native-resolution crop (px or fractions)
  ./kb capture --diff 02-hero@last 03-outro@first   a join: A | B | the difference x4, with numbers
Positions (bar:B[.beat[.16th]], cue:ID, section:ID, optionally +40ms) resolve against audio.grid; a mid-transition
moment belongs to the scene the editor shows as current, and is labelled "A → B (type, 40%)". With --scene S a
position outside S is refused.
Copies land in .kb/captures/<time>-<agent>/ (each agent's newest 40 kept); --out DIR copies there, --no-copy
skips it. A request costs frames x ceil(pixels / 921600) units: at most 144 per request and 240 a
minute per agent (a 4K frame is 9 units, a 1280x720 frame 1)."""


def _point_value(token: str, flag: str) -> Tuple[float, bool]:
    """One coordinate: a whole native pixel, or a fraction in [0, 1] (a decimal point)."""
    try:
        if "." in token or "e" in token.lower():
            value = float(token)
            if not math.isfinite(value) or not 0 <= value <= 1:
                raise KbError(f"{flag} {token}: a fraction must be in [0, 1]", EXIT_ENV, kind="usage")
            return value, True
        value = int(token)
    except ValueError:
        raise KbError(f"{flag} {token}: coordinates are whole pixels (native) or fractions in [0, 1]", EXIT_ENV, kind="usage") from None
    if value < 0:
        raise KbError(f"{flag} coordinates start at 0,0 (the top left)", EXIT_ENV, kind="usage")
    return float(value), False


def parse_probe(specs: Optional[List[str]]) -> Optional[List[Tuple[float, float, bool]]]:
    """--probe x,y[,x,y...] (repeatable) as (x, y, normalised) points: native pixels or fractions in [0, 1], at most 64."""
    if not specs:
        return None
    parts = [p.strip() for spec in specs for p in spec.split(",") if p.strip()]
    if not parts or len(parts) % 2:
        raise KbError("--probe needs x,y pairs, e.g. --probe 100,200,0.5,0.5", EXIT_ENV, kind="usage")
    values = [_point_value(p, "--probe") for p in parts]
    points: List[Tuple[float, float, bool]] = []
    for i in range(0, len(values), 2):
        (x, nx), (y, ny) = values[i], values[i + 1]
        if nx != ny:
            raise KbError(f"--probe {parts[i]},{parts[i + 1]}: a point is native pixels (100,200) or fractions (0.5,0.25), not a mix",
                          EXIT_ENV, kind="usage")
        points.append((x, y, nx))
    if len(points) > MAX_PROBES:
        raise KbError(f"--probe takes at most {MAX_PROBES} points (got {len(points)})", EXIT_ENV, kind="usage")
    return points


def _even(x: float) -> int:
    """The app's even(): Math.round(x / 2) * 2."""
    return int(math.floor(x / 2.0 + 0.5)) * 2


def native_size(aspect: Optional[str]) -> Tuple[int, int]:
    """An aspect's export size from the catalogue (the app's table when it has none); unknown aspects size as 16:9."""
    for entry in catmod.load_catalog().entries("aspects") or []:
        w, h = entry.get("width"), entry.get("height")
        if entry.get("id") == aspect and isinstance(w, (int, float)) and isinstance(h, (int, float)) and w > 0 and h > 0:
            return int(w), int(h)
    return FALLBACK_SIZES.get(aspect or "", FALLBACK_SIZES["16:9"])


def capture_size(native: Tuple[int, int], width: Optional[int] = None, scale: Optional[float] = None, frames: int = 1,
                 sheet: bool = False, probe: bool = False) -> Tuple[int, int]:
    """The size the app renders a capture at: mirror of `captureFormat` (src/render/bridgeRequests.ts)."""
    nw, nh = native
    long = max(nw, nh)
    if width is not None and width > 0:
        if width >= nw:
            return native
        w = _even(width)
        h = _even(w * nh / nw)
    else:
        sized = scale is not None and scale > 0
        multi = (sheet or frames > 1) and not probe
        target = long * scale if sized else (SHEET_LONG_EDGE if multi else long)  # type: ignore[operator]
        if target >= long:
            return native
        if nw >= nh:
            w = _even(target)
            h = _even(w * nh / nw)
        else:
            h = _even(target)
            w = _even(h * nw / nh)
    if min(w, h) < MIN_CAPTURE_EDGE:
        if nw <= nh:
            w, h = MIN_CAPTURE_EDGE, _even(MIN_CAPTURE_EDGE * nh / nw)
        else:
            w, h = _even(MIN_CAPTURE_EDGE * nw / nh), MIN_CAPTURE_EDGE
    return w, h


def map_probes(points: List[Tuple[float, float, bool]], native: Tuple[int, int], size: Tuple[int, int]) -> Tuple[List[List[int]], List[List[int]]]:
    """Each point as (pixels in the returned image, native pixels); a native point outside the frame is a usage error."""
    nw, nh = native
    w, h = size
    wire: List[List[int]] = []
    natives: List[List[int]] = []
    for x, y, normalised in points:
        if normalised:
            nx, ny = min(nw - 1, int(x * nw)), min(nh - 1, int(y * nh))
        else:
            nx, ny = int(x), int(y)
            if nx >= nw or ny >= nh:
                raise KbError(f"--probe {nx},{ny} is outside the {nw}x{nh} native frame (origin top left)", EXIT_ENV, kind="usage")
        natives.append([nx, ny])
        wire.append([min(w - 1, nx * w // nw), min(h - 1, ny * h // nh)])
    return wire, natives


def parse_crop(spec: Optional[str]) -> Optional[Tuple[Tuple[float, float, float, float], bool]]:
    """--crop X,Y,W,H: native pixels, or all four as fractions in [0, 1]."""
    if spec is None:
        return None
    parts = [p.strip() for p in spec.split(",")]
    if len(parts) != 4 or not all(parts):
        raise KbError("--crop needs X,Y,W,H, e.g. --crop 1920,0,960,540 or --crop 0.5,0,0.25,0.25", EXIT_ENV, kind="usage")
    values = [_point_value(p, "--crop") for p in parts]
    kinds = {n for _, n in values}
    if len(kinds) != 1:
        raise KbError(f"--crop {spec}: give native pixels or fractions, not a mix", EXIT_ENV, kind="usage")
    x, y, w, h = (v for v, _ in values)
    return (x, y, w, h), kinds.pop()


def crop_box(raw: Tuple[Tuple[float, float, float, float], bool], native: Tuple[int, int]) -> Dict[str, int]:
    """The crop in native pixels, inside the frame."""
    (x, y, w, h), normalised = raw
    nw, nh = native
    if normalised:
        x, y, w, h = x * nw, y * nh, w * nw, h * nh
    box = {"x": int(round(x)), "y": int(round(y)), "width": int(round(w)), "height": int(round(h))}
    if box["width"] < 1 or box["height"] < 1:
        raise KbError("--crop needs a width and height of at least one pixel", EXIT_ENV, kind="usage")
    if box["x"] + box["width"] > nw or box["y"] + box["height"] > nh:
        raise KbError(f"--crop {box['x']},{box['y']},{box['width']},{box['height']} runs past the {nw}x{nh} native frame",
                      EXIT_ENV, kind="usage")
    return box


# ── transitions, consecutive frames and joins ────────────────────────────────


def transition_at(slots: List[Dict[str, Any]], t_ms: float) -> Optional[Dict[str, Any]]:
    """{ from, to, type, progress } when project time t_ms lands inside a transition's overlap (linear progress)."""
    for i in range(len(slots) - 1):
        b = slots[i + 1]
        spec = b.get("transitionIn")
        if not spec or not b["startMs"] <= t_ms < slots[i]["endMs"]:
            continue
        span = float(slots[i]["endMs"] - b["startMs"])
        progress = (t_ms - b["startMs"]) / span if span > 0 else 1.0
        return {"from": slots[i].get("stem"), "to": b.get("stem"), "type": spec.get("type") or "crossfade",
                "progress": round(max(0.0, min(1.0, progress)), 3)}
    return None


def transition_label(tr: Dict[str, Any]) -> str:
    return f"{tr['from']} → {tr['to']} ({tr['type']}, {tl.js_round(tr['progress'] * 100)}%)"


def label_transitions(resp: Dict[str, Any], slots: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Frames that land mid-transition carry `transition` and a `label` naming both scenes."""
    frames = resp.get("frames") if isinstance(resp.get("frames"), list) else None
    if not frames or not slots:
        return resp
    out = []
    for f in frames:
        t = f.get("tMs") if isinstance(f, dict) else None
        tr = transition_at(slots, float(t)) if isinstance(t, (int, float)) and not isinstance(t, bool) else None
        out.append(dict(f, transition=tr, label=transition_label(tr)) if tr else f)
    return dict(resp, frames=out)


def around_frames(slots: List[Dict[str, Any]], centre_ms: float, count: int, index: Optional[int] = None,
                  fps: float = EXPORT_FPS) -> Tuple[List[Tuple[int, float, int]], bool]:
    """(export frame, project ms, scene) for `count` consecutive frames centred on centre_ms, kept inside scene `index`
    (else the film); True when the window had to move to fit."""
    from .beats import model

    lo, hi = (slots[index]["startMs"], slots[index]["endMs"]) if index is not None else (0.0, tl.timeline_total_ms(slots))
    k_lo = int(math.ceil(lo * fps / 1000.0 - 1e-6))
    k_hi = int(math.ceil(hi * fps / 1000.0 - 1e-6)) - 1
    where = slots[index]["stem"] if index is not None else "the film"
    if k_hi - k_lo + 1 < count:
        raise KbError(f"{where} has {max(0, k_hi - k_lo + 1)} frames at {fps:g} fps, fewer than --count {count}", EXIT_PROBLEMS,
                      kind="invalid", hint="lower --count")
    wanted = tl.frame_at(centre_ms, fps) - count // 2
    first = min(max(wanted, k_lo), k_hi - count + 1)
    out = []
    for k in range(first, first + count):
        t = k * 1000.0 / fps
        out.append((k, t, index if index is not None else model.owner_index(slots, t)))
    return out, first != wanted


def frame_for(slots: List[Dict[str, Any]], index: int, t_ms: float) -> Dict[str, Any]:
    """A request frame showing project time t_ms, addressed to scene `index`."""
    return {"scene": slots[index]["stem"], "at": round(max(0.0, t_ms - slots[index]["startMs"]) / 1000.0, 6)}


def diff_frame(project: Any, slots: List[Dict[str, Any]], spec: str, default_scene: Optional[str]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """One --diff side: S@first and S@last (the solo frames kb verify captures), else one --frames item."""
    from . import verify

    scene, sep, rest = spec.strip().rpartition("@")
    if sep and rest.strip().lower() in ("first", "last"):
        index, stem = project.resolve(scene)
        if index >= len(slots):
            raise KbError(f'no scene "{scene}" on the timeline', EXIT_ENV, kind="usage")
        first, last = verify.solo_window(slots, index)
        local = first if rest.strip().lower() == "first" else last
        return {"scene": stem, "at": round(local / 1000.0, 6)}, {"spec": spec, "projectMs": tl.js_round(slots[index]["startMs"] + local)}
    frames, meta = position_frames(project, spec, default_scene)
    if len(frames) != 1:
        raise KbError(f'--diff "{spec}" is {len(frames)} frames; each side is one frame (S@SEC, POS, S@POS, S@first or S@last)',
                      EXIT_ENV, kind="usage")
    return frames[0], dict(meta[0] or {}, spec=spec)


def _ffmpeg(args: List[str], what: str, binary: bool = False) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(args, capture_output=True, timeout=FFMPEG_TIMEOUT_S)
    except OSError as e:
        raise KbError(f"could not run ffmpeg: {e.strerror}", EXIT_ENV, kind="env") from None
    except subprocess.TimeoutExpired:
        raise KbError(f"ffmpeg took longer than {FFMPEG_TIMEOUT_S} s {what}", EXIT_ENV, kind="env") from None
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace").strip()[-300:]
        raise KbError(f"ffmpeg could not {what}: {tail or 'no output'}", EXIT_ENV, kind="env")
    return proc


def crop_png(ffmpeg: str, path: Path, box: Dict[str, int]) -> None:
    """Crop a PNG in place."""
    tmp = path.with_name(f".{path.name}.crop.png")
    _ffmpeg([ffmpeg, "-v", "error", "-nostdin", "-y", "-i", str(path), "-vf", f"crop={box['width']}:{box['height']}:{box['x']}:{box['y']}",
             "-frames:v", "1", str(tmp)], "crop the capture")
    os.replace(tmp, path)


def diff_stats(diff: bytes, threshold: int = DIFF_THRESHOLD) -> Dict[str, float]:
    """Mean and max absolute difference (% of full scale) of packed rgb24 difference bytes, and the % of pixels with a
    channel changed by more than `threshold`."""
    if not diff:
        return {"meanPct": 0.0, "changedPct": 0.0, "maxPct": 0.0}
    over = diff.translate(bytes(1 if v > threshold else 0 for v in range(256)))
    # Each byte is 0 or 1, so OR-ing the three channels as big integers marks a pixel once.
    marked = int.from_bytes(over[0::3], "big") | int.from_bytes(over[1::3], "big") | int.from_bytes(over[2::3], "big")
    pixels = len(diff) // 3
    return {"meanPct": round(sum(diff) / (len(diff) * 255.0) * 100.0, 3),
            "changedPct": round(bin(marked).count("1") / pixels * 100.0, 3) if pixels else 0.0,
            "maxPct": round(max(diff) / 255.0 * 100.0, 2)}


def diff_frames(ffmpeg: str, a: Path, b: Path, out: Path) -> Dict[str, Any]:
    """[A | B | the difference x4] as one PNG, plus the stats of the exact difference."""
    graph = "[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]blend=all_mode=difference,format=rgb24[out]"
    raw = _ffmpeg([ffmpeg, "-v", "error", "-nostdin", "-i", str(a), "-i", str(b), "-filter_complex", graph, "-map", "[out]",
                   "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], "compare the two frames").stdout
    gain = f"'min(val*{DIFF_GAIN},255)'"
    sheet = ("[0:v]format=gbrp,split[a1][a2];[1:v]format=gbrp,split[b1][b2];"
             f"[a2][b2]blend=all_mode=difference,lutrgb=r={gain}:g={gain}:b={gain}[d];"
             "[a1]pad=iw+8:ih:0:0:color=0x808080[ap];[b1]pad=iw+8:ih:0:0:color=0x808080[bp];"
             "[ap][bp][d]hstack=inputs=3,format=rgb24[out]")
    _ffmpeg([ffmpeg, "-v", "error", "-nostdin", "-y", "-i", str(a), "-i", str(b), "-filter_complex", sheet, "-map", "[out]",
             "-frames:v", "1", str(out)], "draw the difference")
    return dict(diff_stats(raw), path=str(out))


def size_fields(args: argparse.Namespace) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if args.width is not None:
        if args.width < 1:
            raise KbError("--width is a width in pixels, at least 1", EXIT_ENV, kind="usage")
        out["width"] = args.width
    if args.scale is not None:
        if not 0 < args.scale <= 1:
            raise KbError("--scale is a fraction of the native size, in (0, 1]", EXIT_ENV, kind="usage")
        out["scale"] = args.scale
    return out


def frame_name(frame: Dict[str, Any], n: int) -> str:
    """`05-feature@1.5s.png`: the scene stem and seconds into it; mid-transition `04-a-to-05-b-crossfade-40pct.png`."""
    tr = frame.get("transition")
    if isinstance(tr, dict):
        return UNSAFE_RE.sub("-", f"{tr.get('from')}-to-{tr.get('to')}-{tr.get('type')}-{tl.js_round(float(tr.get('progress') or 0) * 100)}pct") + ".png"
    scene = str(frame.get("scene") or f"frame-{n}")
    at = frame.get("at")
    label = f"{scene}@{at:g}s" if isinstance(at, (int, float)) and not isinstance(at, bool) else scene
    return UNSAFE_RE.sub("-", label) + ".png"


def capture_folder(root: Path, agent: Optional[str], at: Optional[float] = None) -> Path:
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(at))
    tag = UNSAFE_RE.sub("-", agent or "").strip("-")[:40]
    base = f"{stamp}-{tag}" if tag else stamp
    folder, n = root / base, 2
    while folder.exists():
        folder, n = root / f"{base}+{n}", n + 1
    return folder


def copy_captures(resp: Dict[str, Any], folder: Path) -> Dict[str, Any]:
    """The answer with `path`, `paths`, each frame's `path` and `sheetPath` pointing at readable copies in `folder`; the originals stay as `bridgePath(s)` and `bridgeSheetPath`."""
    folder.mkdir(parents=True, exist_ok=True)
    out = dict(resp)
    used: set = set()
    copies: Dict[str, str] = {}

    def copy(src: Any, name: str) -> Any:
        if not isinstance(src, str) or not Path(src).is_file():
            return src
        if src in copies:
            return copies[src]
        stem, final, n = name[:-4], name, 2
        while final in used:
            final, n = f"{stem}-{n}.png", n + 1
        used.add(final)
        dest = folder / final
        shutil.copyfile(src, dest)
        copies[src] = str(dest)
        return str(dest)

    frames = resp.get("frames") if isinstance(resp.get("frames"), list) else []
    out_frames = []
    for n, f in enumerate(frames):
        if isinstance(f, dict) and isinstance(f.get("path"), str):
            out_frames.append(dict(f, path=copy(f["path"], frame_name(f, n)), bridgePath=f["path"]))
        else:
            out_frames.append(f)
    if frames:
        out["frames"] = out_frames
    originals = resp.get("paths") if isinstance(resp.get("paths"), list) else ([resp["path"]] if isinstance(resp.get("path"), str) else [])
    if originals:
        out["bridgePaths"] = list(originals)
        out["paths"] = [copy(p, f"frame-{n}.png") for n, p in enumerate(originals)]
    if isinstance(resp.get("path"), str):
        out["bridgePath"] = resp["path"]
        out["path"] = copy(resp["path"], "frame-0.png")
    if isinstance(resp.get("sheetPath"), str):
        out["bridgeSheetPath"] = resp["sheetPath"]
        out["sheetPath"] = copy(resp["sheetPath"], "sheet.png")
    out["captureDir"] = str(folder)
    return out


def _size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def capture_owner(folder: Path) -> str:
    """The agent tag after a capture folder's stamp ('' for untagged ones), so each agent's folders are counted apart; a same-second `+n` suffix stays with its agent."""
    tag = folder.name[15:].split("+")[0]
    return tag[1:] if tag.startswith("-") else tag


def prune_captures(root: Path, keep: Optional[Path] = None, keep_folders: int = KEEP_FOLDERS, max_bytes: int = MAX_CAPTURE_BYTES,
                   min_age_s: float = MIN_AGE_S) -> List[Path]:
    """Keep each agent's newest 40 capture folders, then trim the oldest past 1 GB, never one under an hour old or the one just written. Returns what went."""
    try:
        folders = sorted((p for p in root.iterdir() if p.is_dir() and STAMP_RE.match(p.name)), key=lambda p: p.name)
    except OSError:
        return []
    removed: List[Path] = []

    def drop(p: Path) -> None:
        shutil.rmtree(p, ignore_errors=True)
        removed.append(p)
        folders.remove(p)

    by_owner: Dict[str, List[Path]] = {}
    for p in folders:
        by_owner.setdefault(capture_owner(p), []).append(p)
    for owned in by_owner.values():
        for p in [p for p in owned if p != keep][: max(0, len(owned) - keep_folders)]:
            drop(p)
    sizes = {p: _size(p) for p in folders}
    total = sum(sizes.values())
    now = time.time()
    for p in list(folders):
        if total <= max_bytes:
            break
        try:
            young = now - p.stat().st_mtime < min_age_s
        except OSError:
            young = False
        if p == keep or young:
            continue
        drop(p)
        total -= sizes[p]
    return removed


def captures_root(project: Any) -> Path:
    from . import lock

    return lock.kb_dir(project) / CAPTURES


def _musical(text: str) -> bool:
    from .beats import model

    return music.is_position(text) or model.is_range(text)


def place(project: Any, scope: Tuple[Any, List[Dict[str, Any]]], text: str, scene: Optional[str]) -> Dict[str, Any]:
    """A musical position as the frame that shows it: { scene, at (seconds into it), position, projectMs }. The scene is
    the one the editor attributes that moment to (mid-transition boundaries), or `scene` when the moment is inside it."""
    from .beats import model

    m, slots = scope
    r = model.resolve(text, m)
    if not r["ok"]:
        raise model.position_error(text, r)
    exact = r["projectMs"]
    rounded = music.round_ms(exact)
    total = music.round_ms(tl.timeline_total_ms(slots))
    if not slots or not 0 <= rounded <= total:
        raise KbError(f'"{text}" lands at {rounded} ms, outside the film (0 to {total} ms)', EXIT_PROBLEMS, kind="invalid",
                      hint="pick a position inside the film; ./kb beats lists each scene's bars")
    owner = model.owner_index(slots, rounded)
    index = owner
    if scene is not None:
        index = project.resolve(scene)[0]
    local = music.round_ms(exact - slots[index]["startMs"])
    if not model.in_slot(slots, index, local):
        stem = slots[owner]["stem"]
        raise KbError(f'"{text}" lands at {rounded} ms, in scene {owner} {stem}, outside {slots[index]["stem"]}', EXIT_PROBLEMS, kind="invalid",
                      hint=f"capture it with --scene {stem}, or drop --scene")
    return {"scene": slots[index]["stem"], "at": local / 1000, "position": text, "projectMs": music.round_ms(slots[index]["startMs"] + local)}


def position_frames(project: Any, spec: str, default_scene: Optional[str]) -> Tuple[List[Dict[str, Any]], List[Optional[Dict[str, Any]]]]:
    """--frames with positions: S@SEC and S as before, plus POS, S@POS, bars:A-B (each downbeat) and beats:A-B (every beat
    of bars A to B). Returns (frames for the request, each frame's { position, projectMs } or None)."""
    from .beats import model

    manifest = project.manifest()
    scope = (model.project_music(manifest), model.slots_of(project, manifest))
    items: List[Tuple[Optional[str], str, Optional[str]]] = []
    for part in (p.strip() for p in spec.split(",")):
        if not part:
            continue
        scene, rest = part.rsplit("@", 1) if "@" in part else (None, part)
        scene = scene.strip() if scene is not None else None
        rest = rest.strip()
        positions = model.expand_range(rest, scope[0], limit=bridge.MAX_FRAMES + 1) or ([rest] if music.is_position(rest) else None)
        if positions is None:
            items.append((None, part, None))
        else:
            items += [(scene if scene is not None else default_scene, text, "position") for text in positions]
        if len(items) > bridge.MAX_FRAMES:
            raise KbError(f"--frames comes to more than {bridge.MAX_FRAMES} frames; a request takes at most {bridge.MAX_FRAMES}, so split it", EXIT_ENV, kind="usage")
    if not items:
        raise KbError('--frames needs scene@seconds pairs or positions, e.g. "0@1,bar:13,beats:13-14"', EXIT_ENV, kind="usage")
    frames: List[Dict[str, Any]] = []
    meta: List[Optional[Dict[str, Any]]] = []
    for scene, text, kind in items:
        if kind is None:
            for f in bridge.frames_arg(text):
                f["scene"] = str(project.resolve(f["scene"])[1])
                frames.append(f)
                meta.append(None)
            continue
        placed = place(project, scope, text, scene)
        frames.append({"scene": placed["scene"], "at": placed["at"]})
        meta.append({"position": text, "projectMs": placed["projectMs"]})
    return frames, meta


def check_combinations(args: argparse.Namespace) -> None:
    """Flags that cannot go together are usage errors before anything is sent."""
    def refuse(message: str) -> None:
        raise KbError(message, EXIT_ENV, kind="usage")

    if args.count is not None and args.around is None:
        refuse("--count goes with --around POS")
    if args.around is not None and (args.frames or args.at is not None):
        refuse("--around picks its own frames; drop --frames and --at")
    if args.diff and (args.frames or args.at is not None or args.around is not None or args.crop):
        refuse("--diff A B names both frames; drop --frames, --at, --around and --crop")
    if args.diff and args.no_copy:
        refuse("--diff writes its comparison beside the copies; drop --no-copy")
    if args.crop and (args.width is not None or args.scale is not None or args.sheet):
        refuse("--crop crops a native-resolution frame; drop --width, --scale and --sheet")
    if args.crop and args.no_copy:
        refuse("--crop crops the copy and keeps the app's original; drop --no-copy")
    if args.count is not None and not 1 <= args.count <= bridge.MAX_FRAMES:
        refuse(f"--count takes 1 to {bridge.MAX_FRAMES} frames")


def around_request(project: Any, args: argparse.Namespace) -> Tuple[List[Dict[str, Any]], List[Optional[Dict[str, Any]]]]:
    """--around POS --count N as request frames and their meta."""
    from .beats import model

    count = args.count or DEFAULT_AROUND
    slots = tl.project_slots(project)
    index = project.resolve(args.scene)[0] if args.scene is not None else None
    if _musical(args.around):
        manifest = project.manifest()
        centre = float(place(project, (model.project_music(manifest), model.slots_of(project, manifest)), args.around, args.scene)["projectMs"])
    else:
        try:
            seconds = float(args.around)
        except ValueError:
            raise KbError(f'--around "{args.around}" is neither seconds into the scene nor a position', EXIT_ENV, kind="usage",
                          hint="use --scene S --around 1.5, or --around bar:13") from None
        if index is None:
            raise KbError("--around SECONDS counts from a scene's start; pass --scene S (or use a position like bar:13)", EXIT_ENV, kind="usage")
        slot = slots[index]
        if not 0 <= seconds * 1000 <= slot["durationMs"]:
            raise KbError(f"--around {seconds:g} is outside {slot['stem']} (0 to {slot['durationMs'] / 1000:g} s)", EXIT_PROBLEMS, kind="invalid")
        centre = slot["startMs"] + seconds * 1000
    picked, moved = around_frames(slots, centre, count, index)
    if moved:
        where = slots[index]["stem"] if index is not None else "the film"
        emit_err(f"kb: --around kept inside {where}: export frames {picked[0][0]} to {picked[-1][0]}")
    frames = [frame_for(slots, owner, t) for _, t, owner in picked]
    meta: List[Optional[Dict[str, Any]]] = [{"around": args.around, "frame": k, "projectMs": tl.js_round(t)} for k, t, _ in picked]
    return frames, meta


def cmd_capture(ctx: Any) -> int:
    args = ctx.args
    check_combinations(args)
    explicit_project = args.project
    # Bound before the election, so -C from another folder still picks this project's instance.
    project = None if explicit_project else ctx.project
    at_position = args.at is not None and _musical(args.at)
    frame_positions = bool(args.frames) and any(_musical(p.strip().rsplit("@", 1)[-1].strip()) for p in args.frames.split(","))
    if (at_position or frame_positions or args.around is not None or args.diff) and project is None:
        raise KbError("positions, --around and --diff need the project folder; run kb from it instead of passing --project", EXIT_ENV, kind="usage")
    seconds = None
    if args.at is not None and not at_position:
        try:
            seconds = float(args.at)
        except ValueError:
            raise KbError(f'--at "{args.at}" is neither seconds into the scene nor a position', EXIT_ENV, kind="usage",
                          hint="use --at 1.5 (seconds) or --at bar:13 (bar:B[.beat[.16th]], cue:ID, section:ID)") from None
    probe = parse_probe(args.probe)
    crop = parse_crop(args.crop)
    body: Dict[str, Any] = {}
    meta: List[Optional[Dict[str, Any]]] = []
    echo: Optional[Dict[str, Any]] = None
    if at_position:
        from .beats import model

        manifest = project.manifest()  # type: ignore[union-attr]
        placed = place(project, (model.project_music(manifest), model.slots_of(project, manifest)), args.at, args.scene)
        body.update(scene=placed["scene"], at=placed["at"])
        echo = None if args.frames else {"position": placed["position"], "projectMs": placed["projectMs"]}
    if args.frames and frame_positions:
        body["frames"], meta = position_frames(project, args.frames, args.scene)
    if args.around is not None:
        body["frames"], meta = around_request(project, args)
    if args.diff:
        slots = tl.project_slots(project)
        sides = [diff_frame(project, slots, spec, args.scene) for spec in args.diff]
        body["frames"], meta = [f for f, _ in sides], [m for _, m in sides]
    hb = bridge.require_app("capture", "kb capture", project)
    target = explicit_project or project.project_id  # type: ignore[union-attr]
    body["project"] = target
    if args.scene is not None and not at_position:
        body["scene"] = str(project.resolve(args.scene)[1]) if project else args.scene
    if seconds is not None:
        body["at"] = seconds
    if args.aspect:
        aspects = catmod.load_catalog().ids("aspects", catmod.FALLBACK_ASPECTS) or []
        if aspects and args.aspect not in aspects:
            raise KbError(f'unknown aspect "{args.aspect}"; one of {", ".join(aspects)}', EXIT_ENV, kind="usage")
        body["aspect"] = args.aspect
    if args.frames and not frame_positions:
        frames = bridge.frames_arg(args.frames)
        if project:
            for f in frames:
                f["scene"] = str(project.resolve(f["scene"])[1])
        body["frames"] = frames
    if args.sheet:
        body["sheet"] = True
    body.update(size_fields(args))
    native = native_size(body.get("aspect") or (hb.get("aspect") if isinstance(hb.get("aspect"), str) else None))
    count = len(body["frames"]) if body.get("frames") else 1
    box = crop_box(crop, native) if crop else None
    if box and count > 1:
        # A multi-frame capture renders at the 1280 px long edge unless it is sized; the native width keeps it native.
        body["width"] = native[0]
    natives: List[List[int]] = []
    if probe:
        size = capture_size(native, body.get("width"), body.get("scale"), count, bool(body.get("sheet")), probe=True)
        body["probe"], natives = map_probes(probe, native, size)
    wanted = {key: f"--{key}" for key in ("width", "scale", "probe") if key in body}
    if box and "width" in body and args.width is None:
        wanted["width"] = "--crop"
    if wanted:
        queue.require_features(hb, wanted)
    if "scene" not in body and "frames" not in body and hb.get("openProject") != target:
        raise KbError(
            f"{target} is not open in the app (open: {hb.get('openProject') or 'none'}); a playhead capture needs the open project. Pass --scene S (any project) or ask the user to open it",
            EXIT_ENV,
        )
    resp = bridge.require_ok(bridge.request("capture", body, args.timeout, "kb capture", client=ctx.caller.name), "capture")
    if project is not None:
        resp = label_transitions(resp, tl.project_slots(project))
    resp = with_positions(copied(ctx, resp, project), echo, meta)
    if natives:
        resp = with_native_probes(resp, natives)
    if box:
        resp = cropped(resp, box)
    if args.diff:
        resp = with_diff(resp)
    if ctx.json:
        ctx.out(resp, ok=True)
        return EXIT_OK
    print_capture(resp)
    return EXIT_OK


def with_native_probes(resp: Dict[str, Any], natives: List[List[int]]) -> Dict[str, Any]:
    """Each probe sample also names the native pixel it was asked for."""
    frames = resp.get("frames") if isinstance(resp.get("frames"), list) else None
    if not frames:
        return resp
    out = []
    for f in frames:
        probes = f.get("probes") if isinstance(f, dict) and isinstance(f.get("probes"), list) else None
        if probes is None:
            out.append(f)
            continue
        out.append(dict(f, probes=[dict(p, native=natives[i]) if isinstance(p, dict) and i < len(natives) else p for i, p in enumerate(probes)]))
    return dict(resp, frames=out)


def _copied_paths(resp: Dict[str, Any]) -> List[Path]:
    """The copies kb made (never the app's originals)."""
    seen: List[Path] = []
    frames = resp.get("frames") if isinstance(resp.get("frames"), list) else []
    pairs = [(f.get("path"), f.get("bridgePath")) for f in frames if isinstance(f, dict)] + [(resp.get("path"), resp.get("bridgePath"))]
    for raw, original in pairs:
        if isinstance(raw, str) and isinstance(original, str) and raw != original and Path(raw).is_file() and Path(raw) not in seen:
            seen.append(Path(raw))
    if not seen:
        raise KbError("kb could not copy the capture, so it left the app's frame as it is", EXIT_ENV, kind="env",
                      hint="rerun with --out DIR")
    return seen


def cropped(resp: Dict[str, Any], box: Dict[str, int]) -> Dict[str, Any]:
    """The copies cropped to the native box; the app's uncropped originals stay as bridgePath(s)."""
    from .film import probe as pb

    ffmpeg = pb.tools().ffmpeg
    for path in _copied_paths(resp):
        crop_png(ffmpeg, path, box)
    return dict(resp, crop=dict(box))


def with_diff(resp: Dict[str, Any]) -> Dict[str, Any]:
    """A | B | their difference beside the copies, with the numbers."""
    from .film import probe as pb

    frames = [f for f in resp.get("frames") or [] if isinstance(f, dict)]
    if len(frames) != 2 or not all(isinstance(f.get("path"), str) and Path(f["path"]).is_file() for f in frames):
        raise KbError("the app did not return both --diff frames", EXIT_PROBLEMS, kind="invalid")
    _copied_paths(resp)
    folder = Path(frames[0]["path"]).parent
    a, b = (Path(f["path"]) for f in frames)
    diff = diff_frames(pb.tools().ffmpeg, a, b, folder / "diff.png")

    def side(f: Dict[str, Any]) -> Dict[str, Any]:
        return {k: f[k] for k in ("spec", "scene", "at", "tMs", "projectMs", "label", "path") if f.get(k) is not None}

    return dict(resp, diff=dict(diff, a=side(frames[0]), b=side(frames[1])))


def with_positions(resp: Dict[str, Any], echo: Optional[Dict[str, Any]], meta: List[Optional[Dict[str, Any]]]) -> Dict[str, Any]:
    """The answer with the position each frame was asked for and the project ms it resolved to."""
    out = dict(resp, **echo) if echo else dict(resp)
    frames = resp.get("frames") if isinstance(resp.get("frames"), list) else None
    if frames is not None and (echo or any(meta)):
        tagged = []
        for i, f in enumerate(frames):
            extra = (meta[i] if i < len(meta) else None) if meta else echo
            tagged.append(dict(f, **extra) if isinstance(f, dict) and extra else f)
        out["frames"] = tagged
    return out


def copied(ctx: Any, resp: Dict[str, Any], project: Any) -> Dict[str, Any]:
    args = ctx.args
    if args.no_copy:
        return resp
    try:
        if args.out:
            return copy_captures(resp, reach.guard_write(project or ctx.project, args.out, "--out"))
        if project is None:
            project = ctx.project
        root = captures_root(project)
        folder = capture_folder(root, ctx.caller.name)
        out = copy_captures(resp, folder)
        prune_captures(root, keep=folder)
        return out
    except KbError:
        if args.out:
            raise
        return resp
    except OSError as e:
        raise KbError(f"could not copy the capture: {e.strerror or e}", EXIT_ENV, kind="env", hint="rerun with --no-copy, or --out DIR") from None


def print_capture(resp: Dict[str, Any]) -> None:
    frames_out = resp.get("frames") if isinstance(resp.get("frames"), list) else None
    if frames_out:
        for f in frames_out:
            if not isinstance(f, dict):
                continue
            pos = f" = {f['position']}" if f.get("position") else ""
            where = f"{f['label']}; " if f.get("label") else ""
            emit(f"{f.get('path')}  ({where}scene {f.get('scene')} at {f.get('at')}s, t={f.get('tMs')}ms{pos})")
            for p in f.get("probes") or []:
                if isinstance(p, dict):
                    rgba = ",".join(str(c) for c in p.get("rgba") or [])
                    native = p.get("native") if isinstance(p.get("native"), list) else None
                    asked = f" (native {native[0]},{native[1]})" if native and native != [p.get("x"), p.get("y")] else ""
                    emit(f"  probe {p.get('x')},{p.get('y')}{asked} = {p.get('hex')} rgba({rgba})")
    else:
        paths = resp.get("paths") if isinstance(resp.get("paths"), list) else [resp.get("path")]
        for p in paths:
            if p:
                emit(str(p))
        if resp.get("position"):
            emit_err(f"kb: {resp['position']} = {resp.get('projectMs')} ms in the film")
    if resp.get("sheetPath"):
        emit(f"sheet: {resp['sheetPath']}")
    crop = resp.get("crop") if isinstance(resp.get("crop"), dict) else None
    if crop:
        emit_err(f"kb: cropped to {crop['width']}x{crop['height']} at {crop['x']},{crop['y']} (native pixels); the app's full frame is bridgePath")
    diff = resp.get("diff") if isinstance(resp.get("diff"), dict) else None
    if diff:
        emit(f"diff: {diff['path']}  (A | B | difference x{DIFF_GAIN})")
        emit(f"  mean {diff['meanPct']}%, {diff['changedPct']}% of pixels changed by over {DIFF_THRESHOLD}/255, max {diff['maxPct']}%")
    size = resp.get("size") if isinstance(resp.get("size"), dict) else None
    native = resp.get("nativeSize") if isinstance(resp.get("nativeSize"), dict) else None
    if resp.get("format"):
        dims = f" at {size.get('width')}x{size.get('height')}" if size else ""
        scaled = f" (native {native.get('width')}x{native.get('height')})" if native and size and native != size else ""
        emit_err(f"kb: {resp.get('format')} frame{dims}{scaled} from {resp.get('project')}; Read the PNG to see it")
    served = bridge.served_line(resp)
    if served:
        emit_err(f"kb: {served}")


# ── debug ─────────────────────────────────────────────────────────────────────


def census_line(name: str, census: Any) -> List[str]:
    if not isinstance(census, dict) or not census:
        return [f"  {name}: no census reported yet"]
    alive = "" if "alive" not in census else ("alive, " if census.get("alive") else "not running, ")
    head = (
        f"  {name}: {alive}{census.get('live', 0)} live, {census.get('lost', 0)} lost "
        f"({census.get('evictions', 0)} evicted, {census.get('gpuLosses', 0)} GPU), {census.get('deliberate', 0)} released"
    )
    lines = [head]
    for c in census.get("contexts") or []:
        if isinstance(c, dict):
            state = f"lost ({c.get('lossClass')})" if c.get("lost") else "live"
            lines.append(f"    {c.get('owner')} {c.get('api')} {c.get('width')}x{c.get('height')} {state}, {int((c.get('ageMs') or 0) / 1000)} s old")
    return lines


def cmd_debug(ctx: Any) -> int:
    args = ctx.args
    op = args.op
    project = ctx.project
    hb = bridge.require_app("debug", f"kb debug {op}", project)
    queue.require_features(hb, {"debug": f"kb debug {op}"})
    body: Dict[str, Any] = {"op": op}
    if op == "lose-context":
        body["window"] = args.window
    resp = bridge.require_ok(bridge.request("debug", body, args.timeout, f"kb debug {op}", client=ctx.caller.name), "debug")
    if ctx.json:
        ctx.out(resp, ok=True)
        return EXIT_OK
    if op == "contexts":
        windows = resp.get("windows") if isinstance(resp.get("windows"), dict) else {}
        pids = resp.get("webContentPids") if isinstance(resp.get("webContentPids"), dict) else {}
        emit(f"WebGL contexts (WebKit keeps {resp.get('cap', 16)} live per WebContent process):")
        for name in ("editor", "render"):
            lines = census_line(name, windows.get(name))
            if pids.get(name):
                lines[0] += f"; WebContent pid {pids[name]}"
            for line in lines:
                emit(line)
    else:
        where = "the render window (it recycles now, with no backoff)" if args.window == "render" else "the editor's stage (the GPU banner shows)"
        emit(f"forced a WebGL context loss in {where}")
    return EXIT_OK


# ── kb status ─────────────────────────────────────────────────────────────────


def health_lines(data: Optional[Dict[str, Any]], now: Optional[int] = None) -> List[str]:
    """The capture service's state for kb status, from a heartbeat (or status data) carrying `health`."""
    health = queue.health_of(data)
    if not health:
        return []
    now = now if now is not None else now_ms()
    out: List[str] = []
    gpu = health.get("gpu") if isinstance(health.get("gpu"), dict) else {}
    if gpu.get("wedged"):
        out.append(
            "GPU WEDGED: the render window stalled 3 times in 10 minutes, so captures stop. "
            "Ask the user to quit and reopen Kookaburra Cut (or press Retry captures in the editor)."
        )
    elif gpu.get("stalled") and isinstance(gpu.get("stalledUntilMs"), (int, float)):
        out.append(f"GPU stalled: captures resume in about {max(1, int((gpu['stalledUntilMs'] - now) / 1000))} s; requests wait in the queue")
    q = health.get("queue") if isinstance(health.get("queue"), dict) else {}
    bits = [f"{q.get('depth', 0)} queued"]
    if isinstance(q.get("oldestAgeMs"), (int, float)):
        bits[0] += f" (oldest {int(q['oldestAgeMs'] / 1000)} s)"
    flight = q.get("inFlight") if isinstance(q.get("inFlight"), dict) else None
    if flight:
        bits.append(f"serving a {flight.get('kind')} for {flight.get('client')} ({flight.get('framesDone', 0)}/{flight.get('frames', 1)} frames)")
    if q.get("samples"):
        bits.append(f"about {q.get('unitMs')} ms a unit")
    out.append("Captures: " + ", ".join(bits))
    rw = health.get("renderWindow") if isinstance(health.get("renderWindow"), dict) else {}
    if rw.get("alive"):
        window = "Render window: alive"
        if isinstance(rw.get("beatAgeMs"), (int, float)):
            window += f", beat {rw['beatAgeMs'] / 1000:.1f} s ago"
        else:
            window += ", no beat yet"
    else:
        window = "Render window: closed (opens on the next capture)"
    if rw.get("restarting") is True and not gpu.get("wedged"):
        window += ", restarting after a GPU stall"
    if rw.get("recycles"):
        last = rw.get("lastRecycle") if isinstance(rw.get("lastRecycle"), dict) else {}
        window += f"; {rw['recycles']} recycle{'s' if rw['recycles'] != 1 else ''}"
        if last.get("reason"):
            window += f" (last: {last['reason']})"
    if rw.get("contentReloads"):
        window += f"; its page reloaded {rw['contentReloads']} time(s) (WebContent memory)"
    out.append(window)
    webgl = health.get("webgl") if isinstance(health.get("webgl"), dict) else {}
    cap = webgl.get("cap", 16)
    counts = []
    for name in ("editor", "render"):
        census = webgl.get(name)
        if isinstance(census, dict) and census:
            note = f"{name} {census.get('live', 0)}/{cap}"
            if census.get("evictions") or census.get("gpuLosses"):
                note += f" ({census.get('evictions', 0)} evicted, {census.get('gpuLosses', 0)} GPU losses)"
            counts.append(note)
    if counts:
        out.append("WebGL contexts: " + ", ".join(counts))
    return out


# ── parser ────────────────────────────────────────────────────────────────────


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """Adds `kb capture` and `kb debug` to kb's top-level subparsers."""
    s = sub.add_parser(
        "capture",
        help="render frames in the running app and print PNG paths to Read",
        description="render frames in the running app and print PNG paths to Read",
        epilog=CAPTURE_EPILOG,
        formatter_class=Formatter,
        parents=[common],
    )
    s.add_argument("--scene", help="scene index (0-based) or stem; default: the playhead")
    s.add_argument("--at", metavar="SEC|POS", help="seconds into the scene (default: its midpoint), or a musical position (bar:13, cue:drop)")
    s.add_argument("--aspect", help="render at this aspect for this request only (e.g. 9:16)")
    s.add_argument("--frames", help="several frames: S@SEC, S, POS, S@POS, bars:A-B, beats:A-B (comma separated, at most 48)")
    s.add_argument("--sheet", action="store_true", help="also write one contact-sheet PNG")
    size = s.add_mutually_exclusive_group()
    size.add_argument("--width", type=int, metavar="N", help="capture width in pixels (never upscaled)")
    size.add_argument("--scale", type=float, metavar="F", help="fraction of the native size, in (0, 1]")
    s.add_argument("--probe", action="append", metavar="X,Y[,X,Y...]",
                   help="sample exact pixels: native px (ints) or fractions in [0, 1], top left, at any size; implies native size unless sized")
    s.add_argument("--around", metavar="SEC|POS", help="consecutive frames at 60 fps centred here (seconds into --scene, or a position)")
    s.add_argument("--count", type=int, metavar="N", help=f"frames for --around (default {DEFAULT_AROUND}, at most 48)")
    s.add_argument("--crop", metavar="X,Y,W,H", help="crop the native-resolution frame: native px or fractions in [0, 1]")
    s.add_argument("--diff", nargs=2, metavar=("A", "B"), help="compare two frames (S@SEC, POS, S@POS, S@first, S@last): A | B | difference")
    copies = s.add_mutually_exclusive_group()
    copies.add_argument("--out", metavar="DIR", help="copy the PNGs into DIR instead of .kb/captures/")
    copies.add_argument("--no-copy", action="store_true", help="print the app's own paths, copy nothing")
    s.add_argument("--timeout", type=float, default=120, help="seconds to wait, queue included (default 120)")
    s.add_argument("--project", help=argparse.SUPPRESS)
    s.set_defaults(fn=cmd_capture)

    d = sub.add_parser(
        "debug",
        help="GPU diagnostics: every window's WebGL contexts, or force a context loss",
        description="GPU diagnostics: every window's WebGL contexts, or force a context loss",
        epilog="  kb debug contexts                      live and lost WebGL contexts per window (never opens a window)\n"
        "  kb debug lose-context                  lose the render window's context; it recycles at once\n"
        "  kb debug lose-context --window editor  dev builds only: shows the editor's GPU banner",
        formatter_class=Formatter,
        parents=[common],
    )
    dsub = d.add_subparsers(dest="op", metavar="OP")
    dsub.required = True
    x = dsub.add_parser("contexts", help="every window's WebGL census", parents=[common], formatter_class=Formatter)
    x.add_argument("--timeout", type=float, default=30)
    x = dsub.add_parser("lose-context", help="force a WebGL context loss (render window by default)", parents=[common], formatter_class=Formatter)
    x.add_argument("--window", choices=["render", "editor"], default="render")
    x.add_argument("--timeout", type=float, default=60)
    d.set_defaults(fn=cmd_debug)
