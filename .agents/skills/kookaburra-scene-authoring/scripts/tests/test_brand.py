from __future__ import annotations

import json

from .helpers import KbTestCase, make_project, write_json

GUIDE = "# Acme brand guidelines\n\nSafe defaults and guidance, not hard rules.\n"


class KbBrandTests(KbTestCase):
    """kb brand applies an installed brand the way the Project picker does, matched from the user's words."""

    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp, typography={"chart": "Inter@500"})
        write_json(self.tmp / "themes" / "acme-ink" / "theme.json", {"version": 2, "id": "acme-ink"})
        write_json(self.tmp / "brands" / "acme-co" / "brand.json", {
            "version": 1,
            "name": "Acme Co",
            "defaultTheme": "ws:acme-ink",
            "themes": ["ws:acme-ink"],
            "typography": {"headline": "Inter@700", "body": "Inter@400"},
            "colors": [{"name": "Ink", "hex": "#151E29", "role": "primary", "note": "Default background."}],
        })
        (self.tmp / "brands" / "acme-co" / "guidelines.md").write_text(GUIDE)
        (self.tmp / "brands" / "acme-co" / "images" / "logos").mkdir(parents=True)
        (self.tmp / "brands" / "acme-co" / "images" / "logos" / "mark.png").write_bytes(b"png")

    def manifest(self):
        return json.loads((self.root / "project.json").read_text())

    def test_use_by_name_applies_theme_fonts_and_guidelines(self) -> None:
        run = self.kb(["brand", "use", "acme co"], cwd=self.root)
        self.assertExit(run, 0)
        m = self.manifest()
        self.assertEqual((m["brand"], m["themeId"]), ("ws:acme-co", "ws:acme-ink"))
        self.assertEqual(m["typography"], {"chart": "Inter@500", "headline": "Inter@700", "body": "Inter@400"})
        self.assertEqual((self.root / "BRAND.md").read_text(), GUIDE)
        self.assertIn("wrote BRAND.md", run.stdout)
        self.assertIn("not hard rules", run.stdout)
        self.assertNotIn("BRAND.md is missing", run.stdout + run.stderr)

    def test_the_users_own_phrasing_names_the_brand(self) -> None:
        for phrase in ("the Acme Co brand", "our acme-co brand pack", "ACME CO"):
            with self.subTest(phrase=phrase):
                self.assertExit(self.kb(["brand", "use", phrase], cwd=self.root), 0)
                self.assertEqual(self.manifest()["brand"], "ws:acme-co")

    def test_clear_keeps_theme_and_fonts(self) -> None:
        self.assertExit(self.kb(["brand", "use", "ws:acme-co"], cwd=self.root), 0)
        self.assertExit(self.kb(["brand", "clear"], cwd=self.root), 0)
        m = self.manifest()
        self.assertNotIn("brand", m)
        self.assertEqual(m["themeId"], "ws:acme-ink")
        self.assertFalse((self.root / "BRAND.md").exists())

    def test_an_unknown_brand_names_the_installed_ones(self) -> None:
        run = self.kb(["brand", "use", "globex"], cwd=self.root)
        self.assertExit(run, 2)
        self.assertIn("Acme Co (ws:acme-co)", run.stdout + run.stderr)
        self.assertNotIn("brand", self.manifest())

    def test_list_show_and_context_point_at_installed_brands(self) -> None:
        self.assertIn("ws:acme-co  Acme Co", self.kb(["brand", "list"], cwd=self.root).stdout)
        show = self.kb(["brand", "show", "acme"], cwd=self.root).stdout
        self.assertIn("colour #151E29 Ink (primary): Default background.", show)
        self.assertIn("images: logos 1", show)
        context = self.kb(["context"], cwd=self.root).stdout
        self.assertIn("Brand: none. Installed: Acme Co (ws:acme-co)", context)
        self.assertIn("kb brand use <name>", context)

    def test_check_warns_on_a_missing_brand_or_guide(self) -> None:
        self.assertExit(self.kb(["brand", "use", "acme-co"], cwd=self.root), 0)
        (self.root / "BRAND.md").unlink()
        self.assertIn("BRAND.md is missing", self.kb(["check"], cwd=self.root).stdout)
        m = self.manifest()
        m["brand"] = "ws:gone"
        write_json(self.root / "project.json", m)
        self.assertIn("ws:gone is not in this workspace's brands/", self.kb(["check"], cwd=self.root).stdout)
