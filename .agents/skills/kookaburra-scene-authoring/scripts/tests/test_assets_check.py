"""kb check's asset rules: a scene video ffmpeg misdecodes (warning) and a stale provenance record (info)."""

from __future__ import annotations

import json
from typing import Any, Dict, List

from . import mp4synth as ms
from .helpers import write_json
from .test_assets import AssetsCase


class CheckRuleTests(AssetsCase):
    def setUp(self) -> None:
        super().setUp()
        ms.write(self.root / "assets" / "trim.mov", ms.movie(**ms.MID_SAMPLE))
        ms.write(self.root / "assets" / "clean.mp4", ms.movie(**ms.CLEAN))
        self.sidecar("02-hero", {"name": "Hero", "devices": [
            {"id": "a", "model": "android", "media": {"src": "assets/trim.mov", "kind": "video"}},
            {"id": "b", "model": "android", "media": {"src": "assets/clean.mp4", "kind": "video"}}]})

    def issues(self, *args: str) -> List[Dict[str, Any]]:
        proc = self.kb(["check", *args, "--json"], cwd=self.root)
        self.assertExit(proc, 0)
        return json.loads(proc.stdout)["issues"]

    def test_a_scene_video_ffmpeg_misdecodes_warns(self) -> None:
        found = [i for i in self.issues() if "decoded wrong" in i["message"]]
        self.assertEqual([(i["severity"], i["file"], i["path"]) for i in found], [("warning", "scenes/02-hero.json", "devices[0].media.src")])
        self.assertIn("./kb assets conform assets/trim.mov", found[0]["message"])
        self.assertFalse([i for i in self.issues("scenes/02-hero.json") if "decoded wrong" in i["message"]], "full check only")
        write_json(self.root / "assets" / "trim.timing.json", {"version": 1, "mezzanine": {"path": "assets/trim.mov"}})
        self.assertFalse([i for i in self.issues() if "decoded wrong" in i["message"]], "a mezzanine is never flagged")

    def test_a_probed_verdict_wins_over_the_container(self) -> None:
        cache = self.bridge / "video" / "demo" / "asset-verdicts.json"
        st = (self.root / "assets" / "clean.mp4").stat()
        write_json(cache, {f"assets/clean.mp4|{st.st_size}|{st.st_mtime_ns}": {"verdict": "ffmpeg-misdecodes", "reasons": ["count-mismatch"]}})
        found = [i for i in self.issues() if "decoded wrong" in i["message"]]
        self.assertEqual(sorted(i["path"] for i in found), ["devices[0].media.src", "devices[1].media.src"])

    def test_probing_feeds_the_check(self) -> None:
        self.a("probe", "assets/trim.mov", "--json", code=0)
        cache = json.loads((self.bridge / "video" / "demo" / "asset-verdicts.json").read_text(encoding="utf-8"))
        self.assertEqual([v["verdict"] for k, v in cache.items() if k.startswith("assets/trim.mov|")], ["ffmpeg-misdecodes"])

    def test_a_stale_provenance_record_is_info(self) -> None:
        write_json(self.root / "assets" / "_meta.json", {"version": 1, "assets": {"assets/clean.mp4": {"sha256": "0" * 64, "transforms": []}}})
        proc = self.kb(["check", "--json"], cwd=self.root)
        report = json.loads(proc.stdout)
        info = [i for i in report["issues"] if i["severity"] == "info"]
        self.assertEqual([(i["file"], i["path"]) for i in info], [("assets/_meta.json", 'assets["assets/clean.mp4"]')])
        self.assertEqual(report["warnings"], len([i for i in report["issues"] if i["severity"] == "warning"]), "info is not a warning")
        self.assertIn("info ", self.kb(["check"], cwd=self.root).stdout)
