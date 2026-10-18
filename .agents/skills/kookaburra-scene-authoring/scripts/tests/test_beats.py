from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import sys
import unittest
from pathlib import Path

from kblib.video import fit as f

from .helpers import SCRIPTS, KbTestCase, write_json


def beats_module():
    spec = importlib.util.spec_from_file_location("kb_beats_test", str(SCRIPTS / "beats.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


SONG = b"not really audio"
DIGEST = hashlib.sha256(SONG).hexdigest()


def v2(period=444.07):
    return {
        "version": 2, "sha256": DIGEST, "tracker": "nn", "durationMs": 20000,
        "fit": {"bpm": round(60000 / period, 3), "offsetMs": 447.5, "beatsPerBar": 4, "periodMs": period,
                "phaseMs": 3.43, "residualMs": 0.91, "maxDriftMs": 1.2, "constantTempo": True},
        "beats": [{"ms": round(447.5 + k * period, 3), "bar": k // 4 + 1, "beat": k % 4 + 1, "conf": 0.9} for k in range(40)],
        "keyMoments": [{"tMs": 4400, "strength": 0.9}],
        "envelope": {"hopMs": 21.333, "values": []},
    }


def v1():
    return {"version": 1, "bpm": 135.1, "beats": [450 + 444 * k for k in range(40)],
            "keyMoments": [{"tMs": 4400, "strength": 0.9}], "envelope": {"hopMs": 21.333, "values": []}}


class BeatsReaderTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.mod = beats_module()
        self.cache = self.tmp / "beats"
        self.mod.CACHE_DIR = self.cache
        self.root = self.tmp / "p"
        (self.root / "assets").mkdir(parents=True)
        (self.root / "assets" / "song.mp3").write_bytes(SONG)
        write_json(self.root / "project.json", {
            "scenes": [{"file": "scenes/01-a.tsx", "durationMs": 10000}],
            "audio": {"file": "assets/song.mp3", "startOffsetMs": 0},
        })

    def run_main(self, *args: str):
        out, err = io.StringIO(), io.StringIO()
        cwd = os.getcwd()
        os.chdir(self.root)
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                saved = sys.argv
                sys.argv = ["beats.py", *args]
                try:
                    code = self.mod.main()
                finally:
                    sys.argv = saved
        finally:
            os.chdir(cwd)
        return code, out.getvalue(), err.getvalue()

    def test_v2_is_read_first_and_keeps_the_fitted_period(self) -> None:
        write_json(self.cache / f"{DIGEST}.json", v1())
        write_json(self.cache / f"{DIGEST}-v2.json", v2())
        analysis, path = self.mod.load_analysis(DIGEST)
        self.assertEqual(path.name, f"{DIGEST}-v2.json")
        self.assertEqual(self.mod.tempo(analysis), (135.114, 444.07))
        code, out, err = self.run_main("--json")
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        data = json.loads(out)
        self.assertEqual(data["analysisVersion"], 2)
        self.assertEqual(data["tracker"], "nn")
        self.assertEqual(data["beatIntervalMs"], 444.07)
        self.assertEqual(data["fit"]["offsetMs"], 447.5)
        self.assertEqual(data["beats"][:3], [448, 892, 1336])

    def test_v1_still_reads_with_a_warning(self) -> None:
        write_json(self.cache / f"{DIGEST}.json", v1())
        code, out, err = self.run_main("--json")
        self.assertEqual(code, 0)
        self.assertIn("v1 (unrefined", err)
        data = json.loads(out)
        self.assertEqual(data["analysisVersion"], 1)
        self.assertEqual(data["beatIntervalMs"], 444)
        self.assertIsNone(data["fit"])
        self.assertEqual(data["beats"][:2], [450, 894])

    def test_the_summary_line_shows_the_refined_tempo(self) -> None:
        write_json(self.cache / f"{DIGEST}-v2.json", v2())
        code, out, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("bpm: 135.114 (beat every 444.07ms, residual 0.91ms)", out)

    def test_unknown_versions_and_a_missing_cache_fail(self) -> None:
        code, _, err = self.run_main()
        self.assertEqual(code, 3)
        self.assertIn("no cached analysis", err)
        write_json(self.cache / f"{DIGEST}-v2.json", {**v2(), "version": 3})
        code, _, err = self.run_main()
        self.assertEqual(code, 2)
        self.assertIn("unsupported", err)

    def test_beat_times_read_both_shapes(self) -> None:
        self.assertEqual(self.mod.beat_times({"beats": [{"ms": 1.5}, {"ms": None}, 3, True]}), [1.5, 3])
        self.assertEqual(self.mod.tempo({"bpm": 120}), (120, 500))
        self.assertEqual(self.mod.tempo({}), (None, None))

    def test_video_align_reads_the_v2_cache(self) -> None:
        write_json(self.cache / f"{DIGEST}-v2.json", v2(period=500.0))
        info = f.scene_beats(self.root, 0, lambda p: json.loads(Path(p).read_text()), cache_dir=self.cache)
        self.assertEqual(info["beats"][:2], [447.5, 947.5])
        self.assertEqual(f.pick_beat(info, "beat", 2), 947.5)


if __name__ == "__main__":
    unittest.main()
