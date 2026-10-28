from __future__ import annotations

import json
from typing import Any, Dict, List

from kblib import cuts
from kblib.util import KbError

from .helpers import KbTestCase, git_init, make_project, read_json, write, write_json

SCENE_TSX = 'export default defineScene({{ id: "{id}", durationMs: {ms}, Scene() {{ return null; }} }});\n'


class TimelineCase(KbTestCase):
    """Three 3000 ms scenes crossfading 600 ms, 120 bpm with bar 1 at 200 ms: the first cut is centred on bar:2.2."""

    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp, audio={"file": "assets/track.mp3"}, git=True)
        (self.root / "assets" / "track.mp3").write_bytes(b"click")
        self.assertExit(self.kb(["beats", "set-grid", "--bpm", "120", "--offset", "200"], cwd=self.root), 0)

    def j(self, *args: str, code: int = 0) -> Dict[str, Any]:
        proc = self.kb(list(args) + ["--json"], cwd=self.root)
        self.assertExit(proc, code)
        return json.loads(proc.stdout)

    def entries(self) -> List[Dict[str, Any]]:
        return read_json(self.root / "project.json")["scenes"]

    def plan(self, name: str, text: str) -> str:
        write(self.root / name, text)
        return str(self.root / name)


class TimelineShowTests(TimelineCase):
    def test_bars_ms_and_flags(self) -> None:
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "camera": {"keys": [
            {"id": "k1", "tMs": 0, "pose": {}}, {"id": "k2", "tMs": 3500, "pose": {}}], "segments": []}})
        data = self.j("timeline")
        self.assertEqual([(s["startMs"], s["endMs"], s["cut"]) for s in data["scenes"]],
                         [(0, 3000, "bar:2.2"), (2400, 5400, "bar:3.3 -100 ms"), (4800, 7800, "bar:4.4 +100 ms")])
        kinds = sorted(f["kind"] for f in data["flags"])
        self.assertEqual(kinds, ["key-past-end", "off-beat"])
        text = self.kb(["timeline"], cwd=self.root).stdout
        self.assertIn('camera key "k2" at 3500 ms is past the scene\'s end (3000 ms)', text)


class TimelineApplyTests(TimelineCase):
    def test_a_json_plan_pins_every_cut_in_one_write(self) -> None:
        path = self.plan("cuts.json", json.dumps({"version": 1, "cuts": [
            {"scene": "01-intro", "cutAt": "bar:3", "align": "mid", "transition": {"type": "crossfade", "durationMs": 800}},
            {"scene": "02-hero", "cutAt": "bar:5", "align": "mid", "transition": "wipe:500"},
            {"scene": "03-outro", "cutAt": "bar:7"},
        ]}))
        out = self.j("timeline", "apply", path)
        self.assertEqual([(w["action"], w["path"]) for w in out["writes"]], [("modify", "project.json")])
        self.assertEqual([(e["durationMs"], e["cutAt"], e.get("align")) for e in self.entries()],
                         [(4600, "bar:3", "mid"), (4650, "bar:5", "mid"), (4250, "bar:7", None)])
        self.assertEqual([s["cut"] for s in out["timeline"]["scenes"]][:2], ["bar:3", "bar:5"])
        self.assertEqual(out["timeline"]["flags"], [])
        # A longer first transition later keeps every cut on its bar.
        self.j("scene", "set", "0", "--transition", "crossfade:1200")
        self.assertEqual([s["cut"] for s in self.j("timeline")["scenes"]][:2], ["bar:3", "bar:5"])

    def test_pinning_a_follow_media_scene_makes_its_length_manual(self) -> None:
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "duration": {"mode": "follow-media"}})
        out = self.j("timeline", "apply", self.plan("cuts.json", '[{"scene": "02-hero", "cutAt": "bar:4"}]'))
        self.assertEqual(read_json(self.root / "scenes" / "02-hero.json")["duration"], {"mode": "manual"})
        self.assertTrue(any("duration.mode = manual" in c for c in out["changes"]))

    def test_a_markdown_table_with_bare_bars(self) -> None:
        path = self.plan("cuts.md", "Cuts\n\n| Scene | Cut | Transition | Length | Align |\n|---|---|---|---|---|\n"
                                    "| 01-intro | 3 | crossfade | 0.8s | mid |\n| 02-hero | bar:5 | cut | | |\n")
        self.j("timeline", "apply", path)
        first, second = self.entries()[:2]
        self.assertEqual((first["cutAt"], first["align"], first["transition"]), ("bar:3", "mid", {"type": "crossfade", "durationMs": 800}))
        self.assertEqual((second["cutAt"], "transition" in second), ("bar:5", False))

    def test_a_bad_plan_writes_nothing(self) -> None:
        before = self.entries()
        for body, code in (
            ('{"version": 1, "cuts": [{"scene": "01-intro", "cutAt": "bar:3", "transition": "sparkle:400"}]}', 2),
            ('{"version": 1, "cuts": [{"scene": "09-none", "cutAt": "bar:3"}]}', 1),
            ('{"version": 1, "cuts": [{"scene": "01-intro", "cutAt": "bar:3"}, {"scene": "02-hero", "cutAt": "bar:1"}]}', 1),
            ('{"version": 1, "cuts": [{"scene": "03-outro", "transition": "crossfade:400"}]}', 1),
            ('{"version": 2, "cuts": []}', 2),
            ("no table here", 2),
        ):
            with self.subTest(body=body):
                self.j("timeline", "apply", self.plan("bad.json", body), code=code)
                self.assertEqual(self.entries(), before)

    def test_parse_rows(self) -> None:
        rows = cuts.parse_plan('[{"scene": 2, "cutAt": null, "transition": null}]')
        self.assertEqual((rows[0]["scene"], rows[0]["cutAt"], rows[0]["transition"]), ("2", None, None))
        with self.assertRaises(KbError):
            cuts.parse_plan('{"cuts": [{"scene": "a", "cut": "bar:3"}]}')


class DriftTests(TimelineCase):
    def test_ripple_reports_cuts_it_moves_off_the_beat(self) -> None:
        # Scene 1 runs 2400 to 5700 ms with a hard cut out, so its end sits on bar:3.4.
        self.j("scene", "set", "1", "--transition", "none", "--ripple")
        self.j("scene", "set", "1", "--duration", "3300")
        self.assertExit(self.kb(["checkpoint", "on the beat"], cwd=self.root), 0)
        out = self.j("scene", "set", "0", "--transition", "crossfade:1000", "--ripple")
        self.assertEqual([d["stem"] for d in out["drift"]], ["01-intro", "02-hero"])
        self.assertIn("sat on bar:3.4", out["drift"][1]["message"])
        self.assertIn("--cut-at bar:3.4 --align mid", out["drift"][1]["message"])
        status = self.j("status")
        self.assertEqual([d["stem"] for d in status["drift"]], ["01-intro", "02-hero"])
        check = json.loads(self.kb(["check", "--json"], cwd=self.root).stdout)
        self.assertTrue(any("sat on bar:3.4" in i["message"] for i in check["issues"]))

    def test_keeping_the_cut_reports_nothing(self) -> None:
        self.assertExit(self.kb(["checkpoint", "start"], cwd=self.root), 0)
        out = self.j("scene", "set", "0", "--transition", "crossfade:1000")
        self.assertEqual(out["drift"], [])


class CheckTests(TimelineCase):
    def issues(self) -> List[Dict[str, Any]]:
        return json.loads(self.kb(["check", "--json"], cwd=self.root).stdout)["issues"]

    def test_a_stale_pinned_length_and_a_bad_pin(self) -> None:
        m = read_json(self.root / "project.json")
        m["scenes"][0].update(cutAt="bar:3", align="mid", durationMs=4000)
        m["scenes"][1].update(cutAt="bar 5", align="middle")
        write_json(self.root / "project.json", m)
        found = {(i["path"], i["severity"]) for i in self.issues()}
        self.assertIn(("scenes[0].durationMs", "warning"), found)
        self.assertIn(("scenes[1].cutAt", "error"), found)
        self.assertIn(("scenes[1].align", "error"), found)

    def test_tsx_lengths_that_differ_from_project_json(self) -> None:
        write(self.root / "scenes" / "02-hero.tsx", SCENE_TSX.format(id="hero", ms=4500))
        hits = [i for i in self.issues() if i["path"] == "scenes"]
        self.assertEqual(len(hits), 1)
        self.assertIn("02-hero (4500 in the TSX, 3000 in project.json)", hits[0]["message"])
