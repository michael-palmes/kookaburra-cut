from __future__ import annotations

import json
import shutil
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional

from kblib.camera import cli as camcli
from kblib.camera import rules
from kblib.film import pacing as pc
from kblib.project import Project

from .helpers import FIXTURES, SCRIPTS, KbTestCase, make_project, read_json, write_json

HISTORY = FIXTURES / "camera"
UNVEIL = SCRIPTS.parents[3] / "projects" / "unveil"


def key(kid: str, t: float, position: List[float], at: List[float], **extra: Any) -> Dict[str, Any]:
    return {"id": kid, "tMs": t, "pose": {"position": position, "aim": {"mode": "point", "at": at}, **extra}}


def rig(keys: List[Dict[str, Any]], segments: List[Dict[str, Any]], **extra: Any) -> Dict[str, Any]:
    return {"version": 1, "cameraMode": "rig", "cameraRig": {"keys": keys, "segments": segments}, **extra}


def phone(did: str, position: List[float], rotation: Optional[List[float]] = None) -> Dict[str, Any]:
    return {"id": did, "model": "iphone-17-pro", "placement": {"position": position, "rotationDeg": rotation or [0, 0, 0]}}


def warnings_of(project: Path) -> List[Dict[str, Any]]:
    return camcli.run(Project(project))["issues"]


class UnveilHistoryTests(KbTestCase):
    def history(self, name: str) -> List[Dict[str, Any]]:
        dst = self.tmp / name
        shutil.copytree(HISTORY / name, dst)
        return warnings_of(dst)

    @unittest.skipUnless((UNVEIL / "project.json").is_file(), "the bundled Unveil template is not in this checkout")
    def test_todays_unveil_is_clean(self) -> None:
        self.assertEqual(warnings_of(UNVEIL), [])

    def test_round_15_glimpses_wobble_and_sway(self) -> None:
        found = [i for i in self.history("round-15") if i["scene"] == "03-glimpses"]
        wobble = [i for i in found if i["kind"] == "wobble"]
        self.assertEqual(len(wobble), 1)
        self.assertIn("-18°, +19°, -19°, +19°", wobble[0]["message"])
        sways = [i for i in found if i["kind"] == "sway"]
        self.assertEqual([i["anchor"] for i in sways], ["g1a-g1b", "g2a-g2b", "g3a-g3b", "g4a-g4b"])
        self.assertIn("bends towards g2a in another shot", sways[0]["message"])

    def test_round_15_name_kicks(self) -> None:
        found = {i["kind"]: i for i in self.history("round-15") if i["scene"] == "06-name"}
        self.assertEqual(sorted(found), ["kick-at-cut", "kick-on-turn"])
        self.assertIn("carries straight on from 05-reveal", found["kick-at-cut"]["message"])
        self.assertIn("hero device starts a 6.0° turn", found["kick-on-turn"]["message"])

    def test_round_20_montage_sways_in_nine_of_twelve_cuts(self) -> None:
        found = self.history("round-20")
        self.assertEqual({i["scene"] for i in found}, {"16-montage"})
        self.assertEqual({i["kind"] for i in found}, {"sway"})
        self.assertEqual(len(found), 9)

    def test_round_11_guessed_focus(self) -> None:
        found = [i for i in self.history("round-11") if i["kind"] == "focus"]
        self.assertEqual([(i["scene"], i["anchor"]) for i in found], [("06-name", "k1")])
        self.assertIn("focus 10.42 at k1", found[0]["message"])

    def test_round_16_push_along_its_line_of_sight_is_not_a_climb(self) -> None:
        self.assertEqual(self.history("round-16"), [])


class RuleTests(KbTestCase):
    def project(self, docs: List[Dict[str, Any]], durations: Optional[List[int]] = None, **manifest: Any) -> Path:
        stems = [f"{i + 1:02d}-s{i + 1}" for i in range(len(docs))]
        project = make_project(self.tmp, scenes=stems, **manifest)
        entries = read_json(project / "project.json")
        for entry, ms in zip(entries["scenes"], durations or [3000] * len(docs)):
            entry.pop("transition", None)
            entry["durationMs"] = ms
        write_json(project / "project.json", entries)
        for stem, doc in zip(stems, docs):
            write_json(project / "scenes" / f"{stem}.json", doc)
        return project

    def kinds(self, project: Path) -> List[str]:
        return [i["kind"] for i in warnings_of(project)]

    def test_a_kick_on_a_hard_cut_is_left_alone_and_one_on_a_carried_shot_warns(self) -> None:
        end = key("b", 3000, [0, 0, 5], [0, 0, 0])
        first = rig([key("a", 0, [0, 0, 6], [0, 0, 0]), end], [{"from": "a", "to": "b", "ease": "linear"}])
        kick = [{"at": 0, "zoom": 1.03, "releaseMs": 350}]
        carried = rig([key("c", 0, [0, 0, 5], [0, 0, 0]), key("d", 3000, [0, 0, 4.8], [0, 0, 0])],
                      [{"from": "c", "to": "d", "ease": "linear"}], cameraKicks=kick)
        self.assertEqual(self.kinds(self.project([first, carried])), ["kick-at-cut"])
        moved = rig([key("c", 0, [3, 1, 5], [0, 0, 0]), key("d", 3000, [3, 1, 4.8], [0, 0, 0])],
                    [{"from": "c", "to": "d", "ease": "linear"}], cameraKicks=kick)
        self.assertEqual(self.kinds(self.project([first, moved])), [])
        later = rig(carried["cameraRig"]["keys"], carried["cameraRig"]["segments"], cameraKicks=[{"at": 469, "zoom": 1.03, "releaseMs": 350}])
        self.assertEqual(self.kinds(self.project([first, later])), [])

    def test_a_kick_as_a_pan_starts_warns_and_on_a_steady_pan_does_not(self) -> None:
        held = [key("a", 0, [0, 0, 5], [0, 0, 0]), key("b", 500, [0, 0, 5], [0, 0, 0]), key("c", 1500, [0, 0, 5], [1.5, 0, 0])]
        pan = [{"from": "a", "to": "b", "ease": "linear"}, {"from": "b", "to": "c", "ease": "linear"}]
        starts = rig(held, pan, cameraKicks=[{"at": 500, "zoom": 1.02, "releaseMs": 400}])
        self.assertEqual(self.kinds(self.project([starts])), ["kick-on-turn"])
        steady = rig(held, pan, cameraKicks=[{"at": 1000, "zoom": 1.02, "releaseMs": 400}])
        self.assertEqual(self.kinds(self.project([steady])), [])
        orbit = rig([key("a", 0, [0, 0, 5], [0, 0, 0]), key("b", 2000, [0, 0, 5], [3, 0, 0])], [{"from": "a", "to": "b", "ease": "linear"}],
                    cameraKicks=[{"at": 0, "zoom": 1.02, "releaseMs": 400}])
        self.assertEqual(self.kinds(self.project([orbit])), [])

    def test_a_kick_on_a_device_turn_out_of_view_is_left_alone(self) -> None:
        turn = {"keys": [{"id": "d1", "tMs": 0, "pose": {"p": {"rotationDeg": [0, 0, 0]}}},
                         {"id": "d2", "tMs": 300, "pose": {"p": {"rotationDeg": [0, 0, 0]}}},
                         {"id": "d3", "tMs": 800, "pose": {"p": {"rotationDeg": [0, 20, 0]}}}],
                "segments": [{"from": "d1", "to": "d2", "ease": "jump"}, {"from": "d2", "to": "d3", "ease": "linear"}]}
        still = [key("a", 0, [0, 0, 5], [0, 0, 0]), key("b", 2000, [0, 0, 4.9], [0, 0, 0])]
        seg = [{"from": "a", "to": "b", "ease": "linear"}]
        kick = [{"at": 300, "zoom": 1.02, "releaseMs": 300}]
        seen = rig(still, seg, cameraKicks=kick, devices=[phone("p", [0, 0, 0])], deviceTrack=turn)
        self.assertEqual(self.kinds(self.project([seen])), ["kick-on-turn"])
        hidden = rig(still, seg, cameraKicks=kick, devices=[phone("p", [0, 0, 400])], deviceTrack=turn)
        self.assertEqual(self.kinds(self.project([hidden])), [])

    def test_an_overshooting_ease_runs_back_inside_the_move(self) -> None:
        keys = [key("a", 0, [0, 0, 6], [0, 0, 0]), key("b", 2000, [0, 0, 4], [0, 0, 0])]
        self.assertEqual(self.kinds(self.project([rig(keys, [{"from": "a", "to": "b", "ease": "outBack"}])])), ["sway"])
        self.assertEqual(self.kinds(self.project([rig(keys, [{"from": "a", "to": "b", "ease": "outSine"}])])), [])

    def test_a_straight_segment_never_bends_towards_the_next_shot(self) -> None:
        keys = [key("a", 0, [0, 0, 3], [0, 0, 0], fov=24), key("b", 999, [0, 0, 2.8], [0, 0, 0], fov=24),
                key("c", 1000, [6, 2, 3], [5, 0, 0], fov=24), key("d", 2000, [5.6, 1.8, 2.8], [5, 0, 0], fov=24)]
        segs = [{"from": "a", "to": "b", "ease": "linear"}, {"from": "b", "to": "c", "ease": "jump"}, {"from": "c", "to": "d", "ease": "linear"}]
        found = warnings_of(self.project([rig(keys, segs)]))
        self.assertEqual([i["anchor"] for i in found], ["a-b", "c-d"])
        self.assertIn("bends towards c in another shot", found[0]["message"])
        straight = [dict(s, smooth=False) for s in segs]
        self.assertEqual(self.kinds(self.project([rig(keys, straight)])), [])

    def test_a_push_that_climbs_round_its_subject_warns(self) -> None:
        climbs = rig([key("a", 0, [0, 0, 6], [0, 0, 0], fov=20), key("b", 2000, [0, 0.1, 4], [0, 0, 0], fov=20)],
                     [{"from": "a", "to": "b", "ease": "linear", "smooth": False}])
        self.assertEqual(self.kinds(self.project([climbs])), ["climb"])
        along = rig([key("a", 0, [0, 1, 6], [0, 0, 0], fov=20), key("b", 2000, [0, 0.5, 3], [0, 0, 0], fov=20)],
                    [{"from": "a", "to": "b", "ease": "linear"}])
        self.assertEqual(self.kinds(self.project([along])), [])
        tilt = rig([key("a", 0, [0, 0, 6], [0, 0, 0], fov=20), key("b", 2000, [0, 0, 4], [0, 1, 0], fov=20)],
                   [{"from": "a", "to": "b", "ease": "linear"}])
        self.assertEqual(self.kinds(self.project([tilt])), [])

    def test_jump_cuts_that_mirror_the_angle_wobble_and_one_angle_does_not(self) -> None:
        def shots(yaws: List[float], model: str = "iphone-17-pro") -> Dict[str, Any]:
            import math

            keys, segs, devices = [], [], []
            for n, yaw in enumerate(yaws):
                x = n * 25.0
                r = math.radians(yaw)
                pos = [x + 2.5 * math.sin(r), 0, 2.5 * math.cos(r)]
                closer = [x + (pos[0] - x) * 0.97, 0, pos[2] * 0.97]
                keys += [key(f"s{n}a", n * 1000, pos, [x, 0, 0], fov=28), key(f"s{n}b", n * 1000 + 999, closer, [x, 0, 0], fov=28)]
                segs.append({"from": f"s{n}a", "to": f"s{n}b", "ease": "linear", "smooth": False})
                if n:
                    segs.append({"from": f"s{n - 1}b", "to": f"s{n}a", "ease": "jump"})
                devices.append({"id": f"p{n}", "model": model, "placement": {"position": [x, 0, 0]}})
            return rig(keys, segs, devices=devices)

        self.assertEqual(self.kinds(self.project([shots([-18, 18, -18, 18])], [4000])), ["wobble"])
        self.assertEqual(self.kinds(self.project([shots([-10, -10, -10, -10])], [4000])), [])
        self.assertEqual(self.kinds(self.project([shots([30, -4, -18, 8])], [4000])), [])

    def test_focus_on_nothing_warns_and_focus_on_the_aim_or_a_device_does_not(self) -> None:
        def scene(focus: Any, **dof: Any) -> Dict[str, Any]:
            return rig([key("a", 0, [0, 0, 6], [0, 0, 0], fov=20, dof={"mode": "depth", "blur": 1, "range": 0.3, "focus": focus, **dof}),
                        key("b", 2000, [0, 0, 5.5], [0, 0, 0], fov=20)],
                       [{"from": "a", "to": "b", "ease": "linear"}], devices=[phone("p", [1.5, 0, -2])])
        self.assertEqual(self.kinds(self.project([scene(4.2)])), ["focus"])
        self.assertEqual(self.kinds(self.project([scene("auto")])), [])
        self.assertEqual(self.kinds(self.project([scene(6.0)])), [])
        self.assertEqual(self.kinds(self.project([scene(8.0)])), [])
        self.assertEqual(self.kinds(self.project([scene(4.2, blur=0)])), [])

    def test_a_lens_keeps_a_wider_band_at_a_small_aperture(self) -> None:
        def scene(stop: float) -> Dict[str, Any]:
            return rig([key("a", 0, [0, 0, 4], [0, 0, 0], fov=18, dof={"mode": "lens", "fStop": stop, "focus": 3.4})], [])
        self.assertEqual(self.kinds(self.project([scene(4)])), ["focus"])
        self.assertEqual(self.kinds(self.project([scene(64)])), [])

    def test_a_broken_camera_block_never_breaks_the_check(self) -> None:
        bad = {"version": 1, "cameraMode": "rig", "cameraRig": {"keys": [{"id": "a", "tMs": "x"}, 5, None], "segments": [7, {"from": 1}]},
               "cameraKicks": [{"at": {"x": 1}, "releaseMs": "y"}, 4], "devices": [{"id": 3}], "deviceTrack": {"keys": [{"id": "d", "tMs": 0, "pose": 5}]}}
        self.assertEqual(self.kinds(self.project([bad])), [])


class CameraCliTests(KbTestCase):
    def project(self) -> Path:
        project = make_project(self.tmp, scenes=["01-push"])
        manifest = read_json(project / "project.json")
        manifest["scenes"][0]["durationMs"] = 2000
        write_json(project / "project.json", manifest)
        write_json(project / "scenes" / "01-push.json", rig([key("a", 0, [0, 0, 6], [0, 0, 0], fov=20), key("b", 2000, [0, 0.1, 4], [0, 0, 0], fov=20)],
                                                             [{"from": "a", "to": "b", "ease": "linear", "smooth": False}]))
        return project

    def test_check_camera_lists_each_warning_with_its_id(self) -> None:
        project = self.project()
        proc = self.kb(["check", "camera"], cwd=project)
        self.assertExit(proc, 0)
        ident = rules.issue_id("climb", "01-push", "a-b")
        self.assertIn(f"warn  {ident}  01-push, climb:", proc.stdout)
        out = json.loads(self.kb(["check", "camera", "--json"], cwd=project).stdout)
        self.assertEqual([i["id"] for i in out["issues"]], [ident])
        self.assertExit(self.kb(["check", "camera", "--app"], cwd=project), 2)
        self.assertEqual(json.loads(self.kb(["check", "camera", "0", "--json"], cwd=project).stdout)["issues"][0]["id"], ident)

    def test_kb_check_carries_the_camera_warnings(self) -> None:
        project = self.project()
        proc = self.kb(["check"], cwd=project)
        self.assertExit(proc, 0)
        self.assertIn("camera climb", proc.stdout)
        self.assertIn("./kb camera accept", proc.stdout)
        scoped = self.kb(["check", "scenes/01-push.json"], cwd=project)
        self.assertIn("camera climb", scoped.stdout)

    def test_accept_keeps_it_beside_pacing_and_forget_raises_it_again(self) -> None:
        project = self.project()
        ident = rules.issue_id("climb", "01-push", "a-b")
        write_json(project / pc.ACCEPTED_FILE, {"version": 1, "accepted": [{"id": "p1", "kind": "still", "scene": "01-push", "why": "a breath"}]})
        self.assertExit(self.kb(["camera", "accept", ident], cwd=project), 2)
        self.assertExit(self.kb(["camera", "accept", "deadbeef", "--why", "x"], cwd=project), 1)
        self.assertExit(self.kb(["camera", "accept", ident, "--kind", "focus", "--why", "x"], cwd=project), 2)
        self.assertExit(self.kb(["camera", "accept", ident, "--why", "the settle is the point"], cwd=project), 0)
        rows = read_json(project / pc.ACCEPTED_FILE)["accepted"]
        self.assertEqual([(r["id"], r["kind"]) for r in rows], [("p1", "still"), (ident, "climb")])
        out = json.loads(self.kb(["check", "camera", "--json"], cwd=project).stdout)
        self.assertEqual((out["issues"], [i["why"] for i in out["accepted"]]), ([], ["the settle is the point"]))
        self.assertNotIn("camera climb", self.kb(["check"], cwd=project).stdout)
        self.assertIn(ident, self.kb(["camera"], cwd=project).stdout)
        self.assertNotIn(ident, self.kb(["pacing"], cwd=project).stdout)
        self.assertExit(self.kb(["pacing", "forget", "01-push"], cwd=project), 0)
        self.assertEqual([r["id"] for r in read_json(project / pc.ACCEPTED_FILE)["accepted"]], [ident])
        self.assertExit(self.kb(["camera", "forget", ident], cwd=project), 0)
        self.assertEqual(read_json(project / pc.ACCEPTED_FILE)["accepted"], [])
        self.assertExit(self.kb(["camera", "forget", ident], cwd=project), 1)

    def test_accept_by_scene_keeps_what_is_open_there(self) -> None:
        project = self.project()
        self.assertExit(self.kb(["camera", "accept", "01-push", "--kind", "wobble", "--why", "x"], cwd=project), 1)
        dry = json.loads(self.kb(["camera", "accept", "01-push", "--why", "kept", "--dry-run", "--json"], cwd=project).stdout)
        self.assertTrue(dry["dryRun"])
        self.assertFalse((project / pc.ACCEPTED_FILE).exists())
        self.assertExit(self.kb(["camera", "accept", "01-push", "--why", "kept"], cwd=project), 0)
        self.assertEqual([r["kind"] for r in read_json(project / pc.ACCEPTED_FILE)["accepted"]], ["climb"])
