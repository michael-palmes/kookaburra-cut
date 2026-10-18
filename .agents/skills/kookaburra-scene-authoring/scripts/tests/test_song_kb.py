"""kb song analyse against the fake app CLI: caps gating, the .kb/song copy, the summary, --lyrics and --accept."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List

from .helpers import KbTestCase, make_project, read_json, write_json

SONG = b"not really audio, a steady click"
DIGEST = hashlib.sha256(SONG).hexdigest()
SONG_CAPS = json.dumps({"song": {"analysisVersion": 2, "trackers": ["nn", "dsp"]}})


class SongAnalyseTests(KbTestCase):
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
        self.assertIn("next: ./kb beats set-grid --from-analysis", text.stdout)
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
        self.assertEqual(grid, {"bpm": 120, "offsetMs": 250, "beatsPerBar": 4, "source": {"sha256": DIGEST, "analysisVersion": 2, "tracker": "nn", "residualMs": 0.9}})
        self.assertEqual(out["accepted"]["moved"][0]["file"], "scenes/02-hero.json")
        # bar:3 is track 4250, film 4150, so 1750 into scene 1 (which starts at 2400).
        self.assertEqual(read_json(self.root / "scenes" / "02-hero.json")["camera"]["keys"][1]["tMs"], 1750)
        self.assertEqual(sorted(w["path"] for w in out["writes"]), [f".kb/song/{DIGEST[:12]}.json", "project.json", "scenes/02-hero.json"])

    def test_accept_refuses_a_drifting_tempo(self) -> None:
        from .fake_app_cli import fake_analysis

        body = fake_analysis()
        body["fit"]["constantTempo"] = False
        canned = self.tmp / "drift.json"
        write_json(canned, body)
        self.cli(song=canned)
        out = self.j("--accept", code=1)
        self.assertIn("drifts", out["error"])
        self.assertTrue((self.root / ".kb" / "song" / f"{DIGEST[:12]}.json").is_file())
        self.assertNotIn("grid", read_json(self.root / "project.json")["audio"])

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


if __name__ == "__main__":
    import unittest

    unittest.main()
