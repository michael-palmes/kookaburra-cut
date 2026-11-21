"""kb try: sidecar variants of one scene at one moment, rendered in memory by the app's render window and tiled as one
labelled sheet. Nothing is written to the project; keeping a variant is an ordinary `kb doc` write."""

from __future__ import annotations

import argparse
import itertools
import json
import shlex
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import bridge, queue
from . import capture as capmod
from . import catalog as catmod
from . import contact, lock
from .util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, Report, emit, emit_err

MAX_VARIANTS = 8
MAX_DOC_BYTES = 256 * 1024
LABEL_SCALE = 2
BOXES = {"landscape": (768, 432), "portrait": (360, 640), "square": (512, 512)}

EPILOG = """\
  ./kb try 04-reveal --at 9 --set backdrop.roughness=0.12,0.25,0.35,0.5
  ./kb try 04-reveal --at 9 --set lighting.lights.0.intensity=260,360 --set backdrop.roughness=0.12,0.3
  ./kb try 04-reveal --at bar:13 --variant matte=@.kb/agents/a/matte.json --variant 'mirror={"backdrop":{"roughness":0.05}}'

Each variant is the scene's sidecar with the change applied exactly as kb doc would write it. The app
renders it in memory beside the scene as saved, and nothing in scenes/ changes. Repeated --set flags
make a grid; at most 8 variants. Read the sheet, then keep one with the command kb prints."""


def split_values(raw: str) -> List[str]:
    """Top-level comma split that leaves commas inside [], {} and quotes alone."""
    out: List[str] = []
    depth, quote, start = 0, "", 0
    for i, ch in enumerate(raw):
        if quote:
            if ch == quote and raw[i - 1] != "\\":
                quote = ""
        elif ch in "\"'":
            quote = ch
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        elif ch == "," and depth == 0:
            out.append(raw[start:i])
            start = i + 1
    out.append(raw[start:])
    return [v.strip() for v in out]


def parse_set(spec: str) -> Tuple[str, List[Any], List[str]]:
    """`path=v1,v2` to (path, parsed values, their spellings)."""
    from . import docs as docmod

    path, sep, raw = spec.partition("=")
    path = path.strip()
    if not sep or not path or not raw.strip():
        raise KbError(f'--set "{spec}" needs PATH=VALUE[,VALUE...], e.g. backdrop.roughness=0.12,0.35', EXIT_ENV, kind="usage")
    docmod.split_path(path)
    words = [w for w in split_values(raw) if w != ""]
    if not words:
        raise KbError(f'--set "{spec}" lists no values', EXIT_ENV, kind="usage")
    return path, [docmod.parse_value(w) for w in words], words


def parse_variant(spec: str, project: Any) -> Tuple[str, Dict[str, Any]]:
    """`name=PATCH` (inline JSON or @file in the project) to (name, merge patch)."""
    from .cli import parse_json_arg

    name, sep, raw = spec.partition("=")
    name = name.strip()
    if not sep or not name or not raw.strip():
        raise KbError(f'--variant "{spec}" needs NAME=PATCH (a JSON merge patch, or @file.json)', EXIT_ENV, kind="usage")
    patch = parse_json_arg(raw.strip(), project)
    if not isinstance(patch, dict):
        raise KbError(f"--variant {name}: the patch must be a JSON object (RFC 7386 merge patch: null deletes a key)", EXIT_ENV, kind="usage")
    return name, patch


def plan_variants(sets: List[Tuple[str, List[Any], List[str]]], named: List[Tuple[str, Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Every combination of the --set values, then each --variant: { label, ops: [(op, path, arg, spelling)] }."""
    out: List[Dict[str, Any]] = []
    if sets:
        for combo in itertools.product(*[list(zip(values, words)) for _, values, words in sets]):
            ops = [("set", path, value, word) for (path, _, _), (value, word) in zip(sets, combo)]
            out.append({"label": "  ".join(f"{path}={word}" for _, path, _, word in ops), "ops": ops})
    for name, patch in named:
        out.append({"label": name, "ops": [("merge", "", patch, json.dumps(patch, separators=(",", ":"), ensure_ascii=False))]})
    if not out:
        raise KbError("nothing to try: pass --set PATH=V1,V2 or --variant NAME=PATCH", EXIT_ENV, kind="usage")
    if len(out) > MAX_VARIANTS:
        raise KbError(f"{len(out)} variants; kb try takes at most {MAX_VARIANTS} (fewer values, or one --set at a time)", EXIT_ENV, kind="usage")
    return out


def keep_commands(stem: str, ops: List[Tuple[str, str, Any, str]]) -> List[str]:
    cmds = []
    for op, path, _arg, word in ops:
        cmds.append(f"./kb doc {stem} merge {shlex.quote(word)}" if op == "merge" else f"./kb doc {stem} set {shlex.quote(path)} {shlex.quote(word)}")
    return cmds


def build_doc(project: Any, stem: str, saved: Optional[Dict[str, Any]], ops: List[Tuple[str, str, Any, str]], version: int) -> Dict[str, Any]:
    from .cli import sidecar_edit

    doc: Any = saved
    for op, path, arg, _word in ops:
        doc, _summary = sidecar_edit(project, stem, doc, op, path, arg, version)
    return doc


def refuse_new_errors(ctx: Any, label: str, saved: Optional[Dict[str, Any]], variant: Dict[str, Any], doc: Dict[str, Any]) -> None:
    from .cli import new_errors, sidecar_validator

    validate = sidecar_validator(ctx, label)
    fresh = new_errors(validate(saved) if saved is not None else Report(), validate(doc))
    if fresh:
        lines = "; ".join(f"{i.path}: {i.message}" if i.path else i.message for i in fresh)
        raise KbError(f'variant "{variant["label"]}" would add {len(fresh)} error(s) to {label}: {lines}', EXIT_PROBLEMS, kind="invalid",
                      hint="fix the value; nothing was rendered", data={"variant": variant["label"], "issues": [i.as_dict() for i in fresh]})
    size = len(json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-16-le")) // 2
    if size > MAX_DOC_BYTES:
        raise KbError(f'variant "{variant["label"]}" makes a {size}-byte sidecar; one takes at most {MAX_DOC_BYTES}', EXIT_PROBLEMS, kind="invalid")


def file_hash(path: Path) -> Optional[str]:
    try:
        return lock.sha256_hex(path.read_bytes())
    except OSError:
        return None


def tile_box(size: Any) -> Tuple[int, int]:
    w, h = (size.get("width"), size.get("height")) if isinstance(size, dict) else (16, 9)
    if not (isinstance(w, int) and isinstance(h, int)):
        return BOXES["landscape"]
    return BOXES["square"] if w == h else BOXES["landscape"] if w > h else BOXES["portrait"]


def resolve_at(project: Any, stem: str, at: str) -> float:
    if capmod._musical(at):
        from .beats import model

        manifest = project.manifest()
        placed = capmod.place(project, (model.project_music(manifest), model.slots_of(project, manifest)), at, stem)
        return float(placed["at"])
    try:
        return float(at)
    except ValueError:
        raise KbError(f'--at "{at}" is neither seconds into the scene nor a position', EXIT_ENV, kind="usage",
                      hint="use --at 9 (seconds) or --at bar:13 (bar:B[.beat[.16th]], cue:ID, section:ID)") from None


def cmd_try(ctx: Any) -> int:
    a = ctx.args
    project = ctx.project
    index, stem = project.resolve(a.scene)
    label = f"scenes/{stem}.json"
    sets = [parse_set(s) for s in a.set or []]
    named = [parse_variant(v, project) for v in a.variant or []]
    variants = plan_variants(sets, named)
    seconds = resolve_at(project, stem, a.at)
    version = catmod.scene_doc_version(catmod.load_catalog())
    sidecar = project.sidecar_path(stem)
    before = file_hash(sidecar)
    saved = project.load_sidecar(stem)
    for v in variants:
        v["doc"] = build_doc(project, stem, saved, v["ops"], version)
        v["saved"] = saved is not None and v["doc"] == saved
        if not v["saved"]:
            refuse_new_errors(ctx, label, saved, v, v["doc"])
        v["keep"] = [] if v["saved"] else keep_commands(stem, v["ops"])
    show_saved = not any(v["saved"] for v in variants)
    hb = bridge.require_app("capture", "kb try", project)
    queue.require_features(hb, {"sceneDoc": "kb try"})
    body: Dict[str, Any] = {"project": project.project_id}
    if a.aspect:
        aspects = catmod.load_catalog().ids("aspects", catmod.FALLBACK_ASPECTS) or []
        if aspects and a.aspect not in aspects:
            raise KbError(f'unknown aspect "{a.aspect}"; one of {", ".join(aspects)}', EXIT_ENV, kind="usage")
        body["aspect"] = a.aspect
    if a.width is not None:
        if a.width < 1:
            raise KbError("--width is a width in pixels, at least 1", EXIT_ENV, kind="usage")
        body["width"] = a.width
    frame = {"scene": str(index), "at": seconds}
    tiles = ([{"label": "saved", "saved": True, "keep": []}] if show_saved else []) + variants
    body["frames"] = [dict(frame, sceneDoc=t["doc"]) if not t["saved"] else dict(frame) for t in tiles]
    started = time.monotonic()
    resp = bridge.require_ok(bridge.request("capture", body, a.timeout, "kb try", client=ctx.caller.name), "capture")
    elapsed = time.monotonic() - started
    resp = capmod.copied(ctx, resp, project)
    frames = resp.get("frames") if isinstance(resp.get("frames"), list) else []
    if len(frames) != len(tiles) or any(not isinstance(f, dict) for f in frames):
        raise KbError(f"the app answered {len(frames)} frame(s) for {len(tiles)} tile(s)", EXIT_ENV, kind="env")
    changed = file_hash(sidecar) != before
    out_tiles = []
    for t, f in zip(tiles, frames):
        shown = t["label"] + (" (saved)" if t["saved"] and t["label"] != "saved" else "")
        out_tiles.append({"label": shown, "path": f.get("path"), "saved": t["saved"], "keep": t["keep"],
                          "warnings": f.get("sceneDocWarnings") or []})
    folder = Path(resp["captureDir"]) if isinstance(resp.get("captureDir"), str) else contact.new_folder(project, "try")
    cells = [{"label": t["label"], "image": t["path"], "surface": "on-dark"} for t in out_tiles]
    sheets, _ = contact.write_sheets(cells, folder, tile_box(resp.get("size")), name="try", label_scale=LABEL_SCALE)
    timing = resp.get("timing") if isinstance(resp.get("timing"), dict) else {}
    loads = timing.get("sceneDocLoads")
    render_s = timing["renderMs"] / 1000 if isinstance(timing.get("renderMs"), (int, float)) else None
    result = {
        "scene": stem, "at": seconds, "tMs": resp.get("tMs"), "format": resp.get("format"), "size": resp.get("size"),
        "sheet": str(sheets[0]) if sheets else None, "sheets": [str(s) for s in sheets], "tiles": out_tiles,
        "elapsedS": round(elapsed, 1), "sceneDocLoads": loads, "changedDuring": changed,
    }
    if changed:
        emit_err(f"kb: warning: {label} changed while the variants rendered; rerun kb try to compare against the new version")
    if ctx.json:
        ctx.out(result, ok=True)
        return EXIT_OK
    emit(f"kb try: {stem} at {seconds:g}s, {len(variants)} variant(s){' beside the saved scene' if show_saved else ''} ({resp.get('format')})")
    width = max(len(t["label"]) for t in out_tiles)
    for t in out_tiles:
        keep = "  keep: " + " && ".join(t["keep"]) if t["keep"] else ""
        emit(f"  {t['label'].ljust(width)}  {t['path']}{keep}")
        for w in t["warnings"]:
            emit(f"    the app dropped: {w}")
    for s in sheets:
        emit(f"sheet: {s}")
    per = f", {render_s / len(tiles):.1f} s a tile" if render_s is not None else ""
    emit_err(f"kb: rendered in memory, nothing in scenes/ changed ({elapsed:.1f} s{per}); Read the sheet")
    served = bridge.served_line(resp)
    if served:
        emit_err(f"kb: {served}")
    return EXIT_OK


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """Adds `kb try` to kb's top-level subparsers."""
    s = sub.add_parser("try", help="sidecar variants of one scene at one moment, rendered in memory, as one labelled sheet",
                       description="render sidecar variants of one scene at one moment beside the saved scene; nothing is written",
                       epilog=EPILOG, formatter_class=Formatter, parents=[common])
    s.add_argument("scene", metavar="SCENE", help="scene index (0-based) or stem")
    s.add_argument("--at", required=True, metavar="SEC|POS", help="seconds into the scene, or a musical position (bar:13, cue:drop)")
    s.add_argument("--set", action="append", metavar="PATH=V1,V2", help="a sidecar path and the values to try (repeat for a grid)")
    s.add_argument("--variant", action="append", metavar="NAME=PATCH", help="a named JSON merge patch, inline or @file.json")
    s.add_argument("--aspect", help="render at this aspect (default: the editor's)")
    s.add_argument("--width", type=int, metavar="N", help="tile width in pixels (default 1280 long edge)")
    s.add_argument("--timeout", type=float, default=180, help="seconds to wait, queue included (default 180)")
    s.set_defaults(fn=cmd_try, no_copy=False, out=None)
