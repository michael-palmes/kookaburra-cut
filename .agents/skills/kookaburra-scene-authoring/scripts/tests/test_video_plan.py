from __future__ import annotations

import copy
import unittest
from typing import Any, Dict

from kblib.util import KbError
from kblib.video import editmath as em
from kblib.video import plan

from .test_video_math import clip, doc


class GrammarTests(unittest.TestCase):
    def test_times(self) -> None:
        t = plan.parse_time
        self.assertEqual(t("2.5"), 2500)
        self.assertEqual(t("2500ms"), 2500)
        self.assertEqual(t("2.5s"), 2500)
        self.assertEqual(t("1:02.5"), 62500)
        self.assertEqual(t("1:00:01"), 3601000)
        self.assertAlmostEqual(t("f150", fps=60), 2500)
        self.assertEqual(t("end", total_ms=9000), 9000)
        self.assertEqual(t("end-2s", total_ms=9000), 7000)
        self.assertEqual(t("end-1.5", total_ms=9000), 7500)
        self.assertEqual(t(3), 3000)
        for bad in ("abc", "-1", "2.5x", "f10"):
            with self.assertRaises(KbError) as cm:
                t(bad)
            self.assertEqual(cm.exception.code, 2)
        with self.assertRaises(KbError):
            t("end-20s", total_ms=9000)

    def test_ranges_and_speed(self) -> None:
        r = plan.parse_range
        self.assertEqual(r("2-4"), (2000, 4000))
        self.assertEqual(r("1:02-1:05"), (62000, 65000))
        self.assertEqual(r("3s-end", total_ms=9000), (3000, 9000))
        self.assertEqual(r("end-5s-end", total_ms=9000), (4000, 9000))
        self.assertEqual(r("2.5..4"), (2500, 4000))
        with self.assertRaises(KbError):
            r("4-2")
        self.assertEqual(plan.parse_speed("0.5x"), 0.5)
        with self.assertRaises(KbError):
            plan.parse_speed("0")
        self.assertEqual(plan.parse_pair("0.5, 0.25", "--pos"), [0.5, 0.25])
        with self.assertRaises(KbError):
            plan.parse_pair("1,2,3", "--pos")

    def test_source_times_and_ranges(self) -> None:
        d = doc([clip("c1", 0, 4000)])
        self.assertEqual(plan.parse_src(d, "s1@1.5"), ("s1", 1500))
        with self.assertRaises(KbError):
            plan.parse_src(d, "1.5")
        self.assertEqual(plan.parse_src_range(d, "s1:2-4@2x"), {"sourceId": "s1", "fromMs": 2000, "toMs": 4000, "speed": 2.0})
        one = dict(d, sources=d["sources"][:1])
        self.assertEqual(plan.parse_src(one, "1.5"), ("s1", 1500))
        self.assertEqual(plan.parse_src_range(one, "1:02-1:03"), {"sourceId": "s1", "fromMs": 62000, "toMs": 63000})

    def test_selectors(self) -> None:
        d = doc([clip("c1", 0, 4000), clip("c3", 6000, 10000, 2)])
        self.assertEqual(plan.select_clip(d, "c3")["id"], "c3")
        self.assertEqual(plan.select_clip(d, "0")["id"], "c1")
        self.assertEqual(plan.select_clip(d, "last")["id"], "c3")
        self.assertEqual(plan.select_clip(d, "first")["id"], "c1")
        self.assertEqual(plan.select_clip(d, "@4.5")["id"], "c3")
        self.assertEqual(plan.select_clip(d, "@end")["id"], "c3")
        with self.assertRaises(KbError) as cm:
            plan.select_clip(d, "c9")
        self.assertIn("c1, c3", cm.exception.message)
        self.assertEqual(plan.select_source(d, "assets/shot.png")["id"], "s2")
        self.assertEqual(plan.first_occurrence(d, "s1", 7000), 4500)
        self.assertIsNone(plan.first_occurrence(d, "s1", 5000))


class PlanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.doc = doc([clip("c1", 0, 10000)])

    def test_all_or_nothing(self) -> None:
        before = copy.deepcopy(self.doc)
        with self.assertRaises(plan.PlanError) as cm:
            plan.run_plan(self.doc, [{"op": "split", "atMs": 1000}, {"op": "removeClip", "clipId": "c9"}])
        self.assertEqual(cm.exception.index, 1)
        self.assertEqual(cm.exception.op_code, "unknown-clip")
        self.assertIn("nothing was changed", cm.exception.message)
        self.assertEqual(self.doc, before)

    def test_ops_see_the_doc_as_it_stands_and_labels(self) -> None:
        out, reports = plan.run_plan(self.doc, [
            {"op": "split", "atMs": 4000, "as": "right"},
            {"op": "setSpeed", "clipId": "$right", "speed": 2},
            {"op": "freeze", "atMs": 7000, "as": "hold"},
            {"op": "setHold", "clipId": "$hold", "holdMs": 500},
            {"op": "addTap", "atMs": 1000, "pos": [0.5, 0.5], "as": "tap"},
            {"op": "moveTap", "tapId": "$tap", "pos": [0.1, 0.1]},
            {"op": "setSpeed", "clipId": "first", "speed": 1.5},
        ])
        self.assertEqual([c["id"] for c in out["clips"]], ["c1", "c2", "c3"])
        self.assertEqual(out["clips"][1]["speed"], 2)
        self.assertEqual(out["clips"][2]["holdMs"], 500)
        self.assertEqual(out["clips"][0]["speed"], 1.5)
        self.assertEqual(out["taps"][0]["pos"], [0.1, 0.1])
        self.assertEqual([r["created"] for r in reports][:3], ["c2", None, "c3"])
        self.assertEqual(reports[0]["detail"], "at 4.000s")
        with self.assertRaises(plan.PlanError):
            plan.run_plan(self.doc, [{"op": "setSpeed", "clipId": "$nope", "speed": 2}])
        with self.assertRaises(plan.PlanError):
            plan.run_plan(self.doc, [{"op": "setSpeed", "clipId": "c1", "speed": 2, "as": "x"}])

    def test_source_paths_go_through_probe(self) -> None:
        meta = {"rel": "assets/b.mp4", "kind": "video", "width": 10, "height": 10, "fps": 30, "durationMs": 3000}
        out, _r = plan.run_plan(self.doc, [{"op": "addClip", "source": "assets/b.mp4"}], probe=lambda rel: dict(meta, rel=rel))
        self.assertEqual(out["sources"][-1]["rel"], "assets/b.mp4")
        with self.assertRaises(plan.PlanError):
            plan.run_plan(self.doc, [{"op": "addClip", "source": "assets/b.mp4"}])

    def test_normalise_plan(self) -> None:
        self.assertEqual(plan.normalise_plan([{"op": "split", "atMs": 1}]), ([{"op": "split", "atMs": 1}], None))
        self.assertEqual(plan.normalise_plan({"baseHash": "ab", "ops": []}), ([], "ab"))
        with self.assertRaises(KbError):
            plan.normalise_plan({"ops": "x"})


class RangeOpTests(unittest.TestCase):
    def spans(self, d: Dict[str, Any]) -> Any:
        return [(c["id"], c["inMs"], c["outMs"], c["speed"]) for c in d["clips"]]

    def test_cut_splits_and_snaps(self) -> None:
        d = doc([clip("c1", 0, 10000), clip("c2", 2000, 5000)])
        out, notes = plan.cut_source(d, {"op": "cutSource", "sourceId": "s1", "fromMs": 3000, "toMs": 4000})
        self.assertEqual(self.spans(out), [("c1", 0, 3000, 1), ("c3", 4000, 10000, 1), ("c2", 2000, 3000, 1), ("c4", 4000, 5000, 1)])
        out, notes = plan.cut_source(d, {"op": "cutSource", "sourceId": "s1", "fromMs": 50, "toMs": 9950, "clipId": "c1"})
        self.assertEqual(self.spans(out), [("c2", 2000, 5000, 1)])
        self.assertEqual(len(notes), 3)
        self.assertIn("snapped", notes[0])
        out, _n = plan.cut_source(d, {"op": "cutSource", "sourceId": "s1", "fromMs": 5000, "toMs": 5010, "clipId": "c1"})
        self.assertEqual(self.spans(out)[:2], [("c1", 0, 5000, 1), ("c3", 5010, 10000, 1)])
        with self.assertRaises(plan.OpError) as cm:
            plan.cut_source(d, {"op": "cutSource", "sourceId": "s1", "fromMs": 20000, "toMs": 30000})
        self.assertEqual(cm.exception.code, "no-clip")
        with self.assertRaises(plan.OpError):
            plan.cut_source(d, {"op": "cutSource", "sourceId": "s9", "fromMs": 0, "toMs": 1})

    def test_speed_source_and_keep(self) -> None:
        d = doc([clip("c1", 0, 10000)])
        out, _n = plan.speed_source(d, {"op": "speedSource", "sourceId": "s1", "fromMs": 2000, "toMs": 6000, "speed": 4})
        self.assertEqual(self.spans(out), [("c1", 0, 2000, 1), ("c2", 2000, 6000, 4), ("c3", 6000, 10000, 1)])
        self.assertEqual(em.timeline_duration_ms(out["clips"]), 7000)
        frozen = doc([clip("c1", 0, 10000), clip("c2", 9000, 9000, holdMs=1000), clip("c3", 1000, 1000, holdMs=500)])
        out, notes = plan.keep_ranges(frozen, {"op": "keep", "ranges": [{"sourceId": "s1", "fromMs": 6000, "toMs": 9500, "speed": 2}, {"sourceId": "s1", "fromMs": 1000, "toMs": 3000}]})
        self.assertEqual(self.spans(out), [("c1", 1000, 3000, 1), ("c4", 6000, 9500, 2), ("c2", 9000, 9000, 1), ("c3", 1000, 1000, 1)])
        self.assertFalse(any("removed freeze" in n for n in notes))
        out, notes = plan.keep_ranges(frozen, {"op": "keep", "ranges": [{"sourceId": "s1", "fromMs": 5000, "toMs": 6000}]})
        self.assertEqual([c["id"] for c in out["clips"]], ["c1"])
        self.assertTrue(any("removed freeze" in n for n in notes))
        with self.assertRaises(plan.OpError):
            plan.keep_ranges(frozen, {"op": "keep", "ranges": []})

    def test_timeline_ranges_map_per_clip_latest_first(self) -> None:
        d = doc([clip("c1", 0, 10000, 2), clip("c2", 0, 0, holdMs=1000)])
        ops = plan.timeline_ranges_to_source(d, [(1000, 2000), (3000, 4000), (5500, 5700)])
        self.assertEqual([(o["op"], o.get("fromMs"), o.get("toMs")) for o in ops], [("cutSource", 6000, 8000), ("cutSource", 2000, 4000), ("setHold", None, None)])
        out, _r = plan.run_plan(d, ops)
        self.assertEqual(em.timeline_duration_ms(out["clips"]), 3000 + 800)


if __name__ == "__main__":
    unittest.main()
