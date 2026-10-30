"""kb assets add's still and SVG handling, the deep probe before a skipped conform, and kb assets add-folder. Test media is generated here."""

from __future__ import annotations

import base64
import json
import os
import shutil
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from kblib import asset_folder, assets, imagefile, svgsafe

from .fake_app_cli import MEDIA_CAPS
from .helpers import KbTestCase, make_project, png_bytes, read_json, write_json

MEDIA = json.dumps({"media": MEDIA_CAPS})
DARWIN = sys.platform == "darwin" and imagefile.have_sips()
# A 1x1 lossy WebP, the smallest real one: enough for headers and the blank guard.
TINY_WEBP = base64.b64decode("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")
GOOD_SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="2" y="2" width="12" height="20" fill="#e33"/></svg>'


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def png(pixels: List[List[Tuple[int, int, int, int]]], extra: bytes = b"") -> bytes:
    """An 8-bit RGBA PNG from rows of pixels, with chunks to place before its data."""
    height, width = len(pixels), len(pixels[0])
    raw = b"".join(b"\x00" + b"".join(bytes(p) for p in row) for row in pixels)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + extra + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def flat(width: int, height: int, colour: Tuple[int, int, int, int]) -> bytes:
    return png([[colour] * width for _ in range(height)])


def ink_on_clear(width: int, height: int, ink: Tuple[int, int, int]) -> bytes:
    """A left half of solid ink on a transparent canvas: a cut-out logo."""
    return png([[(*ink, 255) if x < width // 2 else (0, 0, 0, 0) for x in range(width)] for _ in range(height)])


def icc_profile(name: str) -> bytes:
    """Just enough of an ICC profile to carry a v2 description."""
    text = name.encode("latin-1") + b"\x00"
    desc = b"desc\x00\x00\x00\x00" + struct.pack(">I", len(text)) + text
    return b"\x00" * 128 + struct.pack(">I", 1) + struct.pack(">4sII", b"desc", 144, len(desc)) + desc


def iccp_chunk(name: str) -> bytes:
    return chunk(b"iCCP", b"icc\x00\x00" + zlib.compress(icc_profile(name)))


def exif_block(orientation: int) -> bytes:
    return b"MM\x00*\x00\x00\x00\x08" + struct.pack(">H", 1) + struct.pack(">HHI", 0x0112, 3, 1) + struct.pack(">H", orientation) + b"\x00\x00" + b"\x00\x00\x00\x00"


class ImportCase(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.outside = self.tmp / "outside"
        self.outside.mkdir()
        self.log = self.tmp / "argv.log"

    def source(self, name: str, data: bytes) -> Path:
        path = self.outside / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def add(self, *args: str, code: Optional[int] = 0) -> Any:
        proc = self.kb(["assets", "add", *args, "--json"], cwd=self.root)
        if code is not None:
            self.assertExit(proc, code)
        return json.loads(proc.stdout)

    def folder(self, *args: str, code: Optional[int] = 0) -> Any:
        proc = self.kb(["assets", "add-folder", *args, "--json"], cwd=self.root)
        if code is not None:
            self.assertExit(proc, code)
        return json.loads(proc.stdout)


class NameTests(ImportCase):
    def test_name_without_an_extension_keeps_the_sources(self) -> None:
        res = self.add(str(self.source("Hero Shot.PNG", png_bytes())), "--name", "cover")
        self.assertEqual(res["path"], "assets/cover.png")

    def test_a_dotted_name_is_not_taken_for_an_extension(self) -> None:
        res = self.add(str(self.source("a.png", png_bytes())), "--name", "v1.2")
        self.assertEqual(res["path"], "assets/v1.2.png")

    def test_another_extension_in_name_never_changes_the_real_one(self) -> None:
        proc = self.kb(["assets", "add", str(self.source("a.png", png_bytes())), "--name", "cover.jpg"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertEqual(proc.stdout.strip(), "assets/cover.png")
        self.assertIn("--name said .jpg", proc.stderr)
        self.assertFalse((self.root / "assets" / "cover.jpg").exists())

    def test_a_video_name_keeps_the_videos_extension(self) -> None:
        src = self.source("rec.mov", b"not really a movie")
        res = self.add(str(src), "--name", "take.mp4", "--no-conform")
        self.assertEqual(res["path"], "assets/take.mov")

    def test_jpg_and_jpeg_are_one_format(self) -> None:
        self.assertEqual(assets.final_name_of("a.jpg", "b.jpeg"), ("b.jpeg", None))

    def test_a_bad_name_is_refused(self) -> None:
        src = self.source("a.png", png_bytes())
        for name in ("../x", "sub/x", ".hidden"):
            self.assertExit(self.kb(["assets", "add", str(src), "--name", name], cwd=self.root), 2)

    def test_dir_cant_reach_hidden_folders_or_leave_through_a_link(self) -> None:
        src = self.source("a.png", png_bytes())
        self.assertExit(self.kb(["assets", "add", str(src), "--dir", ".originals"], cwd=self.root), 2)
        self.assertExit(self.kb(["assets", "add", str(src), "--dir", "../scenes"], cwd=self.root), 2)
        os.symlink(self.outside, self.root / "assets" / "out")
        self.assertExit(self.kb(["assets", "add", str(src), "--dir", "out"], cwd=self.root), 2)


class FactsTests(ImportCase):
    def test_real_format_beats_the_name(self) -> None:
        res = self.add(str(self.source("really-a-png.jpg", png_bytes())))
        self.assertEqual((res["path"], res["image"]["format"]), ("assets/really-a-png.png", "png"))
        self.assertTrue(any("really a PNG" in w for w in res["warnings"]), res["warnings"])

    def test_what_isnt_an_image_is_refused_whatever_its_name(self) -> None:
        for name, data, word in (("a.png", b"not an image", "first bytes"), ("b.png", b"", "empty"), ("c.jpg", b"II*\x00" + b"\x00" * 64, "TIFF"), ("d.webp", b"%PDF-1.7", "PDF")):
            res = self.add(str(self.source(name, data)), code=1)
            self.assertEqual(res["code"], "invalid", name)
            self.assertIn(word, res["error"], name)
            self.assertFalse((self.root / "assets" / name).exists())

    def test_a_cut_short_png_is_refused(self) -> None:
        data = png_bytes(8, 8)
        self.assertEqual(self.add(str(self.source("a.png", data[:40])), code=1)["code"], "invalid")

    def test_a_decompression_bomb_is_refused_before_anything_decodes_it(self) -> None:
        header = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 60000, 60000, 8, 6, 0, 0, 0)) + chunk(b"IDAT", b"x") + chunk(b"IEND", b"")
        res = self.add(str(self.source("bomb.png", header)), code=1)
        self.assertEqual(res["code"], "too-large")
        wide = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 16000, 16000, 8, 6, 0, 0, 0)) + chunk(b"IDAT", b"x") + chunk(b"IEND", b"")
        self.assertEqual(self.add(str(self.source("wide.png", wide)), code=1)["code"], "too-large")

    def test_png_with_a_damaged_row_filter_or_palette_is_refused(self) -> None:
        raw = b"\x09" + b"\x00" * 16
        bad = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 1, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
        self.assertEqual(self.add(str(self.source("filter.png", bad)), code=1)["code"], "invalid")
        indexed = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 1, 8, 3, 0, 0, 0)) + chunk(b"PLTE", b"\x00\x00\x00") + chunk(b"IDAT", zlib.compress(b"\x00\x00\x05")) + chunk(b"IEND", b"")
        self.assertEqual(self.add(str(self.source("palette.png", indexed)), code=1)["code"], "invalid")

    def test_header_facts_name_what_would_draw_wrong(self) -> None:
        p3 = self.source("p3.png", png([[(1, 2, 3, 255), (9, 8, 7, 255)]], iccp_chunk("Display P3")))
        f = imagefile.facts(p3)
        self.assertEqual((f["profile"], imagefile.needs_conform(f)), ("Display P3", ["colour-profile"]))
        srgb = self.source("srgb.png", png([[(1, 2, 3, 255), (9, 8, 7, 255)]], iccp_chunk("sRGB IEC61966-2.1")))
        self.assertEqual(imagefile.needs_conform(imagefile.facts(srgb)), [])
        turned = self.source("turned.png", png([[(1, 2, 3, 255), (9, 8, 7, 255)]], chunk(b"eXIf", exif_block(6))))
        self.assertEqual(imagefile.needs_conform(imagefile.facts(turned)), ["orientation"])
        anim = self.source("anim.png", png([[(1, 2, 3, 255), (9, 8, 7, 255)]], chunk(b"acTL", b"\x00\x00\x00\x02\x00\x00\x00\x00")))
        self.assertTrue(imagefile.facts(anim)["animated"])
        self.assertEqual(imagefile.facts(self.source("t.webp", TINY_WEBP))["format"], "webp")

    def test_probe_reports_a_stills_facts(self) -> None:
        (self.root / "assets" / "plain.png").write_bytes(flat(4, 4, (9, 9, 9, 255)))
        info = json.loads(self.kb(["assets", "probe", "plain.png", "--json"], cwd=self.root).stdout)
        self.assertEqual((info["image"]["format"], info["image"]["blank"]), ("png", "single-colour"))


class BlankTests(ImportCase):
    def test_fully_transparent_and_one_colour_are_refused(self) -> None:
        clear = self.add(str(self.source("clear.png", flat(32, 32, (0, 0, 0, 0)))), code=1)
        self.assertEqual((clear["code"], clear["refused"]), ("invalid", "blank"))
        self.assertIn("fully transparent", clear["error"])
        white = self.add(str(self.source("white.png", flat(32, 32, (255, 255, 255, 255)))), code=1)
        self.assertIn("#ffffff", white["error"])
        self.assertEqual(sorted(p.name for p in (self.root / "assets").iterdir()), ["logo.png"])

    def test_a_cut_out_shape_in_one_ink_is_not_blank(self) -> None:
        self.assertEqual(self.add(str(self.source("logo.png", ink_on_clear(32, 32, (255, 255, 255)))), "--name", "mark")["path"], "assets/mark.png")

    def test_noise_inside_the_tolerance_still_counts_as_one_colour(self) -> None:
        pixels = [[(100 + (x + y) % 2, 100, 100, 255) for x in range(16)] for y in range(16)]
        self.assertEqual(self.add(str(self.source("noise.png", png(pixels))), code=1)["refused"], "blank")

    def test_allow_blank_takes_it_on_purpose(self) -> None:
        res = self.add(str(self.source("matte.png", flat(8, 8, (0, 0, 0, 255)))), "--allow-blank")
        self.assertEqual(res["path"], "assets/matte.png")

    def test_a_dry_run_reports_the_refusal_and_writes_nothing(self) -> None:
        proc = self.kb(["assets", "add", str(self.source("clear.png", flat(8, 8, (0, 0, 0, 0)))), "--dry-run", "--json"], cwd=self.root)
        self.assertExit(proc, 1)
        self.assertEqual(sorted(p.name for p in (self.root / "assets").iterdir()), ["logo.png"])

    def test_plan_lists_add_folder(self) -> None:
        (self.outside / "kit").mkdir()
        self.source("kit/a.png", png_bytes())
        proc = self.kb(["plan", "assets", "add-folder", str(self.outside / "kit"), "--json"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertEqual([w["path"] for w in json.loads(proc.stdout)["writes"]], ["assets/a.png"])


@unittest.skipUnless(DARWIN, "needs macOS's sips")
class ConvertTests(ImportCase):
    def test_max_size_caps_the_long_edge_and_records_it(self) -> None:
        big = png([[((x * 9) % 255, (y * 7) % 255, 40, 255) for x in range(400)] for y in range(200)])
        res = self.add(str(self.source("big.png", big)), "--max-size", "100")
        self.assertEqual((res["image"]["width"], res["image"]["height"]), (100, 50))
        record = read_json(self.root / "assets" / "_meta.json")["assets"]["assets/big.png"]
        self.assertEqual(record["transforms"], [{"op": "resize", "longEdge": 100}])
        self.assertEqual(record["origin"]["sourceName"], "big.png")
        again = self.add(str(self.outside / "big.png"), "--max-size", "100")
        self.assertEqual((again["path"], again["copied"]), ("assets/big.png", False))

    def test_max_size_never_scales_up(self) -> None:
        src = self.source("small.png", png_bytes(8, 8))
        res = self.add(str(src), "--max-size", "4096")
        self.assertEqual((res["image"]["width"], res["transforms"]), (8, []))
        self.assertEqual((self.root / "assets" / "small.png").read_bytes(), src.read_bytes())

    def test_max_size_is_for_images_and_in_range(self) -> None:
        self.assertExit(self.kb(["assets", "add", str(self.source("clip.mp4", b"x")), "--max-size", "100"], cwd=self.root), 2)
        self.assertExit(self.kb(["assets", "add", str(self.source("a.png", png_bytes())), "--max-size", "1"], cwd=self.root), 2)

    def test_a_p3_png_comes_in_as_srgb_pixels(self) -> None:
        import subprocess

        src = self.source("shot.png", png([[(200, (x * 11) % 255, 40, 255) for x in range(64)] for _ in range(32)]))
        tagged = self.outside / "tagged.png"
        subprocess.run([imagefile.SIPS, "--matchTo", "/System/Library/ColorSync/Profiles/Display P3.icc", str(src), "--out", str(tagged)], check=True, capture_output=True)
        self.assertEqual(imagefile.needs_conform(imagefile.facts(tagged)), ["colour-profile"])
        res = self.add(str(tagged))
        self.assertTrue(res["conformed"])
        self.assertEqual(res["probe"]["why"], ["colour-profile"])
        self.assertEqual(imagefile.needs_conform(imagefile.facts(self.root / res["path"])), [])
        self.assertEqual(read_json(self.root / "assets" / "_meta.json")["assets"][res["path"]]["transforms"][0]["to"], "srgb")
        plain = self.add(str(tagged), "--no-conform", "--name", "as-it-is")
        self.assertFalse(plain["conformed"])
        self.assertTrue(any("will draw wrong" in w for w in plain["warnings"]), plain["warnings"])

    def test_a_webp_that_has_to_change_becomes_a_png(self) -> None:
        res = self.add(str(self.source("a.webp", TINY_WEBP)), "--allow-blank")
        self.assertEqual(res["path"], "assets/a.webp")

    def test_a_blank_result_of_a_resize_is_refused(self) -> None:
        self.assertEqual(self.add(str(self.source("clear.png", flat(400, 400, (0, 0, 0, 0)))), "--max-size", "100", code=1)["refused"], "blank")


class SvgSanitiseTests(unittest.TestCase):
    def clean(self, svg: str) -> Tuple[str, Dict[str, int]]:
        data, dropped = svgsafe.sanitise(svg.encode("utf-8"), "a.svg")
        return data.decode("utf-8"), dropped

    def test_a_plain_drawing_survives(self) -> None:
        out, dropped = self.clean('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect width="2" height="2" fill="url(#g)"/><text>Hi &amp; bye</text></svg>')
        self.assertEqual(dropped, {})
        for piece in ("<rect", 'fill="url(#g)"', "<linearGradient", "Hi &amp; bye"):
            self.assertIn(piece, out)

    def test_scripts_and_handlers_are_gone(self) -> None:
        out, dropped = self.clean('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><rect onclick="x()" width="1" height="1"/><foreignObject><div/></foreignObject></svg>')
        for piece in ("script", "onload", "onclick", "foreignObject", "alert"):
            self.assertNotIn(piece, out)
        self.assertTrue(dropped)

    def test_nothing_reaches_outside_the_file(self) -> None:
        cases = [
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="file:///etc/passwd" width="9" height="9"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png" width="9" height="9"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><use href="other.svg#a"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(http://example.com/x)" width="1" height="1"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(file:///x)" width="1" height="1"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(http://example.com/a.css);</style><rect width="1" height="1"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face { src: url(file:///x.ttf) }</style></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><filter><feImage href="file:///x.png"/></filter></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,PHN2Zy8+" width="1" height="1"/></svg>',
        ]
        for svg in cases:
            out, dropped = self.clean(svg)
            self.assertTrue(dropped, svg)
            for piece in ("file:", "http://example", "https://", "other.svg", "@import", "svg+xml"):
                self.assertNotIn(piece, out, svg)

    def test_an_embedded_raster_and_internal_references_stay(self) -> None:
        out, dropped = self.clean('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><g id="a"/></defs><use xlink:href="#a"/><image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/></svg>')
        self.assertEqual(dropped, {})
        self.assertIn("#a", out)
        self.assertIn("data:image/png", out)

    def test_a_plain_doctype_is_dropped_and_harmless_metadata_goes_quietly(self) -> None:
        out, dropped = self.clean('<?xml version="1.0"?><?xml-stylesheet href="http://example.com/a.css"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg"><metadata><x/></metadata><rect width="1" height="1"/></svg>')
        self.assertEqual(dropped, {})
        self.assertNotIn("DOCTYPE", out)
        self.assertNotIn("example.com", out)

    def test_an_illustrator_style_internal_entity_still_reads(self) -> None:
        out, _ = self.clean('<!DOCTYPE svg [<!ENTITY ns_svg "http://www.w3.org/2000/svg">]><svg xmlns="&ns_svg;"><rect width="1" height="1"/></svg>')
        self.assertIn("<rect", out)

    def assert_refused(self, svg: bytes, word: str) -> None:
        with self.assertRaises(imagefile.Refused) as caught:
            svgsafe.sanitise(svg, "a.svg")
        self.assertIn(word, caught.exception.message)

    def test_external_entities_and_entity_bombs_are_refused(self) -> None:
        self.assert_refused(b'<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>', "reaches outside")
        self.assert_refused(b'<!DOCTYPE svg [<!ENTITY % p SYSTEM "http://example.com/x">%p;]><svg xmlns="http://www.w3.org/2000/svg"/>', "reaches outside")
        self.assert_refused(b'<!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg"><text>&b;</text></svg>', "nested")

    def test_what_isnt_an_svg_is_refused(self) -> None:
        self.assert_refused(b"<html><body/></html>", "root")
        self.assert_refused(b"<svg", "well-formed")
        self.assert_refused(b"not xml at all", "well-formed")
        self.assert_refused(b'<svg xmlns="http://www.w3.org/2000/svg">' + b"<g>" * 300 + b"</g>" * 300 + b"</svg>", "deeply")
        with self.assertRaises(imagefile.Refused) as caught:
            svgsafe.sanitise(b"<svg>" + b" " * (svgsafe.MAX_BYTES + 1) + b"</svg>", "a.svg")
        self.assertEqual(caught.exception.code, "too-large")


@unittest.skipUnless(DARWIN, "needs macOS's osascript and sips")
class SvgImportTests(ImportCase):
    def test_an_svg_lands_as_a_png_through_the_brand_rasteriser(self) -> None:
        res = self.add(str(self.source("Logo Mark.svg", GOOD_SVG)), "--name", "mark", "--max-size", "128")
        self.assertEqual((res["path"], res["image"]["format"], max(res["image"]["width"], res["image"]["height"])), ("assets/mark.png", "png", 128))
        self.assertFalse((self.root / "assets" / "mark.svg").exists())
        self.assertEqual(read_json(self.root / "assets" / "_meta.json")["assets"]["assets/mark.png"]["transforms"], [{"op": "rasterise", "longEdge": 128}])
        again = self.add(str(self.outside / "Logo Mark.svg"), "--name", "mark", "--max-size", "128")
        self.assertEqual((again["path"], again["copied"]), ("assets/mark.png", False))

    def test_a_file_reference_never_reaches_the_raster(self) -> None:
        secret = self.source("secret.png", png([[(255, 0, 0, 255), (0, 255, 0, 255)], [(0, 0, 255, 255), (9, 9, 9, 255)]]))
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64"><image xlink:href="file://{secret}" width="64" height="64"/></svg>'
        res = self.add(str(self.source("sneaky.svg", svg.encode("utf-8"))), code=1)
        self.assertEqual(res["refused"], "blank", "with the image gone nothing is left to draw")

    def test_a_scripted_svg_keeps_only_its_drawing(self) -> None:
        svg = GOOD_SVG.replace(b"<rect", b'<script>alert(1)</script><rect onload="x()"')
        res = self.add(str(self.source("scripted.svg", svg)), "--max-size", "64")
        self.assertEqual(res["path"], "assets/scripted.png")
        self.assertTrue(any("left out" in w for w in res["warnings"]), res["warnings"])

    def test_a_blank_svg_is_refused(self) -> None:
        self.assertEqual(self.add(str(self.source("empty.svg", b'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')), code=1)["refused"], "blank")

    def test_an_svg_named_png_is_treated_as_an_svg(self) -> None:
        self.assertEqual(self.add(str(self.source("named.png", GOOD_SVG)), "--max-size", "64")["path"], "assets/named.png")


class DeepProbeTests(ImportCase):
    def fake_video(self, name: str, *, static_why: Optional[List[str]] = None, deep_mismatch: bool = False) -> Path:
        path = self.outside / name
        path.write_bytes(json.dumps({"fakeRender": True, "frames": 60, "durationMs": 1000, "width": 320, "height": 240, "fps": 30}).encode())
        report = {"ffmpeg": {"container": "mov", "vfr": False, "bframes": 0, "discardedPackets": 0}, "avfoundation": {"codec": "avc1", "durationMs": 1000, "editList": []},
                  "verdict": "ok", "reasons": list(static_why or []), "conform": {"recommended": bool(static_why), "why": list(static_why or []), "refused": None}}
        write_json(Path(str(path) + ".media.json"), report)
        if deep_mismatch:
            write_json(Path(str(path) + ".media-pts.json"), dict(report, verdict="ffmpeg-misdecodes", reasons=["count-mismatch"], conform={"recommended": True, "why": ["decoders"], "refused": None}))
        return path

    def test_a_clip_the_static_probe_passes_is_decoded_and_then_conformed(self) -> None:
        self.fake_cli(caps=MEDIA, log=self.log)
        res = self.add(str(self.fake_video("looks-fine.mp4", deep_mismatch=True)))
        self.assertEqual((res["path"], res["conformed"]), ("assets/looks-fine.mp4", True))
        self.assertEqual(res["probe"]["why"], ["decoders"])
        self.assertEqual(res["probe"]["verdict"], "ffmpeg-misdecodes")
        calls = [json.loads(x) for x in self.log.read_text().splitlines()]
        self.assertTrue(any("--pts" in c for c in calls), calls)
        self.assertTrue((self.root / "assets" / ".originals" / "looks-fine.mp4").is_file())

    def test_a_static_verdict_saves_the_decode(self) -> None:
        self.fake_cli(caps=MEDIA, log=self.log)
        res = self.add(str(self.fake_video("flagged.mov", static_why=["vfr"])))
        self.assertTrue(res["conformed"])
        self.assertFalse(any("--pts" in c for c in (json.loads(x) for x in self.log.read_text().splitlines())))

    def test_a_deep_probe_that_fails_says_the_clip_wasnt_checked(self) -> None:
        self.fake_cli(caps=MEDIA, log=self.log, fail="media-probe-pts")
        res = self.add(str(self.fake_video("flaky.mp4")))
        self.assertEqual((res["conformed"], res["checked"]), (False, False))
        self.assertTrue(any("not checked" in w and "deep probe" in w for w in res["warnings"]), res["warnings"])

    def test_an_identical_file_that_only_looks_conformed_is_flagged_not_skipped(self) -> None:
        self.fake_cli(caps=MEDIA, log=self.log)
        src = self.fake_video("rec.mp4", deep_mismatch=True)
        (self.root / "assets" / "rec.mp4").write_bytes(src.read_bytes())
        res = self.add(str(src))
        self.assertEqual((res["path"], res["copied"], res["checked"]), ("assets/rec.mp4", False, True))
        self.assertTrue(any("only looks conformed" in w and "./kb assets conform" in w for w in res["warnings"]), res["warnings"])

    def test_a_timing_record_without_its_clip_isnt_called_conformed(self) -> None:
        self.fake_cli(caps=MEDIA, log=self.log)
        src = self.fake_video("rec.mov", static_why=["vfr"])
        first = self.add(str(src))
        self.assertEqual(first["path"], "assets/rec.mp4")
        (self.root / "assets" / "rec.mp4").unlink()
        again = self.add(str(src))
        self.assertTrue(again["copied"])
        self.assertTrue((self.root / again["path"]).is_file())


class FolderTests(ImportCase):
    def kit(self) -> Path:
        folder = self.outside / "launch kit"
        (folder / "Logos").mkdir(parents=True, exist_ok=True)
        (folder / "Screens").mkdir(exist_ok=True)
        (folder / "Logos" / "Mark Final (1).PNG").write_bytes(png_bytes(4, 4))
        (folder / "Screens" / "Home_Tab.png").write_bytes(png_bytes(6, 4))
        (folder / "Screens" / "notes.txt").write_text("not media")
        return folder

    def test_a_folder_lands_with_its_shape_under_clean_names(self) -> None:
        res = self.folder(str(self.kit()), "--dir", "launch")
        self.assertEqual(sorted(i["path"] for i in res["items"]), ["assets/launch/logos/mark-final-1.png", "assets/launch/screens/home-tab.png"])
        self.assertEqual((res["copied"], res["otherFiles"]), (2, 1))
        self.assertTrue((self.root / "assets" / "launch" / "screens" / "home-tab.png").is_file())

    def test_reads_outside_the_workspace_are_announced_once(self) -> None:
        away = Path(tempfile.mkdtemp(prefix="kbtest-away-"))
        self.addCleanup(shutil.rmtree, str(away), True)
        for name in ("a.png", "b.png"):
            (away / name).write_bytes(png_bytes(4, 4 + len(name)))
        (away / "b.png").write_bytes(png_bytes(5, 5))
        proc = self.kb(["assets", "add-folder", str(away)], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertEqual(proc.stderr.count("from outside the workspace"), 1, proc.stderr)
        self.assertIn("a folder", proc.stderr)

    def test_credentials_and_the_projects_own_tree_are_refused(self) -> None:
        denied = self.kb(["assets", "add-folder", "~/.ssh"], cwd=self.root)
        self.assertExit(denied, 2)
        self.assertIn("is not read", denied.stderr)
        self.assertExit(self.kb(["assets", "add-folder", str(self.root)], cwd=self.root), 2)
        self.assertExit(self.kb(["assets", "add-folder", str(self.root / "assets")], cwd=self.root), 2)
        self.assertExit(self.kb(["assets", "add-folder", str(self.tmp)], cwd=self.root), 2)
        self.assertExit(self.kb(["assets", "add-folder", str(self.kit() / "Logos" / "Mark Final (1).PNG")], cwd=self.root), 2)

    def test_links_are_never_followed_in_or_out(self) -> None:
        folder = self.kit()
        target = self.source("elsewhere/secret.png", png_bytes(3, 3))
        os.symlink(target, folder / "link.png")
        os.symlink(target.parent, folder / "linked-dir")
        os.symlink(folder / "Logos" / "Mark Final (1).PNG", folder / "inside-link.png")
        res = self.folder(str(folder))
        self.assertEqual(sorted(s["file"] for s in res["skipped"]), ["inside-link.png", "link.png", "linked-dir"])
        self.assertFalse(any("secret" in i["path"] or "link" in i["path"] for i in res["items"]))

    def test_hidden_and_credential_names_are_left_alone(self) -> None:
        folder = self.kit()
        (folder / ".DS_Store").write_bytes(b"x")
        (folder / ".hidden").mkdir()
        (folder / ".hidden" / "x.png").write_bytes(png_bytes())
        (folder / "__MACOSX").mkdir()
        (folder / "__MACOSX" / "y.png").write_bytes(png_bytes())
        (folder / "server.key").write_bytes(b"x")
        res = self.folder(str(folder))
        self.assertEqual(len(res["items"]), 2)
        self.assertEqual([s["file"] for s in res["skipped"]], ["server.key"])

    def test_one_bad_file_doesnt_stop_the_rest_and_a_rerun_lands_nothing_twice(self) -> None:
        folder = self.kit()
        (folder / "broken.png").write_bytes(b"nope")
        (folder / "blank.png").write_bytes(flat(16, 16, (0, 0, 0, 0)))
        res = self.folder(str(folder), code=1)
        self.assertEqual(res["code"], "invalid")
        self.assertEqual(sorted((r["file"], r["code"]) for r in res["refused"]), [("blank.png", "blank"), ("broken.png", "unreadable")])
        self.assertEqual(res["copied"], 2)
        (folder / "broken.png").unlink()
        (folder / "blank.png").unlink()
        again = self.folder(str(folder))
        self.assertEqual((again["copied"], [i["copied"] for i in again["items"]]), (0, [False, False]))

    def test_dedupe_lands_the_same_bytes_once(self) -> None:
        folder = self.kit()
        same = (folder / "Logos" / "Mark Final (1).PNG").read_bytes()
        (folder / "Logos" / "mark-copy.png").write_bytes(same)
        existing = png_bytes(9, 2)
        (self.root / "assets" / "already.png").write_bytes(existing)
        (folder / "same-as-asset.png").write_bytes(existing)
        res = self.folder(str(folder), "--dedupe")
        self.assertEqual(sorted(d["file"] for d in res["duplicates"]), ["Logos/mark-copy.png", "same-as-asset.png"])
        self.assertEqual([d["of"] for d in res["duplicates"] if d["file"] == "same-as-asset.png"], ["assets/already.png"])
        without = self.folder(str(folder))
        self.assertTrue(any("mark-copy" in i["path"] for i in without["items"]))

    def test_limit_takes_the_first_files_and_says_what_is_left(self) -> None:
        res = self.folder(str(self.kit()), "--limit", "1")
        self.assertEqual((len(res["items"]), res["remaining"]), (1, 1))
        self.assertExit(self.kb(["assets", "add-folder", str(self.kit()), "--limit", "0"], cwd=self.root), 2)
        self.assertExit(self.kb(["assets", "add-folder", str(self.kit()), "--limit", str(asset_folder.MAX_LIMIT + 1)], cwd=self.root), 2)

    def test_too_many_files_stop_before_anything_copies(self) -> None:
        folder = self.outside / "many"
        folder.mkdir()
        for i in range(asset_folder.DEFAULT_LIMIT + 1):
            (folder / f"f{i}.png").write_bytes(b"x")
        res = self.folder(str(folder), code=1)
        self.assertEqual(res["code"], "too-large")
        self.assertIn("--limit", res["hint"])
        self.assertEqual(sorted(p.name for p in (self.root / "assets").iterdir()), ["logo.png"])

    def test_scan_stops_at_its_depth_cap(self) -> None:
        deep = self.outside / "deep"
        current = deep
        for i in range(asset_folder.MAX_DEPTH + 2):
            current = current / f"d{i}"
        current.mkdir(parents=True)
        res = self.folder(str(deep), code=1)
        self.assertEqual(res["code"], "too-large")

    def test_a_file_over_the_image_cap_is_refused_alone(self) -> None:
        folder = self.kit()
        with open(folder / "huge.png", "wb") as f:
            f.write(png_bytes())
            f.truncate(imagefile.MAX_BYTES + 1)
        res = self.folder(str(folder), code=1)
        self.assertEqual([(r["file"], r["code"]) for r in res["refused"]], [("huge.png", "too-large")])
        self.assertEqual(res["copied"], 2)

    def test_thumbs_land_in_kb_and_never_in_assets(self) -> None:
        res = self.folder(str(self.kit()), "--thumbs", "64x48")
        sheets = res["thumbs"]["sheets"]
        self.assertEqual(len(sheets), 1)
        self.assertIn("/.kb/thumbs/", sheets[0])
        f = imagefile.facts(Path(sheets[0]))
        self.assertEqual(f["format"], "png")
        self.assertIsNone(imagefile.look(Path(sheets[0]))["blank"])
        self.assertFalse(any("thumb" in str(p) for p in (self.root / "assets").rglob("*")))

    def test_thumbs_size_is_checked(self) -> None:
        for bad in ("big", "0x10", "99999x10", "10"):
            self.assertExit(self.kb(["assets", "add-folder", str(self.kit()), "--thumbs", bad], cwd=self.root), 2)

    def test_a_dry_run_writes_nothing(self) -> None:
        proc = self.kb(["assets", "add-folder", str(self.kit()), "--thumbs", "64x48", "--dry-run", "--json"], cwd=self.root)
        self.assertExit(proc, 0)
        res = json.loads(proc.stdout)
        self.assertEqual(len(res["writes"]), 2)
        self.assertEqual(sorted(p.name for p in (self.root / "assets").iterdir()), ["logo.png"])

    def test_slugs_keep_any_script(self) -> None:
        self.assertEqual(asset_folder.slug("Häfen Grün_1"), "häfen-grün-1")
        self.assertEqual(asset_folder.slug("   "), "")

    @unittest.skipUnless(DARWIN, "needs macOS's osascript and sips")
    def test_svgs_in_a_folder_rasterise_and_dedupe_on_a_rerun(self) -> None:
        folder = self.kit()
        (folder / "Icons").mkdir()
        (folder / "Icons" / "Wallet.svg").write_bytes(GOOD_SVG)
        (folder / "Icons" / "Bad.svg").write_bytes(b"<svg")
        (folder / "Icons" / "Empty.svg").write_bytes(b'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')
        res = self.folder(str(folder), "--max-size", "64", code=1)
        self.assertIn("assets/icons/wallet.png", [i["path"] for i in res["items"]])
        self.assertEqual(sorted((r["file"], r["code"]) for r in res["refused"]), [("Icons/Bad.svg", "unreadable"), ("Icons/Empty.svg", "blank")])
        self.assertEqual(read_json(self.root / "assets" / "_meta.json")["assets"]["assets/icons/wallet.png"]["transforms"], [{"op": "rasterise", "longEdge": 64}])
        again = self.folder(str(folder), "--max-size", "64", "--dedupe", code=1)
        self.assertIn("Icons/Wallet.svg", [d["file"] for d in again["duplicates"]])
