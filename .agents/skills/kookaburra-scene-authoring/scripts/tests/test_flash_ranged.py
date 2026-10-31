"""Fast visual checks: ranged flash checks through the render window (spans, chunks, merging, strips), accepted warnings, film strips and kb preview."""

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path
from typing import Any, Dict, List

from kblib.film import accepts as acc
from kblib.film import ranged as rg
from kblib.film import strips as st
from kblib.project import Project
from kblib.util import KbError

from . import video_synth as vs
from .helpers import FakeApp, KbTestCase, make_project

KINDS = ["capture", "check", "fonts", "insertPreset", "mediaChanged", "openEdit", "debug", "range"]
FEATURES = ["scale", "width", "probe", "client", "deadline", "recycle", "debug", "range", "texts"]
TOOLS = vs.tools()
needs_ffmpeg = unittest.skipUnless(TOOLS, "no ffmpeg")


def health() -> Dict[str, Any]:
    return {"version": 1, "captureFeatures": FEATURES, "queue": {"depth": 0, "order": [], "etaMs": [], "inFlight": None},
            "gpu": {"stalled": False, "wedged": False}, "renderWindow": {"alive": True}, "webgl": {}, "clients": []}


def solid_png(path: Path, size: str, colour: str) -> Path:
    assert TOOLS
    subprocess.run([TOOLS[0], "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", f"color=c={colour}:s={size}", "-frames:v", "1", str(path)],
                   check=True, capture_output=True)
    return path


def issue(severity: str, start: int, standard: str = "wcag", **extra: Any) -> Dict[str, Any]:
    return dict({"type": "general", "standard": standard, "severity": severity, "startMs": start, "endMs": start + 1000,
                 "tc": f"00:{start // 1000:02d}.{start % 1000:03d}", "flashesPerSecond": 4.0, "areaPct": 30.0,
                 "region": [0.1, 0.2, 0.3, 0.3], "deltaL": 0.5, "hint": "hold each state"}, **extra)


class SpanTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        # 120 bpm, bar 1 at 200 ms of the film: bar:B lands at 200 + (B - 1) * 2000.
        self.root = make_project(self.tmp, audio={"file": "assets/track.mp3", "startOffsetMs": 50,
                                                 "grid": {"bpm": 120, "offsetMs": 250, "beatsPerBar": 4}, "cues": {"drop": "bar:3"}})
        (self.root / "assets" / "track.mp3").write_bytes(b"audio")
        self.project = Project(self.root)

    def test_times_bars_and_positions(self) -> None:
        self.assertEqual(rg.parse_time("35.4"), 35400)
        self.assertEqual(rg.parse_time("00:35.4"), 35400)
        self.assertEqual(rg.parse_time("1:02"), 62000)
        self.assertIsNone(rg.parse_time("bar:3"))
        self.assertEqual(rg.parse_span("2-4.5", self.project, 9000), {"startMs": 2000, "endMs": 4500, "label": "2-4.5"})
        self.assertEqual(rg.parse_span("bar:2-3", self.project, 9000)["startMs"], 2200)
        self.assertEqual(rg.parse_span("bar:2-3", self.project, 9000)["endMs"], 6200)
        self.assertEqual(rg.parse_span("bar:2..cue:drop", self.project, 9000)["endMs"], 4200)
        self.assertEqual(rg.parse_span("6-20", self.project, 7800)["endMs"], 7800)
        for bad, code in (("soon", 2), ("4-3", 2), ("bar:4-2", 2), ("20-30", 1)):
            with self.assertRaises(KbError) as caught:
                rg.parse_span(bad, self.project, 7800)
            self.assertEqual(caught.exception.code, code, bad)

    def test_scene_spans_chunks_and_merges(self) -> None:
        slots = [{"startMs": 0, "endMs": 3000, "stem": "a"}, {"startMs": 2400, "endMs": 5400, "stem": "b"}, {"startMs": 4800, "endMs": 7800, "stem": "c"}]
        self.assertEqual(rg.scene_span(slots, 1), {"startMs": 1400, "endMs": 6400, "label": "b"})
        self.assertEqual(rg.scene_span(slots, 0)["startMs"], 0)
        self.assertEqual(rg.scene_span(slots, 2)["endMs"], 7800)
        merged = rg.merge_spans([rg.scene_span(slots, 2), rg.scene_span(slots, 0)])
        self.assertEqual([(s["startMs"], s["endMs"]) for s in merged], [(0, 7800)])
        self.assertEqual(rg.chunks({"startMs": 0, "endMs": 150_000}), [(0, 60_000), (59_000, 119_000), (118_000, 150_000)])
        self.assertEqual(rg.chunks({"startMs": 0, "endMs": 4000}), [(0, 4000)])

    def test_issues_merge_across_overlapping_chunks_and_failures_win(self) -> None:
        a = issue("warn", 59_200)
        b = issue("fail", 59_400)
        c = issue("warn", 59_300, standard="itu")
        merged = rg.merge_issues([a, b, c, issue("warn", 80_000)])
        self.assertEqual([(i["severity"], i["standard"], i["startMs"]) for i in merged],
                         [("warn", "itu", 59_300), ("fail", "wcag", 59_400), ("warn", "wcag", 80_000)])


class AcceptTests(KbTestCase):
    def report(self) -> Dict[str, Any]:
        return {"issues": [dict(issue("warn", 3500), projectMs=3500, scene={"index": 1, "stem": "02-hero", "localMs": 1100}),
                           dict(issue("fail", 6000), projectMs=6000, scene={"index": 2, "stem": "03-outro", "localMs": 1200})]}

    def test_a_warning_is_stored_with_its_reason_and_a_failure_never(self) -> None:
        rows = acc.new_entries(self.report(), 3600, "a soft glint", "agent", "range")
        self.assertEqual((rows[0]["scene"], rows[0]["localMs"], rows[0]["why"]), ("02-hero", 1100, "a soft glint"))
        for ms, needle in ((6100, "never be accepted"), (9000, "no flash warning")):
            with self.assertRaises(KbError) as caught:
                acc.new_entries(self.report(), ms, "fine", "agent", "range")
            self.assertEqual(caught.exception.code, 1)
            self.assertIn(needle, caught.exception.message)
        with self.assertRaises(KbError):
            acc.new_entries(self.report(), 3600, "  ", "agent", "range")

    def test_later_checks_match_by_scene_and_never_mark_failures(self) -> None:
        rows = acc.new_entries(self.report(), 3600, "a soft glint", "agent", "range")
        later = self.report()
        later["issues"][0]["scene"]["localMs"] = 1500
        later["issues"][0]["projectMs"] = 9999
        fail = dict(later["issues"][0], severity="fail")
        later["issues"].append(fail)
        self.assertEqual(acc.apply(later, rows), 1)
        self.assertEqual(later["issues"][0]["accepted"]["why"], "a soft glint")
        self.assertNotIn("accepted", fail)
        moved = self.report()
        moved["issues"][0]["scene"]["localMs"] = 2500
        self.assertEqual(acc.apply(moved, rows), 0)
        doc = acc.merged(None, rows)
        self.assertEqual(acc.merged(doc, rows)["accepted"], rows)
        self.assertEqual(acc.without(doc, [rows[0]["id"]]), {"version": 1, "accepted": []})
        self.assertIsNone(acc.without(doc, ["nope"]))

    def test_a_saved_report_loses_the_mark_of_a_forgotten_warning(self) -> None:
        rows = acc.new_entries(self.report(), 3600, "a soft glint", "agent", "range")
        saved = self.report()
        acc.apply(saved, rows)
        self.assertIn("accepted", saved["issues"][0])
        self.assertEqual(acc.apply(saved, []), 0)
        self.assertNotIn("accepted", saved["issues"][0])


class StripTests(KbTestCase):
    def test_the_box_never_vanishes_and_stays_in_frame(self) -> None:
        self.assertIsNone(st.box_filter([0, 0, 0, 0]))
        self.assertIsNone(st.box_filter(None))
        self.assertIn("w=iw*0.0200", st.box_filter([0.99, 0.5, 0.001, 0.1]) or "")
        self.assertIn("x=iw*0.9800", st.box_filter([0.99, 0.5, 0.001, 0.1]) or "")
        self.assertEqual(st.strip_name(1, 35233), "strip-01-00m35.233s.png")
        self.assertEqual(st.strip_name(12, 61_005), "strip-12-01m01.005s.png")

    @needs_ffmpeg
    def test_three_frames_compose_side_by_side_with_the_region_boxed(self) -> None:
        pngs = [solid_png(self.tmp / f"{n}.png", "640x360", c) for n, c in enumerate(("black", "white", "black"))]
        out = st.compose(TOOLS[0], pngs, [0.25, 0.25, 0.5, 0.5], self.tmp / "strip.png")
        probe = subprocess.run([TOOLS[1], "-v", "error", "-show_entries", "stream=width,height", "-of", "json", str(out)],
                               capture_output=True, text=True, check=True)
        size = json.loads(probe.stdout)["streams"][0]
        self.assertEqual((size["width"], size["height"]), (640 * 3 + 2 * st.GAP_PX, 360))

    @needs_ffmpeg
    def test_a_films_flagged_moments_get_strips_beside_it(self) -> None:
        film = self.tmp / "exports" / "demo-16x9.mp4"
        film.parent.mkdir()
        graph = "color=c=black:s=128x72:r=30:d=2[a];color=c=white:s=128x72:r=30:d=2[b];[a][b]overlay=enable='gte(mod(n\\,8)\\,4)',format=yuv420p[out]"
        subprocess.run([TOOLS[0], "-v", "error", "-y", "-filter_complex", graph, "-map", "[out]", "-c:v", "libx264", "-preset", "ultrafast", str(film)],
                       check=True, capture_output=True)
        folder = film.with_name(film.name + ".flashes")
        folder.mkdir()
        (folder / "strip-09-00m00.000s.png").write_bytes(b"stale")
        report = {"frames": 60, "issues": [issue("fail", 400), issue("warn", 1200)]}
        rows = st.film_strips(TOOLS[0], film, report, folder, 30.0)
        st.attach(report, rows)
        self.assertEqual([Path(r["path"]).name for r in rows], ["strip-01-00m00.400s.png", "strip-02-00m01.200s.png"])
        self.assertEqual([f["frame"] for f in rows[0]["frames"]], [11, 12, 13])
        self.assertFalse((folder / "strip-09-00m00.000s.png").exists())
        self.assertEqual(report["issues"][0]["strip"], rows[0]["path"])


class RangedCommandTests(KbTestCase):
    def app(self, issues: List[Dict[str, Any]], frames_dir: Path, clip: bool = False) -> FakeApp:
        def handler(req: Dict[str, Any]) -> Dict[str, Any]:
            n = int((req["endMs"] - req["startMs"]) * req["fps"] / 1000)
            first = int(req["startMs"] * req["fps"] / 1000)
            shifted = [dict(i, startMs=i["startMs"], endMs=i["endMs"]) for i in issues if req["startMs"] <= i["startMs"] < req["endMs"]]
            strips = []
            for k, i in enumerate(shifted):
                at = round(i["startMs"] * req["fps"] / 1000)
                rows = []
                for role, frame in zip(st.ROLES, (at - 1, at, at + 1)):
                    path = frames_dir / f"{req['id']}-{frame}.png"
                    if not path.exists():
                        solid_png(path, "640x360", "white" if role == "at" else "black")
                    rows.append({"role": role, "frame": frame, "tMs": round(frame * 1000 / req["fps"]), "path": str(path)})
                strips.append({"issue": k, "frames": rows})
            out = {"ok": True, "format": req.get("aspect") or "16:9", "size": {"width": 640, "height": 360}, "fps": req["fps"],
                   "startMs": req["startMs"], "endMs": req["endMs"], "firstFrame": first, "frames": n, "strips": strips,
                   "timing": {"renderMs": 900}}
            if req.get("flashes"):
                out["flashes"] = {"version": 1, "standards": ["wcag-2.3.1"], "grid": [64, 36], "fps": req["fps"], "frames": n,
                                  "ok": not any(i["severity"] == "fail" for i in shifted), "issues": shifted, "source": "range"}
            if req.get("clip"):
                paths = []
                for k in range(n):
                    path = frames_dir / f"{req['id']}-clip-{k}.png"
                    solid_png(path, "480x270", "gray")
                    paths.append(str(path))
                out["clip"] = {"paths": paths, "fps": req["fps"]}
            return out

        return FakeApp(self.bridge, handler, kinds=KINDS, health=health(), openProject="ws:demo")

    @needs_ffmpeg
    def test_a_scene_check_renders_its_span_and_strips_each_flagged_moment(self) -> None:
        root = make_project(self.tmp)
        frames = self.tmp / "frames"
        frames.mkdir()
        with self.app([issue("fail", 3000)], frames) as app:
            proc = self.kb(["check", "film", "--scene", "02-hero", "--json"], cwd=root, env={"KB_FFMPEG": TOOLS[0], "KB_FFPROBE": TOOLS[1]})
        self.assertExit(proc, 1)
        out = json.loads(proc.stdout)
        self.assertEqual(out["code"], "flashes")
        (req,) = app.requests
        self.assertEqual((req["kind"], req["startMs"], req["endMs"], req["fps"]), ("range", 1400, 6400, 30))
        report = out["flashes"]
        self.assertEqual(report["source"], "range")
        self.assertEqual(report["issues"][0]["scene"]["stem"], "02-hero")
        strip = Path(report["issues"][0]["strip"])
        self.assertTrue(strip.is_file() and strip.parent.parent == root / ".kb" / "flashes", strip)
        self.assertTrue((strip.parent / "flashes.json").is_file())
        last = json.loads((root / ".kb" / "flashes" / "last.json").read_text(encoding="utf-8"))
        self.assertEqual(last["source"], "range")
        with self.app([issue("fail", 3000)], frames):
            allowed = self.kb(["check", "film", "--range", "2-4", "--allow-flashes"], cwd=root, env={"KB_FFMPEG": TOOLS[0], "KB_FFPROBE": TOOLS[1]})
        self.assertExit(allowed, 0)
        self.assertIn("Read ", allowed.stdout)

    def test_a_check_with_no_answer_leaves_no_run_behind(self) -> None:
        root = make_project(self.tmp)
        refused = FakeApp(self.bridge, lambda req: {"ok": False, "error": "the render failed"}, kinds=KINDS, health=health(), openProject="ws:demo")
        with refused:
            proc = self.kb(["check", "film", "--range", "2-4"], cwd=root)
        self.assertExit(proc, 1)
        self.assertEqual([p for p in (root / ".kb" / "flashes").iterdir() if p.is_dir()], [])

    def test_no_app_and_an_old_app_exit_2(self) -> None:
        root = make_project(self.tmp)
        self.assertExit(self.kb(["check", "film", "--scene", "0"], cwd=root), 2)
        old = FakeApp(self.bridge, lambda req: {"ok": True}, kinds=KINDS[:-1], health=health(), openProject="ws:demo")
        with old:
            proc = self.kb(["check", "film", "--scene", "0"], cwd=root)
        self.assertExit(proc, 2)
        self.assertIn("update Kookaburra Cut", proc.stderr)

    @needs_ffmpeg
    def test_preview_encodes_the_span_and_a_sheet(self) -> None:
        root = make_project(self.tmp)
        frames = self.tmp / "frames"
        frames.mkdir()
        env = {"KB_FFMPEG": TOOLS[0], "KB_FFPROBE": TOOLS[1]}
        with self.app([], frames) as app:
            proc = self.kb(["preview", "--range", "1-2", "--json"], cwd=root, env=env)
            gif = self.kb(["preview", "--scene", "02-hero", "--gif", "--fps", "4", "--json"], cwd=root, env=env)
        self.assertExit(proc, 0)
        out = json.loads(proc.stdout)
        self.assertTrue(out["path"].endswith(".mp4") and Path(out["path"]).is_file())
        self.assertTrue(out["sheets"] and Path(out["sheets"][0]).is_file())
        self.assertEqual(out["frames"], 12)
        req = app.requests[0]
        self.assertEqual((req["clip"], req["flashes"], req["fps"], req["width"]), (True, False, 12, 480))
        self.assertExit(gif, 0)
        self.assertTrue(json.loads(gif.stdout)["path"].endswith(".gif"))
        self.assertExit(self.kb(["preview", "--range", "1-2", "--fps", "60"], cwd=root), 2)
        self.assertExit(self.kb(["preview"], cwd=root), 2)
