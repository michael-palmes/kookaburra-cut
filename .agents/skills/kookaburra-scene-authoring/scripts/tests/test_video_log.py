"""kb video log and pair through kb, on short clips made with the app's ffmpeg at test time (skipped without one)."""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from kblib.video import footage_commands as fc
from kblib.video import labels
from kblib.video import sheetlayout as sl

from . import video_synth as vs
from .helpers import KbTestCase, make_project, read_json, write, write_json

TOOLS = vs.tools()
needs_ffmpeg = unittest.skipUnless(TOOLS, "no ffmpeg with the analysis filters")

# 10 s at 60 fps, 360x784: screen A, a cut to a tall page at 1 s, the page scrolls up at 600 px/s from 2.5 s to 5.5 s,
# a tap box shows at 7 s and a green screen replaces everything at 7.25 s.
STORY = ";".join([
    "color=c=0xE8E8ED:s=360x784:r=60:d=10[base]",
    "testsrc2=s=360x2400:r=60:d=1,trim=end_frame=1,loop=loop=-1:size=1,setpts=N/60/TB,trim=duration=10[page]",
    "[base]drawbox=x=0:y=0:w=360:h=90:c=0x3A7BD5:t=fill[a]",
    "[a][page]overlay=x=0:y='if(lt(t\\,2.5)\\,0\\,if(lt(t\\,5.5)\\,-(t-2.5)*600\\,-1800))':enable='gte(t\\,1)'[s1]",
    "[s1]drawbox=x=150:y=300:w=40:h=40:c=0x8E8E93:t=fill:enable='between(t\\,7\\,7.2)'[s2]",
    "[s2]drawbox=x=0:y=0:w=360:h=784:c=0x34C759:t=fill:enable='gte(t\\,7.25)',format=yuv420p[out]",
])
HOLDS = [(0, 1000), (1000, 2517), (5500, 7000), (7250, 10000)]
NOTES = "# take one\n- 0:00.0 app opens\n1.2 starts scrolling\n- 5.5s taps the box\n6.0 a new screen\nno time on this line\n"


def story() -> Path:
    ff, _ = TOOLS  # type: ignore[misc]
    return vs._built("footage-story", "mp4", [ff, "-v", "error", "-y", "-filter_complex", STORY, "-map", "[out]", "-c:v", "libx264",
                                              "-preset", "veryfast", "-crf", "16", "-g", "120", "-bf", "0"])


def second_take() -> Path:
    """The story 0.15 s in, brighter, more saturated, with a bar painted across it."""
    ff, _ = TOOLS  # type: ignore[misc]
    vf = "trim=start=0.15,setpts=PTS-STARTPTS,eq=brightness=0.06:saturation=1.3,drawbox=x=0:y=700:w=360:h=40:c=0xFF3B30:t=fill,format=yuv420p"
    return vs._built("footage-take2", "mp4", [ff, "-v", "error", "-y", "-i", str(story()), "-vf", vf, "-c:v", "libx264", "-preset", "veryfast",
                                              "-crf", "16", "-g", "120", "-bf", "0"])


def setUpModule() -> None:
    if TOOLS:
        second_take()


class Info:
    def __init__(self, path: str) -> None:
        self.path = path


class NamingTests(unittest.TestCase):
    def test_names_and_timing_records(self) -> None:
        self.assertEqual(fc.footage_key("assets/rec.mov"), "rec")
        self.assertEqual(fc.footage_key("assets/flows/sign up.mp4"), "flows--sign-up")
        self.assertEqual(fc.timing_rel("assets/rec.mp4"), "assets/rec.timing.json")
        self.assertEqual(fc.timing_rel("assets/a.b.mov"), "assets/a.b.timing.json")

    def test_cell_origins_follow_the_tile_layout(self) -> None:
        lay = sl.layout_one(5, 9 / 16)
        x, y = fc.cell_origin(lay, lay["cols"] + 1)
        self.assertEqual(x, sl.MARGIN + lay["cellW"] + sl.PADDING)
        self.assertEqual(y, sl.MARGIN + lay["cellH"] + sl.BAR + sl.PADDING + sl.BAR)
        self.assertEqual(fc.cell_label(dict(lay, cellW=60), "mf12", 62250), "1:02.25")


@needs_ffmpeg
class LogCommandTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        shutil.copyfile(story(), self.root / "assets" / "rec.mp4")
        ff, fp = TOOLS  # type: ignore[misc]
        self.env.update({"KB_FFMPEG": ff, "KB_FFPROBE": fp})
        self._saved = {k: os.environ.get(k) for k in ("KB_FFMPEG", "KB_FFPROBE")}
        os.environ["KB_FFMPEG"], os.environ["KB_FFPROBE"] = ff, fp

    def tearDown(self) -> None:
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        super().tearDown()

    def json(self, *args: str, code: int = 0) -> Dict[str, Any]:
        proc = self.kb(["video", *args, "--json"], cwd=self.root)
        self.assertExit(proc, code)
        return json.loads(proc.stdout)

    def inproc(self, *args: str) -> Tuple[int, Dict[str, Any]]:
        """kb in this process, so a test can stand in for the app's media probe."""
        from kblib import cli

        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            code = cli.main(["video", *args, "--json", "-C", str(self.root)])
        return code, json.loads(out.getvalue())

    def pixels(self, png: Path, x: int, y: int, w: int, h: int) -> List[Tuple[int, int, int]]:
        ff, _ = TOOLS  # type: ignore[misc]
        raw = subprocess.run([ff, "-v", "error", "-i", str(png), "-vf", f"crop={w}:{h}:{x}:{y}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                             capture_output=True, check=True).stdout
        return [tuple(raw[i:i + 3]) for i in range(0, len(raw), 3)]  # type: ignore[misc]

    def test_holds_scroll_money_frames_and_the_cache(self) -> None:
        d = self.json("log", "assets/rec.mp4")
        self.assertEqual((d["command"], d["file"], d["frames"], d["durationMs"], d["profile"]), ("video log", "assets/rec.mp4", 600, 10000, "screen"))
        self.assertEqual([(h["startMs"], h["endMs"]) for h in d["holds"]], HOLDS)
        scroll = d["scrolls"][0]
        self.assertEqual((scroll["startMs"], scroll["endMs"], scroll["direction"]), (2517, 5517, "up"))
        self.assertLess(abs(scroll["pxPerS"] - 600) / 600, 0.05)
        kinds = {c["kind"] for c in d["changes"]}
        self.assertTrue({"screen", "scroll", "tap"} <= kinds, d["changes"])
        self.assertEqual([m["atMs"] for m in d["moneyFrames"]], [1500, 6000, 7750])
        self.assertEqual((d["decode"]["verdict"], d["decode"]["via"]), ("ok", "kb"))
        self.assertNotIn("app", d["decode"]["checks"])
        self.assertTrue(any("boxes only" in n for n in d["notesForAgent"]))
        log = self.root / ".kb" / "footage" / "rec.json"
        self.assertEqual(d["log"], str(log))
        self.assertEqual(read_json(log)["holds"], d["holds"])
        self.assertEqual(d["writes"], [{"path": ".kb/footage/rec.json", "action": "create", "base": "absent"}])
        cache = self.bridge / "video" / "demo" / "analysis"
        parts = sorted(p.name.split("-p1-")[1].split(".", 1)[1] for p in cache.glob("*-p1-*"))
        self.assertEqual(parts, ["json", "rows.z", "small.z"])
        stamps = {p.name: p.stat().st_mtime_ns for p in cache.glob("*-p1-*")}
        again = self.json("log", "assets/rec.mp4")
        self.assertEqual(again["writes"], [])
        self.assertEqual(self.json("log", "rec.mp4", "--dry-run")["holds"], d["holds"])
        self.assertEqual({p.name: p.stat().st_mtime_ns for p in cache.glob("*-p1-*")}, stamps)

    def test_notes_align_and_the_sheet_is_stamped(self) -> None:
        write(self.root / "notes.md", NOTES)
        d = self.json("log", "assets/rec.mp4", "--notes", "notes.md", "--sheet")
        items = d["notes"]["items"]
        self.assertEqual(d["notes"]["file"], "notes.md")
        self.assertEqual([it["changeMs"] for it in items], [1000, 2517, 7000, 7217])
        self.assertEqual(d["notes"]["skippedLines"], [6])
        self.assertTrue(1000 <= d["notes"]["medianOffsetMs"] <= 1500)
        sheet = self.root / ".kb" / "footage" / "rec" / "money-1.png"
        self.assertEqual(d["sheets"], [str(sheet)])
        self.assertEqual([c["id"] for c in d["sheetCells"]], ["mf1", "mf2", "mf3"])
        lay = sl.plan_sheets(3, 360 / 784)[0]
        x, y = fc.cell_origin(lay, 0)
        scale = fc.label_scale(lay)
        w, h = labels.text_size(fc.cell_label(lay, "mf1", 1500), scale)
        box = self.pixels(sheet, x + fc.LABEL_INSET, y + fc.LABEL_INSET, w, h)
        self.assertTrue(any(min(p) > 230 for p in box), "white glyphs")
        self.assertGreater(sum(1 for p in box if max(p) < 90), len(box) // 2, "a dark backing")

    def test_dry_run_range_money_and_usage(self) -> None:
        d = self.json("log", "assets/rec.mp4", "--dry-run", "--range", "0.5-8", "--money", "1", "--sheet")
        self.assertTrue(d["dryRun"])
        self.assertEqual(d["range"], [500, 8000])
        self.assertEqual([m["atMs"] for m in d["moneyFrames"]], [7750])
        self.assertEqual({w["action"] for w in d["writes"]}, {"create"})
        self.assertFalse((self.root / ".kb" / "footage").exists())
        self.assertTrue(Path(d["sheets"][0]).is_file())
        self.assertEqual(self.json("log", "assets/rec.mp4", "--money", "0", code=2)["code"], "usage")
        self.assertEqual(self.json("log", "nope.mov", code=2)["ok"], False)
        self.assertEqual(self.json("log", "rec.mp4", "--notes", "missing.md", code=2)["code"], "usage")

    def test_a_sheet_from_an_earlier_run_goes_to_the_trash(self) -> None:
        stale = self.root / ".kb" / "footage" / "rec" / "money-2.png"
        self.json("log", "assets/rec.mp4", "--sheet")
        stale.write_bytes(b"old")
        other = self.root / ".kb" / "footage" / "rec" / "notes.png"
        other.write_bytes(b"mine")
        d = self.json("log", "assets/rec.mp4", "--sheet")
        self.assertIn({"path": ".kb/footage/rec/money-2.png", "action": "trash", "base": fc.lockmod.sha256_hex(b"old")}, d["writes"])
        self.assertFalse(stale.exists())
        self.assertTrue(other.exists())
        self.assertEqual([p.name for p in self.trash.iterdir()], ["money-2.png"])

    def test_an_original_logs_its_conformed_file_and_an_edit_its_source(self) -> None:
        (self.root / "assets" / ".originals").mkdir()
        shutil.copyfile(story(), self.root / "assets" / ".originals" / "rec.mov")
        write_json(self.root / "assets" / "rec.timing.json", {"version": 1, "kind": "conform", "source": {"original": "assets/.originals/rec.mov"},
                                                             "mezzanine": {"path": "assets/rec.mp4", "fps": 60}})
        d = self.json("log", "assets/.originals/rec.mov")
        self.assertEqual((d["file"], d["mezzanine"], d["original"], d["decode"]), ("assets/rec.mp4", "assets/rec.mp4", "assets/.originals/rec.mov", None))
        self.assertTrue(any("original of assets/rec.mp4" in n for n in d["notesForAgent"]))
        write_json(self.root / "edits" / "demo-cut.json", {
            "version": 1, "name": "demo-cut", "settings": {"width": 360, "height": 784, "fps": 60},
            "sources": [{"id": "s1", "rel": "assets/rec.mp4", "kind": "video", "width": 360, "height": 784, "fps": 60, "durationMs": 10000}],
            "clips": [{"id": "c1", "sourceId": "s1", "inMs": 0, "outMs": 10000, "speed": 1, "startMs": 0}], "taps": [], "masks": []})
        self.assertEqual(self.json("log", "demo-cut")["file"], "assets/rec.mp4")

    def test_a_misdecoding_file_is_refused_unless_allowed(self) -> None:
        verdict = {"verdict": "ffmpeg-misdecodes", "reasons": ["edit-list", "count-mismatch"], "deep": True, "via": "app-media-1"}
        saved = fc.decode_verdict
        fc.decode_verdict = lambda project, path, refresh=False: dict(verdict)  # type: ignore[assignment]
        try:
            code, out = self.inproc("log", "assets/rec.mp4")
            self.assertEqual(code, 1)
            self.assertEqual((out["ok"], out["code"], out["hint"]), (False, "invalid", "./kb assets conform rec.mp4"))
            self.assertEqual(out["decode"]["verdict"], "ffmpeg-misdecodes")
            self.assertFalse((self.root / ".kb" / "footage").exists())
            code, out = self.inproc("log", "assets/rec.mp4", "--allow-misdecode")
            self.assertEqual(code, 0)
            self.assertEqual(out["decode"], verdict)
        finally:
            fc.decode_verdict = saved  # type: ignore[assignment]

    def test_the_verdict_decodes_only_when_unsure_and_is_cached(self) -> None:
        calls: List[bool] = []

        def probe(path: str, file: Path, deep: bool) -> Optional[Dict[str, Any]]:
            calls.append(deep)
            return {"verdict": "ffmpeg-misdecodes" if deep else "suspect", "reasons": ["edit-list"] + (["span-mismatch"] if deep else [])}

        saved = (fc._media_cli, fc.media_probe, fc._kit_verdict)
        fc._media_cli, fc.media_probe, fc._kit_verdict = (lambda: (Info("/x/kookaburra-cut"), 1)), probe, (lambda path: None)  # type: ignore[assignment]
        try:
            from kblib.project import Project

            project = Project(self.root)
            path = self.root / "assets" / "rec.mp4"
            first = fc.decode_verdict(project, path)
            self.assertEqual(first, {"verdict": "ffmpeg-misdecodes", "reasons": ["edit-list", "span-mismatch"], "deep": True, "via": "app-media-1"})
            self.assertEqual(fc.decode_verdict(project, path), first)
            self.assertEqual(calls, [False, True])
            fc.decode_verdict(project, path, refresh=True)
            self.assertEqual(calls, [False, True, False, True])
        finally:
            fc._media_cli, fc.media_probe, fc._kit_verdict = saved  # type: ignore[assignment]

    def test_an_app_without_the_media_cli_is_never_asked(self) -> None:
        log = self.tmp / "argv.jsonl"
        self.fake_cli(log=log)
        d = self.json("log", "assets/rec.mp4")
        self.assertEqual(d["decode"]["via"], "kb")
        argvs = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertTrue(argvs)
        self.assertFalse([a for a in argvs if a[:1] == ["media"]], argvs)

    def test_media_probe_reads_the_cli_answer(self) -> None:
        good = self.tmp / "media-ok"
        write(good, '#!/bin/sh\necho \'{"ok": true, "verdict": "ok", "reasons": []}\'\n')
        bad = self.tmp / "media-bad"
        write(bad, '#!/bin/sh\necho \'{"ok": false, "code": "invalid", "error": "no"}\'\nexit 1\n')
        for p in (good, bad):
            p.chmod(0o755)
        self.assertEqual(fc.media_probe(str(good), self.root / "assets" / "rec.mp4", deep=False)["verdict"], "ok")
        self.assertIsNone(fc.media_probe(str(bad), self.root / "assets" / "rec.mp4", deep=False))
        self.assertIsNone(fc.media_probe(str(self.tmp / "absent"), self.root / "assets" / "rec.mp4", deep=True))

    def test_pair_finds_the_offset_on_every_state(self) -> None:
        shutil.copyfile(second_take(), self.root / "assets" / "take2.mp4")
        d = self.json("pair", "assets/rec.mp4", "assets/take2.mp4")
        self.assertEqual(len(d["pairs"]), 4)
        self.assertEqual([p["startOffsetMs"] for p in d["pairs"]], [None, -150, -150, -150])
        self.assertEqual([p["endOffsetMs"] for p in d["pairs"]], [-150, -150, -150, None])
        self.assertEqual((d["medianOffsetMs"], d["driftMsPerS"], d["unmatchedA"], d["unmatchedB"]), (-150, 0.0, [], []))
        sheet = self.root / ".kb" / "footage" / "pairs" / "rec--take2-1.png"
        self.assertEqual((d["sheet"], d["sheets"]), (str(sheet), [str(sheet)]))
        self.assertTrue(sheet.is_file())
        self.assertEqual(read_json(self.root / ".kb" / "footage" / "pairs" / "rec--take2.json")["pairs"], d["pairs"])
        bare = self.json("pair", "assets/rec.mp4", "assets/take2.mp4", "--no-sheet", "--dry-run")
        self.assertIsNone(bare["sheet"])
        self.assertTrue(sheet.is_file())

    def test_text_output(self) -> None:
        write(self.root / "notes.md", NOTES)
        proc = self.kb(["video", "log", "assets/rec.mp4", "--notes", "notes.md"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("4 holds, 4 changes (1 scroll), 3 money frames", proc.stdout)
        self.assertIn("sc1      2.52-5.52    up   ", proc.stdout)
        self.assertIn("skipped lines without a time: 6", proc.stdout)
        self.assertTrue(proc.stdout.rstrip().splitlines()[-1].startswith("next: ./kb video log"))
        help_text = self.kb(["video", "--help"], cwd=self.root).stdout
        self.assertIn("log NAME|SRC", help_text)


if __name__ == "__main__":
    unittest.main()
