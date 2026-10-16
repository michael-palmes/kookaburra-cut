from __future__ import annotations

import hashlib
import json
import random
import unittest
from pathlib import Path

from kblib.video import cleanup as cl
from kblib.video import fit as f

from . import video_synth as vs
from .helpers import KbTestCase, write_json
from .test_video_cleanup import engine_project, has_engine


def analyses():
    return {"s1": vs.screen_analysis()}


def tapped_doc():
    return vs.screen_doc(taps=[{"id": "t1", "sourceId": "s1", "sourceMs": 24967, "pos": [0.694, 0.383]}])


def on_grid(speed: float) -> bool:
    return abs(round(speed * 20) - speed * 20) < 1e-6


class ExactLengthTests(unittest.TestCase):
    def test_eight_seconds_lands_480_frames(self) -> None:
        res = f.fit(tapped_doc(), analyses(), 8000)
        self.assertTrue(res.exact)
        self.assertEqual(res.frames, 480)
        self.assertEqual(cl.total_frames(res.clips, 60), 480)
        guarded = [c for c in res.clips if c["inMs"] <= 24967 < c["outMs"]]
        self.assertTrue(guarded and all(c["speed"] <= f.GUARD_CAP for c in guarded))
        for c in res.clips:
            self.assertTrue(on_grid(c["speed"]), c)
            self.assertLessEqual(c["speed"], f.NORMAL_CAP)

    def test_cleanup_alone_when_it_lands(self) -> None:
        res = f.fit(tapped_doc(), analyses(), 20000)
        self.assertEqual(res.frames, 1200)
        self.assertTrue(all(c["speed"] == 1 for c in res.clips))

    def test_lengthen_holds_static_frames_then_the_end(self) -> None:
        res = f.fit(vs.screen_doc(), analyses(), 40000)
        self.assertEqual(res.frames, 2400)
        holds = [c for c in res.clips if c.get("holdMs") is not None]
        self.assertGreaterEqual(len(holds), 2)
        an = vs.screen_analysis()
        statics = [(iv["startMs"], iv["endMs"]) for iv in an["intervals"] if iv.get("sub") == "static"]
        for h in holds[:-1]:
            self.assertTrue(any(a <= h["inMs"] < b for a, b in statics), h)

    def test_strategies(self) -> None:
        trim = f.fit(vs.screen_doc(), analyses(), 32000, strategy="trim")
        self.assertTrue(trim.exact)
        with self.assertRaises(f.FitError) as err:
            f.fit(vs.screen_doc(), analyses(), 9000, strategy="trim")
        self.assertGreater(err.exception.minimum_ms, 9000)
        speed = f.fit(vs.screen_doc(), analyses(), 9000, strategy="speed")
        self.assertTrue(speed.exact)
        self.assertEqual(len({c["speed"] for c in speed.clips if c.get("holdMs") is None}) <= 3, True)
        hold = f.fit(vs.screen_doc(), analyses(), 33000, strategy="hold")
        self.assertTrue(hold.exact)
        self.assertTrue(all(c["speed"] == 1 for c in hold.clips))

    def test_infeasible_names_the_minimum(self) -> None:
        with self.assertRaises(f.FitError) as err:
            f.fit(tapped_doc(), analyses(), 1500)
        self.assertIsNotNone(err.exception.minimum_ms)
        self.assertGreater(err.exception.minimum_ms, 1500)
        self.assertAlmostEqual(f.minimum_length(tapped_doc(), analyses()), err.exception.minimum_ms, delta=600)

    def test_snap_prefers_the_menu(self) -> None:
        self.assertEqual(f.snap_speed(3.9), 4.0)
        self.assertEqual(f.snap_speed(2.15), 2.15)
        self.assertEqual(f.snap_speed(2.13), 2.15)
        self.assertEqual(f.snap_speed(1.02), 1.0)
        self.assertEqual(f.snap_speed(0.52), 0.5)

    def test_random_docs_land_exactly_or_refuse(self) -> None:
        rng = random.Random(42)
        landed = 0
        for case in range(300):
            doc, an = vs.random_doc(rng, sources=rng.choice([1, 2]))
            total = cl.total_ms(cl.relayout(doc["clips"]), set())
            target = total * rng.uniform(0.3, 2.0)
            strategy = rng.choice(["auto", "auto", "trim", "speed", "hold"])
            with self.subTest(case=case, strategy=strategy):
                try:
                    res = f.fit(doc, an, target, strategy=strategy)
                except f.FitError as e:
                    self.assertTrue(e.message)
                    continue
                landed += 1
                self.assertEqual(cl.total_frames(res.clips, cl.doc_fps(doc)), cl.frame_at(target, cl.doc_fps(doc)))
                ids = [c["id"] for c in res.clips]
                self.assertEqual(len(ids), len(set(ids)))
                for c in res.clips:
                    self.assertIsInstance(c["inMs"], int)
                    self.assertIsInstance(c["outMs"], int)
                    if c.get("holdMs") is not None:
                        self.assertGreaterEqual(c["holdMs"], cl.MIN_HOLD_MS)
                    else:
                        self.assertTrue(on_grid(c["speed"]), c)
                        self.assertLessEqual(c["speed"], f.HARD_CAP)
        self.assertGreater(landed, 200)


class AnchorTests(unittest.TestCase):
    def test_anchor_lands_within_half_a_frame(self) -> None:
        res = f.fit(tapped_doc(), analyses(), 10000, anchors=[("s1", 24967.0, 7000.0)])
        self.assertTrue(res.exact)
        t = f.anchor_time(res.clips, "s1", 24967)
        self.assertLessEqual(abs(t - 7000), 500 / 60)
        self.assertTrue(res.anchors[0]["ok"])

    def test_align_edit_side_keep_length(self) -> None:
        plan = f.align(tapped_doc(), analyses(), "s1", 24967, target_tl=20000, lead=f.TAP_LEAD_MS, keep_length=True)
        self.assertEqual(plan.side, "edit")
        self.assertEqual(plan.fit.frames, 1680)
        self.assertLessEqual(abs(f.anchor_time(plan.fit.clips, "s1", 24967) - (20000 - 83)), 500 / 60)

    def test_align_prefers_the_scene_start_when_it_fits(self) -> None:
        slot = {"startMs": 0, "followsMedia": False, "transitionOutStartMs": 27000, "sceneDurationMs": 28000}
        plan = f.align(tapped_doc(), analyses(), "s1", 24967, target_local=25500, slot=slot, lead=f.TAP_LEAD_MS)
        self.assertEqual((plan.side, plan.start_ms), ("scene", 450))
        far = f.align(tapped_doc(), analyses(), "s1", 24967, target_local=20000, slot=slot, lead=f.TAP_LEAD_MS)
        self.assertEqual(far.side, "edit")
        self.assertIn("startMs", far.notes[0])
        follows = dict(slot, followsMedia=True)
        edit = f.align(tapped_doc(), analyses(), "s1", 24967, target_local=25500, slot=follows, lead=f.TAP_LEAD_MS)
        self.assertEqual(edit.side, "edit")
        with self.assertRaises(f.FitError):
            f.align(tapped_doc(), analyses(), "s1", 24967, target_local=25500, slot=follows, lead=f.TAP_LEAD_MS, prefer="scene")

    def test_scene_shift_window(self) -> None:
        slot = {"startMs": 200, "followsMedia": False, "transitionOutStartMs": 7400}
        self.assertEqual(f.scene_shift(3000, 83, 2000, slot), (917, ""))
        self.assertIsNone(f.scene_shift(5000, 0, 2000, slot)[0])
        self.assertIsNone(f.scene_shift(1000, 0, 2000, slot)[0])
        self.assertIsNone(f.scene_shift(7500, 0, 6600, slot)[0])

    def test_random_anchors(self) -> None:
        rng = random.Random(9)
        hits = 0
        for case in range(200):
            doc, an = vs.random_doc(rng)
            clips = cl.relayout(doc["clips"])
            vids = [c for c in clips if c.get("holdMs") is None and c["outMs"] - c["inMs"] > 400]
            if not vids:
                continue
            c = rng.choice(vids)
            x = rng.randint(c["inMs"] + 150, c["outMs"] - 150)
            target = max(50.0, cl.timeline_at(c, x) * rng.uniform(0.4, 1.5))
            with self.subTest(case=case):
                try:
                    plan = f.align(doc, an, c["sourceId"], x, target_tl=target, keep_length=rng.random() < 0.5)
                except f.FitError:
                    continue
                hits += 1
                self.assertLessEqual(abs(f.anchor_time(plan.fit.clips, c["sourceId"], x) - target), 500 / cl.doc_fps(doc))
        self.assertGreater(hits, 120)


class BeatTests(KbTestCase):
    def test_scene_beats_read_the_app_cache(self) -> None:
        root = self.tmp / "p"
        (root / "assets").mkdir(parents=True)
        (root / "assets" / "song.mp3").write_bytes(b"not really audio")
        write_json(root / "project.json", {"scenes": [{"file": "scenes/01-a.tsx", "durationMs": 4000, "transition": {"type": "crossfade", "durationMs": 600}},
                                                      {"file": "scenes/02-b.tsx", "durationMs": 8000}],
                                           "audio": {"file": "assets/song.mp3", "startOffsetMs": 0}})
        cache = self.tmp / "beats"
        digest = hashlib.sha256(b"not really audio").hexdigest()
        write_json(cache / f"{digest}.json", {"version": 1, "bpm": 120, "beats": [500 * i for i in range(30)],
                                               "keyMoments": [{"tMs": 4400, "strength": 0.9}, {"tMs": 7400, "strength": 0.7}]})
        info = f.scene_beats(root, 1, lambda p: json.loads(Path(p).read_text()), cache_dir=cache)
        self.assertEqual(info["beats"][:3], [100, 600, 1100])
        self.assertEqual(f.pick_beat(info, "beat", 4), 1600)
        self.assertEqual(f.pick_beat(info, "moment", 1), 1000)
        with self.assertRaises(f.FitError):
            f.pick_beat(info, "moment", 9)
        with self.assertRaises(f.FitError):
            f.scene_beats(root, 1, lambda p: json.loads(Path(p).read_text()), cache_dir=self.tmp / "empty")


@unittest.skipUnless(has_engine() and vs.tools(), "needs avk-kb's engine and ffmpeg")
class FitCommandTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = engine_project(self)
        self.assertExit(self.kb(["video", "new", "assets/sim-checkout.mov"], cwd=self.root), 0)

    def test_fit_lands_exact_frames_and_applies(self) -> None:
        out = self.kb(["video", "fit", "sim-checkout", "--to", "8", "--dry-run", "--json"], cwd=self.root)
        self.assertExit(out, 0)
        data = json.loads(out.stdout)
        self.assertEqual((data["frames"], data["targetFrames"], data["exact"], data["applied"]), (480, 480, True, False))
        applied = self.kb(["video", "fit", "sim-checkout", "--to", "8", "--json"], cwd=self.root)
        self.assertExit(applied, 0)
        doc = json.loads((self.root / "edits" / "sim-checkout.json").read_text())
        self.assertEqual(cl.total_frames(cl.relayout(doc["clips"]), 60), 480)

    def test_align_moves_a_moment(self) -> None:
        out = self.kb(["video", "align", "sim-checkout", "--src", "24.967", "--at", "20", "--keep-length", "--json"], cwd=self.root)
        self.assertExit(out, 0)
        doc = json.loads((self.root / "edits" / "sim-checkout.json").read_text())
        t = f.anchor_time(cl.relayout(doc["clips"]), "s1", 24967)
        self.assertLessEqual(abs(t - 20000), 500 / 60)


if __name__ == "__main__":
    unittest.main()
