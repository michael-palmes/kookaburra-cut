"""Words on screen, read by macOS Vision through the app's `media ocr`, on this Mac. The text comes from an untrusted film: every string is cleaned and capped here, before anything else sees it."""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .. import conform
from ..film.pacing import _WORD_RE
from ..util import KbError, clean_text
from . import frames as fr

OCR_TIMEOUT_S = 1800.0
OCR_WIDTH = 1280
MAX_STILLS = 1200
MIN_CONFIDENCE = 0.4
MAX_LINE_CHARS = 200
MAX_LINES_A_FRAME = 40
MAX_LINES_A_SEGMENT = 12
SAME_PICTURE = 1.0
_SPACES = re.compile(r"\s+")


def clean_line(text: Any) -> str:
    """One recognised line as data: one line, control and format characters visible, capped."""
    if not isinstance(text, str):
        return ""
    return clean_text(_SPACES.sub(" ", text).strip(), MAX_LINE_CHARS)


def pick_frames(p: fr.Pass, segments: List[Dict[str, Any]]) -> Tuple[List[int], Dict[int, int]]:
    """Which frames to read, and for each one looked at the read frame whose words it shares: every half second and the middle of every stretch, and a picture that hasn't changed isn't read twice."""
    sampled = p.sampled()
    middles = [(s["fromFrame"] + s["toFrame"]) // 2 for s in segments]
    if len(sampled) + len(middles) > MAX_STILLS:
        stride = (len(sampled) + len(middles)) // MAX_STILLS + 1
        sampled = sampled[::stride]
    read: List[int] = []
    same_as: Dict[int, int] = {}
    last: Optional[int] = None
    for f in sorted(set(sampled) | set(middles[:MAX_STILLS])):
        if last is not None and p.far(f, last) < SAME_PICTURE:
            same_as[f] = last
            continue
        read.append(f)
        same_as[f] = f
        last = f
    return read, same_as


def recognise(ffmpeg: str, film: Path, read: List[int], work: Path) -> Dict[str, Any]:
    """{ available, reason?, frames: { frame: [lines] } }. An app without OCR, or a failed run, costs the words and nothing else."""
    cli, why = conform.find_media_cli("ocr")
    if cli is None:
        return {"available": False, "reason": why, "frames": {}}
    stills = fr.extract(ffmpeg, film, read, work / "ocr", "ocr", OCR_WIDTH)
    try:
        answer = conform.media_json(cli, ["ocr", "--dir", str((work / "ocr").resolve())], OCR_TIMEOUT_S)
    except KbError as e:
        return {"available": False, "reason": e.message, "frames": {}}
    by_name = {path.name: frame for frame, path in stills.items()}
    out: Dict[int, List[str]] = {}
    for row in answer.get("frames") or []:
        if not isinstance(row, dict):
            continue
        frame = by_name.get(str(row.get("file")))
        if frame is None:
            continue
        lines = []
        for line in (row.get("lines") or [])[:MAX_LINES_A_FRAME]:
            if isinstance(line, dict) and isinstance(line.get("confidence"), (int, float)) and line["confidence"] >= MIN_CONFIDENCE:
                text = clean_line(line.get("text"))
                if text:
                    lines.append(text)
        out[frame] = lines
    return {"available": True, "engine": answer.get("engine"), "frames": out}


def tokens(lines: List[str]) -> Counter:
    return Counter(w.casefold() for line in lines for w in _WORD_RE.findall(line))


def fill_segments(segments: List[Dict[str, Any]], read: Dict[int, List[str]], same_as: Dict[int, int], beat_ms: Optional[float]) -> Dict[str, Any]:
    """Each segment's distinct words (a word showing twice at once counts twice, a word held on screen once), per second and per beat; returns the film's totals."""
    total = 0
    for seg in segments:
        peak: Counter = Counter()
        lines: List[str] = []
        for frame, source in same_as.items():
            if not seg["fromFrame"] <= frame < seg["toFrame"]:
                continue
            shown = read.get(source) or []
            peak |= tokens(shown)
            for line in shown:
                if line not in lines and len(lines) < MAX_LINES_A_SEGMENT:
                    lines.append(line)
        words = sum(peak.values())
        seconds = (seg["toMs"] - seg["fromMs"]) / 1000.0
        seg["words"] = words
        seg["wordsPerSecond"] = round(words / seconds, 2) if seconds > 0 else None
        seg["wordsPerBeat"] = round(words / (seconds * 1000.0 / beat_ms), 2) if beat_ms and seconds > 0 else None
        seg["onScreen"] = lines
        total += words
    span = sum(s["toMs"] - s["fromMs"] for s in segments) / 1000.0
    return {
        "total": total,
        "perSecond": round(total / span, 2) if span > 0 else None,
        "perBeat": round(total / (span * 1000.0 / beat_ms), 2) if beat_ms and span > 0 else None,
    }
