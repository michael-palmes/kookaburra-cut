"""A media file named on the command line is untrusted: reach checks where it is, then ffprobe reads it under a demuxer whitelist with its size and length capped. Anything odd fails closed, before ffmpeg or the app decode a byte of it."""

from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import reach
from .util import EXIT_ENV, EXIT_PROBLEMS, KbError
from .video.passes import Tools, find_tools

MAX_BYTES = 16 * 1024 ** 3
MAX_DURATION_MS = 30 * 60 * 1000
MAX_EDGE = 8192
PROBE_TIMEOUT_S = 60

# ffmpeg's demuxer names. Never a playlist or concat demuxer, which read other files on the disk.
DEMUXERS = ("mov", "matroska", "avi", "mpegts", "mp3", "wav", "aiff", "flac", "ogg", "aac", "caf")
VIDEO_CODECS = ("h264", "hevc", "prores", "av1", "vp8", "vp9", "mpeg4", "mpeg2video", "mjpeg", "dnxhd")
AUDIO_CODECS = ("aac", "alac", "mp3", "flac", "opus", "vorbis", "ac3", "eac3", "pcm_s16le", "pcm_s16be", "pcm_s24le",
                "pcm_s24be", "pcm_s32le", "pcm_s32be", "pcm_f32le", "pcm_f32be", "pcm_f64le")

# Every ffmpeg or ffprobe that opens an untrusted file goes through these, before its -i.
INPUT_ARGS = ["-protocol_whitelist", "file,pipe", "-format_whitelist", ",".join(DEMUXERS)]


def invalid(message: str, hint: Optional[str] = None) -> KbError:
    return KbError(message, EXIT_PROBLEMS, kind="invalid", hint=hint)


def locate(project: Any, raw: str, what: str = "--file") -> Path:
    """The path reach allows: credentials refused, outside the workspace announced, and it must be a plain file."""
    path = reach.guard_read(project, raw, what)
    if not path.is_file():
        raise KbError(f"{what} {raw} is not a file", EXIT_ENV, kind="usage", hint="give the path of an audio or video file")
    return path


def _finite(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def facts(path: Path, tools: Optional[Tools] = None, *, need_video: bool = False, need_audio: bool = False) -> Dict[str, Any]:
    """{ path, bytes, durationMs, container, video?: {codec, width, height, fps}, audio?: {codec} }, or a refusal."""
    tools = tools or find_tools()
    try:
        size = path.stat().st_size
    except OSError as e:
        raise invalid(f"{path.name} cannot be read: {e.strerror}") from None
    if size == 0:
        raise invalid(f"{path.name} is empty")
    if size > MAX_BYTES:
        raise invalid(f"{path.name} is {size / 1024 ** 3:.1f} GB, over the {MAX_BYTES // 1024 ** 3} GB limit for a file kb reads",
                      hint="export a smaller copy and name that")
    argv: List[str] = [tools.ffprobe, "-v", "error", *INPUT_ARGS, "-print_format", "json", "-show_format", "-show_streams", str(path)]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, errors="replace", timeout=PROBE_TIMEOUT_S, stdin=subprocess.DEVNULL)
    except OSError as e:
        raise KbError(f"could not run ffprobe: {e.strerror}", EXIT_ENV, kind="env") from None
    except subprocess.TimeoutExpired:
        raise invalid(f"{path.name} took longer than {PROBE_TIMEOUT_S} s to probe, so kb will not read it") from None
    if proc.returncode != 0:
        raise invalid(f"{path.name} is not an audio or video file kb reads ({proc.stderr.strip()[-200:] or 'ffprobe refused it'})",
                      hint="mp4, mov, m4v, m4a, mkv, webm, avi, ts, mp3, wav, aiff, flac, ogg and aac are read")
    try:
        data = json.loads(proc.stdout)
    except ValueError:
        raise invalid(f"ffprobe gave no JSON for {path.name}") from None
    fmt = data.get("format") if isinstance(data, dict) and isinstance(data.get("format"), dict) else {}
    streams = [s for s in data.get("streams") or [] if isinstance(s, dict)] if isinstance(data, dict) else []
    seconds = _finite(fmt.get("duration"))
    if seconds is None or seconds <= 0:
        raise invalid(f"{path.name} does not say how long it is, so kb will not read it")
    if seconds * 1000 > MAX_DURATION_MS:
        raise invalid(f"{path.name} runs {seconds / 60:.1f} minutes, over the {MAX_DURATION_MS // 60000} minute limit for a file kb reads",
                      hint="trim it to the part you want to study")
    out: Dict[str, Any] = {"path": str(path), "bytes": size, "durationMs": int(round(seconds * 1000)), "container": fmt.get("format_name"),
                           "video": None, "audio": None}
    video = next((s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")), None)
    if video:
        codec = video.get("codec_name")
        if codec not in VIDEO_CODECS:
            raise invalid(f"{path.name} holds {codec or 'unknown'} video, which kb does not read", hint=f"it reads {', '.join(VIDEO_CODECS)}")
        width, height = _finite(video.get("width")), _finite(video.get("height"))
        if not width or not height or width <= 0 or height <= 0 or width > MAX_EDGE or height > MAX_EDGE:
            raise invalid(f"{path.name} says its picture is {video.get('width')}x{video.get('height')}; kb reads up to {MAX_EDGE} px a side")
        out["video"] = {"codec": codec, "width": int(width), "height": int(height)}
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if audio:
        codec = audio.get("codec_name")
        if codec not in AUDIO_CODECS:
            raise invalid(f"{path.name} holds {codec or 'unknown'} audio, which kb does not read", hint=f"it reads {', '.join(AUDIO_CODECS)}")
        out["audio"] = {"codec": codec}
    if need_video and not video:
        raise invalid(f"{path.name} has no video stream", hint="./kb song analyse --file reads audio on its own")
    if need_audio and not audio:
        raise invalid(f"{path.name} has no audio stream")
    return out
