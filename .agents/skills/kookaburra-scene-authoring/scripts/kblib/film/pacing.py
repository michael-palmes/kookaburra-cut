"""Pacing from the project files: words a viewer reads per scene (labels left out) against reading speed and the beat, the longest stretch with no motion (keyed, TSX-driven or measured from the film), and scenes too short to read as anything but a flash."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from ..project import Project
from ..tsx import strip_comments
from ..util import EXIT_ENV, KbError, is_number

WORDS_PER_SECOND = 3.0
MIN_SCENE_MS = 334
STILL_WARN_MS = 6000
KEYED_BLOCKS = ("camera", "cameraRig", "deviceTrack", "lighting")
# DESIGN.md's labels and captions top out at 0.18 world units in 16:9.
LABEL_MAX_FONT = 0.18
LABEL_TOKENS = frozenset(("label", "labels", "chip", "chips", "tag", "tags", "badge", "badges", "caption", "captions", "eyebrow",
                          "kicker", "footnote", "legend", "unit", "units", "axis", "meta"))
MOTION_SIDE = 32
MOTION_FPS = 5
# Mean change of a 32 x 32 grey thumbnail, or any one cell's change, that reads as motion (out of 255).
MOTION_MEAN = 0.6
MOTION_CELL = 6
DECODE_TIMEOUT_S = 600

_WORD_RE = re.compile(r"[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)
_TOKEN_RE = re.compile(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+")
_EMBEDDED_RE = re.compile(r"""useSceneText\(\s*["']([\w.-]+)["'][^;]*?["']embedded["']""")
_ELEMENT_RE = re.compile(r"<[A-Z][\w.]*\s[^<>]*>")
_TEXT_KEY_RE = re.compile(r"""\btextKey\s*=\s*(?:\{\s*)?["']([\w.-]+)["']""")
_FONT_SIZE_RE = re.compile(r"\bfontSize\s*=\s*\{\s*([0-9]*\.?[0-9]+)\s*\}")
_EMBEDDED_ROLE_RE = re.compile(r"""\bmanagedTextRole\s*=\s*(?:\{\s*)?["']embedded["']""")
_TSX_MOTION_RE = re.compile(r"\b(?:useTimeline|useGroupAnimation|useRigTrack)\s*\(|<(?:AnimatedGroup|AnimatedCounter)\b")


def count_words(text: Any) -> int:
    return len(_WORD_RE.findall(text)) if isinstance(text, str) else 0


def label_key(key: str) -> bool:
    """A key named like a label, chip, caption or eyebrow (`cardLabel`, `stat-unit`)."""
    return any(t.lower() in LABEL_TOKENS for t in _TOKEN_RE.findall(key))


def tsx_label_keys(tsx: str) -> Set[str]:
    """Keys the TSX renders at label size: embedded `useSceneText` copy, `managedTextRole="embedded"`, or a literal fontSize of 0.18 or less."""
    code = strip_comments(tsx or "")
    keys = set(_EMBEDDED_RE.findall(code))
    for element in _ELEMENT_RE.findall(code):
        key = _TEXT_KEY_RE.search(element)
        if not key:
            continue
        size = _FONT_SIZE_RE.search(element)
        if _EMBEDDED_ROLE_RE.search(element) or (size and float(size.group(1)) <= LABEL_MAX_FONT):
            keys.add(key.group(1))
    return keys


def tsx_moves(tsx: str) -> bool:
    """Whether the scene's code drives its own motion (reads the timeline or mounts an animated group or counter)."""
    return bool(_TSX_MOTION_RE.search(strip_comments(tsx or "")))


def scene_word_counts(doc: Optional[Dict[str, Any]], tsx: str = "") -> Tuple[int, int]:
    """(words a viewer reads, label words left out): managed items (bullet points too, never icons), else the sidecar's
    `text`; with a managed stack the remaining `text` keys are embedded labels, and label keys or label-size TSX text never count."""
    if not doc:
        return 0, 0
    labels = tsx_label_keys(tsx)
    counted = skipped = 0
    managed = doc.get("managedText")
    items = managed.get("items") if isinstance(managed, dict) else None
    stacked = isinstance(items, list)
    for item in items if stacked else []:
        if not isinstance(item, dict) or item.get("type") == "icon":
            continue
        points = item.get("points")
        if isinstance(points, list) and points:
            words = sum(count_words(p.get("text")) for p in points if isinstance(p, dict))
        else:
            words = count_words(item.get("text"))
        key = item.get("key") if isinstance(item.get("key"), str) else ""
        if key and (label_key(key) or key in labels):
            skipped += words
        else:
            counted += words
    text = doc.get("text")
    owned = {i["key"] for i in items or [] if isinstance(i, dict) and isinstance(i.get("key"), str)} if stacked else set()
    if isinstance(text, dict):
        for key, value in text.items():
            if key in owned:
                continue
            words = count_words(value)
            if stacked or label_key(key) or key in labels:
                skipped += words
            else:
                counted += words
    return counted, skipped


def scene_words(doc: Optional[Dict[str, Any]], tsx: str = "") -> int:
    """Words a viewer reads, label-size text left out."""
    return scene_word_counts(doc, tsx)[0]


def _keys(block: Any) -> List[float]:
    keys = block.get("keys") if isinstance(block, dict) else None
    return [float(k["tMs"]) for k in keys or [] if isinstance(k, dict) and is_number(k.get("tMs"))]


def keyed_times(doc: Optional[Dict[str, Any]]) -> List[float]:
    """Scene-local key times of the camera, rig, device, lighting and chart tracks."""
    if not doc:
        return []
    times: List[float] = []
    for name in KEYED_BLOCKS:
        times += _keys(doc.get(name))
    chart = doc.get("chart")
    if isinstance(chart, dict):
        times += _keys(chart.get("track"))
    return times


def beat_ms_of(project: Project) -> Optional[float]:
    """One beat of the authored grid in ms, or None without `audio.grid`."""
    from ..beats import model

    grid = model.grid_of(model.project_music(project.manifest()))
    return 60000.0 / grid["bpm"] if grid and is_number(grid.get("bpm")) and grid["bpm"] > 0 else None


# ── motion measured on the film ──────────────────────────────────────────────


def motion_args(ffmpeg: str, path: Path) -> List[str]:
    vf = f"fps={MOTION_FPS},scale={MOTION_SIDE}:{MOTION_SIDE}:flags=area,format=gray"
    return [ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-i", str(path), "-an", "-sn", "-dn", "-vf", vf,
            "-f", "rawvideo", "-pix_fmt", "gray", "-"]


def moving(a: bytes, b: bytes) -> bool:
    diffs = [abs(x - y) for x, y in zip(a, b)]
    return bool(diffs) and (sum(diffs) / len(diffs) >= MOTION_MEAN or max(diffs) >= MOTION_CELL)


def still_spans(samples: List[bytes], step_ms: float, start_ms: float = 0.0) -> List[Tuple[float, float]]:
    """Stretches where consecutive samples barely differ, as project (from, to) ms."""
    spans: List[Tuple[float, float]] = []
    run_from: Optional[int] = None
    for k in range(1, len(samples)):
        if moving(samples[k - 1], samples[k]):
            if run_from is not None and k - 1 > run_from:
                spans.append((start_ms + run_from * step_ms, start_ms + (k - 1) * step_ms))
            run_from = None
        elif run_from is None:
            run_from = k - 1
    if run_from is not None and len(samples) - 1 > run_from:
        spans.append((start_ms + run_from * step_ms, start_ms + (len(samples) - 1) * step_ms))
    return spans


def film_motion(ffmpeg: str, path: Path, fps: float, offset: int, slots: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Still stretches measured from frame differences: a 32 x 32 grey thumbnail every 200 ms, in project time (any poster frame skipped)."""
    try:
        proc = subprocess.run(motion_args(ffmpeg, path), capture_output=True, timeout=DECODE_TIMEOUT_S)
    except OSError as e:
        raise KbError(f"could not run ffmpeg: {e.strerror}", EXIT_ENV) from None
    except subprocess.TimeoutExpired:
        raise KbError(f"ffmpeg took longer than {DECODE_TIMEOUT_S} s measuring motion", EXIT_ENV) from None
    if proc.returncode != 0:
        raise KbError(f"ffmpeg could not measure motion in {path.name}: {proc.stderr.decode('utf-8', 'replace').strip()[-300:]}")
    size = MOTION_SIDE * MOTION_SIDE
    samples = [proc.stdout[i:i + size] for i in range(0, len(proc.stdout) - size + 1, size)]
    step = 1000.0 / MOTION_FPS
    poster_ms = offset * 1000.0 / fps if fps else 0.0
    total = float(slots[-1]["endMs"]) if slots else 0.0
    spans = [(max(0.0, a - poster_ms), min(total, b - poster_ms)) for a, b in still_spans(samples, step)]
    return {"source": "film", "stepMs": int(step), "samples": len(samples), "spans": [(a, b) for a, b in spans if b > a]}


# ── the check ────────────────────────────────────────────────────────────────


def _subtract(spans: List[Tuple[float, float]], cut: Tuple[float, float]) -> List[Tuple[float, float]]:
    out: List[Tuple[float, float]] = []
    lo, hi = cut
    for a, b in spans:
        if hi <= a or lo >= b:
            out.append((a, b))
            continue
        if lo > a:
            out.append((a, lo))
        if hi < b:
            out.append((hi, b))
    return out


def static_still_spans(project: Project, slots: List[Dict[str, Any]], docs: List[Optional[Dict[str, Any]]], tsx: List[str]) -> List[Tuple[float, float]]:
    """Gaps between keyed moves (scene and project camera keys), with scenes whose TSX drives motion taken out."""
    events: List[float] = []
    track = project.manifest().get("camera")
    for key in track if isinstance(track, list) else []:
        if isinstance(key, dict) and is_number(key.get("tMs")):
            events.append(float(key["tMs"]))
    for slot, doc in zip(slots, docs):
        events += [slot["startMs"] + t for t in keyed_times(doc) if 0 <= t <= slot["durationMs"]]
    total = float(slots[-1]["endMs"]) if slots else 0.0
    marks = sorted(set([0.0, total] + [e for e in events if 0 <= e <= total]))
    spans = list(zip(marks, marks[1:]))
    for slot, code in zip(slots, tsx):
        if tsx_moves(code):
            spans = _subtract(spans, (float(slot["startMs"]), float(slot["endMs"])))
    return spans


def longest_still(spans: List[Tuple[float, float]], slots: List[Dict[str, Any]], source: str) -> Dict[str, Any]:
    still: Dict[str, Any] = {"longestStillMs": 0, "fromMs": 0, "toMs": 0, "scenes": [], "source": source}
    for a, b in spans:
        if b - a > still["longestStillMs"]:
            touched = [s.get("stem") for s in slots if s["startMs"] < b and s["endMs"] > a]
            still.update(longestStillMs=int(round(b - a)), fromMs=int(round(a)), toMs=int(round(b)), scenes=touched)
    return still


def check(project: Project, slots: List[Dict[str, Any]], motion: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    scenes: List[Dict[str, Any]] = []
    warnings: List[str] = []
    docs: List[Optional[Dict[str, Any]]] = []
    codes: List[str] = []
    beat_ms = beat_ms_of(project)
    for n, slot in enumerate(slots):
        stem = slot.get("stem") or ""
        try:
            doc = project.load_sidecar(stem)
        except KbError:
            doc = None
        try:
            code = project.read_tsx(stem)
        except (OSError, UnicodeDecodeError):
            code = ""
        docs.append(doc)
        codes.append(code)
        words, label_words = scene_word_counts(doc, code)
        seconds = slot["durationMs"] / 1000.0
        rate = round(words / seconds, 2) if seconds > 0 else None
        row: Dict[str, Any] = {"index": slot["index"], "stem": stem, "durationMs": int(round(slot["durationMs"])), "words": words,
                               "labelWords": label_words, "wordsPerSecond": rate}
        per_beat = ""
        if beat_ms and slot["durationMs"] > 0:
            beats = slot["durationMs"] / beat_ms
            row["beats"] = round(beats, 2)
            row["wordsPerBeat"] = round(words / beats, 2)
            per_beat = f", {row['wordsPerBeat']:g} a beat over {row['beats']:g} beats"
        if rate is not None and rate > WORDS_PER_SECOND:
            need = int(round(words / WORDS_PER_SECOND * 1000))
            row["flag"] = "too much to read"
            warnings.append(f"{stem}: {words} words above label size in {seconds:.1f}s is {rate} a second{per_beat} "
                            f"(aim for {WORDS_PER_SECOND:g} a second); give it about {need} ms or cut words")
        # The film holds on its last frame, so the last scene never reads as a flash.
        if slot["durationMs"] < MIN_SCENE_MS and n < len(slots) - 1:
            row["flag"] = "shorter than a flash"
            warnings.append(f"{stem}: {int(slot['durationMs'])} ms on screen is under {MIN_SCENE_MS} ms, so it reads as a flash; "
                            "lengthen it or merge it into a neighbour")
        scenes.append(row)
    if motion is not None:
        still = longest_still([tuple(s) for s in motion.get("spans") or []], slots, "film")  # type: ignore[misc]
        what = "no motion detected in the film"
    else:
        still = longest_still(static_still_spans(project, slots, docs, codes), slots, "static")
        what = "no keyed or TSX motion"
    if still["longestStillMs"] > STILL_WARN_MS:
        warnings.append(f"{still['longestStillMs'] / 1000:.1f}s with {what} "
                        f"({still['fromMs'] / 1000:.1f}-{still['toMs'] / 1000:.1f}s, {', '.join(str(s) for s in still['scenes'])}); "
                        "fine for reading, but a move or a new beat keeps it alive")
    out: Dict[str, Any] = {"scenes": scenes, "still": still, "warnings": warnings, "wordsPerSecond": WORDS_PER_SECOND}
    if beat_ms:
        out["beatMs"] = round(beat_ms, 3)
    return out
