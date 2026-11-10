"""A stdlib reader for MP4 and QuickTime boxes: the sample tables and edit list of a video, without decoding it.

Enough of ISO/IEC 14496-12 to judge a recording before it reaches ffmpeg: mvhd, tkhd, mdhd, hdlr, elst, stts, ctts,
stss, stsz and the sample entry's colr box. `analyse` turns them into the facts `kb assets probe` and `kb check` use:
where the edit list starts (on a frame, inside one, or past the composition delay), whether the frame rate varies,
and the timeline a frame-exact reader (AVFoundation) presents, which ffmpeg's own pass can be compared against.
"""

from __future__ import annotations

import struct
from pathlib import Path
from typing import Any, BinaryIO, Dict, Iterator, List, Optional, Tuple

CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts"}
MAX_MOOV_BYTES = 64 * 1024 * 1024
MAX_SAMPLES = 1 << 24  # mp4box.rs's cap: far past any real recording (77 hours at 60 fps)
VIDEO_HANDLERS = (b"vide",)
VFR_TOLERANCE_FPS = 0.5
SPAN_TOLERANCE_MS = 2.0

# ISO/IEC 23091-2 code points, named as ffprobe names them (what the app's colour tags compare against).
PRIMARIES = {1: "bt709", 4: "bt470m", 5: "bt470bg", 6: "smpte170m", 7: "smpte240m", 8: "film", 9: "bt2020", 10: "smpte428", 11: "smpte431", 12: "smpte432", 22: "jedec-p22"}
TRANSFERS = {1: "bt709", 4: "gamma22", 5: "gamma28", 6: "smpte170m", 7: "smpte240m", 8: "linear", 11: "iec61966-2-4", 13: "iec61966-2-1", 14: "bt2020-10", 15: "bt2020-12", 16: "smpte2084", 17: "smpte428", 18: "arib-std-b67"}
MATRICES = {0: "gbr", 1: "bt709", 4: "fcc", 5: "bt470bg", 6: "smpte170m", 7: "smpte240m", 8: "ycgco", 9: "bt2020nc", 10: "bt2020c"}


class BoxError(Exception):
    """The file is not a readable MP4 or QuickTime movie."""


def tenth(ms: float) -> float:
    """ms to a tenth, as the app's timing records round them."""
    return round(ms * 10) / 10


# ── boxes ─────────────────────────────────────────────────────────────────────


def _header(f: BinaryIO, end: int) -> Optional[Tuple[bytes, int, int]]:
    """(type, payload start, box end) of the box at the file position, or None at the end."""
    start = f.tell()
    if start + 8 > end:
        return None
    head = f.read(8)
    if len(head) < 8:
        return None
    size, kind = struct.unpack(">I4s", head)
    payload = start + 8
    if size == 1:
        big = f.read(8)
        if len(big) < 8:
            raise BoxError("a box header ends early")
        size = struct.unpack(">Q", big)[0]
        payload += 8
    elif size == 0:
        size = end - start
    if size < payload - start or start + size > end:
        raise BoxError(f"box {kind!r} at byte {start} overruns its parent")
    if kind == b"uuid":
        payload += 16
    return kind, payload, start + size


def top_level(f: BinaryIO, length: int) -> Iterator[Tuple[bytes, int, int]]:
    f.seek(0)
    while True:
        found = _header(f, length)
        if found is None:
            return
        yield found
        f.seek(found[2])


def children(data: bytes, start: int, end: int) -> Iterator[Tuple[bytes, int, int]]:
    """(type, payload start, end) of each box inside data[start:end]."""
    pos = start
    while pos + 8 <= end:
        size, kind = struct.unpack_from(">I4s", data, pos)
        payload = pos + 8
        if size == 1:
            if pos + 16 > end:
                raise BoxError("a box header ends early")
            size = struct.unpack_from(">Q", data, pos + 8)[0]
            payload += 8
        elif size == 0:
            size = end - pos
        if size < payload - pos or pos + size > end:
            raise BoxError(f"box {kind!r} overruns its parent")
        if kind == b"uuid":
            payload += 16
        yield kind, payload, pos + size
        pos += size


def find(data: bytes, start: int, end: int, path: List[bytes]) -> Optional[Tuple[int, int]]:
    """The first box along path (each a child of the last), as (payload start, end)."""
    span = (start, end)
    for kind in path:
        for k, s, e in children(data, span[0], span[1]):
            if k == kind:
                span = (s, e)
                break
        else:
            return None
    return span


def full_box(data: bytes, start: int) -> Tuple[int, int]:
    """(version, payload start after the version and flags)."""
    if start + 4 > len(data):
        raise BoxError("a full box ends early")
    return data[start], start + 4


# ── one track ────────────────────────────────────────────────────────────────


def _mdhd(data: bytes, start: int) -> Tuple[int, int]:
    version, p = full_box(data, start)
    if version == 1:
        timescale, duration = struct.unpack_from(">IQ", data, p + 16)
    else:
        timescale, duration = struct.unpack_from(">II", data, p + 8)
    return timescale, duration


def _mvhd(data: bytes, start: int) -> Tuple[int, int]:
    return _mdhd(data, start)


def _elst(data: bytes, start: int, end: int) -> List[Tuple[int, int, float]]:
    """(segment duration in movie units, media time in media units or -1, rate) per entry."""
    version, p = full_box(data, start)
    count = struct.unpack_from(">I", data, p)[0]
    p += 4
    out = []
    width = 20 if version == 1 else 12
    for _ in range(count):
        if p + width > end:
            raise BoxError("elst ends early")
        if version == 1:
            seg, media, whole, frac = struct.unpack_from(">QqhH", data, p)
        else:
            seg, media, whole, frac = struct.unpack_from(">IihH", data, p)
        out.append((seg, media, whole + frac / 65536.0))
        p += width
    return out


def _pairs(data: bytes, start: int, end: int, signed: bool) -> List[Tuple[int, int]]:
    version, p = full_box(data, start)
    count = struct.unpack_from(">I", data, p)[0]
    p += 4
    if p + 8 * count > end:
        raise BoxError("a sample table ends early")
    fmt = ">I" + ("i" if signed or version == 1 else "I")
    rows = []
    for n, value in struct.iter_unpack(fmt, data[p:p + 8 * count]):
        # A version 0 ctts may still carry a negative offset; readers take it as signed, so do we.
        if not signed and version == 0 and value >= 1 << 31:
            value -= 1 << 32
        rows.append((n, value))
    return rows


def _stsz_count(data: bytes, start: int) -> int:
    _version, p = full_box(data, start)
    return struct.unpack_from(">II", data, p)[1]


def _stss(data: bytes, start: int, end: int) -> List[int]:
    _version, p = full_box(data, start)
    count = struct.unpack_from(">I", data, p)[0]
    p += 4
    if p + 4 * count > end:
        raise BoxError("stss ends early")
    return [n for (n,) in struct.iter_unpack(">I", data[p:p + 4 * count])]


def _sample_entry(data: bytes, start: int, end: int) -> Dict[str, Any]:
    """The first visual sample entry: its four-character code, size and colr tags."""
    _version, p = full_box(data, start)
    p += 4
    out: Dict[str, Any] = {"codec": None, "width": None, "height": None, "colour": None}
    for kind, s, e in children(data, p, end):
        out["codec"] = kind.decode("latin-1")
        if s + 78 > e:
            return out
        out["width"], out["height"] = struct.unpack_from(">HH", data, s + 24)
        for sub, cs, ce in children(data, s + 78, e):
            if sub != b"colr" or cs + 4 > ce:
                continue
            ctype = data[cs:cs + 4]
            if ctype in (b"nclx", b"nclc") and cs + 10 <= ce:
                prim, trc, mat = struct.unpack_from(">HHH", data, cs + 4)
                full = bool(data[cs + 10] & 0x80) if ctype == b"nclx" and cs + 11 <= ce else None
                out["colour"] = {
                    "primaries": PRIMARIES.get(prim),
                    "transfer": TRANSFERS.get(trc),
                    "matrix": MATRICES.get(mat),
                    "range": None if full is None else ("pc" if full else "tv"),
                }
            elif out["colour"] is None:
                out["colour"] = {"primaries": None, "transfer": None, "matrix": None, "range": None, "icc": True}
        return out
    return out


def _track(data: bytes, start: int, end: int) -> Dict[str, Any]:
    t: Dict[str, Any] = {"handler": None, "timescale": 0, "duration": 0, "edits": None, "stts": [], "ctts": [], "stss": None, "samples": 0, "entry": {}}
    mdia = find(data, start, end, [b"mdia"])
    if mdia is None:
        return t
    hdlr = find(data, mdia[0], mdia[1], [b"hdlr"])
    if hdlr is not None and hdlr[0] + 12 <= hdlr[1]:
        t["handler"] = data[hdlr[0] + 8:hdlr[0] + 12]
    mdhd = find(data, mdia[0], mdia[1], [b"mdhd"])
    if mdhd is not None:
        t["timescale"], t["duration"] = _mdhd(data, mdhd[0])
    elst = find(data, start, end, [b"edts", b"elst"])
    if elst is not None:
        t["edits"] = _elst(data, elst[0], elst[1])
    stbl = find(data, mdia[0], mdia[1], [b"minf", b"stbl"])
    if stbl is None:
        return t
    for kind, s, e in children(data, stbl[0], stbl[1]):
        if kind == b"stts":
            t["stts"] = _pairs(data, s, e, signed=False)
        elif kind == b"ctts":
            t["ctts"] = _pairs(data, s, e, signed=False)
        elif kind == b"stss":
            t["stss"] = _stss(data, s, e)
        elif kind == b"stsz":
            t["samples"] = _stsz_count(data, s)
        elif kind == b"stsd":
            t["entry"] = _sample_entry(data, s, e)
    return t


def read_movie(path: Path) -> Dict[str, Any]:
    """{ brand, movieTimescale, fragmented, tracks } from the file's moov box; raises BoxError."""
    try:
        f = open(path, "rb")
    except OSError as e:
        raise BoxError(f"cannot read {path.name}: {e.strerror}") from None
    with f:
        f.seek(0, 2)
        length = f.tell()
        moov: Optional[Tuple[int, int]] = None
        brand = None
        fragmented = False
        for kind, start, end in top_level(f, length):
            if kind == b"ftyp" and brand is None:
                f.seek(start)
                brand = f.read(4).decode("latin-1")
            elif kind == b"moov" and moov is None:
                moov = (start, end)
            elif kind == b"moof":
                fragmented = True
        if moov is None:
            raise BoxError(f"{path.name} has no moov box (not an MP4 or QuickTime movie)")
        if moov[1] - moov[0] > MAX_MOOV_BYTES:
            raise BoxError(f"{path.name} has a moov box over {MAX_MOOV_BYTES >> 20} MB")
        f.seek(moov[0])
        data = f.read(moov[1] - moov[0])
    movie_scale = 0
    tracks: List[Dict[str, Any]] = []
    for kind, s, e in children(data, 0, len(data)):
        if kind == b"mvhd":
            movie_scale = _mvhd(data, s)[0]
        elif kind == b"mvex":
            fragmented = True
        elif kind == b"trak":
            tracks.append(_track(data, s, e))
    return {"brand": brand, "movieTimescale": movie_scale, "fragmented": fragmented, "tracks": tracks}


# ── the video track's timeline ────────────────────────────────────────────────


def _runs(track: Dict[str, Any]) -> Iterator[Tuple[int, int, int]]:
    """(count, first composition time, step) per stretch sharing a delta and an offset, never expanded per sample."""
    offsets = iter(track["ctts"])
    left = offset = dts = 0
    for count, delta in track["stts"]:
        while count:
            if not left:
                left, offset = next(offsets, (count, 0))
                continue
            take = min(count, left)
            yield take, dts + offset, delta
            dts += take * delta
            count -= take
            left -= take


def _below(count: int, start: int, step: int, bound: int) -> int:
    """How many of the count terms start, start + step, ... fall below bound."""
    if step == 0:
        return count if start < bound else 0
    if step > 0:
        return min(max(-((start - bound) // step), 0), count)
    return count - min(max((start - bound) // -step + 1, 0), count)


def _holds(count: int, start: int, step: int, value: int) -> bool:
    if step == 0:
        return value == start
    k, rest = divmod(value - start, step)
    return rest == 0 and 0 <= k < count


def _span(track: Dict[str, Any]) -> Tuple[Optional[int], Optional[int], int, bool]:
    """(earliest composition time, latest, the latest's own decode delta, whether decode order ever steps back); None times without samples."""
    first = last = prev = None
    tail, back = 0, False
    for count, start, step in _runs(track):
        end = start + (count - 1) * step
        back = back or end < start or (prev is not None and start < prev)
        prev = end
        first = min(start, end) if first is None else min(first, start, end)
        if last is None or max(start, end) >= last:
            last, tail = max(start, end), step
    return first, last, tail, back


def _shown(track: Dict[str, Any], n: int, span: Tuple[int, int, int, bool], start: int, end: int) -> Tuple[int, Optional[int], Optional[int]]:
    """(frames, first time, last time) shown in [start, end): sorted frame i shows when t[i] < end and t[i + 1] > start."""
    first, last, tail, _back = span
    before = upto = 0
    latest = None
    for count, s, step in _runs(track):
        k = _below(count, s, step, end)
        before += k
        upto += _below(count, s, step, start + 1)
        if k:
            top = s + ((k - 1) if step > 0 else (count - k)) * step
            latest = top if latest is None else max(latest, top)
    inner = max(min(before, n - 1) - max(upto - 1, 0), 0)
    final = before == n and last + tail > start
    if not inner and not final:
        return 0, None, None
    head = first if inner else last
    foot = last if final else latest
    return inner + int(final), max(head - start, 0), max(foot - start, 0)


def _ms(units: float, scale: int) -> float:
    return units * 1000.0 / scale if scale else 0.0


def analyse(movie: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The first video track's facts, or None without one.

    editStart: "none" (no edit list), "first-frame" (the edit opens on the first frame shown, the B-frame delay's
    trivial edit), "frame" (it skips whole frames), "mid-sample" (it opens inside a frame: ffmpeg drops that frame and
    shows the next at 0 s, the misdecode class), "gap" (it opens before the first frame) or "complex" (several
    segments, an empty edit or a rate change). `expected` is the single-segment timeline a frame-exact reader shows.
    """
    video = next((t for t in movie["tracks"] if t["handler"] in VIDEO_HANDLERS), None)
    if video is None:
        return None
    scale = video["timescale"]
    n = sum(count for count, _ in video["stts"])
    if n > MAX_SAMPLES:
        raise BoxError(f"the video track claims {n} samples, over {MAX_SAMPLES}")
    span = _span(video)
    first, last, tail, back = span
    out: Dict[str, Any] = {
        "codec": video["entry"].get("codec"),
        "width": video["entry"].get("width"),
        "height": video["entry"].get("height"),
        "timescale": scale,
        "samples": n,
        "durationMs": tenth(_ms(video["duration"], scale)),
        "fragmented": bool(movie["fragmented"]),
        "reorders": bool(video["ctts"]) and back,
        "keyframes": len(video["stss"]) if video["stss"] is not None else None,
        "colour": video["entry"].get("colour"),
        "vfr": False,
        "editList": [],
        "editStart": "none",
        "edited": False,
        "expected": None,
    }
    if n == 0 or scale <= 0:
        return out
    seconds = video["duration"] / scale if video["duration"] else (last - first + tail) / scale
    deltas = [d for _c, d in video["stts"] if d > 0]
    if seconds > 0 and deltas:
        nominal = n / seconds
        finest = scale / min(deltas)
        out["vfr"] = abs(nominal - finest) > VFR_TOLERANCE_FPS
    movie_scale = movie["movieTimescale"] or scale
    edits = [e for e in (video["edits"] or []) if not (e[1] == -1 and e[0] == 0)]
    out["editList"] = [
        {"mediaTimeMs": None if media < 0 else tenth(_ms(media, scale)), "durationMs": tenth(_ms(seg, movie_scale)), "rate": round(rate, 4)}
        for seg, media, rate in edits
    ]
    window_start, window_end = first, last + tail
    if not edits:
        out["editStart"] = "none"
    elif len(edits) > 1 or edits[0][1] < 0 or abs(edits[0][2] - 1.0) > 1e-3:
        out["editStart"] = "complex"
        out["edited"] = True
    else:
        seg, media, _rate = edits[0]
        window_start = media
        if seg > 0:
            window_end = min(window_end, media + seg * scale // movie_scale if movie_scale else window_end)
        if media == first:
            out["editStart"] = "first-frame"
        elif media < first:
            out["editStart"] = "gap"
            out["edited"] = True
        else:
            on_frame = any(_holds(*run, media) for run in _runs(video))
            out["editStart"] = "frame" if on_frame else "mid-sample"
            out["edited"] = True
    if out["editStart"] != "complex":
        if out["editStart"] == "none":
            frames, head, foot = n, 0, last - first
        else:
            frames, head, foot = _shown(video, n, span, window_start, window_end)
        out["expected"] = {
            "frames": frames,
            "firstPtsMs": None if head is None else tenth(_ms(head, scale)),
            "lastPtsMs": None if foot is None else tenth(_ms(foot, scale)),
        }
    return out


def probe(path: Path) -> Optional[Dict[str, Any]]:
    """analyse(read_movie(path)), or None when the file is not a movie this reader can parse."""
    try:
        return analyse(read_movie(path))
    except (BoxError, struct.error, ValueError, OverflowError):
        return None


def span_reasons(expected: Dict[str, Any], decoded: Dict[str, Any]) -> List[str]:
    """conform.rs decoder_reasons: a different frame count or a span more than 2 ms apart means another picture."""
    reasons = []
    if expected.get("frames") != decoded.get("frames"):
        reasons.append("count-mismatch")
    span = lambda t: (t["lastPtsMs"] - t["firstPtsMs"]) if t.get("firstPtsMs") is not None and t.get("lastPtsMs") is not None else None  # noqa: E731
    a, b = span(expected), span(decoded)
    if a is not None and b is not None and abs(a - b) > SPAN_TOLERANCE_MS:
        reasons.append("span-mismatch")
    return reasons
