from __future__ import annotations

import json
import unittest

from kblib.camera import sample as cs

from .helpers import FIXTURES

VECTORS = FIXTURES / "camera-vectors.json"
TOLERANCE = 1e-9


@unittest.skipUnless(VECTORS.is_file(), "fixtures/camera-vectors.json is missing (pnpm agent:vectors writes it)")
class CameraConformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.vectors = json.loads(VECTORS.read_text(encoding="utf-8"))

    def close(self, got: float, want: float, what: str) -> None:
        self.assertLessEqual(abs(got - want), TOLERANCE * max(1.0, abs(want)), f"{what}: {got} != {want}")

    def test_version(self) -> None:
        self.assertEqual(self.vectors["version"], 1)

    def test_poses_match_the_app(self) -> None:
        for case in self.vectors["cases"]:
            tracks = cs.scene_tracks(case["docs"], case["music"], case["sceneStartMs"])
            for p in case["poses"]:
                with self.subTest(case=case["id"], scene=p["scene"], t=p["tMs"]):
                    got = cs.scene_pose(tracks[p["scene"]], p["tMs"])
                    want = p["expect"]
                    for axis in range(3):
                        self.close(got["position"][axis], want["position"][axis], "position")
                        self.close(got["lookAt"][axis], want["lookAt"][axis], "lookAt")
                    self.close(got["fov"], want["fov"], "fov")
                    self.close(got.get("rollDeg") or 0.0, want["rollDeg"], "rollDeg")
                    if want["dof"] is None:
                        self.assertIsNone(got.get("dof"))
                        continue
                    self.assertIsNotNone(got.get("dof"))
                    self.assertEqual(got["dof"]["mode"], want["dof"]["mode"])
                    for name in ("blur", "focus", "range", "focusB", "fStop", "sensorMm"):
                        self.close(got["dof"][name], want["dof"][name], name)
                    if want["dof"]["focalMm"] is None:
                        self.assertIsNone(got["dof"]["focalMm"])
                    else:
                        self.close(got["dof"]["focalMm"], want["dof"]["focalMm"], "focalMm")

    def test_device_tracks_match_the_app(self) -> None:
        for case in self.vectors["cases"]:
            tracks = [cs.device_track(doc) for doc in case["docs"]]
            for d in case["devices"]:
                with self.subTest(case=case["id"], device=d["id"], t=d["tMs"]):
                    offset, rotation = cs.device_delta_at(tracks[d["scene"]], d["id"], d["tMs"])
                    for axis in range(3):
                        self.close(offset[axis], d["expect"]["offset"][axis], "offset")
                        self.close(rotation[axis], d["expect"]["rotationDeg"][axis], "rotationDeg")
