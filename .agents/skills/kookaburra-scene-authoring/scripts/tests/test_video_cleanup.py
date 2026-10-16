from __future__ import annotations

import copy
import importlib
import json
import os
import random
import shutil
import unittest
from pathlib import Path

from kblib.video import cleanup as cl

from . import video_synth as vs
from .helpers import KbTestCase, make_project

GOLDEN = {
    "gentle": [("cutSource", 0, 2800, None), ("cutSource", 6200, 11166, None), ("speedSource", 11166, 17500, 2.0),
               ("cutSource", 22550, 24367, None)],
    "normal": [("cutSource", 0, 3000, None), ("cutSource", 5700, 11166, None), ("speedSource", 11166, 17700, 4.0),
               ("cutSource", 22250, 24567, None), ("cutSource", 27000, 28000, None)],
    "aggressive": [("cutSource", 0, 3150, None), ("cutSource", 5300, 11166, None), ("speedSource", 11166, 17800, 6.0),
                   ("cutSource", 18600, 18800, None), ("cutSource", 22050, 24667, None), ("cutSource", 26600, 28000, None)],
}


def ops_of(plan):
    return [(o["op"], o["fromMs"], o["toMs"], o.get("speed")) for o in plan.ops]


def plan(doc=None, preset="normal", **kw):
    return cl.plan_cleanup(doc or vs.screen_doc(), {"s1": vs.screen_analysis()}, preset=preset, **kw)


class GoldenTests(unittest.TestCase):
    def test_each_preset(self) -> None:
        for preset, want in GOLDEN.items():
            with self.subTest(preset=preset):
                p = plan(preset=preset)
                self.assertEqual(ops_of(p), want)
                self.assertIsNone(p.capped)

    def test_normal_report(self) -> None:
        p = plan()
        self.assertEqual(p.before["ms"], 28000.0)
        self.assertEqual(p.after["frames"], 679)
        kinds = [(i["kind"], i["sub"]) for i in p.items]
        self.assertIn(("idle", "loading"), kinds)
        loading = next(i for i in p.items if i["sub"] == "loading")
        self.assertEqual(loading["speed"], 4.0)
        self.assertEqual(loading["timelineMs"], [11166.0, 17700.0])
        clips = p.doc["clips"]
        self.assertEqual([(c["inMs"], c["outMs"], c["speed"]) for c in clips],
                         [(3000, 5700, 1), (11166, 17700, 4.0), (17700, 22250, 1), (24567, 27000, 1)])
        self.assertEqual(clips[0]["id"], "c1")

    def test_second_run_is_a_no_op(self) -> None:
        for preset in GOLDEN:
            with self.subTest(preset=preset):
                first = plan(preset=preset)
                again = cl.plan_cleanup(first.doc, {"s1": vs.screen_analysis()}, preset=preset)
                self.assertEqual(again.ops, [])

    def test_gentle_keeps_more_reading_time(self) -> None:
        self.assertGreater(plan(preset="gentle").after["ms"], plan().after["ms"])
        self.assertGreater(plan().after["ms"], plan(preset="aggressive").after["ms"])


class OptionTests(unittest.TestCase):
    def test_keep_protects_a_timeline_range(self) -> None:
        p = plan(keep=[("s1", 6000.0, 9000.0)])
        for op in p.ops:
            self.assertFalse(op["fromMs"] < 9000 and 6000 < op["toMs"], op)

    def test_skip_leaves_an_interval_alone(self) -> None:
        p = plan(skip=["i4"])
        self.assertFalse(any(op["fromMs"] < 11200 and 4700 < op["toMs"] and op["op"] == "cutSource" and op["fromMs"] > 4000 for op in p.ops))
        self.assertTrue(any(s["interval"] == "i4" and s["reason"] == "--skip" for s in p.skipped))

    def test_cuts_only_and_no_speed(self) -> None:
        cuts = plan(cuts_only=True)
        self.assertFalse(any(o["op"] == "speedSource" for o in cuts.ops))
        self.assertFalse(any(o["fromMs"] == 0 for o in cuts.ops))
        self.assertFalse(any(o["toMs"] == 28000 for o in cuts.ops))
        nospeed = plan(no_speed=True)
        self.assertFalse(any(o["op"] == "speedSource" for o in nospeed.ops))
        self.assertTrue(any(o["fromMs"] == 0 for o in nospeed.ops))

    def test_retimed_frozen_and_still_clips_are_left_alone(self) -> None:
        doc = vs.screen_doc(clips=[
            {"id": "c1", "sourceId": "s1", "inMs": 0, "outMs": 12000, "speed": 2, "startMs": 0},
            {"id": "c2", "sourceId": "s1", "inMs": 12000, "outMs": 12000, "speed": 1, "holdMs": 800, "startMs": 6000},
            {"id": "c3", "sourceId": "s1", "inMs": 12000, "outMs": 28000, "speed": 1, "startMs": 6800},
        ])
        p = plan(doc)
        self.assertEqual({c["clip"] for c in p.clips_skipped}, {"c1", "c2"})
        for op in p.ops:
            self.assertGreaterEqual(op["fromMs"], 12000)
        kept = [c for c in p.doc["clips"] if c["id"] in ("c1", "c2")]
        self.assertEqual([(c["inMs"], c["outMs"], c["speed"]) for c in kept], [(0, 12000, 2), (12000, 12000, 1)])

    def test_a_duplicated_segment_is_cleaned_in_each_copy(self) -> None:
        doc = vs.screen_doc(clips=[
            {"id": "c1", "sourceId": "s1", "inMs": 18000, "outMs": 26000, "speed": 1, "startMs": 0},
            {"id": "c2", "sourceId": "s1", "inMs": 18000, "outMs": 26000, "speed": 1, "startMs": 8000},
        ])
        p = plan(doc)
        spans = [(c["inMs"], c["outMs"]) for c in p.doc["clips"]]
        half = len(spans) // 2
        self.assertEqual(spans[:half], spans[half:])

    def test_doc_taps_are_guarded(self) -> None:
        doc = vs.screen_doc(taps=[{"id": "t1", "sourceId": "s1", "sourceMs": 23000, "pos": [0.5, 0.5]}])
        p = plan(doc)
        for op in p.ops:
            self.assertFalse(op["fromMs"] < 23700 and 22600 < op["toMs"], op)
        self.assertEqual(p.protected_taps[0]["tap"], "t1")

    def test_masks_touched_by_a_cut_are_reported(self) -> None:
        doc = vs.screen_doc(masks=[{"id": "m1", "sourceId": "s1", "style": "blur", "startMs": 5000, "endMs": 9000,
                                    "keys": [{"sourceMs": 5000, "rect": [0.1, 0.1, 0.3, 0.1]}]}])
        self.assertEqual(plan(doc).masks[0]["mask"], "m1")

    def test_removal_cap(self) -> None:
        an = {"profile": "screen", "durationMs": 60000, "screenChanges": [], "tapCandidates": [], "intervals": [
            {"id": "i1", "kind": "lead-in", "sub": "static", "startMs": 0, "endMs": 30000, "exactStartMs": 0.0, "exactEndMs": 30000.0, "confidence": 0.99},
            {"id": "i2", "kind": "active", "sub": None, "startMs": 30000, "endMs": 30400, "exactStartMs": 30000.0, "exactEndMs": 30400.0, "confidence": 1.0},
            {"id": "i3", "kind": "lead-out", "sub": "static", "startMs": 30400, "endMs": 60000, "exactStartMs": 30400.0, "exactEndMs": 60000.0, "confidence": 0.99},
        ]}
        doc = vs.screen_doc(sources=[{"id": "s1", "rel": "assets/x.mov", "kind": "video", "width": 360, "height": 784, "fps": 60, "durationMs": 60000}],
                            clips=[{"id": "c1", "sourceId": "s1", "inMs": 0, "outMs": 60000, "speed": 1, "startMs": 0}])
        p = cl.plan_cleanup(doc, {"s1": an}, preset="normal")
        self.assertIsNotNone(p.capped)
        self.assertIn("--gentle", p.capped)

    def test_loading_speed_picks_the_smallest_menu_speed(self) -> None:
        self.assertEqual(cl.loading_speed(3000, 4, 1000), 4.0)
        self.assertEqual(cl.loading_speed(1800, 4, 1000), 2.0)
        self.assertEqual(cl.loading_speed(1400, 4, 1000), 1.5)
        self.assertEqual(cl.loading_speed(9000, 2, 2000), 2.0)


class ModelTests(unittest.TestCase):
    def test_frame_at_rounds_half_away(self) -> None:
        self.assertEqual(cl.frame_at(8.333333333333334, 60), 1)
        self.assertEqual(cl.frame_at(25.0, 60), 2)
        self.assertEqual(cl.frame_at(508.5, 60), 31)
        self.assertEqual(cl.frame_at(0, 60), 0)

    def test_frame_grid_matches_build_render_args(self) -> None:
        clips = cl.relayout([
            {"id": "c1", "sourceId": "s1", "inMs": 0, "outMs": 1017, "speed": 2},
            {"id": "c2", "sourceId": "s1", "inMs": 2000, "outMs": 3017, "speed": 2},
        ])
        grid = cl.frame_grid(clips, 60)
        self.assertEqual([(g[0], g[1]) for g in grid], [(0, 31), (31, 30)])
        self.assertEqual(clips[1]["startMs"], 509)

    def test_simulate_splits_per_occurrence_and_mints_ids(self) -> None:
        doc = vs.screen_doc()
        out = cl.simulate(doc, [{"op": "cutSource", "sourceId": "s1", "fromMs": 1000, "toMs": 2000},
                                {"op": "speedSource", "sourceId": "s1", "fromMs": 5000, "toMs": 9000, "speed": 2}])
        self.assertEqual([(c["id"], c["inMs"], c["outMs"], c["speed"]) for c in out["clips"]],
                         [("c1", 0, 1000, 1), ("c2", 2000, 5000, 1), ("c3", 5000, 9000, 2), ("c4", 9000, 28000, 1)])

    def test_editmath_agrees_when_present(self) -> None:
        try:
            em = importlib.import_module("kblib.video.editmath")
        except ImportError:
            self.skipTest("kblib.video.editmath arrives with avk-kb")
        rng = random.Random(7)
        for _ in range(50):
            doc, _ = vs.random_doc(rng)
            clips = doc["clips"]
            self.assertEqual([c["startMs"] for c in em.relayout(clips)], [c["startMs"] for c in cl.relayout(clips)])
            for ms in (0, 8.3, 25.0, 508.5, 1234.5):
                self.assertEqual(em.frame_at(ms, 60), cl.frame_at(ms, 60))


class PropertyTests(unittest.TestCase):
    def test_random_docs(self) -> None:
        rng = random.Random(20261016)
        for case in range(150):
            doc, analyses = vs.random_doc(rng, sources=rng.choice([1, 1, 2]))
            preset = rng.choice(list(cl.PRESETS))
            with self.subTest(case=case, preset=preset):
                self.check(doc, analyses, preset)

    def check(self, doc, analyses, preset) -> None:
        p = cl.PRESETS[preset]
        before = copy.deepcopy(doc)
        result = cl.plan_cleanup(doc, analyses, preset=preset)
        self.assertEqual(doc, before, "the input doc must not change")
        after = result.doc
        images = cl.image_ids(doc)
        self.assertLessEqual(cl.total_ms(after["clips"], images), cl.total_ms(cl.relayout(doc["clips"]), images) + 1e-6)
        for op in result.ops:
            self.assertIsInstance(op["fromMs"], int)
            self.assertIsInstance(op["toMs"], int)
            if op["op"] == "speedSource":
                self.assertIn(op["speed"], cl.SPEED_MENU)
            for tap in doc["taps"]:
                if tap["sourceId"] == op["sourceId"]:
                    guard = (tap["sourceMs"] - p["tapBefore"], tap["sourceMs"] + p["tapAfter"])
                    self.assertFalse(op["fromMs"] < guard[1] and guard[0] < op["toMs"], (op, tap))
        for c in after["clips"]:
            self.assertIsInstance(c["inMs"], int)
            self.assertIsInstance(c["outMs"], int)
            if c.get("holdMs") is None:
                original = next(o for o in doc["clips"] if o["sourceId"] == c["sourceId"] and o["inMs"] <= c["inMs"] and c["outMs"] <= o["outMs"])
                if original["outMs"] - original["inMs"] >= cl.MIN_CLIP_SOURCE_MS:
                    self.assertGreaterEqual(c["outMs"] - c["inMs"], cl.MIN_CLIP_SOURCE_MS, c)
                self.assertTrue(c["speed"] in cl.SPEED_MENU, c)
        for tap in doc["taps"]:
            was = cl.occurrences(cl.relayout(doc["clips"]), tap["sourceId"], tap["sourceMs"])
            now = cl.occurrences(after["clips"], tap["sourceId"], tap["sourceMs"])
            self.assertEqual(len(now), len(was), tap)
        firsts = [c["id"] for c in after["clips"] if c["id"] in {o["id"] for o in doc["clips"]}]
        self.assertEqual(firsts, [o["id"] for o in doc["clips"] if o["id"] in firsts], "order kept")
        if result.capped is None:
            again = cl.plan_cleanup(after, analyses, preset=preset)
            self.assertEqual(again.ops, [], "idempotent")


def has_engine() -> bool:
    try:
        importlib.import_module("kblib.video.editdoc")
        importlib.import_module("kblib.video.commands")
    except ImportError:
        return False
    return hasattr(KbTestCase, "fake_cli")


def engine_project(case: KbTestCase) -> Path:
    """A git project holding the VFR fixture as assets/sim-checkout.mov, kb wired to the fake app CLI and real ffmpeg."""
    root = make_project(case.tmp, git=True)
    dest = root / "assets" / "sim-checkout.mov"
    shutil.copyfile(vs.screen_vfr(), dest)
    probe = {"kind": "video", "width": 360, "height": 784, "fps": 18.5, "rFps": 60, "avgFps": 18.5, "durationMs": 28000, "vfr": True}
    Path(str(dest) + ".probe.json").write_text(json.dumps(probe))
    case.fake_cli()  # type: ignore[attr-defined]
    ff, fp = vs.tools()  # type: ignore[misc]
    case.env.update({"KB_FFMPEG": ff, "KB_FFPROBE": fp})
    return root


@unittest.skipUnless(has_engine() and vs.tools(), "needs avk-kb's engine (editdoc, commands, fake_cli) and ffmpeg")
class CleanupCommandTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = engine_project(self)

    def test_dry_run_then_apply_then_no_op(self) -> None:
        dry = self.kb(["video", "cleanup", "assets/sim-checkout.mov", "--dry-run", "--json"], cwd=self.root)
        self.assertExit(dry, 0)
        data = json.loads(dry.stdout)
        self.assertEqual([(o["op"], o["fromMs"], o["toMs"]) for o in data["ops"]], [(o, a, b) for o, a, b, _ in GOLDEN["normal"]])
        self.assertFalse(data["applied"])
        self.assertTrue(data["sheet"])
        applied = self.kb(["video", "cleanup", "assets/sim-checkout.mov"], cwd=self.root)
        self.assertExit(applied, 0)
        self.assertIn("next:", applied.stdout)
        again = self.kb(["video", "cleanup", "sim-checkout", "--json"], cwd=self.root)
        self.assertExit(again, 0)
        self.assertEqual(json.loads(again.stdout)["ops"], [])
        emitted = self.kb(["video", "cleanup", "sim-checkout", "--emit-plan"], cwd=self.root)
        self.assertExit(emitted, 0)
        self.assertEqual(json.loads(emitted.stdout)["ops"], [])

    def test_taps_suggest_lists_without_adding(self) -> None:
        self.assertExit(self.kb(["video", "cleanup", "assets/sim-checkout.mov"], cwd=self.root), 0)
        out = self.kb(["video", "taps", "suggest", "sim-checkout", "--json"], cwd=self.root)
        self.assertExit(out, 0)
        rows = json.loads(out.stdout)["candidates"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["sourceMs"], 24967)
        doc = json.loads((self.root / "edits" / "sim-checkout.json").read_text())
        self.assertEqual(doc.get("taps") or [], [])


if __name__ == "__main__":
    unittest.main()
