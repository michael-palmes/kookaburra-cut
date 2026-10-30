"""The brand image library: brand.py's import guards, tags, pairs and copies for scenes, kb brand icons and the kb status hint."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from typing import Any, Dict

from kblib import brandlib, imagefile

from .helpers import KbTestCase, make_project, png_bytes, read_json, write_json
from .test_asset_import import DARWIN, GOOD_SVG, flat, ink_on_clear, png

BRAND_PY = Path(__file__).resolve().parents[3] / "kookaburra-brand-packs" / "scripts" / "brand.py"
GUIDE = "# Acme\n\nThese are safe defaults and guidance, not hard rules.\n"


class LibraryCase(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp, brand="ws:acme")
        self.home = self.tmp / "brands" / "acme"
        (self.home / "images").mkdir(parents=True)
        write_json(self.home / "brand.json", {"version": 1, "name": "Acme"})
        (self.home / "guidelines.md").write_text(GUIDE)
        self.src = self.tmp / "source"
        self.src.mkdir()

    def brand(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-I", str(BRAND_PY), "--root", str(self.tmp), *args], capture_output=True, text=True, env=self.env)

    def image(self, rel: str, data: bytes) -> Path:
        path = self.home / "images" / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def icons(self, *args: str, code: int = 0) -> Any:
        proc = self.kb(["brand", "icons", *args, "--json"], cwd=self.root)
        self.assertExit(proc, code)
        return json.loads(proc.stdout)

    def library(self) -> Dict[str, Any]:
        return read_json(self.home / "library.json")


class ImportGuardTests(LibraryCase):
    def test_blank_and_unreadable_images_stay_out_and_fail_the_command(self) -> None:
        (self.src / "good.png").write_bytes(png_bytes(4, 4))
        (self.src / "clear.png").write_bytes(flat(16, 16, (0, 0, 0, 0)))
        (self.src / "broken.png").write_bytes(b"nope")
        run = self.brand("images", "acme", f"{self.src}=icons")
        self.assertEqual(run.returncode, 1, run.stdout)
        self.assertIn("REFUSED clear.png", run.stdout)
        self.assertIn("REFUSED broken.png", run.stdout)
        self.assertEqual(sorted(p.name for p in (self.home / "images" / "icons").iterdir()), ["good.png"])
        self.assertEqual(list(self.library()["images"]), ["icons/good.png"])

    def test_allow_blank_takes_a_matte_on_purpose(self) -> None:
        (self.src / "matte.png").write_bytes(flat(16, 16, (0, 0, 0, 255)))
        self.assertEqual(self.brand("images", "acme", f"{self.src}=backgrounds", "--allow-blank").returncode, 0)
        self.assertTrue((self.home / "images" / "backgrounds" / "matte.png").is_file())

    def test_links_are_never_followed(self) -> None:
        outside = self.tmp / "elsewhere"
        outside.mkdir()
        (outside / "secret.png").write_bytes(png_bytes(3, 3))
        (self.src / "good.png").write_bytes(png_bytes(4, 4))
        os.symlink(outside / "secret.png", self.src / "link.png")
        os.symlink(outside, self.src / "linked")
        self.assertEqual(self.brand("images", "acme", f"{self.src}=icons").returncode, 0)
        names = [p.name for p in (self.home / "images" / "icons").rglob("*") if p.is_file()]
        self.assertEqual(names, ["good.png"])

    def test_a_credential_folder_is_refused(self) -> None:
        run = self.brand("images", "acme", f"{Path.home() / '.ssh'}=icons")
        self.assertEqual(run.returncode, 1)
        self.assertIn("is not read", run.stderr)

    def test_a_bad_svg_is_refused_and_its_copy_is_sanitised(self) -> None:
        (self.src / "bad.svg").write_bytes(b"<svg")
        hostile = GOOD_SVG.replace(b"<rect", b'<script>alert(1)</script><rect onload="x()"')
        (self.src / "scripted.svg").write_bytes(hostile)
        (self.src / "scripted.png").write_bytes(png_bytes(4, 4))
        run = self.brand("images", "acme", f"{self.src}=icons")
        self.assertEqual(run.returncode, 1, run.stdout)
        self.assertIn("REFUSED bad.svg", run.stdout)
        kept = (self.home / "images" / "icons" / "scripted.svg").read_bytes()
        self.assertNotIn(b"script", kept)
        self.assertNotIn(b"onload", kept)
        self.assertIn(b"<rect", kept)
        self.assertFalse((self.home / "images" / "icons" / "bad.svg").exists())


class TagsAndPairsTests(LibraryCase):
    def test_tags_from_import_and_tag_survive_a_rebuild(self) -> None:
        (self.src / "wallet.png").write_bytes(png_bytes(4, 4))
        (self.src / "card.png").write_bytes(png_bytes(4, 5))
        self.assertEqual(self.brand("images", "acme", f"{self.src}=icons", "--tags", "Payments, Core").returncode, 0)
        self.assertEqual(self.library()["images"]["icons/wallet.png"]["tags"], ["payments", "core"])
        self.assertEqual(self.brand("tag", "acme", "icons/wal*", "money").returncode, 0)
        self.assertEqual(self.brand("tag", "acme", "icons/card.png", "core", "--remove").returncode, 0)
        self.assertEqual(self.brand("library", "acme").returncode, 0)
        images = self.library()["images"]
        self.assertEqual(images["icons/wallet.png"]["tags"], ["payments", "core", "money"])
        self.assertEqual(images["icons/card.png"]["tags"], ["payments"])
        self.assertNotEqual(self.brand("tag", "acme", "nothing/*", "x").returncode, 0)

    def test_light_and_dark_ink_pair_up_by_measuring_the_pixels(self) -> None:
        self.image("logos/acme-dark.png", ink_on_clear(16, 16, (250, 250, 250)))
        self.image("logos/acme-light.png", ink_on_clear(16, 16, (10, 10, 10)))
        self.image("logos/other.png", ink_on_clear(16, 16, (120, 120, 120)))
        self.assertEqual(self.brand("library", "acme").returncode, 0)
        images = self.library()["images"]
        self.assertEqual(images["logos/acme-dark.png"]["surface"], "on-dark")
        self.assertEqual(images["logos/acme-light.png"]["surface"], "on-light")
        self.assertEqual(images["logos/acme-dark.png"]["pair"], "logos/acme-light.png")
        self.assertEqual(images["logos/acme-light.png"]["pair"], "logos/acme-dark.png")
        self.assertNotIn("pair", images["logos/other.png"])

    def test_pairs_can_sit_in_sibling_folders(self) -> None:
        self.image("logos/white/acme.png", ink_on_clear(16, 16, (250, 250, 250)))
        self.image("logos/black/acme.png", ink_on_clear(16, 16, (10, 10, 10)))
        self.assertEqual(self.brand("library", "acme").returncode, 0)
        self.assertEqual(self.library()["images"]["logos/white/acme.png"]["pair"], "logos/black/acme.png")

    def test_an_opaque_picture_falls_back_on_its_name(self) -> None:
        self.image("logos/acme-on-dark.png", png_bytes(8, 8))
        self.image("logos/acme.png", png_bytes(8, 9))
        self.assertEqual(self.brand("library", "acme").returncode, 0)
        images = self.library()["images"]
        self.assertEqual(images["logos/acme-on-dark.png"]["surface"], "on-dark")
        self.assertNotIn("surface", images["logos/acme.png"])

    def test_check_flags_a_stale_library(self) -> None:
        self.image("icons/a.png", png_bytes(4, 4))
        self.assertEqual(self.brand("library", "acme").returncode, 0)
        (self.home / "images" / "icons" / "a.png").unlink()
        self.image("icons/b.png", png_bytes(5, 5))
        out = self.brand("check", "acme").stdout
        self.assertIn("lists 1 images that are gone", out)
        self.assertIn("1 of 1 images indexed", out)


@unittest.skipUnless(DARWIN, "needs macOS's sips")
class SceneCopyTests(LibraryCase):
    def big(self) -> bytes:
        return png([[((x * 3) % 255, (y * 5) % 255, 90, 255) for x in range(300)] for y in range(150)])

    def test_a_large_image_gets_a_size_limited_copy_a_small_one_doesnt(self) -> None:
        self.image("backgrounds/wide.png", self.big())
        self.image("icons/small.png", png_bytes(8, 8))
        self.assertEqual(self.brand("library", "acme", "--scene-edge", "100").returncode, 0)
        images = self.library()["images"]
        self.assertEqual(images["backgrounds/wide.png"]["scene"], "scene/backgrounds/wide.png")
        self.assertNotIn("scene", images["icons/small.png"])
        f = imagefile.facts(self.home / "scene" / "backgrounds" / "wide.png")
        self.assertEqual((f["width"], f["height"]), (100, 50))
        self.assertEqual(imagefile.facts(self.home / "images" / "backgrounds" / "wide.png")["width"], 300)

    def test_the_scene_edge_is_remembered(self) -> None:
        self.image("backgrounds/wide.png", self.big())
        self.assertEqual(self.brand("library", "acme", "--scene-edge", "100").returncode, 0)
        self.assertEqual(self.brand("library", "acme").returncode, 0)
        self.assertEqual(self.library()["sceneEdge"], 100)
        self.assertEqual(self.library()["images"]["backgrounds/wide.png"]["scene"], "scene/backgrounds/wide.png")

    def test_copies_follow_their_image(self) -> None:
        wide = self.image("backgrounds/wide.png", self.big())
        self.assertEqual(self.brand("library", "acme", "--scene-edge", "100").returncode, 0)
        wide.unlink()
        self.assertEqual(self.brand("library", "acme", "--scene-edge", "100").returncode, 0)
        self.assertFalse((self.home / "scene" / "backgrounds" / "wide.png").exists())

    def test_kb_brand_icons_points_at_the_copy(self) -> None:
        self.image("backgrounds/wide.png", self.big())
        self.assertEqual(self.brand("library", "acme", "--scene-edge", "100").returncode, 0)
        item = self.icons("--all")["items"][0]
        self.assertTrue(item["path"].endswith("scene/backgrounds/wide.png"))
        self.assertTrue(item["original"].endswith("images/backgrounds/wide.png"))

    @unittest.skipUnless(DARWIN, "needs macOS's osascript")
    def test_an_svg_rasterises_at_its_edge_into_the_library(self) -> None:
        (self.src / "wallet.svg").write_bytes(GOOD_SVG)
        run = self.brand("images", "acme", f"{self.src}=icons", "--edge", "64")
        self.assertEqual(run.returncode, 0, run.stdout)
        self.assertEqual(max(imagefile.facts(self.home / "images" / "icons" / "wallet.png")["width"], imagefile.facts(self.home / "images" / "icons" / "wallet.png")["height"]), 64)
        self.assertIn("icons/wallet.png", self.library()["images"])
        self.assertTrue((self.home / "images" / "icons" / "wallet.svg").is_file())


class IconsCommandTests(LibraryCase):
    def seed(self) -> None:
        self.image("icons/wallet.png", png_bytes(4, 4))
        self.image("icons/wallet-white.png", png_bytes(4, 5))
        self.image("icons/credit-card.png", png_bytes(5, 4))
        self.image("logos/acme.png", png_bytes(6, 4))

    def test_search_finds_by_name_and_ranks_the_name_first(self) -> None:
        self.seed()
        self.assertEqual(self.brand("tag", "acme", "*", "x").returncode, 1)
        self.assertEqual(self.brand("library", "acme").returncode, 0)
        self.assertEqual(self.brand("tag", "acme", "icons/credit-card.png", "wallet-alternative").returncode, 0)
        res = self.icons("--search", "wallet")
        self.assertEqual([i["rel"] for i in res["items"]], ["icons/wallet.png", "icons/wallet-white.png", "icons/credit-card.png"])

    def test_every_word_must_match_and_partial_words_count(self) -> None:
        self.seed()
        self.assertEqual([i["rel"] for i in self.icons("--search", "wall whi")["items"]], ["icons/wallet-white.png"])
        self.assertEqual(self.icons("--search", "wallet nothing")["items"], [])

    def test_a_brand_with_no_library_still_lists_and_pairs_by_name(self) -> None:
        self.seed()
        self.image("icons/wallet-black.png", png_bytes(5, 5))
        rows = {i["rel"]: i for i in self.icons()["items"]}
        self.assertEqual(rows["icons/wallet-white.png"]["surface"], "on-dark")
        self.assertEqual(rows["icons/wallet-white.png"]["pair"], "icons/wallet-black.png")
        self.assertNotIn("logos/acme.png", rows, "only the icon folders by default")

    def test_scope_flags(self) -> None:
        self.seed()
        self.assertEqual([i["rel"] for i in self.icons("--category", "logos")["items"]], ["logos/acme.png"])
        self.assertEqual(len(self.icons("--all")["items"]), 4)
        self.assertEqual(len(self.icons("--limit", "1")["items"]), 1)
        self.assertEqual(self.icons("--limit", "1")["total"], 3)

    def test_a_brand_with_no_icon_folder_shows_everything(self) -> None:
        self.image("logos/acme.png", png_bytes(6, 4))
        self.assertEqual([i["rel"] for i in self.icons()["items"]], ["logos/acme.png"])

    def test_it_needs_a_brand(self) -> None:
        manifest = read_json(self.root / "project.json")
        del manifest["brand"]
        write_json(self.root / "project.json", manifest)
        self.assertExit(self.kb(["brand", "icons"], cwd=self.root), 2)
        self.image("icons/a.png", png_bytes(4, 4))
        self.assertEqual(len(self.icons("--brand", "acme")["items"]), 1)

    def test_a_contact_sheet_lands_in_kb_and_is_a_real_picture(self) -> None:
        self.seed()
        res = self.icons("--search", "wallet", "--sheet", "--cell", "64")
        sheets = res["sheets"]
        self.assertEqual(len(sheets), 1)
        self.assertIn("/.kb/thumbs/", sheets[0])
        self.assertIsNone(imagefile.look(Path(sheets[0]))["blank"])
        proc = self.kb(["brand", "icons", "--search", "wallet", "--sheet"], cwd=self.root)
        self.assertIn("sheet to Read:", proc.stdout)
        self.assertIn('./kb assets add "', proc.stdout)

    def test_a_large_set_spills_to_more_sheets_and_stops_at_the_cap(self) -> None:
        for i in range(60):
            self.image(f"icons/i{i:03d}.png", png_bytes(4, 4))
        res = self.icons("--sheet", "--cell", "400")
        self.assertGreater(len(res["sheets"]), 1)
        self.assertEqual(res["shownOnSheets"], 54)
        self.assertLessEqual(len(res["sheets"]), 6)

    def test_nothing_found_says_so(self) -> None:
        self.seed()
        proc = self.kb(["brand", "icons", "--search", "zebra", "--sheet"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("nothing in Acme's library matches", proc.stdout)

    def test_an_untrusted_library_cant_point_outside_the_brand(self) -> None:
        self.image("icons/a.png", png_bytes(4, 4))
        write_json(self.home / "library.json", {"version": 1, "images": {
            "icons/a.png": {"scene": "../../../secret.png", "pair": "../x.png", "tags": ["ok", 7, "x" * 500], "surface": "nonsense", "width": -1},
            "../../escape.png": {"tags": ["bad"]},
            "icons/b.png": "not an object",
        }})
        item = self.icons("--all")["items"][0]
        self.assertTrue(item["path"].endswith("images/icons/a.png"))
        self.assertIsNone(item["pair"])
        self.assertIsNone(item["surface"])
        self.assertIsNone(item["width"])
        self.assertEqual(item["tags"], ["ok", "x" * brandlib.MAX_TAG_CHARS])
        self.assertEqual(sorted(brandlib.read_library(self.home)["images"]), ["icons/a.png"])

    def test_a_link_in_the_library_is_passed_over(self) -> None:
        outside = self.tmp / "elsewhere.png"
        outside.write_bytes(png_bytes())
        self.image("icons/a.png", png_bytes(4, 4))
        os.symlink(outside, self.home / "images" / "icons" / "link.png")
        self.assertEqual([i["rel"] for i in self.icons()["items"]], ["icons/a.png"])
        (self.home / "scene").mkdir()
        os.symlink(outside, self.home / "scene" / "a.png")
        write_json(self.home / "library.json", {"version": 1, "images": {"icons/a.png": {"scene": "scene/a.png"}}})
        self.assertTrue(self.icons()["items"][0]["path"].endswith("images/icons/a.png"))


class StatusHintTests(LibraryCase):
    def test_status_and_context_name_the_library(self) -> None:
        self.image("icons/a.png", png_bytes(4, 4))
        self.image("icons/b.png", png_bytes(4, 5))
        self.image("logos/c.png", png_bytes(4, 6))
        text = self.kb(["status"], cwd=self.root).stdout
        self.assertIn("its library has 2 icons, 1 logos: ./kb brand icons --search TERM --sheet", text)
        self.assertIn("kb brand icons", self.kb(["context"], cwd=self.root).stdout)

    def test_a_brand_with_no_images_gets_no_hint(self) -> None:
        self.assertNotIn("kb brand icons", self.kb(["status"], cwd=self.root).stdout)

    def test_status_json_counts_the_library(self) -> None:
        self.image("icons/a.png", png_bytes(4, 4))
        data = json.loads(self.kb(["status", "--json"], cwd=self.root).stdout)
        self.assertEqual(data["brandImages"], {"icons": 1})

    def test_a_brand_id_that_climbs_out_is_never_walked(self) -> None:
        elsewhere = self.tmp / "elsewhere" / "images" / "secret-folder"
        elsewhere.mkdir(parents=True)
        (elsewhere / "a.png").write_bytes(png_bytes())
        manifest = read_json(self.root / "project.json")
        manifest["brand"] = "ws:../../elsewhere"
        write_json(self.root / "project.json", manifest)
        self.assertNotIn("secret-folder", self.kb(["status"], cwd=self.root).stdout)
        self.assertIsNone(json.loads(self.kb(["status", "--json"], cwd=self.root).stdout)["brandImages"])

    def test_a_missing_brand_folder_gets_no_hint(self) -> None:
        manifest = read_json(self.root / "project.json")
        manifest["brand"] = "ws:gone"
        write_json(self.root / "project.json", manifest)
        self.assertNotIn("kb brand icons", self.kb(["status"], cwd=self.root).stdout)
