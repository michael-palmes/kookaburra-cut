"""What ffmpeg and ffprobe may open: a local file and the demuxers kb reads, whatever the file's name says. Every lane that opens a file goes through these, before its -i."""

from __future__ import annotations

from pathlib import Path
from typing import List

# ffmpeg's demuxer names. Never a playlist or concat demuxer, which read other files on the disk.
DEMUXERS = ("mov", "matroska", "avi", "mpegts", "mp3", "wav", "aiff", "flac", "ogg", "aac", "caf")
# ffmpeg opens most JPEGs as image2, and only an image extension reaches it.
STILL_DEMUXERS = ("png_pipe", "jpeg_pipe", "webp_pipe", "apng", "gif", "image2")
STILL_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".gif")

INPUT_ARGS = ["-protocol_whitelist", "file,pipe", "-format_whitelist", ",".join(DEMUXERS)]
STILL_INPUT_ARGS = ["-protocol_whitelist", "file,pipe", "-format_whitelist", ",".join(STILL_DEMUXERS)]


def input_args(path: Path) -> List[str]:
    """The whitelist for a file by its name; ffmpeg reads it as an option of the next -i alone."""
    return STILL_INPUT_ARGS if Path(path).suffix.lower() in STILL_SUFFIXES else INPUT_ARGS
