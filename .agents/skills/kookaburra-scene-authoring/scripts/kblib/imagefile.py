"""Still images on the way in, for kb assets and brand.py. An imported file is untrusted: its header is read and capped
before anything decodes it, and what it really is decides what happens to it, never its extension.

The stage reads raw pixel values (`decode_png`, and `createImageBitmap` with `colorSpaceConversion: "none"`), so a colour
profile or an EXIF turn never reaches a frame: a P3 screenshot draws washed out. Conforming bakes them into plain sRGB
pixels through ImageIO (`sips`), the decoder WebKit itself uses, and a blank result is refused here, not found in a frame.
"""

from __future__ import annotations

import os
import struct
import subprocess
import tempfile
import zlib
from pathlib import Path
from typing import Any, BinaryIO, Dict, List, Optional, Tuple

# png_decode.rs MAX_INPUT_BYTES; past MAX_EDGE no GPU the app runs on holds the texture.
MAX_BYTES = 256 * 1024 ** 2
MAX_EDGE = 16384
MAX_PIXELS = 100_000_000
LARGE_EDGE = 4096
SIPS = "/usr/bin/sips"
SRGB_PROFILE = "/System/Library/ColorSync/Profiles/sRGB Profile.icc"
TOOL_TIMEOUT_S = 60
PROBE_EDGE = 64
BLANK_TOLERANCE = 3
MAX_ICC_BYTES = 16 * 1024 ** 2
MAX_CHUNKS = 8192
JPEG_QUALITY = "92"
READABLE = ("png", "jpeg", "webp", "gif")
EXT_OF = {"png": "png", "jpeg": "jpg", "webp": "webp", "gif": "gif"}
SAME_FORMAT = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png", "webp": "webp", "gif": "gif"}
FOREIGN = {"tiff": "TIFF", "bmp": "BMP", "heic": "HEIC", "avif": "AVIF", "pdf": "PDF", "html": "HTML", "jxl": "JPEG XL"}
# EXIF orientation to the sips turn and flip that shows the picture upright.
UPRIGHT = {2: (0, "horizontal"), 3: (180, None), 4: (0, "vertical"), 5: (270, "horizontal"), 6: (90, None), 7: (90, "horizontal"), 8: (270, None)}


class Refused(Exception):
    """A file that does not come in, and why. `code` is stable: unreadable, too-large, blank, no-decoder."""

    def __init__(self, code: str, message: str, hint: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint


def sniff(head: bytes) -> Optional[str]:
    """What the first bytes say the file is, whatever its name says."""
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if head[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    if head[:2] == b"BM":
        return "bmp"
    if head[:4] == b"%PDF":
        return "pdf"
    if head[:2] == b"\xff\x0a" or head[4:12] == b"JXL \r\n\x87\n":
        return "jxl"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"avif", b"avis"):
            return "avif"
        if brand in (b"heic", b"heix", b"hevc", b"mif1", b"msf1"):
            return "heic"
    text = head[:4096].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if b"<svg" in text and text[:5] in (b"<svg ", b"<svg>", b"<svg\n", b"<?xml", b"<!doc", b"<!--\n", b"<!-- "):
        return "svg"
    if text.startswith((b"<!doctype html", b"<html")):
        return "html"
    return None


def sniff_file(path: Path) -> Optional[str]:
    try:
        with open(path, "rb") as f:
            return sniff(f.read(4096))
    except OSError:
        return None


# ── what the header says ──────────────────────────────────────────────────────


def _unreadable(path: Path, why: str) -> Refused:
    return Refused("unreadable", f"{path.name} is not a readable image: {why}", "export it again as png, jpg or webp")


def icc_name(profile: bytes) -> Optional[str]:
    """The ICC profile's description (v2 `desc`, v4 `mluc`); None when it has none."""
    try:
        count = struct.unpack(">I", profile[128:132])[0]
        for i in range(min(count, 256)):
            tag, offset, size = struct.unpack(">4sII", profile[132 + 12 * i:144 + 12 * i])
            if tag != b"desc":
                continue
            body = profile[offset:offset + size]
            if body[:4] == b"desc":
                length = struct.unpack(">I", body[8:12])[0]
                return body[12:12 + length].split(b"\x00")[0].decode("latin-1").strip() or None
            if body[:4] == b"mluc":
                records = struct.unpack(">I", body[8:12])[0]
                if records:
                    length, start = struct.unpack(">II", body[20:28])
                    return body[start:start + length].decode("utf-16-be", "replace").strip("\x00 ") or None
    except struct.error:
        return None
    return None


def _exif_orientation(block: bytes) -> Optional[int]:
    """Tag 0x0112 of IFD0 in a TIFF-format EXIF block."""
    try:
        order = {b"II": "<", b"MM": ">"}.get(block[:2])
        if order is None:
            return None
        offset = struct.unpack(order + "I", block[4:8])[0]
        count = struct.unpack(order + "H", block[offset:offset + 2])[0]
        for i in range(min(count, 512)):
            entry = block[offset + 2 + 12 * i:offset + 14 + 12 * i]
            tag, kind = struct.unpack(order + "HH", entry[:4])
            if tag == 0x0112 and kind == 3:
                value = struct.unpack(order + "H", entry[8:10])[0]
                return value if 1 <= value <= 8 else None
    except struct.error:
        return None
    return None


def _inflate(data: bytes, limit: int) -> Optional[bytes]:
    try:
        d = zlib.decompressobj()
        out = d.decompress(data, limit)
        return None if d.unconsumed_tail else out
    except zlib.error:
        return None


def _png_facts(f: BinaryIO, path: Path) -> Dict[str, Any]:
    f.seek(8)
    out: Dict[str, Any] = {"format": "png"}
    for _ in range(MAX_CHUNKS):
        head = f.read(8)
        if len(head) < 8:
            raise _unreadable(path, "it ends before any pixels")
        length, kind = struct.unpack(">I4s", head)
        if kind == b"IHDR":
            body = f.read(length)
            if length < 13:
                raise _unreadable(path, "its header is cut short")
            out["width"], out["height"], out["bits"], colour, _, _, interlace = struct.unpack(">IIBBBBB", body[:13])
            if colour not in (0, 2, 3, 4, 6) or out["bits"] not in (1, 2, 4, 8, 16):
                raise _unreadable(path, "its header names a pixel format PNG doesn't have")
            out.update(colourType=colour, alpha=colour in (4, 6), space="gray" if colour in (0, 4) else "rgb", interlaced=interlace != 0)
            f.seek(4, os.SEEK_CUR)
            continue
        if "width" not in out:
            raise _unreadable(path, "its header is missing")
        if kind == b"IDAT":
            return out
        if kind in (b"iCCP", b"eXIf") and length <= MAX_ICC_BYTES:
            body = f.read(length)
            if kind == b"iCCP":
                _, _, packed = body.partition(b"\x00")
                profile = _inflate(packed[1:], MAX_ICC_BYTES)
                out["profile"] = (icc_name(profile) if profile else None) or "unnamed profile"
            else:
                out["orientation"] = _exif_orientation(body)
            f.seek(4, os.SEEK_CUR)
            continue
        if kind == b"sRGB":
            out.setdefault("profile", "sRGB")
        elif kind == b"cICP":
            body = f.read(min(length, 4))
            out.setdefault("profile", "sRGB" if body[:2] in (b"\x01\x0d", b"\x01\x01") else "cICP")
            f.seek(length - len(body) + 4, os.SEEK_CUR)
            continue
        elif kind == b"tRNS":
            out["alpha"] = True
        elif kind == b"acTL":
            out["animated"] = True
        f.seek(length + 4, os.SEEK_CUR)
    raise _unreadable(path, "it has too many chunks")


def _jpeg_facts(f: BinaryIO, path: Path) -> Dict[str, Any]:
    f.seek(2)
    out: Dict[str, Any] = {"format": "jpeg", "alpha": False}
    icc: Dict[int, bytes] = {}
    for _ in range(MAX_CHUNKS):
        byte = f.read(1)
        if not byte:
            break
        if byte != b"\xff":
            continue
        marker = f.read(1)
        while marker == b"\xff":
            marker = f.read(1)
        if not marker:
            break
        code = marker[0]
        if code == 0 or 0xD0 <= code <= 0xD8:
            continue
        if code in (0xD9, 0xDA):
            break
        raw = f.read(2)
        if len(raw) < 2:
            break
        length = struct.unpack(">H", raw)[0]
        if length < 2:
            raise _unreadable(path, "a segment has a bad length")
        if code in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            body = f.read(length - 2)
            if len(body) < 6:
                raise _unreadable(path, "its frame header is cut short")
            out["bits"], out["height"], out["width"], parts = struct.unpack(">BHHB", body[:6])
            out["space"] = {1: "gray", 3: "rgb", 4: "cmyk"}.get(parts, "rgb")
        elif code == 0xE1:
            body = f.read(length - 2)
            if body[:6] == b"Exif\x00\x00":
                out["orientation"] = out.get("orientation") or _exif_orientation(body[6:])
        elif code == 0xE2:
            body = f.read(length - 2)
            if body[:12] == b"ICC_PROFILE\x00" and len(body) > 14 and sum(len(v) for v in icc.values()) < MAX_ICC_BYTES:
                icc[body[12]] = body[14:]
        else:
            f.seek(length - 2, os.SEEK_CUR)
    if "width" not in out:
        raise _unreadable(path, "it has no frame header")
    if icc:
        out["profile"] = icc_name(b"".join(icc[k] for k in sorted(icc))) or "unnamed profile"
    return out


def _webp_facts(f: BinaryIO, path: Path) -> Dict[str, Any]:
    f.seek(12)
    out: Dict[str, Any] = {"format": "webp", "bits": 8, "space": "rgb", "alpha": False}
    extended = False
    for _ in range(MAX_CHUNKS):
        head = f.read(8)
        if len(head) < 8:
            break
        kind, length = struct.unpack("<4sI", head)
        step = length + (length & 1)
        if kind == b"VP8X":
            body = f.read(10)
            if len(body) < 10:
                raise _unreadable(path, "its header is cut short")
            flags = body[0]
            extended = True
            out.update(alpha=bool(flags & 0x10), animated=bool(flags & 0x02))
            out["width"] = 1 + int.from_bytes(body[4:7], "little")
            out["height"] = 1 + int.from_bytes(body[7:10], "little")
            f.seek(step - 10, os.SEEK_CUR)
        elif kind == b"VP8 ":
            body = f.read(10)
            if len(body) < 10 or body[3:6] != b"\x9d\x01\x2a":
                raise _unreadable(path, "its frame header is cut short")
            out.setdefault("width", struct.unpack("<H", body[6:8])[0] & 0x3FFF)
            out.setdefault("height", struct.unpack("<H", body[8:10])[0] & 0x3FFF)
            if not extended:
                return out
            f.seek(max(0, step - 10), os.SEEK_CUR)
        elif kind == b"VP8L":
            body = f.read(5)
            if len(body) < 5 or body[0] != 0x2F:
                raise _unreadable(path, "its frame header is cut short")
            bits = int.from_bytes(body[1:5], "little")
            out.setdefault("width", (bits & 0x3FFF) + 1)
            out.setdefault("height", ((bits >> 14) & 0x3FFF) + 1)
            out["alpha"] = out["alpha"] or bool((bits >> 28) & 1)
            if not extended:
                return out
            f.seek(max(0, step - 5), os.SEEK_CUR)
        elif kind == b"ICCP" and length <= MAX_ICC_BYTES:
            out["profile"] = icc_name(f.read(length)) or "unnamed profile"
            f.seek(length & 1, os.SEEK_CUR)
        elif kind == b"EXIF" and length <= MAX_ICC_BYTES:
            body = f.read(length)
            out["orientation"] = _exif_orientation(body[6:] if body[:6] == b"Exif\x00\x00" else body)
            f.seek(length & 1, os.SEEK_CUR)
        elif kind == b"ANMF" or "width" in out and kind == b"ANIM":
            return out
        else:
            f.seek(step, os.SEEK_CUR)
    if "width" not in out:
        raise _unreadable(path, "it has no frame header")
    return out


def _gif_facts(f: BinaryIO, path: Path) -> Dict[str, Any]:
    f.seek(6)
    screen = f.read(4)
    if len(screen) < 4:
        raise _unreadable(path, "its header is cut short")
    width, height = struct.unpack("<HH", screen)
    return {"format": "gif", "bits": 8, "space": "rgb", "alpha": True, "width": width, "height": height, "animated": f.read(1 << 20).count(b"\x21\xf9\x04") > 1}


def facts(path: Path) -> Dict[str, Any]:
    """{ format, width, height, bits, alpha, space, profile?, orientation?, animated?, bytes } from the header alone; a file
    that isn't an image the app reads, or is too big to decode safely, is refused before anything decodes it."""
    path = Path(path)
    try:
        size = path.stat().st_size
        f = open(path, "rb")
    except OSError as e:
        raise _unreadable(path, e.strerror or "it can't be opened") from None
    with f:
        if size == 0:
            raise _unreadable(path, "it is empty")
        if size > MAX_BYTES:
            raise Refused("too-large", f"{path.name} is {size // 1024 ** 2} MB, over the {MAX_BYTES // 1024 ** 2} MB an image may be", "export a smaller copy")
        kind = sniff(f.read(4096))
        if kind not in READABLE:
            what = FOREIGN.get(str(kind)) or ("an SVG" if kind == "svg" else None)
            raise _unreadable(path, f"it holds {what}" if what else "its first bytes aren't an image's")
        reader = {"png": _png_facts, "jpeg": _jpeg_facts, "webp": _webp_facts, "gif": _gif_facts}[str(kind)]
        try:
            out = reader(f, path)
        except struct.error:
            raise _unreadable(path, "its header is damaged") from None
    width, height = int(out.get("width") or 0), int(out.get("height") or 0)
    if width <= 0 or height <= 0:
        raise _unreadable(path, f"it says it is {width}x{height}")
    if width > MAX_EDGE or height > MAX_EDGE or width * height > MAX_PIXELS:
        raise Refused("too-large", f"{path.name} is {width}x{height}, over the {MAX_EDGE} px a side and {MAX_PIXELS // 1000000} MP an image may be", "export a smaller copy")
    out["bytes"] = size
    return out


def is_srgb(profile: Optional[str]) -> bool:
    if profile is None:
        return True
    low = profile.lower().replace(" ", "")
    return "srgb" in low or "iec61966-2" in low


def needs_conform(f: Dict[str, Any]) -> List[str]:
    """What would draw wrong as it is: a profile the stage ignores, CMYK pixels, an EXIF turn it ignores."""
    out: List[str] = []
    if f.get("space") == "cmyk":
        out.append("cmyk")
    elif f.get("space") != "gray" and not is_srgb(f.get("profile")):
        out.append("colour-profile")
    if f.get("orientation") not in (None, 1):
        out.append("orientation")
    return out


def describe(f: Dict[str, Any]) -> str:
    parts = [f"{f['width']}x{f['height']}", str(f["format"])]
    if f.get("profile"):
        parts.append(str(f["profile"]))
    return " ".join(parts)


# ── pixels ────────────────────────────────────────────────────────────────────


def have_sips() -> bool:
    return os.access(SIPS, os.X_OK)


def _sips(args: List[str], src: Path, out: Path) -> None:
    if not have_sips():
        raise Refused("no-decoder", f"{src.name} can't be converted here: macOS's sips is missing", "run this on the Mac the app is installed on")
    try:
        proc = subprocess.run([SIPS, *args, str(src), "--out", str(out)], capture_output=True, text=True, errors="replace", timeout=TOOL_TIMEOUT_S, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise _unreadable(src, f"decoding it took longer than {TOOL_TIMEOUT_S} s") from None
    except OSError as e:
        raise Refused("no-decoder", f"could not run sips: {e.strerror}") from None
    if proc.returncode != 0 or not out.is_file():
        raise _unreadable(src, (proc.stderr or proc.stdout).strip().splitlines()[-1][-160:] if (proc.stderr or proc.stdout).strip() else "macOS could not decode it")


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def png_rgba(path: Path) -> Tuple[int, int, bytes]:
    """A non-interlaced PNG as (width, height, straight RGBA8 rows), the way png_decode.rs reads it, in plain Python: fast
    enough for the small files this reads. Refuses damaged data rather than guess."""
    f = facts(path)
    if f["format"] != "png":
        raise _unreadable(Path(path), "it isn't a PNG")
    if f.get("interlaced"):
        raise Refused("no-decoder", f"{Path(path).name} is interlaced, which kb reads only through sips")
    width, height, bits, colour = f["width"], f["height"], f["bits"], f["colourType"]
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colour]
    stride = (width * channels * bits + 7) // 8
    expected = (stride + 1) * height
    palette = b""
    trns = b""
    packed = zlib.decompressobj()
    raw = bytearray()
    with open(path, "rb") as fh:
        fh.seek(8)
        for _ in range(1 << 20):
            head = fh.read(8)
            if len(head) < 8:
                break
            length, kind = struct.unpack(">I4s", head)
            if kind in (b"PLTE", b"tRNS") and length <= 1 << 16:
                body = fh.read(length)
                if kind == b"PLTE":
                    palette = body
                else:
                    trns = body
                fh.seek(4, os.SEEK_CUR)
            elif kind == b"IDAT":
                try:
                    raw += packed.decompress(fh.read(length), expected + 1 - len(raw))
                except zlib.error:
                    raise _unreadable(Path(path), "its pixel data is damaged") from None
                if len(raw) > expected:
                    raise _unreadable(Path(path), "it holds more pixel data than its header says")
                fh.seek(4, os.SEEK_CUR)
            elif kind == b"IEND":
                break
            else:
                fh.seek(length + 4, os.SEEK_CUR)
    if len(raw) < expected:
        raise _unreadable(Path(path), "its pixel data is cut short")
    bpp = max(1, channels * bits // 8)
    prev = bytearray(stride)
    rgba = bytearray(width * height * 4)
    at = 0
    for y in range(height):
        kind = raw[y * (stride + 1)]
        row = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if kind == 1:
            for i in range(bpp, stride):
                row[i] = (row[i] + row[i - bpp]) & 255
        elif kind == 2:
            for i in range(stride):
                row[i] = (row[i] + prev[i]) & 255
        elif kind == 3:
            for i in range(stride):
                left = row[i - bpp] if i >= bpp else 0
                row[i] = (row[i] + (left + prev[i]) // 2) & 255
        elif kind == 4:
            for i in range(stride):
                left = row[i - bpp] if i >= bpp else 0
                corner = prev[i - bpp] if i >= bpp else 0
                row[i] = (row[i] + _paeth(left, prev[i], corner)) & 255
        elif kind != 0:
            raise _unreadable(Path(path), "a row names a filter PNG doesn't have")
        prev = row
        for x in range(width):
            if bits == 8:
                base = x * channels
                if colour == 6:
                    r, g, b, a = row[base], row[base + 1], row[base + 2], row[base + 3]
                elif colour == 2:
                    r, g, b, a = row[base], row[base + 1], row[base + 2], 255
                elif colour == 4:
                    r = g = b = row[base]
                    a = row[base + 1]
                elif colour == 0:
                    r = g = b = row[base]
                    a = 255
                else:
                    index = row[base]
                    if index * 3 + 2 >= len(palette):
                        raise _unreadable(Path(path), "a pixel names a colour its palette doesn't have")
                    r, g, b = palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]
                    a = trns[index] if index < len(trns) else 255
            elif bits == 16:
                base = x * channels * 2
                if colour == 6:
                    r, g, b, a = row[base], row[base + 2], row[base + 4], row[base + 6]
                elif colour == 2:
                    r, g, b, a = row[base], row[base + 2], row[base + 4], 255
                elif colour == 4:
                    r = g = b = row[base]
                    a = row[base + 2]
                else:
                    r = g = b = row[base]
                    a = 255
            else:
                offset = x * bits
                value = (row[offset // 8] >> (8 - bits - offset % 8)) & ((1 << bits) - 1)
                if colour == 3:
                    if value * 3 + 2 >= len(palette):
                        raise _unreadable(Path(path), "a pixel names a colour its palette doesn't have")
                    r, g, b = palette[value * 3], palette[value * 3 + 1], palette[value * 3 + 2]
                    a = trns[value] if value < len(trns) else 255
                else:
                    r = g = b = value * 255 // ((1 << bits) - 1)
                    a = 255
            rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3] = r, g, b, a
            at += 4
    return width, height, bytes(rgba)


def summarise(width: int, height: int, rgba: bytes) -> Dict[str, Any]:
    """{ blank: None | "transparent" | "single-colour", colour, ink (0..1 luma of what is visible), coverage (0..1) }."""
    step = max(1, max(width, height) // 256)
    alpha_min, alpha_max = 255, 0
    low, high = [255, 255, 255], [0, 0, 0]
    seen = visible = 0
    weight = luma = 0.0
    for y in range(0, height, step):
        for x in range(0, width, step):
            at = (y * width + x) * 4
            a = rgba[at + 3]
            seen += 1
            alpha_min = min(alpha_min, a)
            alpha_max = max(alpha_max, a)
            if a <= BLANK_TOLERANCE:
                continue
            visible += 1
            r, g, b = rgba[at], rgba[at + 1], rgba[at + 2]
            for i, v in enumerate((r, g, b)):
                low[i] = min(low[i], v)
                high[i] = max(high[i], v)
            weight += a
            luma += a * (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
    if not visible:
        return {"blank": "transparent", "colour": None, "ink": None, "coverage": 0.0}
    single = alpha_max - alpha_min <= BLANK_TOLERANCE and all(high[i] - low[i] <= BLANK_TOLERANCE for i in range(3))
    colour = "#" + "".join(f"{(low[i] + high[i]) // 2:02x}" for i in range(3))
    return {"blank": "single-colour" if single else None, "colour": colour, "ink": round(luma / weight, 3), "coverage": round(visible / seen, 3)}


def look(path: Path, f: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """summarise() of the decoded picture: small PNGs read directly, anything else shrunk by sips first."""
    path = Path(path)
    f = f or facts(path)
    small = max(f["width"], f["height"]) <= PROBE_EDGE * 2
    direct = f["format"] == "png" and not f.get("interlaced") and (small or not have_sips())
    if direct:
        return summarise(*png_rgba(path))
    with tempfile.TemporaryDirectory(prefix="kb-look-") as tmp:
        out = Path(tmp) / "look.png"
        args = ["-s", "format", "png"] + (["-Z", str(PROBE_EDGE)] if not small else [])
        _sips(args, path, out)
        return summarise(*png_rgba(out))


def refuse_blank(path: Path, f: Optional[Dict[str, Any]] = None, shown: Optional[str] = None) -> Dict[str, Any]:
    """A picture that draws nothing never comes in; returns what look() saw."""
    seen = look(path, f)
    name = shown or Path(path).name
    if seen["blank"] == "transparent":
        raise Refused("blank", f"{name} is fully transparent: it would draw nothing in a frame", "check the source file, or pass --allow-blank if this is what you want")
    if seen["blank"] == "single-colour":
        raise Refused("blank", f"{name} is one flat colour ({seen['colour']}): it would draw a plain block in a frame", "check the source file, or pass --allow-blank if this is what you want")
    return seen


def surface_of(seen: Dict[str, Any]) -> Optional[str]:
    """Which background a cut-out picture is made for, from its ink: light ink wants a dark surface. None for an opaque or mid-toned one."""
    ink, coverage = seen.get("ink"), seen.get("coverage")
    if ink is None or coverage is None or coverage >= 0.98:
        return None
    if ink >= 0.72:
        return "on-dark"
    return "on-light" if ink <= 0.45 else None


# ── a clean copy ──────────────────────────────────────────────────────────────


def _strip_jpeg_exif(path: Path) -> None:
    """Drop the APP1 EXIF blocks sips carries across, so an orientation already baked in isn't applied twice."""
    data = path.read_bytes()
    out = bytearray(data[:2])
    i = 2
    while i + 4 <= len(data) and data[i] == 0xFF:
        marker = data[i + 1]
        if marker == 0xDA:
            break
        length = struct.unpack(">H", data[i + 2:i + 4])[0]
        block = data[i:i + 2 + length]
        if not (marker == 0xE1 and block[4:10] == b"Exif\x00\x00"):
            out += block
        i += 2 + length
    out += data[i:]
    path.write_bytes(bytes(out))


def prepare(src: Path, stage: Path, *, max_edge: Optional[int] = None, conform: bool = True) -> Dict[str, Any]:
    """The file to land: src itself when nothing needs doing, else a converted copy in stage. sips can't write WebP or GIF,
    so a converted one becomes a PNG. { path, facts, ext, conformed: [reasons], resized: bool, transforms }."""
    src = Path(src)
    f = facts(src)
    reasons = needs_conform(f) if conform else []
    resize = max_edge is not None and max(f["width"], f["height"]) > max_edge
    if not reasons and not resize:
        return {"path": src, "facts": f, "ext": EXT_OF[f["format"]], "conformed": [], "resized": False, "transforms": []}
    target = "jpeg" if f["format"] == "jpeg" else "png"
    out = Path(stage) / f"converted.{EXT_OF[target]}"
    args: List[str] = []
    transforms: List[Dict[str, Any]] = []
    if "colour-profile" in reasons or "cmyk" in reasons:
        if not os.path.isfile(SRGB_PROFILE):
            raise Refused("no-decoder", f"{src.name} needs converting to sRGB, but macOS's sRGB profile is missing")
        args += ["--matchTo", SRGB_PROFILE]
        transforms.append({"op": "colour", "to": "srgb", "from": "cmyk" if "cmyk" in reasons else f.get("profile")})
    if "orientation" in reasons:
        turn, flip = UPRIGHT[int(f["orientation"])]
        if turn:
            args += ["--rotate", str(turn)]
        if flip:
            args += ["--flip", flip]
        transforms.append({"op": "upright", "orientation": f["orientation"]})
    if resize:
        args += ["--resampleHeightWidthMax", str(max_edge)]
        transforms.append({"op": "resize", "longEdge": max_edge})
    args += ["-s", "format", target]
    if target == "jpeg":
        args += ["-s", "formatOptions", JPEG_QUALITY]
    _sips(args, src, out)
    if target == "jpeg" and "orientation" in reasons:
        _strip_jpeg_exif(out)
    g = facts(out)
    if needs_conform(g) and conform:
        raise _unreadable(src, f"converting it still left {', '.join(needs_conform(g))}")
    return {"path": out, "facts": g, "ext": EXT_OF[target], "conformed": reasons, "resized": bool(resize), "transforms": transforms}


def thumb(src: Path, out: Path, box: Tuple[int, int], f: Optional[Dict[str, Any]] = None) -> Tuple[int, int, bytes]:
    """The picture as RGBA fitted inside box, never scaled up. Through sips; without it, a PNG reads directly at full size."""
    f = f or facts(src)
    k = min(box[0] / f["width"], box[1] / f["height"], 1.0)
    width, height = max(1, round(f["width"] * k)), max(1, round(f["height"] * k))
    if not have_sips():
        return png_rgba(src)
    args = ["-s", "format", "png"]
    if k < 1.0:
        args += ["--resampleHeightWidth", str(height), str(width)]
    _sips(args, src, out)
    return png_rgba(out)
