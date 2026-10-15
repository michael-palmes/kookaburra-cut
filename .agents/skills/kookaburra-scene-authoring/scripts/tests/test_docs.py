from __future__ import annotations

import json

from kblib import docs
from kblib.util import KbError

from .helpers import KbTestCase, make_project, read_json, write_json


class DottedPathTests(KbTestCase):
    def test_set_get_unset_and_append(self) -> None:
        doc = {"version": 1, "devices": [{"id": "d1", "model": "android"}]}
        out = docs.set_path(doc, "devices.0.model", "iphone-17-pro")
        self.assertEqual(out["devices"][0]["model"], "iphone-17-pro")
        self.assertEqual(doc["devices"][0]["model"], "android")
        out = docs.set_path(out, "devices.+", {"id": "d2", "model": "android"})
        self.assertEqual(len(out["devices"]), 2)
        out = docs.set_path(out, "textStyle.titleSize", 1.25)
        self.assertEqual(docs.get_path(out, "textStyle.titleSize"), (True, 1.25))
        out = docs.unset_path(out, "textStyle.titleSize")
        self.assertNotIn("textStyle", out)
        self.assertEqual(docs.get_path(out, "devices[1].id"), (True, "d2"))

    def test_refuses_to_clobber_or_invent_lists(self) -> None:
        with self.assertRaises(KbError):
            docs.set_path({"text": {"title": "x"}}, "text.title.size", 1)
        with self.assertRaises(KbError):
            docs.set_path({}, "devices.0.model", "x")
        with self.assertRaises(KbError):
            docs.unset_path({"a": 1}, "b")

    def test_merge_patch_rfc7386(self) -> None:
        out = docs.merge_patch({"a": {"b": 1, "c": 2}, "d": 1}, {"a": {"b": None, "e": 3}, "d": [1]})
        self.assertEqual(out, {"a": {"c": 2, "e": 3}, "d": [1]})

    def test_parse_value(self) -> None:
        self.assertEqual(docs.parse_value("1.5"), 1.5)
        self.assertEqual(docs.parse_value("Inter@600"), "Inter@600")
        self.assertEqual(docs.parse_value('{"a": 1}'), {"a": 1})
        self.assertEqual(docs.parse_value("123", as_string=True), "123")


class DocCommandTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.sidecar = self.root / "scenes" / "02-hero.json"

    def test_get_and_set(self) -> None:
        proc = self.kb(["doc", "02-hero", "get", "text.title"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertEqual(json.loads(proc.stdout), "Hello")
        self.assertExit(self.kb(["doc", "1", "set", "textStyle.titleFont", "Inter@600"], cwd=self.root), 0)
        self.assertEqual(read_json(self.sidecar)["textStyle"]["titleFont"], "Inter@600")
        self.assertExit(self.kb(["doc", "02-hero", "set", "text.title", "42", "--string"], cwd=self.root), 0)
        self.assertEqual(read_json(self.sidecar)["text"]["title"], "42")
        text = self.sidecar.read_text()
        self.assertTrue(text.endswith("}\n"))
        self.assertIn('\n  "version": 1', text)

    def test_unicode_is_written_raw(self) -> None:
        self.assertExit(self.kb(["doc", "02-hero", "set", "headerIcon", "🚀"], cwd=self.root), 0)
        self.assertIn("🚀", self.sidecar.read_text(encoding="utf-8"))

    def test_refuses_a_write_that_adds_errors(self) -> None:
        before = self.sidecar.read_text()
        proc = self.kb(["doc", "02-hero", "set", "devices", '[{"id": "d1", "model": "iphone-99"}]'], cwd=self.root)
        self.assertExit(proc, 1)
        self.assertIn("nothing written", proc.stderr)
        self.assertIn("iphone-99", proc.stderr)
        self.assertEqual(self.sidecar.read_text(), before)
        forced = self.kb(["doc", "02-hero", "set", "devices", '[{"id": "d1", "model": "iphone-99"}]', "--force"], cwd=self.root)
        self.assertExit(forced, 1)
        self.assertEqual(read_json(self.sidecar)["devices"][0]["model"], "iphone-99")

    def test_warnings_print_but_pass(self) -> None:
        proc = self.kb(["doc", "02-hero", "set", "textStyle.titleFont", "Futura@500"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("not vetted yet", proc.stdout)

    def test_merge_and_unset(self) -> None:
        self.assertExit(self.kb(["doc", "02-hero", "merge", '{"background": {"type": "color", "color": "#101418"}, "text": {"title": null}}'], cwd=self.root), 0)
        doc = read_json(self.sidecar)
        self.assertEqual(doc["background"]["color"], "#101418")
        self.assertNotIn("title", doc["text"])
        self.assertExit(self.kb(["doc", "02-hero", "unset", "background"], cwd=self.root), 0)
        self.assertNotIn("background", read_json(self.sidecar))
        missing = self.kb(["doc", "02-hero", "unset", "background"], cwd=self.root)
        self.assertExit(missing, 1)
        patch_file = self.tmp / "patch.json"
        write_json(patch_file, {"name": "From file"})
        self.assertExit(self.kb(["doc", "02-hero", "merge", f"@{patch_file}"], cwd=self.root), 0)
        self.assertEqual(read_json(self.sidecar)["name"], "From file")

    def test_creates_a_missing_sidecar_with_version(self) -> None:
        self.sidecar.unlink()
        self.assertExit(self.kb(["doc", "02-hero", "get"], cwd=self.root), 1)
        self.assertExit(self.kb(["doc", "02-hero", "set", "name", "Hero"], cwd=self.root), 0)
        self.assertEqual(read_json(self.sidecar), {"version": 1, "name": "Hero"})

    def test_sidecar_shim_keeps_the_old_shape(self) -> None:
        from .helpers import SCRIPTS

        proc = self.kb(["02-hero", "set", "textStyle.titleSize", "1.5"], cwd=self.root, script=SCRIPTS / "sidecar.py")
        self.assertExit(proc, 0)
        self.assertEqual(read_json(self.sidecar)["textStyle"]["titleSize"], 1.5)
        got = self.kb(["02-hero", "get", "textStyle"], cwd=self.root, script=SCRIPTS / "sidecar.py")
        self.assertEqual(json.loads(got.stdout), {"titleSize": 1.5})


class ProjectAndThemeCommandTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)

    def test_project_get_set(self) -> None:
        proc = self.kb(["project", "get"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertNotIn("scenes", json.loads(proc.stdout))
        self.assertExit(self.kb(["project", "set", "themeId", "kookaburra-midnight"], cwd=self.root), 0)
        self.assertEqual(read_json(self.root / "project.json")["themeId"], "kookaburra-midnight")
        bad = self.kb(["project", "set", "formats", '["16:9", "21:9"]'], cwd=self.root)
        self.assertExit(bad, 1)
        self.assertIn("21:9", bad.stderr)
        scenes = self.kb(["project", "set", "scenes.0.durationMs", "5"], cwd=self.root)
        self.assertExit(scenes, 2)
        self.assertIn("kb scene", scenes.stderr)

    def test_theme_list_show_set(self) -> None:
        theme_dir = self.tmp / "themes" / "brand"
        write_json(theme_dir / "theme.json", {"id": "ws:brand", "colors": {"accent": "#000000"}, "typography": {"headline": {"family": "Inter", "weight": 600}}})
        listed = self.kb(["theme", "list"], cwd=self.root)
        self.assertExit(listed, 0)
        self.assertIn("kookaburra-midnight", listed.stdout)
        self.assertIn("ws:brand", listed.stdout)
        shown = self.kb(["theme", "show"], cwd=self.root)
        self.assertExit(shown, 0)
        self.assertIn("read-only", shown.stdout)
        refused = self.kb(["theme", "set", "colors.accent", "#ff5a36"], cwd=self.root)
        self.assertExit(refused, 1)
        self.assertIn("duplicate it", refused.stderr)
        self.assertExit(self.kb(["theme", "set", "colors.accent", "#ff5a36", "--theme", "ws:brand"], cwd=self.root), 0)
        self.assertEqual(read_json(theme_dir / "theme.json")["colors"]["accent"], "#ff5a36")
        from .helpers import SCRIPTS

        shim = self.kb([], cwd=self.root, script=SCRIPTS / "theme.py")
        self.assertExit(shim, 0)
        self.assertIn("kookaburra-default", shim.stdout)
