from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, Optional

from kblib import git, hookfast

from .helpers import KbTestCase, make_project, read_json, run_git, write, write_json

SESSION = "sess-bash-0001"


class BashHookCase(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp, git=git.git_available())
        self.env.update({"CLAUDE_PROJECT_DIR": str(self.root), "CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": SESSION, "TMPDIR": str(self.tmp)})
        self.calls = 0

    def payload(self, event: str, command: str, call: str, agent: Optional[str] = None, **tool: Any) -> str:
        body: Dict[str, Any] = {"session_id": SESSION, "cwd": str(self.root), "hook_event_name": event, "tool_name": "Bash", "tool_use_id": call,
                                "tool_input": dict({"command": command}, **tool)}
        if agent:
            body["agent_id"] = agent
        if event == "PostToolUseFailure":
            body["error"] = "Exit code 1"
        return json.dumps(body)

    def around(self, command: str, change: Any = None, agent: Optional[str] = None, event: str = "PostToolUse", process: bool = False, **tool: Any):
        """bash-pre, then the command's effect (change), then bash-post; returns (pre, post)."""
        self.calls += 1
        call = f"toolu_{self.calls}_{time.time_ns()}"
        pre = self.kb(["hook", "bash-pre"], cwd=self.root, stdin=self.payload("PreToolUse", command, call, agent, **tool), process=process)
        if change is not None:
            time.sleep(0.01)
            change()
        post = self.kb(["hook", "bash-post"], cwd=self.root, stdin=self.payload(event, command, call, agent, **tool), process=process)
        return pre, post

    def events(self) -> list:
        path = self.root / ".kb" / "events.jsonl"
        return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []

    def context(self, proc: subprocess.CompletedProcess, event: str = "PostToolUse") -> str:
        self.assertExit(proc, 0)
        out = json.loads(proc.stdout)["hookSpecificOutput"]
        self.assertEqual(out["hookEventName"], event)
        return out["additionalContext"]


class BashPostTests(BashHookCase):
    def break_hero(self) -> None:
        write(self.root / "scenes" / "02-hero.tsx", 'import { useState } from "react";\nexport default defineScene({ id: "hero" });\n')

    def test_a_direct_file_change_that_adds_an_error_exits_2(self) -> None:
        pre, post = self.around("sed -i '' 's/useSceneText/useState/' scenes/02-hero.tsx", self.break_hero)
        self.assertExit(pre, 0)
        self.assertExit(post, 2)
        self.assertIn("kb check found problems in files this command changed: scenes/02-hero.tsx", post.stderr)
        self.assertIn('import "react"', post.stderr)
        changed = [e for e in self.events() if e["kind"] == "files.changed"]
        self.assertEqual((changed[-1]["files"], changed[-1]["via"]), (["scenes/02-hero.tsx"], "bash"))

    def test_errors_a_named_file_already_had_come_back_as_context(self) -> None:
        self.break_hero()

        def retitle() -> None:
            path = self.root / "scenes" / "02-hero.tsx"
            path.write_text(path.read_text() + "// retitled\n")

        _pre, post = self.around("sed -i '' 's/a/b/' scenes/02-hero.tsx", retitle)
        text = self.context(post)
        self.assertIn("already there before this command", text)
        self.assertIn('import "react"', text)

    def test_kbs_own_write_inside_a_compound_command_is_not_checked_again(self) -> None:
        def kb_wrote() -> None:
            self.break_hero()
            from kblib import events

            events.journal(str(self.root), "files.changed", {"name": None, "session": SESSION, "agentId": "main"}, ["scenes/02-hero.tsx"], via="kb")

        _pre, post = self.around("./kb doc 02-hero set name X && ls scenes", kb_wrote)
        self.assertExit(post, 0)
        self.assertEqual(post.stdout.strip(), "")

    def test_the_real_kb_entry_point_takes_the_fast_path(self) -> None:
        _pre, post = self.around("python3 rewrite.py", self.break_hero, process=True)
        self.assertExit(post, 2)
        self.assertIn("scenes/02-hero.tsx", post.stderr)

    def test_warnings_come_back_as_context(self) -> None:
        def unvetted() -> None:
            write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "textStyle": {"titleFont": "Futura@500"}})

        _pre, post = self.around("python3 restyle.py", unvetted)
        self.assertIn("not vetted yet", self.context(post))

    def test_a_quiet_command_and_a_clean_change_say_nothing(self) -> None:
        _pre, post = self.around("ls -la scenes")
        self.assertExit(post, 0)
        self.assertEqual((post.stdout.strip(), post.stderr.strip()), ("", ""))

        def rename() -> None:
            write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "name": "Renamed", "text": {"title": "Hello"}})

        _pre, post = self.around("python3 rename.py", rename)
        self.assertExit(post, 0)
        self.assertEqual((post.stdout.strip(), post.stderr.strip()), ("", ""))

    def test_kb_only_commands_and_background_calls_are_skipped(self) -> None:
        for command in ("./kb doc 02-hero set text.title 'a > b'", "cd scenes && ./kb scenes | head -5",
                        "python3 -I .claude/skills/kookaburra-scene-authoring/scripts/kb.py check"):
            _pre, post = self.around(command, self.break_hero)
            self.assertExit(post, 0)
            self.assertEqual(post.stderr.strip(), "", command)
        _pre, post = self.around("python3 long-render.py", self.break_hero, run_in_background=True)
        self.assertExit(post, 0)
        self.assertEqual(post.stderr.strip(), "")
        self.assertFalse(any(p.name.startswith("bash-") for p in (self.tmp / "kb-hooks").glob("*")) if (self.tmp / "kb-hooks").is_dir() else False)
        self.assertFalse(hookfast.kb_only("./kb doc 02-hero get > scenes/02-hero.json"))
        self.assertFalse(hookfast.kb_only("./kb scenes && sed -i '' s/a/b/ scenes/02-hero.tsx"))

    def test_edits_changes_are_errors_unless_kb_video_ran(self) -> None:
        write_json(self.root / "edits" / "demo.json", {"version": 1, "clips": []})

        def touch_edit() -> None:
            write_json(self.root / "edits" / "demo.json", {"version": 1, "clips": [{"id": "c1"}]})

        _pre, post = self.around("python3 tweak.py", touch_edit)
        self.assertExit(post, 2)
        self.assertIn("only kb video changes edits/", post.stderr)
        self.assertIn("edits/demo.json", post.stderr)
        _pre, post = self.around("./kb video cut demo --at 1 && echo done", touch_edit)
        self.assertNotIn("only kb video", post.stderr)

    def test_a_failed_command_reports_through_context_only(self) -> None:
        _pre, post = self.around("python3 broken.py", self.break_hero, event="PostToolUseFailure")
        text = self.context(post, "PostToolUseFailure")
        self.assertIn("kb check found problems in files this command changed: scenes/02-hero.tsx", text)

    def test_files_other_agents_journalled_meanwhile_are_left_out(self) -> None:
        def both() -> None:
            self.break_hero()
            from kblib import events

            events.journal(self.root, "files.changed", {"name": "beta", "session": "sess-other", "agentId": "b2"}, ["scenes/02-hero.tsx"], via="kb")

        _pre, post = self.around("python3 rewrite.py", both)
        self.assertExit(post, 0)
        self.assertEqual(post.stderr.strip(), "")

    def test_a_change_to_someone_elses_leased_scene_is_reported_and_journalled(self) -> None:
        bind = self.payload("PreToolUse", "./kb lease 02-hero --agent alpha", "bind", agent="a1")
        self.assertExit(self.kb(["hook", "bash-pre"], cwd=self.root, stdin=bind), 0)
        self.assertExit(self.kb(["lease", "02-hero", "--agent", "alpha"], cwd=self.root), 0)

        def retitle() -> None:
            write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "name": "Beta was here", "text": {"title": "Hello"}})

        _pre, post = self.around("python3 retitle.py", retitle, agent="b2")
        self.assertExit(post, 2)
        self.assertIn("scenes/02-hero.json, which is leased to alpha", post.stderr)
        violated = [e for e in self.events() if e["kind"] == "lease.violated"]
        self.assertEqual((violated[0]["scene"], violated[0]["holder"]["name"]), ("02-hero", "alpha"))
        _pre, mine = self.around("python3 retitle.py", retitle, agent="a1")
        self.assertExit(mine, 0)


class BashPreTests(BashHookCase):
    def test_kb_with_agent_binds_the_name_to_the_hook_agent(self) -> None:
        pre, _post = self.around("./kb lease 02-hero --agent alpha", agent="a1")
        self.assertExit(pre, 0)
        binding = read_json(self.root / ".kb" / "agents" / "alpha" / "identity.json")
        self.assertEqual((binding["session"], binding["agentId"]), (SESSION, "a1"))
        self.assertTrue((self.root / ".kb" / ".gitignore").is_file())
        self.around("echo --agent ghost")
        self.assertFalse((self.root / ".kb" / "agents" / "ghost").exists())

    def test_the_first_visible_write_makes_the_session_checkpoint(self) -> None:
        if not git.git_available():
            self.skipTest("git is not available")
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "name": "Dirty"})
        self.around("cat scenes/02-hero.json")
        self.assertEqual(run_git(self.root, ["rev-list", "--count", "HEAD"]).strip(), "1")
        pre, _post = self.around("sed -i '' 's/Dirty/Clean/' scenes/02-hero.json")
        self.assertExit(pre, 0)
        self.assertEqual(run_git(self.root, ["rev-list", "--count", "HEAD"]).strip(), "2")
        self.assertIn(f"before Claude edits (session {SESSION[:8]})", run_git(self.root, ["log", "-1", "--format=%s"]))
        self.assertTrue((self.root / ".git" / "kb" / "sessions" / SESSION).exists())
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "name": "Dirtier"})
        self.around("./kb scene set 02-hero --duration 4000")
        self.assertEqual(run_git(self.root, ["rev-list", "--count", "HEAD"]).strip(), "2")

    def test_write_patterns(self) -> None:
        self.assertTrue(hookfast.writes_project("./kb scene add pricing --preset title"))
        self.assertFalse(hookfast.writes_project("./kb scene add pricing --dry-run"))
        self.assertTrue(hookfast.writes_project("echo x >> project.json"))
        self.assertTrue(hookfast.writes_project("python3 -c \"import json; json.dump({}, open('scenes/a.json', 'w'))\""))
        self.assertFalse(hookfast.writes_project("cat project.json | jq .scenes"))
        self.assertFalse(hookfast.writes_project("./kb video show demo"))
        self.assertTrue(hookfast.writes_project("./kb video cut demo --at 2"))
        self.assertEqual(hookfast.write_targets("cp a.tsx scenes/b.tsx && rm -f scenes/c.json 2>/dev/null"), ["scenes/b.tsx", "scenes/c.json"])
        self.assertTrue(hookfast.names_scene("scenes/0*-hero.tsx", "02-hero"))
        self.assertFalse(hookfast.names_scene("scenes/02-hero-two.tsx", "02-hero"))

    def test_hooks_fail_open(self) -> None:
        self.assertExit(self.kb(["hook", "bash-pre"], cwd=self.root, stdin="{not json"), 0)
        self.assertExit(self.kb(["hook", "bash-post"], cwd=self.root, stdin=json.dumps({"tool_input": {"command": 3}})), 0)
        self.assertExit(self.kb(["hook", "bash-later"], cwd=self.root, stdin="{}"), 0)
        outside = json.dumps({"session_id": SESSION, "cwd": str(self.tmp), "tool_use_id": "x", "tool_input": {"command": "rm -rf scenes"}})
        env = {"CLAUDE_PROJECT_DIR": str(self.tmp / "nowhere")}
        self.assertExit(self.kb(["hook", "bash-pre"], cwd=self.tmp, stdin=outside, env=env), 0)


class StampTests(BashHookCase):
    def test_stamps_cover_project_scenes_and_edit_docs_but_not_temp_files(self) -> None:
        write(self.root / "scenes" / "_lib" / "util.ts", "export const x = 1;\n")
        write(self.root / "scenes" / ".02-hero.json.abc.kbtmp", "{}")
        write(self.root / "scenes" / "02-hero.json.tmp", "{}")
        write_json(self.root / "edits" / "demo.json", {})
        write_json(self.root / "edits" / ".renders" / "demo.json", {})
        found = hookfast.stamps(str(self.root))
        self.assertIn("project.json", found)
        self.assertIn("scenes/_lib/util.ts", found)
        self.assertIn("edits/demo.json", found)
        self.assertFalse([k for k in found if k.endswith((".kbtmp", ".tmp")) or ".renders" in k])
        st = os.stat(self.root / "project.json")
        self.assertEqual(found["project.json"], f"{st.st_mtime_ns}:{st.st_size}")
        self.assertEqual(hookfast.diff({"a": "1", "b": "2"}, {"b": "3", "c": "4"}), ["a", "b", "c"])
        Path(self.root / "scenes" / "02-hero.json").unlink()
        self.assertNotIn("scenes/02-hero.json", hookfast.stamps(str(self.root)))
