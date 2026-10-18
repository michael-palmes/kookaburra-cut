"""Facts about a finished film from the app's bundled ffprobe and ffmpeg: streams, frame count, colour tags and loudness."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..util import EXIT_ENV, EXIT_PROBLEMS, KbError
from ..video.passes import Tools, find_tools, parse_rate, rust_round

PROBE_TIMEOUT_S = 120
LOUDNESS_TIMEOUT_S = 1800

_SUMMARY_RE = {
    "integratedLufs": re.compile(r"^\s*I:\s*(-?[0-9.]+|-inf)\s*LUFS", re.M),
    "lra": re.compile(r"^\s*LRA:\s*(-?[0-9.]+)\s*LU\b", re.M),
    "truePeakDbtp": re.compile(r"^\s*Peak:\s*(-?[0-9.]+|-inf)\s*dBFS", re.M),
}


def tools() -> Tools:
    return find_tools()


def _run(args: List[str], timeout: float) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout, errors="replace")
    except OSError as e:
        raise KbError(f"could not run {Path(args[0]).name}: {e.strerror}", EXIT_ENV) from None
    except subprocess.TimeoutExpired:
        raise KbError(f"{Path(args[0]).name} took longer than {int(timeout)} s", EXIT_ENV) from None


def _int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _ms(seconds: Any) -> Optional[int]:
    try:
        return rust_round(float(seconds) * 1000)
    except (TypeError, ValueError):
        return None


def parse_streams(data: Dict[str, Any]) -> Dict[str, Any]:
    """ffprobe's JSON reduced to the facts verify-export checks."""
    streams = [s for s in data.get("streams") or [] if isinstance(s, dict)]
    fmt = data.get("format") if isinstance(data.get("format"), dict) else {}
    video = next((s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    out: Dict[str, Any] = {
        "container": fmt.get("format_name"),
        "durationMs": _ms(fmt.get("duration")),
        "bytes": _int(fmt.get("size")),
        "video": None,
        "audio": None,
    }
    if video:
        out["video"] = {
            "codec": video.get("codec_name"),
            "profile": video.get("profile"),
            "pixFmt": video.get("pix_fmt"),
            "width": _int(video.get("width")),
            "height": _int(video.get("height")),
            "rFps": round(parse_rate(video.get("r_frame_rate")), 4),
            "avgFps": round(parse_rate(video.get("avg_frame_rate")), 4),
            "frames": _int(video.get("nb_frames")),
            "durationMs": _ms(video.get("duration")),
            "colorSpace": video.get("color_space"),
            "colorPrimaries": video.get("color_primaries"),
            "colorTransfer": video.get("color_transfer"),
            "colorRange": video.get("color_range"),
            "bitRate": _int(video.get("bit_rate")),
        }
    if audio:
        out["audio"] = {
            "codec": audio.get("codec_name"),
            "sampleRate": _int(audio.get("sample_rate")),
            "channels": _int(audio.get("channels")),
            "durationMs": _ms(audio.get("duration")),
            "bitRate": _int(audio.get("bit_rate")),
        }
    return out


def probe(path: Path, t: Optional[Tools] = None) -> Dict[str, Any]:
    t = t or tools()
    proc = _run([t.ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)], PROBE_TIMEOUT_S)
    if proc.returncode != 0:
        raise KbError(f"ffprobe could not read {path.name}: {proc.stderr.strip()[-300:]}", EXIT_PROBLEMS)
    try:
        facts = parse_streams(json.loads(proc.stdout))
    except ValueError:
        raise KbError(f"ffprobe gave no JSON for {path.name}", EXIT_ENV) from None
    video = facts.get("video")
    if not video:
        raise KbError(f"{path.name} has no video stream", EXIT_PROBLEMS)
    if video.get("frames") is None:
        video["frames"] = count_frames(path, t)
    return facts


def count_frames(path: Path, t: Tools) -> Optional[int]:
    """Packets of the first video stream (a demux, no decode) when the container declares no count."""
    proc = _run([t.ffprobe, "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets",
                 "-of", "csv=p=0", str(path)], PROBE_TIMEOUT_S)
    return _int(proc.stdout.strip().split(",")[0]) if proc.returncode == 0 else None


def parse_loudness(stderr: str) -> Optional[Dict[str, Optional[float]]]:
    """ebur128's closing summary: integrated loudness, loudness range and true peak."""
    at = stderr.rfind("Summary:")
    if at < 0:
        return None
    tail = stderr[at:]
    out: Dict[str, Optional[float]] = {}
    for key, rx in _SUMMARY_RE.items():
        m = rx.search(tail)
        out[key] = None if not m or m.group(1) == "-inf" else float(m.group(1))
    return out


def loudness(path: Path, t: Optional[Tools] = None) -> Optional[Dict[str, Optional[float]]]:
    """Integrated loudness (LUFS), LRA (LU) and true peak (dBTP) with `ebur128=peak=true`; None without audio."""
    t = t or tools()
    proc = _run([t.ffmpeg, "-hide_banner", "-nostdin", "-v", "info", "-i", str(path), "-vn", "-sn", "-dn",
                 "-af", "ebur128=peak=true", "-f", "null", "-"], LOUDNESS_TIMEOUT_S)
    if proc.returncode != 0:
        raise KbError(f"ffmpeg could not measure the loudness of {path.name}: {proc.stderr.strip()[-300:]}", EXIT_PROBLEMS)
    return parse_loudness(proc.stderr)
