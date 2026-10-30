from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from .helpers import PNG_1x1, KbTestCase, make_project, write_json

BRAND_PY = Path(__file__).resolve().parents[3] / "kookaburra-brand-packs" / "scripts" / "brand.py"
GUIDE = "# Acme brand guidelines\n\nThese are safe defaults and guidance, not hard rules.\n"


class BrandPackTests(KbTestCase):
    """The brand-packs skill's tool builds a brand that checks clean and applies like the Project picker."""

    def brand(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-I", str(BRAND_PY), "--root", str(self.tmp), *args], capture_output=True, text=True, env=self.env)

    def setUp(self) -> None:
        super().setUp()
        write_json(self.tmp / "themes" / "acme-ink" / "theme.json", {"version": 2, "id": "acme-ink", "name": "Acme Ink"})
        write_json(self.tmp / "fonts" / "fonts.json", {"version": 1, "fonts": [{"family": "Acme Sans", "weight": 500, "postscript": "AcmeSans-Medium", "file": "AcmeSans-Medium.ttf", "path": ""}]})
        self.assertEqual(self.brand("init", "acme", "--name", "Acme").returncode, 0)
        self.dir = self.tmp / "brands" / "acme"

    def finish(self) -> None:
        doc = json.loads((self.dir / "brand.json").read_text())
        doc.update({
            "themes": ["ws:acme-ink"],
            "defaultTheme": "ws:acme-ink",
            "typography": {"headline": "Acme Sans@500", "body": "Acme Sans@500"},
            "fonts": [{"family": "Acme Sans", "weight": 500}],
            "colors": [{"name": "Ink", "hex": "#151E29", "role": "primary"}],
        })
        write_json(self.dir / "brand.json", doc)
        (self.dir / "guidelines.md").write_text(GUIDE)

    def test_a_fresh_brand_fails_check_until_its_template_is_filled(self) -> None:
        check = self.brand("check", "acme")
        self.assertEqual(check.returncode, 1)
        self.assertIn("template placeholders", check.stdout)
        self.finish()
        self.assertEqual(self.brand("gradient", "acme", "acme-glow", "--stops", "#000A57@0,#151e29@1", "--angle", "135").returncode, 0)
        check = self.brand("check", "acme")
        self.assertEqual(check.returncode, 0, check.stdout)
        gradient = json.loads((self.tmp / "gradients" / "acme-glow.json").read_text())
        self.assertEqual(gradient["spec"]["stops"], [["#000A57", 0.0], ["#151E29", 1.0]])
        self.assertEqual(json.loads((self.dir / "brand.json").read_text())["gradients"], ["acme-glow"])

    def test_check_names_missing_themes_fonts_and_a_guide_without_the_stance(self) -> None:
        self.finish()
        doc = json.loads((self.dir / "brand.json").read_text())
        doc["themes"].append("ws:acme-gone")
        doc["fonts"].append({"family": "Acme Serif", "weight": 400})
        write_json(self.dir / "brand.json", doc)
        (self.dir / "guidelines.md").write_text("# Acme\n\nAlways do this.\n")
        out = self.brand("check", "acme").stdout
        self.assertIn("theme ws:acme-gone is not in", out)
        self.assertIn("font Acme Serif@400 is not installed", out)
        self.assertIn("guidance, not hard rules", out)

    def test_images_land_in_kebab_case_categories(self) -> None:
        src = self.tmp / "source" / "Logos" / "SVG"
        src.mkdir(parents=True)
        (src / "Acme Logo_White.png").write_bytes(PNG_1x1)
        (src / "Acme Logo_White.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>")
        run = self.brand("images", "acme", f"{self.tmp / 'source' / 'Logos'}=logos/wordmark")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue((self.dir / "images" / "logos" / "wordmark" / "acme-logo-white.png").is_file())
        self.assertTrue((self.dir / "images" / "logos" / "wordmark" / "acme-logo-white.svg").is_file())

    def test_names_that_slugify_alike_never_overwrite(self) -> None:
        src = self.tmp / "source" / "Backgrounds"
        src.mkdir(parents=True)
        for name in ("Hero Wide.png", "hero-wide.png", "hero wide.jpeg", "hero_wide.jpg"):
            (src / name).write_bytes(PNG_1x1 + name.encode())
        self.assertEqual(self.brand("images", "acme", f"{src}=backgrounds").returncode, 0)
        names = sorted(p.name for p in (self.dir / "images" / "backgrounds").iterdir())
        self.assertEqual(names, ["hero-wide-2.png", "hero-wide-3.png", "hero-wide-4.png", "hero-wide.png"], "real format decides the extension")

    def test_apply_and_clear_match_the_project_picker(self) -> None:
        self.finish()
        project = make_project(self.tmp, typography={"chart": "Inter@500"})
        self.assertEqual(self.brand("apply", str(project), "acme").returncode, 0)
        manifest = json.loads((project / "project.json").read_text())
        self.assertEqual(manifest["brand"], "ws:acme")
        self.assertEqual(manifest["themeId"], "ws:acme-ink")
        self.assertEqual(manifest["typography"], {"chart": "Inter@500", "headline": "Acme Sans@500", "body": "Acme Sans@500"})
        self.assertEqual((project / "BRAND.md").read_text(), GUIDE)
        self.assertEqual(self.brand("apply", str(project), "none").returncode, 0)
        manifest = json.loads((project / "project.json").read_text())
        self.assertNotIn("brand", manifest)
        self.assertEqual(manifest["themeId"], "ws:acme-ink")
        self.assertFalse((project / "BRAND.md").exists())
