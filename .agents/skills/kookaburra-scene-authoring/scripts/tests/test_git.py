from __future__ import annotations

import json
import os
import threading
import time

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
        (self.root / "NOTES.md").write_text("staged by someone else\n")
        run_git(self.root, ["add", "NOTES.md"])
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "name": "Changed"})
        self.assertExit(self.kb(["checkpoint"], cwd=self.root), 0)
        self.assertNotIn("NOTES.md", self.committed())
        self.assertIn("A  NOTES.md", run_git(self.root, ["status", "--porcelain"]))

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


class ScopedHistoryTests(KbTestCase):
    """Two agents in one session (alpha a1, beta b2), each kb call bound by the Bash pre-hook first."""

    def setUp(self) -> None:
        super().setUp()
        if not git.git_available():
            self.skipTest("git is not available")
        self.root = make_project(self.tmp, git=True)
        self.env.update({"CLAUDE_PROJECT_DIR": str(self.root), "CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "sess-history", "TMPDIR": str(self.tmp)})

    def as_agent(self, agent: str, name: str, args: list):
        pre = json.dumps({"session_id": "sess-history", "agent_id": agent, "cwd": str(self.root), "hook_event_name": "PreToolUse", "tool_name": "Bash",
                          "tool_use_id": f"t-{time.time_ns()}", "tool_input": {"command": "./kb " + " ".join(args + ["--agent", name])}})
        self.assertExit(self.kb(["hook", "bash-pre"], cwd=self.root, stdin=pre), 0)
        return self.kb(args + ["--agent", name], cwd=self.root)

    def subject(self) -> str:
        return run_git(self.root, ["log", "-1", "--format=%s"]).strip()

    def test_a_scoped_checkpoint_commits_only_that_scene_and_leaves_others_dirty(self) -> None:
        write_json(self.root / "scenes" / "01-intro.json", {"version": 1, "name": "Alpha's"})
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "name": "Beta's"})
        run_git(self.root, ["add", "scenes/02-hero.json"])
        proc = self.as_agent("a1", "alpha", ["checkpoint", "intro copy", "--scene", "01-intro"])
        self.assertExit(proc, 0)
        self.assertEqual(self.subject(), "checkpoint(01-intro): intro copy [alpha]")
        self.assertEqual(run_git(self.root, ["show", "--name-only", "--format=", "HEAD"]).split(), ["scenes/01-intro.json"])
        status = run_git(self.root, ["status", "--porcelain"])
        self.assertIn("M  scenes/02-hero.json", status)
        self.assertNotIn("01-intro", status)
        events = [json.loads(x) for x in (self.root / ".kb" / "events.jsonl").read_text().splitlines()]
        self.assertEqual([e["kind"] for e in events if e["kind"] == "checkpoint"], ["checkpoint"])

    def test_undo_scene_restores_one_scene_and_its_manifest_entry_only(self) -> None:
        self.assertExit(self.kb(["checkpoint", "base"], cwd=self.root), 0)
        self.assertExit(self.as_agent("a1", "alpha", ["doc", "02-hero", "set", "name", "Alpha's hero"]), 0)
        self.assertExit(self.as_agent("a1", "alpha", ["scene", "set", "02-hero", "--duration", "5000", "--transition", "none"]), 0)
        self.assertExit(self.as_agent("b2", "beta", ["doc", "01-intro", "set", "name", "Beta's intro"]), 0)
        self.assertExit(self.as_agent("b2", "beta", ["scene", "set", "01-intro", "--duration", "4500"]), 0)
        self.assertExit(self.as_agent("b2", "beta", ["scene", "add", "extra"]), 0)
        proc = self.as_agent("a1", "alpha", ["undo", "--scene", "02-hero", "--json"])
        self.assertExit(proc, 0)
        out = json.loads(proc.stdout)
        self.assertTrue(out["manifest"])
        self.assertEqual(out["restored"], ["scenes/02-hero.json"])
        self.assertEqual(read_json(self.root / "scenes" / "02-hero.json")["name"], "Hero")
        manifest = read_json(self.root / "project.json")
        hero = manifest["scenes"][1]
        self.assertEqual((hero["durationMs"], hero["transition"]["type"]), (3000, "crossfade"))
        self.assertEqual(manifest["scenes"][0]["durationMs"], 4500)
        self.assertEqual(manifest["scenes"][3]["file"], "scenes/04-extra.tsx")
        self.assertEqual(read_json(self.root / "scenes" / "01-intro.json")["name"], "Beta's intro")
        self.assertTrue((self.root / "scenes" / "04-extra.tsx").exists())
        self.assertIn("checkpoint(02-hero): before kb undo --scene 02-hero [alpha]", run_git(self.root, ["log", "--format=%s"]))
        self.assertEqual(run_git(self.root, ["show", "--name-only", "--format=", "HEAD"]).split(), ["scenes/02-hero.json"])

    def test_undo_scene_of_a_scene_added_since_refuses_and_points_at_scene_remove(self) -> None:
        self.assertExit(self.kb(["checkpoint", "base"], cwd=self.root), 0)
        self.assertExit(self.as_agent("a1", "alpha", ["scene", "add", "extra"]), 0)
        proc = self.as_agent("a1", "alpha", ["undo", "--scene", "04-extra", "--json"])
        self.assertExit(proc, 1)
        out = json.loads(proc.stdout)
        self.assertIn("did not exist at checkpoint", out["error"])
        self.assertIn("./kb scene remove 04-extra", out["hint"])
        self.assertTrue((self.root / "scenes" / "04-extra.tsx").exists())
        self.assertEqual(len(read_json(self.root / "project.json")["scenes"]), 4)

    def test_plain_undo_refuses_another_agents_work_then_all_reverts_it(self) -> None:
        self.assertExit(self.kb(["checkpoint", "base"], cwd=self.root), 0)
        self.assertExit(self.as_agent("a1", "alpha", ["doc", "02-hero", "set", "name", "Alpha's hero"]), 0)
        self.assertExit(self.as_agent("b2", "beta", ["doc", "01-intro", "set", "name", "Beta's intro"]), 0)
        refused = self.as_agent("b2", "beta", ["undo", "--json"])
        self.assertExit(refused, 1)
        out = json.loads(refused.stdout)
        self.assertEqual(out["code"], "others-changed")
        self.assertEqual(out["files"], [{"path": "scenes/02-hero.json", "by": "alpha"}])
        self.assertIn("--scene", out["hint"])
        self.assertEqual(read_json(self.root / "scenes" / "02-hero.json")["name"], "Alpha's hero")
        plan = json.loads(self.as_agent("b2", "beta", ["undo", "--dry-run", "--json"]).stdout)
        self.assertEqual([r["path"] for r in plan["refusals"]], ["scenes/02-hero.json"])
        self.assertExit(self.as_agent("b2", "beta", ["undo", "--all"]), 0)
        self.assertEqual(read_json(self.root / "scenes" / "02-hero.json")["name"], "Hero")
        self.assertEqual(read_json(self.root / "scenes" / "01-intro.json")["name"], "Intro")

    def test_plain_undo_of_only_your_own_work_behaves_as_before(self) -> None:
        self.assertExit(self.kb(["checkpoint", "base"], cwd=self.root), 0)
        self.assertExit(self.as_agent("b2", "beta", ["doc", "01-intro", "set", "name", "Beta's intro"]), 0)
        self.assertExit(self.as_agent("b2", "beta", ["undo"]), 0)
        self.assertEqual(read_json(self.root / "scenes" / "01-intro.json")["name"], "Intro")

    def test_plain_undo_refuses_a_scene_another_agent_leases(self) -> None:
        self.assertExit(self.kb(["checkpoint", "base"], cwd=self.root), 0)
        self.assertExit(self.as_agent("a1", "alpha", ["lease", "02-hero"]), 0)
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "name": "Hand edit"})
        refused = self.as_agent("b2", "beta", ["undo", "--json"])
        self.assertExit(refused, 1)
        self.assertEqual(json.loads(refused.stdout)["files"], [{"path": "scenes/02-hero.json", "by": "alpha", "leased": True}])


class IndexLockTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        if not git.git_available():
            self.skipTest("git is not available")
        self.root = make_project(self.tmp, git=True)
        self.lock = self.root / ".git" / "index.lock"
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "name": "Dirty"})

    def test_a_lock_released_within_the_backoff_is_waited_out(self) -> None:
        self.lock.write_text("")
        timer = threading.Timer(0.3, self.lock.unlink)
        timer.start()
        self.addCleanup(timer.cancel)
        proc = self.kb(["checkpoint", "after the lock"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("checkpoint: after the lock", run_git(self.root, ["log", "-1", "--format=%s"]))

    def test_a_held_lock_exits_3_naming_its_age(self) -> None:
        self.lock.write_text("")
        old = time.time() - 15 * 60
        os.utime(self.lock, (old, old))
        proc = self.kb(["checkpoint", "--json"], cwd=self.root)
        self.assertExit(proc, 3)
        out = json.loads(proc.stdout)
        self.assertEqual(out["code"], "index-locked")
        self.assertIn("15 min old", out["hint"])
        self.assertIn("may be stale", out["hint"])
        self.assertTrue(self.lock.exists())

    def test_the_pre_edit_checkpoint_skip_comes_back_as_context_without_a_marker(self) -> None:
        self.env["CLAUDE_PROJECT_DIR"] = str(self.root)
        self.lock.write_text("")
        target = self.root / "scenes" / "02-hero.json"
        body = json.dumps({"session_id": "sess-locked", "cwd": str(self.root), "hook_event_name": "PreToolUse", "tool_name": "Edit",
                           "tool_input": {"file_path": str(target)}})
        proc = self.kb(["hook", "pre-edit"], cwd=self.root, stdin=body)
        self.assertExit(proc, 0)
        note = json.loads(proc.stdout)["hookSpecificOutput"]
        self.assertEqual(note["hookEventName"], "PreToolUse")
        self.assertIn("kb did not make the session checkpoint before this edit: .git/index.lock is held by another git process.", note["additionalContext"])
        self.assertRegex(note["additionalContext"], r"The last checkpoint is [0-9a-f]{7,}, ")
        marker = self.root / ".git" / "kb" / "sessions" / "sess-locked"
        self.assertFalse(marker.exists())
        kinds = [json.loads(x)["kind"] for x in (self.root / ".kb" / "events.jsonl").read_text().splitlines()]
        self.assertIn("checkpoint.skipped", kinds)
        self.lock.unlink()
        again = self.kb(["hook", "pre-edit"], cwd=self.root, stdin=body)
        self.assertExit(again, 0)
        self.assertEqual(again.stdout.strip(), "")
        self.assertTrue(marker.exists())
        self.assertIn("before Claude edits (session sess-loc", run_git(self.root, ["log", "-1", "--format=%s"]))
