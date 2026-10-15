from __future__ import annotations

import json

from kblib.cli import build_parser

from .helpers import SCRIPTS, FakeApp, KbTestCase, make_project, write_json


class HelpTests(KbTestCase):
    def test_every_command_has_help(self) -> None:
        commands = [
            [], ["status"], ["context"], ["scenes"], ["check"], ["capture"], ["scene"], ["scene", "add"],
            ["scene", "duplicate"], ["scene", "move"], ["scene", "remove"], ["scene", "set"], ["doc"],
            ["project"], ["theme"], ["fonts"], ["presets"], ["catalog"], ["assets"], ["checkpoint"],
            ["history"], ["undo"], ["diff"], ["hook"],
        ]
        for cmd in commands:
            proc = self.kb(cmd + ["--help"])
            self.assertExit(proc, 0)
            self.assertIn("usage: kb", proc.stdout)
        self.assertIn("Exit codes", self.kb(["--help"]).stdout)

    def test_usage_errors_exit_2(self) -> None:
        self.assertExit(self.kb(["scene", "move", "0"], cwd=make_project(self.tmp)), 2)
        self.assertExit(self.kb(["nonsense"]), 2)

    def test_outside_a_project_is_exit_2(self) -> None:
        proc = self.kb(["scenes"], cwd=self.tmp)
        self.assertExit(proc, 2)
        self.assertIn("no project.json", proc.stderr)

    def test_parser_builds(self) -> None:
        self.assertIsNotNone(build_parser())


class ReportCommandTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)

    def test_scenes_and_inspect_shim(self) -> None:
        proc = self.kb(["scenes"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("02-hero", proc.stdout)
        self.assertIn("-> crossfade 600ms", proc.stdout)
        data = json.loads(self.kb(["scenes", "--json"], cwd=self.root).stdout)
        self.assertEqual([s["stem"] for s in data["scenes"]], ["01-intro", "02-hero", "03-outro"])
        self.assertEqual(data["totalMs"], 9000 - 1200)
        shim = self.kb([], cwd=self.root / "scenes", script=SCRIPTS / "inspect.py")
        self.assertExit(shim, 0)
        self.assertIn("01-intro", shim.stdout)

    def test_project_found_from_env_and_subfolders(self) -> None:
        self.assertExit(self.kb(["status"], cwd=self.root / "assets"), 0)
        proc = self.kb(["status"], cwd=self.tmp, env={"CLAUDE_PROJECT_DIR": str(self.root)})
        self.assertExit(proc, 0)
        self.assertIn("ws:demo", proc.stdout)
        self.assertExit(self.kb(["-C", str(self.root), "scenes"], cwd=self.tmp), 0)

    def test_status_reports_the_app_and_last_load(self) -> None:
        last = {
            "project": "ws:demo", "ok": True, "atMs": 1,
            "sceneErrors": [{"index": -1, "file": "scenes/orb.tsx", "phase": "evaluate", "message": "boom"}],
            "fontIssues": [{"ref": "SF Mono@400", "message": "unknown encoding format: 1", "fallback": "Inter@400"}],
            "warnings": ["LUT assets/grade.cube failed and was dropped"],
        }
        with FakeApp(self.bridge, lambda r: None, openProject="ws:demo", lastLoad=last):
            proc = self.kb(["status"], cwd=self.root)
            data = json.loads(self.kb(["status", "--json"], cwd=self.root).stdout)
            context = self.kb(["context"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("this project is open", proc.stdout)
        self.assertIn("persistent module scenes/orb.tsx", proc.stdout)
        self.assertIn("SF Mono@400", proc.stdout)
        self.assertIn("LUT assets/grade.cube", proc.stdout)
        self.assertTrue(data["app"]["running"])
        self.assertIn("persistent module", context.stdout)

    def test_catalog_queries(self) -> None:
        fams = self.kb(["catalog"], cwd=self.root)
        self.assertExit(fams, 0)
        self.assertIn("backgrounds.scene3d", fams.stdout)
        trans = self.kb(["catalog", "transitions"], cwd=self.root)
        self.assertIn("glasssweep (Glass sweep) - A glass band sweeps across", trans.stdout)
        hit = self.kb(["catalog", "--search", "neon"], cwd=self.root)
        self.assertExit(hit, 0)
        self.assertIn("textLooks: neon", hit.stdout)
        self.assertExit(self.kb(["catalog", "--search", "zzzz"], cwd=self.root), 1)
        self.assertExit(self.kb(["catalog", "transitons"], cwd=self.root), 2)
        missing = self.kb(["catalog"], cwd=self.root, env={"KB_CATALOG": str(self.tmp / "none.json")})
        self.assertExit(missing, 2)

    def test_assets_add_list_probe(self) -> None:
        src = self.tmp / "Screen Shot.png"
        src.write_bytes((self.root / "assets" / "logo.png").read_bytes())
        added = self.kb(["assets", "add", str(src), "--name", "logo.png"], cwd=self.root)
        self.assertExit(added, 0)
        self.assertEqual(added.stdout.strip(), "assets/logo.png")
        src.write_bytes(b"different")
        clash = self.kb(["assets", "add", str(src), "--name", "logo.png"], cwd=self.root)
        self.assertEqual(clash.stdout.strip(), "assets/logo-2.png")
        self.assertIn("already exists", clash.stderr)
        bad = self.kb(["assets", "add", str(self.root / "project.json")], cwd=self.root)
        self.assertExit(bad, 1)
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "headerIcon": "assets/logo.png"})
        listed = self.kb(["assets", "list"], cwd=self.root)
        self.assertIn("assets/logo.png  image", listed.stdout)
        self.assertIn("(02-hero)", listed.stdout)
        self.assertIn("(unused)", listed.stdout)
        probe = json.loads(self.kb(["assets", "probe", "logo.png", "--json"], cwd=self.root).stdout)
        self.assertEqual((probe["width"], probe["height"]), (2, 3))


class DelegateTests(KbTestCase):
    def test_chart_and_beats_pass_through(self) -> None:
        root = make_project(self.tmp)
        self.assertExit(self.kb(["chart", "02-hero", "seed"], cwd=root), 0)
        shown = self.kb(["chart", "02-hero", "show"], cwd=root)
        self.assertExit(shown, 0)
        self.assertIn("Region 1", shown.stdout)
        self.assertExit(self.kb(["chart", "02-hero", "set-data", "--inline", "Q1,Q2;Direct,10,20"], cwd=root), 0)
        self.assertExit(self.kb(["check", "scenes/02-hero.json"], cwd=root), 0)
        beats = self.kb(["beats"], cwd=root)
        self.assertExit(beats, 0)
        self.assertIn("no soundtrack", beats.stdout)
