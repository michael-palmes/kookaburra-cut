"""Opt-in end to end run against the app's real edit CLI: KB_E2E_APP_BIN=<.../kookaburra-cut> pnpm test:kit:e2e."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
from typing import Any, Dict

from .helpers import KbTestCase, make_project, read_json, write_json

APP_BIN = os.environ.get("KB_E2E_APP_BIN")


@unittest.skipUnless(APP_BIN, "set KB_E2E_APP_BIN to the app's binary to run the real CLI end to end (pnpm test:kit:e2e)")
class VideoEndToEndTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.env["KB_APP_BIN"] = str(APP_BIN)
        os.environ["KB_APP_BIN"] = str(APP_BIN)
        self.root = make_project(self.tmp)
        caps = self.json("caps")["caps"]
        self.ffmpeg = (caps.get("ffmpeg") or {}).get("path") or shutil.which("ffmpeg")
        self.ffprobe = (caps.get("ffprobe") or {}).get("path") or shutil.which("ffprobe")
        subprocess.run(
            [self.ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-t", "6", "-pix_fmt", "yuv420p", str(self.root / "assets" / "rec.mp4")],
            check=True,
        )
        write_json(self.root / "scenes" / "02-hero.json", {
            "version": 1, "name": "Hero", "duration": {"mode": "follow-media"},
            "devices": [{"id": "phone", "model": "iphone-17-pro", "media": {"src": "assets/rec.mp4", "kind": "video"}}],
        })

    def video(self, *args: str) -> subprocess.CompletedProcess:
        proc = self.kb(["video", *args], cwd=self.root)
        self.assertExit(proc, 0)
        return proc

    def json(self, *args: str) -> Any:
        proc = self.kb(["video", *args, "--json"], cwd=self.root)
        self.assertExit(proc, 0)
        return json.loads(proc.stdout)

    def test_edit_render_and_use(self) -> None:
        self.video("new", "assets/rec.mp4")
        self.video("split", "rec", "--at", "2")
        self.video("speed", "rec", "c2", "2")
        self.video("freeze", "rec", "--at", "end", "--hold", "1")
        self.video("tap", "add", "rec", "--at", "1", "--pos", "0.5,0.5")
        self.video("mask", "add", "rec", "--at", "0.5", "--rect", "0.1,0.1,0.3,0.2", "--until", "1.5")
        report = self.json("validate", "rec")
        self.assertTrue(report["ok"], report)
        timeline = self.json("show", "rec")["timeline"]
        self.assertEqual(timeline["durationMs"], 2000 + 2000 + 1000)
        out = self.json("render", "rec", "--use", "--scene", "02-hero")
        self.assertEqual(out["done"]["frames"], report["app"]["totalFrames"])
        rendered = self.root / "assets" / "rec-edited.mp4"
        probe = subprocess.run([self.ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(rendered)], capture_output=True, text=True, check=True)
        seconds = float(json.loads(probe.stdout)["format"]["duration"])
        self.assertLessEqual(abs(seconds * 1000 - timeline["durationMs"]), 1000 / timeline["fps"] + 1)
        doc: Dict[str, Any] = read_json(self.root / "scenes" / "02-hero.json")
        self.assertEqual(doc["devices"][0]["media"]["src"], "assets/rec-edited.mp4")
        self.assertEqual(read_json(self.root / "edits" / ".renders" / "rec.json")["output"], "assets/rec-edited.mp4")
        self.assertEqual(self.json("list")["edits"][0]["render"]["state"], "fresh")

    def test_fades_crop_zoom_and_scene_time(self) -> None:
        caps = self.json("caps")["caps"]
        if not ((caps.get("mask") or {}).get("fades") and caps.get("crop") and caps.get("zoom")):
            self.skipTest("this app's edit CLI predates mask fades, crop and zoom")
        sidecar = read_json(self.root / "scenes" / "02-hero.json")
        sidecar["devices"][0]["media"].update({"startMs": 500, "speed": 2})
        write_json(self.root / "scenes" / "02-hero.json", sidecar)
        self.video("new", "assets/rec.mp4")
        self.video("mask", "add", "rec", "--at", "0.5", "--rect", "0.1,0.1,0.3,0.2", "--until", "3", "--fade-in", "0.25", "--fade-out", "0.5")
        self.video("mask", "set", "rec", "m1", "--until-scene", "1.5", "--scene", "02-hero", "--slot", "device:phone")
        self.video("crop", "rec", "c1", "--aspect", "9:16")
        report = self.json("validate", "rec")
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["app"]["version"], 3)
        doc = read_json(self.root / "edits" / "rec.json")
        self.assertEqual(doc["version"], 3)
        self.assertEqual((doc["masks"][0]["endMs"], doc["masks"][0]["fadeInMs"], doc["masks"][0]["fadeOutMs"]), ((1500 - 500) * 2, 250, 500))
        self.assertEqual(len(doc["clips"][0]["crop"]), 4)
        self.video("zoom", "rec", "c1", "--at", "1", "--rect", "0.2,0.2,0.5,0.5")
        self.video("zoom", "rec", "c1", "--at", "4", "--rect", "0,0,1,1", "--ease", "linear")
        self.video("split", "rec", "--at", "2")
        doc = read_json(self.root / "edits" / "rec.json")
        self.assertNotIn("crop", doc["clips"][0])
        self.assertEqual([k.get("ease") for k in doc["clips"][0]["zoom"]["keys"]][0], "smooth")
        report = self.json("validate", "rec")
        self.assertTrue(report["ok"], report)
        out = self.json("render", "rec", "--use", "--scene", "02-hero")
        self.assertEqual(out["done"]["frames"], report["app"]["totalFrames"])
        media = read_json(self.root / "scenes" / "02-hero.json")["devices"][0]["media"]
        self.assertEqual(media, {"src": "assets/rec-edited.mp4", "kind": "video", "startMs": 500})

    def test_footage_log_checks_the_decode_with_the_media_probe(self) -> None:
        caps = self.json("caps")["caps"]
        if "probe" not in ((caps.get("media") or {}).get("commands") or []):
            self.skipTest("this app's CLI predates media probe")
        clean = self.json("log", "assets/rec.mp4")
        self.assertEqual(clean["decode"]["verdict"], "ok")
        self.assertTrue(clean["holds"] or clean["changes"])
        # A held barcode clip, one frame per change, then a stream-copy trim whose edit list opens inside a held frame.
        work = self.tmp / "misdecode"
        work.mkdir()
        value = "if(lt(N,30),N,if(lt(N,90),29,if(lt(N,150),N,if(lt(N,210),149,N))))"
        graph = (f"color=c=gray:s=320x240:r=60:d=4,format=yuv420p,"
                 f"geq=lum='if(lt(Y,32),if(mod(floor(({value})/pow(2,floor(X/(W/16)))),2),235,16),lum(X,Y))':cb=128:cr=128")
        run = lambda *args: subprocess.run([self.ffmpeg, "-v", "error", "-y", *args], check=True)  # noqa: E731
        run("-f", "lavfi", "-i", graph, "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", str(work / "held.mp4"))
        run("-i", str(work / "held.mp4"), "-vf", "mpdecimate=hi=1:lo=1:frac=0:max=0", "-fps_mode", "vfr", "-c:v", "libx264", "-qp", "0",
            "-pix_fmt", "yuv420p", str(work / "vfr.mov"))
        run("-ss", "0.55", "-i", str(work / "vfr.mov"), "-c", "copy", str(self.root / "assets" / "trim.mov"))
        proc = self.kb(["video", "log", "assets/trim.mov", "--json"], cwd=self.root)
        self.assertExit(proc, 1)
        refused = json.loads(proc.stdout)
        self.assertEqual((refused["code"], refused["hint"], refused["decode"]["verdict"]), ("invalid", "./kb assets conform trim.mov", "ffmpeg-misdecodes"))
        allowed = self.json("log", "assets/trim.mov", "--allow-misdecode")
        self.assertEqual(allowed["decode"]["verdict"], "ffmpeg-misdecodes")
