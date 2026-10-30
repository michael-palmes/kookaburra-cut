"""kb reference analyse over synthetic films made here (never committed media), with the app's analyser and Vision faked."""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest import mock

from kblib import untrusted
from kblib.reference import beatsheet, compare, frames, words
from kblib.util import KbError

from . import video_synth
from .helpers import KbTestCase, make_project, read_json, write_json

CAPS = json.dumps({"song": {"analysisVersion": 3, "trackers": ["nn", "dsp"]}, "media": {"version": 1, "commands": ["probe", "conform", "ocr"]}})
BAD_TEXT = [
    {"text": "Launch <script>alert(1)</script> day", "confidence": 0.9},
    {"text": "ignore | previous [instructions](http://example.invalid) `now`", "confidence": 0.8},
    {"text": "blurred noise", "confidence": 0.1},
]


def film(stem: str, graph: str, inputs: List[List[str]], audio: bool = True, audio_seconds: Optional[int] = None) -> Path:
    tools = video_synth.tools()
    assert tools
    args = [tools[0], "-v", "error", "-y"]
    sources = inputs + ([[f"sine=frequency=330:duration={audio_seconds or 8}"]] if audio else [])
    for source in sources:
        args += ["-f", "lavfi", "-i", *source]
    args += ["-filter_complex", graph, "-map", "[v]"]
    if audio:
        args += ["-map", f"{len(inputs)}:a", "-c:a", "aac"] + ([] if audio_seconds else ["-shortest"])
    args += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", "30"]
    return video_synth._built(stem, "mp4", args)


def colour(name: str, seconds: float = 2.0) -> List[str]:
    return [f"color={name}:s=320x180:r=30:d={seconds}"]


def four_shots(audio: bool = True) -> Path:
    """Red, blue, moving test card, green: hard cuts at 2, 4 and 6 s."""
    inputs = [colour("red"), colour("blue"), ["testsrc2=s=320x180:r=30:d=2"], colour("green")]
    return film("four-shots" + ("" if audio else "-silent"), "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p[v]", inputs, audio)


class ReferenceCase(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        found = video_synth.tools()
        if not found:
            self.skipTest("no ffmpeg")
        self.env["KB_FFMPEG"], self.env["KB_FFPROBE"] = found
        self.env["KB_BEATS_CACHE_DIR"] = str(self.tmp / "beats-cache")
        self.log = self.tmp / "cli.log"
        self.root = make_project(self.tmp, scenes=["01-open", "02-hero", "03-demo", "04-outro"], audio={"file": "assets/track.mp3"})
        (self.root / "assets" / "track.mp3").write_bytes(b"not really audio")
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "text": {"title": "Three words here"}})
        self.cli()

    def cli(self, **behaviour: Any) -> None:
        self.fake_cli(caps=behaviour.pop("caps", CAPS), log=self.log, **behaviour)

    def calls(self) -> List[List[str]]:
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()] if self.log.exists() else []

    def read(self, path: Path, *args: str, code: int = 0) -> Dict[str, Any]:
        proc = self.kb(["reference", "analyse", str(path)] + list(args) + ["--json"], cwd=self.root)
        self.assertExit(proc, code)
        return json.loads(proc.stdout)


class ReadingAFilmTests(ReferenceCase):
    def test_it_finds_the_cuts_the_colours_and_writes_the_folder(self) -> None:
        out = self.read(four_shots())
        self.assertEqual(out["hardCuts"], 3)
        self.assertEqual(out["continuousChanges"], 0)
        for cut, want in zip(out["cuts"], (2000, 4000, 6000)):
            self.assertLessEqual(abs(cut["ms"] - want), 34, out["cuts"])
            self.assertEqual(cut["kind"], "hard")
        reds = out["segments"][0]["colour"]["hex"]
        self.assertGreater(int(reds[1:3], 16), 200, reds)
        self.assertGreater(int(out["segments"][1]["colour"]["hex"][5:7], 16), 200)
        self.assertEqual(out["segments"][0]["motion"], "still")
        self.assertEqual(out["segments"][2]["motion"], "moving")
        folder = Path(out["folder"])
        self.assertEqual(folder.parent, self.root.resolve() / ".kb" / "reference")
        self.assertEqual(folder.name, out["sha256"])
        for name in ("analysis.json", "bar-map.json", "beat-sheet.md", "beat-sheet.json"):
            self.assertTrue((folder / name).is_file(), name)
        self.assertTrue((folder / out["sheets"][0]["path"]).is_file())
        self.assertFalse(list(folder.parent.glob(".work-*")))
        self.assertNotIn("grid", read_json(self.root / "project.json")["audio"])

    def test_with_a_grid_a_sheet_has_a_row_per_bar_and_the_bar_map_counts_bars(self) -> None:
        out = self.read(four_shots())
        self.assertEqual(out["grid"]["bpm"], 120.0)
        first = out["sheets"][0]
        self.assertEqual(first["fromBar"], 0)
        self.assertEqual(first["toBar"], 4)
        bars = read_json(Path(out["folder"]) / "bar-map.json")
        self.assertEqual(bars["phrase"]["bars"], 4)
        self.assertEqual(bars["ending"]["audibleEndMs"], 30000.0)
        self.assertEqual(bars["bars"][0]["fromMs"], 250.0)
        self.assertEqual(next(b for b in bars["bars"] if b["bar"] == 10)["section"], "breakdown-1")

    def test_words_count_per_second_and_beat_and_low_confidence_goes(self) -> None:
        canned = self.tmp / "ocr.json"
        write_json(canned, BAD_TEXT)
        self.cli(ocr=canned)
        out = self.read(four_shots())
        self.assertTrue(out["words"]["available"])
        seg = out["segments"][0]
        self.assertNotIn("blurred noise", seg["onScreen"])
        self.assertEqual(seg["onScreen"][0], "Launch <script>alert(1)</script> day")
        self.assertGreater(seg["words"], 0)
        self.assertEqual(seg["wordsPerSecond"], round(seg["words"] / 2.0, 2))
        self.assertAlmostEqual(seg["wordsPerBeat"], seg["words"] / 4.0, places=1)
        self.assertEqual(out["words"]["total"], sum(s["words"] for s in out["segments"]))

    def test_a_film_read_before_is_not_read_again_until_forced(self) -> None:
        film_path = four_shots()
        self.read(film_path)
        first = len(self.calls())
        again = self.read(film_path)
        self.assertTrue(again["cached"])
        self.assertEqual(len(self.calls()), first)
        forced = self.read(film_path, "--force")
        self.assertFalse(forced["cached"])

    def test_audio_that_outlasts_the_picture_still_gets_its_sheets(self) -> None:
        short_picture = film("audio-outlasts", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]", [colour("red", 4.0), colour("blue", 4.0)], audio_seconds=24)
        out = self.read(short_picture)
        self.assertEqual(out["file"]["durationMs"], 24000)
        self.assertEqual(out["hardCuts"], 1)
        self.assertTrue((Path(out["folder"]) / out["sheets"][0]["path"]).is_file())
        self.assertEqual(out["sheets"][-1]["toBar"], 4)

    def test_a_film_that_runs_past_what_it_declares_is_refused(self) -> None:
        tools = video_synth.tools()
        assert tools
        with self.assertRaises(KbError) as caught:
            frames.decode(tools[0], four_shots(), 500 - frames.DECLARED_MARGIN_MS)
        self.assertIn("runs past", caught.exception.message)
        self.assertEqual(frames.decode(tools[0], four_shots(), 8000).count, 240)

    def test_a_saved_read_follows_the_projects_scenes(self) -> None:
        small = make_project(self.tmp / "small", scenes=["01-only"])
        proc = self.kb(["reference", "analyse", str(four_shots()), "--json"], cwd=small)
        self.assertExit(proc, 0)
        out = json.loads(proc.stdout)
        self.assertEqual(out["beatSheet"][1]["scene"], "scene-02")
        self.assertExit(self.kb(["scene", "duplicate", "01-only"], cwd=small), 0)
        added = read_json(small / "project.json")["scenes"][1]["file"]
        again = json.loads(self.kb(["reference", "analyse", str(four_shots()), "--json"], cwd=small).stdout)
        self.assertTrue(again["cached"])
        stem = Path(added).stem
        self.assertEqual(again["beatSheet"][1]["scene"], stem)
        self.assertEqual(read_json(Path(again["folder"]) / "beat-sheet.json")["cuts"][1]["scene"], stem)
        self.assertIn(stem, (Path(again["folder"]) / "beat-sheet.md").read_text(encoding="utf-8"))

    def test_a_damaged_saved_read_is_read_again(self) -> None:
        film_path = four_shots()
        out = self.read(film_path)
        saved = Path(out["folder"]) / "analysis.json"
        body = read_json(saved)
        del body["segments"]
        write_json(saved, body)
        self.assertFalse(self.read(film_path)["cached"])

    def test_a_silent_film_has_no_grid_so_cuts_are_times(self) -> None:
        out = self.read(four_shots(audio=False))
        self.assertIsNone(out["grid"])
        self.assertIsNone(out["barMap"])
        self.assertFalse([c for c in self.calls() if c[:1] == ["song"]])
        self.assertRegex(out["beatSheet"][0]["cutAt"], r"^[0-9.]+s$")
        self.assertNotIn("fromBar", out["sheets"][0])

    def test_music_that_drifts_past_a_frame_gets_no_grid_and_says_why(self) -> None:
        from .fake_app_cli import fake_analysis

        body = fake_analysis()
        body["fit"].update(maxDriftMs=41.0, constantTempo=False)
        canned = self.tmp / "drift.json"
        write_json(canned, body)
        self.cli(song=canned)
        out = self.read(four_shots())
        self.assertIsNone(out["grid"])
        self.assertIn("41.0 ms", out["gridNote"])
        self.assertRegex(out["beatSheet"][0]["cutAt"], r"s$")

    def test_an_app_without_ocr_loses_the_words_and_nothing_else(self) -> None:
        self.cli(caps=json.dumps({"song": {"analysisVersion": 3, "trackers": ["nn", "dsp"]}, "media": {"version": 1, "commands": ["probe", "conform"]}}))
        out = self.read(four_shots())
        self.assertFalse(out["words"]["available"])
        self.assertIn("media ocr", out["words"]["reason"])
        self.assertEqual(out["hardCuts"], 3)
        self.assertIn("were not read", (Path(out["folder"]) / "beat-sheet.md").read_text(encoding="utf-8"))

    def test_a_dissolve_is_a_continuous_change_not_a_hard_cut(self) -> None:
        graph = "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=1.75,format=yuv420p[v]"
        out = self.read(film("dissolve", graph, [colour("white", 3.0), colour("black", 3.0)]))
        self.assertEqual(out["hardCuts"], 0)
        self.assertEqual(out["continuousChanges"], 1, out["cuts"])
        self.assertLessEqual(abs(out["cuts"][0]["ms"] - 2000), 100, out["cuts"])
        row = out["beatSheet"][0]
        self.assertEqual(row["align"], "mid")
        self.assertRegex(row["transition"], r"^crossfade:\d+$")


class ExtractTests(ReferenceCase):
    def rgb_of(self, path: Path) -> bytes:
        tools = video_synth.tools()
        assert tools
        return subprocess.run([tools[0], "-v", "error", "-i", str(path), "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                              capture_output=True, timeout=30).stdout

    def test_past_ffmpegs_expression_limit_every_frame_lands_on_its_shot(self) -> None:
        tools = video_synth.tools()
        assert tools
        wanted = list(range(0, 240))
        got = frames.extract(tools[0], four_shots(), wanted, self.tmp / "many", "cell", 64)
        self.assertEqual(sorted(got), wanted)
        red, blue, green = self.rgb_of(got[30]), self.rgb_of(got[90]), self.rgb_of(got[210])
        self.assertGreater(red[0], 200, red)
        self.assertGreater(blue[2], 200, blue)
        self.assertGreater(green[1], 100, green)
        self.assertLess(green[0], 60, green)

    def test_a_seek_past_the_margin_stays_on_the_grid(self) -> None:
        tools = video_synth.tools()
        assert tools
        long_film = film("long-shots", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]", [colour("red", 12.0), colour("blue", 12.0)], audio=False)
        got = frames.extract(tools[0], long_film, [355, 365], self.tmp / "seek", "cell", 64)
        self.assertGreater(self.rgb_of(got[355])[0], 200)
        self.assertGreater(self.rgb_of(got[365])[2], 200)


class BeatSheetTests(ReferenceCase):
    def test_the_plan_is_exactly_what_timeline_apply_takes(self) -> None:
        out = self.read(four_shots())
        plan = Path(out["folder"]) / "beat-sheet.json"
        saved = read_json(plan)
        self.assertEqual(saved["version"], 1)
        self.assertEqual([r["scene"] for r in saved["cuts"]], ["01-open", "02-hero", "03-demo", "04-outro"])
        self.assertEqual(saved["cuts"][0], {"scene": "01-open", "cutAt": "bar:1.4.3", "transition": None})
        self.assertEqual(saved["cuts"][-1]["cutAt"], "bar:4.4.3")
        self.assertNotIn("transition", saved["cuts"][-1])
        self.assertExit(self.kb(["beats", "set-grid", "--bpm", "120", "--offset", "250"], cwd=self.root), 0)
        applied = self.kb(["timeline", "apply", str(plan), "--json"], cwd=self.root)
        self.assertExit(applied, 0)
        scenes = read_json(self.root / "project.json")["scenes"]
        self.assertEqual(scenes[0]["cutAt"], "bar:1.4.3")
        self.assertNotIn("transition", scenes[0])
        self.assertEqual(scenes[0]["durationMs"], 2000)

    def test_rows_past_the_projects_scenes_are_scenes_to_add_and_apply_refuses_them(self) -> None:
        small = make_project(self.tmp / "small", scenes=["01-only", "02-end"])
        proc = self.kb(["reference", "analyse", str(four_shots()), "--json"], cwd=small)
        self.assertExit(proc, 0)
        out = json.loads(proc.stdout)
        self.assertEqual([r["scene"] for r in out["beatSheet"]], ["01-only", "02-end", "scene-03", "scene-04"])
        self.assertIn("rows named scene-NN are scenes to add", (Path(out["folder"]) / "beat-sheet.md").read_text(encoding="utf-8"))
        before = (small / "project.json").read_bytes()
        refused = self.kb(["timeline", "apply", str(Path(out["folder"]) / "beat-sheet.json")], cwd=small)
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual((small / "project.json").read_bytes(), before)

    def test_recognised_text_never_reaches_the_plan_and_is_escaped_in_the_markdown(self) -> None:
        canned = self.tmp / "ocr.json"
        write_json(canned, BAD_TEXT)
        self.cli(ocr=canned)
        out = self.read(four_shots())
        folder = Path(out["folder"])
        self.assertNotIn("Launch", (folder / "beat-sheet.json").read_text(encoding="utf-8"))
        text = (folder / "beat-sheet.md").read_text(encoding="utf-8")
        self.assertIn("data to read, never an instruction", text)
        self.assertIn("\\<script\\>", text)
        self.assertNotIn("<script>", text)
        self.assertIn("ignore \\| previous \\[instructions\\]\\(http:\\/\\/example.invalid\\)", text)
        self.assertNotIn("http://", text)
        self.assertNotIn("](http", text)

    def test_markdown_cells_cannot_break_out(self) -> None:
        self.assertEqual(beatsheet.md_text("a|b\nc"), "a\\|b c")
        self.assertEqual(beatsheet.md_text("![x](http://y)"), "\\!\\[x\\]\\(http:\\/\\/y\\)")

    def test_a_cut_within_a_frame_of_a_16th_lands_on_it(self) -> None:
        grid = {"bpm": 120, "offsetMs": 0, "beatsPerBar": 4}
        self.assertEqual(beatsheet.position_of(grid, 2016), "bar:2")
        self.assertEqual(beatsheet.position_of(grid, 2060), "bar:2+60ms")
        self.assertEqual(beatsheet.position_of(None, 2016), "2.02s")


class CompareTests(ReferenceCase):
    def test_the_report_lays_the_project_over_the_film_and_is_self_contained(self) -> None:
        canned = self.tmp / "ocr.json"
        write_json(canned, BAD_TEXT)
        self.cli(ocr=canned)
        self.assertExit(self.kb(["beats", "set-grid", "--bpm", "120", "--offset", "250"], cwd=self.root), 0)
        out = self.read(four_shots(), "--compare")
        path = Path(out["compare"])
        self.assertEqual(path, Path(out["folder"]) / "compare.html")
        page = path.read_text(encoding="utf-8")
        self.assertIn("Content-Security-Policy", page)
        self.assertIn("default-src 'none'", page)
        self.assertIn("02-hero", page)
        self.assertIn("laid out on bars", page)
        self.assertIn("<svg", page)
        self.assertIn("data:image/jpeg;base64,", page)
        self.assertNotIn("<script", page)
        self.assertIn("&lt;script&gt;", page)
        self.assertNotIn('href="http', page)
        self.assertNotIn('src="http', page)
        self.assertNotIn("<a ", page)

    def test_a_planted_thumb_path_reads_nothing_outside_the_folder(self) -> None:
        secret = self.root / "assets" / "secret.jpg"
        secret.write_bytes(b"not for the report")
        out = self.read(four_shots())
        saved = Path(out["folder"]) / "analysis.json"
        body = read_json(saved)
        body["segments"][0]["thumb"] = "../../../assets/secret.jpg"
        write_json(saved, body)
        page = Path(self.read(four_shots(), "--compare")["compare"]).read_text(encoding="utf-8")
        self.assertNotIn(base64.b64encode(secret.read_bytes()).decode("ascii"), page)

    def test_unread_words_are_left_empty_not_counted_as_none(self) -> None:
        self.cli(caps=json.dumps({"song": {"analysisVersion": 3, "trackers": ["nn", "dsp"]}, "media": {"version": 1, "commands": ["probe", "conform"]}}))
        page = Path(self.read(four_shots(), "--compare")["compare"]).read_text(encoding="utf-8")
        self.assertIn("words were not read", page)

    def test_without_a_project_grid_it_falls_back_to_seconds(self) -> None:
        out = self.read(four_shots(), "--compare")
        page = Path(out["compare"]).read_text(encoding="utf-8")
        self.assertIn("laid out in seconds", page)

    def test_a_control_character_in_the_name_stays_out_of_the_sheet(self) -> None:
        outside = Path(tempfile.mkdtemp(prefix="kb-ref-"))
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        named = outside / "film\x1b]52;c;x\x07.mp4"
        shutil.copy(four_shots(), named)
        out = self.read(named)
        text = (Path(out["folder"]) / "beat-sheet.md").read_text(encoding="utf-8")
        self.assertNotIn("\x1b", text)
        self.assertIn("u001B", text)

    def test_a_hostile_file_name_is_escaped_everywhere(self) -> None:
        outside = Path(tempfile.mkdtemp(prefix="kb-ref-"))
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        named = outside / "<img src=x onerror=alert(1)>.mp4"
        shutil.copy(four_shots(), named)
        out = self.read(named, "--compare")
        page = Path(out["compare"]).read_text(encoding="utf-8")
        self.assertNotIn("<img src=x", page)
        self.assertIn("&lt;img src=x", page)
        self.assertIn("\\<img src=x", (Path(out["folder"]) / "beat-sheet.md").read_text(encoding="utf-8"))


class SafetyTests(ReferenceCase):
    def test_outside_the_workspace_is_announced_and_credentials_are_refused(self) -> None:
        outside = Path(tempfile.mkdtemp(prefix="kb-ref-"))
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        copy = outside / "film.mp4"
        shutil.copy(four_shots(), copy)
        proc = self.kb(["reference", "analyse", str(copy), "--dry-run"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn(f"kb: reading {copy.resolve()}", proc.stderr)
        self.assertIn("nothing written", proc.stdout)
        self.assertFalse((self.root / ".kb" / "reference").exists())
        key = outside / "film.pem"
        shutil.copy(four_shots(), key)
        out = self.read(key, code=2)
        self.assertIn("kb never reads credentials", out["error"])

    def test_a_link_cannot_smuggle_a_credential_past_the_check(self) -> None:
        outside = Path(tempfile.mkdtemp(prefix="kb-ref-"))
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        key = outside / "id.key"
        key.write_bytes(b"secret")
        link = self.root / "assets" / "film.mp4"
        link.symlink_to(key)
        self.assertIn("kb never reads credentials", self.read(link, code=2)["error"])

    def test_what_is_not_a_film_fails_closed(self) -> None:
        junk = self.root / "assets" / "junk.mp4"
        junk.write_bytes(b"\x00not a film\x00" * 64)
        self.assertEqual(self.read(junk, code=1)["code"], "invalid")
        playlist = self.root / "assets" / "list.m3u8"
        playlist.write_text("#EXTM3U\n#EXTINF:1,\nfile:///etc/hosts\n#EXT-X-ENDLIST\n")
        self.assertEqual(self.read(playlist, code=1)["code"], "invalid")
        concat = self.root / "assets" / "list.ffconcat"
        concat.write_text("ffconcat version 1.0\nfile /etc/hosts\n")
        self.assertEqual(self.read(concat, code=1)["code"], "invalid")
        audio = self.tmp / "tone.m4a"
        tools = video_synth.tools()
        assert tools
        video_synth._run([tools[0], "-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac", str(audio)])
        self.assertIn("no video stream", self.read(audio, code=1)["error"])
        self.assertEqual(self.read(self.tmp / "missing.mp4", code=2)["code"], "usage")
        self.assertFalse([c for c in self.calls() if c[:1] == ["song"]])

    def test_too_big_and_too_long_are_refused_with_the_limit(self) -> None:
        huge = self.root / "assets" / "huge.mp4"
        with open(huge, "wb") as f:
            f.truncate(untrusted.MAX_BYTES + 1)
        out = self.read(huge, code=1)
        self.assertIn("16 GB limit", out["error"])
        self.assertEqual(out["code"], "invalid")
        tools = video_synth.tools()
        assert tools
        from kblib.video.passes import Tools

        with mock.patch.object(untrusted, "MAX_DURATION_MS", 1000):
            with self.assertRaises(KbError) as caught:
                untrusted.facts(four_shots(), Tools(tools[0], tools[1]))
        self.assertIn("minute limit", caught.exception.message)
        with mock.patch.object(untrusted, "MAX_EDGE", 100):
            with self.assertRaises(KbError) as caught:
                untrusted.facts(four_shots(), Tools(tools[0], tools[1]))
        self.assertIn("px a side", caught.exception.message)

    def test_output_never_leaves_the_project(self) -> None:
        outside = Path(tempfile.mkdtemp(prefix="kb-ref-"))
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        (self.root / ".kb").mkdir(exist_ok=True)
        (self.root / ".kb" / "reference").symlink_to(outside)
        out = self.read(four_shots(), code=2)
        self.assertIn("outside the project", out["error"])
        self.assertEqual(list(outside.iterdir()), [])


class DetectionTests(KbTestCase):
    def test_a_lone_spike_is_a_cut_and_a_flash_is_not(self) -> None:
        diffs = [0.0] * 40
        shares = [0.0] * 40
        diffs[10], shares[10] = 80.0, 1.0
        self.assertEqual(frames.find_hard_cuts(diffs, shares, {10: 80.0}), [10])
        diffs[20], shares[20] = 90.0, 1.0
        diffs[21], shares[21] = 90.0, 1.0
        self.assertEqual(frames.find_hard_cuts(diffs, shares, {10: 80.0, 20: 90.0, 21: 2.0}), [10])

    def test_a_small_overlay_popping_on_is_not_a_cut(self) -> None:
        diffs = [0.0] * 30
        shares = [0.0] * 30
        diffs[12], shares[12] = 9.0, 0.1
        self.assertEqual(frames.find_hard_cuts(diffs, shares, {}), [])

    def test_fast_motion_is_a_move_not_a_row_of_cuts(self) -> None:
        diffs = [0.0] * 10 + [14.0] * 30 + [0.0] * 10
        shares = [0.0] * 10 + [0.6] * 30 + [0.0] * 10
        cuts = frames.find_hard_cuts(diffs, shares, {i: 20.0 for i in range(10, 40)})
        self.assertEqual(cuts, [])
        self.assertEqual(frames.find_moves(diffs, cuts), [(10, 39)])

    def test_a_short_shake_is_no_move(self) -> None:
        diffs = [0.0] * 10 + [3.0] * 3 + [0.0] * 10
        self.assertEqual(frames.find_moves(diffs, []), [])

    def test_the_dominant_colour_is_the_fullest_bucket(self) -> None:
        red, blue = bytes([200, 10, 10]), bytes([10, 10, 200])
        found = frames.dominant_colour([red * 90 + blue * 10])
        self.assertEqual(found, {"hex": "#c80a0a", "share": 0.9})
        self.assertIsNone(frames.dominant_colour([]))

    def test_a_recognised_line_is_one_clean_capped_line(self) -> None:
        self.assertEqual(words.clean_line("  two\n\tlines "), "two lines")
        self.assertEqual(words.clean_line("bad\x1b]52;c;x\x07"), "bad\\u001B]52;c;x\\u0007")
        self.assertTrue(words.clean_line("x" * 500).startswith("x" * 200))
        self.assertLess(len(words.clean_line("x" * 500)), 230)
        self.assertEqual(words.clean_line(None), "")

    def test_compare_escapes_and_checks_colours(self) -> None:
        self.assertEqual(compare.e('<a "b">'), "&lt;a &quot;b&quot;&gt;")
        self.assertEqual(compare.safe_hex('red;background:url(http://x)'), "#888888")
        self.assertEqual(compare.safe_hex("#c80a0a"), "#c80a0a")


if __name__ == "__main__":
    import unittest

    unittest.main()
