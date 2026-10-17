from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List

from kblib.project import Project
from kblib.util import KbError
from kblib.video import appcli, editdoc

from .helpers import KbTestCase, video_project, write_json


def doc_for(name: str = "rec") -> Dict[str, Any]:
    return {
        "version": 1, "name": name,
        "sources": [{"id": "s1", "rel": "assets/rec.mp4", "kind": "video", "width": 1920, "height": 1080, "fps": 60, "durationMs": 10000}],
        "settings": {"width": 1920, "height": 1080, "fps": 60},
        "clips": [{"id": "c1", "sourceId": "s1", "inMs": 0, "outMs": 1000, "speed": 1, "startMs": 0}],
    }


class LocateTests(KbTestCase):
    def heartbeat(self, **fields: Any) -> None:
        body = {"version": 2, "pid": os.getpid(), "updatedAtMs": int(time.time() * 1000), "kinds": ["capture"]}
        body.update(fields)
        write_json(self.bridge / "app.json", body)

    def test_kb_app_bin_is_exclusive(self) -> None:
        good = self.fake_cli(self.tmp / "dev" / "kookaburra-cut")
        write_json(self.bridge / "cli.json", {"path": str(good), "cli": 1})
        with self.assertRaises(KbError) as cm:
            appcli.locate()
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("KB_APP_BIN", cm.exception.message)
        os.environ["KB_APP_BIN"] = str(good)
        self.assertEqual(appcli.locate().source, "KB_APP_BIN")

    def test_order_heartbeat_then_installed_app_then_cli_json(self) -> None:
        self.no_app_bin()
        live = self.fake_cli(self.tmp / "live" / "kookaburra-cut")
        recorded = self.fake_cli(self.tmp / "recorded" / "kookaburra-cut")
        app = self.fake_bundle({"CFBundleShortVersionString": "0.19.0", "KookaburraEditCli": 1})
        os.environ["KB_RESOURCES_DIR"] = str(app / "Contents" / "Resources")
        self.heartbeat(cliPath=str(live), cliVersion=1, appVersion="0.19.0-dev")
        write_json(self.bridge / "cli.json", {"path": str(recorded), "cli": 1, "appVersion": "0.19.0-rec"})
        found = appcli.locate()
        self.assertEqual((found.path, found.source, found.app_version), (str(live), "heartbeat", "0.19.0-dev"))
        self.heartbeat(cliPath=str(live), updatedAtMs=1)
        found = appcli.locate()
        self.assertEqual((found.source, found.app_version), ("KB_RESOURCES_DIR", "0.19.0"))
        os.environ["KB_RESOURCES_DIR"] = str(self.tmp / "NoApp" / "Contents" / "Resources")
        self.assertEqual(appcli.locate().source, "cli.json")

    def test_plist_gate_never_runs_an_old_bundle(self) -> None:
        self.no_app_bin()
        marker = self.tmp / "ran.txt"
        app = self.fake_bundle({"CFBundleShortVersionString": "0.18.0"}, ran=marker)
        os.environ["KB_RESOURCES_DIR"] = str(app / "Contents" / "Resources")
        with self.assertRaises(KbError) as cm:
            appcli.caps()
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("Kookaburra Cut 0.18.0 predates terminal video editing; ask the user to update the app", cm.exception.message)
        self.assertFalse(marker.exists())
        with open(app / "Contents" / "Info.plist", "wb") as f:
            import plistlib

            plistlib.dump({"CFBundleShortVersionString": "0.18.0", "KookaburraEditCli": True}, f)
        with self.assertRaises(KbError):
            appcli.locate()
        status = appcli.locate_status()
        self.assertFalse(status["ok"])
        self.assertIn("predates", status["error"])
        self.assertFalse(marker.exists())

    def test_resources_override_keeps_tests_away_from_applications(self) -> None:
        self.no_app_bin()
        with self.assertRaises(KbError) as cm:
            appcli.locate()
        self.assertIn("no Kookaburra Cut with terminal video editing", cm.exception.message)


class RunTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = video_project(self.tmp)
        self.project = Project(self.root)

    def log_lines(self, log: Path) -> List[List[str]]:
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def test_caps_gate_and_cache(self) -> None:
        log = self.tmp / "argv.log"
        self.fake_cli(log=log)
        self.assertEqual(appcli.caps()["cli"], 1)
        appcli.caps()
        self.assertEqual(sum(1 for a in self.log_lines(log) if a[1] == "caps"), 1)
        self.fake_cli(caps='{"cli": 0}')
        with self.assertRaises(KbError) as cm:
            appcli.caps()
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("older edit CLI", cm.exception.message)
        self.fake_cli(self.tmp / "bin2" / "kookaburra-cut", caps='{"commands": ["caps", "probe"]}')
        os.environ["KB_APP_BIN"] = str(self.tmp / "bin2" / "kookaburra-cut")
        with self.assertRaises(KbError) as cm:
            appcli.caps()
        self.assertIn("no create", cm.exception.message)

    def test_malformed_output_is_exit_2(self) -> None:
        self.fake_cli(malformed="caps")
        with self.assertRaises(KbError) as cm:
            appcli.caps()
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("gave no JSON", cm.exception.message)

    def test_probe_create_validate_save(self) -> None:
        log = self.tmp / "argv.log"
        self.fake_cli(log=log)
        self.assertEqual(appcli.probe(self.project, "assets/rec.mp4")["durationMs"], 10000)
        appcli.probe(self.project, "assets/rec.mp4")
        self.assertEqual(sum(1 for a in self.log_lines(log) if a[1] == "probe"), 1)
        self.assertEqual(appcli.source_meta(self.project, "assets/rec.mp4")["kind"], "video")
        made = appcli.create(self.project, "assets/rec.mp4")
        self.assertTrue(made["created"])
        with self.assertRaises(appcli.CliError) as cm:
            appcli.create(self.project, "assets/rec.mp4")
        self.assertEqual(cm.exception.cli_code, "exists")
        self.assertEqual(cm.exception.data["sourceRel"], "assets/rec.mp4")
        report = appcli.validate(self.project, name="rec")
        self.assertTrue(report["ok"])
        self.assertEqual(report["totalFrames"], 600)
        with self.assertRaises(appcli.CliError) as cm:
            appcli.save(self.project, "rec", doc_for(), "0" * 64)
        self.assertEqual(cm.exception.cli_code, "conflict")
        saved = appcli.save(self.project, "rec", doc_for(), made["hash"])
        self.assertEqual(saved["hash"], editdoc.file_sha(editdoc.edit_path(self.project, "rec")))

    def test_render_streams_events_and_returns_done(self) -> None:
        self.fake_cli()
        appcli.create(self.project, "assets/rec.mp4")
        events: List[Dict[str, Any]] = []
        done = appcli.render(self.project, name="rec", on_event=events.append)
        self.assertEqual(events[0]["event"], "start")
        self.assertEqual(events[-1]["event"], "done")
        self.assertTrue(any(e["event"] == "progress" for e in events))
        self.assertEqual(done["rel"], "assets/rec-edited.mp4")
        self.assertTrue((self.root / "assets" / "rec-edited.mp4").is_file())
        self.assertEqual(editdoc.render_state(self.project, "rec"), "fresh")

    def test_render_failure_keeps_the_old_file(self) -> None:
        self.fake_cli()
        appcli.create(self.project, "assets/rec.mp4")
        appcli.render(self.project, name="rec")
        good = (self.root / "assets" / "rec-edited.mp4").read_bytes()
        self.fake_cli(fail="render")
        with self.assertRaises(appcli.CliError) as cm:
            appcli.render(self.project, name="rec")
        self.assertEqual(cm.exception.cli_code, "ffmpeg")
        self.assertEqual((self.root / "assets" / "rec-edited.mp4").read_bytes(), good)
        self.assertEqual(list((self.root / "assets" / ".kc-render").iterdir()), [])

    def test_render_timeout_kills_the_cli(self) -> None:
        self.fake_cli(sleep="0.3")
        appcli.create(self.project, "assets/rec.mp4")
        started = time.monotonic()
        with self.assertRaises(KbError) as cm:
            appcli.render(self.project, name="rec", timeout=0.5)
        self.assertLess(time.monotonic() - started, 8)
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("took longer", cm.exception.message)
        time.sleep(0.3)
        self.assertEqual(list((self.root / "assets" / ".kc-render").iterdir()), [])
        self.assertFalse((self.root / "assets" / "rec-edited.mp4").exists())

    def test_doc_render_refuses_assets_out(self) -> None:
        self.fake_cli()
        with self.assertRaises(KbError) as cm:
            appcli.render(self.project, doc=doc_for(), out=str(self.root / "assets" / "x.mp4"), draft=True)
        self.assertEqual(cm.exception.code, 2)
        out = self.tmp / "review.mp4"
        done = appcli.render(self.project, doc=doc_for(), out=str(out), draft=True)
        self.assertIsNone(done["rel"])
        self.assertEqual(done["width"], 960)
        self.assertTrue(out.is_file())

    def test_render_skips_junk_lines_and_needs_a_result(self) -> None:
        self.fake_cli(noise="1")
        appcli.create(self.project, "assets/rec.mp4")
        events: List[Dict[str, Any]] = []
        done = appcli.render(self.project, name="rec", on_event=events.append)
        self.assertEqual(done["frames"], 600)
        self.assertTrue(all(isinstance(e, dict) and "event" in e for e in events))
        self.fake_cli(malformed="render")
        with self.assertRaises(KbError) as cm:
            appcli.render(self.project, name="rec")
        self.assertIn("without a result", cm.exception.message)
