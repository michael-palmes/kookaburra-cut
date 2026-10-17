from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from kblib import exporting as ex
from kblib.project import Project

from .helpers import KB, FakeApp, KbTestCase, make_project, python_argv, read_json, sleeper, write, write_json

KINDS = ["capture", "check", "fonts", "insertPreset", "mediaChanged", "openEdit", "export", "cancelExport"]
SHA = "1a2b3c4d" + "0" * 56

FAIL_ISSUE = {"type": "general", "standard": "wcag", "severity": "fail", "startMs": 1016, "endMs": 2016, "tc": "00:01.016",
              "scene": None, "flashesPerSecond": 5.0, "areaPct": 100.0, "region": [0, 0, 1, 1], "deltaL": 0.9,
              "hint": "hold each state at least 334 ms, or keep the change under 10% luminance"}


def report(*issues: Dict[str, Any]) -> Dict[str, Any]:
    return {"version": 1, "approximate": True, "standards": ["wcag-2.3.1", "itu-bt1702"], "source": "export", "fps": 60.0,
            "frames": 541, "grid": [64, 36], "ok": not any(i["severity"] == "fail" for i in issues), "issues": list(issues)}


class ExportViaBridgeTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.film = self.root / "exports" / "demo-16x9.mp4"
        write(self.film, "film bytes")

    def success(self, request: Dict[str, Any], **extra: Any) -> Dict[str, Any]:
        body = {"ok": True, "surface": "editor", "project": "ws:demo", "aspect": "16:9", "preset": "kookaburra-standard",
                "lane": "spec", "codec": "libx264", "fps": 60, "width": 3840, "height": 2160, "posterFrame": True, "frames": 541,
                "durationMs": 9016.67, "totalMs": 9000, "path": str(self.film), "bytes": 10, "sha256": SHA, "elapsedMs": 1234,
                "timeline": [{"index": 0, "stem": "01-intro", "startMs": 0, "endMs": 3000, "durationMs": 3000, "transitionIn": None},
                             {"index": 1, "stem": "02-hero", "startMs": 2400, "endMs": 5400, "durationMs": 3000,
                              "transitionIn": {"type": "crossfade", "durationMs": 600}}],
                "verify": None, "flashes": report(), "warnings": []}
        body.update(extra)
        return body

    def progress(self, request: Dict[str, Any], **fields: Any) -> None:
        body = {"version": 2, "id": request["id"], "project": "ws:demo", "updatedAtMs": int(time.time() * 1000)}
        body.update(fields)
        write_json(self.bridge / "responses" / f"{request['id']}.progress.json", body)

    def app(self, handler: Any, **heartbeat: Any) -> FakeApp:
        heartbeat.setdefault("openProject", "ws:demo")
        return FakeApp(self.bridge, handler, KINDS, **heartbeat)

    def test_progress_then_done_writes_the_record(self) -> None:
        def handler(r: Dict[str, Any]) -> Dict[str, Any]:
            if r.get("kind") != "export":
                return {"ok": False, "error": "unexpected"}
            self.progress(r, stage="preparing", prepareLabel="Loading models and images", frame=0, total=541)
            time.sleep(0.4)
            self.progress(r, stage="render", frame=270, total=541, percent=49.9, renderFps=4.1, etaMs=66_000)
            time.sleep(0.4)
            return self.success(r)

        with self.app(handler) as app:
            proc = self.kb(["export", "--progress-every", "0"], cwd=self.root)
        self.assertExit(proc, 0)
        sent = app.requests[0]
        self.assertEqual(sent["kind"], "export")
        self.assertEqual(sent["project"], "ws:demo")
        self.assertIsInstance(sent["clientPid"], int)
        self.assertFalse(sent["detach"])
        self.assertIsNone(sent["posterFrame"], "the app's setting by default")
        self.assertEqual(set(sent["sources"]), {"project.json", "scenes/01-intro.tsx", "scenes/01-intro.json", "scenes/02-hero.tsx",
                                                "scenes/02-hero.json", "scenes/03-outro.tsx", "scenes/03-outro.json"})
        self.assertEqual(len(sent["sources"]["project.json"]), 64)
        self.assertEqual(sent["instancePid"], os.getpid())
        lines = proc.stdout.splitlines()
        self.assertIn("kb export: preparing (Loading models and images)", lines)
        self.assertIn("kb export: render 270/541 49% 4.1 fps eta 1m06s", lines)
        self.assertEqual(lines[-1], f"kb export: done exports/demo-16x9.mp4 sha256 {SHA[:16]}... 541 frames 9.02 s")
        record = read_json(self.bridge / "exports" / "demo" / f"{SHA[:16]}.json")
        self.assertEqual((record["sha256"], record["project"], record["lane"], record["posterFrame"], record["frames"]),
                         (SHA, "ws:demo", "spec", True, 541))
        self.assertEqual(record["timeline"][1]["transitionIn"]["durationMs"], 600)
        self.assertEqual(record["flashes"]["gate"], "export")
        self.assertEqual(record["appVersion"], "0.19.0-test")

    def test_json_streams_progress_lines_then_the_envelope(self) -> None:
        def handler(r: Dict[str, Any]) -> Dict[str, Any]:
            self.progress(r, stage="render", frame=10, total=541, percent=1.8)
            time.sleep(0.4)
            return self.success(r)

        with self.app(handler):
            proc = self.kb(["export", "--json", "--aspect", "16:9", "--poster-frame", "off", "--preset", "share-h264"], cwd=self.root)
        self.assertExit(proc, 0)
        lines = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertTrue(all(len(line.splitlines()) == 1 for line in proc.stdout.splitlines()))
        self.assertEqual(lines[0]["event"], "progress")
        final = lines[-1]
        self.assertEqual((final["ok"], final["command"], final["file"], final["sha256"]), (True, "export", "exports/demo-16x9.mp4", SHA))
        self.assertTrue(final["record"].endswith(f"{SHA[:16]}.json"))

    def test_the_request_carries_the_flags(self) -> None:
        with self.app(lambda r: self.success(r)) as app:
            proc = self.kb(["export", "--aspect", "9:16", "--fps", "30", "--short-edge", "1080", "--poster-frame", "on", "--verify"],
                           cwd=self.root)
        self.assertExit(proc, 0)
        sent = app.requests[0]
        self.assertEqual((sent["aspect"], sent["fps"], sent["shortEdge"], sent["posterFrame"], sent["verify"]), ("9:16", 30, 1080, True, True))

    def test_sources_cover_nested_scene_files_like_the_apps_stamps(self) -> None:
        write(self.root / "scenes" / "shared" / "util.tsx", "export const x = 1;\n")
        write(self.root / "scenes" / ".hidden" / "skip.tsx", "x\n")
        write(self.root / "scenes" / "01-intro.json.tmp", "x\n")
        sources = ex.source_hashes(Project(self.root))
        self.assertIn("scenes/shared/util.tsx", sources)
        self.assertIn("project.json", sources)
        self.assertFalse(any(".hidden" in f or f.endswith(".tmp") for f in sources))

    def test_flash_failures_exit_one_and_keep_the_file(self) -> None:
        with self.app(lambda r: self.success(r, flashes=report(FAIL_ISSUE))):
            proc = self.kb(["export", "--json"], cwd=self.root)
        self.assertExit(proc, 1)
        final = json.loads(proc.stdout.splitlines()[-1])
        self.assertEqual((final["ok"], final["code"]), (False, "flashes"))
        self.assertEqual(final["flashes"]["issues"][0]["scene"]["stem"], "01-intro")
        self.assertTrue(self.film.is_file())
        self.assertTrue((self.bridge / "exports" / "demo" / f"{SHA[:16]}.json").is_file())
        self.assertIn("--allow-flashes", proc.stderr)
        with self.app(lambda r: self.success(r, flashes=report(FAIL_ISSUE))):
            self.assertExit(self.kb(["export", "--allow-flashes"], cwd=self.root), 0)
        warn = dict(FAIL_ISSUE, severity="warn")
        with self.app(lambda r: self.success(r, flashes=report(warn))):
            proc = self.kb(["export"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("flashes: ok (0 fail, 1 warn", proc.stdout)

    def test_refusals_map_to_exit_codes(self) -> None:
        cases = [
            ({"code": "notOpen", "error": "on the Welcome screen", "hint": "ask the user to open this project in Kookaburra Cut, then rerun"},
             2, "not-open"),
            ({"code": "wrongProject", "error": "ws:other is open"}, 2, "wrong-project"),
            ({"code": "invalid", "error": "unknown aspect"}, 2, "usage"),
            ({"code": "refused", "error": "a scene is an error card"}, 1, "invalid"),
            ({"code": "stale", "error": "changed after kb read them", "retryAfterMs": 2000}, 3, "stale"),
            ({"code": "stale", "error": "the last reload failed", "reloadFailed": True}, 1, "invalid"),
            ({"code": "gpuStalled", "error": "GPU stalled"}, 3, "gpu-stalled"),
            ({"code": "gpuWedged", "error": "context lost"}, 2, "gpu-wedged"),
            ({"code": "cancelled", "error": "cancelled", "by": "user"}, 1, "cancelled"),
            ({"code": "verifyMismatch", "error": "not identical", "path": str(self.film), "sha256": SHA}, 1, "verify-mismatch"),
            ({"code": "acceptTimeout", "error": "no editor"}, 3, "bridge-timeout"),
        ]
        for answer, exit_code, kind in cases:
            with self.app(lambda r, a=answer: dict(a, ok=False)):
                proc = self.kb(["export", "--json"], cwd=self.root)
            self.assertExit(proc, exit_code)
            final = json.loads(proc.stdout.splitlines()[-1])
            self.assertEqual((final["code"], final["appCode"]), (kind, answer["code"]), answer)
            if kind == "not-open":
                self.assertIn("open this project", final["hint"])
        self.assertFalse(list((self.bridge / "exports").glob("demo/*.json")), "no record without a finished film")

    def test_busy_retries_then_exits_three(self) -> None:
        with self.app(lambda r: {"ok": False, "busy": True, "code": "editing", "error": "the user is typing in a field"}) as app:
            started = time.monotonic()
            proc = self.kb(["export", "--json", "--timeout", "3"], cwd=self.root)
        self.assertExit(proc, 3)
        self.assertGreaterEqual(len(app.requests), 2, "kb retried the busy answer")
        self.assertLess(time.monotonic() - started, 20)
        final = json.loads(proc.stdout.splitlines()[-1])
        self.assertEqual(final["code"], "app-busy")
        self.assertIn("typing", final["error"])

    def test_the_timeout_cancels_the_export(self) -> None:
        def handler(r: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            if r.get("kind") == "cancelExport":
                export_id = r.get("target")
                write_json(self.bridge / "responses" / f"{export_id}.json",
                           {"version": 2, "id": export_id, "ok": False, "code": "cancelled", "cancelled": True, "by": "client",
                            "error": "cancelled"})
                return {"ok": True, "cancelled": True, "state": "cancelling", "target": export_id}
            self.progress(r, stage="render", frame=1, total=541)
            return None

        with self.app(handler) as app:
            proc = self.kb(["export", "--json", "--timeout", "2"], cwd=self.root)
        self.assertExit(proc, 1)
        kinds = [r.get("kind") for r in app.requests]
        self.assertEqual(kinds, ["export", "cancelExport"])
        self.assertEqual(app.requests[1]["target"], app.requests[0]["id"])
        final = json.loads(proc.stdout.splitlines()[-1])
        self.assertEqual(final["code"], "timeout")

    def test_sigterm_cancels_and_exits_130(self) -> None:
        def handler(r: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            if r.get("kind") == "cancelExport":
                return {"ok": True, "cancelled": True, "state": "cancelling"}
            self.progress(r, stage="render", frame=1, total=541)
            return None

        with self.app(handler) as app:
            env = dict(self.env)
            kb = subprocess.Popen(python_argv(KB) + ["export", "--json"], cwd=str(self.root), env=env, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 15
            while not app.requests and time.monotonic() < deadline:
                time.sleep(0.05)
            time.sleep(0.3)
            kb.send_signal(signal.SIGTERM)
            out, err = kb.communicate(timeout=30)
        self.assertEqual(kb.returncode, 130, err)
        self.assertIn("cancelExport", [r.get("kind") for r in app.requests])
        self.assertEqual(json.loads(out.splitlines()[-1])["code"], "interrupted")

    def test_no_app_and_an_older_app(self) -> None:
        self.assertExit(self.kb(["export"], cwd=self.root), 2)
        with FakeApp(self.bridge, lambda r: {"ok": True}, openProject="ws:demo"):
            proc = self.kb(["export"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("does not answer export requests", proc.stderr)

    def test_verify_refuses_a_hardware_preset_before_asking(self) -> None:
        catalog = read_json(Path(self.env["KB_CATALOG"]))
        catalog["exportPresets"] = [{"id": "fast-draft", "fps": 60, "hardware": True, "aspects": ["16:9"]}]
        path = self.tmp / "catalog.json"
        write_json(path, catalog)
        proc = self.kb(["export", "--verify", "--preset", "fast-draft"], cwd=self.root, env={"KB_CATALOG": str(path)})
        self.assertExit(proc, 2)
        self.assertIn("VideoToolbox", proc.stderr)


FAKE_APP = r'''
import json, os, sys, time
from pathlib import Path
knobs = json.loads(Path(sys.argv[0] + ".knobs.json").read_text())
args = sys.argv[1:]
if args[:2] == ["edit", "caps"]:
    caps = {"ok": True, "cli": 1, "appVersion": "0.19.0-fake", "build": "release", "exe": sys.argv[0],
            "commands": ["caps", "probe", "create", "validate", "save", "render"], "checks": ["flashes"],
            "autorun": {"actions": ["export", "verify"], "trust": ["stored-only"], "poster": True, "progress": True},
            "ffmpeg": {"path": "/usr/bin/false", "ok": True}, "ffprobe": {"path": "/usr/bin/false", "ok": True}}
    caps.update(knobs.get("caps") or {})
    print(json.dumps(caps))
    sys.exit(0)
env = {k: v for k, v in os.environ.items() if k.startswith("KOOKABURRA_")}
out = Path(env["KOOKABURRA_RESULT_DIR"])
(out / "env.json").write_text(json.dumps(env))
if knobs.get("hang"):
    (out / "progress.json").write_text(json.dumps({"stage": "render", "frame": 1, "total": 541, "updatedAtMs": 1}))
    exports = Path(knobs["project"]) / "exports"
    exports.mkdir(exist_ok=True)
    (exports / ".demo-16x9.part.mp4").write_text("partial")
    time.sleep(120)
for frame in (0, 270):
    (out / ".p").write_text(json.dumps({"version": 1, "stage": "render" if frame else "preparing", "frame": frame, "total": 541,
                                        "percent": frame / 5.41, "updatedAtMs": frame + 1}))
    os.replace(out / ".p", out / "progress.json")
    time.sleep(0.4)
result = knobs.get("result")
if result is None:
    film = Path(knobs["project"]) / "exports" / "demo-16x9.mp4"
    film.parent.mkdir(exist_ok=True)
    film.write_text("headless film")
    row = {"aspect": env.get("KOOKABURRA_ASPECT", "16:9"), "project": env["KOOKABURRA_PROJECT"], "path": str(film), "fps": 60,
           "posterFrame": env.get("KOOKABURRA_POSTER") == "on"}
    row.update(knobs.get("row") or {})
    result = {"action": env["KOOKABURRA_ACTION"], "project": env["KOOKABURRA_PROJECT"], "codec": "libx264", "ok": True,
              "durationMs": 1, "results": [row]}
(out / "last-run.json").write_text(json.dumps(result, indent=2))
'''


class HeadlessTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.autorun = self.tmp / "_autorun"
        self.env["KB_AUTORUN_DIR"] = str(self.autorun)
        os.environ["KB_AUTORUN_DIR"] = str(self.autorun)
        self.addCleanup(os.environ.pop, "KB_AUTORUN_DIR", None)

    def fake_app(self, **knobs: Any) -> Path:
        script = self.tmp / "app" / "fake_app.py"
        write(script, FAKE_APP)
        binary = self.tmp / "app" / "kookaburra-cut"
        knobs.setdefault("project", str(self.root))
        write_json(Path(str(script) + ".knobs.json"), knobs)
        write(binary, f"#!/bin/sh\nexec {' '.join(python_argv(script)[:3])} {script} \"$@\"\n")
        binary.chmod(0o755)
        self.env["KB_APP_BIN"] = str(binary)
        return binary

    def test_a_headless_export_queues_runs_stored_only_and_records(self) -> None:
        self.fake_app()
        proc = self.kb(["export", "--headless", "--progress-every", "0", "--json"], cwd=self.root)
        self.assertExit(proc, 0)
        lines = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertIn("preparing", [line.get("stage") for line in lines])
        final = lines[-1]
        self.assertEqual((final["ok"], final["surface"], final["file"]), (True, "headless", "exports/demo-16x9.mp4"))
        film = self.root / "exports" / "demo-16x9.mp4"
        self.assertEqual(final["sha256"], ex.file_hash(film))
        runs = list((self.autorun / "runs").iterdir())
        env = read_json(runs[0] / "env.json")
        self.assertEqual(env["KOOKABURRA_TRUST"], "stored-only")
        self.assertEqual((env["KOOKABURRA_ACTION"], env["KOOKABURRA_POSTER"], env["KOOKABURRA_PROGRESS"]), ("export", "app", "1"))
        self.assertEqual(env["KOOKABURRA_WORKSPACE_ROOT"], str(self.tmp))
        self.assertEqual(env["KOOKABURRA_ASPECT"], "16:9")
        self.assertNotIn("KOOKABURRA_PRESET", env)
        self.assertEqual(list((self.autorun / "queue").glob("*.json")), [], "the ticket is released")
        record = read_json(self.bridge / "exports" / "demo" / f"{final['sha256'][:16]}.json")
        self.assertEqual((record["lane"], record["frames"], record["fps"], record["totalMs"]), ("frozen", 468, 60, 7800))

    def test_a_project_that_changed_needs_the_users_trust(self) -> None:
        self.fake_app(result={"ok": False, "error": 'Project "demo" changed since it was last opened', "needsTrust": True})
        proc = self.kb(["export", "--headless", "--json"], cwd=self.root)
        self.assertExit(proc, 2)
        final = json.loads(proc.stdout.splitlines()[-1])
        self.assertEqual(final["code"], "needs-trust")
        self.assertIn("open the project once", final["hint"])

    def test_only_a_release_build_that_knows_headless_runs(self) -> None:
        for caps, words in (({"build": "dev"}, "development build"),
                            ({"autorun": None}, "predates headless"),
                            ({"autorun": {"actions": ["export", "verify"], "trust": [], "poster": True, "progress": True}}, "predates headless")):
            self.fake_app(caps=caps)
            proc = self.kb(["export", "--headless"], cwd=self.root)
            self.assertExit(proc, 2)
            self.assertIn(words, proc.stderr)
        self.fake_app()
        proc = self.kb(["export", "--headless", "--fps", "30"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("Custom panel", proc.stderr)

    def test_an_open_app_means_drop_headless(self) -> None:
        self.fake_app()
        with FakeApp(self.bridge, lambda r: None, KINDS, openProject=None):
            proc = self.kb(["export", "--headless"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("drop --headless", proc.stderr)
        self.assertFalse((self.autorun / "runs").exists(), "nothing ran")

    def test_the_timeout_stops_the_run_and_cleans_up(self) -> None:
        self.fake_app(hang=True)
        proc = self.kb(["export", "--headless", "--timeout", "3"], cwd=self.root)
        self.assertExit(proc, 1)
        self.assertIn("did not finish within 3 s", proc.stderr)
        self.assertEqual(list((self.root / "exports").glob(".*.part.*")), [])
        self.assertEqual(list((self.autorun / "queue").glob("*.json")), [])

    def test_a_preset_keeps_the_projects_first_format_when_it_allows_it(self) -> None:
        project = Project(self.root)
        args = type("A", (), {"aspect": None, "preset": None})()
        self.assertEqual(ex.headless_aspect(project, args), "16:9")
        catalog = read_json(Path(self.env["KB_CATALOG"]))
        catalog["exportPresets"] = [{"id": "tiktok", "aspects": ["9:16", "1:1"], "favouredAspect": "9:16", "fps": 30},
                                    {"id": "share-h264", "aspects": ["16:9", "9:16"], "favouredAspect": "16:9", "fps": 60}]
        path = self.tmp / "catalog.json"
        write_json(path, catalog)
        os.environ["KB_CATALOG"] = str(path)
        from kblib.catalog import reset_cache

        reset_cache()
        args.preset = "tiktok"
        self.assertEqual(ex.headless_aspect(project, args), "9:16")
        args.preset = "share-h264"
        self.assertEqual(ex.headless_aspect(project, args), "16:9")
        args.preset = "ws:client"
        self.assertIsNone(ex.headless_aspect(project, args), "a user preset takes its favoured aspect in the app")


class TicketTests(KbTestCase):
    def test_the_queue_is_fifo_and_sweeps_dead_runs(self) -> None:
        queue = self.tmp / "queue"
        project = Project(make_project(self.tmp))
        live = sleeper(self)
        write_json(queue / f"{1:012d}-{live.pid}.json", {"pid": live.pid, "action": "verify", "project": "x"})
        write_json(queue / f"{0:012d}-999999.json", {"pid": 999_999_9, "action": "verify", "project": "gone"})
        ticket = ex.Ticket(queue, "export", project)
        notes: List[str] = []
        reporter = ex.Reporter(False, 0)
        reporter.note = notes.append  # type: ignore[method-assign]
        waits: List[float] = []

        def sleep(s: float) -> None:
            waits.append(s)
            if len(waits) == 2:
                live.kill()
                live.wait()

        ticket.wait(time.monotonic() + 30, reporter, sleep=sleep)
        self.assertEqual(ticket.front(), ticket.path)
        self.assertFalse((queue / f"{0:012d}-999999.json").exists(), "a dead run's ticket is swept")
        self.assertTrue(any("queued behind verify x" in n for n in notes))
        body = json.loads(ticket.path.read_text())
        self.assertEqual((body["pid"], body["action"], body["project"]), (os.getpid(), "export", "ws:demo"))
        self.assertRegex(ticket.path.name, r"^\d{12}-\d+\.json$")
        ticket.release()
        self.assertFalse(ticket.path.exists())

    def test_a_held_queue_times_out_without_touching_the_holder(self) -> None:
        queue = self.tmp / "queue"
        live = sleeper(self)
        holder = queue / f"{0:012d}-{live.pid}.json"
        write_json(holder, {"pid": live.pid, "action": "verify", "project": "x"})
        ticket = ex.Ticket(queue, "export", Project(make_project(self.tmp)))
        quiet = ex.Reporter(True, 0)
        quiet.note = lambda text: None  # type: ignore[method-assign]
        with self.assertRaises(ex.KbError) as caught:
            ticket.wait(time.monotonic() + 0.1, quiet, sleep=lambda s: None)
        self.assertEqual(caught.exception.code, 3)
        self.assertTrue(holder.exists())
        self.assertIsNone(live.poll())
        ticket.release()


class ProgressTextTests(KbTestCase):
    def test_lines(self) -> None:
        self.assertEqual(ex.progress_text({"stage": "render", "frame": 1234, "total": 3901, "percent": 31.6, "renderFps": 4.1, "etaMs": 645_000}),
                         "render 1234/3901 31% 4.1 fps eta 10m45s")
        self.assertEqual(ex.progress_text({"stage": "render", "frame": 5, "total": 10, "run": 2, "runs": 2, "percent": 75}),
                         "render 5/10 (2/2) 75%")
        self.assertEqual(ex.progress_text({"stage": "pass2"}), "encoding pass 2/2")
        self.assertEqual(ex.progress_text({"stage": "syncing"}), "syncing")
        self.assertEqual(ex.fmt_eta(7_500_000), "2h05m")

    def test_a_line_per_stage_and_per_interval(self) -> None:
        clock = [0.0]
        reporter = ex.Reporter(False, 10, clock=lambda: clock[0])
        printed = []
        original = ex.emit
        ex.emit = printed.append  # type: ignore[assignment]
        try:
            for t, stage, frame in ((0, "syncing", 0), (1, "render", 1), (5, "render", 20), (11.5, "render", 50), (12, "finalising", 99)):
                clock[0] = t
                reporter.progress({"stage": stage, "frame": frame, "total": 99, "updatedAtMs": t})
        finally:
            ex.emit = original  # type: ignore[assignment]
        self.assertEqual([p.split(": ", 1)[1].split(" ")[0] for p in printed], ["syncing", "render", "render", "finalising"])
