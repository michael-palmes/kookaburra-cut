from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from kblib.project import Project
from kblib.video import editdoc

from .helpers import KB, FakeApp, KbTestCase, fake_worktree, png_bytes, python_argv, read_json, video_project, write_json, write_probe

VIDEO_COMMANDS = [
    "list", "show", "map", "usages", "validate", "caps", "new", "reset", "split", "cut", "keep", "trim", "speed", "freeze", "hold",
    "remove", "move", "insert", "append", "tap", "mask", "crop", "zoom", "apply", "render", "use", "durations", "open",
]
OLD_CAPS = json.dumps({"appVersion": "0.18.0", "mask": {"styles": ["solid", "blur", "pixelate"]}, "crop": False, "zoom": False, "docVersion": {"read": 2, "write": [1, 2]}})
TAP_OPS = ["add", "move", "retime", "remove", "style", "list"]
MASK_OPS = ["add", "key", "hold", "unkey", "offset", "set", "span", "remove", "list"]


class VideoCase(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = video_project(self.tmp)
        self.project = Project(self.root)
        self.log = self.tmp / "argv.log"
        self.fake_cli(log=self.log)

    def v(self, *args: str, stdin: Optional[str] = None, code: Optional[int] = 0) -> subprocess.CompletedProcess:
        proc = self.kb(["video", *args], cwd=self.root, stdin=stdin)
        if code is not None:
            self.assertExit(proc, code)
        return proc

    def j(self, *args: str, code: int = 0) -> Any:
        return json.loads(self.v(*args, "--json", code=code).stdout)

    def doc(self, name: str = "rec") -> Dict[str, Any]:
        return read_json(self.root / "edits" / f"{name}.json")

    def spans(self, name: str = "rec") -> List[Any]:
        return [(c["id"], c["inMs"], c["outMs"]) + ((c["holdMs"],) if "holdMs" in c else ()) for c in self.doc(name)["clips"]]

    def calls(self, command: str) -> List[List[str]]:
        return [a for a in (json.loads(x) for x in self.log.read_text().splitlines()) if a[1] == command] if self.log.exists() else []

    def device_scene(self, src: str = "assets/rec.mp4", follow: bool = True) -> None:
        doc: Dict[str, Any] = {"version": 1, "name": "Hero", "devices": [{"id": "phone", "model": "iphone-17-pro", "media": {"src": src, "kind": "video", "startMs": 500}}]}
        if follow:
            doc["duration"] = {"mode": "follow-media"}
        write_json(self.root / "scenes" / "02-hero.json", doc)


class HelpAndInspectTests(VideoCase):
    def test_help_lists_every_video_subcommand(self) -> None:
        out = self.kb(["video", "--help"]).stdout
        for name in VIDEO_COMMANDS:
            self.assertIn(f"    {name} ", out.replace(f"    {name}\n", f"    {name} \n"))
        for name in VIDEO_COMMANDS:
            self.assertExit(self.kb(["video", name, "--help"]), 0)
        for op in TAP_OPS:
            self.assertExit(self.kb(["video", "tap", op, "--help"]), 0)
        for op in MASK_OPS:
            self.assertExit(self.kb(["video", "mask", op, "--help"]), 0)
        self.assertIn("video render NAME", self.kb(["--help"]).stdout)

    def test_new_list_show_validate_caps(self) -> None:
        out = self.v("new", "assets/rec.mp4").stdout
        self.assertIn("created edits/rec.json", out)
        self.assertIn("next:", out)
        listed = self.j("list")
        self.assertEqual((listed["ok"], listed["command"]), (True, "video list"))
        rows = listed["edits"]
        self.assertEqual(rows[0]["name"], "rec")
        self.assertEqual(rows[0]["render"]["state"], "none")
        shown = self.j("show", "rec", "--at", "2.5")
        self.assertEqual(shown["timeline"]["frames"], 600)
        self.assertEqual(shown["at"]["sourceMs"], 2500)
        self.assertIn("ok", self.v("validate", "rec").stdout)
        caps = self.j("caps")
        self.assertEqual(caps["caps"]["cli"], 1)
        self.assertEqual(caps["cli"]["source"], "KB_APP_BIN")

    def test_missing_cli_is_exit_2_for_writes(self) -> None:
        self.real_process = True
        self.v("new", "assets/rec.mp4")
        self.env["KB_APP_BIN"] = str(self.tmp / "missing")
        proc = self.v("split", "rec", "--at", "2", code=2)
        self.assertIn("KB_APP_BIN", proc.stderr)
        self.assertEqual(len(self.doc()["clips"]), 1)
        self.v("split", "rec", "--at", "2", "--dry-run")


class CreateTests(VideoCase):
    def test_reuse_fresh_and_collisions(self) -> None:
        self.v("new", "assets/rec.mp4")
        self.v("split", "rec", "--at", "2")
        self.assertIn("reusing", self.v("new", "assets/rec.mp4").stdout)
        self.assertEqual(len(self.doc()["clips"]), 2)
        self.v("new", "assets/rec.mp4", "--fresh")
        self.assertEqual(len(self.doc()["clips"]), 1)
        self.assertTrue((self.root / "edits" / "rec.json.bak").is_file())
        write_probe(self.root / "assets" / "sub" / "rec.mp4")
        proc = self.v("new", "assets/sub/rec.mp4", code=1)
        self.assertIn("--name", proc.stderr)
        self.assertIn("rec-2", proc.stderr)
        self.v("new", "assets/sub/rec.mp4", "--name", "rec-sub")
        self.assertEqual(self.doc("rec-sub")["sources"][0]["rel"], "assets/sub/rec.mp4")
        self.v("new", "assets/sub/rec.mp4", "--name", "_bad", code=2)

    def test_outside_files_import_and_renders_reopen(self) -> None:
        outside = self.tmp / "Desktop" / "Screen Take.mp4"
        write_probe(outside)
        (self.tmp / "Desktop" / "Screen Take.mp4.probe.json").rename(self.tmp / "probe.json")
        proc = self.v("new", str(outside), code=None)
        self.assertNotEqual(proc.returncode, 0)
        os.replace(self.tmp / "probe.json", self.root / "assets" / "Screen Take.mp4.probe.json")
        proc = self.v("new", str(outside))
        self.assertIn("assets/Screen Take.mp4", proc.stdout)
        self.assertTrue((self.root / "assets" / "Screen Take.mp4").is_file())
        self.assertTrue((self.root / "edits" / "screen-take.json").is_file())
        self.v("new", "assets/rec.mp4")
        self.v("render", "rec")
        out = self.v("new", "assets/rec-edited.mp4").stdout
        self.assertIn("reopens", out)
        self.assertFalse((self.root / "edits" / "rec-edited.json").exists())

    def test_for_a_scene_slot(self) -> None:
        self.device_scene()
        out = self.v("new", "--for", "02-hero").stdout
        self.assertIn("render --use will point 02-hero device:phone", out)
        self.v("render", "rec", "--use")
        self.assertEqual(read_json(self.root / "scenes" / "02-hero.json")["devices"][0]["media"]["src"], "assets/rec-edited.mp4")

    def test_reset(self) -> None:
        self.v("new", "assets/rec.mp4")
        self.v("split", "rec", "--at", "2")
        self.v("reset", "rec", code=2)
        (self.root / "edits" / "rec.json").write_text("{broken")
        self.assertIn("rebuilt", self.v("reset", "rec", "--yes").stdout)
        self.assertEqual(len(self.doc()["clips"]), 1)


class ClipTests(VideoCase):
    def setUp(self) -> None:
        super().setUp()
        self.v("new", "assets/rec.mp4")

    def test_split_cut_keep(self) -> None:
        self.v("split", "rec", "--at", "2", "--at", "4000ms")
        self.assertEqual(self.spans(), [("c1", 0, 2000), ("c2", 2000, 4000), ("c3", 4000, 10000)])
        self.v("cut", "rec", "1-3", "end-1s-end")
        self.assertEqual(self.spans(), [("c1", 0, 1000), ("c2", 3000, 4000), ("c3", 4000, 9000)])
        self.v("cut", "rec", "--src", "s1:5-6")
        self.assertEqual(self.spans(), [("c1", 0, 1000), ("c2", 3000, 4000), ("c3", 4000, 5000), ("c4", 6000, 9000)])
        self.v("keep", "rec", "3.5-4.5", "6-8@2x")
        clips = self.doc()["clips"]
        self.assertEqual([(c["inMs"], c["outMs"], c["speed"]) for c in clips], [(3500, 4000, 1), (4000, 4500, 1), (6000, 8000, 2)])

    def test_trim_speed_freeze_hold(self) -> None:
        self.v("trim", "rec", "c1", "--in", "1", "--out", "end-1")
        self.assertEqual(self.spans(), [("c1", 1000, 9000)])
        self.v("trim", "rec", "first", "--head", "0.5", "--tail", "500ms")
        self.assertEqual(self.spans(), [("c1", 1500, 8500)])
        self.v("speed", "rec", "c1", "2x")
        self.assertEqual(self.doc()["clips"][0]["speed"], 2)
        self.v("speed", "rec", "--range", "1-2", "1")
        self.assertEqual([c["speed"] for c in self.doc()["clips"]], [2, 1, 2])
        self.v("freeze", "rec", "--at", "end", "--hold", "1.5")
        last = self.doc()["clips"][-1]
        self.assertEqual(last["holdMs"], 1500)
        self.v("hold", "rec", "last", "3")
        self.assertEqual(self.doc()["clips"][-1]["holdMs"], 3000)
        self.v("freeze", "rec", "--src", "s1@2")
        self.assertTrue(any(c.get("holdMs") == 2000 and c["inMs"] == 2000 for c in self.doc()["clips"]))
        proc = self.v("speed", "rec", "last", "2", code=1)
        self.assertIn("freeze or still", proc.stderr)

    def test_remove_move_insert_append(self) -> None:
        self.v("split", "rec", "--at", "2", "--at", "5")
        self.v("move", "rec", "c3", "--to", "0")
        self.assertEqual([c["id"] for c in self.doc()["clips"]], ["c3", "c1", "c2"])
        self.v("move", "rec", "c3", "--after", "c2")
        self.assertEqual([c["id"] for c in self.doc()["clips"]], ["c1", "c2", "c3"])
        self.v("move", "rec", "c1", "--before", "c3")
        self.assertEqual([c["id"] for c in self.doc()["clips"]], ["c2", "c1", "c3"])
        self.v("remove", "rec", "c1", "0")
        self.assertEqual([c["id"] for c in self.doc()["clips"]], ["c3"])
        (self.root / "assets" / "shot.png").write_bytes(png_bytes(801, 600))
        self.v("insert", "rec", "assets/shot.png", "--at", "1", "--hold", "1.2")
        clips = self.doc()["clips"]
        self.assertEqual([c.get("holdMs") for c in clips], [None, 1200, None])
        self.assertEqual(self.doc()["sources"][1]["kind"], "image")
        write_probe(self.root / "assets" / "b.mp4", durationMs=3000)
        self.v("append", "rec", "assets/b.mp4")
        self.assertEqual(self.doc()["clips"][-1]["outMs"], 3000)

    def test_dry_run_json_and_base(self) -> None:
        before = (self.root / "edits" / "rec.json").read_bytes()
        out = self.j("split", "rec", "--at", "2", "--dry-run")
        self.assertTrue(out["dryRun"])
        self.assertFalse(out["saved"])
        self.assertEqual(len(out["timeline"]["clips"]), 2)
        self.assertEqual((self.root / "edits" / "rec.json").read_bytes(), before)
        proc = self.v("split", "rec", "--at", "2", "--base", "f" * 64, code=1)
        self.assertIn("changed since", proc.stderr)
        sha = editdoc.file_sha(self.root / "edits" / "rec.json")
        out = self.j("split", "rec", "--at", "2", "--base", sha)
        self.assertTrue(out["saved"])
        self.assertEqual(out["beforeHash"], sha)
        self.assertEqual(out["changes"][0]["created"], "c2")
        self.assertIn(sha, self.calls("save")[-1])

    def test_lock_busy_is_exit_3(self) -> None:
        self.real_process = True
        with editdoc.edit_lock(self.project, "rec", "kb video render", wait=0):
            proc = self.v("split", "rec", "--at", "2", "--wait", "0.3", code=3)
            out = self.j("split", "rec", "--at", "2", "--wait", "0.3", code=3)
        self.assertIn("busy", proc.stderr)
        self.assertIn(str(os.getpid()), proc.stderr)
        self.assertEqual((out["ok"], out["code"], out["command"]), (False, "locked", "video split"))
        self.assertEqual(out["holder"]["pid"], os.getpid())
        self.assertGreater(out["retryAfterMs"], 0)


class TapMaskTests(VideoCase):
    def setUp(self) -> None:
        super().setUp()
        self.v("new", "assets/rec.mp4")

    def test_taps(self) -> None:
        self.v("tap", "add", "rec", "--at", "1.5", "--pos", "0.5,0.25")
        self.v("tap", "add", "rec", "--src", "s1@3", "--px", "960,540")
        taps = self.doc()["taps"]
        self.assertEqual([(t["id"], t["sourceMs"], t["pos"]) for t in taps], [("t1", 1500, [0.5, 0.25]), ("t2", 3000, [0.5, 0.5])])
        self.v("tap", "move", "rec", "t1", "--pos", "0.1,0.1")
        self.v("tap", "retime", "rec", "t1", "--at", "4")
        self.assertEqual(self.doc()["taps"][0]["sourceMs"], 4000)
        self.v("tap", "style", "rec", "--style", "ring", "--colour", "red", "--size", "2")
        d = self.doc()
        self.assertEqual((d["tapStyle"], d["tapColor"], d["tapSize"]), ("ring", "red", 2))
        self.v("tap", "style", "rec", "--style", "sparkle", code=2)
        self.v("tap", "add", "rec", "--at", "1", "--pos", "1.5,0", code=2)
        self.assertIn("t2", self.v("tap", "list", "rec").stdout)
        self.v("tap", "remove", "rec", "t1", "t2")
        self.assertNotIn("taps", self.doc())

    def test_masks(self) -> None:
        self.v("mask", "add", "rec", "--at", "1", "--rect", "0.1,0.1,0.3,0.1", "--until", "5", "--style", "blur", "--strength", "0.6")
        m = self.doc()["masks"][0]
        self.assertEqual((m["id"], m["style"], m["strength"], m["startMs"], m["endMs"]), ("m1", "blur", 0.6, 1000, 5000))
        self.assertEqual(self.doc()["version"], 2)
        self.v("mask", "key", "rec", "m1", "--at", "3", "--rect-px", "960,108,384,108")
        self.assertEqual(len(self.doc()["masks"][0]["keys"]), 2)
        self.v("mask", "hold", "rec", "m1", "--at", "2")
        self.assertEqual(len(self.doc()["masks"][0]["keys"]), 3)
        self.v("mask", "unkey", "rec", "m1", "--at", "2")
        self.v("mask", "hold", "rec", "m1", "--at", "1", code=1)
        self.v("mask", "offset", "rec", "m1", "--by", "0.05,0")
        self.v("mask", "set", "rec", "m1", "--style", "solid", "--colour", "#F00", "--strength", "none")
        m = self.doc()["masks"][0]
        self.assertEqual((m["style"], m["color"]), ("solid", "#ff0000"))
        self.assertNotIn("strength", m)
        self.v("mask", "span", "rec", "m1", "--src-start", "s1@6", "--src-end", "s1@8")
        m = self.doc()["masks"][0]
        self.assertEqual((m["startMs"], m["endMs"]), (6000, 8000))
        self.v("mask", "add", "rec", "--at", "0", "--pos", "0.5,0.5", "--span", "2")
        self.assertEqual(self.doc()["masks"][1]["endMs"], 2000)
        self.assertIn("key s1@", self.v("mask", "list", "rec").stdout)
        self.v("mask", "remove", "rec", "m1", "m2")
        self.assertNotIn("masks", self.doc())
        self.assertEqual(self.doc()["version"], 1)

    def test_cutting_a_masked_span_prunes_the_mask(self) -> None:
        self.v("mask", "add", "rec", "--at", "0", "--rect", "0.1,0.1,0.3,0.1", "--until", "1")
        out = self.v("cut", "rec", "0-2").stdout
        self.assertIn("m1", out)
        self.assertNotIn("masks", self.doc())


class FadeCropZoomTests(VideoCase):
    def setUp(self) -> None:
        super().setUp()
        self.v("new", "assets/rec.mp4")

    def older_app(self) -> None:
        old = self.fake_cli(self.tmp / "old" / "kookaburra-cut", caps=OLD_CAPS)
        self.env["KB_APP_BIN"] = str(old)

    def timed_scene(self, src: str, **timing: Any) -> None:
        media = dict({"src": src, "kind": "video"}, **timing)
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "name": "Hero", "devices": [{"id": "phone", "model": "iphone-17-pro", "media": media}]})

    def test_mask_fades(self) -> None:
        self.v("mask", "add", "rec", "--at", "1", "--rect", "0.1,0.1,0.3,0.1", "--until", "5", "--fade-in", "0.2", "--fade-out", "300ms")
        m = self.doc()["masks"][0]
        self.assertEqual((m["startMs"], m["endMs"], m["fadeInMs"], m["fadeOutMs"], self.doc()["version"]), (1000, 5000, 200, 300, 2))
        self.v("mask", "set", "rec", "m1", "--fade-in", "none")
        m = self.doc()["masks"][0]
        self.assertNotIn("fadeInMs", m)
        self.assertEqual(m["fadeOutMs"], 300)
        self.assertIn("fades out 0.300s", self.v("mask", "list", "rec").stdout)
        self.assertIn("fades out 0.300s", self.v("show", "rec").stdout)
        self.assertIn("don't fit", self.v("mask", "set", "rec", "m1", "--fade-out", "5", code=1).stderr)
        self.v("mask", "span", "rec", "m1", "--until", "1.5")
        self.assertEqual((self.doc()["masks"][0]["endMs"], self.doc()["masks"][0]["fadeOutMs"]), (1500, 300))
        self.v("mask", "set", "rec", "m1", "--fade-in", "-1", code=2)
        self.v("mask", "set", "rec", "m1", code=2)

    def test_fades_refused_by_an_older_app(self) -> None:
        self.v("mask", "add", "rec", "--at", "1", "--rect", "0.1,0.1,0.3,0.1", "--fade-out", "0.2")
        self.older_app()
        proc = self.v("mask", "set", "rec", "m1", "--fade-in", "0.1", code=2)
        self.assertIn("mask fades", proc.stderr)
        self.assertIn("update Kookaburra Cut", proc.stderr)
        proc = self.v("split", "rec", "--at", "4", code=2)
        self.assertIn("would drop them on save", proc.stderr)
        self.assertEqual(len(self.doc()["clips"]), 1)
        self.v("mask", "add", "rec", "--at", "1", "--rect", "0.1,0.1,0.3,0.1", "--fade-in", "0.1", "--dry-run", code=2)

    def test_until_scene_through_a_timed_slot(self) -> None:
        self.timed_scene("assets/rec.mp4", startMs=500, inMs=1000, speed=2)
        out = self.j("mask", "add", "rec", "--at", "1", "--rect", "0.1,0.1,0.3,0.1", "--until-scene", "2", "--scene", "02-hero")
        self.assertEqual(out["timeline"]["masks"][0]["endMs"], 1000 + (2000 - 500) * 2)
        self.v("mask", "set", "rec", "m1", "--until-scene", "2.25", "--scene", "02-hero", "--slot", "device:phone", "--fade-out", "0.25")
        m = self.doc()["masks"][0]
        self.assertEqual((m["endMs"], m["fadeOutMs"]), (4500, 250))
        self.assertIn("into the scene", self.v("mask", "set", "rec", "m1", "--until-scene", "0.2", "--scene", "02-hero", code=1).stderr)
        self.v("mask", "set", "rec", "m1", "--until-scene", "2", code=2)
        self.v("mask", "set", "rec", "m1", "--scene", "02-hero", "--fade-in", "0.1", code=2)
        self.v("mask", "add", "rec", "--at", "1", "--rect", "0,0,1,1", "--until", "2", "--until-scene", "2", "--scene", "02-hero", code=2)
        self.timed_scene("assets/rec.mp4", loop=True)
        self.assertIn("loops", self.v("mask", "span", "rec", "m1", "--until-scene", "2", "--scene", "02-hero", code=2).stderr)

    def test_until_scene_through_the_render(self) -> None:
        self.v("trim", "rec", "c1", "--in", "2")
        self.v("render", "rec")
        self.timed_scene("assets/rec-edited.mp4", startMs=500, speed=0.5, outMs=6000)
        self.v("mask", "add", "rec", "--at", "0", "--rect", "0.1,0.1,0.3,0.1", "--until-scene", "2.5", "--scene", "02-hero")
        self.assertEqual(self.doc()["masks"][0]["endMs"], 2000 + 1000)
        mapped = self.j("map", "rec", "--scene-at", "2.5", "--scene", "02-hero")
        self.assertEqual(mapped["results"][0]["timelineMs"], 1000)
        self.assertEqual(mapped["results"][0]["scene"]["sceneMs"], 2500)
        used = self.j("usages", "rec")["slots"][0]
        self.assertEqual((used["retimed"], used["timing"]), (True, {"outMs": 6000, "speed": 0.5}))
        self.assertIn("retimed: outMs 6000, speed 0.5", self.v("usages", "rec").stdout)
        self.assertIn("own timing", self.v("fit", "rec", "--scene", "02-hero", code=1).stderr)
        self.assertIn("own timing", self.v("align", "rec", "--src", "3", "--scene-at", "2", "--scene", "02-hero", code=1).stderr)

    def test_crop(self) -> None:
        self.v("crop", "rec", "c1", "--rect", "0.1,0.1,0.5,0.5")
        clip = self.doc()["clips"][0]
        self.assertEqual((self.doc()["version"], clip["crop"]), (3, [0.1, 0.1, 0.5, 0.5]))
        self.assertIn("crop x 0.100 y 0.100 w 0.500 h 0.500", self.v("show", "rec").stdout)
        self.v("crop", "rec", "c1", "--aspect", "9:16", "--centre", "0.25,0.5")
        x, y, w, h = self.doc()["clips"][0]["crop"]
        self.assertAlmostEqual((w * 1920) / (h * 1080), 9 / 16, delta=0.01)
        self.assertEqual((y, h), (0, 1))
        self.assertEqual(self.j("show", "rec")["timeline"]["clips"][0]["crop"], [x, y, w, h])
        self.v("crop", "rec", "c1", "--clear")
        self.assertNotIn("crop", self.doc()["clips"][0])
        self.assertEqual(self.doc()["version"], 1)
        self.v("crop", "rec", "c1", "--rect", "0.1,0.1,0.5,0.5", "--centre", "0.5,0.5", code=2)
        self.v("crop", "rec", "c1", "--aspect", "wide", code=2)
        self.v("crop", "rec", "c1", "--clear", code=1)
        self.older_app()
        self.assertIn("a crop", self.v("crop", "rec", "c1", "--rect", "0.1,0.1,0.5,0.5", code=2).stderr)

    def test_zoom_keys(self) -> None:
        self.v("zoom", "rec", "c1", "--at", "1", "--rect", "0.2,0.2,0.5,0.5")
        keys = self.doc()["clips"][0]["zoom"]["keys"]
        self.assertEqual((len(keys), keys[0]["tMs"], keys[0]["ease"], self.doc()["version"]), (1, 1000, "smooth", 3))
        self.v("zoom", "rec", "c1", "--at", "2", "--rect", "0.1,0.1,0.5,0.5", "--ease", "linear")
        self.v("zoom", "rec", "c1", "--at", "1", "--rect", "0.3,0.3,0.4,0.4")
        keys = self.doc()["clips"][0]["zoom"]["keys"]
        self.assertEqual([(k["tMs"], k.get("ease")) for k in keys], [(1000, "smooth"), (2000, None)])
        self.v("zoom", "rec", "c1", "--at", "1", "--ease", "linear")
        self.assertNotIn("ease", self.doc()["clips"][0]["zoom"]["keys"][0])
        self.v("zoom", "rec", "c1", "--move", "2", "--to", "3")
        self.assertEqual([k["tMs"] for k in self.doc()["clips"][0]["zoom"]["keys"]], [1000, 3000])
        self.assertIn("zoom key at 3.000s", self.v("show", "rec").stdout)
        self.assertIn("gliding zoom", self.v("fit", "rec", "--to", "5", code=1).stderr)
        self.v("zoom", "rec", "c1", "--remove", "3")
        self.assertEqual(len(self.doc()["clips"][0]["zoom"]["keys"]), 1)
        self.v("zoom", "rec", "c1", "--remove", "3", code=1)
        self.v("zoom", "rec", "c1", "--clear")
        self.assertNotIn("zoom", self.doc()["clips"][0])
        self.v("crop", "rec", "c1", "--rect", "0.1,0.1,0.5,0.5")
        self.assertIn("static crop", self.v("zoom", "rec", "c1", "--clear", code=1).stderr)
        for bad in (["--at", "1"], ["--move", "1"], ["--remove", "1", "--to", "2"], ["--remove", "1", "--rect", "0,0,1,1"]):
            self.v("zoom", "rec", "c1", *bad, code=2)
        self.older_app()
        self.assertIn("zoom keys", self.v("zoom", "rec", "c1", "--at", "1", "--rect", "0.2,0.2,0.5,0.5", code=2).stderr)


class ApplyTests(VideoCase):
    def setUp(self) -> None:
        super().setUp()
        self.v("new", "assets/rec.mp4")

    def test_plan_with_labels_file_and_stdin(self) -> None:
        plan = [
            {"op": "split", "atMs": 4000, "as": "tail"},
            {"op": "setSpeed", "clipId": "$tail", "speed": 2},
            {"op": "addMask", "atMs": 0, "rect": [0.1, 0.1, 0.4, 0.1], "as": "m"},
            {"op": "retimeMaskEdge", "maskId": "$m", "edge": "end", "sourceMs": 3000},
            {"op": "cutSource", "sourceId": "s1", "fromMs": 3500, "toMs": 4000},
        ]
        out = self.j("apply", "rec", json.dumps(plan))
        self.assertEqual([c["created"] for c in out["changes"]][:3], ["c2", None, "m1"])
        self.assertEqual(self.spans(), [("c1", 0, 3500), ("c2", 4000, 10000)])
        self.assertEqual(self.doc()["masks"][0]["endMs"], 3000)
        path = self.tmp / "plan.json"
        path.write_text(json.dumps({"ops": [{"op": "removeClip", "clipId": "c1"}]}))
        self.v("apply", "rec", f"@{path}")
        self.assertEqual(len(self.doc()["clips"]), 1)
        self.v("apply", "rec", "-", stdin=json.dumps([{"op": "trimIn", "clipId": "first", "inMs": 5000}]))
        self.assertEqual(self.doc()["clips"][0]["inMs"], 5000)

    def test_all_or_nothing_and_plan_base(self) -> None:
        before = (self.root / "edits" / "rec.json").read_bytes()
        proc = self.v("apply", "rec", json.dumps([{"op": "split", "atMs": 1000}, {"op": "setSpeed", "clipId": "c9", "speed": 2}]), code=1)
        self.assertIn("op 1 (setSpeed)", proc.stderr)
        self.assertIn("unknown-clip", proc.stderr)
        self.assertEqual((self.root / "edits" / "rec.json").read_bytes(), before)
        self.v("apply", "rec", json.dumps({"baseHash": "0" * 64, "ops": [{"op": "split", "atMs": 1000}]}), code=1)
        self.v("apply", "rec", "{not json", code=2)


class RenderTests(VideoCase):
    def setUp(self) -> None:
        super().setUp()
        self.device_scene()
        self.v("new", "assets/rec.mp4")
        self.v("cut", "rec", "0-2")

    def sidecar_src(self) -> str:
        return read_json(self.root / "scenes" / "02-hero.json")["devices"][0]["media"]["src"]

    def test_render_order_video_then_media_changed_then_sidecar(self) -> None:
        seen: Dict[str, Any] = {}
        output = self.root / "assets" / "rec-edited.mp4"

        def handler(req: Dict[str, Any]) -> Dict[str, Any]:
            if req["kind"] == "mediaChanged":
                seen["exists"] = output.is_file()
                seen["src"] = self.sidecar_src()
                seen["req"] = req
                return {"ok": True, "project": req["project"], "paths": req["paths"], "warmed": req["paths"], "missing": [], "deferred": False}
            return {"ok": False, "error": "unexpected"}

        with FakeApp(self.bridge, handler, openProject="ws:demo"):
            proc = self.v("render", "rec", "--use", "--scene", "02-hero")
        self.assertTrue(seen["exists"])
        self.assertEqual(seen["src"], "assets/rec.mp4")
        self.assertEqual(seen["req"]["paths"], ["assets/rec-edited.mp4"])
        self.assertEqual(seen["req"]["edit"], "rec")
        self.assertEqual(seen["req"]["projectPath"], str(self.root.resolve()))
        self.assertEqual(self.sidecar_src(), "assets/rec-edited.mp4")
        self.assertIn("02-hero length", proc.stdout)
        self.assertEqual(read_json(self.root / "project.json")["scenes"][1]["durationMs"], 8000)
        render = self.calls("render")[-1]
        self.assertIn("--expect-hash", render)
        self.assertNotIn("--draft", render)
        self.assertLessEqual(len(proc.stderr.splitlines()), 10)
        self.assertEqual(editdoc.render_state(self.project, "rec"), "fresh")

    def test_render_without_the_app_or_its_kind_warns(self) -> None:
        proc = self.v("render", "rec")
        self.assertIn("not running", proc.stdout)
        with FakeApp(self.bridge, lambda r: {"ok": True}, kinds=["capture", "check"]):
            proc = self.v("render", "rec")
        self.assertIn("does not take mediaChanged", proc.stdout)
        self.assertEqual(self.sidecar_src(), "assets/rec.mp4")
        self.assertEqual(read_json(self.root / "project.json")["scenes"][1]["durationMs"], 3000)

    def test_render_json_progress_lines(self) -> None:
        proc = self.v("render", "rec", "--json")
        events = [json.loads(line) for line in proc.stderr.splitlines() if line.startswith("{")]
        self.assertEqual(events[0]["event"], "start")
        self.assertEqual(events[-1]["event"], "done")
        self.assertEqual(json.loads(proc.stdout)["done"]["frames"], 480)

    def test_exporting_refuses_then_waits(self) -> None:
        self.v("render", "rec", "--use", "--scene", "02-hero")
        with FakeApp(self.bridge, lambda r: {"ok": True}, openProject="ws:demo", exporting=True) as app:
            proc = self.v("render", "rec", code=2)
            self.assertIn("exporting", proc.stderr)
            started = time.monotonic()
            run = subprocess.Popen(python_argv(KB) + ["video", "render", "rec", "--wait", "30"], cwd=str(self.root), env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            time.sleep(1.0)
            app.heartbeat["exporting"] = False
            app.write_heartbeat()
            out, err = run.communicate(timeout=60)
        self.assertEqual(run.returncode, 0, err)
        self.assertGreater(time.monotonic() - started, 0.9)

    def test_export_of_another_project_does_not_block(self) -> None:
        with FakeApp(self.bridge, lambda r: {"ok": True, "warmed": [], "deferred": True}, openProject="ws:other", exporting=True):
            self.v("render", "rec")

    def test_interrupt_reaches_the_cli(self) -> None:
        import signal

        self.v("render", "rec")
        good = (self.root / "assets" / "rec-edited.mp4").read_bytes()
        self.v("split", "rec", "--at", "1")
        self.fake_cli(log=self.log, sleep="0.4")
        run = subprocess.Popen(python_argv(KB) + ["video", "render", "rec"], cwd=str(self.root), env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and not list((self.root / "assets" / ".kc-render").glob("*")):
            time.sleep(0.05)
        time.sleep(0.3)
        run.send_signal(signal.SIGINT)
        out, err = run.communicate(timeout=30)
        self.assertEqual(run.returncode, 2, err)
        self.assertIn("interrupted", err)
        self.assertEqual(list((self.root / "assets" / ".kc-render").glob("*")), [])
        self.assertEqual((self.root / "assets" / "rec-edited.mp4").read_bytes(), good)

    def test_draft_goes_to_the_scratch_folder(self) -> None:
        out = self.j("render", "rec", "--draft")
        path = Path(out["path"])
        self.assertTrue(path.is_file())
        self.assertTrue(str(path).startswith(str(self.bridge / "video" / "demo" / "drafts")))
        self.assertFalse((self.root / "assets" / "rec-edited.mp4").exists())
        self.assertIn("--out", self.calls("render")[-1])

    def test_failed_render_keeps_the_scene(self) -> None:
        self.fake_cli(log=self.log, fail="render")
        proc = self.v("render", "rec", "--use", "--scene", "02-hero", code=1)
        self.assertIn("ffmpeg", proc.stderr)
        self.assertEqual(self.sidecar_src(), "assets/rec.mp4")

    def test_use_follow_and_durations(self) -> None:
        self.v("use", "rec", "--scene", "02-hero", code=1)
        self.v("render", "rec")
        self.device_scene(follow=False)
        out = self.v("use", "rec", "--scene", "02-hero", "--follow").stdout
        self.assertIn("now plays assets/rec-edited.mp4", out)
        doc = read_json(self.root / "scenes" / "02-hero.json")
        self.assertEqual(doc["duration"], {"mode": "follow-media", "sourceDeviceId": "phone"})
        self.assertEqual(doc["devices"][0]["media"], {"src": "assets/rec-edited.mp4", "kind": "video", "startMs": 500})
        self.assertEqual(read_json(self.root / "project.json")["scenes"][1]["durationMs"], 8000)
        manifest = read_json(self.root / "project.json")
        manifest["scenes"][1]["durationMs"] = 1234
        write_json(self.root / "project.json", manifest)
        self.assertIn("would be 8.000s", self.v("durations").stdout)
        self.assertEqual(read_json(self.root / "project.json")["scenes"][1]["durationMs"], 1234)
        self.v("durations", "--write")
        self.assertEqual(read_json(self.root / "project.json")["scenes"][1]["durationMs"], 8000)

    def test_usages_and_map(self) -> None:
        self.v("render", "rec", "--use", "--scene", "02-hero")
        used = self.j("usages", "rec")
        self.assertEqual([(u["scene"], u["ref"], u["followsMedia"]) for u in used["slots"]], [("02-hero", "device:phone", True)])
        mapped = self.j("map", "rec", "--at", "1")
        result = mapped["results"][0]
        self.assertEqual(result["sourceMs"], 3000)
        self.assertEqual(result["scene"]["sceneMs"], 1500)
        self.assertEqual(result["scene"]["projectMs"], 2400 + 1500)
        back = self.j("map", "rec", "--scene-at", "1.5")
        self.assertEqual(back["results"][0]["timelineMs"], 1000)
        src = self.j("map", "rec", "--src", "s1@3")
        self.assertEqual(src["results"][0]["timelineMs"], 1000)
        self.v("map", "rec", "--src", "s1@1", code=1)


class OpenTests(VideoCase):
    def setUp(self) -> None:
        super().setUp()
        self.v("new", "assets/rec.mp4")

    def test_open_with_and_without_the_app(self) -> None:
        proc = self.v("open", "rec", code=2)
        self.assertIn("not running", proc.stderr)
        with FakeApp(self.bridge, lambda r: {"ok": True, "project": r["project"], "name": r["name"], "opened": "created", "projectOpen": True}) as app:
            proc = self.v("open", "rec", "--scene", "02-hero")
        req = app.requests[0]
        self.assertEqual((req["kind"], req["name"], req["scene"], req["project"]), ("openEdit", "rec", 1, "ws:demo"))
        self.assertIn("created", proc.stdout)
        with FakeApp(self.bridge, lambda r: {"ok": True}, kinds=["capture"]):
            proc = self.v("open", "rec", code=2)
        self.assertIn("update Kookaburra Cut", proc.stderr)
        self.v("open", "nope", code=1)


class WorktreeTests(KbTestCase):
    def test_mutations_refuse_in_a_linked_worktree(self) -> None:
        self.real_process = True
        main = video_project(self.tmp)
        subprocess.run(["git", "init", "-q", str(main)], check=True)
        tree = fake_worktree(main, self.tmp / "tree" / "demo")
        self.fake_cli()
        proc = self.kb(["video", "new", "assets/rec.mp4"], cwd=tree)
        self.assertExit(proc, 2)
        self.assertIn("STOP", proc.stderr)
        self.assertFalse((tree / "edits").exists())
        self.assertExit(self.kb(["video", "list"], cwd=tree), 0)
