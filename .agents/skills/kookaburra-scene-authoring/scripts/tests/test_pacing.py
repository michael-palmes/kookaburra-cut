from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest import mock

from kblib.beats import pulse
from kblib.film import pacing as pc
from kblib.film import timeline as tl
from kblib.project import Project

from .helpers import KbTestCase, make_project, read_json, write_json

GRID = {"bpm": 120, "offsetMs": 0, "beatsPerBar": 4}
# 32 bars at 120 bpm (a bar is 2 s): a quiet build, a peak, a longer build, the final peak, the final hit on bar 32.
SONG = [{"id": "build-1", "from": "bar:1", "to": "bar:9"}, {"id": "peak-1", "from": "bar:9", "to": "bar:17"},
        {"id": "build-2", "from": "bar:17", "to": "bar:29"}, {"id": "peak-2", "from": "bar:29", "to": "bar:33"}]


def song_project(root: Path, stems: List[str], durations: Optional[List[int]] = None, **audio: Any) -> Path:
    spec: Dict[str, Any] = {"file": "assets/track.mp3", "grid": GRID, "sections": SONG, "cues": {"final-hit": "bar:32"}}
    spec.update(audio)
    project = make_project(root, scenes=stems, audio=spec)
    (project / "assets" / "track.mp3").write_bytes(b"click")
    manifest = read_json(project / "project.json")
    for entry, ms in zip(manifest["scenes"], durations or [2000] * len(stems)):
        entry.pop("transition", None)
        entry["durationMs"] = ms
    write_json(project / "project.json", manifest)
    return project


def stems(n: int) -> List[str]:
    return [f"{i + 1:02d}-s{i + 1}" for i in range(n)]


class ShapeTests(KbTestCase):
    def test_musical_sections_set_the_parts_and_story_sections_do_not(self) -> None:
        project = song_project(self.tmp, stems(2))
        shape = pulse.song_shape(Project(project))
        self.assertEqual([(p["id"], p["kind"], p["fromBar"], p["toBar"]) for p in shape["parts"]],
                         [("build-1", "quiet", 1, 9), ("peak-1", "peak", 9, 17), ("build-2", "quiet", 17, 29), ("peak-2", "peak", 29, 33)])
        self.assertEqual((shape["finalHit"], shape["finalHitMs"], shape["partsSource"]), ("bar:32", 62000, "sections"))
        story = song_project(self.tmp / "b", stems(2), sections=[{"id": "reveal", "from": "bar:9", "to": "bar:11"}])
        self.assertEqual(pulse.song_shape(Project(story))["parts"], [])
        mixed = song_project(self.tmp / "c", stems(2), sections=[{"id": "intro", "from": "bar:1", "to": "bar:9"}, {"id": "reveal", "from": "bar:9", "to": "bar:11"}])
        self.assertEqual(pulse.song_shape(Project(mixed))["parts"], [])

    def test_analysis_parts_convert_through_time(self) -> None:
        project = song_project(self.tmp, stems(2), sections=[], cues={})
        # The analysis counts its bar 1 a bar later than the authored grid does.
        analysis = {"version": 3, "fit": {"bpm": 120, "offsetMs": 2000, "beatsPerBar": 4},
                    "form": {"parts": [{"id": "build-1", "kind": "build", "fromBar": 1, "toBar": 8},
                                       {"id": "peak-1", "kind": "peak", "fromBar": 8, "toBar": 16}],
                             "moments": [{"id": "final-hit", "kind": "final", "ms": 31000}]},
                    "ending": {"audibleEndMs": 33000}}
        with mock.patch.object(pulse, "_analysis", return_value=analysis):
            shape = pulse.song_shape(Project(project))
        self.assertEqual([(p["id"], p["fromBar"], p["toBar"]) for p in shape["parts"]], [("build-1", 2, 9), ("peak-1", 9, 17)])
        self.assertEqual((shape["partsSource"], shape["finalHit"], shape["audibleEndMs"]), ("analysis", "bar:16.3", 33000))

    def test_the_pulse_per_part_the_cap_and_the_end(self) -> None:
        shape = pulse.song_shape(Project(song_project(self.tmp, stems(2))))
        self.assertEqual(pulse.pulse_at(shape, 4000)["allowedMs"], 2000)
        self.assertEqual(pulse.pulse_at(shape, 17000)["allowedMs"], 1000)
        self.assertEqual(pulse.pulse_at(shape, 63000)["kind"], "end")
        slow = song_project(self.tmp / "slow", stems(2), grid={"bpm": 80, "offsetMs": 0, "beatsPerBar": 4})
        self.assertEqual(pulse.pulse_at(pulse.song_shape(Project(slow)), 1000)["allowedMs"], pulse.STILL_CAP_MS)

    def test_reading_time_is_rounded_up_to_the_beat(self) -> None:
        self.assertEqual(pulse.reading_ms(5, 1), 1600)
        self.assertEqual(pulse.reading_ms(5, 1, 60000 / 128), 1875)
        self.assertEqual(pulse.reading_ms(8, 2, 500), 3000)
        self.assertEqual(pulse.reading_ms(0, 0, 500), 0)


class PacingCheckTests(KbTestCase):
    def check(self, project: Path, motion: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        p = Project(project)
        return pc.check(p, tl.project_slots(p), motion)

    def test_a_still_stretch_past_its_part_warns_and_inside_it_does_not(self) -> None:
        project = song_project(self.tmp, stems(2), [16000, 16000])
        motion = {"spans": [(0, 1900), (2000, 6000), (16000, 16900), (17000, 19000)], "changes": [2000, 6000, 16000, 17000, 19000]}
        out = self.check(project, motion)
        stills = [i for i in out["issues"] if i["kind"] == "still"]
        self.assertEqual([(i["atMs"], i["scene"]) for i in stills], [(2000, "01-s1"), (17000, "02-s2")])
        self.assertIn("in build-1 the song asks for something new every bar", stills[0]["message"])
        self.assertIn("in peak-1 the song asks for something new every 2 beats", stills[1]["message"])

    def test_the_payoff_must_land_on_the_final_hit_and_the_film_end_within_a_bar(self) -> None:
        project = song_project(self.tmp, stems(2), [60000, 4000])
        missed = self.check(project, {"spans": [], "changes": [60000, 61000]})
        self.assertEqual(sorted(i["kind"] for i in missed["issues"]), ["final-hit"])
        landed = self.check(project, {"spans": [], "changes": [60000, 62100]})
        self.assertEqual(landed["issues"], [])
        late = song_project(self.tmp / "late", stems(2), [60000, 8000])
        self.assertIn("runs 6.0s past the song's final hit", self.check(late, {"spans": [], "changes": [62000]})["warnings"][0])

    def test_words_need_their_reading_time(self) -> None:
        project = song_project(self.tmp, stems(2), [2000, 6000])
        write_json(project / "scenes" / "01-s1.json", {"version": 1, "text": {"title": "one two three four five six seven eight"}})
        out = self.check(project, {"spans": [], "changes": [0, 2000, 4000, 6000, 62000]})
        self.assertEqual(out["scenes"][0]["readMs"], 2500)
        self.assertIn("01-s1: 8 words on 1 line need 2.5s (5 beats) to read once", out["warnings"][0])

    def test_a_kept_warning_moves_to_accepted_with_its_reason(self) -> None:
        project = song_project(self.tmp, stems(2), [16000, 16000])
        motion = {"spans": [(2000, 6000)], "changes": [2000, 6000, 62000]}
        write_json(project / pc.ACCEPTED_FILE, {"version": 1, "accepted": [{"id": "x", "kind": "still", "scene": "01-s1", "why": "a held breath"}]})
        out = self.check(project, motion)
        self.assertEqual(out["warnings"], [])
        self.assertEqual(out["accepted"][0]["why"], "a held breath")

    def test_no_soundtrack_counts_a_bar_as_two_seconds(self) -> None:
        project = make_project(self.tmp, scenes=stems(2))
        out = self.check(project, {"spans": [(0, 2200), (2300, 3000)], "changes": [0, 2300]})
        self.assertEqual(out["song"]["grid"], None)
        self.assertEqual(out["warnings"], [])
        out = self.check(project, {"spans": [(0, 2600)], "changes": [2600]})
        self.assertIn("with no soundtrack, something new every 2 s", out["warnings"][0])


class StaticChangeTests(KbTestCase):
    def test_camera_kicks_count_as_changes(self) -> None:
        project = song_project(self.tmp, stems(2), [8000, 2000])
        p = Project(project)
        bare = pc.check(p, tl.project_slots(p))
        self.assertEqual([i["scene"] for i in bare["issues"] if i["kind"] == "still"], ["01-s1"])
        write_json(project / "scenes" / "01-s1.json", {"version": 1, "cameraKicks": [
            {"at": "bar:2", "zoom": 1.04, "releaseMs": 300}, {"at": 4000, "zoom": 1.04, "releaseMs": 300}, {"at": "bar:4", "zoom": 1.04, "releaseMs": 300}]})
        kicked = pc.check(Project(project), tl.project_slots(Project(project)))
        self.assertEqual([i for i in kicked["issues"] if i["kind"] == "still"], [])


class ChangeDetectorTests(KbTestCase):
    def test_a_change_splits_the_stillness_and_a_slow_drift_does_not(self) -> None:
        flat = bytes([10] * 1024)
        changed = bytes([10] * 1016 + [60] * 8)
        self.assertEqual(pc.still_spans([flat] * 3 + [changed] * 5, 100, 1000), [(1000, 1300), (1300, 1700)])
        drift = [bytes([10 + k] * 1024) for k in range(10)]
        self.assertEqual(pc.still_spans(drift, 100), [(0, 900)])
        self.assertEqual(pc.change_marks(drift)[0], [])

    def test_steady_fast_motion_is_live(self) -> None:
        fast = [bytes([(10 + 9 * k) % 256] * 1024) for k in range(10)]
        events, live = pc.change_marks(fast)
        self.assertEqual(events, [])
        self.assertTrue(all(live[1:]))


class PacingCommandTests(KbTestCase):
    def test_accept_list_and_forget(self) -> None:
        project = song_project(self.tmp, stems(2))
        self.assertExit(self.kb(["pacing", "accept", "01-s1"], cwd=project), 2)
        proc = self.kb(["pacing", "accept", "01-s1", "--kind", "still", "--why", "a held breath"], cwd=project)
        self.assertExit(proc, 0)
        rows = read_json(project / pc.ACCEPTED_FILE)["accepted"]
        self.assertEqual([(r["kind"], r["scene"], r["why"]) for r in rows], [("still", "01-s1", "a held breath")])
        self.assertIn("01-s1, still: a held breath", self.kb(["pacing"], cwd=project).stdout)
        self.assertExit(self.kb(["pacing", "forget", "01-s1"], cwd=project), 0)
        self.assertEqual(read_json(project / pc.ACCEPTED_FILE)["accepted"], [])
        self.assertExit(self.kb(["pacing", "forget", "01-s1"], cwd=project), 1)


class BeatsPlanTests(KbTestCase):
    def plan(self, project: Path, *args: str, code: int = 0) -> Dict[str, Any]:
        proc = self.kb(["beats", "plan", *args, "--json"], cwd=project)
        self.assertExit(proc, code)
        return json.loads(proc.stdout)

    def test_the_song_sets_the_scenes(self) -> None:
        project = song_project(self.tmp, stems(3))
        data = self.plan(project)
        slots = data["slots"]
        self.assertEqual(data["film"]["toBar"], 33)
        self.assertEqual([p["scenes"] for p in data["parts"]], [4, 5, 5, 3])
        self.assertEqual(len(slots), 17)
        reveal = next(s for s in slots if s["role"].startswith("reveal"))
        burst = next(s for s in slots if s["kind"] == "burst")
        self.assertEqual((reveal["from"], burst["from"], burst["cutAt"], burst["maxWords"]), ("bar:9", "bar:25", "bar:29", 0))
        self.assertEqual((slots[-1]["from"], slots[-1]["cutAt"], slots[-1]["role"]), ("bar:32", "bar:33", "payoff: lands on the final hit (bar:32)"))
        self.assertEqual(data["cuts"][0], {"scene": "scene-01", "cutAt": "bar:3"})
        self.assertTrue(any("--scenes 3" in n for n in data["notes"]))

    def test_a_scene_count_grows_and_shrinks_where_scenes_run_long_or_short(self) -> None:
        project = song_project(self.tmp, stems(3))
        self.assertEqual(len(self.plan(project, "--scenes", "20")["slots"]), 20)
        self.assertEqual(len(self.plan(project, "--scenes", "8")["slots"]), 8)
        self.assertIn("fewer than", self.plan(project, "--scenes", "3", code=1)["error"])
        self.assertIn("don't fit", self.plan(project, "--scenes", "99", code=1)["error"])

    def test_a_cut_of_the_song(self) -> None:
        data = self.plan(song_project(self.tmp, stems(3)), "--from", "bar:9", "--to", "bar:17")
        self.assertEqual((data["film"]["fromBar"], data["film"]["toBar"], [p["id"] for p in data["parts"]]), (9, 17, ["peak-1"]))
        self.assertEqual(data["slots"][-1]["role"], "payoff: lands on its first downbeat")
        self.assertEqual((data["slots"][0]["fromMs"], data["film"]["lengthMs"]), (0, 16000))
        self.assertTrue(any("./kb project set audio.startOffsetMs 16000" in n for n in data["notes"]))

    def test_apply_retimes_the_scenes_in_order(self) -> None:
        project = song_project(self.tmp, stems(17))
        data = self.plan(project, "--apply")
        self.assertEqual(data["film"]["matchesProject"], True)
        entries = read_json(project / "project.json")["scenes"]
        self.assertEqual([e["cutAt"] for e in entries], [c["cutAt"] for c in data["cuts"]])
        self.assertEqual(entries[-1]["cutAt"], "bar:33")
        self.assertExit(self.kb(["beats", "plan", "--apply", "--scenes", "5"], cwd=project), 2)

    def test_a_pickup_before_a_peak_keeps_the_reveal_on_its_downbeat(self) -> None:
        project = song_project(self.tmp, stems(3), sections=[{"id": "peak-1", "from": "bar:2", "to": "bar:10"}], cues={})
        data = self.plan(project, "--to", "bar:10")
        self.assertEqual([(p["id"], p["fromBar"]) for p in data["parts"]], [("unnamed", 1), ("peak-1", 2)])
        self.assertEqual(next(s for s in data["slots"] if s["role"].startswith("reveal"))["from"], "bar:2")

    def test_overlapping_sections_never_overlap_their_scenes(self) -> None:
        overlap = [{"id": "intro", "from": "bar:1", "to": "bar:9"}, {"id": "peak-1", "from": "bar:7", "to": "bar:13"},
                   {"id": "breakdown-1", "from": "bar:8", "to": "bar:10"}]
        project = song_project(self.tmp, stems(5), sections=overlap, cues={})
        data = self.plan(project, "--to", "bar:13", "--apply")
        self.assertEqual([(p["id"], p["fromBar"], p["toBar"]) for p in data["parts"]], [("intro", 1, 9), ("peak-1", 9, 13)])
        cuts = [s["cutAt"] for s in data["slots"]]
        self.assertEqual(len(cuts), len(set(cuts)))
        self.assertTrue(all(a["toMs"] == b["fromMs"] for a, b in zip(data["slots"], data["slots"][1:])))
        self.assertWritesWhatItPrinted(project, data)

    def test_two_four_time_caps_peaks_at_a_scene_a_bar(self) -> None:
        project = song_project(self.tmp, stems(3), grid={"bpm": 120, "offsetMs": 0, "beatsPerBar": 2},
                               sections=[{"id": "peak-1", "from": "bar:1", "to": "bar:9"}], cues={})
        self.assertEqual(len(self.plan(project, "--to", "bar:9", "--scenes", "8")["slots"]), 8)
        self.assertIn("don't fit", self.plan(project, "--to", "bar:9", "--scenes", "9", code=1)["error"])

    def test_no_song_asks_for_one_first(self) -> None:
        out = self.plan(make_project(self.tmp, scenes=stems(2)), code=1)
        self.assertIn("ask the person for a song first", out.get("hint") or "")

    def assertWritesWhatItPrinted(self, project: Path, data: Dict[str, Any]) -> None:
        p = Project(project)
        written = [(round(s["startMs"]), round(s["endMs"])) for s in tl.project_slots(p)]
        self.assertEqual(written, [(s["fromMs"], s["toMs"]) for s in data["slots"]])

    def test_a_start_offset_plans_from_the_bar_the_film_starts_on(self) -> None:
        project = song_project(self.tmp, stems(4), startOffsetMs=16000)
        data = self.plan(project, "--to", "bar:17", "--apply")
        self.assertEqual((data["film"]["fromBar"], data["slots"][0]["from"], data["slots"][0]["fromMs"]), (9, "bar:9", 0))
        self.assertNotIn("startOffsetWas", data["film"])
        self.assertWritesWhatItPrinted(project, data)
        self.assertEqual(read_json(project / "project.json")["audio"]["startOffsetMs"], 16000)

    def test_from_with_apply_starts_the_song_on_that_bar(self) -> None:
        project = song_project(self.tmp, stems(4))
        data = self.plan(project, "--from", "bar:9", "--to", "bar:17", "--apply")
        self.assertEqual((data["film"]["startOffsetMs"], data["film"]["startOffsetWas"]), (16000, 0))
        self.assertEqual([s["cutAt"] for s in data["slots"]], ["bar:11", "bar:13", "bar:15", "bar:17"])
        self.assertEqual(read_json(project / "project.json")["audio"]["startOffsetMs"], 16000)
        self.assertWritesWhatItPrinted(project, data)
        self.assertTrue(any("startOffsetMs = 16000" in c for c in data["changes"]))

    def test_apply_dry_run_writes_nothing(self) -> None:
        project = song_project(self.tmp, stems(4))
        before = (project / "project.json").read_bytes()
        data = self.plan(project, "--from", "bar:9", "--to", "bar:17", "--apply", "--dry-run")
        self.assertTrue(data["dryRun"])
        self.assertTrue(any("startOffsetMs = 16000" in c for c in data["changes"]))
        self.assertEqual((project / "project.json").read_bytes(), before)

    def test_a_pickup_before_bar_one_joins_the_first_scene(self) -> None:
        project = song_project(self.tmp, stems(4), grid={"bpm": 120, "offsetMs": 1000, "beatsPerBar": 4})
        data = self.plan(project, "--to", "bar:9", "--apply")
        first = data["slots"][0]
        self.assertEqual((first["from"], first["fromMs"], first["toMs"], first["bars"]), ("bar:0.3", 0, 5000, 2.5))
        self.assertEqual((data["film"]["fromBar"], data["film"]["lengthMs"]), (1, 17000))
        self.assertNotIn("startOffsetMs", read_json(project / "project.json")["audio"])
        self.assertWritesWhatItPrinted(project, data)

    def test_from_a_bar_before_the_song_refuses(self) -> None:
        project = song_project(self.tmp, stems(4))
        self.assertIn("before the song does", self.plan(project, "--from", "bar:0", "--to", "bar:9", code=1)["error"])
