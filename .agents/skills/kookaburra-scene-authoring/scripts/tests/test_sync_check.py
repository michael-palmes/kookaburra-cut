from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path
from typing import Any, List

from kblib.film import sync

from . import video_synth as vs
from .helpers import KbTestCase, make_project, write_json

TOOLS = vs.tools()
needs_ffmpeg = unittest.skipUnless(TOOLS, "no ffmpeg")
FLASHES = (15, 30, 45, 76)
CUT = 60


def synced_film(out: Path, *, poster: bool = False, delay_video_s: float = 0.0) -> Path:
    """30 fps x264 (B-frames, so an edit list) and AAC: flashes on beats 1 to 3, a cut on beat 4, a flash a frame after beat 5."""
    assert TOOLS
    ff = TOOLS[0]
    lead = 1 if poster else 0
    frames = 120 + lead
    lit = "+".join(f"eq(n\\,{f + lead})" for f in FLASHES)
    graph = (f"color=c=0x0b0f14:s=320x180:r=30:d={frames / 30}[a];color=c=0x606060:s=320x180:r=30:d={frames / 30}[g];"
             f"color=c=white:s=320x180:r=30:d={frames / 30}[w];[a][g]overlay=enable='gte(n\\,{CUT + lead})+lt(n\\,{lead})'[ag];"
             f"[ag][w]overlay=enable='{lit}',format=yuv420p[out];sine=frequency=440:duration={frames / 30}:sample_rate=48000[tone]")
    out.parent.mkdir(parents=True, exist_ok=True)
    plain = out.with_name(out.stem + ".plain.mp4") if delay_video_s else out
    subprocess.run([ff, "-v", "error", "-y", "-filter_complex", graph, "-map", "[out]", "-map", "[tone]", "-frames:v", str(frames),
                    "-c:v", "libx264", "-c:a", "aac", "-b:a", "128k", str(plain)], check=True, capture_output=True)
    if delay_video_s:
        subprocess.run([ff, "-v", "error", "-y", "-itsoffset", str(delay_video_s), "-i", str(plain), "-i", str(plain),
                        "-map", "0:v", "-map", "1:a", "-c", "copy", str(out)], check=True, capture_output=True)
    return out


class PureTests(unittest.TestCase):
    def test_a_jump_counts_once_and_a_ramp_never(self) -> None:
        times = [i * 1000 / 30 for i in range(20)]
        changes = [0.5] * 20
        changes[5], changes[6] = 60.0, 60.0
        changes[12:17] = [6.0, 9.0, 12.0, 15.0, 18.0]
        self.assertEqual(sync.detect(changes, times, 1), [5])
        self.assertEqual(sync.detect(changes, times, 6), [])

    def test_bpm_beats_cover_the_film_from_any_offset(self) -> None:
        self.assertEqual(sync.bpm_beats(120, 250, 1300), [250.0, 750.0, 1250.0])
        self.assertEqual(sync.bpm_beats(120, -400, 700), [100.0, 600.0])

    def test_nearest_and_verdict(self) -> None:
        self.assertEqual(sync.nearest([0.0, 500.0, 1000.0], 740.0), (1, 500.0))
        self.assertEqual(sync.nearest([0.0, 500.0, 1000.0], 760.0), (2, 1000.0))
        self.assertEqual(sync.verdict(33.0, 33.33, 2.0), "in sync")
        self.assertEqual(sync.verdict(40.0, 33.33, 2.0), "late")
        self.assertEqual(sync.verdict(-5.0, 33.33, 2.0), "early")

    def test_a_quiet_cut_is_found_at_its_seam(self) -> None:
        slots = [{"index": 0, "stem": "01-a", "startMs": 0, "durationMs": 1000, "endMs": 1000},
                 {"index": 1, "stem": "02-b", "startMs": 1000, "durationMs": 1000, "endMs": 2000}]
        changes = [0.2] * 60
        changes[30] = 3.0
        times = [i * 1000 / 30 for i in range(60)]
        evs = sync.events(changes, times, slots, 30.0, 0)
        self.assertEqual([(e["frame"], e["kind"], e["to"]) for e in evs], [(30, "cut", "02-b")])


@needs_ffmpeg
class SyncCheckTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        assert TOOLS
        self.env.update({"KB_FFMPEG": TOOLS[0], "KB_FFPROBE": TOOLS[1]})
        self.project = make_project(self.tmp, scenes=["01-title", "02-strobe"])
        self.manifest(audio={"grid": {"bpm": 120, "offsetMs": 0, "beatsPerBar": 4}})

    def manifest(self, **extra: Any) -> None:
        m = json.loads((self.project / "project.json").read_text())
        m["scenes"] = [{"file": "scenes/01-title.tsx", "durationMs": 2000}, {"file": "scenes/02-strobe.tsx", "durationMs": 2000}]
        m.pop("audio", None)
        m.update(extra)
        write_json(self.project / "project.json", m)

    def check(self, film: Path, *args: str, code: int = 0) -> Any:
        proc = self.kb(["sync-check", str(film), "--json"] + list(args), cwd=self.project)
        self.assertExit(proc, code)
        return json.loads(proc.stdout)

    def offsets(self, out: Any) -> List[float]:
        return [e["offsetMs"] for e in out["events"]]

    def test_cuts_land_on_the_frame_grid_with_b_frames_and_aac(self) -> None:
        out = self.check(synced_film(self.project / "exports" / "demo-16x9-custom.mp4"))
        self.assertEqual((out["ok"], out["command"], out["posterFrame"], out["clock"]), (True, "sync-check", False, "audio"))
        self.assertEqual(out["grid"]["source"], "authored")
        self.assertEqual([round(o, 1) for o in self.offsets(out)], [0.0, 0.0, 0.0, 0.0, 33.3])
        cut = out["events"][3]
        self.assertEqual((cut["kind"], cut["from"], cut["to"], cut["scene"]["stem"]), ("cut", "01-title", "02-strobe", "02-strobe"))
        s = out["summary"]
        self.assertEqual((s["verdict"], s["medianMs"], s["onBeat"], s["worstScene"]), ("in sync", 0.0, 5, "02-strobe"))
        self.assertEqual([(sc["stem"], sc["events"]) for sc in out["scenes"]], [("01-title", 3), ("02-strobe", 2)])
        text = self.kb(["sync-check", "exports/demo-16x9-custom.mp4"], cwd=self.project)
        self.assertExit(text, 0)
        self.assertIn("in sync: median +0.0 ms, worst +33.3 ms at 2.53s (02-strobe)", text.stdout)
        self.assertIn("cut 01-title -> 02-strobe: +0.0 ms from beat 4", text.stdout)

    def test_a_poster_frame_is_taken_off(self) -> None:
        film = synced_film(self.project / "exports" / "demo-16x9-custom.mp4", poster=True)
        out = self.check(film)
        self.assertTrue(out["posterFrame"])
        self.assertEqual([round(o, 1) for o in self.offsets(out)], [0.0, 0.0, 0.0, 0.0, 33.3])
        naive = self.check(film, "--poster-frame", "off")
        self.assertEqual([round(o, 1) for o in self.offsets(naive)][:4], [33.3] * 4)

    def test_a_delayed_picture_reads_late_through_its_edit_list(self) -> None:
        out = self.check(synced_film(self.project / "exports" / "delayed.mp4", delay_video_s=0.1))
        self.assertEqual(out["starts"]["video"], 100.0)
        s = out["summary"]
        self.assertEqual((s["verdict"], s["medianMs"], s["onBeat"]), ("late", 100.0, 4))
        self.assertTrue(any("beyond the frame grid" in w for w in out["warnings"]))

    def test_bpm_stands_in_for_missing_music(self) -> None:
        self.manifest()
        film = synced_film(self.project / "exports" / "demo-16x9-custom.mp4")
        missing = self.check(film, code=1)
        self.assertEqual((missing["ok"], missing["code"]), (False, "invalid"))
        self.assertIn("--bpm", missing["hint"])
        out = self.check(film, "--bpm", "120", "--offset", "500")
        self.assertEqual(out["grid"]["source"], "bpm")
        self.assertEqual([round(o, 1) for o in self.offsets(out)], [0.0, 0.0, 0.0, 0.0, 33.3])
        self.assertEqual(self.check(film, "--offset", "20", code=2)["code"], "usage")
