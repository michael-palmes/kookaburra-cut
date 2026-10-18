from __future__ import annotations

import json
import unittest
from typing import Any, Dict
from unittest import mock

from kblib import lock
from kblib.project import Project
from kblib.util import KbError
from kblib.video import repoint

from .helpers import FIXTURES, KbTestCase, read_json, video_project, write_json, write_probe

VECTORS = FIXTURES / "repoint-vectors.json"
ABSENT = object()


def pick(node: Any, path: str) -> Any:
    for part in path.split("."):
        if isinstance(node, list) and part.isdigit():
            node = node[int(part)] if int(part) < len(node) else ABSENT
        elif isinstance(node, dict):
            node = node.get(part, ABSENT)
        else:
            return ABSENT
        if node is ABSENT:
            return ABSENT
    return node


class RepointVectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.vectors = json.loads(VECTORS.read_text(encoding="utf-8"))

    def test_every_repoint_vector(self) -> None:
        problems = []
        for v in self.vectors["repoint"]:
            raw = json.loads(json.dumps(v["raw"]))
            out = repoint.apply_raw(raw, v["slot"], v["rel"], v["targetId"])
            if raw != v["raw"]:
                problems.append(f"{v['id']}: mutated its input")
            if v["expect"] is None:
                if out is not None:
                    problems.append(f"{v['id']}: re-pointed, the app re-points nothing")
                continue
            if out is None:
                problems.append(f"{v['id']}: re-pointed nothing")
                continue
            for path, want in v["expect"].items():
                got = pick(out, path)
                if want is None:
                    if got is not ABSENT:
                        problems.append(f"{v['id']} {path}: should be absent, is {json.dumps(got)}")
                elif got != want:
                    problems.append(f"{v['id']} {path}: {json.dumps(got)} != {json.dumps(want)}")
            touched = {p.split(".")[0] for p in v["expect"]}
            for key in v["raw"]:
                if key not in touched and out.get(key) != v["raw"][key]:
                    problems.append(f"{v['id']}: changed untouched {key}")
        self.assertEqual(problems, [], "\n".join(problems))

    def test_every_follow_vector(self) -> None:
        for v in self.vectors["follow"]:
            self.assertEqual(repoint.follow_media_sources(v["raw"]), v["expect"], v["id"])

    def test_every_follow_length_vector(self) -> None:
        self.assertGreater(len(self.vectors["followLength"]), 10)
        for v in self.vectors["followLength"]:
            slots = repoint.follow_media_slots(v["raw"])
            lengths = [{"src": s["src"], "lengthMs": repoint.follow_media_length_ms(s.get("spec"), v["probed"].get(s["src"], 0))} for s in slots]
            self.assertEqual(lengths, v["slots"], v["id"])
            self.assertEqual(repoint.follow_media_duration_ms(slots, v["probed"]), v["expect"], v["id"])

    def test_media_key_parse_mirrors_the_app(self) -> None:
        video = {"src": "assets/a.mp4", "kind": "video"}
        timed = dict(video, speed=2)
        self.assertIs(repoint.parse_media_keys(timed), timed)
        self.assertEqual(repoint.parse_media_keys(dict(video, inMs=1000.0)), dict(video, inMs=1000.0))
        self.assertEqual(repoint.parse_media_keys(dict(video, inMs=None, loop=None, speed=0)), video)
        self.assertEqual(repoint.parse_media_keys({"src": "assets/a.png", "kind": "image", "speed": 2}), {"src": "assets/a.png", "kind": "image"})
        self.assertEqual([k for k, _ in repoint.media_key_problems(dict(video, startMs=-1, inMs=10, outMs=20))], ["inMs"])
        self.assertEqual([k for k, _ in repoint.media_key_problems(dict(video, inMs=10, outMs=26))], ["outMs"])
        self.assertEqual(repoint.media_key_problems(dict(video, inMs=10, outMs=27)), [])

    def test_slot_media_ms(self) -> None:
        info = {"slot": "device", "ref": "device:phone", "scene": "02-hero", "startMs": 500, "timing": {"inMs": 1000, "speed": 2, "outMs": 9000}}
        self.assertEqual(repoint.slot_media_ms(info, 2500), 5000)
        self.assertEqual(repoint.slot_media_ms(dict(info, timing={}, startMs=-2000), 1000), 3000)
        self.assertEqual(repoint.slot_scene_ms(info, 5000), 2500)
        self.assertIsNone(repoint.slot_scene_ms(info, 9000))
        for bad, scene_ms in ((dict(info, startMs=3000), 1000), (info, 9000), (dict(info, timing={"loop": True}), 1000), (dict(info, slot="media", timing={}, loop=True), 1000),
                              (dict(info, startOn="open"), 1000), (dict(info, slot="background"), 1000)):
            with self.assertRaises(KbError):
                repoint.slot_media_ms(bad, scene_ms)


class RepointProjectTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = video_project(self.tmp)
        self.project = Project(self.root)
        self.fake_cli()
        write_probe(self.root / "assets" / "rec-edited.mp4", durationMs=7000)
        write_probe(self.root / "assets" / "bg.mp4", durationMs=2000)
        (self.root / "assets" / "shot.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 30)
        write_json(self.root / "scenes" / "02-hero.json", {
            "version": 1, "name": "Hero",
            "duration": {"mode": "follow-media"},
            "background": {"type": "video", "src": "assets/bg.mp4"},
            "devices": [
                {"id": "phone", "model": "iphone-duo", "media": {"src": "assets/rec.mp4", "kind": "video"}, "coverMedia": {"src": "assets/shot.png", "kind": "image"}},
                {"id": "tab", "model": "ipad-pro-13", "media": {"src": "assets/bg.mp4", "kind": "video"}},
            ],
            "compare": {"b": {}},
            "videoWindow": {"media": {"src": "assets/rec.mp4", "startMs": 300}},
            "camera": {"keys": [{"id": "k1", "tMs": 0}, {"id": "k2", "tMs": 9000}], "segments": [{"from": "k1", "to": "k2"}]},
        })

    def sidecar(self) -> Dict[str, Any]:
        return read_json(self.root / "scenes" / "02-hero.json")

    def test_every_slot_through_apply(self) -> None:
        rel = "assets/rec-edited.mp4"
        r = repoint.apply(self.project, "02-hero", "device", rel)
        self.assertEqual((r["targetId"], r["from"], r["written"]), ("phone", "assets/rec.mp4", True))
        repoint.apply(self.project, "1", "device:1", rel)
        self.assertEqual(self.sidecar()["devices"][1]["media"]["src"], rel)
        repoint.apply(self.project, "02-hero", "device-cover:phone", rel)
        self.assertEqual(self.sidecar()["devices"][0]["coverMedia"], {"src": rel, "kind": "video"})
        repoint.apply(self.project, "02-hero", "compare-device:tab", rel)
        self.assertEqual(self.sidecar()["compare"]["b"]["media"]["tab"]["src"], rel)
        repoint.apply(self.project, "02-hero", "compare-device-cover:phone", rel)
        self.assertEqual(self.sidecar()["compare"]["b"]["coverMedia"]["phone"]["kind"], "video")
        repoint.apply(self.project, "02-hero", "window", rel)
        doc = self.sidecar()
        self.assertNotIn("videoWindow", doc)
        self.assertEqual(doc["media"][0]["id"], "videoWindow")
        self.assertEqual(doc["media"][0]["video"], {})
        repoint.apply(self.project, "02-hero", "background", rel)
        self.assertEqual(self.sidecar()["background"], {"type": "video", "src": rel})
        self.assertEqual(self.sidecar()["camera"]["keys"][1]["tMs"], 9000)
        with self.assertRaises(KbError):
            repoint.apply(self.project, "02-hero", "device:gone", rel)
        with self.assertRaises(KbError):
            repoint.parse_slot("nonsense")

    def test_usages_auto_slot_and_info(self) -> None:
        used = repoint.usages(self.project, ["assets/rec.mp4"])
        self.assertEqual(sorted(u["ref"] for u in used), ["device:phone", "media:videoWindow"])
        with self.assertRaises(KbError) as cm:
            repoint.pick_slot(self.project, "02-hero", ["assets/rec.mp4"])
        self.assertIn("2 slots", cm.exception.message)
        self.assertEqual(repoint.pick_slot(self.project, "02-hero", ["assets/shot.png"]), ("device-cover", "phone"))
        with self.assertRaises(KbError):
            repoint.pick_slot(self.project, "02-hero", ["assets/none.mp4"])
        info = repoint.slot_info(self.project, "02-hero", "window")
        self.assertEqual((info["src"], info["startMs"], info["sceneDurationMs"], info["transitionOutStartMs"], info["sceneStartMs"]), ("assets/rec.mp4", 300, 3000, 2400, 2400))
        self.assertEqual((info["timing"], info["retimed"], info["loop"]), ({}, False, False))
        inherited = repoint.slot_info(self.project, "02-hero", "compare-device:phone")
        self.assertEqual(inherited["src"], "assets/rec.mp4")
        self.assertTrue(repoint.slot_info(self.project, "02-hero", "device:phone")["followsMedia"])

    def test_guarded_write_refuses_new_errors(self) -> None:
        with self.assertRaises(KbError) as cm:
            repoint.apply(self.project, "02-hero", "device:phone", "assets/missing-edited.mp4")
        self.assertIn("nothing written", cm.exception.message)
        self.assertEqual(self.sidecar()["devices"][0]["media"]["src"], "assets/rec.mp4")
        repoint.apply(self.project, "02-hero", "device:phone", "assets/missing-edited.mp4", force=True)
        self.assertEqual(self.sidecar()["devices"][0]["media"]["src"], "assets/missing-edited.mp4")

    def test_hash_checked_write_retries_on_change(self) -> None:
        path = self.root / "scenes" / "02-hero.json"
        calls = {"n": 0}

        real = lock.write_if_unchanged

        def racing(target: Any, base: Any, data: Any) -> bool:
            calls["n"] += 1
            if calls["n"] == 1:
                other = read_json(path)
                other["name"] = "Edited by the app"
                write_json(path, other)
            return real(target, base, data)

        with mock.patch.object(lock, "write_if_unchanged", side_effect=racing):
            repoint.apply(self.project, "02-hero", "device:phone", "assets/rec-edited.mp4")
        doc = self.sidecar()
        self.assertEqual(calls["n"], 2)
        self.assertEqual(doc["name"], "Edited by the app")
        self.assertEqual(doc["devices"][0]["media"]["src"], "assets/rec-edited.mp4")

    def test_resync_reports_overhang_without_clamping(self) -> None:
        repoint.apply(self.project, "02-hero", "device:phone", "assets/rec-edited.mp4")
        changes = repoint.resync_durations(self.project, ["assets/rec-edited.mp4"], write=False)
        self.assertEqual([(c["scene"], c["fromMs"], c["toMs"]) for c in changes], [("02-hero", 3000, 7000)])
        self.assertEqual(read_json(self.root / "project.json")["scenes"][1]["durationMs"], 3000)
        repoint.resync_durations(self.project, ["assets/rec-edited.mp4"])
        self.assertEqual(read_json(self.root / "project.json")["scenes"][1]["durationMs"], 7000)
        manifest = read_json(self.root / "project.json")
        manifest["scenes"][1]["durationMs"] = 9500
        write_json(self.root / "project.json", manifest)
        shrink = repoint.resync_durations(Project(self.root), None)
        self.assertEqual(shrink[0]["toMs"], 7000)
        self.assertEqual(shrink[0]["overhang"], ["camera key k2 at 9.00s"])
        self.assertEqual(self.sidecar()["camera"]["keys"][1]["tMs"], 9000)

    def test_set_follow(self) -> None:
        self.assertEqual(repoint.follow_spec("device:phone"), {"mode": "follow-media", "sourceDeviceId": "phone"})
        self.assertEqual(repoint.follow_spec("media:vid1"), {"mode": "follow-media", "source": "media", "sourceMediaId": "vid1"})
        self.assertEqual(repoint.follow_spec("window"), {"mode": "follow-media", "source": "videoWindow"})
        repoint.set_follow(self.project, "02-hero", "device:1")
        self.assertEqual(self.sidecar()["duration"], {"mode": "follow-media", "sourceDeviceId": "tab"})

    def test_set_start(self) -> None:
        r = repoint.set_start(self.project, "02-hero", "device:phone", 800)
        self.assertEqual((r["fromMs"], r["toMs"]), (0, 800))
        self.assertEqual(self.sidecar()["devices"][0]["media"]["startMs"], 800)
        repoint.set_start(self.project, "02-hero", "window", 0)
        self.assertEqual(self.sidecar()["media"][0]["video"], {})
        with self.assertRaises(KbError):
            repoint.set_start(self.project, "02-hero", "background", 100)
        with self.assertRaises(KbError):
            repoint.set_start(self.project, "02-hero", "device-cover:phone", 100)

    def test_set_start_negative_only_without_a_trim(self) -> None:
        repoint.set_start(self.project, "02-hero", "device:phone", -1200)
        self.assertEqual(self.sidecar()["devices"][0]["media"]["startMs"], -1200)
        doc = self.sidecar()
        doc["devices"][1]["media"]["inMs"] = 500
        write_json(self.root / "scenes" / "02-hero.json", doc)
        with self.assertRaises(KbError) as cm:
            repoint.set_start(self.project, "02-hero", "device:tab", -300)
        self.assertIn("inMs", cm.exception.message)
        repoint.set_start(self.project, "02-hero", "device:tab", 300)
        self.assertEqual(self.sidecar()["devices"][1]["media"], {"src": "assets/bg.mp4", "kind": "video", "inMs": 500, "startMs": 300})

    def test_timing_reported_and_followed(self) -> None:
        doc = self.sidecar()
        doc["devices"][0]["media"].update({"inMs": 1000, "outMs": 5000, "speed": 2, "startMs": 400, "loop": "yes"})
        doc["devices"][1]["media"] = {"src": "assets/bg.mp4", "kind": "video"}
        write_json(self.root / "scenes" / "02-hero.json", doc)
        write_probe(self.root / "assets" / "rec.mp4", durationMs=8000)
        used = {u["ref"]: u for u in repoint.usages(self.project, ["assets/rec.mp4"])}
        self.assertEqual(used["device:phone"]["timing"], {"inMs": 1000, "outMs": 5000, "speed": 2})
        self.assertTrue(used["device:phone"]["retimed"])
        self.assertFalse(used["media:videoWindow"]["retimed"])
        info = repoint.slot_info(self.project, "02-hero", "device:phone")
        self.assertEqual((info["timing"]["speed"], info["retimed"], info["startMs"]), (2, True, 400))
        changes = repoint.resync_durations(self.project, None, write=False)
        self.assertEqual([(c["scene"], c["toMs"]) for c in changes], [("02-hero", 2400)])
