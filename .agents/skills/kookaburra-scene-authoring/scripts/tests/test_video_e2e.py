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
        self.assertEqual(self.json("list")[0]["render"]["state"], "fresh")
