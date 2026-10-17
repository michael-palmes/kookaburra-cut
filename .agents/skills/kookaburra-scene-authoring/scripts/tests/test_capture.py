from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List
from unittest import mock

from kblib import capture, queue

from .helpers import FakeApp, KbTestCase, make_project, png_bytes, write_json

FEATURES = ["scale", "width", "probe", "client", "deadline", "recycle", "debug"]
KINDS = ["capture", "check", "fonts", "insertPreset", "mediaChanged", "openEdit", "debug"]


def health(**fields: Any) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "version": 1,
        "captureFeatures": FEATURES,
        "queue": {"depth": 0, "oldestAgeMs": None, "order": [], "etaMs": [], "inFlight": None, "unitMs": 400, "overheadMs": 1000, "samples": 0},
        "renderWindow": {"alive": True, "beatAgeMs": 1200, "glMs": 2.5, "createdAtMs": 1, "loadedProject": "ws:demo", "contentReloads": 0, "recycles": 0, "lastRecycle": None},
        "gpu": {"stalled": False, "stalledUntilMs": None, "wedged": False, "stallsLast10Min": 0, "editorLostAtMs": None},
        "webgl": {"cap": 16, "editor": {"live": 3, "lost": 0, "deliberate": 1, "evictions": 0, "gpuLosses": 0}, "render": {"live": 2, "lost": 0, "deliberate": 0, "evictions": 0, "gpuLosses": 0}},
        "clients": [],
    }
    for key, value in fields.items():
        if isinstance(value, dict) and isinstance(body.get(key), dict):
            body[key] = dict(body[key], **value)
        else:
            body[key] = value
    return body


def ok_frame(req: Dict[str, Any]) -> Dict[str, Any]:
    return {"ok": True, "path": f"/tmp/{req['id']}.png", "project": req.get("project"), "format": "16:9"}


class StallRetryTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)

    def app(self, handler: Any, **hb: Any) -> FakeApp:
        return FakeApp(self.bridge, handler, kinds=KINDS, health=hb.pop("health", health()), **hb)

    def test_one_stall_is_retried_once_with_retry_of(self) -> None:
        answers = [{"ok": False, "gpuStalled": True, "reason": "contextLost", "recycled": True, "retryAfterMs": 0, "wedged": False, "error": "GPU stalled (contextLost)"}]

        def handler(req: Dict[str, Any]) -> Dict[str, Any]:
            return answers.pop(0) if answers else ok_frame(req)

        with self.app(handler) as app:
            started = time.monotonic()
            proc = self.kb(["capture", "--scene", "0", "--no-copy"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertGreaterEqual(time.monotonic() - started, queue.STALL_MIN_WAIT_S)
        self.assertIn("kb: GPU stalled, render window recycled; retrying once", proc.stderr)
        first, second = app.requests
        self.assertNotIn("retryOf", first)
        self.assertEqual(second["retryOf"], first["id"])
        self.assertEqual(second["deadlineAtMs"], first["deadlineAtMs"])

    def test_a_second_stall_exits_3(self) -> None:
        stall = {"ok": False, "gpuStalled": True, "reason": "blankReadback", "recycled": True, "retryAfterMs": 0, "wedged": False, "error": "GPU stalled"}
        with self.app(lambda r: dict(stall)) as app:
            proc = self.kb(["capture", "--scene", "0", "--json"], cwd=self.root)
        self.assertExit(proc, 3)
        envelope = json.loads(proc.stdout)
        self.assertEqual((envelope["code"], envelope["retryAfterMs"]), ("gpu-stalled", 2000))
        self.assertIn("stalled again", envelope["error"])
        self.assertEqual(len(app.requests), 2)

    def test_wedged_exits_2_without_retrying(self) -> None:
        wedged = {"ok": False, "gpuStalled": True, "wedged": True, "recycled": False, "reason": "wedged", "error": "GPU wedged: the render window stalled 3 times in 10 minutes"}
        with self.app(lambda r: dict(wedged)) as app:
            proc = self.kb(["capture", "--scene", "0", "--json"], cwd=self.root)
        self.assertExit(proc, 2)
        envelope = json.loads(proc.stdout)
        self.assertEqual(envelope["code"], "gpu-wedged")
        self.assertIn("quit and reopen", envelope["hint"])
        self.assertEqual(len(app.requests), 1)
        self.assertNotIn("retrying", proc.stderr)

    def test_a_window_that_cannot_come_up_says_so_then_wedged_exits_2(self) -> None:
        now = int(time.time() * 1000)
        restarting = health(
            queue={"depth": 1, "oldestAgeMs": 1_000},
            renderWindow={"alive": False, "beatAgeMs": 95_000, "restarting": True, "recycles": 2, "lastRecycle": {"atMs": now, "reason": "silent"}},
            gpu={"stalled": True, "stalledUntilMs": now + 60_000, "stallsLast10Min": 2},
        )
        wedged = {"ok": False, "gpuStalled": True, "wedged": True, "recycled": False, "reason": "wedged", "retryAfterMs": None,
                  "error": "GPU wedged: the render window stalled 3 times in 10 minutes, so Kookaburra Cut stopped capturing"}
        app = self.app(lambda r: dict(wedged), health=restarting)
        held_until = time.monotonic() + 2.5

        def triage(body: Dict[str, Any]) -> bool:
            if time.monotonic() < held_until:
                return False
            app.heartbeat["health"] = health(gpu={"wedged": True, "stallsLast10Min": 3}, renderWindow={"alive": False, "restarting": True})
            return True

        app.serve_filter = triage
        with app:
            proc = self.kb(["capture", "--scene", "0", "--json"], cwd=self.root)
        self.assertExit(proc, 2)
        envelope = json.loads(proc.stdout)
        self.assertEqual(envelope["code"], "gpu-wedged")
        self.assertIn("quit and reopen", envelope["hint"])
        self.assertIn("kb: the app is restarting its render window after a GPU stall (try 2 of 3, in about", proc.stderr)
        self.assertNotIn("retrying", proc.stderr)
        self.assertEqual(len(app.requests), 1)

    def test_throttled_waits_then_succeeds_or_exits_3(self) -> None:
        answers = [{"ok": False, "throttled": True, "retryAfterMs": 300, "error": "alpha already has 4 requests waiting"}]

        def handler(req: Dict[str, Any]) -> Dict[str, Any]:
            return answers.pop(0) if answers else ok_frame(req)

        with self.app(handler) as app:
            proc = self.kb(["capture", "--scene", "0", "--no-copy"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertEqual(len(app.requests), 2)
        self.assertNotIn("retryOf", app.requests[1])
        long_wait = {"ok": False, "throttled": True, "retryAfterMs": 60_000, "error": "alpha would use 290 capture units in a minute", "hint": "capture fewer or smaller frames (--scale 0.5)"}
        with self.app(lambda r: dict(long_wait)):
            data = self.kb(["capture", "--scene", "0", "--timeout", "5", "--json"], cwd=self.root)
        self.assertExit(data, 3)
        envelope = json.loads(data.stdout)
        self.assertEqual((envelope["code"], envelope["retryAfterMs"]), ("throttled", 60_000))
        self.assertIn("--scale 0.5", envelope["hint"])

    def test_too_large_and_a_reloaded_page(self) -> None:
        big = {"ok": False, "tooLarge": True, "units": 153, "maxUnits": 144, "error": "this capture costs 153 units", "hint": "drop --scale/--width, use the default sheet size"}
        with self.app(lambda r: dict(big)):
            proc = self.kb(["capture", "--scene", "0", "--json"], cwd=self.root)
        self.assertExit(proc, 1)
        envelope = json.loads(proc.stdout)
        self.assertEqual((envelope["code"], envelope["units"]), ("too-large", 153))
        reload = {"ok": False, "transient": True, "reason": "contentReload", "error": "the render window's page reloaded mid-request"}
        with self.app(lambda r: dict(reload)):
            proc = self.kb(["capture", "--scene", "0"], cwd=self.root)
        self.assertExit(proc, 3)
        self.assertIn("page reloaded", proc.stderr)


class FlagTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)

    def test_size_and_probe_flags_reach_the_request(self) -> None:
        with FakeApp(self.bridge, ok_frame, kinds=KINDS, health=health()) as app:
            scaled = self.kb(["capture", "--scene", "0", "--scale", "0.5", "--probe", "10,20,30,40", "--probe", "5,6", "--no-copy"], cwd=self.root)
            wide = self.kb(["capture", "--scene", "0", "--width", "960", "--no-copy"], cwd=self.root)
        self.assertExit(scaled, 0)
        self.assertExit(wide, 0)
        self.assertEqual(app.requests[0]["scale"], 0.5)
        self.assertEqual(app.requests[0]["probe"], [[10, 20], [30, 40], [5, 6]])
        self.assertEqual(app.requests[1]["width"], 960)
        self.assertNotIn("scale", app.requests[1])

    def test_bad_flags_are_usage_errors(self) -> None:
        for argv, needle in (
            (["--scale", "1.5"], "(0, 1]"),
            (["--scale", "0"], "(0, 1]"),
            (["--width", "0"], "at least 1"),
            (["--probe", "1,2,3"], "x,y pairs"),
            (["--probe", "1,a"], "whole pixels"),
            (["--probe", ",".join(["1"] * 130)], "at most 64"),
        ):
            with FakeApp(self.bridge, ok_frame, kinds=KINDS, health=health()) as app:
                proc = self.kb(["capture", "--scene", "0"] + argv, cwd=self.root)
            self.assertExit(proc, 2)
            self.assertIn(needle, proc.stderr)
            self.assertEqual(app.requests, [])
        proc = self.kb(["capture", "--scene", "0", "--width", "10", "--scale", "0.5"], cwd=self.root)
        self.assertExit(proc, 2)

    def test_an_older_app_refuses_the_new_flags(self) -> None:
        with FakeApp(self.bridge, ok_frame) as app:
            proc = self.kb(["capture", "--scene", "0", "--probe", "1,1", "--json"], cwd=self.root)
            plain = self.kb(["capture", "--scene", "0", "--no-copy"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("does not support --probe", json.loads(proc.stdout)["error"])
        self.assertExit(plain, 0)
        self.assertEqual(len(app.requests), 1)


class PolicyTests(KbTestCase):
    def test_client_precedence(self) -> None:
        self.assertEqual(queue.client_id("explicit", argparse.Namespace(agent="alpha")), "explicit")
        with mock.patch.dict(os.environ, {"CLAUDECODE": "", "KB_AGENT": "beta", "CLAUDE_CODE_SESSION_ID": "1a2b3c4d5e"}):
            self.assertEqual(queue.client_id(None, argparse.Namespace(agent="alpha")), "alpha")
            self.assertEqual(queue.client_id(None, argparse.Namespace()), "beta")
        with mock.patch.dict(os.environ, {"CLAUDECODE": "1", "KB_AGENT": "beta", "CLAUDE_CODE_SESSION_ID": "1a2b3c4d5e"}):
            self.assertEqual(queue.client_id(None, argparse.Namespace()), "session-1a2b3c4d")
        with mock.patch("kblib.identity.caller_from", side_effect=RuntimeError("no identity")):
            self.assertEqual(queue.client_id(None, argparse.Namespace(agent="gamma")), "gamma")
            with mock.patch.dict(os.environ, {"KB_AGENT": "", "CLAUDE_CODE_SESSION_ID": ""}):
                self.assertEqual(queue.client_id(None, argparse.Namespace()), "anon")

    def test_the_deadline_and_claim_window_follow_the_feature(self) -> None:
        modern = queue.Policy("capture", {"pid": 1, "health": health()}, 600, "alpha")
        body = modern.payload({"kind": "capture"})
        self.assertEqual(body["client"], "alpha")
        self.assertAlmostEqual(body["deadlineAtMs"], int(time.time() * 1000) + 600_000, delta=2_000)
        self.assertEqual(modern.claim_window_s, 600)
        legacy = queue.Policy("capture", {"pid": 1, "health": None}, 600, "alpha")
        self.assertEqual(legacy.claim_window_s, queue.LEGACY_CLAIM_WINDOW_S)
        self.assertEqual(queue.Policy("capture", None, 30, None).claim_window_s, 30)

    def test_the_position_line_comes_from_health(self) -> None:
        now = int(time.time() * 1000)
        h = health(queue={"order": ["a", "me", "c"], "etaMs": [1_000, 40_200, 50_000]})
        self.assertEqual(queue.position_line(h, "me", now), "kb: queued 2 of 3, about 40 s")
        self.assertIsNone(queue.position_line(h, "gone", now))
        stalled = health(queue={"order": ["me"], "etaMs": [16_000]}, gpu={"stalledUntilMs": now + 15_000})
        self.assertEqual(queue.position_line(stalled, "me", now), "kb: queued 1 of 1, about 16 s (the GPU is recovering first)")
        write_json(self.bridge / "apps" / "4242.json", {"pid": 4242, "health": h})
        policy = queue.Policy("capture", {"pid": 4242, "health": h}, 60, "alpha")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            policy.waiting("me")
            policy.waiting("me")
            policy._health_at = 0.0
            policy.waiting("me")
            write_json(self.bridge / "apps" / "4242.json", {"pid": 4242, "health": health(queue={"order": ["me"], "etaMs": [2_000]})})
            policy._health_at = 0.0
            policy.waiting("me")
        self.assertEqual(err.getvalue().splitlines(), ["kb: queued 2 of 3, about 40 s", "kb: queued 1 of 1, about 2 s"])


    def test_the_recovery_line_names_the_restart(self) -> None:
        now = int(time.time() * 1000)
        backoff = health(gpu={"stalled": True, "stalledUntilMs": now + 15_000, "stallsLast10Min": 2}, renderWindow={"alive": False, "restarting": True})
        self.assertEqual(queue.recovery_line(backoff, now), "kb: the app is restarting its render window after a GPU stall (try 2 of 3, in about 15 s)")
        no_beat = health(gpu={"stallsLast10Min": 3}, renderWindow={"alive": True, "beatAgeMs": None, "restarting": True})
        self.assertEqual(queue.recovery_line(no_beat, now), "kb: the app is restarting its render window after a GPU stall (try 3 of 3)")
        self.assertEqual(queue.recovery_line(health(gpu={"stallsLast10Min": 7}, renderWindow={"restarting": True}), now)[-12:], "(try 3 of 3)")
        for quiet in (
            health(gpu={"stallsLast10Min": 1}, renderWindow={"restarting": False}),
            health(gpu={"stallsLast10Min": 1}),
            health(gpu={"stallsLast10Min": 0}, renderWindow={"restarting": True}),
            health(gpu={"wedged": True, "stallsLast10Min": 3, "stalledUntilMs": now + 9_000}, renderWindow={"restarting": True}),
            {},
        ):
            self.assertIsNone(queue.recovery_line(quiet, now))
        h = dict(no_beat, queue=dict(no_beat["queue"], order=["me"], etaMs=[2_000]))
        write_json(self.bridge / "apps" / "4242.json", {"pid": 4242, "health": h})
        policy = queue.Policy("capture", {"pid": 4242, "health": h}, 60, "alpha")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            policy.waiting("me")
            write_json(self.bridge / "apps" / "4242.json", {"pid": 4242, "health": health(queue={"order": ["me"], "etaMs": [2_000]})})
            policy._health_at = 0.0
            policy.waiting("me")
        self.assertEqual(err.getvalue().splitlines(), ["kb: the app is restarting its render window after a GPU stall (try 3 of 3)", "kb: queued 1 of 1, about 2 s"])


class CopyTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.app_out = self.tmp / "responses"
        self.app_out.mkdir()

    def handler(self, req: Dict[str, Any]) -> Dict[str, Any]:
        frames = []
        for n, f in enumerate(req.get("frames") or [{"scene": req.get("scene"), "at": req.get("at")}]):
            path = self.app_out / (f"{req['id']}.png" if n == 0 else f"{req['id']}-{n}.png")
            path.write_bytes(png_bytes())
            frames.append({"scene": f.get("scene"), "at": f.get("at") if f.get("at") is not None else 1.5, "tMs": 1500, "path": str(path), "index": n})
        sheet = self.app_out / f"{req['id']}-sheet.png"
        sheet.write_bytes(png_bytes(4, 4))
        return {"ok": True, "path": frames[0]["path"], "paths": [f["path"] for f in frames], "frames": frames, "sheetPath": str(sheet), "project": req["project"], "format": "16:9", "size": {"width": 1280, "height": 720}, "nativeSize": {"width": 3840, "height": 2160}}

    def test_captures_are_copied_with_readable_names(self) -> None:
        with FakeApp(self.bridge, self.handler, kinds=KINDS, health=health()):
            proc = self.kb(["capture", "--frames", "0@1,1@2.5,1@2.5", "--sheet", "--agent", "alpha", "--json"], cwd=self.root)
        self.assertExit(proc, 0)
        data = json.loads(proc.stdout)
        folder = Path(data["captureDir"])
        self.assertEqual(folder.parent, self.root / ".kb" / "captures")
        self.assertRegex(folder.name, r"^\d{8}-\d{6}-alpha$")
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["01-intro@1s.png", "02-hero@2.5s-2.png", "02-hero@2.5s.png", "sheet.png"])
        self.assertEqual(data["path"], str(folder / "01-intro@1s.png"))
        self.assertEqual(data["paths"], [f["path"] for f in data["frames"]])
        self.assertTrue(data["bridgePath"].startswith(str(self.app_out)))
        self.assertEqual(data["frames"][1]["bridgePath"], data["bridgePaths"][1])
        self.assertEqual((data["sheetPath"], Path(data["bridgeSheetPath"]).parent), (str(folder / "sheet.png"), self.app_out))
        self.assertEqual((self.root / ".kb" / ".gitignore").read_text(), "*\n")

    def test_out_dir_no_copy_and_text(self) -> None:
        out = self.tmp / "mine"
        with FakeApp(self.bridge, self.handler, kinds=KINDS, health=health()):
            proc = self.kb(["capture", "--scene", "0", "--at", "1.5", "--out", str(out)], cwd=self.root)
            raw = self.kb(["capture", "--scene", "0", "--no-copy"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn(str(out / "01-intro@1.5s.png"), proc.stdout)
        self.assertIn("1280x720 (native 3840x2160)", proc.stderr)
        self.assertTrue((out / "sheet.png").is_file())
        self.assertExit(raw, 0)
        self.assertIn(str(self.app_out), raw.stdout)
        self.assertFalse((self.root / ".kb" / "captures").exists())

    def test_capture_folders_prune_to_40_and_a_gigabyte(self) -> None:
        root = self.tmp / "captures"
        made: List[Path] = []
        for n in range(43):
            folder = root / f"20261017-{n:06d}-a"
            folder.mkdir(parents=True)
            (folder / "f.png").write_bytes(b"x" * 10)
            made.append(folder)
        (root / "not-a-capture").mkdir()
        removed = capture.prune_captures(root, keep=made[0])
        self.assertEqual(len(removed), 3)
        self.assertTrue(made[0].is_dir() and not made[1].exists() and made[4].is_dir())
        self.assertTrue((root / "not-a-capture").is_dir())
        self.assertEqual(capture.prune_captures(root, keep=made[-1], max_bytes=25), [], "folders under an hour old survive the size cap")
        removed = capture.prune_captures(root, keep=made[-1], max_bytes=25, min_age_s=0)
        left = sorted(p.name for p in root.iterdir() if p.name != "not-a-capture")
        self.assertEqual(left, [made[-2].name, made[-1].name])
        self.assertEqual(len(removed), 38)

    def test_each_agent_keeps_its_own_newest_capture_folders(self) -> None:
        root = self.tmp / "captures"
        for n in range(41):
            (root / f"20261017-{n:06d}-alpha").mkdir(parents=True)
        for n in range(5):
            (root / f"20261017-{100 + n:06d}-beta").mkdir(parents=True)
        removed = capture.prune_captures(root, keep_folders=40)
        self.assertEqual([p.name for p in removed], ["20261017-000000-alpha"])
        self.assertEqual(len([p for p in root.iterdir() if p.name.endswith("-beta")]), 5)


class StatusAndDebugTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)

    def test_status_shows_the_capture_service(self) -> None:
        busy = health(
            queue={"depth": 2, "oldestAgeMs": 42_000, "order": ["x", "y"], "inFlight": {"id": "w", "kind": "capture", "client": "alpha", "frames": 12, "framesDone": 4, "units": 12}, "samples": 5},
            renderWindow={"recycles": 1, "lastRecycle": {"atMs": 1, "reason": "contextLost"}},
            webgl={"cap": 16, "editor": {"live": 3, "evictions": 1, "gpuLosses": 0}, "render": {"live": 16}},
        )
        with FakeApp(self.bridge, ok_frame, kinds=KINDS, health=busy, openProject="ws:demo"):
            text = self.kb(["status"], cwd=self.root)
            data = json.loads(self.kb(["status", "--json"], cwd=self.root).stdout)
        self.assertExit(text, 0)
        self.assertIn("Captures: 2 queued (oldest 42 s), serving a capture for alpha (4/12 frames), about 400 ms a unit", text.stdout)
        self.assertIn("Render window: alive, beat 1.2 s ago; 1 recycle (last: contextLost)", text.stdout)
        self.assertIn("WebGL contexts: editor 3/16 (1 evicted, 0 GPU losses), render 16/16", text.stdout)
        self.assertEqual(data["health"], busy)
        restarting = health(gpu={"stallsLast10Min": 2}, renderWindow={"beatAgeMs": None, "restarting": True, "recycles": 2, "lastRecycle": {"atMs": 1, "reason": "silent"}})
        with FakeApp(self.bridge, ok_frame, kinds=KINDS, health=restarting):
            text = self.kb(["status"], cwd=self.root)
        self.assertIn("Render window: alive, no beat yet, restarting after a GPU stall; 2 recycles (last: silent)", text.stdout)
        with FakeApp(self.bridge, ok_frame, kinds=KINDS, health=health(gpu={"wedged": True})):
            wedged = self.kb(["status"], cwd=self.root)
        self.assertIn("GPU WEDGED", wedged.stdout)
        self.assertIn("quit and reopen Kookaburra Cut", wedged.stdout)
        with FakeApp(self.bridge, ok_frame):
            old = self.kb(["status"], cwd=self.root)
        self.assertNotIn("Captures:", old.stdout)

    def test_debug_commands(self) -> None:
        def handler(req: Dict[str, Any]) -> Dict[str, Any]:
            if req["op"] == "contexts":
                return {"ok": True, "op": "contexts", "cap": 16, "windows": {"editor": {"live": 2, "lost": 0, "deliberate": 1, "evictions": 0, "gpuLosses": 0, "contexts": [{"owner": "stage", "api": "webgl2", "width": 1920, "height": 1080, "lost": False, "ageMs": 12_000}]}, "render": {"alive": False}}, "webContentPids": {"editor": 2345, "render": None}}
            return {"ok": True, "op": req["op"], "window": req.get("window"), "lost": True}

        with FakeApp(self.bridge, handler, kinds=KINDS, health=health()) as app:
            contexts = self.kb(["debug", "contexts"], cwd=self.root)
            lose = self.kb(["debug", "lose-context", "--window", "editor", "--json"], cwd=self.root)
        self.assertExit(contexts, 0)
        self.assertIn("editor: 2 live, 0 lost (0 evicted, 0 GPU), 1 released; WebContent pid 2345", contexts.stdout)
        self.assertIn("stage webgl2 1920x1080 live, 12 s old", contexts.stdout)
        self.assertIn("render: not running", contexts.stdout)
        self.assertExit(lose, 0)
        self.assertEqual(json.loads(lose.stdout)["command"], "debug lose-context")
        self.assertEqual([(r["kind"], r["op"], r.get("window")) for r in app.requests], [("debug", "contexts", None), ("debug", "lose-context", "editor")])
        with FakeApp(self.bridge, handler):
            old = self.kb(["debug", "contexts"], cwd=self.root)
        self.assertExit(old, 2)
