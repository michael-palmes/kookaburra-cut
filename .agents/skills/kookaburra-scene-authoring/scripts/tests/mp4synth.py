"""Tiny MP4 and QuickTime movies built byte by byte (no ffmpeg, no committed media): just the boxes kblib/mp4box.py reads."""

from __future__ import annotations

import struct
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

Edit = Tuple[int, int, float]


def box(kind: bytes, payload: bytes, large: bool = False) -> bytes:
    if large:
        return struct.pack(">I4sQ", 1, kind, 16 + len(payload)) + payload
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def full(kind: bytes, version: int, payload: bytes, flags: int = 0) -> bytes:
    return box(kind, bytes([version]) + flags.to_bytes(3, "big") + payload)


def runs(values: Sequence[int]) -> List[Tuple[int, int]]:
    out: List[Tuple[int, int]] = []
    for v in values:
        if out and out[-1][1] == v:
            out[-1] = (out[-1][0] + 1, v)
        else:
            out.append((1, v))
    return out


def colr_nclx(primaries: int, transfer: int, matrix: int, full_range: bool = False) -> bytes:
    return box(b"colr", b"nclx" + struct.pack(">HHHB", primaries, transfer, matrix, 0x80 if full_range else 0))


def movie(
    deltas: Sequence[int],
    *,
    offsets: Optional[Sequence[int]] = None,
    edits: Optional[Sequence[Edit]] = None,
    timescale: int = 600,
    movie_scale: int = 1000,
    elst_version: int = 0,
    colr: Optional[bytes] = None,
    size: Tuple[int, int] = (320, 240),
    moov_first: bool = False,
    large_mdat: bool = False,
    fragmented: bool = False,
    codec: bytes = b"avc1",
) -> bytes:
    """A one-track video: decode deltas (stts), composition offsets (ctts), an edit list (segment duration in movie units,
    media time in media units or -1, rate)."""
    n = len(deltas)
    media_duration = sum(deltas)
    movie_duration = media_duration * movie_scale // timescale
    mvhd = full(b"mvhd", 0, struct.pack(">IIII", 0, 0, movie_scale, movie_duration) + b"\0" * 80)
    tkhd = full(b"tkhd", 0, struct.pack(">IIIII", 0, 0, 1, 0, movie_duration) + b"\0" * 60, flags=3)
    edts = b""
    if edits is not None:
        if elst_version == 1:
            body = b"".join(struct.pack(">QqhH", seg, media, int(rate), int(round((rate - int(rate)) * 65536))) for seg, media, rate in edits)
        else:
            body = b"".join(struct.pack(">IihH", seg, media, int(rate), int(round((rate - int(rate)) * 65536))) for seg, media, rate in edits)
        edts = box(b"edts", full(b"elst", elst_version, struct.pack(">I", len(edits)) + body))
    mdhd = full(b"mdhd", 0, struct.pack(">IIII", 0, 0, timescale, media_duration) + b"\x55\xc4\0\0")
    hdlr = full(b"hdlr", 0, b"\0\0\0\0" + b"vide" + b"\0" * 12 + b"VideoHandler\0")
    entry = b"\0" * 6 + b"\0\x01" + b"\0" * 16 + struct.pack(">HH", *size) + struct.pack(">IIIH", 0x480000, 0x480000, 0, 1) + b"\0" * 32 + struct.pack(">Hh", 24, -1)
    stsd = full(b"stsd", 0, struct.pack(">I", 1) + box(codec, entry + (colr or b"")))
    stts_rows = runs(deltas)
    stts = full(b"stts", 0, struct.pack(">I", len(stts_rows)) + b"".join(struct.pack(">II", c, d) for c, d in stts_rows))
    ctts = b""
    if offsets is not None:
        rows = runs(offsets)
        ctts = full(b"ctts", 1, struct.pack(">I", len(rows)) + b"".join(struct.pack(">Ii", c, o) for c, o in rows))
    stss = full(b"stss", 0, struct.pack(">II", 1, 1))
    stsz = full(b"stsz", 0, struct.pack(">II", 0, n) + struct.pack(f">{n}I", *([4] * n)))
    stco = full(b"stco", 0, struct.pack(">II", 1, 0))
    stbl = box(b"stbl", stsd + stts + ctts + stss + stsz + stco)
    minf = box(b"minf", stbl)
    mdia = box(b"mdia", mdhd + hdlr + minf)
    trak = box(b"trak", tkhd + edts + mdia)
    moov = box(b"moov", mvhd + (box(b"mvex", b"") if fragmented else b"") + trak)
    ftyp = box(b"ftyp", b"isom\0\0\x02\0isomiso2avc1mp41")
    mdat = box(b"mdat", b"\0" * (4 * n), large=large_mdat)
    tail = box(b"moof", b"") if fragmented else b""
    return ftyp + (moov + mdat if moov_first else mdat + moov) + tail


def write(path: Path, data: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


# A held recording trimmed by a stream copy so its edit opens inside a held frame (the class ffmpeg misdecodes):
# 30 frames at 60 fps, one frame held 1 s, 30 more; the edit starts 0.75 s in, inside the held frame.
HELD = [10] * 29 + [600] + [10] * 30
MID_SAMPLE = dict(deltas=HELD, edits=[(1500, 450, 1.0)])
ON_FRAME = dict(deltas=[10] * 120, edits=[(1500, 300, 1.0)])
CLEAN = dict(deltas=[10] * 60, edits=[(1000, 0, 1.0)])
