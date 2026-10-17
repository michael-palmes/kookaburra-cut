"""Colour on the finished film: corner swatches of flat-background scenes against the colour the project asks for (CIEDE2000), measured colours elsewhere, and the static tone-mapping warning. Never fails a film."""

from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ..project import Project
from ..util import EXIT_ENV, KbError

PATCH_PX = 24
INSET = 0.03
DELTA_E_WARN = 2.0
EXACT_TONE_MAPPINGS = ("neutral", "linear")
DECODE_TIMEOUT_S = 600

_LINEAR = [((i / 255.0) / 12.92) if i / 255.0 <= 0.04045 else (((i / 255.0) + 0.055) / 1.055) ** 2.4 for i in range(256)]


def linear(byte: int) -> float:
    return _LINEAR[max(0, min(255, int(byte)))]


def hex_rgb(value: Any) -> Optional[Tuple[int, int, int]]:
    if not isinstance(value, str):
        return None
    h = value.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) == 8:
        h = h[:6]
    if len(h) != 6:
        return None
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        return None


def rgb_hex(rgb: Sequence[int]) -> str:
    return "#" + "".join(f"{max(0, min(255, int(c))):02x}" for c in rgb[:3])


def rgb_lab(rgb: Sequence[int]) -> Tuple[float, float, float]:
    """sRGB bytes to CIELAB (D65)."""
    r, g, b = (linear(c) for c in rgb[:3])
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t: float) -> float:
        return t ** (1 / 3) if t > 216 / 24389 else (24389 / 27 * t + 16) / 116

    fx, fy, fz = f(x), f(y), f(z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def ciede2000(lab1: Sequence[float], lab2: Sequence[float]) -> float:
    """Sharma, Wu and Dalal's CIEDE2000 (kL = kC = kH = 1)."""
    l1, a1, b1 = lab1
    l2, a2, b2 = lab2
    c1, c2 = math.hypot(a1, b1), math.hypot(a2, b2)
    cbar = (c1 + c2) / 2
    g = 0.5 * (1 - math.sqrt(cbar ** 7 / (cbar ** 7 + 25 ** 7))) if cbar else 0.0
    a1p, a2p = (1 + g) * a1, (1 + g) * a2
    c1p, c2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360 if c1p else 0.0
    h2p = math.degrees(math.atan2(b2, a2p)) % 360 if c2p else 0.0
    dlp = l2 - l1
    dcp = c2p - c1p
    if c1p * c2p == 0:
        dhp = 0.0
    elif abs(h2p - h1p) <= 180:
        dhp = h2p - h1p
    elif h2p - h1p > 180:
        dhp = h2p - h1p - 360
    else:
        dhp = h2p - h1p + 360
    dhp_big = 2 * math.sqrt(c1p * c2p) * math.sin(math.radians(dhp / 2))
    lbar = (l1 + l2) / 2
    cbarp = (c1p + c2p) / 2
    if c1p * c2p == 0:
        hbarp = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        hbarp = (h1p + h2p) / 2
    elif h1p + h2p < 360:
        hbarp = (h1p + h2p + 360) / 2
    else:
        hbarp = (h1p + h2p - 360) / 2
    t = (1 - 0.17 * math.cos(math.radians(hbarp - 30)) + 0.24 * math.cos(math.radians(2 * hbarp))
         + 0.32 * math.cos(math.radians(3 * hbarp + 6)) - 0.20 * math.cos(math.radians(4 * hbarp - 63)))
    d_theta = 30 * math.exp(-(((hbarp - 275) / 25) ** 2))
    rc = 2 * math.sqrt(cbarp ** 7 / (cbarp ** 7 + 25 ** 7)) if cbarp else 0.0
    sl = 1 + (0.015 * (lbar - 50) ** 2) / math.sqrt(20 + (lbar - 50) ** 2)
    sc = 1 + 0.045 * cbarp
    sh = 1 + 0.015 * cbarp * t
    rt = -math.sin(math.radians(2 * d_theta)) * rc
    return math.sqrt((dlp / sl) ** 2 + (dcp / sc) ** 2 + (dhp_big / sh) ** 2 + rt * (dcp / sc) * (dhp_big / sh))


def delta_e(rgb1: Sequence[int], rgb2: Sequence[int]) -> float:
    return ciede2000(rgb_lab(rgb1), rgb_lab(rgb2))


# ── decoding a few frames as raw pixels ──────────────────────────────────────


def select_expr(frames: Sequence[int]) -> str:
    return "+".join(f"eq(n\\,{int(n)})" for n in frames)


def raw_frames(ffmpeg: str, path: Path, frames: Sequence[int], graph_tail: str, frame_bytes: int) -> Dict[int, bytes]:
    """Selected frames through `[sel]<graph_tail>[out]` as packed rgb24 bytes, keyed by frame index."""
    order = sorted(set(int(f) for f in frames if f >= 0))
    if not order:
        return {}
    graph = f"[0:v]select='{select_expr(order)}',format=rgb24[sel];{graph_tail}"
    args = [ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-i", str(path), "-filter_complex", graph, "-map", "[out]",
            "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    try:
        proc = subprocess.run(args, capture_output=True, timeout=DECODE_TIMEOUT_S)
    except OSError as e:
        raise KbError(f"could not run ffmpeg: {e.strerror}", EXIT_ENV) from None
    except subprocess.TimeoutExpired:
        raise KbError(f"ffmpeg took longer than {DECODE_TIMEOUT_S} s reading frames", EXIT_ENV) from None
    if proc.returncode != 0:
        raise KbError(f"ffmpeg could not read frames from {path.name}: {proc.stderr.decode('utf-8', 'replace').strip()[-300:]}")
    data = proc.stdout
    out: Dict[int, bytes] = {}
    for i, n in enumerate(order):
        chunk = data[i * frame_bytes:(i + 1) * frame_bytes]
        if len(chunk) == frame_bytes:
            out[n] = chunk
    return out


def corner_origins(width: int, height: int, patch: int = PATCH_PX) -> List[Tuple[int, int]]:
    """Top-left corners of the four patches at a 3% inset: top-left, top-right, bottom-left, bottom-right."""
    dx, dy = int(round(width * INSET)), int(round(height * INSET))
    right, bottom = max(0, width - dx - patch), max(0, height - dy - patch)
    return [(dx, dy), (right, dy), (dx, bottom), (right, bottom)]


def measure_corners(ffmpeg: str, path: Path, frames: Sequence[int], width: int, height: int) -> Dict[int, List[Tuple[int, int, int]]]:
    """The mean colour of each corner patch (area-scaled to one pixel), per frame."""
    patch = max(1, min(PATCH_PX, width // 4, height // 4))
    legs = [f"[c{i}]crop={patch}:{patch}:{x}:{y},scale=1:1:flags=area[p{i}]" for i, (x, y) in enumerate(corner_origins(width, height, patch))]
    tail = "[sel]split=4[c0][c1][c2][c3];" + ";".join(legs) + ";[p0][p1][p2][p3]hstack=inputs=4[out]"
    raw = raw_frames(ffmpeg, path, frames, tail, 12)
    return {n: [tuple(b[i * 3:i * 3 + 3]) for i in range(4)] for n, b in raw.items()}  # type: ignore[misc]


# ── what the project asks for ────────────────────────────────────────────────


def _theme(project: Project, theme_id: str, catalog: Any) -> Optional[Dict[str, Any]]:
    """A theme's colours, background, backdrop and effects: workspace themes from their file, bundled ones from the catalogue."""
    path = project.theme_file(theme_id)
    if path is not None:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(raw, dict):
            return None
        effects = raw.get("effects")
        return {"colors": raw.get("colors") or {}, "background": raw.get("background"), "backdrop": raw.get("backdrop"),
                "effects": bool(effects) if isinstance(effects, (dict, list)) else False}
    for entry in (catalog.entries("themes") or []) if catalog is not None else []:
        if entry.get("id") == theme_id:
            return {"colors": entry.get("colors") or {}, "background": entry.get("background"), "backdrop": entry.get("backdrop"),
                    "effects": bool(entry.get("effects"))}
    return None


def _none(block: Any) -> bool:
    return isinstance(block, dict) and block.get("type") == "none"


def expected_background(project: Project, index: int, stem: str, catalog: Any) -> Dict[str, Any]:
    """`{ colour, source }` when scene `index` has a flat background, else `{ colour: None, reason }`."""
    manifest = project.manifest()
    try:
        doc = project.load_sidecar(stem) or {}
    except KbError:
        doc = {}
    theme_id = doc.get("themeId") if isinstance(doc.get("themeId"), str) else manifest.get("themeId")
    theme = _theme(project, str(theme_id or ""), catalog) or {}
    entries = project.scene_entries()
    entry = entries[index] if index < len(entries) and isinstance(entries[index], dict) else {}
    effects = bool(theme.get("effects")) or bool(entry.get("effects"))
    try:
        tsx = project.read_tsx(stem)
    except (OSError, UnicodeDecodeError):
        tsx = ""
    staged = "<SceneStage" in tsx or "<DepthStage" in tsx
    backdrop = doc.get("backdrop") if "backdrop" in doc else theme.get("backdrop")
    if backdrop and not _none(backdrop) and staged:
        return {"colour": None, "reason": "a staged backdrop"}
    bg = doc.get("background") if "background" in doc else theme.get("background")
    if isinstance(bg, dict) and bg.get("type") == "color" and hex_rgb(bg.get("color")):
        colour, source = bg["color"], "the scene's colour background" if "background" in doc else f"theme {theme_id}"
    elif bg is None or _none(bg):
        colour = (theme.get("colors") or {}).get("background")
        if not hex_rgb(colour):
            return {"colour": None, "reason": "no theme colour"}
        source = f"theme {theme_id} background colour"
    else:
        kind = bg.get("type") if isinstance(bg, dict) else bg
        return {"colour": None, "reason": f"a {kind} background"}
    if effects:
        return {"colour": None, "reason": "effects run on this scene", "measuredOnly": True, "wanted": colour}
    return {"colour": rgb_hex(hex_rgb(colour) or (0, 0, 0)), "source": source}


def tone_mapping_warning(project: Project, catalog: Any) -> Optional[str]:
    """Effects composite through the project's tone mapping, so brand colours shift unless it is neutral or linear."""
    manifest = project.manifest()
    render = manifest.get("render") if isinstance(manifest.get("render"), dict) else {}
    mode = render.get("toneMapping") if isinstance(render.get("toneMapping"), str) else "aces"
    if mode in EXACT_TONE_MAPPINGS:
        return None
    themes = {str(manifest.get("themeId") or "")}
    for entry in project.scene_entries():
        if isinstance(entry, dict) and entry.get("effects"):
            return f"effects run with {mode} tone mapping, which shifts flat colours; set project render.toneMapping to neutral for exact brand colours"
    for stem in project.stems():
        try:
            doc = project.load_sidecar(stem) or {}
        except KbError:
            continue
        if isinstance(doc.get("themeId"), str):
            themes.add(doc["themeId"])
    for theme_id in sorted(themes):
        if (_theme(project, theme_id, catalog) or {}).get("effects"):
            return f"theme {theme_id} runs effects with {mode} tone mapping, which shifts flat colours; set project render.toneMapping to neutral for exact brand colours"
    return None


def check(ffmpeg: str, path: Path, project: Project, slots: List[Dict[str, Any]], frames_by_scene: Dict[int, int],
          width: int, height: int, catalog: Any) -> Dict[str, Any]:
    """Swatches at each scene's settled frame: compared on flat backgrounds (warn over ΔE 2), measured elsewhere."""
    measured = measure_corners(ffmpeg, path, list(frames_by_scene.values()), width, height)
    swatches: List[Dict[str, Any]] = []
    warnings: List[str] = []
    for index, frame in sorted(frames_by_scene.items()):
        stem = slots[index].get("stem") or str(index)
        corners = measured.get(frame)
        if not corners:
            continue
        want = expected_background(project, index, stem, catalog)
        row: Dict[str, Any] = {"index": index, "stem": stem, "frame": frame, "corners": [rgb_hex(c) for c in corners]}
        if want.get("colour"):
            target = hex_rgb(want["colour"]) or (0, 0, 0)
            scores = [round(delta_e(c, target), 2) for c in corners]
            row.update({"expected": want["colour"], "source": want["source"], "deltaE": scores, "ok": max(scores) <= DELTA_E_WARN})
            if max(scores) > DELTA_E_WARN:
                warnings.append(f"{stem}: corners measure {', '.join(row['corners'])} against {want['colour']} ({want['source']}); "
                                f"ΔE up to {max(scores)} (over {DELTA_E_WARN})")
        else:
            row["note"] = f"measured only ({want.get('reason')})"
        swatches.append(row)
    tone = tone_mapping_warning(project, catalog)
    if tone:
        warnings.append(tone)
    return {"swatches": swatches, "warnings": warnings}
