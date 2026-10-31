"""kb song analyse against the fake app CLI: caps gating, the .kb/song copy, the summary, --lyrics and --accept."""

from __future__ import annotations

import hashlib
import json
import math
import shutil
import struct
import tempfile
import wave
from pathlib import Path
from typing import Any, Dict, List

from .helpers import KbTestCase, make_project, read_json, write_json

SONG = b"not really audio, a steady click"
DIGEST = hashlib.sha256(SONG).hexdigest()
SONG_CAPS = json.dumps({"song": {"analysisVersion": 3, "trackers": ["nn", "dsp"]}})


def write_wav(path: Path, seconds: int = 2) -> None:
    """A second of 440 Hz, made here: tests never commit media."""
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / 8000))) for i in range(8000 * seconds))
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(8000)
        out.writeframes(frames)


class SongCase(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.env["KB_BEATS_CACHE_DIR"] = str(self.tmp / "beats-cache")
        self.log = self.tmp / "cli.log"
        self.root = make_project(self.tmp, audio={"file": "assets/track.mp3", "startOffsetMs": 100})
        (self.root / "assets" / "track.mp3").write_bytes(SONG)
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "camera": {"keys": [{"id": "k1", "tMs": 0}, {"id": "k2", "tMs": 1, "at": "bar:3"}], "segments": []}})

    def cli(self, **behaviour: Any) -> None:
        self.fake_cli(caps=behaviour.pop("caps", SONG_CAPS), log=self.log, **behaviour)

    def calls(self) -> List[List[str]]:
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()] if self.log.exists() else []

    def j(self, *args: str, code: int = 0) -> Dict[str, Any]:
        proc = self.kb(["song", "analyse"] + list(args) + ["--json"], cwd=self.root)
        self.assertExit(proc, code)
        return json.loads(proc.stdout)


class SongAnalyseTests(SongCase):
    def test_an_app_without_song_caps_is_refused_before_it_runs(self) -> None:
        self.cli(caps=json.dumps({"song": None}))
        out = self.j(code=2)
        self.assertEqual(out["code"], "env")
        self.assertIn("update", out["hint"])
        self.assertFalse([c for c in self.calls() if c[:1] == ["song"]])

    def test_no_soundtrack_is_invalid(self) -> None:
        self.cli()
        root = make_project(self.tmp / "silent")
        proc = self.kb(["song", "analyse", "--json"], cwd=root)
        self.assertExit(proc, 1)
        out = json.loads(proc.stdout)
        self.assertEqual(out["code"], "invalid")
        self.assertIn("kb assets add", out["hint"])

    def test_analyse_copies_the_result_and_summarises_it(self) -> None:
        self.cli()
        out = self.j("--tracker", "dsp", "--force")
        song = [c for c in self.calls() if c[:1] == ["song"]][0]
        self.assertEqual(song[:2], ["song", "analyse"])
        self.assertEqual(song[song.index("--file") + 1], str((self.root / "assets" / "track.mp3").resolve()))
        self.assertIn("--force", song)
        self.assertEqual(song[song.index("--tracker") + 1], "dsp")
        copy = self.root / ".kb" / "song" / f"{DIGEST[:12]}.json"
        self.assertEqual(out["analysisPath"], str(copy))
        self.assertEqual(read_json(copy)["sha256"], DIGEST)
        self.assertEqual((self.root / ".kb" / ".gitignore").read_text(), "*\n")
        self.assertEqual(out["fit"]["bpm"], 120.0)
        self.assertEqual(out["downbeat"], {"trackMs": 250.0, "projectMs": 150.0})
        self.assertEqual(out["tracker"], "dsp")
        self.assertEqual(out["sections"][1], {"fromBar": 9, "toBar": 17, "novelty": 0.7})
        self.assertNotIn("grid", read_json(self.root / "project.json")["audio"])
        text = self.kb(["song", "analyse"], cwd=self.root)
        self.assertExit(text, 0)
        self.assertIn("tempo: 120.0 bpm", text.stdout)
        self.assertIn("next: ./kb song analyse --accept", text.stdout)
        shown = self.kb(["beats", "--json"], cwd=self.root)
        self.assertEqual(json.loads(shown.stdout)["analysisPath"], str(copy))

    def test_lyrics_print_only_when_asked(self) -> None:
        from .fake_app_cli import fake_analysis

        canned = self.tmp / "song.json"
        body = fake_analysis()
        body["lyrics"] = {"source": "tag", "lang": "eng", "text": "la la la\nla la"}
        write_json(canned, body)
        self.cli(song=canned)
        hidden = self.j()
        self.assertEqual(hidden["lyrics"], {"source": "tag", "lang": "eng", "present": True})
        text = self.kb(["song", "analyse"], cwd=self.root)
        self.assertNotIn("la la", text.stdout)
        self.assertIn("pass --lyrics", text.stdout)
        shown = self.j("--lyrics")
        self.assertEqual(shown["lyrics"]["text"], "la la la\nla la")

    def test_accept_writes_the_grid_with_its_source_and_refreshes_caches(self) -> None:
        self.cli()
        out = self.j("--accept")
        grid = read_json(self.root / "project.json")["audio"]["grid"]
        self.assertEqual(grid, {"bpm": 120, "offsetMs": 250, "beatsPerBar": 4, "source": {"sha256": DIGEST, "analysisVersion": 3, "tracker": "nn", "residualMs": 0.9}})
        self.assertEqual(out["accepted"]["moved"][0]["file"], "scenes/02-hero.json")
        # bar:3 is track 4250, film 4150, so 1750 into scene 1 (which starts at 2400).
        self.assertEqual(read_json(self.root / "scenes" / "02-hero.json")["camera"]["keys"][1]["tMs"], 1750)
        self.assertEqual(sorted(w["path"] for w in out["writes"]), [f".kb/song/{DIGEST[:12]}.json", "project.json", "scenes/02-hero.json"])

    def test_accept_refuses_a_drifting_tempo(self) -> None:
        from .fake_app_cli import fake_analysis

        body = fake_analysis()
        body["fit"].update(constantTempo=False, maxDriftMs=40.5)
        canned = self.tmp / "drift.json"
        write_json(canned, body)
        self.cli(song=canned)
        out = self.j("--accept", code=1)
        self.assertIn("max drift 40.5 ms is over one frame at 30 fps (33 ms)", out["error"])
        self.assertIn("residual 0.9 ms", out["error"])
        self.assertTrue((self.root / ".kb" / "song" / f"{DIGEST[:12]}.json").is_file())
        audio = read_json(self.root / "project.json")["audio"]
        self.assertNotIn("grid", audio)
        self.assertNotIn("cues", audio)

    def test_a_drift_within_a_frame_is_accepted_and_says_so(self) -> None:
        from .fake_app_cli import fake_analysis

        body = fake_analysis()
        # A v2 copy could call this drifting; the number decides.
        body["fit"].update(constantTempo=False, maxDriftMs=19)
        canned = self.tmp / "holds.json"
        write_json(canned, body)
        self.cli(song=canned)
        shown = self.kb(["song", "analyse"], cwd=self.root)
        self.assertIn("max drift 19 ms: under one frame at 30 fps (33 ms), so one grid holds", shown.stdout)
        out = self.j("--accept")
        self.assertIn("grid", read_json(self.root / "project.json")["audio"])
        self.assertTrue(any("drifts by up to 19 ms: under one frame" in n for n in out["accepted"]["notes"]), out["accepted"]["notes"])

    def test_a_song_that_slips_off_a_grid_that_holds_says_where(self) -> None:
        from .fake_app_cli import fake_analysis

        body = fake_analysis()
        body["fit"].update(maxDriftMs=18, beatStrayMs=105.2, beatStrayAtMs=43500)
        canned = self.tmp / "slips.json"
        write_json(canned, body)
        self.cli(song=canned)
        shown = self.kb(["song", "analyse"], cwd=self.root)
        self.assertIn("beats stray up to 105.2 ms from this grid near 43.5 s", shown.stdout)
        self.assertNotIn("so one grid holds", shown.stdout)
        out = self.j("--accept")
        self.assertIn("grid", read_json(self.root / "project.json")["audio"])
        self.assertTrue(any("beats stray up to 105.2 ms" in n for n in out["accepted"]["notes"]), out["accepted"]["notes"])

    def test_a_stray_under_two_frames_says_nothing(self) -> None:
        from .fake_app_cli import fake_analysis

        body = fake_analysis()
        body["fit"].update(maxDriftMs=10, beatStrayMs=47, beatStrayAtMs=62600)
        canned = self.tmp / "tail.json"
        write_json(canned, body)
        self.cli(song=canned)
        shown = self.kb(["song", "analyse"], cwd=self.root)
        self.assertNotIn("stray", shown.stdout)
        self.assertIn("steady tempo", shown.stdout)

    def test_analyse_prints_the_audible_end_and_the_form(self) -> None:
        self.cli()
        out = self.j()
        self.assertEqual(out["ending"]["audibleEndMs"], 30000.0)
        self.assertEqual(out["form"]["phrase"]["bars"], 4)
        self.assertEqual(out["hits"], {"full": 3, "low": 1, "mid": 1, "high": 0})
        text = self.kb(["song", "analyse"], cwd=self.root).stdout
        self.assertIn("audible end: 30.00 s, then 2.00 s of silence; last strong hit at 29.75 s (bar:15.4.1), strength 0.8", text)
        self.assertIn("phrases: 4 bars, counting from bar 1", text)
        self.assertIn("parts: peak-1 bars 1-8, breakdown-1 bars 9-12, peak-2 bars 13-15", text)
        self.assertIn("moments: fill-1 bar:8.3, final-hit bar:15.4", text)

    def test_accept_names_the_form_as_cues_and_sections_that_resolve(self) -> None:
        self.cli()
        self.j("--accept")
        audio = read_json(self.root / "project.json")["audio"]
        self.assertEqual(audio["cues"], {"fill-1": "bar:8.3", "final-hit": "bar:15.4"})
        self.assertEqual(audio["sections"][1], {"id": "breakdown-1", "from": "bar:9", "to": "bar:13", "label": "Breakdown 1"})
        shown = json.loads(self.kb(["beats", "--json"], cwd=self.root).stdout)
        self.assertEqual(shown["problems"], [])
        self.assertEqual({c["id"]: c["projectMs"] for c in shown["cues"]}, {"fill-1": 15150, "final-hit": 29650})
        self.assertEqual([s["id"] for s in shown["sections"]], ["peak-1", "breakdown-1", "peak-2"])
        again = self.j("--accept")
        self.assertIn("0 cues and 0 sections added", again["accepted"]["summary"])

    def test_accept_never_overwrites_what_was_authored(self) -> None:
        self.cli()
        self.kb(["song", "analyse", "--accept"], cwd=self.root)
        self.assertExit(self.kb(["beats", "cue", "set", "fill-1", "bar:6"], cwd=self.root), 0)
        self.assertExit(self.kb(["beats", "section", "set", "peak-1", "--from", "bar:2", "--to", "bar:7", "--label", "Mine"], cwd=self.root), 0)
        out = self.j("--accept")
        audio = read_json(self.root / "project.json")["audio"]
        self.assertEqual(audio["cues"]["fill-1"], "bar:6")
        peak = next(s for s in audio["sections"] if s["id"] == "peak-1")
        self.assertEqual((peak["from"], peak["to"], peak["label"]), ("bar:2", "bar:7", "Mine"))
        notes = " ".join(out["accepted"]["notes"])
        self.assertIn("kept cue fill-1 = bar:6 (the analysis says bar:8.3)", notes)
        self.assertIn("kept section peak-1", notes)

    def test_dry_run_writes_nothing(self) -> None:
        self.cli()
        out = self.j("--accept", "--dry-run")
        self.assertTrue(out["dryRun"])
        self.assertFalse((self.root / ".kb" / "song").exists())
        self.assertNotIn("grid", read_json(self.root / "project.json")["audio"])
        self.assertIn("project.json", [w["path"] for w in out["writes"]])

    def test_a_failed_analysis_is_exit_1(self) -> None:
        self.cli(fail="song")
        out = self.j(code=1)
        self.assertIn("Invalid data", out["error"])

    def test_file_analyses_any_file_and_the_project_stays_as_it_is(self) -> None:
        from .video_synth import tools

        found = tools()
        if not found:
            self.skipTest("no ffmpeg")
        self.env["KB_FFMPEG"], self.env["KB_FFPROBE"] = found
        self.cli()
        outside = Path(tempfile.mkdtemp(prefix="kb-song-outside-"))
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        ref = outside / "ref.wav"
        write_wav(ref)
        before = (self.root / "project.json").read_bytes()
        proc = self.kb(["song", "analyse", "--file", str(ref), "--json"], cwd=self.root)
        self.assertExit(proc, 0)
        out = json.loads(proc.stdout)
        self.assertEqual(out["file"], str(ref.resolve()))
        self.assertEqual(out["downbeat"]["projectMs"], out["downbeat"]["trackMs"])
        self.assertIn(f"kb: reading {ref.resolve()}", proc.stderr)
        self.assertIn("from outside the workspace", proc.stderr)
        self.assertEqual((self.root / "project.json").read_bytes(), before)
        digest = hashlib.sha256(ref.read_bytes()).hexdigest()
        self.assertTrue((self.root / ".kb" / "song" / f"{digest[:12]}.json").is_file())
        song = [c for c in self.calls() if c[:1] == ["song"]][-1]
        self.assertEqual(song[song.index("--file") + 1], str(ref.resolve()))
        hits = self.kb(["song", "hits", "--file", str(ref), "--json"], cwd=self.root)
        self.assertExit(hits, 0)
        self.assertEqual(json.loads(hits.stdout)["gridFrom"], "fit")

    def test_file_refuses_credentials_garbage_and_accept(self) -> None:
        from .video_synth import tools

        found = tools()
        if not found:
            self.skipTest("no ffmpeg")
        self.env["KB_FFMPEG"], self.env["KB_FFPROBE"] = found
        self.cli()
        key = self.tmp / "signing.pem"
        key.write_text("secret")
        out = self.j("--file", str(key), code=2)
        self.assertIn("kb never reads credentials", out["error"])
        junk = self.root / "assets" / "junk.mp3"
        junk.write_bytes(b"\x00not audio at all\x00" * 64)
        out = self.j("--file", str(junk), code=1)
        self.assertEqual(out["code"], "invalid")
        playlist = self.root / "assets" / "list.m3u8"
        playlist.write_text("#EXTM3U\n#EXTINF:1,\nfile:///etc/hosts\n#EXT-X-ENDLIST\n")
        out = self.j("--file", str(playlist), code=1)
        self.assertEqual(out["code"], "invalid")
        self.assertFalse([c for c in self.calls() if c[:1] == ["song"]])
        self.assertEqual(self.j("--file", str(self.root / "assets" / "track.mp3"), "--accept", code=2)["code"], "usage")
        self.assertEqual(self.j("--file", str(self.tmp / "missing.wav"), code=2)["code"], "usage")


class SongHitsTests(SongCase):
    def hits(self, *args: str, code: int = 0) -> Dict[str, Any]:
        proc = self.kb(["song", "hits"] + list(args) + ["--json"], cwd=self.root)
        self.assertExit(proc, code)
        return json.loads(proc.stdout)

    def test_hits_are_positions_with_a_strength_split_by_band(self) -> None:
        self.cli()
        full = self.hits()
        self.assertEqual([h["position"] for h in full["hits"]], ["bar:1.1.1", "bar:8.1.2"])
        self.assertEqual(full["hits"][1]["strength"], 0.8)
        self.assertEqual(full["hits"][1]["projectMs"], 14275.0)
        self.assertEqual(full["gridFrom"], "fit")
        self.assertEqual(len(self.hits("--min-strength", "0.3")["hits"]), 3)
        self.assertEqual([h["position"] for h in self.hits("--bars", "8")["hits"]], ["bar:8.1.2"])
        self.assertEqual(self.hits("--bars", "2-7")["hits"], [])
        mid = self.hits("--band", "mid")["hits"]
        self.assertEqual(mid[0]["position"], "bar:8.1.2+12ms")
        self.assertEqual(mid[0]["offMs"], 12.0)
        text = self.kb(["song", "hits", "--bars", "1-8"], cwd=self.root).stdout
        self.assertIn("2 hits in bars 1-8 (full band, strength 0.5 or more)", text)
        self.assertIn("bar:8.1.2", text)

    def test_a_position_lands_on_the_hit_it_names(self) -> None:
        self.cli()
        self.kb(["song", "analyse", "--accept"], cwd=self.root)
        hit = self.hits("--band", "mid")["hits"][0]
        resolved = json.loads(self.kb(["beats", "resolve", hit["position"], "--json"], cwd=self.root).stdout)
        self.assertEqual(resolved["projectMs"], round(hit["projectMs"]))

    def test_hits_read_the_saved_analysis_and_never_recompute(self) -> None:
        self.cli()
        self.j()
        before = len([c for c in self.calls() if c[:1] == ["song"]])
        self.hits()
        self.assertEqual(len([c for c in self.calls() if c[:1] == ["song"]]), before)

    def test_hits_run_an_analysis_when_the_saved_one_has_none(self) -> None:
        self.cli()
        from .fake_app_cli import fake_analysis

        old = {k: v for k, v in fake_analysis().items() if k not in ("hits", "ending", "form")}
        write_json(self.root / ".kb" / "song" / f"{DIGEST[:12]}.json", dict(old, version=2, sha256=DIGEST))
        self.assertEqual(len(self.hits()["hits"]), 2)
        self.assertTrue([c for c in self.calls() if c[:1] == ["song"]])
        self.assertIn("hits", read_json(self.root / ".kb" / "song" / f"{DIGEST[:12]}.json"))

    def test_hits_count_on_the_authored_grid_when_there_is_one(self) -> None:
        self.cli()
        self.assertExit(self.kb(["beats", "set-grid", "--bpm", "60", "--offset", "250", "--beats-per-bar", "4"], cwd=self.root), 0)
        out = self.hits()
        self.assertEqual(out["gridFrom"], "authored")
        # At 60 bpm a 16th is 250 ms: 14375 is 56.5 of them past bar 1, rounding up to bar 4 beat 3's second, 125 ms early.
        self.assertEqual(out["hits"][1]["position"], "bar:4.3.2-125ms")

    def test_a_damaged_saved_fit_never_divides_by_zero(self) -> None:
        self.cli()
        self.j()
        copy = self.root / ".kb" / "song" / f"{DIGEST[:12]}.json"
        body = read_json(copy)
        body["fit"]["beatsPerBar"] = 0
        write_json(copy, body)
        self.assertEqual(self.hits()["hits"][0]["position"], "bar:1.1.1")
        body["fit"]["bpm"] = 0
        write_json(copy, body)
        out = self.hits()
        self.assertIsNone(out["gridFrom"])
        self.assertNotIn("position", out["hits"][0])

    def test_bad_bars_are_usage_errors(self) -> None:
        self.cli()
        self.assertEqual(self.hits("--bars", "nine", code=2)["code"], "usage")
        self.assertEqual(self.hits("--bars", "9-4", code=2)["code"], "usage")
        self.assertEqual(self.hits("--min-strength", "2", code=2)["code"], "usage")


class ProjectFitTests(SongCase):
    def fit(self, *args: str, code: int = 0) -> Dict[str, Any]:
        proc = self.kb(["project", "fit", "--to", "song-end"] + list(args) + ["--json"], cwd=self.root)
        self.assertExit(proc, code)
        return json.loads(proc.stdout)

    def total(self) -> int:
        return json.loads(self.kb(["beats", "--json"], cwd=self.root).stdout)["projectTotalMs"]

    def test_the_film_ends_on_the_music(self) -> None:
        self.cli()
        out = self.fit()
        # The audible end is 30000 ms in the track and the film starts 100 ms into it.
        self.assertEqual(self.total(), 29900)
        self.assertIn("ends at 29.90 s", out["summary"])
        self.assertTrue(any("2.00 s of silence" in n for n in out["notes"]), out["notes"])
        self.assertIn("project.json", [w["path"] for w in out["writes"]])

    def test_it_warns_when_the_default_fade_would_swallow_the_last_hit(self) -> None:
        self.cli()
        notes = " ".join(self.fit()["notes"])
        self.assertIn("plays inside the fade", notes)
        self.assertIn("audio.fadeOutMs 0", notes)
        self.assertExit(self.kb(["project", "set", "audio.fadeOutMs", "0"], cwd=self.root), 0)
        self.assertNotIn("plays inside the fade", " ".join(self.fit()["notes"]))

    def test_a_hold_stays_past_it_and_a_negative_one_is_refused(self) -> None:
        self.cli()
        self.fit("--hold", "400")
        self.assertEqual(self.total(), 30300)
        for bad in ("-1", "nan", "inf"):
            self.assertEqual(self.fit(f"--hold={bad}", code=2)["code"], "usage")

    def test_it_unpins_the_last_scene_and_keeps_the_earlier_ones(self) -> None:
        self.cli()
        self.kb(["song", "analyse", "--accept"], cwd=self.root)
        self.assertExit(self.kb(["scene", "set", "03-outro", "--cut-at", "bar:9"], cwd=self.root), 0)
        self.fit()
        scenes = read_json(self.root / "project.json")["scenes"]
        self.assertNotIn("cutAt", scenes[-1])
        self.assertEqual(self.total(), 29900)

    def test_it_refuses_when_the_music_ends_before_the_last_scene(self) -> None:
        self.cli()
        self.assertExit(self.kb(["scene", "set", "01-intro", "--duration", "40000"], cwd=self.root), 0)
        out = self.fit(code=1)
        self.assertIn("before the last scene", out["error"])

    def test_a_dry_run_writes_nothing(self) -> None:
        self.cli()
        before = self.total()
        plan = self.kb(["project", "fit", "--to", "song-end", "--dry-run", "--json"], cwd=self.root)
        self.assertExit(plan, 0)
        self.assertTrue(json.loads(plan.stdout)["dryRun"])
        self.assertEqual(self.total(), before)
        planned = self.kb(["plan", "project", "fit", "--to", "song-end"], cwd=self.root)
        self.assertExit(planned, 0)
        self.assertIn("project.json", planned.stdout)


if __name__ == "__main__":
    import unittest

    unittest.main()
