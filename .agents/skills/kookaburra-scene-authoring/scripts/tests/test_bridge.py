from __future__ import annotations

import json
import os
import subprocess
import time
from typing import Any, Dict, Optional

from kblib import bridge, util
from kblib.project import Project

from .helpers import KB, SCRIPTS, FakeApp, KbTestCase, make_project, make_resources, python_argv, read_json, sleeper, write_json


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
        self.write_hb(updatedAtMs=int(time.time() * 1000) - 40_000)
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

    def test_unanswered_request_times_out_as_transient(self) -> None:
        with FakeApp(self.bridge, lambda r: None):
            proc = self.kb(["capture", "--scene", "0", "--timeout", "1"], cwd=self.root)
            data = self.kb(["capture", "--scene", "0", "--timeout", "1", "--json"], cwd=self.root)
        self.assertExit(proc, 3)
        self.assertIn("still working on the capture request", proc.stderr)
        self.assertEqual(json.loads(data.stdout)["code"], "bridge-timeout")
        self.assertIn("retryAfterMs", json.loads(data.stdout))
        self.assertEqual(list((self.bridge / "requests" / ".claimed").glob("*.json")), [])

    def test_unclaimed_and_busy_requests_are_transient(self) -> None:
        with FakeApp(self.bridge, lambda r: {"ok": True}, serve_filter=lambda r: False):
            proc = self.kb(["capture", "--scene", "0", "--timeout", "1"], cwd=self.root)
        self.assertExit(proc, 3)
        self.assertIn("did not pick up the capture request", proc.stderr)
        self.assertEqual(list((self.bridge / "requests").glob("*.json")), [])
        with FakeApp(self.bridge, lambda r: {"ok": False, "busy": True, "error": "Kookaburra Cut is exporting right now; retry shortly"}):
            data = self.kb(["capture", "--scene", "0", "--timeout", "1", "--json"], cwd=self.root)
        self.assertExit(data, 3)
        envelope = json.loads(data.stdout)
        self.assertEqual((envelope["code"], envelope["retryAfterMs"]), ("app-busy", 10_000))

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
        self.assertEqual(app.requests[0]["workspaceRoot"], str(self.tmp))


def ok_capture(req: Dict[str, Any]) -> Dict[str, Any]:
    return {"ok": True, "path": f"/tmp/{req['id']}.png", "project": req.get("project")}


class AddressingTests(KbTestCase):
    """Several app instances share one queue: kb elects one per workspace root and addresses it by pid."""

    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.other = self.tmp / "elsewhere"
        self.other.mkdir()

    def test_every_kind_carries_the_address(self) -> None:
        with FakeApp(self.bridge, lambda r: {"ok": True}) as app:
            proc = self.kb(["capture", "--scene", "0", "--agent", "alpha"], cwd=self.root)
            for kind in ("capture", "check", "fonts", "insertPreset", "mediaChanged", "openEdit"):
                bridge.request(kind, {"project": "ws:demo", "projectPath": str(self.root)}, 10, "test", client="agent-a")
        self.assertExit(proc, 0)
        self.assertIn("served by Kookaburra Cut 0.19.0-test (dev, pid", proc.stderr)
        first = app.requests[0]
        self.assertEqual((first["workspaceRoot"], first["projectPath"], first["instancePid"]), (str(self.tmp), str(self.root), os.getpid()))
        self.assertEqual(first["client"], "alpha")
        self.assertAlmostEqual(first["deadlineAtMs"] - first["requestedAtMs"], 120_000, delta=1_000)
        sent = {r["kind"]: r for r in app.requests[1:]}
        self.assertEqual(sorted(sent), ["capture", "check", "fonts", "insertPreset", "mediaChanged", "openEdit"])
        for req in sent.values():
            self.assertEqual((req["workspaceRoot"], req["projectPath"], req["instancePid"], req["client"]), (str(self.tmp), str(self.root), os.getpid(), "agent-a"))

    def test_each_root_reaches_its_own_instance(self) -> None:
        second = make_project(self.other)
        with FakeApp(self.bridge, ok_capture) as ours, FakeApp(self.bridge, ok_capture, pid=sleeper(self).pid, root=self.other) as theirs:
            here = self.kb(["capture", "--scene", "0"], cwd=self.root)
            there = self.kb(["capture", "--scene", "0"], cwd=second)
        self.assertExit(here, 0)
        self.assertExit(there, 0)
        self.assertEqual([r["projectPath"] for r in ours.requests], [str(self.root)])
        self.assertEqual([r["projectPath"] for r in theirs.requests], [str(second)])
        self.assertEqual(theirs.requests[0]["instancePid"], theirs.pid)

    def test_only_foreign_or_passive_instances_fail_fast(self) -> None:
        with FakeApp(self.bridge, ok_capture, pid=sleeper(self).pid, root=self.other) as foreign, \
                FakeApp(self.bridge, ok_capture, pid=sleeper(self).pid, serving=False) as passive:
            started = time.monotonic()
            proc = self.kb(["capture", "--scene", "0"], cwd=self.root)
            data = self.kb(["capture", "--scene", "0", "--json"], cwd=self.root)
        self.assertLess(time.monotonic() - started, 20)
        self.assertExit(proc, 2)
        self.assertIn("no running Kookaburra Cut serves this project's workspace", proc.stderr)
        self.assertIn(f"pid {foreign.pid}", proc.stderr)
        self.assertIn(f"on {self.other} (serves another workspace)", proc.stderr)
        self.assertIn(f"pid {passive.pid}", proc.stderr)
        self.assertIn("bridge off: workspace root overridden", proc.stderr)
        envelope = json.loads(data.stdout)
        self.assertEqual(envelope["code"], "no-app")
        self.assertEqual(sorted(i["pid"] for i in envelope["instances"]), sorted([foreign.pid, passive.pid]))
        self.assertEqual(foreign.requests + passive.requests, [])
        self.assertEqual(list((self.bridge / "requests").glob("*.json")), [])

    def test_a_passive_instance_is_listed_but_never_addressed(self) -> None:
        pid = sleeper(self).pid
        with FakeApp(self.bridge, ok_capture, pid=pid, serving=False, serve_filter=lambda r: r.get("instancePid") == pid, startedAtMs=1) as passive, \
                FakeApp(self.bridge, ok_capture) as serving:
            proc = self.kb(["capture", "--scene", "0"], cwd=self.root)
            data = json.loads(self.kb(["status", "--json"], cwd=self.root).stdout)
        self.assertExit(proc, 0)
        self.assertEqual(len(serving.requests), 1)
        self.assertEqual(passive.requests, [])
        rows = {r["pid"]: r for r in data["instances"]}
        self.assertEqual((rows[pid]["serving"], rows[pid]["chosen"]), (False, False))
        self.assertTrue(rows[os.getpid()]["chosen"])

    def test_an_answer_from_another_workspace_is_discarded(self) -> None:
        def handler(req: Dict[str, Any]) -> Dict[str, Any]:
            return dict(ok_capture(req), servedBy={"pid": 4242, "workspaceRoot": str(self.other)})

        with FakeApp(self.bridge, handler):
            proc = self.kb(["capture", "--scene", "0"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("kb discarded the answer", proc.stderr)
        self.assertNotIn(".png", proc.stdout)

    def test_an_older_app_is_used_only_on_this_root(self) -> None:
        with FakeApp(self.bridge, ok_capture, legacy=True) as app:
            proc = self.kb(["capture", "--scene", "0"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertNotIn("instancePid", app.requests[0])
        self.assertEqual(app.requests[0]["workspaceRoot"], str(self.tmp))
        self.assertNotIn("served by", proc.stderr)
        with FakeApp(self.bridge, ok_capture, legacy=True, root=self.other) as app:
            proc = self.kb(["capture", "--scene", "0"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("serves another workspace", proc.stderr)
        self.assertEqual(app.requests, [])

    def test_stale_and_dead_heartbeats_are_ignored(self) -> None:
        gone = sleeper(self)
        gone.kill()
        gone.wait()
        now = int(time.time() * 1000)
        write_json(self.bridge / "apps" / f"{gone.pid}.json", {"pid": gone.pid, "updatedAtMs": now, "workspaceRoot": str(self.tmp), "bridge": {"serving": True}})
        write_json(self.bridge / "apps" / f"{os.getpid()}.json", {"pid": os.getpid(), "updatedAtMs": now - 60_000, "workspaceRoot": str(self.tmp), "bridge": {"serving": True}})
        self.assertEqual(bridge.instances(), [])
        proc = self.kb(["capture", "--scene", "0"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("not running", proc.stderr)

    def test_the_addressed_instance_quitting_fails_fast(self) -> None:
        app_process = sleeper(self)
        with FakeApp(self.bridge, lambda r: None, pid=app_process.pid):
            run = subprocess.Popen(python_argv(KB) + ["capture", "--scene", "0", "--timeout", "60"], cwd=str(self.root), env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            time.sleep(1.0)
            started = time.monotonic()
            app_process.kill()
            app_process.wait()
            _out, err = run.communicate(timeout=30)
        self.assertEqual(run.returncode, 2, err)
        self.assertLess(time.monotonic() - started, 5)
        self.assertIn("quit while kb waited for the capture request", err)

    def test_the_election_prefers_open_then_release_then_earliest_then_lowest_pid(self) -> None:
        pids = sorted(sleeper(self).pid for _ in range(4))
        now = int(time.time() * 1000)

        def beat(pid: int, **fields: Any) -> None:
            body = {"pid": pid, "updatedAtMs": now, "workspaceRoot": str(self.tmp), "build": "dev", "startedAtMs": 100, "bridge": {"serving": True}}
            body.update(fields)
            write_json(self.bridge / "apps" / f"{pid}.json", body)

        def winner() -> int:
            pick = bridge.elect(bridge.instances(), self.tmp, "ws:demo")
            return pick.pid if pick else -1

        beat(pids[0])
        beat(pids[1])
        self.assertEqual(winner(), pids[0])
        beat(pids[1], startedAtMs=50)
        self.assertEqual(winner(), pids[1])
        beat(pids[2], build="release", startedAtMs=900)
        self.assertEqual(winner(), pids[2])
        beat(pids[3], openProject="ws:demo", startedAtMs=999)
        self.assertEqual(winner(), pids[3])
        beat(pids[3], openProject="ws:demo", workspaceRoot=str(self.other))
        self.assertEqual(winner(), pids[2])
        beat(pids[2], build="release", bridge={"serving": False, "reason": "dev build from a git worktree"})
        self.assertEqual(winner(), pids[1])
        self.assertIsNone(bridge.elect(bridge.instances(), self.other / "nowhere", "ws:demo"))
        self.assertEqual(bridge.elect(bridge.instances(), self.other, None).pid, pids[3])

    def test_same_dir_compares_folders_not_spellings(self) -> None:
        alias = self.tmp / "alias"
        alias.symlink_to(self.tmp / "elsewhere")
        self.assertTrue(bridge.same_dir(alias, self.other))
        self.assertTrue(bridge.same_dir(f"{self.tmp}/demo/..", self.tmp))
        self.assertFalse(bridge.same_dir(self.other, self.tmp))
        self.assertFalse(bridge.same_dir(self.tmp / "missing", self.tmp / "missing"))
        self.assertFalse(bridge.same_dir(self.root / "project.json", self.root / "project.json"))

    def test_the_bridge_dir_follows_the_apps_variable(self) -> None:
        saved = os.environ.get("KOOKABURRA_BRIDGE_DIR")
        try:
            os.environ["KOOKABURRA_BRIDGE_DIR"] = str(self.other / "_bridge")
            self.assertEqual(util.bridge_dir(), self.bridge)
            os.environ.pop("KB_BRIDGE_DIR")
            self.assertEqual(util.bridge_dir(), self.other / "_bridge")
            os.environ["KOOKABURRA_BRIDGE_DIR"] = "relative/_bridge"
            self.assertEqual(util.bridge_dir(), util.home() / "Kookaburra Cut" / "_bridge")
        finally:
            if saved is None:
                os.environ.pop("KOOKABURRA_BRIDGE_DIR", None)
            else:
                os.environ["KOOKABURRA_BRIDGE_DIR"] = saved

    def test_the_video_cli_follows_the_serving_instance(self) -> None:
        self.no_app_bin()
        ours = self.fake_cli(self.tmp / "ours" / "kookaburra-cut")
        theirs = self.fake_cli(self.tmp / "theirs" / "kookaburra-cut")
        with FakeApp(self.bridge, ok_capture, cliPath=str(ours), cliVersion=1), \
                FakeApp(self.bridge, ok_capture, pid=sleeper(self).pid, root=self.other, cliPath=str(theirs), cliVersion=1, build="release"):
            data = json.loads(self.kb(["status", "--json"], cwd=self.root).stdout)
            bridge.bind(Project(self.root))
            try:
                hb = bridge.live_heartbeat()
            finally:
                bridge.bind(None)
        self.assertEqual(data["videoCli"]["path"], str(ours))
        self.assertEqual(hb["cliPath"] if hb else None, str(ours))
