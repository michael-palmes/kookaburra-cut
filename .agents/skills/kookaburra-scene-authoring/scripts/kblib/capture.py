"""kb capture and kb debug: frames from the running app (sized, probed, and copied into the project's .kb/captures/), the GPU and WebGL diagnostics, and the capture-service lines in kb status (docs/agent-kit.md, "The capture service")."""

from __future__ import annotations

import argparse
import re
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import bridge
from . import catalog as catmod
from . import music, queue
from .film import timeline as tl
from .util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, emit, emit_err, now_ms

CAPTURES = "captures"
KEEP_FOLDERS = 40
MAX_CAPTURE_BYTES = 1024 ** 3
MIN_AGE_S = 3600
MAX_PROBES = 64
STAMP_RE = re.compile(r"^\d{8}-\d{6}")
UNSAFE_RE = re.compile(r"[^A-Za-z0-9._@-]+")

CAPTURE_EPILOG = """\
  kb capture                          the editor's playhead (this project must be open)
  kb capture --scene 03-x --at 1.5    one frame at its native size (3840x2160 for 16:9)
  kb capture --scene 2 --aspect 9:16
  kb capture --frames 0@1,3@2.5 --sheet   several frames (1280 px long edge) plus one contact sheet
  kb capture --scene 2 --scale 0.5    half size; --width 960 sets the width in pixels
  kb capture --scene 2 --probe 100,200,640,360   exact pixel values (x,y in the returned image, top left)
  ./kb capture --at bar:13                 the frame at a musical position, in the scene that owns it
  ./kb capture --frames bars:13-16 --sheet   each downbeat of bars 13 to 16 (beats:13-14 for every beat)
Positions (bar:B[.beat[.16th]], cue:ID, section:ID, optionally +40ms) resolve against audio.grid; a mid-transition
moment belongs to the scene the editor shows as current. With --scene S a position outside S is refused.
Copies land in .kb/captures/<time>-<agent>/ (each agent's newest 40 kept); --out DIR copies there, --no-copy
skips it. A request costs frames x ceil(pixels / 921600) units: at most 144 per request and 240 a
minute per agent (a 4K frame is 9 units, a 1280x720 frame 1)."""


def parse_probe(specs: Optional[List[str]]) -> Optional[List[List[int]]]:
    """--probe x,y[,x,y...] (repeatable) as [[x, y], ...]: whole pixels, at most 64 points."""
    if not specs:
        return None
    parts = [p.strip() for spec in specs for p in spec.split(",") if p.strip()]
    if not parts or len(parts) % 2:
        raise KbError("--probe needs x,y pairs, e.g. --probe 100,200,640,360", EXIT_ENV, kind="usage")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        raise KbError(f"--probe {','.join(parts)}: coordinates are whole pixels in the returned image", EXIT_ENV, kind="usage") from None
    if any(n < 0 for n in nums):
        raise KbError("--probe coordinates start at 0,0 (the top left)", EXIT_ENV, kind="usage")
    pairs = [[nums[i], nums[i + 1]] for i in range(0, len(nums), 2)]
    if len(pairs) > MAX_PROBES:
        raise KbError(f"--probe takes at most {MAX_PROBES} points (got {len(pairs)})", EXIT_ENV, kind="usage")
    return pairs


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
    """`05-feature@1.5s.png`: the scene stem and seconds into it."""
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


def cmd_capture(ctx: Any) -> int:
    args = ctx.args
    explicit_project = args.project
    # Bound before the election, so -C from another folder still picks this project's instance.
    project = None if explicit_project else ctx.project
    at_position = args.at is not None and _musical(args.at)
    frame_positions = bool(args.frames) and any(_musical(p.strip().rsplit("@", 1)[-1].strip()) for p in args.frames.split(","))
    if (at_position or frame_positions) and project is None:
        raise KbError("musical positions need the project folder; run kb from it instead of passing --project", EXIT_ENV, kind="usage")
    seconds = None
    if args.at is not None and not at_position:
        try:
            seconds = float(args.at)
        except ValueError:
            raise KbError(f'--at "{args.at}" is neither seconds into the scene nor a position', EXIT_ENV, kind="usage",
                          hint="use --at 1.5 (seconds) or --at bar:13 (bar:B[.beat[.16th]], cue:ID, section:ID)") from None
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
    probe = parse_probe(args.probe)
    if probe:
        body["probe"] = probe
    wanted = {key: f"--{key}" for key in ("width", "scale", "probe") if key in body}
    if wanted:
        queue.require_features(hb, wanted)
    if "scene" not in body and "frames" not in body and hb.get("openProject") != target:
        raise KbError(
            f"{target} is not open in the app (open: {hb.get('openProject') or 'none'}); a playhead capture needs the open project. Pass --scene S (any project) or ask the user to open it",
            EXIT_ENV,
        )
    resp = bridge.require_ok(bridge.request("capture", body, args.timeout, "kb capture", client=ctx.caller.name), "capture")
    resp = with_positions(copied(ctx, resp, project), echo, meta)
    if ctx.json:
        ctx.out(resp, ok=True)
        return EXIT_OK
    print_capture(resp)
    return EXIT_OK


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
            return copy_captures(resp, Path(args.out).expanduser().resolve())
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
            emit(f"{f.get('path')}  (scene {f.get('scene')} at {f.get('at')}s, t={f.get('tMs')}ms{pos})")
            for p in f.get("probes") or []:
                if isinstance(p, dict):
                    rgba = ",".join(str(c) for c in p.get("rgba") or [])
                    emit(f"  probe {p.get('x')},{p.get('y')} = {p.get('hex')} rgba({rgba})")
    else:
        paths = resp.get("paths") if isinstance(resp.get("paths"), list) else [resp.get("path")]
        for p in paths:
            if p:
                emit(str(p))
        if resp.get("position"):
            emit_err(f"kb: {resp['position']} = {resp.get('projectMs')} ms in the film")
    if resp.get("sheetPath"):
        emit(f"sheet: {resp['sheetPath']}")
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
    s.add_argument("--probe", action="append", metavar="X,Y[,X,Y...]", help="sample exact pixels (x,y in the returned image, top left); implies native size unless sized")
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
