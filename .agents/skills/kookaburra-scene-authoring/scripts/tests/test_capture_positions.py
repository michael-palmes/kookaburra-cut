"""kb capture at musical positions: resolution against the authored grid, the owning scene across a crossfade, --scene
checks, bars:/beats: ranges and the 48-frame cap, with a fake bridge."""

from __future__ import annotations

import json
from typing import Any, Dict

from .helpers import FakeApp, KbTestCase, make_project, png_bytes

KINDS = ["capture", "check", "fonts", "insertPreset", "mediaChanged", "openEdit", "debug"]
FEATURES = ["scale", "width", "probe", "client", "deadline", "recycle", "debug"]


class CapturePositionTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        # Three 3000 ms scenes with 600 ms crossfades: they start at 0, 2400 and 4800; scene 1 owns 2700..5099.
        # The grid: 120 bpm, bar 1 at 250 ms in the track, soundtrack starting 50 ms in, so bar:B lands at 200 + (B - 1) * 2000.
        self.root = make_project(self.tmp, audio={"file": "assets/track.mp3", "startOffsetMs": 50,
                                                 "grid": {"bpm": 120, "offsetMs": 250, "beatsPerBar": 4}, "cues": {"hit": "bar:2.3+20ms"}})
        (self.root / "assets" / "track.mp3").write_bytes(b"audio")

    def answer(self, req: Dict[str, Any]) -> Dict[str, Any]:
        frames = []
        for n, f in enumerate(req.get("frames") or [{"scene": req.get("scene"), "at": req.get("at")}]):
            path = self.tmp / f"{req['id']}-{n}.png"
            path.write_bytes(png_bytes())
            frames.append({"scene": f.get("scene"), "at": f.get("at"), "tMs": 0, "path": str(path), "index": n})
        return {"ok": True, "path": frames[0]["path"], "paths": [f["path"] for f in frames], "frames": frames,
                "project": req["project"], "format": "16:9", "size": {"width": 1280, "height": 720}, "nativeSize": {"width": 1280, "height": 720}}

    def capture(self, *args: str, code: int = 0) -> Dict[str, Any]:
        with FakeApp(self.bridge, self.answer, kinds=KINDS, health={"version": 1, "captureFeatures": FEATURES}) as app:
            proc = self.kb(["capture", "--no-copy", "--json"] + list(args), cwd=self.root)
        self.assertExit(proc, code)
        out = json.loads(proc.stdout)
        out["_requests"] = app.requests
        return out

    def test_at_a_bar_captures_the_scene_that_owns_it(self) -> None:
        out = self.capture("--at", "bar:2")
        req = out["_requests"][0]
        self.assertEqual((req["scene"], req["at"]), ("01-intro", 2.2))
        self.assertEqual((out["position"], out["projectMs"]), ("bar:2", 2200))
        self.assertEqual(out["frames"][0]["position"], "bar:2")

    def test_mid_crossfade_belongs_to_the_scene_the_editor_shows(self) -> None:
        # bar:2.2 is 2700 ms: the first moment scene 1 owns; 1 ms earlier still belongs to scene 0.
        req = self.capture("--at", "bar:2.2")["_requests"][0]
        self.assertEqual((req["scene"], req["at"]), ("02-hero", 0.3))
        req = self.capture("--at", "bar:2.2-1ms")["_requests"][0]
        self.assertEqual((req["scene"], req["at"]), ("01-intro", 2.699))

    def test_scene_must_contain_the_position(self) -> None:
        req = self.capture("--scene", "01-intro", "--at", "bar:2.2")["_requests"][0]
        self.assertEqual((req["scene"], req["at"]), ("01-intro", 2.7))
        out = self.capture("--scene", "03-outro", "--at", "bar:2", code=1)
        self.assertEqual(out["code"], "invalid")
        self.assertIn("--scene 01-intro", out["hint"])
        self.assertEqual(out["_requests"], [])

    def test_cues_nudges_and_the_film_end(self) -> None:
        req = self.capture("--at", "cue:hit")["_requests"][0]
        self.assertEqual((req["scene"], req["at"]), ("02-hero", 0.82))
        out = self.capture("--at", "bar:9", code=1)
        self.assertIn("outside the film", out["error"])

    def test_seconds_still_mean_seconds_into_the_scene(self) -> None:
        req = self.capture("--scene", "1", "--at", "1.5")["_requests"][0]
        self.assertEqual((req["scene"], req["at"]), ("02-hero", 1.5))
        out = self.capture("--at", "soon", code=2)
        self.assertEqual(out["code"], "usage")

    def test_frames_mix_ranges_positions_and_seconds(self) -> None:
        out = self.capture("--frames", "bars:1-3,0@1,2@bar:4,beats:2-2")
        frames = [(f["scene"], f["at"]) for f in out["_requests"][0]["frames"]]
        self.assertEqual(frames, [
            ("01-intro", 0.2), ("01-intro", 2.2), ("02-hero", 1.8), ("01-intro", 1.0), ("03-outro", 1.4),
            ("01-intro", 2.2), ("02-hero", 0.3), ("02-hero", 0.8), ("02-hero", 1.3),
        ])
        self.assertEqual([f.get("position") for f in out["frames"]],
                         ["bar:1", "bar:2", "bar:3", None, "bar:4", "bar:2", "bar:2.2", "bar:2.3", "bar:2.4"])
        self.assertEqual(out["frames"][2]["projectMs"], 4200)

    def test_the_frame_cap_and_no_grid(self) -> None:
        out = self.capture("--frames", "beats:1-13", code=2)
        self.assertIn("at most 48", out["error"])
        root = make_project(self.tmp / "silent")
        with FakeApp(self.bridge, self.answer, kinds=KINDS) as app:
            proc = self.kb(["capture", "--at", "bar:2", "--json"], cwd=root)
        self.assertExit(proc, 1)
        out = json.loads(proc.stdout)
        self.assertEqual(out["code"], "no-grid")
        self.assertEqual(out["hint"], "./kb song analyse, then ./kb beats set-grid --from-analysis")
        self.assertEqual(app.requests, [])


if __name__ == "__main__":
    import unittest

    unittest.main()
