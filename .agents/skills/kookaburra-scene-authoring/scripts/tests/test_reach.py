"""kb's reach: output escaping, reads outside the workspace, writes confined to picked folders."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

from kblib import reach
from kblib.project import Project
from kblib.util import KbError, clean_lines, clean_text, clean_value

from .helpers import FakeApp, KbTestCase, make_project, png_bytes, write_json

KINDS = ["capture", "check", "fonts", "insertPreset", "mediaChanged", "openEdit", "debug"]
OSC52 = "Hero\x1b]52;c;aGVsbG8=\x07 title"


def ok_frame(req: Dict[str, Any]) -> Dict[str, Any]:
    return {"ok": True, "path": f"/tmp/{req['id']}.png", "project": req.get("project"), "format": "16:9"}


class CleanTextTests(KbTestCase):
    def test_controls_and_format_characters_become_visible_escapes(self) -> None:
        self.assertEqual(clean_text(OSC52), "Hero\\u001B]52;c;aGVsbG8=\\u0007 title")
        self.assertEqual(clean_text("a‮b​c"), "a\\u202Eb\\u200Bc")
        self.assertEqual(clean_text("tag\U000e0041"), "tag\\U000E0041")
        self.assertEqual(clean_text("keep\n\ttabs"), "keep\n\ttabs")
        self.assertEqual(clean_text("plain ünïcödé 🎬"), "plain ünïcödé 🎬")
        self.assertEqual(clean_text(42), 42)

    def test_long_strings_are_capped_per_string_and_per_line(self) -> None:
        long = "x" * 525
        self.assertEqual(clean_text(long), "x" * 500 + " …[+25 chars]")
        self.assertEqual(clean_text("y" * 500), "y" * 500)
        lines = clean_lines("a" * 600 + "\nshort")
        self.assertTrue(lines.startswith("a" * 500 + " …[+100 chars]\nshort"))

    def test_json_values_are_cleaned_keys_included(self) -> None:
        value = clean_value({"na‏me": [OSC52, 1.5, {"deep": "\x9dx"}], "ok": True})
        self.assertEqual(value["na\\u200Fme"][0], "Hero\\u001B]52;c;aGVsbG8=\\u0007 title")
        self.assertEqual(value["na\\u200Fme"][2]["deep"], "\\u009Dx")
        self.assertIs(value["ok"], True)

    def test_errors_and_issues_are_cleaned_at_birth(self) -> None:
        e = KbError(f"scene {OSC52} is broken", hint="fix \x1b[2J it")
        self.assertNotIn("\x1b", e.message + str(e.hint))
        self.assertIn("\\u001B", e.message)


class EscapedOutputTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp, scenes=["01-intro"])
        write_json(self.root / "scenes" / "01-intro.json", {"version": 1, "name": OSC52})

    def test_a_scene_name_with_an_osc_sequence_reaches_the_agent_escaped(self) -> None:
        text = self.kb(["scenes"], cwd=self.root)
        self.assertExit(text, 0)
        self.assertNotIn("\x1b", text.stdout)
        self.assertIn("\\u001B]52;", text.stdout)
        data = self.kb(["scenes", "--json"], cwd=self.root)
        self.assertExit(data, 0)
        self.assertNotIn("\x1b", data.stdout)
        self.assertIn("\\u001B]52;", json.loads(data.stdout)["scenes"][0]["name"])
        hook = self.kb(["hook", "session-start"], cwd=self.root, stdin=json.dumps({"session_id": "s1", "cwd": str(self.root)}))
        self.assertExit(hook, 0)
        self.assertNotIn("\x1b", hook.stdout)
        self.assertIn("\\u001B]52;", hook.stdout)


class ReadGuardTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)

    def test_reads_inside_the_workspace_are_silent(self) -> None:
        inside = self.tmp / "clip.png"
        inside.write_bytes(png_bytes())
        proc = self.kb(["assets", "add", str(inside), "--no-conform", "--json"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertNotIn("outside the workspace", proc.stderr)

    def test_reads_outside_the_workspace_are_announced_with_the_resolved_path(self) -> None:
        outside = Path(os.path.realpath(self.tmp.parent)) / f"kbtest-outside-{os.getpid()}.png"
        outside.write_bytes(png_bytes())
        try:
            proc = self.kb(["assets", "add", str(outside), "--no-conform", "--json"], cwd=self.root)
            self.assertExit(proc, 0)
            self.assertIn(f"kb: reading {outside} ({len(png_bytes())} bytes) from outside the workspace", proc.stderr)
        finally:
            outside.unlink()

    def test_credential_files_are_refused(self) -> None:
        home = Path(os.path.realpath(os.path.expanduser("~")))
        for raw in ("~/.ssh/id_ed25519", "~/.aws/credentials", "~/.config/gh/hosts.yml", "~/.gnupg/pubring.kbx",
                    "~/Library/Keychains/login.keychain-db", "/tmp/x/.env", "/tmp/x/.env.local", "/tmp/.netrc",
                    "/tmp/server.pem", "/tmp/id.p12", "/tmp/private.key", "~/.zsh_history", "~/.bash_history"):
            with self.assertRaises(KbError, msg=raw) as caught:
                reach.guard_read_at(self.root, raw, "the file")
            self.assertEqual(caught.exception.code, 2, raw)
            self.assertIn("never reads credentials", caught.exception.message)
        self.assertIsNone(reach.denied_reason(home / "Documents" / "deck.pdf"))
        self.assertIsNone(reach.denied_reason(home / "keynote.key.png"))
        proc = self.kb(["assets", "add", "~/.ssh/id_ed25519", "--json"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertEqual(json.loads(proc.stdout)["code"], "usage")


class WriteGuardTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp, scenes=["01-intro"])
        self.outside = Path(os.path.realpath(self.tmp.parent)) / f"kbtest-desk-{os.getpid()}"

    def tearDown(self) -> None:
        if self.outside.is_dir():
            for p in self.outside.iterdir():
                p.unlink()
            self.outside.rmdir()
        super().tearDown()

    def test_capture_out_outside_the_workspace_is_refused_naming_the_roots(self) -> None:
        with FakeApp(self.bridge, ok_frame, kinds=KINDS):
            proc = self.kb(["capture", "--scene", "0", "--out", str(self.outside), "--json"], cwd=self.root)
        self.assertExit(proc, 2)
        body = json.loads(proc.stdout)
        self.assertEqual(body["code"], "usage")
        self.assertIn("none picked yet", body["error"])
        self.assertIn(str(self.root), body["error"])
        self.assertIn("Kookaburra Cut", body["error"])
        self.assertFalse(self.outside.exists())

    def test_a_folder_the_app_dialog_returned_is_allowed(self) -> None:
        self.outside.mkdir()
        with FakeApp(self.bridge, ok_frame, kinds=KINDS, pickedDirs=[str(self.outside)]):
            proc = self.kb(["capture", "--scene", "0", "--out", str(self.outside / "shots"), "--json"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertTrue((self.outside / "shots").is_dir())
        for p in (self.outside / "shots").iterdir():
            p.unlink()
        (self.outside / "shots").rmdir()

    def test_the_archive_folder_follows_the_same_rule(self) -> None:
        project = Project(self.root)
        with self.assertRaises(KbError) as caught:
            reach.guard_write(project, str(self.outside), "--archive")
        self.assertIn("--archive", caught.exception.message)
        self.assertEqual(reach.guard_write(project, str(self.tmp / "aside"), "--archive"),
                         Path(os.path.realpath(self.tmp / "aside")))
