from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

from kblib import git

from .helpers import KbTestCase, make_project, run_git, write, write_json


def payload(path: Path, event: str = "PreToolUse", session: str = "sess-1234567890", tool: str = "Write") -> str:
    body: Dict[str, Any] = {
        "session_id": session,
        "cwd": str(path.parent),
        "hook_event_name": event,
        "tool_name": tool,
        "tool_input": {"file_path": str(path), "content": "x"},
    }
    return json.dumps(body)


class HookTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp, git=git.git_available())
        self.env["CLAUDE_PROJECT_DIR"] = str(self.root)

    def hook(self, event: str, stdin: str):
        return self.kb(["hook", event], cwd=self.root, stdin=stdin)

    def test_pre_edit_blocks_app_owned_and_managed_paths(self) -> None:
        for rel in ("exports/cut.mp4", "edits/a.json", ".kookaburra-cache/x", ".claude/skills/kookaburra-scene-authoring/SKILL.md"):
            proc = self.hook("pre-edit", payload(self.root / rel))
            self.assertExit(proc, 2)
            self.assertIn("blocked", proc.stderr)
        for rel in ("assets/new.png", "CLAUDE.md", ".claude/settings.json"):
            self.assertExit(self.hook("pre-edit", payload(self.root / rel)), 0)

    def test_hooks_ignore_files_outside_the_project(self) -> None:
        outside = self.tmp / "elsewhere" / "exports" / "x.json"
        self.assertExit(self.hook("pre-edit", payload(outside)), 0)
        proc = self.hook("post-edit", payload(outside, "PostToolUse"))
        self.assertExit(proc, 0)
        self.assertEqual(proc.stdout.strip(), "")

    def test_pre_edit_checkpoints_once_per_session_when_dirty(self) -> None:
        if not git.git_available():
            self.skipTest("git is not available")
        target = self.root / "scenes" / "02-hero.json"
        self.assertExit(self.hook("pre-edit", payload(target)), 0)
        self.assertEqual(run_git(self.root, ["rev-list", "--count", "HEAD"]).strip(), "1")
        write_json(target, {"version": 1, "name": "Dirty"})
        self.assertExit(self.hook("pre-edit", payload(target, session="sess-other")), 0)
        self.assertEqual(run_git(self.root, ["rev-list", "--count", "HEAD"]).strip(), "2")
        self.assertIn("before Claude edits (session sess-oth", run_git(self.root, ["log", "-1", "--format=%s"]))
        write_json(target, {"version": 1, "name": "Dirtier"})
        self.assertExit(self.hook("pre-edit", payload(target, session="sess-other")), 0)
        self.assertEqual(run_git(self.root, ["rev-list", "--count", "HEAD"]).strip(), "2")
        self.assertTrue((self.root / ".git" / "kb" / "sessions" / "sess-other").exists())

    def test_post_edit_errors_exit_2_with_stderr(self) -> None:
        target = self.root / "scenes" / "02-hero.tsx"
        write(target, 'import { useState } from "react";\nexport default defineScene({ id: "hero" });\n')
        proc = self.hook("post-edit", payload(target, "PostToolUse"))
        self.assertExit(proc, 2)
        self.assertIn("scenes/02-hero.tsx", proc.stderr)
        self.assertIn('import "react"', proc.stderr)

    def test_post_edit_warnings_become_additional_context(self) -> None:
        target = self.root / "scenes" / "02-hero.json"
        write_json(target, {"version": 1, "textStyle": {"titleFont": "Futura@500"}})
        proc = self.hook("post-edit", payload(target, "PostToolUse"))
        self.assertExit(proc, 0)
        out = json.loads(proc.stdout)
        self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "PostToolUse")
        self.assertIn("not vetted yet", out["hookSpecificOutput"]["additionalContext"])

    def test_post_edit_clean_file_is_silent_and_manifest_errors_surface(self) -> None:
        target = self.root / "scenes" / "02-hero.json"
        clean = self.hook("post-edit", payload(target, "PostToolUse"))
        self.assertExit(clean, 0)
        self.assertEqual(clean.stdout.strip(), "")
        write(self.root / "project.json", "{broken")
        broken = self.hook("post-edit", payload(target, "PostToolUse"))
        self.assertExit(broken, 2)
        self.assertIn("project.json", broken.stderr)

    def test_session_start_prints_context_under_4kb(self) -> None:
        proc = self.hook("session-start", json.dumps({"session_id": "s", "cwd": str(self.root), "hook_event_name": "SessionStart", "source": "startup"}))
        self.assertExit(proc, 0)
        self.assertIn("Kookaburra Cut project", proc.stdout)
        self.assertIn("01-intro", proc.stdout)
        self.assertLess(len(proc.stdout.encode("utf-8")), 4096)

    def test_session_start_never_fails(self) -> None:
        write(self.root / "project.json", "not json")
        proc = self.hook("session-start", "garbage stdin")
        self.assertExit(proc, 0)
        self.assertIn("project.json", proc.stdout)

    def test_session_start_trims_a_long_roster(self) -> None:
        stems = [f"{i:02d}-scene-with-a-fairly-long-name-{i}" for i in range(1, 120)]
        root = make_project(self.tmp / "big", scenes=stems)
        proc = self.kb(["context"], cwd=root)
        self.assertExit(proc, 0)
        self.assertLess(len(proc.stdout.encode("utf-8")), 4096)
        self.assertIn("more (kb scenes)", proc.stdout)

    def test_hooks_fail_open(self) -> None:
        self.assertExit(self.kb(["hook", "bogus-event"], cwd=self.root, stdin="{}"), 0)
        self.assertExit(self.hook("post-edit", "{not json"), 0)
        self.assertExit(self.hook("pre-edit", json.dumps({"tool_input": {}})), 0)

    def test_a_broken_kit_fails_open_for_hooks_only(self) -> None:
        import shutil

        from .helpers import KB

        lonely = self.tmp / "lonely"
        lonely.mkdir()
        shutil.copy(KB, lonely / "kb.py")
        self.assertExit(self.kb(["hook", "pre-edit"], cwd=self.root, stdin="{}", script=lonely / "kb.py"), 0)
        proc = self.kb(["scenes"], cwd=self.root, script=lonely / "kb.py")
        self.assertExit(proc, 2)
        self.assertIn("mid-update", proc.stderr)


class PostEditBaselineTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp, git=False)
        self.env["CLAUDE_PROJECT_DIR"] = str(self.root)
        self.target = self.root / "scenes" / "02-hero.json"

    def hook(self, event: str, stdin: str):
        return self.kb(["hook", event], cwd=self.root, stdin=stdin)

    def test_errors_already_in_the_file_are_context_not_a_block(self) -> None:
        broken = {"version": 1, "background": {"type": "image", "src": "assets/missing.png"}}
        write_json(self.target, broken)
        self.assertExit(self.hook("pre-edit", payload(self.target)), 0)
        write_json(self.target, dict(broken, name="Renamed"))
        proc = self.hook("post-edit", payload(self.target, "PostToolUse"))
        self.assertExit(proc, 0)
        context = json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("already in scenes/02-hero.json before this edit", context)

    def test_an_error_the_edit_introduced_still_blocks(self) -> None:
        write_json(self.target, {"version": 1, "name": "Fine"})
        self.assertExit(self.hook("pre-edit", payload(self.target)), 0)
        write(self.target, '{ "version": 1, "name": ')
        proc = self.hook("post-edit", payload(self.target, "PostToolUse"))
        self.assertExit(proc, 2)
        self.assertIn("Fix every error", proc.stderr)
