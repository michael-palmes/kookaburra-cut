from __future__ import annotations

import json

from kblib import catalog, fonts

from .helpers import KbTestCase


class FontVerdictTests(KbTestCase):
    def cat(self) -> catalog.Catalog:
        return catalog.load_catalog()

    def test_parse_ref_mirrors_parse_font_string(self) -> None:
        self.assertEqual(fonts.parse_ref("Inter@600"), ("Inter", 600))
        self.assertEqual(fonts.parse_ref("Avenir Next"), ("Avenir Next", 400))
        self.assertEqual(fonts.parse_ref("Weird@bold"), ("Weird@bold", 400))
        self.assertEqual(fonts.parse_ref("Big@2000"), ("Big@2000", 400))
        self.assertEqual(fonts.parse_ref("@600"), ("@600", 400))

    def test_bundled_is_safe(self) -> None:
        self.assertIsNone(fonts.static_verdict("Inter@600", self.cat(), {}).severity)
        self.assertIsNone(fonts.static_verdict("JetBrains Mono", self.cat(), {}).severity)

    def test_bundled_missing_weight_warns_with_rendered_weight(self) -> None:
        v = fonts.static_verdict("Inter@700", self.cat(), {})
        self.assertEqual(v.severity, "warning")
        self.assertIn("Inter@600", v.message)

    def test_system_faces_are_unvetted_warnings_not_errors(self) -> None:
        for ref in ("Menlo@400", "SF Mono", "Helvetica Neue@500", "Futura@500"):
            v = fonts.static_verdict(ref, self.cat(), {})
            self.assertEqual(v.severity, "warning", ref)
            self.assertIn("not vetted yet", v.message)
            self.assertIn(f'kb fonts check "{ref}"', v.message)

    def test_futura_has_no_400(self) -> None:
        v = fonts.static_verdict("Futura", self.cat(), {})
        self.assertIn("Futura has no 400 weight", v.message)
        self.assertIn("Futura@500", v.message)
        fonts.record_verdicts([{"ref": "Futura@400", "ok": True}], None)
        self.assertEqual(fonts.static_verdict("Futura@400", self.cat()).severity, "warning")
        self.assertIsNone(fonts.static_verdict("Futura@700", self.cat(), {"Futura@700": {"ok": True}}).severity)

    def test_app_verdict_cache_overrides(self) -> None:
        fonts.record_verdicts([{"ref": "Futura@500", "ok": True}, {"ref": "Courier New", "ok": False, "error": "unknown cmap table format 6", "fallback": "Inter@400"}], "0.19.0")
        cached = fonts.load_verdicts()
        self.assertIn("Futura@500", cached)
        self.assertIsNone(fonts.static_verdict("Futura@500", self.cat()).severity)
        bad = fonts.static_verdict("Courier New@400", self.cat())
        self.assertEqual(bad.severity, "error")
        self.assertIn("cmap table format 6", bad.message)
        self.assertIn("Inter@400 renders instead", bad.message)
        raw = json.loads((self.bridge / "font-verdicts.json").read_text())
        self.assertEqual(raw["version"], 1)

    def test_load_issue_from_heartbeat_is_an_error(self) -> None:
        issues = [{"ref": "Futura@500", "message": "unknown encoding format: 1", "fallback": "Inter@400"}]
        v = fonts.static_verdict("Futura@500", self.cat(), {}, issues)
        self.assertEqual(v.severity, "error")
        self.assertIn("Inter@400", v.message)

    def test_bundled_list_falls_back_without_catalogue(self) -> None:
        empty = catalog.Catalog({}, self.tmp / "none.json")
        self.assertIn("Barlow Condensed", fonts.bundled_fonts(empty))
        self.assertEqual(fonts.bundled_fonts(empty)["Inter"], [400, 600])
