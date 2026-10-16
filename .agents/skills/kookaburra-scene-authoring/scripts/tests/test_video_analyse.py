from __future__ import annotations

import io
import json
import os
import shutil
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from kblib.video import detect, passes

from . import video_synth as vs
from .helpers import KbTestCase, make_project

TOOLS = vs.tools()
needs_ffmpeg = unittest.skipUnless(TOOLS, "no ffmpeg with the analysis filters")


def raw_series(changes, duration=10000.0, samples=None, black=(), vfr=True, gaps=(), scd=()):
    """A passes.collect()-shaped dict built by hand."""
    if samples is None:
        samples = [[t * 100.0, 200.0, 235.0, 0.0, 0.0] for t in range(int(duration // 100))]
    return {
        "version": passes.ANALYSIS_VERSION, "info": {"durationMs": duration, "vfr": vfr, "width": 360, "height": 784, "fps": 60, "editFps": 60},
        "scaled": [360, 784], "samples": samples, "black": [list(b) for b in black], "freezes": [], "cameraFreezes": {},
        "packetGaps": [list(g) for g in gaps], "scd": list(scd), "changes": changes,
    }


def box(x, y, w, h):
    return [x, y, x + w - 1, y + h - 1]


class ParserTests(unittest.TestCase):
    def test_parse_log_reads_metadata_lines_per_instance(self) -> None:
        text = [
            "[metadata@pa @ 0x7f00] frame:0    pts:0       pts_time:0\n",
            "[metadata@pa @ 0x7f00] lavfi.signalstats.YAVG=16\n",
            "[Parsed_cropdetect_3 @ 0x7f01] x1:0 x2:359\n",
            "[metadata@pb @ 0x7f02] frame:1    pts:2040    pts_time:3.4\n",
            "[metadata@pb @ 0x7f02] lavfi.bbox.x1=0\n",
            "[metadata@pa @ 0x7f00] frame:1    pts:1       pts_time:0.1\n",
        ]
        logs = passes.parse_log(text)
        self.assertEqual([r["t"] for r in logs["metadata@pa"]], [0.0, 100.0])
        self.assertEqual(logs["metadata@pa"][0]["meta"], {"lavfi.signalstats.YAVG": "16"})
        self.assertEqual(logs["metadata@pb"][0]["t"], 3400.0)

    def test_probe_mirrors_media_rs(self) -> None:
        vfr = passes.parse_probe({"streams": [{"codec_type": "video", "width": 1206, "height": 2622, "r_frame_rate": "600/1",
                                               "avg_frame_rate": "15196/1000", "nb_frames": "455"}], "format": {"duration": "29.9405"}})
        self.assertTrue(vfr["vfr"])
        self.assertEqual(vfr["editFps"], 60.0)
        self.assertEqual(vfr["durationMs"], 29941)
        cfr = passes.parse_probe({"streams": [{"codec_type": "video", "width": 1920, "height": 1080, "r_frame_rate": "30000/1001",
                                               "avg_frame_rate": "30000/1001", "side_data_list": [{"rotation": -90}]}], "format": {"duration": "2"}})
        self.assertFalse(cfr["vfr"])
        self.assertAlmostEqual(cfr["editFps"], 29.97, places=2)
        self.assertEqual((cfr["width"], cfr["height"]), (1080, 1920))
        self.assertFalse(passes.is_vfr(30.0, 29.99))
        self.assertFalse(passes.is_vfr(0.0, 30.0))

    def test_packet_gaps_include_the_container_end(self) -> None:
        pts = passes.parse_packets("0.000000,K__\n0.600000,___\n3.400000,___\n3.416667,___\n")
        self.assertEqual(pts, [0.0, 600.0, 3400.0, 3416.667])
        self.assertEqual(passes.packet_gaps(pts, 6000.0), [(0.0, 600.0), (600.0, 3400.0), (3416.667, 6000.0)])

    def test_scaled_size_never_upscales_and_stays_even(self) -> None:
        self.assertEqual(passes.scaled_size(1206, 2622, 360), (360, 782))
        self.assertEqual(passes.scaled_size(320, 240, 360), (320, 240))
        self.assertEqual(passes.scaled_size(1920, 1080, 270), (480, 270))

    def test_no_path_enters_the_filter_graph(self) -> None:
        graph = passes.decode_graph(360, 784)
        self.assertNotIn("/", graph.replace("ih/10", "").replace("iw/10", ""))
        self.assertIn("metadata@pb=mode=print", graph)


class DetectSeriesTests(unittest.TestCase):
    def test_static_blink_typing_and_tap(self) -> None:
        changes = [[1000.0, 50.0, 200.0, box(0, 0, 360, 784)]]
        changes += [[2000.0 + 500 * k, 0.03, 200.0, box(40, 160, 2, 18)] for k in range(8)]
        changes += [[7000.0 + 250 * k, 0.1, 211.0, box(30 + 20 * k, 612, 10, 14)] for k in range(8)]
        changes += [[9600.0, 0.6, 115.0, box(230, 280, 40, 40)], [9850.0, 100.0, 120.0, box(0, 0, 360, 784)]]
        out = detect.analyse(raw_series(changes, scd=[1000.0, 9900.0]))
        kinds = [(iv["kind"], iv["sub"], iv["startMs"], iv["endMs"]) for iv in out["intervals"]]
        self.assertIn(("idle", "blink", 2000, 5500), kinds)
        self.assertIn(("active", "typing", 7000, 8750), kinds)
        self.assertEqual(out["screenChanges"][-1]["tMs"], 9850.0)
        self.assertEqual(len(out["tapCandidates"]), 1)
        tap = out["tapCandidates"][0]
        self.assertEqual(tap["sourceMs"], 9567)
        self.assertAlmostEqual(tap["pos"][0], 250 / 360, places=3)
        self.assertAlmostEqual(tap["confidence"], 0.95)
        self.assertEqual(kinds[0][0], "lead-in")

    def test_loading_run_is_fast_regular_and_stationary(self) -> None:
        changes = [[3000.0 + 16.667 * k, 0.05, 150.0, box(170, 390, 10, 10)] for k in range(240)]
        out = detect.analyse(raw_series(changes))
        loading = [iv for iv in out["intervals"] if iv["sub"] == "loading"]
        self.assertEqual(len(loading), 1)
        self.assertGreaterEqual(loading[0]["confidence"], 0.79)

    def test_keyboard_presses_are_not_taps(self) -> None:
        typing = [[5000.0 + 220 * k, 0.1, 211.0, box(30 + 25 * k, 640, 12, 16)] for k in range(8)]
        press = [[7500.0, 0.6, 115.0, box(200, 650, 30, 30)], [7700.0, 100.0, 120.0, box(0, 0, 360, 784)]]
        out = detect.analyse(raw_series(typing + press, scd=[7800.0]))
        self.assertEqual(out["tapCandidates"], [])

    def test_dark_splash_with_a_logo_is_not_black(self) -> None:
        samples = [[t * 100.0, 18.0, 16.0 if t < 6 else 235.0, 0.0, 0.0] for t in range(30)]
        out = detect.analyse(raw_series([[600.0, 120.0, 235.0, box(0, 0, 360, 784)]], duration=3000.0, samples=samples,
                                        black=[(0.0, 3000.0)]))
        black = [iv for iv in out["intervals"] if iv["kind"] == "black"]
        self.assertEqual([(b["startMs"], b["endMs"]) for b in black], [(0, 600)])

    def test_profile_auto(self) -> None:
        screen = raw_series([], vfr=False, samples=[[t * 100.0, 200, 235, 0.0, 0] for t in range(50)])
        self.assertEqual(detect.choose_profile(screen)[0], "screen")
        camera = raw_series([], vfr=False, samples=[[t * 100.0, 200, 235, 2.5, 0] for t in range(50)])
        self.assertEqual(detect.choose_profile(camera)[0], "camera")
        self.assertEqual(detect.choose_profile(camera, "screen")[0], "screen")

    def test_strip_is_log_spaced(self) -> None:
        s = detect.strip([0.0, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 1e-1], width=7)
        self.assertEqual(s[0], " ")
        self.assertEqual(len(set(s[2:])), 5)

    def test_projection_through_clips(self) -> None:
        an = vs.screen_analysis()
        clips = [{"id": "c1", "sourceId": "s1", "inMs": 3000, "outMs": 5000, "speed": 2, "startMs": 0},
                 {"id": "c2", "sourceId": "s1", "inMs": 3000, "outMs": 3000, "speed": 1, "holdMs": 500, "startMs": 1000}]
        rows = detect.project(clips, {"s1": an})
        active = next(r for r in rows if r.get("interval") == "i3")
        self.assertEqual(active["timelineMs"], [200.0, 850.0])
        self.assertFalse(any(r["clip"] == "c2" for r in rows))


@needs_ffmpeg
class RecordingTests(unittest.TestCase):
    def analyse(self, path: Path, profile: str = "auto") -> dict:
        t = passes.Tools(*TOOLS)  # type: ignore[misc]
        return detect.analyse(passes.raw_for(t, path), profile)

    def assert_intervals(self, out: dict, tolerance: float) -> None:
        got = out["intervals"]
        want = vs.SCREEN_TRUTH["intervals"]
        self.assertEqual([(g["kind"], g["sub"] if g["kind"] == "idle" or g["sub"] == "typing" else w.get("sub")) for g, w in zip(got, want)],
                         [(w["kind"], w.get("sub")) for w in want])
        for g, w in zip(got, want):
            self.assertLessEqual(abs(g["exactStartMs"] - w["startMs"]), tolerance, (g, w))
            self.assertLessEqual(abs(g["exactEndMs"] - w["endMs"]), tolerance, (g, w))

    def test_vfr_screen_recording_matches_ground_truth_to_a_millisecond(self) -> None:
        out = self.analyse(vs.screen_vfr())
        self.assertEqual(out["profile"], "screen")
        self.assertTrue(out["vfr"])
        self.assert_intervals(out, 1.0)
        changes = [c["tMs"] for c in out["screenChanges"]]
        for t in vs.SCREEN_TRUTH["screenChanges"]:
            self.assertTrue(any(abs(c - t) <= 1 for c in changes), t)
        tap = out["tapCandidates"]
        self.assertEqual(len(tap), 1)
        self.assertLessEqual(abs(tap[0]["sourceMs"] - vs.SCREEN_TRUTH["tap"]["sourceMs"]), 50)
        for got, want in zip(tap[0]["pos"], vs.SCREEN_TRUTH["tap"]["pos"]):
            self.assertLessEqual(abs(got - want), 0.03)
        lead = out["intervals"][1]
        self.assertGreaterEqual(lead["confidence"], 0.99)

    def test_cfr_screen_recording_within_a_sample(self) -> None:
        out = self.analyse(vs.screen_cfr())
        self.assertEqual(out["profile"], "screen")
        self.assert_intervals(out, 100.0)
        self.assertLessEqual(abs(out["tapCandidates"][0]["sourceMs"] - vs.SCREEN_TRUTH["tap"]["sourceMs"]), 50)

    def test_camera_floor_finds_the_true_freeze_not_the_noisy_still(self) -> None:
        out = self.analyse(vs.camera_cfr())
        self.assertEqual(out["profile"], "camera")
        freezes = [(iv["startMs"], iv["endMs"]) for iv in out["intervals"] if iv["kind"] in ("idle", "lead-in", "lead-out")]
        a, b = vs.CAMERA_TRUTH["trueFreeze"]
        self.assertEqual(len(freezes), 1)
        self.assertLessEqual(abs(freezes[0][0] - a), 100)
        self.assertLessEqual(abs(freezes[0][1] - b), 100)
        still = vs.CAMERA_TRUTH["noisyStill"]
        self.assertFalse(any(x < still[1] - 200 and still[0] + 200 < y for x, y in freezes))
        self.assertEqual(out["tapCandidates"], [])


@needs_ffmpeg
class AnalyseCommandTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        shutil.copyfile(vs.screen_vfr(), self.root / "assets" / "sim-checkout.mov")
        self._env = {k: os.environ.get(k) for k in ("KB_FFMPEG", "KB_FFPROBE")}
        os.environ["KB_FFMPEG"], os.environ["KB_FFPROBE"] = TOOLS  # type: ignore[misc]
        self.cwd = os.getcwd()
        os.chdir(self.root)

    def tearDown(self) -> None:
        os.chdir(self.cwd)
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        super().tearDown()

    def run_cmd(self, argv):
        from kblib.video import smart_commands as sc

        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(io.StringIO()):
            code = sc.run_standalone(argv)
        return code, buf.getvalue()

    def test_text_and_json_and_cache(self) -> None:
        code, text = self.run_cmd(["analyse", "assets/sim-checkout.mov"])
        self.assertEqual(code, 0)
        self.assertIn("profile screen", text)
        self.assertIn("activity |", text)
        self.assertIn("tap candidate k1", text)
        self.assertTrue(text.rstrip().splitlines()[-1].startswith("next:"))
        cached = list((self.bridge / "video" / "demo" / "analysis").glob("*-v*.json"))
        self.assertEqual(len(cached), 1)
        code, out = self.run_cmd(["analyze", "sim-checkout.mov", "--json", "--range", "18-26"])
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertEqual(data["kind"], "source")
        self.assertEqual(len(data["sources"]["s1"]["intervals"]), 11)

    def test_unknown_target_exits_2(self) -> None:
        code, _ = self.run_cmd(["analyse", "nope.mov"])
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
