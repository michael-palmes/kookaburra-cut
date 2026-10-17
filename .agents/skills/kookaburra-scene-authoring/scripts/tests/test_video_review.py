from __future__ import annotations

import glob
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from kblib.video import cleanup as cl
from kblib.video import review as rv

from . import video_synth as vs
from .helpers import KbTestCase, make_project

TOOLS = vs.tools()
needs_ffmpeg = unittest.skipUnless(TOOLS, "no ffmpeg with the review filters")
CONFORMANCE = Path(__file__).resolve().parent / "fixtures" / "video-conformance"


def shown_frame(case: dict, entry: dict) -> int:
    src = next(s for s in case["sources"] if s["id"] == entry["sourceId"])
    if entry.get("image") or src.get("kind") == "image":
        return 0
    frames = src.get("kept") or list(range(src["frames"]))
    return rv.source_frame_for_slot(entry["slot"], case["fps"], src["indexFps"], frames)


class MappingTests(unittest.TestCase):
    def test_trim_edges_round_half_away(self) -> None:
        self.assertEqual(rv.rescale_ms(50, 30), 2)
        self.assertEqual(rv.rescale_ms(1017, 60), 61)
        self.assertEqual(rv.rescale_ms(508, 60), 30)
        self.assertEqual(rv.rescale_ms(1001, 30000 / 1001), 30)

    def test_setpts_truncation(self) -> None:
        self.assertEqual([rv.picked_local(j, 120, 2.0) for j in range(4)], [1, 3, 5, 7])
        self.assertEqual([rv.picked_local(j, 120, 0.5) for j in range(4)], [0, 0, 1, 1])
        self.assertEqual(rv.picked_local(500, 30, 1.0), 29)

    def test_predict_hand_cases(self) -> None:
        doc = {"settings": {"fps": 60}, "sources": [{"id": "s1", "kind": "video"}],
               "clips": [{"id": "c1", "sourceId": "s1", "inMs": 1017, "outMs": 3024, "speed": 2},
                         {"id": "c2", "sourceId": "s1", "inMs": 500, "outMs": 500, "speed": 1, "holdMs": 508}]}
        got = rv.predict(doc, [0, 1, 59, 60, 89])
        self.assertEqual([g["slot"] for g in got], [62, 64, 180, 30, 30])
        self.assertEqual([g["class"] for g in got], ["faster", "faster", "faster", "hold", "hold"])

    @unittest.skipUnless(CONFORMANCE.is_dir() and glob.glob(str(CONFORMANCE / "*.json")), "barcode fixtures arrive with avk-core")
    def test_barcode_conformance(self) -> None:
        for path in sorted(CONFORMANCE.glob("*.json")):
            case = json.loads(path.read_text())
            with self.subTest(case=case["case"]):
                doc = {"settings": {"width": case["width"], "height": case["height"], "fps": case["fps"]},
                       "sources": case["sources"], "clips": case["clips"]}
                images = cl.image_ids(doc)
                self.assertEqual(cl.total_frames(cl.relayout(case["clips"], images), case["fps"], images), case["totalFrames"])
                preds = rv.predict(doc, [o["k"] for o in case["outputFrames"]])
                self.assertEqual(len(preds), len(case["outputFrames"]))
                for want, got in zip(case["outputFrames"], preds):
                    self.assertEqual(shown_frame(case, got), want["sourceFrame"], (want, got))
                    if "sourceId" in want:
                        self.assertEqual(got["sourceId"], want["sourceId"])

    def test_contain_fit_matches_the_render(self) -> None:
        self.assertEqual(rv.contain_fit(1920, 1080, 1206, 2622), (711, 0, 497, 1080))
        self.assertEqual(rv.contain_fit(360, 784, 360, 784), (0, 0, 360, 784))
        self.assertEqual(rv.contain_fit(1080, 1920, 1920, 1080), (0, 656, 1080, 608))

    def test_overlays_follow_the_tap_window_and_mask_span(self) -> None:
        doc = vs.screen_doc(taps=[{"id": "t1", "sourceId": "s1", "sourceMs": 2000, "pos": [0.5, 0.5]}],
                            masks=[{"id": "m1", "sourceId": "s1", "style": "blur", "startMs": 1000, "endMs": 3000,
                                    "keys": [{"sourceMs": 1000, "rect": [0.1, 0.1, 0.2, 0.1]}, {"sourceMs": 3000, "rect": [0.3, 0.1, 0.2, 0.1]}]}])
        boxes = rv.overlay_boxes(doc, "s1", 2000, 2100, ["taps", "masks"])
        self.assertEqual([b["kind"] for b in boxes], ["tap", "blur"])
        self.assertAlmostEqual(boxes[1]["rect"][0], 0.2)
        edge = rv.tap_box(doc, doc["sources"][0])
        self.assertAlmostEqual(boxes[0]["rect"][2], edge)
        self.assertAlmostEqual(edge, 0.07 * 360 * 1.25 / 360)
        self.assertEqual(rv.overlay_boxes(doc, "s1", 3500, 2700, ["taps", "masks"]), [])
        filters = rv.decorate_filters(400, 800, grid=True, boxes=boxes)
        self.assertTrue(any("0x30D158" in x for x in filters))
        self.assertTrue(any("0x64D2FF" in x for x in filters))
        self.assertEqual(sum(1 for x in filters if x.startswith("drawgrid")), 4)


def render_graph(clips, fps, size):
    """A Python port of edit.rs build_render_args for one source (no masks or taps), to check predict against ffmpeg."""
    w, h = size
    outs = "".join(f"[src0_{j}]" for j in range(len(clips)))
    split = f",split={len(clips)}" if len(clips) > 1 else ""
    g = f"[0:v]fps={fps}:start_time=0{split}{outs};"
    cursor = 0.0
    for i, c in enumerate(clips):
        start = cl.frame_at(cursor, fps)
        cursor += cl.clip_ms(c)
        frames = max(1, cl.frame_at(cursor, fps) - start)
        if c.get("holdMs") is not None:
            head = f"[src0_{i}]trim=start={c['inMs'] / 1000:.6f}:duration=0.5,select=eq(n\\,0),setpts=PTS-STARTPTS,"
        else:
            head = f"[src0_{i}]trim=start={c['inMs'] / 1000:.6f}:end={c['outMs'] / 1000:.6f},setpts=(PTS-STARTPTS)/{c['speed']!r},"
        g += (f"{head}tpad=stop_mode=clone:stop={frames},fps={fps},trim=end_frame={frames},setpts=PTS-STARTPTS,"
              f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v{i}];")
    return g + "".join(f"[v{i}]" for i in range(len(clips))) + f"concat=n={len(clips)}:v=1:a=0[outv]"


def counters(ffmpeg: str, path: Path, vf: str = "") -> list:
    chain = (vf + "," if vf else "") + "crop=240:60:0:0,scale=12:1:flags=area,format=gray"
    raw = subprocess.run([ffmpeg, "-v", "error", "-i", str(path), "-vf", chain, "-f", "rawvideo", "-"], capture_output=True).stdout
    return [sum(1 << i for i in range(12) if raw[k * 12 + i] > 128) for k in range(len(raw) // 12)]


@needs_ffmpeg
class RenderAgreementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="kb-review-"))
        self.ff = TOOLS[0]  # type: ignore[index]

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_predict_matches_an_ffmpeg_render_of_the_edit_chain(self) -> None:
        src = vs.counter_cfr()
        cases = [
            (30, [{"inMs": 50, "outMs": 1050, "speed": 1}]),
            (30, [{"inMs": 17, "outMs": 2017, "speed": 2}, {"inMs": 500, "outMs": 500, "speed": 1, "holdMs": 508}]),
            (30, [{"inMs": 100, "outMs": 1700, "speed": 1.15}, {"inMs": 1700, "outMs": 3100, "speed": 2.15}, {"inMs": 3100, "outMs": 4000, "speed": 6}]),
            (60, [{"inMs": 0, "outMs": 1000, "speed": 1}, {"inMs": 1000, "outMs": 2500, "speed": 1.5}, {"inMs": 3000, "outMs": 4000, "speed": 0.75}]),
        ]
        for fps, raw_clips in cases:
            with self.subTest(fps=fps, clips=raw_clips):
                clips = cl.relayout([dict(c, id=f"c{i}", sourceId="s1") for i, c in enumerate(raw_clips)])
                out = self.tmp / "render.mp4"
                subprocess.run([self.ff, "-v", "error", "-y", "-i", str(src), "-filter_complex", render_graph(clips, fps, (240, 120)),
                                "-map", "[outv]", "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", str(out)], check=True)
                got = counters(self.ff, out)
                slots = counters(self.ff, src, f"fps={fps}:start_time=0")
                doc = {"settings": {"fps": fps}, "sources": [{"id": "s1", "kind": "video"}], "clips": clips}
                want = [slots[p["slot"]] for p in rv.predict(doc, range(len(got)))]
                self.assertEqual(len(got), cl.total_frames(clips, fps))
                self.assertEqual(got, want)

    def test_fast_path_equals_the_full_decode(self) -> None:
        for src, fps in ((vs.screen_vfr(), 60.0), (vs.counter_cfr(), 30.0)):
            with self.subTest(src=src.name):
                slots = [rv.slot_of(t, fps) for t in (9500.0, 10250.0, 11010.0)]
                fast = rv.extract_slots(self.ff, src, fps, slots, self.tmp / "fast", "f", fast=True)
                full = rv.extract_slots(self.ff, src, fps, slots, self.tmp / "full", "f", fast=False)
                for n in slots:
                    self.assertEqual(fast[n].read_bytes(), full[n].read_bytes(), n)

    def test_seam_diff_is_zero_inside_a_static_stretch(self) -> None:
        doc = vs.screen_doc(clips=[{"id": "c1", "sourceId": "s1", "inMs": 0, "outMs": 22250, "speed": 1},
                                   {"id": "c2", "sourceId": "s1", "inMs": 24567, "outMs": 28000, "speed": 1}])
        doc["clips"] = cl.relayout(doc["clips"])
        start = cl.frame_grid(doc["clips"], 60)[1][0]
        pair = rv.predict(doc, [start - 1, start])
        pngs = rv.extract_slots(self.ff, vs.screen_vfr(), 60, [p["slot"] for p in pair], self.tmp / "seam", "s")
        self.assertLess(rv.seam_diff(self.ff, pngs[pair[0]["slot"]], pngs[pair[1]["slot"]]), rv.SEAMLESS_PCT)
        jump = rv.extract_slots(self.ff, vs.screen_vfr(), 60, [rv.slot_of(17000, 60), rv.slot_of(18500, 60)], self.tmp / "jump", "j")
        a, b = sorted(jump)
        self.assertGreater(rv.seam_diff(self.ff, jump[a], jump[b]), 1.0)


@needs_ffmpeg
class ReviewCommandTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        shutil.copyfile(vs.screen_vfr(), self.root / "assets" / "onboarding.mov")
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

    def png_size(self, path: str):
        data = Path(path).read_bytes()
        return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")

    def test_gridded_source_frames(self) -> None:
        code, out = self.run_cmd(["frames", "assets/onboarding.mov", "--src", "24.967,3", "--grid", "--json"])
        self.assertEqual(code, 0)
        frames = json.loads(out)["frames"]
        self.assertEqual(len(frames), 2)
        w, h = self.png_size(frames[0]["path"])
        self.assertEqual((w % 20, h % 20), (0, 0))
        self.assertLessEqual(max(w, h), 1568)
        self.assertTrue(frames[0]["path"].startswith(str(self.bridge / "video")))

    def test_zoom_enlarges(self) -> None:
        code, out = self.run_cmd(["frames", "onboarding.mov", "--at", "25", "--zoom", "0.6,0.33,0.2,0.1", "--json"])
        self.assertEqual(code, 0)
        w, h = self.png_size(json.loads(out)["frames"][0]["path"])
        self.assertGreater(w, 360 * 0.2 * 2)

    def test_sheet_with_legend(self) -> None:
        code, out = self.run_cmd(["sheet", "assets/onboarding.mov", "--count", "10", "--json"])
        self.assertEqual(code, 0)
        meta = json.loads(out)
        self.assertEqual(len(meta["cells"]), 10)
        self.assertTrue(Path(meta["json"]).is_file())
        w, h = self.png_size(meta["paths"][0])
        self.assertLessEqual(max(w, h), 1568)
        self.assertLessEqual(w * h, 1_150_000)
        code, text = self.run_cmd(["sheet", "assets/onboarding.mov", "--every", "4"])
        self.assertEqual(code, 0)
        self.assertIn("next: Read", text)

    def test_edit_only_modes_refuse_a_file(self) -> None:
        code, _ = self.run_cmd(["sheet", "assets/onboarding.mov", "--seams"])
        self.assertEqual(code, 2)
        code, _ = self.run_cmd(["frames", "assets/onboarding.mov", "--tap", "t1"])
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
