"""Pacing against the song (DESIGN.md, "Pacing"): each scene's words against their reading time (0.2 s a word plus 0.6 s
a line, rounded up to the beat; labels left out), every stretch where nothing new happens against the pulse its part of
the song asks for (a bar in quiet parts, 2 beats in peaks, never past 2.4 s, at most a bar after the final hit), whether
something lands on the final hit, and scenes too short to read as anything but a flash. Advice, never a rule: the
person decides, and a warning they keep is accepted with their reason (pacing.accepted.json)."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from ..beats import pulse
from ..media_input import input_args
from ..project import Project
from ..tsx import strip_comments
from ..util import EXIT_ENV, KbError, is_number

MIN_SCENE_MS = 334
KEYED_BLOCKS = ("camera", "cameraRig", "deviceTrack", "lighting")
# DESIGN.md's labels and captions top out at 0.18 world units in 16:9.
LABEL_MAX_FONT = 0.18
LABEL_TOKENS = frozenset(("label", "labels", "chip", "chips", "tag", "tags", "badge", "badges", "caption", "captions", "eyebrow",
                          "kicker", "footnote", "legend", "unit", "units", "axis", "meta"))
MOTION_SIDE = 32
MOTION_FPS = 10
# A change: EVENT_CELLS cells moving EVENT_DIFF (of 255) past their own median; live: that, or BUSY_CELLS moving BUSY_DIFF.
EVENT_DIFF = 6
EVENT_CELLS = 6
BUSY_DIFF = 8
BUSY_CELLS = 60
BASELINE_SAMPLES = 10
MERGE_SAMPLES = 2
# Film stretches are measured to the sample, so they get a sample either side; keyed ones are exact.
FILM_SLACK_MS = 250
STATIC_SLACK_MS = 50
DECODE_TIMEOUT_S = 600
ACCEPTED_FILE = "pacing.accepted.json"
ACCEPTED_VERSION = 1
KINDS = ("still", "read", "short", "final-hit", "end")

_WORD_RE = re.compile(r"[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)
_TOKEN_RE = re.compile(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+")
_EMBEDDED_RE = re.compile(r"""useSceneText\(\s*["']([\w.-]+)["'][^;]*?["']embedded["']""")
_ELEMENT_RE = re.compile(r"<[A-Z][\w.]*\s[^<>]*>")
_TEXT_KEY_RE = re.compile(r"""\btextKey\s*=\s*(?:\{\s*)?["']([\w.-]+)["']""")
_FONT_SIZE_RE = re.compile(r"\bfontSize\s*=\s*\{\s*([0-9]*\.?[0-9]+)\s*\}")
_EMBEDDED_ROLE_RE = re.compile(r"""\bmanagedTextRole\s*=\s*(?:\{\s*)?["']embedded["']""")
_TSX_MOTION_RE = re.compile(r"\b(?:useTimeline|useBeatGrid|useGroupAnimation|useRigTrack)\s*\(|<(?:AnimatedGroup|AnimatedCounter)\b")


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
    """Whether the scene's code drives its own motion (reads the timeline or the beat grid, or mounts an animated group or counter)."""
    return bool(_TSX_MOTION_RE.search(strip_comments(tsx or "")))


def plays_video(doc: Optional[Dict[str, Any]]) -> bool:
    """Whether the scene plays a video: a device screen, a media element or the background."""
    if not isinstance(doc, dict):
        return False
    specs: List[Any] = []
    for d in doc.get("devices") or []:
        if isinstance(d, dict):
            specs += [d.get("media"), d.get("coverMedia")]
    specs += [e for e in doc.get("media") or [] if isinstance(e, dict)]
    side = (doc.get("compare") or {}).get("b") if isinstance(doc.get("compare"), dict) else None
    for field in ("media", "coverMedia"):
        overrides = side.get(field) if isinstance(side, dict) else None
        specs += list(overrides.values()) if isinstance(overrides, dict) else []
    bg = doc.get("background")
    if isinstance(bg, dict) and bg.get("type") == "video":
        return True
    return any(isinstance(s, dict) and s.get("kind") == "video" for s in specs)


def scene_reading(doc: Optional[Dict[str, Any]], tsx: str = "") -> Tuple[int, int, int]:
    """(words a viewer reads, lines they sit on, label words left out): managed items (each bullet point a line, never
    icons), else the sidecar's `text`; with a managed stack the remaining `text` keys are embedded labels, and label
    keys or label-size TSX text never count."""
    if not doc:
        return 0, 0, 0
    labels = tsx_label_keys(tsx)
    counted = lines = skipped = 0
    managed = doc.get("managedText")
    items = managed.get("items") if isinstance(managed, dict) else None
    stacked = isinstance(items, list)
    for item in items if stacked else []:
        if not isinstance(item, dict) or item.get("type") == "icon":
            continue
        points = item.get("points")
        if isinstance(points, list) and points:
            per = [count_words(p.get("text")) for p in points if isinstance(p, dict)]
        else:
            per = [count_words(item.get("text"))]
        key = item.get("key") if isinstance(item.get("key"), str) else ""
        if key and (label_key(key) or key in labels):
            skipped += sum(per)
        else:
            counted += sum(per)
            lines += sum(1 for w in per if w)
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
                lines += 1 if words else 0
    return counted, lines, skipped


def scene_word_counts(doc: Optional[Dict[str, Any]], tsx: str = "") -> Tuple[int, int]:
    """(words a viewer reads, label words left out)."""
    words, _lines, skipped = scene_reading(doc, tsx)
    return words, skipped


def scene_words(doc: Optional[Dict[str, Any]], tsx: str = "") -> int:
    """Words a viewer reads, label-size text left out."""
    return scene_reading(doc, tsx)[0]


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


# ── changes measured on the film ─────────────────────────────────────────────


def motion_args(ffmpeg: str, path: Path) -> List[str]:
    vf = f"fps={MOTION_FPS},scale={MOTION_SIDE}:{MOTION_SIDE}:flags=area,format=gray"
    return [ffmpeg, "-hide_banner", "-nostdin", "-v", "error", *input_args(path), "-i", str(path), "-an", "-sn", "-dn", "-vf", vf,
            "-f", "rawvideo", "-pix_fmt", "gray", "-"]


def change_marks(samples: List[bytes]) -> Tuple[List[int], List[bool]]:
    """(the samples where something new appears, whether each sample is live) from consecutive thumbnails. Sample k
    compares thumbnails k-1 and k (sample 0 is never live). A change is enough cells moving well past their own level
    over the second around; live is a change or steady fast motion."""
    diffs = [bytes(abs(x - y) for x, y in zip(samples[k - 1], samples[k])) for k in range(1, len(samples))]
    events: List[int] = []
    live = [False] * len(samples)
    for k, row in enumerate(diffs):
        lo, hi = max(0, k - BASELINE_SAMPLES), min(len(diffs), k + BASELINE_SAMPLES + 1)
        hits = 0
        for c, x in enumerate(row):
            if x < EVENT_DIFF:
                continue
            around = sorted(diffs[j][c] for j in range(lo, hi) if j != k)
            if not around or x - around[len(around) // 2] >= EVENT_DIFF:
                hits += 1
                if hits >= EVENT_CELLS:
                    break
        if hits >= EVENT_CELLS:
            events.append(k + 1)
            live[k + 1] = True
        elif sum(1 for x in row if x >= BUSY_DIFF) >= BUSY_CELLS:
            live[k + 1] = True
    # One change per burst of samples: a kick's attack and release, or a cut and its settle, land as one.
    starts = [e for i, e in enumerate(events) if i == 0 or e - events[i - 1] > MERGE_SAMPLES]
    return starts, live


def still_spans(samples: List[bytes], step_ms: float, start_ms: float = 0.0) -> List[Tuple[float, float]]:
    """Stretches where nothing new appears, as project (from, to) ms: between one live sample and the next."""
    return spans_of(change_marks(samples)[1], step_ms, start_ms) if samples else []


def spans_of(live: List[bool], step_ms: float, start_ms: float = 0.0) -> List[Tuple[float, float]]:
    if not live:
        return []
    marks = [0] + [k for k, flag in enumerate(live) if flag] + [len(live) - 1]
    return [(start_ms + a * step_ms, start_ms + b * step_ms) for a, b in zip(marks, marks[1:]) if b > a + 1 or (b > a and not live[b])]


def film_motion(ffmpeg: str, path: Path, fps: float, offset: int, slots: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Changes and still stretches measured on the film: a 32 x 32 grey thumbnail every 100 ms, in project time (any poster frame skipped)."""
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
    events, live = change_marks(samples)
    spans = [(max(0.0, a - poster_ms), min(total, b - poster_ms)) for a, b in spans_of(live, step)]
    changes = [k * step - poster_ms for k in events if 0 <= k * step - poster_ms <= total]
    return {"source": "film", "stepMs": int(step), "samples": len(samples), "spans": [(a, b) for a, b in spans if b > a], "changes": changes}


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


def kick_times(doc: Optional[Dict[str, Any]], m: Optional[Dict[str, Any]], start_ms: float) -> List[float]:
    """Scene-local ms of each camera kick: `at` in ms, or a position resolved against the grid."""
    from ..beats import model

    out: List[float] = []
    for kick in (doc or {}).get("cameraKicks") or []:
        at = kick.get("at") if isinstance(kick, dict) else None
        if is_number(at):
            out.append(float(at))
        elif isinstance(at, str):
            r = model.resolve_local(at, m, start_ms)
            if r["ok"]:
                out.append(float(r["projectMs"]))
    return out


def static_still_spans(project: Project, slots: List[Dict[str, Any]], docs: List[Optional[Dict[str, Any]]], tsx: List[str]) -> List[Tuple[float, float]]:
    """Gaps between cuts, keyed moves (scene and project camera keys) and camera kicks, with scenes whose TSX drives
    motion or that play a video taken out."""
    from ..beats import model

    m = model.project_music(project.manifest())
    events: List[float] = []
    track = project.manifest().get("camera")
    for key in track if isinstance(track, list) else []:
        if isinstance(key, dict) and is_number(key.get("tMs")):
            events.append(float(key["tMs"]))
    for slot, doc in zip(slots, docs):
        events.append(float(slot["startMs"]))
        events += [slot["startMs"] + t for t in keyed_times(doc) + kick_times(doc, m, slot["startMs"]) if 0 <= t <= slot["durationMs"]]
    total = float(slots[-1]["endMs"]) if slots else 0.0
    marks = sorted(set([0.0, total] + [e for e in events if 0 <= e <= total]))
    spans = list(zip(marks, marks[1:]))
    for slot, code, doc in zip(slots, tsx, docs):
        if tsx_moves(code) or plays_video(doc):
            spans = _subtract(spans, (float(slot["startMs"]), float(slot["endMs"])))
    return spans


def longest_still(spans: List[Tuple[float, float]], slots: List[Dict[str, Any]], source: str) -> Dict[str, Any]:
    still: Dict[str, Any] = {"longestStillMs": 0, "fromMs": 0, "toMs": 0, "scenes": [], "source": source}
    for a, b in spans:
        if b - a > still["longestStillMs"]:
            still.update(longestStillMs=int(round(b - a)), fromMs=int(round(a)), toMs=int(round(b)), scenes=scenes_in(slots, a, b))
    return still


def scenes_in(slots: List[Dict[str, Any]], a: float, b: float) -> List[str]:
    return [s.get("stem") for s in slots if s["startMs"] < b and s["endMs"] > a] or [slots[-1].get("stem")] if slots else []


def scene_at(slots: List[Dict[str, Any]], ms: float) -> Optional[str]:
    for s in slots:
        if s["startMs"] <= ms < s["endMs"]:
            return s.get("stem")
    return slots[-1].get("stem") if slots else None


def window_ms(slots: List[Dict[str, Any]], n: int) -> float:
    """The part of a scene no transition covers: its length less half of each overlap."""
    slot = slots[n]
    t_in = slot["transitionIn"]["durationMs"] if isinstance(slot.get("transitionIn"), dict) else 0
    nxt = slots[n + 1] if n + 1 < len(slots) else None
    t_out = nxt["transitionIn"]["durationMs"] if nxt and isinstance(nxt.get("transitionIn"), dict) else 0
    return float(slot["durationMs"]) - t_in / 2 - t_out / 2


def _at(shape: Dict[str, Any], ms: float) -> str:
    where = pulse.position(shape, ms)
    return f"{ms / 1000:.2f}s" + (f" ({where})" if where else "")


def _span(shape: Dict[str, Any], a: float, b: float) -> str:
    lo, hi = pulse.position(shape, a), pulse.position(shape, b)
    return f"{a / 1000:.1f}-{b / 1000:.1f}s" + (f", {lo} to {hi}" if lo and hi else "")


def still_issues(shape: Dict[str, Any], spans: List[Tuple[float, float]], slots: List[Dict[str, Any]], film: bool) -> List[Dict[str, Any]]:
    """A still stretch past the pulse of its part of the song; the last one, the hold at the end, may run a bar."""
    total = float(slots[-1]["endMs"]) if slots else 0.0
    slack = FILM_SLACK_MS if film else STATIC_SLACK_MS
    what = "nothing new appears" if film else "nothing keyed, scripted or playing moves"
    out = []
    for a, b in spans:
        if b >= total - slack:
            allowed, why = shape["barMs"], "the ending holds at most a bar"
        else:
            p = pulse.pulse_at(shape, (a + b) / 2)
            allowed = p["allowedMs"]
            if p["kind"] == "end":
                why = "after the final hit, hold at most a bar"
            elif not shape["grid"]:
                why = "with no soundtrack, something new every 2 s"
            else:
                part = f"in {p['part']}" if p["part"] else "here"
                why = f"{part} the song asks for something new {pulse.pulse_words(p['beats'], shape['beatsPerBar'])}"
                if allowed < p["beats"] * shape["beatMs"]:
                    why += ", and never more than 2.4 s"
        if b - a > allowed + slack:
            stems = scenes_in(slots, a, b)
            out.append({"kind": "still", "scene": scene_at(slots, (a + b) / 2), "atMs": int(round(a)), "toMs": int(round(b)),
                        "message": f"{(b - a) / 1000:.1f}s where {what} ({_span(shape, a, b)}, {', '.join(str(s) for s in stems)}): "
                                   f"{why}. Land a line, a camera key or a kick inside it, or cut sooner"})
    return out


def ending_issues(shape: Dict[str, Any], slots: List[Dict[str, Any]], changes: Optional[List[float]]) -> List[Dict[str, Any]]:
    """The film running more than a bar past the final hit, and (on the film) nothing landing on it."""
    final, total = shape.get("finalHitMs"), (float(slots[-1]["endMs"]) if slots else 0.0)
    if final is None or not slots or final > total:
        return []
    last = slots[-1].get("stem")
    out = []
    if total - final > shape["barMs"] + STATIC_SLACK_MS:
        out.append({"kind": "end", "scene": last, "atMs": int(round(final)),
                    "message": f"the film runs {(total - final) / 1000:.1f}s past the song's final hit at {_at(shape, final)}: land the payoff "
                               "on it and end within a bar (./kb project fit --to song-end --hold MS)"})
    if changes is not None:
        near = max(FILM_SLACK_MS, shape["beatMs"] / 2)
        if not any(abs(c - final) <= near for c in changes):
            before = [c for c in changes if c < final]
            was = f"; the last change is at {_at(shape, before[-1])}" if before else ""
            out.append({"kind": "final-hit", "scene": scene_at(slots, final), "atMs": int(round(final)),
                        "message": f"nothing lands on the song's final hit at {_at(shape, final)}{was}: land the payoff (the name or the call "
                                   "to action) on it"})
    return out


# ── accepted warnings ────────────────────────────────────────────────────────


def issue_id(kind: str, scene: Optional[str]) -> str:
    return hashlib.sha1(f"{kind}|{scene or ''}".encode("utf-8")).hexdigest()[:8]


def load_accepted(project: Project) -> List[Dict[str, Any]]:
    try:
        doc = json.loads((project.root / ACCEPTED_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rows = doc.get("accepted") if isinstance(doc, dict) else None
    return [r for r in rows or [] if isinstance(r, dict) and r.get("kind") in KINDS and isinstance(r.get("why"), str)]


def accepted_merge(doc: Any, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    have = [r for r in (doc.get("accepted") if isinstance(doc, dict) else None) or [] if isinstance(r, dict)]
    ids = {r["id"] for r in rows}
    return {"version": ACCEPTED_VERSION, "accepted": [r for r in have if r.get("id") not in ids] + rows}


def accepted_without(doc: Any, ids: List[str]) -> Dict[str, Any]:
    have = [r for r in (doc.get("accepted") if isinstance(doc, dict) else None) or [] if isinstance(r, dict)]
    return {"version": ACCEPTED_VERSION, "accepted": [r for r in have if r.get("id") not in ids]}


def split_accepted(issues: List[Dict[str, Any]], accepted: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """(warnings still open, warnings the person kept): accepted per kind and scene, with their reason."""
    by = {(a.get("kind"), a.get("scene")): a for a in accepted}
    open_, kept = [], []
    for issue in issues:
        hit = by.get((issue["kind"], issue.get("scene")))
        issue["id"] = issue_id(issue["kind"], issue.get("scene"))
        if hit is None:
            open_.append(issue)
        else:
            kept.append(dict(issue, why=hit.get("why"), by=hit.get("by")))
    return open_, kept


def check(project: Project, slots: List[Dict[str, Any]], motion: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    scenes: List[Dict[str, Any]] = []
    issues: List[Dict[str, Any]] = []
    docs: List[Optional[Dict[str, Any]]] = []
    codes: List[str] = []
    shape = pulse.song_shape(project)
    beat_ms = shape["beatMs"] if shape["grid"] else None
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
        words, lines, label_words = scene_reading(doc, code)
        seconds = slot["durationMs"] / 1000.0
        need = pulse.reading_ms(words, lines, beat_ms)
        shown = window_ms(slots, n)
        row: Dict[str, Any] = {"index": slot["index"], "stem": stem, "durationMs": int(round(slot["durationMs"])), "words": words, "lines": lines,
                               "labelWords": label_words, "readMs": need, "wordsPerSecond": round(words / seconds, 2) if seconds > 0 else None}
        if beat_ms and slot["durationMs"] > 0:
            beats = slot["durationMs"] / beat_ms
            row["beats"] = round(beats, 2)
            row["wordsPerBeat"] = round(words / beats, 2)
        if words and need > shown + 1:
            row["flag"] = "too much to read"
            to_beat = f" ({round(need / beat_ms):g} beats)" if beat_ms else ""
            issues.append({"kind": "read", "scene": stem, "atMs": int(round(slot["startMs"])),
                           "message": f"{stem}: {words} words on {lines} line{'s' if lines != 1 else ''} need {need / 1000:.1f}s{to_beat} to read once "
                                      f"(0.2 s a word and 0.6 s a line{', to the beat' if beat_ms else ''}) and show for {shown / 1000:.1f}s; "
                                      "give it the time or cut words"})
        # The film holds on its last frame, so the last scene never reads as a flash.
        if slot["durationMs"] < MIN_SCENE_MS and n < len(slots) - 1:
            row["flag"] = "shorter than a flash"
            issues.append({"kind": "short", "scene": stem, "atMs": int(round(slot["startMs"])),
                           "message": f"{stem}: {int(slot['durationMs'])} ms on screen is under {MIN_SCENE_MS} ms, so it reads as a flash; "
                                      "lengthen it or merge it into a neighbour (a burst cuts inside one scene)"})
        scenes.append(row)
    film = motion is not None
    if film:
        spans = [tuple(s) for s in motion.get("spans") or []]  # type: ignore[union-attr]
    else:
        spans = static_still_spans(project, slots, docs, codes)
    still = longest_still(spans, slots, "film" if film else "static")  # type: ignore[arg-type]
    issues += still_issues(shape, spans, slots, film)  # type: ignore[arg-type]
    issues += ending_issues(shape, slots, motion.get("changes") if film else None)  # type: ignore[union-attr]
    open_, kept = split_accepted(issues, load_accepted(project))
    out: Dict[str, Any] = {"scenes": scenes, "still": still, "issues": open_, "accepted": kept, "warnings": [i["message"] for i in open_],
                           "readWordMs": pulse.READ_WORD_MS, "readLineMs": pulse.READ_SETTLE_MS,
                           "song": {"grid": shape["grid"], "parts": [{k: p[k] for k in ("id", "kind", "fromBar", "toBar")} for p in shape["parts"]],
                                    "partsSource": shape["partsSource"], "finalHit": shape["finalHit"], "soundtrack": shape["soundtrack"]}}
    if beat_ms:
        out["beatMs"] = round(beat_ms, 3)
    if film:
        total = float(slots[-1]["endMs"]) if slots else 0.0
        count = len(motion.get("changes") or [])  # type: ignore[union-attr]
        out["changes"] = {"count": count, "perBar": round(count / (total / shape["barMs"]), 2) if total else None}
    return out
