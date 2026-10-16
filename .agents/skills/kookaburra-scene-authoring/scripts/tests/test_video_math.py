from __future__ import annotations

import copy
import json
import unittest
from typing import Any, Dict, List

from kblib.video import editmath as em
from kblib.video.editops import OpError, apply_op


def clip(cid: str, a: int, b: int, speed: float = 1, sid: str = "s1", **extra: Any) -> Dict[str, Any]:
    out = {"id": cid, "sourceId": sid, "inMs": a, "outMs": b, "speed": speed, "startMs": 0}
    out.update(extra)
    return out


def doc(clips: List[Dict[str, Any]], **extra: Any) -> Dict[str, Any]:
    d: Dict[str, Any] = {
        "version": 1,
        "name": "demo",
        "sources": [
            {"id": "s1", "rel": "assets/rec.mp4", "kind": "video", "width": 1920, "height": 1080, "fps": 30, "durationMs": 10000},
            {"id": "s2", "rel": "assets/shot.png", "kind": "image", "width": 800, "height": 600, "fps": 0, "durationMs": 0},
        ],
        "settings": {"width": 1920, "height": 1080, "fps": 60},
        "clips": em.relayout(clips),
    }
    d.update(extra)
    return d


SOURCE = {"rel": "assets/other.mp4", "kind": "video", "width": 1280, "height": 720, "fps": 30, "durationMs": 4000}
STILL = {"rel": "assets/shot.png", "kind": "image", "width": 800, "height": 600, "fps": 0, "durationMs": 0}


class JsRoundTests(unittest.TestCase):
    def test_half_up_like_math_round(self) -> None:
        self.assertEqual(em.js_round(2.5), 3)
        self.assertEqual(em.js_round(-2.5), -2)
        self.assertEqual(em.js_round(-2.6), -3)
        self.assertEqual(em.js_round(0.49999999999999994), 0)
        self.assertEqual(em.js_round(508.5), 509)
        self.assertEqual(em.js_round(1.5), 2)
        self.assertNotEqual(round(2.5), em.js_round(2.5))
        self.assertIsInstance(em.js_round(3.0), int)
        self.assertEqual(em.js_round(7), 7)

    def test_frame_grid_is_half_up_and_cumulative(self) -> None:
        self.assertEqual(em.frame_at(508.5, 60), 31)
        self.assertEqual(em.frame_at(25, 60), 2)
        clips = em.relayout([clip("c1", 0, 1017, 2), clip("c2", 2000, 2508)])
        frames = em.clip_frames(clips, 60)
        self.assertEqual(sum(n for _s, n in frames), em.frame_at(em.timeline_duration_ms(clips), 60))
        self.assertEqual(em.total_frames(clips, 60), 61)

    def test_effective_speed(self) -> None:
        self.assertEqual(em.effective_speed(0), 1)
        self.assertEqual(em.effective_speed(-2), 1)
        self.assertEqual(em.effective_speed(float("nan")), 1)
        self.assertEqual(em.effective_speed(1.5), 1.5)

    def test_sum_is_a_left_fold(self) -> None:
        clips = [clip(f"c{i}", 0, 100 + i, 3) for i in range(1, 30)]
        total = 0
        for c in clips:
            total = total + em.clip_timeline_ms(c)
        self.assertEqual(em.timeline_duration_ms(clips), total)


class EditMathTests(unittest.TestCase):
    def test_relayout_never_mutates(self) -> None:
        clips = [clip("c1", 0, 1000, 2), clip("c2", 0, 999)]
        before = copy.deepcopy(clips)
        laid = em.relayout(clips)
        self.assertEqual(clips, before)
        self.assertEqual([c["startMs"] for c in laid], [0, 500])

    def test_split_respects_the_floor(self) -> None:
        clips = em.relayout([clip("c1", 0, 1000)])
        self.assertIsNone(em.split_at(clips, 50, "c2"))
        self.assertIsNone(em.split_at(clips, 950, "c2"))
        self.assertIsNone(em.split_at(clips, 1000, "c2"))
        out = em.split_at(clips, 400, "c2")
        self.assertEqual([(c["id"], c["inMs"], c["outMs"]) for c in out], [("c1", 0, 400), ("c2", 400, 1000)])

    def test_freeze_slips_to_an_edge_near_the_floor(self) -> None:
        clips = em.relayout([clip("c1", 0, 1000)])
        head = em.freeze_at(clips, 50, 2000)
        self.assertEqual([c["id"] for c in head], ["c2", "c1"])
        tail = em.freeze_at(clips, 950, 2000)
        self.assertEqual([c["id"] for c in tail], ["c1", "c2"])
        mid = em.freeze_at(clips, 500, 50)
        self.assertEqual([c["id"] for c in mid], ["c1", "c2", "c3"])
        self.assertEqual(mid[1]["holdMs"], em.MIN_HOLD_MS)
        self.assertIsNone(em.freeze_at(mid, mid[1]["startMs"] + 10, 1000))
        end = em.freeze_at_end(clips, 60, 2000)
        self.assertEqual(end[-1]["inMs"], 983)

    def test_insert_clip_at_edges(self) -> None:
        clips = em.relayout([clip("c1", 0, 1000), clip("c2", 0, 150)])
        new = clip("c3", 0, 500, sid="s9")
        self.assertEqual([c["id"] for c in em.insert_clip_at(clips, 50, new)], ["c3", "c1", "c2"])
        self.assertEqual([c["id"] for c in em.insert_clip_at(clips, 950, new)], ["c1", "c3", "c2"])
        self.assertEqual([c["id"] for c in em.insert_clip_at(clips, 1000, new)], ["c1", "c3", "c2"])
        self.assertEqual([c["id"] for c in em.insert_clip_at(clips, 1150, new)], ["c1", "c2", "c3"])
        split = em.insert_clip_at(clips, 500, new)
        self.assertEqual([c["id"] for c in split], ["c1", "c3", "c4", "c2"])
        short = em.relayout([clip("c1", 0, 150)])
        self.assertEqual([c["id"] for c in em.insert_clip_at(short, 70, new)], ["c3", "c1"])
        self.assertEqual([c["id"] for c in em.insert_clip_at(short, 80, new)], ["c1", "c3"])
        frozen = em.relayout([clip("c1", 0, 0, holdMs=1000)])
        self.assertEqual([c["id"] for c in em.insert_clip_at(frozen, 499, new)], ["c3", "c1"])
        self.assertEqual([c["id"] for c in em.insert_clip_at(frozen, 500, new)], ["c1", "c3"])

    def test_ids_are_ascii_and_collision_checked(self) -> None:
        self.assertEqual(em.next_prefixed_id("c", ["c1", "c3", "c٣"]), "c4")
        self.assertEqual(em.next_prefixed_id("c", ["c1\n"]), "c1")
        self.assertEqual(em.next_prefixed_id("t", ["t2", "t3"]), "t4")
        self.assertEqual(em.next_prefixed_id("m", []), "m1")

    def test_trims_clamp(self) -> None:
        clips = em.relayout([clip("c1", 200, 1000)])
        self.assertEqual(em.trim_clip_in(clips, "c1", 950)[0]["inMs"], 900)
        self.assertEqual(em.trim_clip_in(clips, "c1", -50)[0]["inMs"], 0)
        self.assertEqual(em.trim_clip_out(clips, "c1", 120, 5000)[0]["outMs"], 300)
        self.assertEqual(em.trim_clip_out(clips, "c1", 9000, 5000)[0]["outMs"], 5000)

    def test_output_to_source_and_tap_windows(self) -> None:
        clips = em.relayout([clip("c1", 0, 1000, 2), clip("c2", 500, 900)])
        hit = em.output_to_source(clips, 250.4)
        self.assertEqual((hit["sourceId"], hit["sourceMs"], hit["clip"]["id"]), ("s1", 501, "c1"))
        self.assertIsNone(em.output_to_source(clips, 2000))
        windows = em.tap_windows(clips, {"id": "t1", "sourceId": "s1", "sourceMs": 600, "pos": [0, 0]})
        self.assertEqual(windows, [{"startMs": 300.0, "endMs": 500.0}, {"startMs": 600.0, "endMs": 900.0}])


class MaskMathTests(unittest.TestCase):
    def test_clamps(self) -> None:
        self.assertEqual(em.clamp_rect([0.95, -0.2, 0.5, 0.001]), [0.5, 0, 0.5, 0.01])
        self.assertEqual(em.rect_from_corners([0.6, 0.6], [0.2, 0.1]), [0.2, 0.1, 0.39999999999999997, 0.5])
        r = em.default_mask_rect([0.5, 0.5], {"width": 1920, "height": 1080})
        self.assertAlmostEqual(r[2], 0.35 * 1080 / 1920)
        self.assertEqual(em.mask_block_px({}, {"width": 1920, "height": 1080}), 2 * em.js_round(0.0625 * 1080 / 2))
        self.assertEqual(em.mask_blur_sigma_px({"strength": 2}, {"width": 100, "height": 100}), 4.0)

    def test_tolerance_and_keys(self) -> None:
        self.assertAlmostEqual(em.key_tolerance_ms(60, 2), 500 / 60 * 2)
        self.assertEqual(em.key_tolerance_ms(0, 0), 500 / 60)
        mask = {"id": "m1", "sourceId": "s1", "style": "solid", "startMs": 0, "endMs": 3000, "keys": [{"sourceMs": 1000, "rect": [0.1, 0.1, 0.2, 0.2]}]}
        same = em.upsert_mask_key(mask, 1008, [0.5, 0.5, 0.2, 0.2], 8.4, False)
        self.assertEqual(len(same["keys"]), 1)
        added = em.upsert_mask_key(mask, 1009, [0.5, 0.5, 0.2, 0.2], 8.4, False)
        self.assertEqual([k["sourceMs"] for k in added["keys"]], [1000, 1009])
        self.assertIs(em.add_hold_key(mask, 1000, 1), mask)
        self.assertIs(em.remove_mask_key(mask, 1000, 1), mask)
        glide = em.add_hold_key(added, 1004, 0.1)
        self.assertEqual(len(glide["keys"]), 3)
        self.assertEqual(em.sample_mask_rect(added["keys"], 0), [0.1, 0.1, 0.2, 0.2])
        moved = em.offset_mask_keys(added, 5, -5)
        self.assertEqual([k["rect"][:2] for k in moved["keys"]], [[0.4, 0.0], [0.8, 0.4]])
        self.assertEqual(mask["keys"][0]["rect"], [0.1, 0.1, 0.2, 0.2])

    def test_prune_returns_the_same_list_when_nothing_drops(self) -> None:
        clips = em.relayout([clip("c1", 0, 1000)])
        masks = [{"id": "m1", "sourceId": "s1", "style": "solid", "startMs": 0, "endMs": 500, "keys": [{"sourceMs": 0, "rect": [0, 0, 0.1, 0.1]}]}]
        sources = [{"id": "s1", "kind": "video"}]
        self.assertIs(em.prune_orphan_masks(clips, masks, sources), masks)
        self.assertEqual(em.prune_orphan_masks(em.relayout([clip("c1", 600, 1000)]), masks, sources), [])

    def test_retime_edge_and_rows(self) -> None:
        mask = {"id": "m1", "sourceId": "s1", "startMs": 1000, "endMs": 2000, "keys": []}
        self.assertEqual(em.retime_mask_edge(mask, "start", 1950.4, 0)["startMs"], 1900)
        self.assertEqual(em.retime_mask_edge(mask, "end", 99999, 5000)["endMs"], 5000)
        self.assertEqual(em.retime_mask_edge(mask, "end", 99999, 0)["endMs"], 99999)
        rows = em.pack_mask_rows({"m1": [{"startMs": 0, "endMs": 10}], "m2": [{"startMs": 5, "endMs": 20}], "m3": [{"startMs": 10, "endMs": 30}]})
        self.assertEqual(rows, {"m1": 0, "m2": 1, "m3": 0})


class EditOpsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.doc = doc([clip("c1", 0, 4000), clip("c2", 6000, 10000, 2)])
        self.snapshot = json.dumps(self.doc, sort_keys=True)

    def tearDown(self) -> None:
        self.assertEqual(json.dumps(self.doc, sort_keys=True), self.snapshot, "an op mutated its input")

    def code(self, op: Dict[str, Any]) -> str:
        with self.assertRaises(OpError) as cm:
            apply_op(self.doc, op)
        return cm.exception.code

    def test_clip_ops(self) -> None:
        r = apply_op(self.doc, {"op": "split", "atMs": 1000})
        self.assertEqual((r.label, r.created), ("split clip", "c3"))
        self.assertEqual(self.code({"op": "split", "atMs": 50}), "no-split")
        r = apply_op(self.doc, {"op": "freeze", "atMs": 6000, "holdMs": 500})
        self.assertEqual(r.created, "c3")
        self.assertEqual(r.doc["clips"][-1]["holdMs"], 500)
        self.assertEqual(self.code({"op": "freeze", "atMs": 99999}), "no-clip")
        frozen = apply_op(self.doc, {"op": "freeze", "atMs": 1000}).doc
        with self.assertRaises(OpError) as cm:
            apply_op(frozen, {"op": "freeze", "atMs": 1500})
        self.assertEqual(cm.exception.code, "no-freeze")
        self.assertEqual(apply_op(self.doc, {"op": "removeClip", "clipId": "c1"}).doc["clips"][0]["startMs"], 0)
        self.assertEqual(self.code({"op": "removeClip", "clipId": "c9"}), "unknown-clip")
        self.assertEqual([c["id"] for c in apply_op(self.doc, {"op": "moveClip", "from": 0, "to": 1}).doc["clips"]], ["c2", "c1"])
        self.assertEqual(apply_op(self.doc, {"op": "moveClip", "from": 1, "to": 1}).label, "reorder clip")
        self.assertEqual(self.code({"op": "moveClip", "from": 5, "to": 1}), "bad-arg")
        self.assertEqual(self.code({"op": "setSpeed", "clipId": "c1", "speed": -3}), "bad-arg")
        self.assertEqual(apply_op(self.doc, {"op": "trimIn", "clipId": "c2", "inMs": 7000.6}).doc["clips"][1]["inMs"], 7001)
        self.assertEqual(apply_op(self.doc, {"op": "trimOut", "clipId": "c1", "outMs": 50000}).doc["clips"][0]["outMs"], 10000)
        self.assertEqual(self.code({"op": "setHold", "clipId": "c1", "holdMs": 100}), "bad-arg")
        self.assertEqual(self.code({"op": "nope"}), "bad-arg")

    def test_add_and_insert_reuse_sources_by_rel(self) -> None:
        r = apply_op(self.doc, {"op": "addClip", "source": SOURCE})
        self.assertEqual(r.doc["sources"][-1]["id"], "s3")
        self.assertEqual(r.doc["clips"][-1]["outMs"], 4000)
        r = apply_op(self.doc, {"op": "addClip", "source": STILL, "index": 0})
        self.assertEqual(len(r.doc["sources"]), 2)
        self.assertEqual(r.doc["clips"][0]["holdMs"], em.DEFAULT_HOLD_MS)
        r = apply_op(self.doc, {"op": "insertClip", "source": SOURCE, "atMs": 2000})
        self.assertEqual([c["id"] for c in r.doc["clips"]], ["c1", "c3", "c4", "c2"])
        self.assertEqual(r.created, "c3")

    def test_tap_ops(self) -> None:
        r = apply_op(self.doc, {"op": "addTap", "atMs": 4500, "pos": [0.2, 0.3]})
        self.assertEqual(r.doc["taps"], [{"id": "t1", "sourceId": "s1", "sourceMs": 7000, "pos": [0.2, 0.3]}])
        d = r.doc
        self.assertEqual(apply_op(d, {"op": "retimeTap", "tapId": "t1", "atMs": 100}).doc["taps"][0]["sourceMs"], 100)
        self.assertEqual(apply_op(d, {"op": "moveTap", "tapId": "t1", "pos": [1, 1]}).doc["taps"][0]["pos"], [1, 1])
        self.assertEqual(apply_op(d, {"op": "removeTap", "tapId": "t1"}).doc["taps"], [])
        self.assertEqual(self.code({"op": "removeTap", "tapId": "t1"}), "unknown-tap")
        self.assertEqual(self.code({"op": "addTap", "atMs": 99999, "pos": [0, 0]}), "no-clip")
        look = apply_op(d, {"op": "setTapLook", "style": "ring", "size": 2})
        self.assertEqual((look.doc["tapStyle"], look.doc["tapSize"]), ("ring", 2))
        self.assertEqual(self.code({"op": "addTapAtSource", "sourceId": "s1", "sourceMs": 3.6, "pos": [0, 0]}), "bad-arg")
        self.assertEqual(apply_op(self.doc, {"op": "addTapAtSource", "sourceId": "s1", "sourceMs": 4.0, "pos": [0, 0]}).doc["taps"][0]["sourceMs"], 4)
        self.assertEqual(self.code({"op": "addTapAtSource", "sourceId": "s2", "sourceMs": 0, "pos": [0, 0]}), "image-source")
        self.assertEqual(self.code({"op": "addTap", "atMs": 100, "pos": [1.5, 0]}), "bad-arg")

    def test_mask_ops_and_pruning(self) -> None:
        r = apply_op(self.doc, {"op": "addMask", "atMs": 1000, "rect": [0.1, 0.1, 0.2, 0.1], "style": "blur", "strength": 0.7})
        mask = r.doc["masks"][0]
        self.assertEqual((mask["startMs"], mask["endMs"], mask["style"], mask["strength"]), (1000, 4000, "blur", 0.7))
        d = r.doc
        keyed = apply_op(d, {"op": "setMaskRect", "maskId": "m1", "atMs": 2000, "rect": [0.5, 0.5, 0.2, 0.1]}).doc
        self.assertEqual([k["sourceMs"] for k in keyed["masks"][0]["keys"]], [1000, 2000])
        self.assertEqual(self.code({"op": "addMaskKey", "maskId": "m9", "atMs": 0}), "unknown-mask")
        self.assertEqual(len(apply_op(d, {"op": "addMaskKey", "maskId": "m1", "atMs": 1500}).doc["masks"][0]["keys"]), 2)
        with self.assertRaises(OpError) as cm:
            apply_op(d, {"op": "addMaskKey", "maskId": "m1", "atMs": 1000})
        self.assertEqual(cm.exception.code, "no-change")
        cleared = apply_op(d, {"op": "setMaskLook", "maskId": "m1", "strength": None, "color": "#ff0000"}).doc["masks"][0]
        self.assertNotIn("strength", cleared)
        self.assertEqual(cleared["color"], "#ff0000")
        cut = apply_op(d, {"op": "removeClip", "clipId": "c1"})
        self.assertEqual(cut.pruned, ("m1",))
        self.assertEqual(cut.doc["masks"], [])

    def test_mask_moment_on_another_source(self) -> None:
        d = doc([clip("c1", 0, 4000), clip("c2", 0, 0, sid="s2", holdMs=2000)])
        r = apply_op(d, {"op": "addMask", "atMs": 1000, "rect": [0.1, 0.1, 0.2, 0.1]})
        with self.assertRaises(OpError) as cm:
            apply_op(r.doc, {"op": "setMaskRect", "maskId": "m1", "atMs": 5000, "rect": [0.1, 0.1, 0.2, 0.1]})
        self.assertEqual(cm.exception.code, "source-mismatch")
        still = apply_op(d, {"op": "addMask", "atMs": 4500, "rect": [0.1, 0.1, 0.2, 0.1]}).doc["masks"][0]
        self.assertEqual((still["startMs"], still["endMs"], still["keys"][0]["sourceMs"]), (0, 0, 0))
        with self.assertRaises(OpError) as cm:
            apply_op(dict(d, masks=[still]), {"op": "addMaskKey", "maskId": still["id"], "atMs": 4500})
        self.assertEqual(cm.exception.code, "image-source")


if __name__ == "__main__":
    unittest.main()
