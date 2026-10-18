"""Timestamp labels for contact sheets, drawn with a 5x7 bitmap font into an RGBA PNG (the bundled ffmpeg has no drawtext); pure stdlib."""

from __future__ import annotations

import struct
import zlib
from typing import Dict, Iterable, List, Sequence, Tuple

GLYPH_W, GLYPH_H = 5, 7
ADVANCE = GLYPH_W + 1
PAD = 2
INK = (255, 255, 255, 255)
BACKING = (0, 0, 0, 190)

_ROWS: Dict[str, str] = {
    "0": "01110 10001 10011 10101 11001 10001 01110", "1": "00100 01100 00100 00100 00100 00100 01110",
    "2": "01110 10001 00001 00010 00100 01000 11111", "3": "11111 00010 00100 00010 00001 10001 01110",
    "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "00110 01000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110", "9": "01110 10001 10001 01111 00001 00010 01100",
    "A": "01110 10001 10001 11111 10001 10001 10001", "B": "11110 10001 10001 11110 10001 10001 11110",
    "C": "01110 10001 10000 10000 10000 10001 01110", "D": "11100 10010 10001 10001 10001 10010 11100",
    "E": "11111 10000 10000 11110 10000 10000 11111", "F": "11111 10000 10000 11110 10000 10000 10000",
    "G": "01110 10001 10000 10111 10001 10001 01111", "H": "10001 10001 10001 11111 10001 10001 10001",
    "I": "01110 00100 00100 00100 00100 00100 01110", "J": "00111 00010 00010 00010 00010 10010 01100",
    "K": "10001 10010 10100 11000 10100 10010 10001", "L": "10000 10000 10000 10000 10000 10000 11111",
    "M": "10001 11011 10101 10101 10001 10001 10001", "N": "10001 10001 11001 10101 10011 10001 10001",
    "O": "01110 10001 10001 10001 10001 10001 01110", "P": "11110 10001 10001 11110 10000 10000 10000",
    "Q": "01110 10001 10001 10001 10101 10010 01101", "R": "11110 10001 10001 11110 10100 10010 10001",
    "S": "01111 10000 10000 01110 00001 00001 11110", "T": "11111 00100 00100 00100 00100 00100 00100",
    "U": "10001 10001 10001 10001 10001 10001 01110", "V": "10001 10001 10001 10001 10001 01010 00100",
    "W": "10001 10001 10001 10101 10101 10101 01010", "X": "10001 10001 01010 00100 01010 10001 10001",
    "Y": "10001 10001 01010 00100 00100 00100 00100", "Z": "11111 00001 00010 00100 01000 10000 11111",
    "a": "00000 00000 01110 00001 01111 10001 01111", "b": "10000 10000 10110 11001 10001 10001 11110",
    "c": "00000 00000 01110 10000 10000 10001 01110", "d": "00001 00001 01101 10011 10001 10001 01111",
    "e": "00000 00000 01110 10001 11111 10000 01110", "f": "00110 01001 01000 11100 01000 01000 01000",
    "g": "00000 01111 10001 10001 01111 00001 01110", "h": "10000 10000 10110 11001 10001 10001 10001",
    "i": "00100 00000 01100 00100 00100 00100 01110", "j": "00010 00000 00110 00010 00010 10010 01100",
    "k": "10000 10000 10010 10100 11000 10100 10010", "l": "01100 00100 00100 00100 00100 00100 01110",
    "m": "00000 00000 11010 10101 10101 10001 10001", "n": "00000 00000 10110 11001 10001 10001 10001",
    "o": "00000 00000 01110 10001 10001 10001 01110", "p": "00000 00000 11110 10001 11110 10000 10000",
    "q": "00000 00000 01101 10011 01111 00001 00001", "r": "00000 00000 10110 11001 10000 10000 10000",
    "s": "00000 00000 01110 10000 01110 00001 11110", "t": "01000 01000 11100 01000 01000 01001 00110",
    "u": "00000 00000 10001 10001 10001 10011 01101", "v": "00000 00000 10001 10001 10001 01010 00100",
    "w": "00000 00000 10001 10001 10101 10101 01010", "x": "00000 00000 10001 01010 00100 01010 10001",
    "y": "00000 00000 10001 10001 01111 00001 01110", "z": "00000 00000 11111 00010 00100 01000 11111",
    ".": "00000 00000 00000 00000 00000 01100 01100", ":": "00000 01100 01100 00000 01100 01100 00000",
    "-": "00000 00000 00000 11111 00000 00000 00000", "+": "00000 00100 00100 11111 00100 00100 00000",
    "#": "01010 01010 11111 01010 11111 01010 01010", "/": "00000 00001 00010 00100 01000 10000 00000",
    "@": "01110 10001 10111 10101 10111 10000 01110", "%": "11000 11001 00010 00100 01000 10011 00011",
    "(": "00010 00100 01000 01000 01000 00100 00010", ")": "01000 00100 00010 00010 00010 00100 01000",
    "?": "01110 10001 00001 00010 00100 00000 00100", " ": "00000 00000 00000 00000 00000 00000 00000",
}
GLYPHS: Dict[str, Tuple[int, ...]] = {ch: tuple(int(row, 2) for row in rows.split()) for ch, rows in _ROWS.items()}


def glyph(ch: str) -> Tuple[int, ...]:
    return GLYPHS.get(ch) or GLYPHS["?"]


def fmt_stamp(ms: float) -> str:
    """12.35s under a minute, then 1:02.35."""
    cs = int(max(0.0, float(ms)) / 10.0 + 0.5)
    seconds, hundredths = divmod(cs, 100)
    if seconds < 60:
        return f"{seconds}.{hundredths:02d}s"
    minutes, seconds = divmod(seconds, 60)
    return f"{minutes}:{seconds:02d}.{hundredths:02d}"


def text_size(text: str, scale: int = 2) -> Tuple[int, int]:
    """The label's box, backing included."""
    n = len(text)
    inner_w = (n * ADVANCE - 1) * scale if n else 0
    return inner_w + 2 * PAD * scale, GLYPH_H * scale + 2 * PAD * scale


class Canvas:
    """A transparent RGBA image to paint labels on."""

    def __init__(self, width: int, height: int) -> None:
        if width <= 0 or height <= 0:
            raise ValueError("a canvas needs a positive size")
        self.width = width
        self.height = height
        self.px = bytearray(width * height * 4)

    def fill(self, x: int, y: int, w: int, h: int, rgba: Sequence[int]) -> None:
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(self.width, x + w), min(self.height, y + h)
        if x1 <= x0 or y1 <= y0:
            return
        run = bytes(rgba) * (x1 - x0)
        stride = self.width * 4
        for row in range(y0, y1):
            start = row * stride + x0 * 4
            self.px[start:start + len(run)] = run

    def label(self, x: int, y: int, text: str, scale: int = 2) -> Tuple[int, int]:
        """A white label on a dark backing with its top left at (x, y); returns its size."""
        scale = max(1, int(scale))
        w, h = text_size(text, scale)
        self.fill(x, y, w, h, BACKING)
        ox, oy = x + PAD * scale, y + PAD * scale
        for i, ch in enumerate(text):
            rows = glyph(ch)
            gx = ox + i * ADVANCE * scale
            for r, bits in enumerate(rows):
                for c in range(GLYPH_W):
                    if bits & (1 << (GLYPH_W - 1 - c)):
                        self.fill(gx + c * scale, oy + r * scale, scale, scale, INK)
        return w, h

    def png(self) -> bytes:
        stride = self.width * 4
        raw = b"".join(b"\x00" + bytes(self.px[r * stride:(r + 1) * stride]) for r in range(self.height))
        return png_bytes(self.width, self.height, raw)


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def png_bytes(width: int, height: int, filtered_rgba: bytes) -> bytes:
    """An 8-bit RGBA PNG from rows that already carry their filter byte."""
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", header) + _chunk(b"IDAT", zlib.compress(filtered_rgba, 6)) + _chunk(b"IEND", b"")


def overlay_png(width: int, height: int, labels: Iterable[Tuple[int, int, str]], scale: int = 2) -> bytes:
    """A width x height transparent PNG holding each (x, y, text) label, to overlay on a sheet at 0:0."""
    canvas = Canvas(width, height)
    for x, y, text in labels:
        canvas.label(int(x), int(y), text, scale)
    return canvas.png()


def label_png(text: str, scale: int = 2) -> bytes:
    w, h = text_size(text, scale)
    canvas = Canvas(max(1, w), max(1, h))
    canvas.label(0, 0, text, scale)
    return canvas.png()


def read_png_rgba(data: bytes) -> Tuple[int, int, List[bytes]]:
    """Rows of an unfiltered (filter 0) 8-bit RGBA PNG written by png_bytes; for tests."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, width, height, idat = 8, 0, 0, b""
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            width, height = struct.unpack(">II", body[:8])
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    raw = zlib.decompress(idat)
    stride = width * 4 + 1
    return width, height, [raw[r * stride + 1:(r + 1) * stride] for r in range(height)]
