"""A folder shared by zip, copy or clone keeps its links: none of them may steer kb's writes or deletes outside the project."""

from __future__ import annotations

import json
import os
import shutil
import types
from typing import List

from .helpers import HOSTILE_KB_FILES, HOSTILE_KB_FOLDERS, KbTestCase, git_init, make_project, plant_link, tree_bytes


class HostileFolder(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.project = make_project(self.tmp, git=False)
        self.victim = self.tmp / "victim"
        self.victim.mkdir()
        (self.victim / "thesis.txt").write_text("precious")
        for name in ("notes.md", "lock", "events.jsonl", "01-intro.json"):
            (self.victim / name).write_text("mine")
        for i in range(8):
            (self.victim / f"keep-{i}").mkdir()
            (self.victim / f"keep-{i}" / "doc.txt").write_text("mine")
        for i in range(45):
            folder = self.victim / f"20260101-0000{i:02d}"
            folder.mkdir()
            (folder / "frame.png").write_text("mine")
        self.before = tree_bytes(self.victim)

    def untouched(self) -> None:
        self.assertEqual(tree_bytes(self.victim), self.before)

    def refused(self, args: List[str], rel: str) -> None:
        proc = self.kb([*args, "--json"], cwd=self.project)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        body = json.loads(proc.stdout)
        self.assertEqual(body["code"], "not-a-folder")
        self.assertIn(rel, body["error"])
        self.assertNotIn("Traceback", proc.stderr)
        self.untouched()

    def link_folder(self, rel: str) -> None:
        plant_link(self.project, rel, self.victim)

    def test_a_linked_kb_folder_refuses_every_write_by_name(self) -> None:
        self.link_folder(".kb")
        self.refused(["note", "hello"], ".kb")
        self.refused(["lease", "01-intro", "--agent", "alpha"], ".kb")
        self.refused(["doc", "01-intro", "set", "name", "Other"], ".kb")
        self.refused(["checkpoint", "x"], ".kb")

    def test_a_file_where_kb_expects_its_folder_is_refused(self) -> None:
        (self.project / ".kb").write_text("not a folder")
        proc = self.kb(["note", "hello", "--json"], cwd=self.project)
        self.assertExit(proc, 1)
        self.assertEqual(json.loads(proc.stdout)["code"], "not-a-folder")
        self.assertEqual((self.project / ".kb").read_text(), "not a folder")

    def test_linked_scratch_folders_are_refused_by_name(self) -> None:
        self.link_folder(".kb/leases")
        self.refused(["lease", "01-intro", "--agent", "alpha"], ".kb/leases")
        (self.project / ".kb" / "leases").unlink()

        self.link_folder(".kb/archive")
        (self.project / "assets" / "spare.png").write_bytes(b"x")
        self.refused(["assets", "unused", "--archive"], ".kb/archive")
        self.assertTrue((self.project / "assets" / "spare.png").exists())
        (self.project / ".kb" / "archive").unlink()

    def test_status_never_writes_through_a_linked_agents_folder(self) -> None:
        self.link_folder(".kb/agents")
        proc = self.kb(["--agent", "alpha", "status"], cwd=self.project)
        self.assertNotIn("Traceback", proc.stderr)
        self.untouched()

    def test_file_links_are_refused_and_their_targets_keep_their_bytes(self) -> None:
        for rel in HOSTILE_KB_FILES:
            with self.subTest(rel):
                plant_link(self.project, rel, self.victim / "thesis.txt")
                proc = self.kb(["note", "hello"], cwd=self.project)
                self.assertNotIn("Traceback", proc.stderr)
                self.untouched()
                shutil.rmtree(self.project / ".kb")

    def test_a_dangling_lock_link_creates_nothing_behind_it(self) -> None:
        plant_link(self.project, ".kb/lock", self.victim / "made-by-kb")
        self.refused(["note", "hello"], ".kb/lock")
        self.assertFalse((self.victim / "made-by-kb").exists())

    def test_every_scratch_root_refuses_before_a_prune_can_delete(self) -> None:
        from kblib import capture, verify
        from kblib.project import Project
        from kblib.util import KbError

        project = Project(self.project)
        self.link_folder(".kb/captures")
        with self.assertRaises(KbError) as caught:
            capture.prune_captures(capture.captures_root(project))
        self.assertEqual(caught.exception.kind, "not-a-folder")
        self.untouched()

        self.link_folder(".kb/verify")
        with self.assertRaises(KbError):
            verify.keep_draft(project, str(self.project / "project.json"), verify.drafts_root(project) / "held-1")
        self.untouched()

    def test_every_listed_folder_refuses_through_the_write_path(self) -> None:
        from kblib import lock
        from kblib.util import KbError

        for rel in HOSTILE_KB_FOLDERS[1:]:
            with self.subTest(rel):
                self.link_folder(rel)
                with self.assertRaises(KbError) as caught:
                    lock.write_if_unchanged(self.project / rel / "x.json", lock.ABSENT, b"{}")
                self.assertEqual(caught.exception.kind, "not-a-folder")
                self.assertIn(rel, caught.exception.message)
                (self.project / rel).unlink()
        self.untouched()

    def test_atomic_writes_refuse_a_linked_folder_too(self) -> None:
        from kblib.util import KbError, atomic_write_json

        self.link_folder(".kb/verify")
        with self.assertRaises(KbError):
            atomic_write_json(self.project / ".kb" / "verify" / "last.json", {})
        self.untouched()

    def test_a_transaction_never_moves_or_trashes_through_a_link(self) -> None:
        from kblib import lock
        from kblib.util import KbError

        self.link_folder(".kb/archive")
        (self.victim / "kept.png").write_bytes(b"mine")
        self.before = tree_bytes(self.victim)
        with self.assertRaises(KbError):
            with lock.project_txn(self.project, "test") as tx:
                tx.move(".kb/archive/kept.png", "assets/kept.png")
        self.assertFalse((self.project / "assets" / "kept.png").exists())
        self.untouched()

    def test_hooks_fail_open_and_write_nothing_through_a_link(self) -> None:
        self.link_folder(".kb")
        payload = {
            "session_id": "s1",
            "tool_use_id": "t1",
            "cwd": str(self.project),
            "tool_name": "Bash",
            "tool_input": {"command": "./kb note hello --agent alpha"},
        }
        env = {"CLAUDE_PROJECT_DIR": str(self.project)}
        for event in ("session-start", "bash-pre", "bash-post"):
            proc = self.kb(["hook", event], cwd=self.project, stdin=json.dumps(payload), env=env)
            self.assertExit(proc, 0)
            self.assertNotIn("Traceback", proc.stderr)
        edit = dict(payload, tool_name="Write", tool_input={"file_path": str(self.project / "scenes" / "01-intro.json"), "content": "{}"})
        for event in ("pre-edit", "post-edit"):
            proc = self.kb(["hook", event], cwd=self.project, stdin=json.dumps(edit), env=env)
            self.assertNotIn("Traceback", proc.stderr)
        self.untouched()

    def test_a_linked_staging_folder_is_never_listed_or_archived(self) -> None:
        self.link_folder("assets/.kc-render")
        proc = self.kb(["assets", "unused", "--archive"], cwd=self.project)
        self.assertNotIn("Traceback", proc.stderr)
        self.untouched()
        self.assertTrue(os.path.islink(self.project / "assets" / ".kc-render"))

    def test_flash_and_preview_prunes_never_follow_a_link(self) -> None:
        from kblib import preview
        from kblib.film import flashes, ranged
        from kblib.project import Project
        from kblib.util import KbError

        project = Project(self.project)
        self.link_folder(".kb/flashes")
        with self.assertRaises(KbError):
            ranged.run_folder(project)
        self.assertIsNone(flashes.load_last(project))
        self.assertEqual(flashes.settle(project, {"issues": []}, "test")["issues"], [])
        self.untouched()

        self.link_folder(".kb/previews")
        (self.victim / "a.mp4").write_bytes(b"mine")
        self.before = tree_bytes(self.victim)
        with self.assertRaises(KbError):
            preview.out_path(project, "span", ".mp4")
        self.untouched()

    def test_a_linked_strips_folder_is_refused_and_the_check_still_reports(self) -> None:
        from kblib.film import flashes
        from kblib.project import Project

        (self.project / "exports").mkdir()
        film = self.project / "exports" / "cut.mp4"
        film.write_bytes(b"film")
        (self.victim / "strip-01.png").write_bytes(b"mine")
        self.before = tree_bytes(self.victim)
        self.link_folder("exports/cut.mp4.flashes")
        tools = types.SimpleNamespace(ffmpeg="/nonexistent/ffmpeg")
        report = flashes.settle(Project(self.project), {"issues": []}, "test", film=film, tools=tools, fps=30.0)
        self.assertIn("cut.mp4.flashes", report["stripsError"])
        self.untouched()

    def test_a_linked_frames_folder_inside_the_strips_folder_is_refused(self) -> None:
        from kblib.film import strips
        from kblib.util import KbError

        self.link_folder("exports/cut.mp4.flashes/.frames")
        folder = self.project / "exports" / "cut.mp4.flashes"
        with self.assertRaises(KbError):
            strips.film_strips("/nonexistent/ffmpeg", self.project / "exports" / "cut.mp4", {"issues": [{"startMs": 100}]}, folder, 30.0)
        self.untouched()

    def test_git_excludes_never_append_through_a_link(self) -> None:
        git_init(self.project)
        exclude = self.project / ".git" / "info" / "exclude"
        exclude.unlink()
        exclude.symlink_to(self.victim / "thesis.txt")
        self.assertExit(self.kb(["note", "hello"], cwd=self.project), 0)
        self.untouched()

    def test_real_folders_still_work(self) -> None:
        self.assertExit(self.kb(["note", "hello"], cwd=self.project), 0)
        self.assertExit(self.kb(["lease", "01-intro", "--agent", "alpha"], cwd=self.project), 0)
        self.assertExit(self.kb(["lease", "01-intro", "--release", "--agent", "alpha"], cwd=self.project), 0)
        self.assertTrue((self.project / ".kb" / "notes.md").is_file())
        self.assertFalse((self.project / ".kb" / "lock").is_symlink())
        self.untouched()

