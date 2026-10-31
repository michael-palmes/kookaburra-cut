from __future__ import annotations

import json
import os
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List

from kblib import check, identity
from kblib.film import handoffs as ho
from kblib.film import pacing as pc
from kblib.film import swatch as sw
from kblib.film import timeline as tl
from kblib.project import Project

from . import video_synth as vs
from .helpers import KbTestCase, make_project, write, write_json

TOOLS = vs.tools()
needs_ffmpeg = unittest.skipUnless(TOOLS, "no ffmpeg")
DARK = "0x0b0f14"


def three_scenes(root: Path, durations: List[int], **extra: Any) -> Path:
    project = make_project(root, scenes=["01-a", "02-b", "03-c"])
    manifest = json.loads((project / "project.json").read_text())
    manifest["scenes"] = [{"file": f"scenes/{s}.tsx", "durationMs": d} for s, d in zip(["01-a", "02-b", "03-c"], durations)]
    manifest.update(extra)
    write_json(project / "project.json", manifest)
    return project


class EndHoldTests(unittest.TestCase):
    def test_the_last_scene_never_counts_as_short(self) -> None:
        slots = [{"index": 0, "durationMs": 2000}, {"index": 1, "durationMs": 600}, {"index": 2, "durationMs": 300}]
        self.assertTrue(ho.seam_short(slots, 0))
        self.assertFalse(ho.seam_short([slots[0], slots[2]], 0))
        self.assertTrue(ho.seam_short(slots, 1))


class WordTests(KbTestCase):
    def test_label_keys_and_label_size_tsx_text_never_count(self) -> None:
        self.assertTrue(pc.label_key("cardLabel"))
        self.assertTrue(pc.label_key("stat-unit"))
        self.assertFalse(pc.label_key("tagline"))
        self.assertFalse(pc.label_key("title"))
        tsx = ('const chip = useSceneText("chip", "New", "embedded");\n'
               '<AnimatedHeadline text={note} textKey="note" fontSize={0.16} />\n'
               '<AnimatedHeadline text={title} textKey="title" fontSize={0.5} />\n'
               '<AnimatedHeadline textKey="axis2" managedTextRole="embedded" />')
        self.assertEqual(pc.tsx_label_keys(tsx), {"chip", "note", "axis2"})
        doc = {"text": {"title": "one two three", "cardLabel": "x y", "note": "p q", "chip": "New"}}
        self.assertEqual(pc.scene_word_counts(doc, tsx), (3, 5))

    def test_a_managed_stack_leaves_embedded_labels_out(self) -> None:
        doc = {"managedText": {"items": [{"key": "title", "type": "title", "text": "Pick a slot"},
                                         {"key": "eyebrowText", "type": "subtitle", "text": "Brand new"}]},
               "text": {"title": "managed", "price": "From ten dollars"}}
        self.assertEqual(pc.scene_word_counts(doc), (3, 5))

    def test_rates_per_beat_and_the_last_scene_holds(self) -> None:
        grid = {"bpm": 120, "offsetMs": 0, "beatsPerBar": 4, "source": {"kind": "manual"}}
        project = three_scenes(self.tmp, [2000, 300, 200], audio={"file": "assets/song.mp3", "grid": grid})
        write_json(project / "scenes" / "01-a.json", {"version": 1, "text": {"title": "one two three four five six seven eight", "badge": "x y z"}})
        for stem in ("02-b", "03-c"):
            write_json(project / "scenes" / f"{stem}.json", {"version": 1})
        p = Project(project)
        result = pc.check(p, tl.project_slots(p))
        first, middle, last = result["scenes"]
        self.assertEqual((first["words"], first["labelWords"], first["beats"], first["wordsPerBeat"]), (8, 3, 4.0, 2.0))
        self.assertEqual(first["flag"], "too much to read")
        self.assertTrue(any("2 a beat over 4 beats" in w for w in result["warnings"]))
        self.assertEqual(middle["flag"], "shorter than a flash")
        self.assertNotIn("flag", last)


class MotionTests(KbTestCase):
    def test_tsx_driven_scenes_count_as_moving(self) -> None:
        project = three_scenes(self.tmp, [4000, 4000, 4000])
        p = Project(project)
        still = pc.check(p, tl.project_slots(p))
        self.assertEqual(still["still"]["longestStillMs"], 12000)
        self.assertTrue(any("no keyed or TSX motion" in w for w in still["warnings"]))
        tsx = project / "scenes" / "02-b.tsx"
        write(tsx, tsx.read_text().replace("export default", "const spin = () => useTimeline();\nexport default"))
        moving = pc.check(Project(project), tl.project_slots(Project(project)))
        self.assertEqual((moving["still"]["longestStillMs"], moving["still"]["source"]), (4000, "static"))
        self.assertEqual(moving["warnings"], [])

    def test_still_spans_from_frame_differences(self) -> None:
        flat, other = bytes([10] * 1024), bytes([10] * 1023 + [40])
        self.assertEqual(pc.still_spans([flat] * 5, 200), [(0, 800)])
        self.assertEqual(pc.still_spans([flat, flat, other, other, other], 200, 1000), [(1000, 1200), (1400, 1800)])
        self.assertFalse(pc.moving(flat, bytes([10, 11] * 512)))
        self.assertTrue(pc.moving(flat, bytes([11] * 1024)))

    @needs_ffmpeg
    def test_motion_is_measured_on_the_film(self) -> None:
        assert TOOLS
        graph = (f"color=c={DARK}:s=64x36:r=30:d=3[a];testsrc2=s=64x36:r=30:d=2[b];"
                 "[a][b]concat=n=2:v=1:a=0,format=yuv420p[out]")
        film = vs._built("signal-motion", "mp4", [TOOLS[0], "-v", "error", "-y", "-filter_complex", graph, "-map", "[out]",
                                                  "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0"])
        slots = [{"index": 0, "stem": "01-a", "startMs": 0, "endMs": 5000, "durationMs": 5000}]
        motion = pc.film_motion(TOOLS[0], film, 30, 0, slots)
        self.assertEqual(motion["source"], "film")
        longest = max(b - a for a, b in motion["spans"])
        self.assertGreaterEqual(longest, 2600)
        self.assertTrue(all(b <= 3200 for a, b in motion["spans"] if b - a > 400))


class SettleTests(KbTestCase):
    def test_settled_moments_skip_the_cut_and_follow_keyed_moves(self) -> None:
        project = three_scenes(self.tmp, [3000, 3000, 3000])
        manifest = json.loads((project / "project.json").read_text())
        manifest["scenes"][0]["transition"] = {"type": "crossfade", "durationMs": 600}
        write_json(project / "project.json", manifest)
        write_json(project / "scenes" / "03-c.json", {"version": 1, "camera": {"keys": [{"id": "k", "tMs": 2200, "pose": {}}]}})
        p = Project(project)
        slots = tl.project_slots(p)
        self.assertEqual(sw.settled_ms(p, slots, 0), 400)
        self.assertEqual(sw.settled_ms(p, slots, 1), slots[1]["startMs"] + 1000)
        self.assertEqual(sw.settled_ms(p, slots, 2), slots[2]["startMs"] + 2200)
        short = [{"index": 0, "stem": "01-a", "startMs": 0, "endMs": 300, "durationMs": 300}]
        self.assertAlmostEqual(sw.settled_ms(p, short, 0), 300 - 1000 / 60)

    def test_covered_corners_need_a_matching_one(self) -> None:
        self.assertEqual(sw.covered_corners([0.5, 15.0, 0.8, 3.0], [0.1, 0.2, 0.1, 6.0]), [1, 3])
        self.assertEqual(sw.covered_corners([0.5, 4.0, 0.8, 1.0], [0.1, 0.2, 0.1, 0.1]), [])
        self.assertEqual(sw.covered_corners([12.0, 15.0, 14.0, 13.0], [9.0, 9.0, 9.0, 9.0]), [])

    @needs_ffmpeg
    def test_a_device_in_a_corner_is_skipped_only_in_device_scenes(self) -> None:
        assert TOOLS
        graph = f"color=c={DARK}:s=320x180:r=30:d=1,drawbox=x=286:y=0:w=12:h=40:color=white:t=fill,format=yuv420p[out]"
        film = vs._built("signal-corner", "mp4", [TOOLS[0], "-v", "error", "-y", "-filter_complex", graph, "-map", "[out]",
                                                  "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0"])
        patches = sw.measure_corner_patches(TOOLS[0], film, [0], 320, 180)[0]
        self.assertLess(patches[0]["spread"], 1.0)
        self.assertGreater(patches[1]["spread"], sw.DELTA_E_PATCHY)
        project = make_project(self.tmp, scenes=["01-a"])
        write_json(project / "scenes" / "01-a.json", {"version": 1, "background": {"type": "color", "color": "#0b0f14"}})
        slots = tl.project_slots(Project(project))
        plain = sw.check(TOOLS[0], film, Project(project), slots, {0: 0}, 320, 180, None)
        self.assertEqual(len(plain["warnings"]), 1)
        self.assertNotIn("skipped", plain["swatches"][0])
        write_json(project / "scenes" / "01-a.json", {"version": 1, "background": {"type": "color", "color": "#0b0f14"},
                                                      "devices": [{"id": "d1", "model": "android"}]})
        device = sw.check(TOOLS[0], film, Project(project), slots, {0: 0}, 320, 180, None)
        row = device["swatches"][0]
        self.assertEqual((row["skipped"], row["ok"], device["warnings"]), (["top-right"], True, []))
        self.assertIn("a device covers it", row["note"])


THEME: Dict[str, Any] = {"version": 3, "id": "brand", "name": "Brand", "colors": {"background": "#0b1020", "text": "#f4f6fb"},
                         "textAnimation": {"in": "fade", "out": "none", "staggerMs": 0, "delivery": "by-paragraph"}}


class ThemeOnceTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        manifest = json.loads((self.root / "project.json").read_text())
        manifest["themeId"] = "ws:brand"
        write_json(self.root / "project.json", manifest)
        self.theme = self.tmp / "themes" / "brand" / "theme.json"
        write_json(self.theme, THEME)
        self.project = Project(self.root)

    def run_once(self, caller: identity.Caller) -> check.Report:
        report = check.check_project(self.project)
        check.collapse_theme_warnings(self.project, report, caller)
        return report

    def theme_lines(self, report: check.Report, severity: str) -> List[str]:
        return [i.message for i in report.issues if i.severity == severity and i.file.startswith("../themes/")]

    def test_theme_warnings_show_once_a_session_until_the_file_changes(self) -> None:
        alpha = identity.Caller("alpha", "session-1")
        first = self.run_once(alpha)
        self.assertTrue(any("staggerExact" in w for w in self.theme_lines(first, "warning")))
        self.assertTrue(any(str(self.theme) in n and "once a session" in n for n in self.theme_lines(first, "info")))
        again = self.run_once(alpha)
        self.assertEqual(self.theme_lines(again, "warning"), [])
        self.assertTrue(any("already shown this session" in n for n in self.theme_lines(again, "info")))
        self.assertTrue(self.theme_lines(self.run_once(identity.Caller("alpha", "session-2")), "warning"))
        time.sleep(0.01)
        write_json(self.theme, dict(THEME, name="Brand 2"))
        self.assertTrue(self.theme_lines(self.run_once(identity.Caller("alpha", "session-2")), "warning"))
        self.assertTrue(self.theme_lines(self.run_once(identity.Caller("beta")), "warning"))
        self.assertTrue(self.theme_lines(self.run_once(identity.Caller("beta")), "warning"))

    def test_only_a_check_that_reaches_the_agent_collapses(self) -> None:
        identity.bind(identity.Caller("alpha", "session-1"))
        try:
            check.check_project(self.project)
            check.check_project(self.project)
            self.assertTrue(self.theme_lines(check.check_project(self.project, once=True), "warning"))
            self.assertEqual(self.theme_lines(check.check_project(self.project, once=True), "warning"), [])
        finally:
            identity.bind(None)
        self.assertTrue(os.path.isfile(self.root / ".kb" / "agents" / "alpha" / check.THEME_NOTES))


if __name__ == "__main__":
    unittest.main()
