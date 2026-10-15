from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, Optional

from kblib import bridge

from .helpers import SCRIPTS, FakeApp, KbTestCase, make_project, make_resources, read_json


class HeartbeatTests(KbTestCase):
    def write_hb(self, **fields: Any) -> None:
        body = {"version": 2, "pid": os.getpid(), "updatedAtMs": int(time.time() * 1000)}
        body.update(fields)
        self.bridge.mkdir(parents=True, exist_ok=True)
        (self.bridge / "app.json").write_text(json.dumps(body))

    def test_fresh_live_heartbeat(self) -> None:
        self.write_hb()
        self.assertIsNotNone(bridge.live_heartbeat())

    def test_stale_or_dead_heartbeat(self) -> None:
        self.write_hb(updatedAtMs=int(time.time() * 1000) - 20_000)
        self.assertIsNone(bridge.live_heartbeat())
        self.assertIn("stale", bridge.not_running_message("x"))
        self.write_hb(pid=999_999_9)
        self.assertIsNone(bridge.live_heartbeat())
        self.assertIn("exited", bridge.not_running_message("x"))
        (self.bridge / "app.json").unlink()
        self.assertIn("no heartbeat", bridge.not_running_message("x"))

    def test_heartbeat_preset_dirs_win(self) -> None:
        os.environ.pop("KB_RESOURCES_DIR")
        presets = self.tmp / "dev" / "presets"
        previews = self.tmp / "dev" / "previews"
        presets.mkdir(parents=True)
        previews.mkdir(parents=True)
        self.write_hb(presetsDir=str(presets), presetPreviewsDir=str(previews))
        self.assertEqual(bridge.presets_dir(), presets)
        self.assertEqual(bridge.preset_previews_dir(), previews)
        self.assertEqual(bridge.samples_dir(), self.tmp / "dev" / "projects" / "_samples")

    def test_frames_arg(self) -> None:
        self.assertEqual(bridge.frames_arg("0@1, 02-hero@2.5,3"), [{"scene": "0", "at": 1.0}, {"scene": "02-hero", "at": 2.5}, {"scene": "3"}])
        with self.assertRaises(Exception):
            bridge.frames_arg(",".join(["0@1"] * 49))


class BridgeCommandTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)

    def test_app_not_running_is_exit_2(self) -> None:
        proc = self.kb(["capture", "--scene", "0"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("not running", proc.stderr)
        self.assertIn("ask the user to open it", proc.stderr)

    def test_capture_round_trip(self) -> None:
        def handler(req: Dict[str, Any]) -> Dict[str, Any]:
            return {"ok": True, "path": f"/tmp/{req['id']}.png", "frames": [{"scene": req["scene"], "at": req.get("at"), "tMs": 3100, "path": f"/tmp/{req['id']}.png", "index": 1}], "format": "9:16", "project": req["project"], "surface": "render-window"}

        with FakeApp(self.bridge, handler) as app:
            proc = self.kb(["capture", "--scene", "1", "--at", "0.5", "--aspect", "9:16"], cwd=self.root)
        self.assertExit(proc, 0)
        req = app.requests[0]
        self.assertEqual(req["version"], 2)
        self.assertEqual(req["kind"], "capture")
        self.assertEqual(req["project"], "ws:demo")
        self.assertEqual(req["scene"], "02-hero")
        self.assertEqual(req["aspect"], "9:16")
        self.assertRegex(req["id"], r"^\d{16}-\d+-[0-9a-f]{6}$")
        self.assertIn(".png", proc.stdout)
        self.assertFalse(any(p.name.startswith(".") for p in (self.bridge / "requests").glob("*.tmp")))

    def test_frames_and_sheet(self) -> None:
        def handler(req: Dict[str, Any]) -> Dict[str, Any]:
            frames = [dict(f, tMs=1, path=f"/tmp/{i}.png", index=i) for i, f in enumerate(req["frames"])]
            return {"ok": True, "path": frames[0]["path"], "paths": [f["path"] for f in frames], "frames": frames, "sheetPath": "/tmp/sheet.png"}

        with FakeApp(self.bridge, handler) as app:
            proc = self.kb(["capture", "--frames", "0@1,02-hero@2", "--sheet"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertEqual(app.requests[0]["frames"], [{"scene": "01-intro", "at": 1.0}, {"scene": "02-hero", "at": 2.0}])
        self.assertTrue(app.requests[0]["sheet"])
        self.assertIn("sheet: /tmp/sheet.png", proc.stdout)

    def test_playhead_capture_needs_the_open_project(self) -> None:
        with FakeApp(self.bridge, lambda r: {"ok": True, "path": "/tmp/x.png"}, openProject="ws:other"):
            proc = self.kb(["capture"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("not open in the app", proc.stderr)
        with FakeApp(self.bridge, lambda r: {"ok": True, "path": "/tmp/x.png"}, openProject="ws:demo"):
            self.assertExit(self.kb(["capture"], cwd=self.root), 0)

    def test_busy_then_ok_retries(self) -> None:
        calls = {"n": 0}

        def handler(req: Dict[str, Any]) -> Dict[str, Any]:
            calls["n"] += 1
            if calls["n"] == 1:
                return {"ok": False, "busy": True, "error": "Kookaburra Cut is exporting right now; retry shortly"}
            return {"ok": True, "path": "/tmp/after-busy.png"}

        with FakeApp(self.bridge, handler) as app:
            proc = self.kb(["capture", "--scene", "0"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertEqual(len(app.requests), 2)
        self.assertIn("/tmp/after-busy.png", proc.stdout)

    def test_needs_trust_and_rejection(self) -> None:
        with FakeApp(self.bridge, lambda r: {"ok": False, "needsTrust": True, "error": "Open this project in Kookaburra Cut once to trust its code."}):
            proc = self.kb(["capture", "--scene", "0"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("trust", proc.stderr)
        with FakeApp(self.bridge, lambda r: {"ok": False, "error": "line 4: Unexpected token"}):
            proc = self.kb(["capture", "--scene", "0"], cwd=self.root)
        self.assertExit(proc, 1)
        self.assertIn("Unexpected token", proc.stderr)

    def test_unanswered_request_times_out_with_exit_2(self) -> None:
        with FakeApp(self.bridge, lambda r: None):
            proc = self.kb(["capture", "--scene", "0", "--timeout", "1"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("still working on the capture request", proc.stderr)
        self.assertEqual(list((self.bridge / "requests" / ".claimed").glob("*.json")), [])

    def test_missing_kind_in_heartbeat(self) -> None:
        with FakeApp(self.bridge, lambda r: {"ok": True}, kinds=["capture"]):
            proc = self.kb(["check", "--app"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("update Kookaburra Cut", proc.stderr)

    def test_check_app_merges_results_and_records_fonts(self) -> None:
        def handler(req: Dict[str, Any]) -> Dict[str, Any]:
            return {
                "ok": False, "project": req["project"], "rendered": False, "warnings": [],
                "scenes": [
                    {"index": 0, "file": "scenes/01-intro.tsx", "id": "intro", "ok": True, "warnings": []},
                    {"index": 1, "file": "scenes/02-hero.tsx", "id": "hero", "ok": False, "phase": "compile", "error": "line 4: Unexpected token", "warnings": ["assets/gone.png"]},
                ],
                "fonts": [{"ref": "Futura@500", "ok": True}, {"ref": "SF Mono@400", "ok": False, "error": "unknown encoding format: 1", "fallback": "Inter@400"}],
                "assets": [],
            }

        with FakeApp(self.bridge, handler) as app:
            proc = self.kb(["check", "--app"], cwd=self.root)
        self.assertExit(proc, 1)
        self.assertEqual(app.requests[0]["kind"], "check")
        self.assertFalse(app.requests[0]["render"])
        self.assertIn("Unexpected token", proc.stdout)
        self.assertIn("SF Mono@400", proc.stdout)
        verdicts = read_json(self.bridge / "font-verdicts.json")["verdicts"]
        self.assertTrue(verdicts["Futura@500"]["ok"])
        self.assertFalse(verdicts["SF Mono@400"]["ok"])

    def test_check_app_load_failure(self) -> None:
        with FakeApp(self.bridge, lambda r: {"ok": False, "error": "project.json needs a non-empty scenes array", "scenes": [], "fonts": [], "assets": []}):
            proc = self.kb(["check", "--render"], cwd=self.root)
        self.assertExit(proc, 1)
        self.assertIn("could not load the project", proc.stdout)

    def test_fonts_check_via_app(self) -> None:
        def handler(req: Dict[str, Any]) -> Dict[str, Any]:
            return {"ok": True, "results": [{"ref": r, "ok": r != "LastResort", "error": None if r != "LastResort" else "no glyphs", "face": {"postscript": "X", "weight": 400, "file": "x.ttf"}} for r in req["refs"]]}

        with FakeApp(self.bridge, handler) as app:
            ok = self.kb(["fonts", "check", "Menlo@400"], cwd=self.root)
            bad = self.kb(["fonts", "check", "LastResort"], cwd=self.root)
        self.assertExit(ok, 0)
        self.assertIn("ok    Menlo@400", ok.stdout)
        self.assertExit(bad, 1)
        self.assertIn("BAD", bad.stdout)
        self.assertEqual(app.requests[0]["kind"], "fonts")
        self.assertFalse(app.requests[0]["listFamilies"])
        self.assertTrue(read_json(self.bridge / "font-verdicts.json")["verdicts"]["Menlo@400"]["ok"])

    def test_fonts_static_without_app(self) -> None:
        proc = self.kb(["fonts", "check", "Inter@600", "Futura"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("static verdict", proc.stdout)
        self.assertIn("Futura has no 400 weight", proc.stdout)
        safe = self.kb(["fonts", "safe"], cwd=self.root)
        self.assertIn("JetBrains Mono@400", safe.stdout)

    def test_insert_preset_via_app(self) -> None:
        make_resources(self.tmp)
        self.env["KB_RESOURCES_DIR"] = str(self.tmp / "Resources")

        def handler(req: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            return {"ok": True, "file": "scenes/04-pricing.tsx", "index": 1, "id": "pricing", "name": "Pricing", "project": req["project"], "preset": req["preset"]}

        with FakeApp(self.bridge, handler) as app:
            proc = self.kb(["scene", "add", "pricing", "--preset", "title", "--after", "0"], cwd=self.root)
        req = app.requests[0]
        self.assertEqual(req["kind"], "insertPreset")
        self.assertEqual(req["preset"], "title")
        self.assertEqual(req["position"], 1)
        self.assertEqual(req["name"], "Pricing")
        self.assertIn("inserted by the app", proc.stdout)

    def test_capture_shim_keeps_the_old_flags(self) -> None:
        with FakeApp(self.bridge, lambda r: {"ok": True, "path": "/tmp/shim.png"}) as app:
            proc = self.kb(["--scene", "2", "--at", "1", "--project", "ws:demo", "--timeout", "10"], cwd=self.root, script=SCRIPTS / "capture.py")
        self.assertExit(proc, 0)
        self.assertEqual(proc.stdout.strip(), "/tmp/shim.png")
        self.assertEqual(app.requests[0]["scene"], "2")
