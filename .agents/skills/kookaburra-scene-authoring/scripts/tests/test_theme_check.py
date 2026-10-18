from __future__ import annotations

import copy
from typing import Any, Dict, List

from kblib import check
from kblib.project import Project

from .helpers import KbTestCase, make_project, read_json, write_json

BASE: Dict[str, Any] = {
    "version": 3,
    "id": "base",
    "name": "Base",
    "colors": {"background": "#0b1020", "text": "#f4f6fb", "accent": "#ff5a36", "muted": "#8a94ab"},
    "typography": {"headline": "Inter@600", "body": "Inter", "scale": 1.25},
    "motion": {"durations": {"fast": 200, "base": 500, "slow": 900}, "easings": {"standard": "outCubic", "emphasized": "outExpo"}},
}


def issues(report: check.Report, severity: str) -> List[str]:
    return [f"{i.path} {i.message}" for i in report.issues if i.severity == severity]


class ThemeDocCheckTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.project = Project(self.root)

    def theme(self, slug: str, doc: Dict[str, Any]) -> None:
        write_json(self.tmp / "themes" / slug / "theme.json", doc)

    def check(self, doc: Any, theme_id: str = "ws:brand") -> check.Report:
        report = check.Report()
        check.Checker(check.Context(self.project), report).theme_doc(theme_id, doc)
        return report

    def test_a_complete_theme_is_clean(self) -> None:
        report = self.check(BASE)
        self.assertEqual(issues(report, "error"), [])

    def test_font_strings_get_the_font_check(self) -> None:
        doc = copy.deepcopy(BASE)
        doc["typography"]["headline"] = "Nonexistent Grotesk@700"
        doc["typography"]["body"] = 7
        report = self.check(doc)
        found = issues(report, "error") + issues(report, "warning")
        self.assertTrue(any("typography.headline" in i for i in found), found)
        self.assertTrue(any("typography.body" in i and "Family@weight" in i for i in issues(report, "error")))

    def test_shadow_needs_only_a_technique(self) -> None:
        doc = copy.deepcopy(BASE)
        doc["lighting"] = {"shadow": {"technique": "map", "softness": "soft"}}
        report = self.check(doc)
        self.assertEqual(issues(report, "error"), [])
        self.assertTrue(any("lighting.shadow.softness" in w for w in issues(report, "warning")))
        doc["lighting"]["shadow"] = {"opacity": 0.4}
        self.assertTrue(any("technique" in e for e in issues(self.check(doc), "error")))

    def test_gradient_angles(self) -> None:
        doc = copy.deepcopy(BASE)
        doc["gradients"] = {
            "glow": {"type": "radial", "stops": [["#000000", 0], ["#ffffff", 1]]},
            "band": {"type": "linear", "stops": [["#000000", 0], ["#ffffff", 1]]},
        }
        doc["background"] = {"type": "gradient", "gradient": "glow", "spec": {"type": "linear", "stops": []}}
        report = self.check(doc)
        errors = issues(report, "error")
        self.assertEqual([e for e in errors if "gradients.glow" in e], [])
        self.assertTrue(any("gradients.band" in e and "angleDeg" in e for e in errors), errors)
        self.assertTrue(any("background.spec" in w and '"glow" gradient shows instead' in w for w in issues(report, "warning")))

    def test_extends_needs_version_three_and_a_real_base(self) -> None:
        self.assertTrue(any("version" in e for e in issues(self.check({"version": 2, "extends": "ws:base"}), "error")))
        self.assertTrue(any('"ws:gone" can\'t be found' in e for e in issues(self.check({"version": 3, "extends": "ws:gone"}), "error")))
        bundled = issues(self.check({"version": 3, "extends": "kookaburra-midnite"}), "error")
        self.assertTrue(any("kookaburra-midnight" in e for e in bundled), bundled)
        self.assertEqual(issues(self.check({"version": 3, "extends": "kookaburra-midnight"}), "error"), [])

    def test_extends_merges_the_chain(self) -> None:
        self.theme("base", BASE)
        self.theme("middle", {"version": 3, "extends": "ws:base", "colors": {"accent": "#00aa88"}})
        self.assertEqual(issues(self.check({"version": 3, "id": "brand", "extends": "ws:middle", "mode": "light"}), "error"), [])
        gaps = issues(self.check({"version": 3, "extends": "ws:middle", "colors": None}), "error")
        self.assertTrue(any("its own id" in e and "colors" in e and "still lacks" in e for e in gaps), gaps)

    def test_extends_cycles(self) -> None:
        self.theme("a", {"version": 3, "extends": "ws:brand"})
        errors = issues(self.check({"version": 3, "extends": "ws:a"}), "error")
        self.assertTrue(any("loops back on itself (ws:brand > ws:a > ws:brand)" in e for e in errors), errors)
        self.assertTrue(any("loops back" in e for e in issues(self.check({"version": 3, "extends": "ws:brand"}), "error")))

    def test_theme_set_refuses_a_broken_base(self) -> None:
        self.theme("brand", copy.deepcopy(BASE))
        path = self.tmp / "themes" / "brand" / "theme.json"
        refused = self.kb(["theme", "set", "extends", "ws:gone", "--theme", "ws:brand"], cwd=self.root)
        self.assertExit(refused, 1)
        self.assertNotIn("extends", read_json(path))
        self.theme("base", BASE)
        self.assertExit(self.kb(["theme", "set", "extends", "ws:base", "--theme", "ws:brand"], cwd=self.root), 0)
        self.assertEqual(read_json(path)["extends"], "ws:base")

    def test_full_check_reads_the_project_theme(self) -> None:
        manifest = read_json(self.root / "project.json")
        manifest["themeId"] = "ws:brand"
        write_json(self.root / "project.json", manifest)
        self.theme("brand", {**BASE, "extends": "ws:gone"})
        report = check.check_project(self.project)
        self.assertTrue(any("ws:gone" in e for e in issues(report, "error")))
