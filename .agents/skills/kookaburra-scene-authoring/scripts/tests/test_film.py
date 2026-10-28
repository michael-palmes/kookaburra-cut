from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path
from typing import Any, Dict, List

from kblib.film import cli as filmcli
from kblib.film import flashes as fl
from kblib.film import handoffs as ho
from kblib.film import pacing as pc
from kblib.film import probe as pb
from kblib.film import report as rp
from kblib.film import swatch as sw
from kblib.film import timeline as tl
from kblib.catalog import load_catalog, reset_cache
from kblib.project import Project
from kblib.util import KbError
from kblib.video.passes import Tools

from . import video_synth as vs
from .helpers import FIXTURES, SCRIPTS, KbTestCase, make_project, write, write_json

TOOLS = vs.tools()
needs_ffmpeg = unittest.skipUnless(TOOLS, "no ffmpeg")
REAL_CATALOG = SCRIPTS.parent / "catalog.json"
DARK, LIGHT = "0x0b0f14", "0xf5f7fa"


def film_project(root: Path, **extra: Any) -> Path:
    """A two-scene project laid out like fixtures/flash-spike: 2 s title, 500 ms crossfade, 2.5 s strobe."""
    project = make_project(root, scenes=["01-title", "02-strobe"])
    manifest = json.loads((project / "project.json").read_text())
    manifest["scenes"] = [
        {"file": "scenes/01-title.tsx", "durationMs": 2000, "transition": {"type": "crossfade", "durationMs": 500}},
        {"file": "scenes/02-strobe.tsx", "durationMs": 2500},
    ]
    manifest.update(extra)
    write_json(project / "project.json", manifest)
    return project


def strobe_film(stem: str, *, size: str = "320x180", frames: int = 240, audio: bool = False, period: int = 12,
                start: int = 150, stop: int = 210) -> Path:
    """Dark frames with light ones between `start` and `stop` (half of each `period` frames lit), then a 2 Hz control."""
    assert TOOLS
    ff = TOOLS[0]
    seconds = frames / 60.0
    lit = (f"between(n\\,{start}\\,{stop - 1})*eq(mod(floor((n-{start})/{period // 2})\\,2)\\,1)"
           f"+gte(n\\,{stop})*eq(mod(floor((n-{stop})/15)\\,2)\\,1)")
    graph = (f"color=c={DARK}:s={size}:r=60:d={seconds}[a];color=c={LIGHT}:s={size}:r=60:d={seconds}[b];"
             f"[a][b]overlay=enable='{lit}',format=yuv420p[out]")
    if audio:
        graph += f";sine=frequency=440:duration={seconds}:sample_rate=48000[tone]"
    args = [ff, "-v", "error", "-y", "-filter_complex", graph, "-map", "[out]"]
    if audio:
        args += ["-map", "[tone]", "-c:a", "aac", "-b:a", "128k"]
    args += ["-frames:v", str(frames), "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-bf", "0"]
    return vs._built(stem, "mp4", args)


def tools() -> Tools:
    assert TOOLS
    return Tools(TOOLS[0], TOOLS[1])


class TimelineVectorTests(unittest.TestCase):
    def test_the_mirror_replays_the_app_timeline(self) -> None:
        vectors = json.loads((FIXTURES / "timeline-vectors.json").read_text())
        self.assertGreater(len(vectors["cases"]), 5)
        for case in vectors["cases"]:
            with self.subTest(case=case["id"]):
                out = tl.outgoing_transitions(case["manifest"])
                scenes = [{"id": f"s{i}", "durationMs": s["durationMs"], "transition": out[i]} for i, s in enumerate(case["manifest"]["scenes"])]
                slots = tl.build_scene_timeline(scenes)
                self.assertEqual(slots, case["slots"])
                self.assertEqual(tl.timeline_total_ms(slots), case["totalMs"])
                for at in case["at"]:
                    got = tl.resolve_at(slots, at["tMs"])
                    self.assertEqual(got["active"], at["active"], at["tMs"])
                    if at["transition"] is None:
                        self.assertIsNone(got["transition"])
                    else:
                        want, have = at["transition"], got["transition"]
                        self.assertEqual((have["type"], have["fromIndex"], have["toIndex"]), (want["type"], want["fromIndex"], want["toIndex"]))
                        self.assertAlmostEqual(have["progress"], want["progress"], places=12)


class TimelineTests(KbTestCase):
    def test_project_slots_use_manifest_durations_then_the_tsx(self) -> None:
        project = film_project(self.tmp)
        slots = tl.project_slots(Project(project))
        self.assertEqual([(s["stem"], s["startMs"], s["endMs"]) for s in slots], [("01-title", 0, 2000), ("02-strobe", 1500, 4000)])
        self.assertEqual(slots[1]["transitionIn"], {"type": "crossfade", "durationMs": 500})
        manifest = json.loads((project / "project.json").read_text())
        del manifest["scenes"][1]["durationMs"]
        write_json(project / "project.json", manifest)
        write(project / "scenes" / "02-strobe.tsx", 'export default defineScene({ id: "strobe", durationMs: 1250, Scene() { return null; } });\n')
        self.assertEqual(tl.project_slots(Project(project))[1]["durationMs"], 1250.0)

    def test_frames_follow_the_export_grid_and_the_poster_frame(self) -> None:
        self.assertEqual(tl.export_frames(4000, 60), 240)
        self.assertEqual(tl.export_frames(1, 60), 1)
        self.assertEqual(tl.export_frames(1025, 30), 31)
        self.assertEqual(tl.frame_at(1500, 60), 90)
        self.assertEqual(tl.frame_at(1500, 60, 1), 91)
        self.assertEqual(tl.last_frame_before(2000, 60), 119)
        self.assertEqual(tl.last_frame_before(2000, 30, 1), 60)
        self.assertEqual(tl.frame_ms(91, 60, 1), 1500)
        slots = tl.build_scene_timeline([{"id": "a", "durationMs": 2000, "transition": {"type": "dip", "durationMs": 500}}, {"id": "b", "durationMs": 2500}])
        self.assertEqual(tl.scene_at(slots, 1600), (1, 100))
        self.assertEqual(tl.scene_at(slots, 9999), (1, 2500))
        self.assertIsNone(tl.scene_at([], 0))


class ExpectationTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        os.environ["KB_CATALOG"] = str(REAL_CATALOG)
        reset_cache()
        self.catalog = load_catalog()

    def test_names_give_the_aspect_and_the_preset(self) -> None:
        parse = lambda n: rp.parse_name(n, "product-tour", self.catalog)  # noqa: E731
        self.assertEqual(parse("product-tour-16x9.mp4"), {"aspect": "16:9", "suffix": None})
        self.assertEqual(parse("product-tour-9x16-tiktok.mp4"), {"aspect": "9:16", "suffix": "tiktok"})
        self.assertEqual(parse("product-tour-phone-landscape-custom 2.mov"), {"aspect": "phone-landscape", "suffix": "custom"})
        self.assertEqual(parse("product-tour-phone.mp4"), {"aspect": "phone", "suffix": None})
        self.assertEqual(parse("holiday.mp4"), {"aspect": None, "suffix": None})

    def test_short_edges_match_encode_rs(self) -> None:
        self.assertEqual(rp.out_dims(3840, 2160, 1080), (1920, 1080))
        self.assertEqual(rp.out_dims(1206, 2622, 720), (720, 1566))
        self.assertEqual(rp.out_dims(2160, 3840, 2160), (2160, 3840))
        self.assertEqual(rp.out_dims(2160, 2160, None), (2160, 2160))

    def test_static_expectations_for_high_quality_presets_and_unknown_ones(self) -> None:
        project = Project(film_project(self.tmp))
        slots = tl.project_slots(project)
        exp = rp.static_expectations(project, Path("demo-16x9.mp4"), self.catalog, slots)
        self.assertEqual((exp["aspect"], exp["width"], exp["height"], exp["fps"], exp["frames"], exp["audio"]), ("16:9", 3840, 2160, 60, 240, False))
        tiktok = rp.static_expectations(project, Path("demo-9x16-tiktok.mp4"), self.catalog, slots)
        self.assertEqual((tiktok["width"], tiktok["height"], tiktok["fps"], tiktok["frames"], tiktok["loudnessTarget"]), (1080, 1920, 30, 120, -14))
        other = rp.static_expectations(project, Path("demo-9x16-client-cut.mp4"), self.catalog, slots)
        self.assertIsNone(other["fps"])
        self.assertIn("not in this kit's catalogue", other["note"])
        self.assertNotIn("width", other)


class ColourTests(KbTestCase):
    def test_ciede2000_matches_sharmas_table(self) -> None:
        pairs = [
            ((50.0, 2.6772, -79.7751), (50.0, 0.0, -82.7485), 2.0425),
            ((50.0, 0.0, 0.0), (50.0, -1.0, 2.0), 2.3669),
            ((50.0, 2.5, 0.0), (73.0, 25.0, -18.0), 27.1492),
            ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
            ((2.0776, 0.0795, -1.135), (0.9033, -0.0636, -0.5514), 0.9082),
        ]
        for a, b, want in pairs:
            self.assertAlmostEqual(sw.ciede2000(a, b), want, places=4)
        self.assertEqual(sw.delta_e((11, 15, 20), (11, 15, 20)), 0.0)
        self.assertLess(sw.delta_e((11, 15, 20), (12, 16, 21)), 2.0)
        self.assertEqual(sw.hex_rgb("#0B0F14"), (11, 15, 20))
        self.assertEqual(sw.hex_rgb("#abc"), (170, 187, 204))
        self.assertIsNone(sw.hex_rgb("teal"))

    def test_only_flat_backgrounds_get_an_expected_colour(self) -> None:
        os.environ["KB_CATALOG"] = str(REAL_CATALOG)
        reset_cache()
        catalog = load_catalog()
        project = Project(film_project(self.tmp))
        self.assertEqual(sw.expected_background(project, 0, "01-title", catalog), {"colour": "#0b0f14", "source": "theme kookaburra-default background colour"})
        write_json(project.root / "scenes" / "02-strobe.json", {"version": 1, "name": "Strobe", "background": {"type": "color", "color": "#336699"}})
        self.assertEqual(sw.expected_background(project, 1, "02-strobe", catalog)["colour"], "#336699")
        write_json(project.root / "scenes" / "02-strobe.json", {"version": 1, "background": {"type": "shader", "shader": "swirl"}})
        self.assertEqual(sw.expected_background(project, 1, "02-strobe", catalog), {"colour": None, "reason": "a shader background"})
        manifest = json.loads(project.manifest_path.read_text())
        manifest["themeId"] = "kookaburra-fx"
        write_json(project.manifest_path, manifest)
        project = Project(project.root)
        self.assertTrue(sw.expected_background(project, 0, "01-title", catalog)["measuredOnly"])
        self.assertIn("aces tone mapping", sw.tone_mapping_warning(project, catalog) or "")
        manifest["render"] = {"toneMapping": "neutral"}
        write_json(project.manifest_path, manifest)
        self.assertIsNone(sw.tone_mapping_warning(Project(project.root), catalog))

    def test_corner_patches_sit_at_a_three_percent_inset(self) -> None:
        self.assertEqual(sw.corner_origins(3840, 2160), [(115, 65), (3701, 65), (115, 2071), (3701, 2071)])


class PacingTests(KbTestCase):
    def test_words_reading_speed_short_scenes_and_still_stretches(self) -> None:
        self.assertEqual(pc.count_words("Ship it: today's the day, 3 times."), 7)
        doc = {"managedText": {"items": [{"key": "title", "type": "title", "text": "Pick a slot"},
                                         {"key": "list", "type": "bullets", "points": [{"text": "One tap"}, {"text": "Two taps"}]},
                                         {"key": "i", "type": "icon", "icon": "star"}]},
               "text": {"title": "ignored, managed", "eyebrow": "New"}}
        self.assertEqual(pc.scene_words(doc), 7)
        project = film_project(self.tmp)
        write_json(project / "scenes" / "01-title.json", {"version": 1, "text": {"title": "one two three four five six seven"}})
        write_json(project / "scenes" / "02-strobe.json", {"version": 1, "camera": {"keys": [{"id": "k1", "tMs": 500, "pose": {}}]}})
        p = Project(project)
        result = pc.check(p, tl.project_slots(p))
        self.assertEqual(result["scenes"][0]["flag"], "too much to read")
        self.assertEqual(result["still"], {"longestStillMs": 2000, "fromMs": 0, "toMs": 2000, "scenes": ["01-title", "02-strobe"], "source": "static"})
        manifest = json.loads((project / "project.json").read_text())
        manifest["scenes"][1]["durationMs"] = 300
        manifest["scenes"][0]["transition"] = {"type": "crossfade", "durationMs": 0}
        write_json(project / "project.json", manifest)
        p = Project(project)
        short = pc.check(p, tl.project_slots(p))
        self.assertNotIn("flag", short["scenes"][1])
        self.assertFalse(any("under 334 ms" in w for w in short["warnings"]))


PRECHECK_LOG = "\n".join(
    [f"[metadata@ps @ 0x7f00] frame:{n}    pts:{n * 256}     pts_time:{n / 60:.6g}\n[metadata@ps @ 0x7f00] lavfi.photosensitivity.badness={b:.6f}"
     for n, b in enumerate([0.0] * 60 + [7.2] * 30 + [3.0] * 120 + [8.1] * 10)]
)


class FlashReportTests(KbTestCase):
    def test_the_precheck_folds_bad_frames_into_spans(self) -> None:
        pre = fl.parse_precheck(PRECHECK_LOG)
        self.assertEqual(pre["maxBadness"], 8.1)
        self.assertEqual(pre["frames"], 220)
        self.assertEqual([(c["startMs"], c["endMs"], c["badness"]) for c in pre["candidates"]], [(1000, 1483, 7.2), (3500, 3650, 8.1)])
        self.assertEqual(fl.parse_precheck("")["candidates"], [])
        args = fl.precheck_args("/x/ffmpeg", Path("/tmp/a,b.mp4"), 59.94)
        self.assertIn("scale=1024:-2:flags=area,photosensitivity=frames=60:bypass=1,metadata@ps=mode=print", args)
        self.assertIn("/tmp/a,b.mp4", args)

    def test_issues_land_on_scenes_after_the_poster_frame(self) -> None:
        slots = tl.project_slots(Project(film_project(self.tmp)))
        report = {"issues": [{"startMs": 2517, "severity": "fail"}, {"startMs": 17, "severity": "warn"}]}
        fl.place_issues(report, slots, 1000 / 60)
        self.assertEqual(report["issues"][0]["scene"], {"index": 1, "stem": "02-strobe", "localMs": 1000})
        self.assertEqual(report["issues"][1]["scene"], {"index": 0, "stem": "01-title", "localMs": 0})
        self.assertEqual(len(fl.failures(report)), 1)

    def test_the_app_detector_needs_caps_that_list_it(self) -> None:
        self.assertIsNone(fl.app_cli())
        self.fake_cli()
        self.assertIsNone(fl.app_cli())
        self.fake_cli(caps=json.dumps({"checks": ["flashes"]}))
        info = fl.app_cli()
        self.assertIsNotNone(info)
        film = self.tmp / "film.mp4"
        film.write_bytes(b"x")
        self.assertTrue(fl.run_cli(info, film, "both")["ok"])  # type: ignore[arg-type]

    def test_summary_lines_name_the_gate(self) -> None:
        lines = fl.summary_lines({"gate": "unavailable", "note": "update", "precheck": {"maxBadness": 9.5, "candidates": [{"startMs": 2500, "endMs": 3400, "badness": 9.5}]}})
        self.assertIn("gate unavailable", lines[0])
        self.assertIn("look here: 2.50-3.40s (9.5)", lines[1])


class HandoffTests(unittest.TestCase):
    SLOTS = [
        {"index": 0, "stem": "01-a", "startMs": 0, "endMs": 2000, "durationMs": 2000},
        {"index": 1, "stem": "02-b", "startMs": 1500, "endMs": 2300, "durationMs": 800, "transitionIn": {"type": "dip", "durationMs": 500}},
        {"index": 2, "stem": "03-c", "startMs": 2300, "endMs": 4300, "durationMs": 2000},
    ]

    def test_seams_take_either_side_of_a_transition_or_a_cut(self) -> None:
        seams = ho.seam_frames(self.SLOTS, 60, 1, 259)
        self.assertEqual([(s["kind"], s["frames"], s["short"]) for s in seams], [("dip", [90, 121], True), ("cut", [138, 139], True)])
        seams[1]["deltaL"] = 0.4
        warnings = ho.flag_seams(seams, 60)
        self.assertEqual(seams[1]["flag"], "luminance step next to a short scene")
        self.assertEqual(len(warnings), 1)

    def test_four_hard_steps_in_a_second_strobe(self) -> None:
        seams = [{"kind": "cut", "deltaL": 0.3 * (-1) ** i, "atMs": 200 * i, "short": False, "from": "a", "to": "b"} for i in range(5)]
        self.assertTrue(any("within one second" in w for w in ho.flag_seams(seams, 60)))
        self.assertAlmostEqual(ho.mean_luminance(bytes([255, 255, 255, 0, 0, 0])), 0.5)


@needs_ffmpeg
class FilmFfmpegTests(KbTestCase):
    def test_the_precheck_flags_the_strobe_and_not_the_control(self) -> None:
        strobe = fl.precheck(tools(), strobe_film("film-strobe"), 60)
        self.assertGreaterEqual(strobe["maxBadness"], fl.LOOK_HERE_BADNESS)
        self.assertTrue(strobe["candidates"])
        self.assertTrue(all(2400 <= c["startMs"] <= 3500 for c in strobe["candidates"]))
        calm = fl.precheck(tools(), strobe_film("film-calm", start=150, stop=150), 60)
        self.assertLess(calm["maxBadness"], fl.LOOK_HERE_BADNESS)
        self.assertEqual(calm["candidates"], [])

    def test_corners_measure_a_flat_frame(self) -> None:
        film = strobe_film("film-strobe")
        corners = sw.measure_corners(TOOLS[0], film, [0, 157], 320, 180)  # type: ignore[index]
        for c in corners[0]:
            self.assertLess(sw.delta_e(c, (11, 15, 20)), 2.0, c)
        for c in corners[157]:
            self.assertLess(sw.delta_e(c, (245, 247, 250)), 2.0, c)

    def test_handoffs_read_the_luminance_step(self) -> None:
        film = strobe_film("film-strobe")
        slots = [{"index": 0, "stem": "01-a", "startMs": 0, "endMs": 2600, "durationMs": 2600},
                 {"index": 1, "stem": "02-b", "startMs": 2600, "endMs": 4000, "durationMs": 1400}]
        result = ho.check(TOOLS[0], film, slots, 60, 0, 240, out_dir=self.tmp / "seams")  # type: ignore[index]
        seam = result["seams"][0]
        self.assertEqual(seam["frames"], [155, 156])
        self.assertGreater(abs(seam["deltaL"]), 0.8)
        self.assertGreater(seam["diffPct"], 50)

    def test_probe_and_loudness(self) -> None:
        film = strobe_film("film-tone", audio=True)
        facts = pb.probe(film, tools())
        self.assertEqual((facts["video"]["width"], facts["video"]["frames"], facts["video"]["rFps"]), (320, 240, 60.0))
        self.assertEqual(facts["audio"]["codec"], "aac")
        loud = pb.loudness(film, tools()) or {}
        self.assertLess(loud["integratedLufs"], -10)
        self.assertLess(loud["truePeakDbtp"], 0)


FAIL_REPORT = {
    "version": 1, "approximate": True, "standards": ["wcag-2.3.1"], "source": "file", "fps": 60.0, "frames": 240, "grid": [64, 36],
    "ok": False, "issues": [{"type": "general", "standard": "wcag", "severity": "fail", "startMs": 2500, "endMs": 3500, "tc": "00:02.500",
                             "scene": None, "flashesPerSecond": 5.0, "areaPct": 100.0, "region": [0, 0, 1, 1], "deltaL": 0.9,
                             "hint": "hold each state at least 334 ms, or keep the change under 10% luminance"}],
}


@needs_ffmpeg
class VerifyExportTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        assert TOOLS
        self.env.update({"KB_FFMPEG": TOOLS[0], "KB_FFPROBE": TOOLS[1], "KB_CATALOG": str(REAL_CATALOG)})
        self.project = film_project(self.tmp)
        self.film = self.project / "exports" / "demo-16x9.mp4"
        self.film.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(strobe_film("film-strobe"), self.film)

    def record(self, **extra: Any) -> Path:
        sha = rp.sha256_file(self.film)
        body: Dict[str, Any] = {"version": 1, "sha256": sha, "path": str(self.film), "project": "ws:demo", "aspect": "16:9",
                                "preset": "kookaburra-standard", "lane": "frozen", "codec": "libx264", "fps": 60, "width": 320, "height": 180,
                                "posterFrame": False, "frames": 240, "totalMs": 4000, "audio": False}
        body.update(extra)
        path = self.bridge / "exports" / "demo" / f"{sha[:16]}.json"
        write_json(path, body)
        return path

    def verify(self, *args: str) -> subprocess.CompletedProcess:
        return self.kb(["verify-export", str(self.film), "--json"] + list(args), cwd=self.project)

    def test_static_expectations_catch_a_wrong_size(self) -> None:
        proc = self.verify("--no-flashes", "--no-sheet")
        self.assertExit(proc, 1)
        out = json.loads(proc.stdout)
        self.assertEqual((out["ok"], out["command"], out["code"]), (False, "verify-export", "failed"))
        size = next(c for c in out["checks"] if c["id"] == "size")
        self.assertEqual((size["ok"], size["expected"], size["actual"]), (False, [3840, 2160], [320, 180]))
        self.assertIn("size 320x180, expected 3840x2160", proc.stderr)

    def test_a_record_passes_and_the_sheet_and_swatches_come_back(self) -> None:
        self.record()
        proc = self.verify("--no-flashes")
        self.assertExit(proc, 0)
        out = json.loads(proc.stdout)
        self.assertTrue(out["ok"])
        self.assertTrue(out["record"].endswith(".json"))
        self.assertTrue(all(c["ok"] for c in out["checks"]))
        self.assertEqual(len(out["sheets"]), 1)
        self.assertTrue(Path(out["sheets"][0]).is_file())
        labels = [(f["scene"], f["label"]) for f in out["frames"]]
        self.assertEqual(labels, [("01-title", "first"), ("01-title", "middle"), ("01-title", "last"),
                                  ("02-strobe", "first"), ("02-strobe", "settled"), ("02-strobe", "middle"), ("02-strobe", "last")])
        title = next(s for s in out["swatches"] if s["stem"] == "01-title")
        self.assertTrue(title["ok"], title)

    def test_a_flash_failure_exits_one_unless_allowed(self) -> None:
        self.record()
        report = self.tmp / "report.json"
        write_json(report, FAIL_REPORT)
        self.fake_cli(caps=json.dumps({"checks": ["flashes"]}), flash_report=str(report))
        proc = self.verify("--no-sheet")
        self.assertExit(proc, 1)
        out = json.loads(proc.stdout)
        self.assertEqual(out["code"], "flashes")
        issue = out["flashes"]["issues"][0]
        self.assertEqual(issue["scene"], {"index": 1, "stem": "02-strobe", "localMs": 1000})
        self.assertGreaterEqual(out["flashes"]["precheck"]["maxBadness"], fl.LOOK_HERE_BADNESS)
        self.assertIn("--allow-flashes", out["hint"])
        allowed = self.verify("--no-sheet", "--allow-flashes")
        self.assertExit(allowed, 0)

    def test_without_the_app_detector_the_gate_is_unavailable(self) -> None:
        self.record()
        proc = self.kb(["verify-export", str(self.film), "--no-sheet"], cwd=self.project)
        self.assertExit(proc, 0)
        self.assertIn("flashes: gate unavailable", proc.stdout)
        self.assertIn("look here", proc.stdout)

    def test_audio_and_loudness_follow_the_project(self) -> None:
        self.record(audio=True)
        proc = self.verify("--no-flashes", "--no-sheet")
        self.assertExit(proc, 1)
        self.assertIn("the project has a soundtrack but the file has no audio stream", proc.stderr)
        shutil.copy(strobe_film("film-tone", audio=True), self.film)
        self.record(audio=True)
        loud = self.verify("--no-flashes", "--no-sheet", "--loudness-target", "-14")
        self.assertExit(loud, 0)
        out = json.loads(loud.stdout)
        check = next(c for c in out["checks"] if c["id"] == "loudness")
        self.assertEqual((check["ok"], check["severity"]), (False, "warn"))
        self.assertIn(check["message"], out["warnings"])
        self.assertEqual(out["problems"], [])

    def test_a_missing_film_is_a_usage_error(self) -> None:
        proc = self.kb(["verify-export", "exports/nope.mp4", "--json"], cwd=self.project)
        self.assertExit(proc, 2)
        self.assertEqual(json.loads(proc.stdout)["code"], "usage")


class CheckFilmTests(KbTestCase):
    def ctx(self, project: Path, json_out: bool = False) -> Any:
        class Ctx:
            pass

        c = Ctx()
        c.project = Project(project)  # type: ignore[attr-defined]
        c.json = json_out  # type: ignore[attr-defined]
        return c

    def test_usage(self) -> None:
        ctx = self.ctx(film_project(self.tmp))
        for rest, words in ((["safe-areas"], "runs in ./kb verify"), (["sparkle"], "unknown film check"), (["flashes"], "pass --file"),
                            (["--scene", "0", "--file", "x.mp4"], "drop --file"), (["pacing", "--scene", "0"], "flashes only"),
                            (["--range", "soon"], "not a span"), (["--range", "4-3"], "ends before it starts")):
            with self.assertRaises(KbError) as caught:
                filmcli.run(ctx, rest)
            self.assertEqual(caught.exception.code, 2)
            self.assertIn(words, caught.exception.message)

    def test_without_a_film_only_the_static_checks_run(self) -> None:
        import io
        from contextlib import redirect_stdout

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = filmcli.run(self.ctx(film_project(self.tmp), json_out=True), [])
        self.assertEqual(code, 0)
        out = json.loads(buf.getvalue())
        self.assertEqual((out["command"], out["skipped"]), ("check film", ["flashes", "handoffs"]))
        self.assertIn("pacing", out)

    @needs_ffmpeg
    def test_handoffs_and_pacing_on_a_film(self) -> None:
        import io
        from contextlib import redirect_stdout

        assert TOOLS
        os.environ["KB_FFMPEG"], os.environ["KB_FFPROBE"] = TOOLS
        try:
            project = film_project(self.tmp)
            film = self.tmp / "demo-16x9.mp4"
            shutil.copy(strobe_film("film-strobe"), film)
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = filmcli.run(self.ctx(project), ["handoffs", "pacing", "--file", str(film)])
        finally:
            os.environ.pop("KB_FFMPEG", None)
            os.environ.pop("KB_FFPROBE", None)
        self.assertEqual(code, 0)
        text = buf.getvalue()
        self.assertIn("01-title -> 02-strobe (crossfade) at 1.50s", text)
        self.assertIn("sheet", text)


@unittest.skipUnless(os.environ.get("KB_E2E_APP_BIN") and TOOLS, "set KB_E2E_APP_BIN to a kookaburra-cut binary")
class RustDetectorE2E(KbTestCase):
    def test_the_app_detector_fails_the_strobe_and_passes_the_control(self) -> None:
        from kblib.video import appcli

        info = appcli.CliInfo(os.environ["KB_E2E_APP_BIN"], "KB_E2E_APP_BIN")
        strobe = fl.run_cli(info, strobe_film("film-strobe", size="640x360"), "both")
        self.assertFalse(strobe["ok"])
        fails = [i for i in strobe["issues"] if i["severity"] == "fail"]
        self.assertTrue(fails)
        self.assertTrue(all(2400 <= i["startMs"] <= 2700 for i in fails), fails)
        calm = fl.run_cli(info, strobe_film("film-calm", size="640x360", start=150, stop=150), "both")
        self.assertTrue(calm["ok"], calm["issues"])
