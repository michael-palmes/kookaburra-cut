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


NAVY, CREAM, RUST, STRIPE, SLATE, BUFF = map(hexink, ("#0E1825", "#F6E3CF", "#75422A", "#341F19", "#667D8F", "#ECC49A"))
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


def rule(c, x0, y, k, x1=None, head=None):
    # The product sign: a timeline ruler with its playhead, running off the sheet.
    shape = c.shape[:2]
    x1 = shape[1] if x1 is None else x1
    t = max(1.5, 3 * k)
    c = lay(c, SLATE, box(shape, x0, y, x1, y + t))
    step = 62 * k
    for i in range(int((x1 - x0) / step) + 1):
        x = x0 + i * step
        c = lay(c, SLATE, box(shape, x, y, x + t, y + (36 if i % 5 == 0 else 16) * k))
    px = x0 + 8 * step if head is None else head
    c = lay(c, CREAM, box(shape, px - t, y - 30 * k, px + t, y + 62 * k))
    return lay(c, CREAM, triangle(shape, [(px - 20 * k, y - 50 * k), (px + 20 * k, y - 50 * k), (px, y - 24 * k)]))


def font(face, size):
    return ImageFont.truetype(str(FONTS / f"{face if '-' in face else 'Inter-' + face}.woff"), int(size))


def words(c, lines):
    im = Image.fromarray((np.clip(c, 0, 1) * 255 + 0.5).astype(np.uint8))
    d = ImageDraw.Draw(im)
    for x, y, size, face, col, text, track in lines:
        f = font(face, size)
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
        return ((w - font(face, size).getlength(text)) / 2, base, size, face, col, text, 0)

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


class Diagram:
    def __init__(self, w, h):
        self.c = np.broadcast_to(NAVY, (h * 2, w * 2, 3)).copy()
        self.lines = []

    def fill(self, col, x0, y0, x1, y1):
        self.c[round(y0 * 2) : round(y1 * 2), round(x0 * 2) : round(x1 * 2)] = col

    def frame(self, col, x0, y0, x1, y1, t):
        for b in ((x0, y0, x1, y0 + t), (x0, y1 - t, x1, y1), (x0, y0, x0 + t, y1), (x1 - t, y0, x1, y1)):
            self.fill(col, *b)

    def arrow(self, x0, y0, x1, y1, dashed=False):
        down = x0 == x1
        end = (y1 if down else x1) - 14
        at = y0 if down else x0
        while at < end:
            to = min(at + 12, end) if dashed else end
            self.fill(CREAM, *((x0 - 1.5, at, x0 + 1.5, to) if down else (at, y0 - 1.5, to, y0 + 1.5)))
            at = to + 8
        tip = [(x1 - 8, y1 - 14), (x1 + 8, y1 - 14), (x1, y1)] if down else [(x1 - 14, y1 - 8), (x1 - 14, y1 + 8), (x1, y1)]
        self.c = lay(self.c, CREAM, triangle(self.c.shape[:2], [(x * 2, y * 2) for x, y in tip]))

    def say(self, x, y, size, face, col, text, align=0, track=0):
        w = font(face, size * 2).getlength(text) / 2 + track * (len(text) - 1)
        self.lines.append(((x - w * align) * 2, y * 2, size * 2, face, col, text, track * 2))
        return x - w * align + w

    def block(self, x, y, col, title, *subs, sub=SUBTITLE):
        self.say(x, y, 24, "SemiBold", col, title)
        for i, text in enumerate(subs):
            self.say(x, y + 28 + i * 24, 18, "Regular", sub, text)

    def done(self):
        return words(self.c, self.lines)


def doors():
    d = Diagram(1200, 680)
    d.frame(CREAM, 40, 40, 560, 640, 6)
    d.say(72, 90, 16, "SemiBold", SUBTITLE, "YOUR MAC", track=2)
    inside = [
        ("Projects", "scenes, footage, brand files"),
        ("Render", "one canvas, frame by frame"),
        ("Export", "ffmpeg, built without networking"),
    ]
    outside = [
        ("GitHub", "update check and install", "DisableUpdateCheck"),
        ("Your Claude app", "your account, your settings", "DisableClaude"),
        ("A website you allow", "live inside a scene", "DisableLiveWebsites"),
    ]
    for i, (stays, (name, what, key)) in enumerate(zip(inside, outside)):
        y = 112 + i * 136
        cy = y + 44
        d.frame(SLATE, 72, y, 500, y + 88, 3)
        d.block(96, y + 40, CREAM, *stays)
        if i:
            d.arrow(286, y - 46, 286, y - 2)
        d.fill(CREAM, 534, cy - 18, 586, cy + 18)
        d.fill(RUST, 537, cy - 15, 583, cy + 15)
        d.fill(BUFF, 541, cy - 11, 559, cy + 11)
        d.arrow(594, cy, 714, cy, dashed=True)
        d.frame(CREAM, 720, cy - 44, 1160, cy + 44, 3)
        d.block(744, cy - 4, CREAM, name, what)
        x = d.say(720, cy + 70, 16, "Regular", SUBTITLE, "Fleet lock")
        d.say(x + 10, cy + 70, 16, "JetBrainsMono-Regular", BUFF, key)
    d.say(72, 548, 18, "Regular", SUBTITLE, "No account. No telemetry.")
    d.say(72, 574, 18, "Regular", SUBTITLE, "No HTTP client of its own.")
    d.fill(RUST, 546, 524, 574, 612)
    d.block(600, 562, CREAM, "No other way out", "the app's policy names no outside host")
    return d.done()


def release():
    d = Diagram(1200, 300)
    steps = [
        ("Signed tag", "Touch ID key in the", "Mac's Secure Enclave"),
        ("Build", "pinned tools, no", "signing secret in reach"),
        ("Sign", "second reviewer,", "signed and notarised"),
        ("Verify", "fresh runner,", "every file rechecked"),
        ("Publish", "attested, with an SBOM", "and SHA256SUMS"),
        ("Your Mac", "check it yourself", "with three commands"),
    ]
    d.fill(SLATE, 110, 66.5, 1090, 69.5)
    for i, (title, *subs) in enumerate(steps):
        x = 110 + i * 196
        last = i == len(steps) - 1
        d.fill(CREAM if last else RUST, x - 28, 40, x + 28, 96)
        d.say(x, 78, 26, "SemiBold", NAVY if last else CREAM, str(i + 1), align=0.5)
        d.say(x, 140, 22, "SemiBold", CREAM, title, align=0.5)
        for j, text in enumerate(subs):
            d.say(x, 168 + j * 22, 16, "Regular", SUBTITLE, text, align=0.5)
    head = (110 + (len(steps) - 1) * 196) * 2
    d.c = rule(d.c, head - 42 * 49.6, 480, 0.8, head=head)
    return d.done()


def shared():
    d = Diagram(1200, 370)
    d.frame(SLATE, 40, 40, 300, 150, 3)
    d.block(60, 80, CREAM, "Shared work", "a project or pack from", "a colleague or download")
    d.arrow(304, 95, 340, 95)
    d.fill(RUST, 344, 40, 604, 150)
    d.block(364, 80, CREAM, "Checked on import", "a pack's signature and", "hashes. Nothing runs.", sub=CREAM)
    d.arrow(608, 95, 644, 95)
    d.fill(RUST, 648, 40, 908, 150)
    d.block(668, 80, CREAM, "You allow it", "Don't open is the default.", "A change asks again.", sub=CREAM)
    d.arrow(912, 95, 948, 95)
    d.frame(CREAM, 952, 40, 1160, 150, 6)
    d.block(974, 80, CREAM, "The stage", "no network,", "no app commands")
    d.arrow(170, 154, 170, 216)
    d.frame(SLATE, 40, 220, 300, 330, 3)
    d.say(60, 262, 24, "SemiBold", CREAM, "Agent settings in it")
    d.say(60, 294, 16, "JetBrainsMono-Regular", BUFF, "CLAUDE.md  .claude/")
    d.arrow(304, 275, 340, 275)
    d.fill(RUST, 344, 220, 1160, 330)
    d.block(364, 262, CREAM, "Set aside", "dropped on import, and you see the list before Claude starts", sub=CREAM)
    return d.done()


ART = [
    ("docs/assets/social-preview.jpg", lambda: print_sheet(2560, 1280, 0.54, -30, 1150, 610, 178, 830), {"quality": 88}),
    ("docs/assets/print-roundel.png", lambda: shrink(roundel(2000), 1000, 1000), {}),
    ("docs/assets/og.png", lambda: shrink(print_sheet(2400, 1260, 0.5, -30, 1070, 600, 170, 815), 1200, 630), {"colours": 256}),
    ("docs/assets/readme-banner.jpg", lambda: print_sheet(2400, 800, 0.38, -24, 860, 390, 148, 575), {"quality": 88}),
    ("src/assets/update-banner.jpg", lambda: shrink(print_sheet(1920, 640, 0.3, -18, 700, 0, 0, 390), 960, 320), {"quality": 88}),
    ("src-tauri/dmg/dmg_bg@2x.png", lambda: dmg(2), {"colours": 256}),
    ("src-tauri/dmg/dmg_bg.png", lambda: shrink(dmg(2), 806, 488), {"colours": 256}),
    ("docs/assets/security-doors.png", doors, {"colours": 64}),
    ("docs/assets/security-release.png", release, {"colours": 64}),
    ("docs/assets/security-shared.png", shared, {"colours": 64}),
]
wanted = [art for art in ART if not sys.argv[1:] or any(word in art[0] for word in sys.argv[1:])]
if not wanted:
    sys.exit(f"No art path holds: {' '.join(sys.argv[1:])}")
for path, make, how in wanted:
    save(make(), path, **how)
