"""kb try: value splitting and the variant plan, the one capture request it sends (each variant a whole sidecar, the saved
scene without one), keep commands, the labelled sheet, and that nothing in scenes/ is ever written."""

from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path
from typing import Any, Dict, List

from kblib import try_cli
from kblib.util import KbError

from .helpers import FakeApp, KbTestCase, make_project, png_bytes

KINDS = ["capture", "check", "fonts", "insertPreset", "mediaChanged", "openEdit", "debug"]
FEATURES = ["scale", "width", "probe", "client", "deadline", "recycle", "debug", "range", "texts", "sceneDoc"]


class PlanTests(unittest.TestCase):
    def test_values_split_on_top_level_commas_only(self) -> None:
        self.assertEqual(try_cli.split_values("0.12, 0.25,0.5"), ["0.12", "0.25", "0.5"])
        self.assertEqual(try_cli.split_values('[1,2],{"a":1,"b":2},"x,y"'), ["[1,2]", '{"a":1,"b":2}', '"x,y"'])
        path, values, words = try_cli.parse_set("lighting.lights.0.position=[1,2,3],[0,0,0]")
        self.assertEqual((path, values, words), ("lighting.lights.0.position", [[1, 2, 3], [0, 0, 0]], ["[1,2,3]", "[0,0,0]"]))

    def test_sets_make_a_grid_and_named_patches_follow(self) -> None:
        sets = [try_cli.parse_set("a=1,2"), try_cli.parse_set("b.c=x,y")]
        plan = try_cli.plan_variants(sets, [("matte", {"backdrop": {"roughness": 0.9}})])
        self.assertEqual([v["label"] for v in plan], ["a=1  b.c=x", "a=1  b.c=y", "a=2  b.c=x", "a=2  b.c=y", "matte"])
        self.assertEqual(plan[1]["ops"], [("set", "a", 1, "1"), ("set", "b.c", "y", "y")])
        self.assertEqual(try_cli.keep_commands("04-x", plan[1]["ops"]), ["./kb doc 04-x set a 1", "./kb doc 04-x set b.c y"])
        self.assertEqual(try_cli.keep_commands("04-x", plan[4]["ops"]), ["./kb doc 04-x merge '{\"backdrop\":{\"roughness\":0.9}}'"])

    def test_bad_plans_are_usage_errors(self) -> None:
        for spec in ("a", "=1", "a=", "a= , "):
            with self.assertRaises(KbError) as e:
                try_cli.parse_set(spec)
            self.assertEqual(e.exception.kind, "usage", spec)
        with self.assertRaises(KbError) as e:
            try_cli.plan_variants([try_cli.parse_set("a=1,2,3"), try_cli.parse_set("b=1,2,3")], [])
        self.assertIn("at most 8", e.exception.message)
        with self.assertRaises(KbError):
            try_cli.plan_variants([], [])


class TryTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.sidecar = self.root / "scenes" / "02-hero.json"
        self.on_answer = lambda: None

    def answer(self, req: Dict[str, Any]) -> Dict[str, Any]:
        self.on_answer()
        frames = []
        for n, f in enumerate(req["frames"]):
            path = self.tmp / "app" / f"{req['id']}-{n}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(png_bytes(16, 9))
            frame = {"scene": "02-hero", "at": f["at"], "tMs": 3400, "path": str(path), "index": 1}
            if "sceneDoc" in f:
                frame["sceneDoc"] = True
            frames.append(frame)
        loads = len({json.dumps(f["sceneDoc"], sort_keys=True) for f in req["frames"] if "sceneDoc" in f})
        return {"ok": True, "path": frames[0]["path"], "paths": [f["path"] for f in frames], "frames": frames, "project": req["project"],
                "format": "16:9", "size": {"width": 1280, "height": 720}, "nativeSize": {"width": 3840, "height": 2160},
                "timing": {"renderMs": 10, "sceneDocLoads": loads}}

    def run_try(self, *args: str, code: int = 0, features: List[str] = FEATURES) -> Dict[str, Any]:
        with FakeApp(self.bridge, self.answer, kinds=KINDS, health={"version": 1, "captureFeatures": features}) as app:
            proc = self.kb(["try", "--json", *args], cwd=self.root)
        self.assertExit(proc, code)
        out = json.loads(proc.stdout)
        out["_requests"] = app.requests
        out["_stderr"] = proc.stderr
        return out

    def scenes_hash(self) -> str:
        h = hashlib.sha256()
        for p in sorted((self.root / "scenes").iterdir()):
            h.update(p.name.encode() + p.read_bytes())
        h.update((self.root / "project.json").read_bytes())
        return h.hexdigest()

    def test_variants_render_in_one_request_and_nothing_is_written(self) -> None:
        before = self.scenes_hash()
        saved = json.loads(self.sidecar.read_text())
        out = self.run_try("02-hero", "--at", "1", "--set", 'name=Alpha,Hero,"Beta, two"')
        self.assertEqual(self.scenes_hash(), before)
        (req,) = out["_requests"]
        self.assertEqual(req["project"], "ws:demo")
        # The saved value is one of the variants, so no separate saved tile, and that tile renders without a sceneDoc.
        self.assertEqual([("sceneDoc" in f, f["scene"], f["at"]) for f in req["frames"]], [(True, "1", 1.0), (False, "1", 1.0), (True, "1", 1.0)])
        self.assertEqual(req["frames"][0]["sceneDoc"], dict(saved, name="Alpha"))
        self.assertEqual(req["frames"][2]["sceneDoc"], dict(saved, name="Beta, two"))
        labels = [t["label"] for t in out["tiles"]]
        self.assertEqual(labels, ["name=Alpha", "name=Hero (saved)", 'name="Beta, two"'])
        self.assertEqual(out["tiles"][0]["keep"], ["./kb doc 02-hero set name Alpha"])
        self.assertEqual(out["tiles"][1]["keep"], [])
        self.assertEqual(out["tiles"][2]["keep"], ["./kb doc 02-hero set name '\"Beta, two\"'"])
        self.assertTrue(Path(out["sheet"]).is_file())
        self.assertEqual(Path(out["sheet"]).name, "try.png")
        self.assertTrue(all(Path(t["path"]).parent == Path(out["sheet"]).parent for t in out["tiles"]))
        self.assertEqual(out["sceneDocLoads"], 2)
        self.assertFalse(out["changedDuring"])

    def test_the_saved_scene_leads_when_no_variant_matches_it(self) -> None:
        out = self.run_try("02-hero", "--at", "0.5", "--variant", 'dark={"background":{"type":"color","color":"#000000"}}')
        frames = out["_requests"][0]["frames"]
        self.assertEqual(["sceneDoc" in f for f in frames], [False, True])
        self.assertEqual([t["label"] for t in out["tiles"]], ["saved", "dark"])
        self.assertEqual(frames[1]["sceneDoc"]["background"], {"type": "color", "color": "#000000"})

    def test_a_variant_that_adds_errors_sends_nothing(self) -> None:
        out = self.run_try("02-hero", "--at", "1", "--set", "devices=5", code=1)
        self.assertEqual(out["code"], "invalid")
        self.assertIn("devices", out["error"])
        self.assertEqual(out["_requests"], [])

    def test_an_app_without_scene_docs_is_refused_before_sending(self) -> None:
        out = self.run_try("02-hero", "--at", "1", "--set", "name=A", code=2, features=FEATURES[:-1])
        self.assertIn("does not support kb try", out["error"])
        self.assertEqual(out["_requests"], [])

    def test_a_sidecar_edited_mid_render_is_flagged(self) -> None:
        self.on_answer = lambda: self.sidecar.write_text(json.dumps({"version": 1, "name": "Edited"}))
        out = self.run_try("02-hero", "--at", "1", "--set", "name=A")
        self.assertTrue(out["changedDuring"])
        self.assertIn("changed while the variants rendered", out["_stderr"])


if __name__ == "__main__":
    unittest.main()
