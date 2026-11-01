#!/usr/bin/env python3
# Prints the brand art from AppIcon.icon's plates (docs/design.md section 16); needs numpy, opencv-python and pillow.
import math
import sys
from pathlib import Path

try:
    import cv2
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
except ImportError as e:
    sys.exit(f"error: {e.name} is missing (pip install numpy opencv-python pillow)")

ROOT = Path(__file__).resolve().parent.parent
PLATES = ROOT / "src-tauri/icons/AppIcon.icon/Assets"
FONTS = ROOT / "src/assets/fonts"
ORDER = ["rust", "blue", "stripe", "slate", "buff", "cream"]


def hexink(h):
    return np.array([int(h[i : i + 2], 16) / 255 for i in (1, 3, 5)], np.float32)


NAVY, CREAM, RUST, STRIPE, SLATE = map(hexink, ("#0E1825", "#F6E3CF", "#75422A", "#341F19", "#667D8F"))
SUBTITLE = SLATE * 0.35 + CREAM * 0.65
PLATE = {}
for name in ORDER:
    im = cv2.imread(str(PLATES / f"{name}.png"), cv2.IMREAD_UNCHANGED).astype(np.float32) / 255
    a = im[..., 3:]
    PLATE[name] = np.dstack([im[..., 2::-1] * a, a])


def grid(h, w):
    return np.mgrid[0:h, 0:w].astype(np.float32)


def noise(rng, shape, sigma, scale):
    n = cv2.GaussianBlur(rng.standard_normal(shape).astype(np.float32), (0, 0), sigma)
    return n / n.std() * scale


def tooth(rng, shape, s):
    return np.clip(1 + noise(rng, shape, 45, s * 0.45) + noise(rng, shape, 1.0, s), 0.74, 1.12)


def lay(c, col, a):
    return c * (1 - a[..., None]) + col * a[..., None]


def screen(cov, angle, pitch):
    yy, xx = grid(*cov.shape)
    r = np.deg2rad(angle)
    u = (xx * np.cos(r) + yy * np.sin(r)) * 2 * np.pi / pitch
    v = (-xx * np.sin(r) + yy * np.cos(r)) * 2 * np.pi / pitch
    scr = 0.5 + 0.25 * (np.cos(u) + np.cos(v))
    return np.clip((cov - scr) * pitch * 0.9 + 0.5, 0, 1) * (cov > 0.004)


def box(shape, x0, y0, x1, y1):
    yy, xx = grid(*shape)
    return np.clip(xx + 1 - x0, 0, 1) * np.clip(x1 - xx, 0, 1) * np.clip(yy + 1 - y0, 0, 1) * np.clip(y1 - yy, 0, 1)


def disc(shape, cx, cy, r):
    yy, xx = grid(*shape)
    return np.clip(r - np.hypot(xx - cx, yy - cy) + 0.5, 0, 1)


def triangle(shape, pts):
    m = np.zeros(shape, np.uint8)
    cv2.fillPoly(m, [np.int32(np.array(pts) * 16)], 255, lineType=cv2.LINE_AA, shift=4)
    return m.astype(np.float32) / 255


def moon(c, rng, cx, cy, r, s):
    shape = c.shape[:2]
    yy, xx = grid(*shape)
    m = disc(shape, cx, cy, r)
    c = lay(c, RUST * tooth(rng, shape, 0.08)[..., None], m)
    cov = np.clip((xx - cx + yy - cy + r * 0.7) / (r * 2.2), 0, 0.62)
    return lay(c, STRIPE * tooth(rng, shape, 0.07)[..., None], m * screen(cov, 15, max(5.5, 17.6 * s)))


def bird(c, s, ox, oy):
    h, w = c.shape[:2]
    yy, xx = grid(h, w)
    c = lay(c, NAVY, np.clip(46 * s - np.hypot(xx - (ox + 990 * s), yy - (oy + 565 * s)) + 0.5, 0, 1))
    n = int(round(2048 * s))
    M = np.float32([[1, 0, ox], [0, 1, oy]])
    for name in ORDER:
        p = PLATE[name]
        p = cv2.resize(p, (n, n), interpolation=cv2.INTER_CUBIC if n > p.shape[0] else cv2.INTER_AREA)
        p = cv2.warpAffine(p, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
        a = np.clip(p[..., 3:], 0, 1)
        c = c * (1 - a) + np.clip(p[..., :3], 0, 1)
    return c


def rule(c, x0, y, k, x1=None):
    # The product sign: a timeline ruler with its playhead, running off the sheet.
    shape = c.shape[:2]
    x1 = shape[1] if x1 is None else x1
    t = max(1.5, 3 * k)
    c = lay(c, SLATE, box(shape, x0, y, x1, y + t))
    step = 62 * k
    for i in range(int((x1 - x0) / step) + 1):
        x = x0 + i * step
        c = lay(c, SLATE, box(shape, x, y, x + t, y + (36 if i % 5 == 0 else 16) * k))
    px = x0 + 8 * step
    c = lay(c, CREAM, box(shape, px - t, y - 30 * k, px + t, y + 62 * k))
    return lay(c, CREAM, triangle(shape, [(px - 20 * k, y - 50 * k), (px + 20 * k, y - 50 * k), (px, y - 24 * k)]))


def words(c, lines):
    im = Image.fromarray((np.clip(c, 0, 1) * 255 + 0.5).astype(np.uint8))
    d = ImageDraw.Draw(im)
    for x, y, size, face, col, text, track in lines:
        f = ImageFont.truetype(str(FONTS / f"Inter-{face}.woff"), int(size))
        fill = tuple(int(v * 255 + 0.5) for v in col)
        for i, ch in enumerate(text):
            d.text((x, y), ch, font=f, fill=fill, anchor="ls")
            pair = text[i : i + 2]
            x += (f.getlength(pair) - f.getlength(pair[1:]) + track) if len(pair) == 2 else 0
    return np.asarray(im).astype(np.float32) / 255


def print_sheet(w, h, s, ox, x, base, size, rule_y=None, seed=1773):
    rng = np.random.default_rng(seed)
    shape = (h, w)
    c = NAVY * tooth(rng, shape, 0.10)[..., None]
    oy = h - int(round(2048 * s))
    c = moon(c, rng, ox + 1080 * s, oy + 670 * s, 950 * s, s)
    k = (size or 110) / 178
    if rule_y is not None:
        c = rule(c, x + 5 * k, rule_y, k)
    c = bird(c, s, ox, oy)
    if size:
        c = words(c, [
            (x, base, size, "SemiBold", CREAM, "Kookaburra Cut", -3.9 * k),
            (x + 5 * k, base + 118 * k, 72 * k, "Regular", SUBTITLE, "Give every feature its moment.", -0.6 * k),
        ])
    return c


def dmg(scale):
    rng = np.random.default_rng(1776)
    w, h = 806 * scale, 488 * scale
    shape = (h, w)
    c = NAVY * tooth(rng, shape, 0.10)[..., None]
    c = moon(c, rng, 635 * scale, 232 * scale, 80 * scale, 0.16 * scale)
    c = rule(c, 270 * scale, 253 * scale, 0.28 * scale, 520 * scale)
    tip = 532 * scale
    y = 254 * scale
    c = lay(c, SLATE, triangle(shape, [(tip - 16 * scale, y - 9 * scale), (tip, y), (tip - 16 * scale, y + 9 * scale)]))
    for cx in (170, 635):
        c = lay(c, hexink("#364555"), box(shape, (cx - 76) * scale, 316 * scale, (cx + 76) * scale, 345 * scale))
    def centred(base, size, face, col, text):
        f = ImageFont.truetype(str(FONTS / f"Inter-{face}.woff"), int(size))
        return ((w - f.getlength(text)) / 2, base, size, face, col, text, 0)

    return words(c, [
        centred(398 * scale, 25 * scale, "SemiBold", CREAM, "Give it a place on your Mac."),
        centred(428 * scale, 14 * scale, "Regular", SUBTITLE, "Move Kookaburra Cut into Applications."),
    ])


def roundel(size):
    # Where a layout has no sheet edge to bleed off, the bird is cut hard to its moon.
    rng = np.random.default_rng(1777)
    shape = (size, size)
    r = size / 2 - 2
    bs = r / 950
    ox, oy = size / 2 - 1080 * bs, size / 2 - 670 * bs
    c = NAVY * tooth(rng, shape, 0.10)[..., None]
    c = moon(c, rng, size / 2, size / 2, r, bs)
    c = bird(c, bs, int(round(ox)), int(round(oy)))
    return np.dstack([c, disc(shape, size / 2, size / 2, r)])


def shrink(c, w, h):
    return cv2.resize(c, (w, h), interpolation=cv2.INTER_AREA)


def save(c, path, colours=None, quality=None):
    path = ROOT / path
    im = Image.fromarray((np.clip(c, 0, 1) * 255 + 0.5).astype(np.uint8))
    if quality:
        im.save(path, quality=quality, subsampling=0, optimize=True)
    elif colours:
        im.quantize(colours, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(path, optimize=True)
    else:
        im.save(path, optimize=True)
    print(f"{path.relative_to(ROOT)}: {path.stat().st_size // 1024} KB")


card = print_sheet(2560, 1280, 0.54, -30, 1150, 610, 178, 830)
save(card, "docs/assets/social-preview.jpg", quality=88)
save(shrink(roundel(2000), 1000, 1000), "docs/assets/print-roundel.png")
save(shrink(print_sheet(2400, 1260, 0.5, -30, 1070, 600, 170, 815), 1200, 630), "docs/assets/og.png", colours=256)
save(print_sheet(2400, 800, 0.38, -24, 860, 390, 148, 575), "docs/assets/readme-banner.jpg", quality=88)
save(shrink(print_sheet(1920, 640, 0.3, -18, 700, 0, 0, 390), 960, 320), "src/assets/update-banner.jpg", quality=88)
save(dmg(2), "src-tauri/dmg/dmg_bg@2x.png", colours=256)
save(shrink(dmg(2), 806, 488), "src-tauri/dmg/dmg_bg.png", colours=256)
