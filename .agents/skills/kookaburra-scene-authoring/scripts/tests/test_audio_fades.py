from __future__ import annotations

import json
from typing import Any, List

from .helpers import read_json, write_json
from .test_app_edits import JournalCase, line


class FadeCheckTests(JournalCase):
    def set_audio(self, **audio: Any) -> None:
        manifest = read_json(self.root / "project.json")
        (self.root / "assets/track.mp3").write_bytes(b"x")
        manifest["audio"] = dict({"file": "assets/track.mp3"}, **audio)
        write_json(self.root / "project.json", manifest)

    def issues(self) -> List[str]:
        body = json.loads(self.kb(["check", "--json"], cwd=self.root).stdout)
        return [f"{i['path']}: {i['message']}" for i in body["issues"] if i["path"].startswith("audio.fade")]

    def test_a_short_fade_is_fine(self) -> None:
        self.set_audio(fadeOutMs=1000)
        self.assertEqual(self.issues(), [])

    def test_a_long_fade_warns_with_its_share_and_who_set_it(self) -> None:
        self.set_audio(fadeOutMs=3000)
        issues = self.issues()
        self.assertEqual(len(issues), 1)
        self.assertIn("covers 38%", issues[0])
        self.assertIn("set in project.json", issues[0])
        self.assertIn("./kb project set audio.fadeOutMs", issues[0])

    def test_provenance_names_the_app_when_the_app_set_it(self) -> None:
        self.set_audio(fadeOutMs=3000)
        self.edit(line("project.json", [{"path": "audio.fadeOutMs", "before": 1000, "after": 3000}]))
        self.assertIn("set in the app", self.issues()[0])

    def test_provenance_ignores_an_app_write_that_has_since_been_replaced(self) -> None:
        self.set_audio(fadeOutMs=3000)
        self.edit(line("project.json", [{"path": "audio.fadeOutMs", "before": 1000, "after": 2000}]))
        self.assertIn("set in project.json", self.issues()[0])

    def test_a_cue_inside_the_fade_warns_even_when_the_fade_is_short(self) -> None:
        self.set_audio(fadeOutMs=1000, grid={"bpm": 120, "offsetMs": 0, "beatsPerBar": 4}, cues={"final-hit": 7300})
        issues = self.issues()
        self.assertEqual(len(issues), 1)
        self.assertIn('cue "final-hit"', issues[0])
        self.assertIn("plays inside", issues[0])

    def test_the_default_fade_counts_and_says_so(self) -> None:
        self.set_audio(grid={"bpm": 120, "offsetMs": 0, "beatsPerBar": 4}, cues={"final-hit": 7300})
        self.assertIn("the default", self.issues()[0])

    def test_no_fade_is_no_warning(self) -> None:
        self.set_audio(fadeOutMs=0, grid={"bpm": 120, "offsetMs": 0, "beatsPerBar": 4}, cues={"final-hit": 7300})
        self.assertEqual(self.issues(), [])

    def test_a_long_fade_in_and_a_cue_inside_it(self) -> None:
        self.set_audio(fadeInMs=2000, grid={"bpm": 120, "offsetMs": 0, "beatsPerBar": 4}, cues={"open": 500})
        issues = self.issues()
        self.assertTrue(any("audio.fadeInMs" in i and "covers" in i for i in issues))
        self.assertTrue(any('cue "open"' in i for i in issues))
