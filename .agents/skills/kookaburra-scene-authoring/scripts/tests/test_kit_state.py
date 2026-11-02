from __future__ import annotations

import json

from .helpers import KbTestCase, make_project, write


class KitStateTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)

    def test_a_hand_built_shim_is_blocked_and_a_persons_own_is_theirs(self) -> None:
        from kblib import kitstate

        root = str(self.root)
        self.assertEqual(kitstate.shim_state(root), "missing")
        self.assertIn("reopen", kitstate.write_reason(root, "kb") or "")
        write(self.root / "kb", "#!/bin/sh\n# kookaburra-cut kb shim v1\nexec python3 x\n")
        self.assertEqual(kitstate.shim_state(root), "app")
        self.assertIsNotNone(kitstate.write_reason(root, "kb"))
        write(self.root / "kb", "#!/bin/sh\necho mine\n")
        self.assertEqual(kitstate.shim_state(root), "own")
        self.assertIsNone(kitstate.write_reason(root, "kb"))
        self.assertTrue(any("not the app's shim" in l for l in kitstate.problem_lines(root)))

    def test_any_spelling_apfs_opens_as_the_kit_is_blocked(self) -> None:
        from kblib import kitstate

        root = str(self.root)
        self.assertIsNotNone(kitstate.write_reason(root, "KB"))
        self.assertIsNotNone(kitstate.write_reason(root, ".CLAUDE/skills/Kookaburra-Scene-Authoring/kb.py"))

    def test_the_edit_hook_blocks_rebuilding_the_shim(self) -> None:
        payload = {"session_id": "s", "tool_input": {"file_path": str(self.root / "kb")}, "cwd": str(self.root)}
        proc = self.kb(["hook", "pre-edit"], cwd=self.root, stdin=json.dumps(payload))
        self.assertExit(proc, 2)
        self.assertIn("reopen the project in Kookaburra Cut", proc.stderr)

    def test_the_bash_hook_blocks_rebuilding_the_kit(self) -> None:
        for command in ("cat > kb <<EOF\nexec python3 x\nEOF", "cp /tmp/kb ./kb", "rm -rf .claude/skills/kookaburra-scene-authoring", "echo x > .claude/skills/kookaburra-video-editing/SKILL.md"):
            payload = {"session_id": "s", "tool_use_id": "t1", "tool_input": {"command": command}, "cwd": str(self.root)}
            proc = self.kb(["hook", "bash-pre"], cwd=self.root, stdin=json.dumps(payload))
            self.assertExit(proc, 0)
            self.assertEqual(json.loads(proc.stdout)["hookSpecificOutput"]["permissionDecision"], "deny", command)

    def test_the_bash_hook_leaves_running_kb_alone(self) -> None:
        for command in ("./kb status > out.txt", "./kb scene add x", "cat kb", "ls .claude/skills"):
            payload = {"session_id": "s", "tool_use_id": "t1", "tool_input": {"command": command}, "cwd": str(self.root)}
            proc = self.kb(["hook", "bash-pre"], cwd=self.root, stdin=json.dumps(payload))
            self.assertExit(proc, 0)
            self.assertNotIn('"deny"', proc.stdout, command)

    def test_a_restamps_kept_edits_are_named(self) -> None:
        (self.root / ".kb/kit-replaced/1700000000000").mkdir(parents=True)
        self.assertIn(".kb/kit-replaced/1700000000000", self.kb(["status"], cwd=self.root).stdout)
