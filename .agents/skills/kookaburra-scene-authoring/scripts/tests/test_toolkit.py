from __future__ import annotations

import json

from kblib import toolkit

from .helpers import KbTestCase, make_project


class ToolkitReferenceTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)

    def test_show_prints_props_defaults_units_example_and_timing(self) -> None:
        proc = self.kb(["toolkit", "show", "AnimatedHeadline"], cwd=self.root)
        self.assertExit(proc, 0)
        for needle in ("fontSize?: number  (default 0.6)", "hitAt?: number", "[ms]", "Example:", "Timing:", "outDurationMs"):
            self.assertIn(needle, proc.stdout)

    def test_show_json_is_the_entry(self) -> None:
        proc = self.kb(["toolkit", "show", "ScreenLayer", "--json"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("order", proc.stdout)
        self.assertEqual(json.loads(proc.stdout)["name"], "ScreenLayer")

    def test_show_suggests_a_near_name(self) -> None:
        proc = self.kb(["toolkit", "show", "ScreenLayr"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("ScreenLayer", proc.stdout + proc.stderr)

    def test_list_filters_by_kind(self) -> None:
        proc = self.kb(["toolkit", "list", "--kind", "hook"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("useBeatAt", proc.stdout)
        self.assertNotIn("AnimatedHeadline (component)", proc.stdout)

    def test_every_entry_is_printable(self) -> None:
        for name, entry in toolkit.load_reference().items():
            self.assertTrue(toolkit.entry_text(name, entry).startswith(name))
