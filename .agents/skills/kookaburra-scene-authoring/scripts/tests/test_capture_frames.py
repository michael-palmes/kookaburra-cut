"""kb capture for motion and joins: the capture-size mirror and probe mapping, transition labels, --around frame
times, --crop parsing and cropping, and --diff (S@first / S@last sides, the A | B | difference sheet and its numbers)."""

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path
from typing import Any, Dict, List

from kblib import capture as cap
from kblib.film import timeline as tl
from kblib.project import Project
from kblib.util import KbError

from . import video_synth as vs
from .helpers import FakeApp, KbTestCase, make_project, png_bytes

KINDS = ["capture", "check", "fonts", "insertPreset", "mediaChanged", "openEdit", "debug"]
FEATURES = ["scale", "width", "probe", "client", "deadline", "recycle", "debug"]
TOOLS = vs.tools()
needs_ffmpeg = unittest.skipUnless(TOOLS, "no ffmpeg")


def solid_png(path: Path, size: str, colour: str) -> None:
    assert TOOLS
    subprocess.run([TOOLS[0], "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", f"color=c={colour}:s={size}", "-frames:v", "1", str(path)],
                   check=True, capture_output=True)


class SizeAndProbeTests(unittest.TestCase):
    def test_capture_size_mirrors_the_app(self) -> None:
        native = (3840, 2160)
        self.assertEqual(cap.capture_size(native), native)
        self.assertEqual(cap.capture_size(native, frames=3), (1280, 720))
        self.assertEqual(cap.capture_size(native, frames=3, probe=True), native)
        self.assertEqual(cap.capture_size(native, sheet=True), (1280, 720))
        self.assertEqual(cap.capture_size(native, scale=0.5), (1920, 1080))
        self.assertEqual(cap.capture_size(native, width=961), (962, 542))
        self.assertEqual(cap.capture_size(native, width=5000), native)
        self.assertEqual(cap.capture_size((2160, 3840), frames=2), (720, 1280))
        self.assertEqual(cap.capture_size(native, width=20), (114, 64))

    def test_probes_map_native_and_normalised_points_into_the_image(self) -> None:
        points = cap.parse_probe(["10,20,0.5,0.5", "3839,2159"])
        wire, natives = cap.map_probes(points or [], (3840, 2160), (1920, 1080))
        self.assertEqual(natives, [[10, 20], [1920, 1080], [3839, 2159]])
        self.assertEqual(wire, [[5, 10], [960, 540], [1919, 1079]])
        wire, natives = cap.map_probes(cap.parse_probe(["1.0,0.0"]) or [], (3840, 2160), (3840, 2160))
        self.assertEqual((wire, natives), ([[3839, 0]], [[3839, 0]]))

    def test_bad_probes_are_usage_errors(self) -> None:
        for spec, needle in (("1,2,3", "x,y pairs"), ("1,a", "whole pixels"), ("0.5,10", "not a mix"), ("1.5,0.5", "[0, 1]"), ("-1,2", "0,0")):
            with self.assertRaises(KbError) as e:
                cap.parse_probe([spec])
            self.assertIn(needle, e.exception.message)
            self.assertEqual(e.exception.kind, "usage")
        with self.assertRaises(KbError) as e:
            cap.map_probes(cap.parse_probe(["3840,10"]) or [], (3840, 2160), (1280, 720))
        self.assertIn("outside the 3840x2160 native frame", e.exception.message)

    def test_crops_take_pixels_or_fractions_inside_the_frame(self) -> None:
        native = (3840, 2160)
        self.assertEqual(cap.crop_box(cap.parse_crop("100,50,640,360"), native), {"x": 100, "y": 50, "width": 640, "height": 360})  # type: ignore[arg-type]
        self.assertEqual(cap.crop_box(cap.parse_crop("0.5,0.0,0.25,0.5"), native), {"x": 1920, "y": 0, "width": 960, "height": 1080})  # type: ignore[arg-type]
        for spec, needle in (("1,2,3", "X,Y,W,H"), ("0.5,10,1,1", "not a mix"), ("3800,0,100,10", "runs past"), ("0,0,0,10", "at least one")):
            with self.assertRaises(KbError) as e:
                cap.crop_box(cap.parse_crop(spec), native)  # type: ignore[arg-type]
            self.assertIn(needle, e.exception.message)


class TimelineTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        # Three 3000 ms scenes with 600 ms crossfades: they start at 0, 2400 and 4800.
        self.root = make_project(self.tmp)
        self.slots = tl.project_slots(Project(self.root))

    def test_transition_frames_name_both_scenes(self) -> None:
        tr = cap.transition_at(self.slots, 2640)
        self.assertEqual(tr, {"from": "01-intro", "to": "02-hero", "type": "crossfade", "progress": 0.4})
        self.assertEqual(cap.transition_label(tr or {}), "01-intro → 02-hero (crossfade, 40%)")
        self.assertEqual(cap.frame_name({"scene": "02-hero", "at": 0.24, "transition": tr}, 0), "01-intro-to-02-hero-crossfade-40pct.png")
        self.assertIsNone(cap.transition_at(self.slots, 2399))
        self.assertIsNone(cap.transition_at(self.slots, 3000))
        self.assertEqual(cap.frame_name({"scene": "02-hero", "at": 1.5}, 0), "02-hero@1.5s.png")

    def test_around_counts_export_frames_and_stays_inside_the_scene(self) -> None:
        frames, moved = cap.around_frames(self.slots, 2400 + 1500, 5, index=1)
        self.assertFalse(moved)
        self.assertEqual([k for k, _, _ in frames], [232, 233, 234, 235, 236])
        self.assertAlmostEqual(frames[2][1], 3900.0)
        self.assertEqual({i for _, _, i in frames}, {1})
        frames, moved = cap.around_frames(self.slots, 2400, 4, index=1)
        self.assertTrue(moved)
        self.assertEqual(frames[0][0], 144)
        # Across the crossfade each frame goes to the scene the editor shows (scene 1 from 2700 ms).
        frames, moved = cap.around_frames(self.slots, 2700, 3)
        self.assertEqual([i for _, _, i in frames], [0, 1, 1])
        with self.assertRaises(KbError) as e:
            cap.around_frames(self.slots, 1000, 181, index=0)
        self.assertEqual(e.exception.kind, "invalid")

    def test_diff_sides_take_first_and_last_sugar(self) -> None:
        project = Project(self.root)
        first, meta = cap.diff_frame(project, self.slots, "02-hero@first", None)
        self.assertEqual(first, {"scene": "02-hero", "at": 0.6})
        self.assertEqual(meta, {"spec": "02-hero@first", "projectMs": 3000})
        last, meta = cap.diff_frame(project, self.slots, "1@last", None)
        self.assertEqual(last, {"scene": "02-hero", "at": round((2400 - 1000 / 60) / 1000, 6)})
        plain, meta = cap.diff_frame(project, self.slots, "03-outro@0.5", None)
        self.assertEqual((plain, meta), ({"scene": "03-outro", "at": 0.5}, {"spec": "03-outro@0.5"}))

    def test_diff_stats(self) -> None:
        self.assertEqual(cap.diff_stats(b""), {"meanPct": 0.0, "changedPct": 0.0, "maxPct": 0.0})
        stats = cap.diff_stats(bytes([0, 0, 0, 255, 0, 0, 0, 9, 0, 0, 0, 8]))
        self.assertEqual(stats["changedPct"], 50.0)
        self.assertEqual(stats["maxPct"], 100.0)
        self.assertAlmostEqual(stats["meanPct"], round(272 / (12 * 255) * 100, 3))


class CaptureFlowTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.starts = [0, 2400, 4800]
        self.colours: List[str] = []

    def answer(self, req: Dict[str, Any]) -> Dict[str, Any]:
        frames = []
        for n, f in enumerate(req.get("frames") or [{"scene": req.get("scene"), "at": req.get("at")}]):
            path = self.tmp / "app" / f"{req['id']}-{n}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            if self.colours:
                solid_png(path, "3840x2160" if not req.get("frames") or req.get("width") == 3840 else "1280x720", self.colours[n % len(self.colours)])
            else:
                path.write_bytes(png_bytes())
            index = int(str(f.get("scene"))[:2]) - 1
            t = self.starts[index] + float(f.get("at") or 0) * 1000
            frames.append({"scene": f.get("scene"), "at": f.get("at"), "tMs": round(t), "path": str(path), "index": index,
                           "probes": [{"x": x, "y": y, "rgba": [1, 2, 3, 255], "hex": "#010203"} for x, y in req.get("probe") or []]})
        return {"ok": True, "path": frames[0]["path"], "paths": [f["path"] for f in frames], "frames": frames, "project": req["project"],
                "format": "16:9", "size": {"width": 1280, "height": 720}, "nativeSize": {"width": 3840, "height": 2160}}

    def capture(self, *args: str, code: int = 0) -> Dict[str, Any]:
        with FakeApp(self.bridge, self.answer, kinds=KINDS, health={"version": 1, "captureFeatures": FEATURES}) as app:
            proc = self.kb(["capture", "--json"] + list(args), cwd=self.root)
        self.assertExit(proc, code)
        out = json.loads(proc.stdout)
        out["_requests"] = app.requests
        return out

    def test_around_sends_consecutive_frames(self) -> None:
        out = self.capture("--scene", "02-hero", "--around", "1.5", "--count", "3", "--no-copy")
        frames = out["_requests"][0]["frames"]
        self.assertEqual([f["scene"] for f in frames], ["02-hero"] * 3)
        self.assertEqual([f["at"] for f in frames], [round(1.5 - 1 / 60, 6), 1.5, round(1.5 + 1 / 60, 6)])
        self.assertEqual([f["frame"] for f in out["frames"]], [233, 234, 235])

    def test_mid_transition_frames_are_labelled_and_named(self) -> None:
        out = self.capture("--frames", "1@0.24,1@1.5", "--agent", "alpha")
        first, second = out["frames"]
        self.assertEqual(first["label"], "01-intro → 02-hero (crossfade, 40%)")
        self.assertEqual(first["transition"]["progress"], 0.4)
        self.assertEqual(Path(first["path"]).name, "01-intro-to-02-hero-crossfade-40pct.png")
        self.assertNotIn("label", second)
        self.assertEqual(Path(second["path"]).name, "02-hero@1.5s.png")

    def test_probes_scale_from_native_and_report_both(self) -> None:
        out = self.capture("--scene", "0", "--scale", "0.5", "--probe", "100,200,0.5,0.5", "--no-copy")
        self.assertEqual(out["_requests"][0]["probe"], [[50, 100], [960, 540]])
        self.assertEqual([p["native"] for p in out["frames"][0]["probes"]], [[100, 200], [1920, 1080]])

    def test_flag_clashes_are_usage_errors(self) -> None:
        for argv in (["--count", "3"], ["--around", "1", "--frames", "0@1"], ["--crop", "0,0,10,10", "--scale", "0.5"],
                     ["--diff", "0@1", "1@1", "--no-copy"], ["--around", "1"], ["--diff", "0@1", "1@1", "--crop", "0,0,1,1"]):
            out = self.capture(*argv, code=2)
            self.assertEqual(out["code"], "usage", argv)
            self.assertEqual(out["_requests"], [], argv)

    @needs_ffmpeg
    def test_crop_cuts_the_native_copy_and_keeps_the_original(self) -> None:
        self.colours = ["red"]
        with FakeApp(self.bridge, self.answer, kinds=KINDS, health={"version": 1, "captureFeatures": FEATURES}):
            proc = self.kb(["capture", "--scene", "1", "--at", "1", "--crop", "0.5,0.5,0.25,0.25", "--json"], cwd=self.root,
                           env={"KB_FFMPEG": TOOLS[0], "KB_FFPROBE": TOOLS[1]} if TOOLS else None)
        self.assertExit(proc, 0)
        out = json.loads(proc.stdout)
        self.assertEqual(out["crop"], {"x": 1920, "y": 1080, "width": 960, "height": 540})
        self.assertEqual(png_size(Path(out["frames"][0]["path"])), (960, 540))
        self.assertEqual(png_size(Path(out["frames"][0]["bridgePath"])), (3840, 2160))

    @needs_ffmpeg
    def test_diff_writes_the_comparison_and_its_numbers(self) -> None:
        self.colours = ["black", "white"]
        with FakeApp(self.bridge, self.answer, kinds=KINDS, health={"version": 1, "captureFeatures": FEATURES}) as app:
            proc = self.kb(["capture", "--diff", "01-intro@last", "02-hero@first", "--json"], cwd=self.root,
                           env={"KB_FFMPEG": TOOLS[0], "KB_FFPROBE": TOOLS[1]} if TOOLS else None)
            text = self.kb(["capture", "--diff", "01-intro@last", "02-hero@first"], cwd=self.root,
                           env={"KB_FFMPEG": TOOLS[0], "KB_FFPROBE": TOOLS[1]} if TOOLS else None)
        self.assertExit(proc, 0)
        out = json.loads(proc.stdout)
        self.assertEqual(len(app.requests[0]["frames"]), 2)
        diff = out["diff"]
        self.assertEqual((diff["meanPct"], diff["changedPct"], diff["maxPct"]), (100.0, 100.0, 100.0))
        self.assertEqual((diff["a"]["spec"], diff["b"]["spec"]), ("01-intro@last", "02-hero@first"))
        self.assertEqual(png_size(Path(diff["path"])), (1280 * 3 + 16, 720))
        self.assertExit(text, 0)
        self.assertIn("diff: ", text.stdout)
        self.assertIn("of pixels changed", text.stdout)


def png_size(path: Path) -> tuple:
    data = path.read_bytes()
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


if __name__ == "__main__":
    unittest.main()
