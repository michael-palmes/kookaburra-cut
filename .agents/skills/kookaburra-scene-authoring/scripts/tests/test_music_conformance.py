from __future__ import annotations

import json
import unittest

from kblib import music

from .helpers import FIXTURES

VECTORS = FIXTURES / "music-vectors.json"


@unittest.skipUnless(VECTORS.is_file(), "fixtures/music-vectors.json is missing (pnpm agent:vectors writes it)")
class MusicConformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.vectors = json.loads(VECTORS.read_text(encoding="utf-8"))

    def test_version(self) -> None:
        self.assertEqual(self.vectors["version"], 1)

    def test_resolve_matches_the_app_exactly(self) -> None:
        for v in self.vectors["resolve"]:
            with self.subTest(v["id"]):
                got = music.resolve(v["position"], v["music"])
                want = v["expect"]
                self.assertEqual(got["ok"], want["ok"], got)
                if not want["ok"]:
                    self.assertEqual(got["code"], want["code"])
                    continue
                self.assertEqual(float(got["projectMs"]), want["projectMs"])
                self.assertEqual(music.round_ms(got["projectMs"]), want["rounded"])
                local = music.resolve_scene_local(v["position"], v["music"], v["sceneStartMs"])
                self.assertEqual(local["projectMs"], want["sceneLocalMs"])

    def test_rounding_copies_math_round(self) -> None:
        for r in self.vectors["rounding"]:
            with self.subTest(r["x"]):
                self.assertEqual(music.round_ms(r["x"]), r["out"])


class MusicGrammarTests(unittest.TestCase):
    def test_python_regex_quirks_stay_out(self) -> None:
        self.assertFalse(music.is_position("bar:1\n"))
        self.assertFalse(music.is_position("bar:١"))
        self.assertTrue(music.is_position("bar:12.3.2-8ms"))

    def test_cue_values_must_be_positions_or_ms(self) -> None:
        base = {"grid": {"bpm": 120, "offsetMs": 0, "beatsPerBar": 4}, "startOffsetMs": 0, "sections": {}}
        self.assertEqual(music.resolve("cue:a", {**base, "cues": {"a": None}})["code"], "syntax")
        self.assertEqual(music.resolve("cue:a", {**base, "cues": {"a": True}})["code"], "syntax")
        self.assertEqual(music.resolve("cue:constructor", {**base, "cues": {}})["code"], "unknown")
        self.assertEqual(music.resolve("section:a", {**base, "cues": {}, "sections": {"a": None}})["code"], "unknown")


if __name__ == "__main__":
    unittest.main()
