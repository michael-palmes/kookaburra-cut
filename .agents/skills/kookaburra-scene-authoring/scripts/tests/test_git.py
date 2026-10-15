from __future__ import annotations

from kblib import git

from .helpers import KbTestCase, make_project, read_json, run_git, write, write_json


class CheckpointTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        if not git.git_available():
            self.skipTest("git is not available")
        self.root = make_project(self.tmp)

    def committed(self) -> list:
        return run_git(self.root, ["ls-tree", "-r", "--name-only", "HEAD"]).split()

    def test_checkpoint_inits_and_commits_only_project_and_scenes(self) -> None:
        (self.root / "notes.txt").write_text("keep out")
        proc = self.kb(["checkpoint", "first", "pass"], cwd=self.root)
        self.assertExit(proc, 0)
        files = self.committed()
        self.assertIn("project.json", files)
        self.assertIn("scenes/01-intro.tsx", files)
        self.assertNotIn("assets/logo.png", files)
        self.assertNotIn("notes.txt", files)
        self.assertIn("checkpoint: first pass", run_git(self.root, ["log", "-1", "--format=%s"]))
        again = self.kb(["checkpoint"], cwd=self.root)
        self.assertIn("nothing changed", again.stdout)

    def test_checkpoint_leaves_other_staged_work_alone(self) -> None:
        self.assertExit(self.kb(["checkpoint"], cwd=self.root), 0)
        (self.root / "assets" / "new.png").write_bytes(b"x")
        run_git(self.root, ["add", "assets/new.png"])
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "name": "Changed"})
        self.assertExit(self.kb(["checkpoint"], cwd=self.root), 0)
        self.assertNotIn("assets/new.png", self.committed())
        self.assertIn("A  assets/new.png", run_git(self.root, ["status", "--porcelain"]))

    def test_history_diff_and_undo_round_trip(self) -> None:
        self.assertExit(self.kb(["checkpoint", "base"], cwd=self.root), 0)
        self.assertExit(self.kb(["scene", "add", "extra"], cwd=self.root), 0)
        diff = self.kb(["diff"], cwd=self.root)
        self.assertIn("scenes/04-extra.tsx", diff.stdout)
        self.assertIn("project.json", diff.stdout)
        undo = self.kb(["undo"], cwd=self.root)
        self.assertExit(undo, 0)
        self.assertIn("Trash", undo.stdout)
        self.assertFalse((self.root / "scenes" / "04-extra.tsx").exists())
        self.assertTrue((self.trash / "04-extra.tsx").exists())
        self.assertEqual(len(read_json(self.root / "project.json")["scenes"]), 3)
        hist = self.kb(["history"], cwd=self.root)
        self.assertIn("before kb undo", hist.stdout)
        saved = hist.stdout.split()[0]
        redo = self.kb(["undo", saved], cwd=self.root)
        self.assertExit(redo, 0)
        self.assertTrue((self.root / "scenes" / "04-extra.tsx").exists())
        self.assertEqual(len(read_json(self.root / "project.json")["scenes"]), 4)

    def test_undo_without_changes_goes_one_checkpoint_back(self) -> None:
        self.assertExit(self.kb(["checkpoint", "one"], cwd=self.root), 0)
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "name": "Two"})
        self.assertExit(self.kb(["checkpoint", "two"], cwd=self.root), 0)
        self.assertExit(self.kb(["undo"], cwd=self.root), 0)
        self.assertEqual(read_json(self.root / "scenes" / "02-hero.json")["name"], "Hero")

    def test_bad_rev_and_no_history(self) -> None:
        self.assertIn("no checkpoints yet", self.kb(["history"], cwd=self.root).stdout)
        self.assertExit(self.kb(["checkpoint"], cwd=self.root), 0)
        bad = self.kb(["undo", "nope"], cwd=self.root)
        self.assertExit(bad, 1)
        self.assertIn("kb history", bad.stderr)

    def test_refuses_a_parent_repository(self) -> None:
        outer = self.tmp
        run_git(outer, ["init", "-q"])
        proc = self.kb(["checkpoint"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("inside another git repository", proc.stderr)

    def test_scene_remove_checkpoints_a_dirty_tree_first(self) -> None:
        self.assertExit(self.kb(["checkpoint"], cwd=self.root), 0)
        write(self.root / "scenes" / "01-intro.json", '{"version": 1, "name": "Edited"}\n')
        proc = self.kb(["scene", "remove", "01-intro"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("kb undo", proc.stdout)
        self.assertIn("before kb scene remove", run_git(self.root, ["log", "-1", "--format=%s"]))
