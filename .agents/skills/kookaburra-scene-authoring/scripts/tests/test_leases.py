from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, Optional

from kblib import leases

from .helpers import KbTestCase, make_project, read_json, write_json

SESSION = "sess-0123456789abcdef"


def hook_payload(event: str, session: str = SESSION, agent: Optional[str] = None, **extra: Any) -> str:
    body: Dict[str, Any] = {"session_id": session, "hook_event_name": event, "tool_use_id": f"toolu_{time.time_ns()}"}
    if agent is not None:
        body["agent_id"] = agent
    body.update(extra)
    return json.dumps(body)


class LeaseCase(KbTestCase):
    """One session, two subagents (a1 is alpha, b2 is beta), as Claude Code runs them."""

    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.env.update({"CLAUDE_PROJECT_DIR": str(self.root), "CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": SESSION, "TMPDIR": str(self.tmp)})

    def bash_pre(self, command: str, agent: Optional[str] = None, **tool: Any) -> subprocess.CompletedProcess:
        ti = dict({"command": command}, **tool)
        return self.kb(["hook", "bash-pre"], cwd=self.root, stdin=hook_payload("PreToolUse", agent=agent, cwd=str(self.root), tool_name="Bash", tool_input=ti))

    def as_agent(self, agent: str, name: str, args: list) -> subprocess.CompletedProcess:
        """A kb call from Bash: the pre-hook binds --agent NAME to the subagent first, as Claude Code would run them."""
        self.assertExit(self.bash_pre("./kb " + " ".join(args + ["--agent", name]), agent), 0)
        return self.kb(args + ["--agent", name], cwd=self.root)

    def pre_edit(self, rel: str, agent: Optional[str] = None, tool: str = "Edit") -> subprocess.CompletedProcess:
        body = hook_payload("PreToolUse", agent=agent, cwd=str(self.root), tool_name=tool, tool_input={"file_path": str(self.root / rel)})
        return self.kb(["hook", "pre-edit"], cwd=self.root, stdin=body)

    def denial(self, proc: subprocess.CompletedProcess) -> Optional[str]:
        self.assertExit(proc, 0)
        if not proc.stdout.strip():
            return None
        out = json.loads(proc.stdout)["hookSpecificOutput"]
        return out["permissionDecisionReason"] if out.get("permissionDecision") == "deny" else None

    def lease_file(self, stem: str) -> Path:
        return self.root / ".kb" / "leases" / f"{stem}.json"


class LeaseTests(LeaseCase):
    def test_edit_by_another_agent_is_denied_with_json_and_the_holder_is_allowed(self) -> None:
        taken = self.as_agent("a1", "alpha", ["lease", "02-hero", "--note", "hero rewrite"])
        self.assertExit(taken, 0)
        lease = read_json(self.lease_file("02-hero"))
        self.assertEqual(lease["holder"], {"name": "alpha", "session": SESSION, "agentId": "a1"})
        self.assertEqual(lease["files"], ["scenes/02-hero.tsx", "scenes/02-hero.json"])
        self.assertEqual(lease["untilMs"] - lease["renewedAtMs"], leases.DEFAULT_TTL_MS)
        reason = self.denial(self.pre_edit("scenes/02-hero.tsx", "b2"))
        self.assertIsNotNone(reason)
        self.assertIn("scenes/02-hero.tsx is leased to alpha until", reason)
        self.assertIn("If you are alpha, run ./kb lease 02-hero --agent alpha; otherwise leave them a ./kb note.", reason)
        self.assertIsNone(self.denial(self.pre_edit("scenes/02-hero.json", "a1", tool="Write")))
        self.assertIsNotNone(self.denial(self.pre_edit("scenes/02-hero.json", None)))
        self.assertIsNone(self.denial(self.pre_edit("scenes/01-intro.tsx", "b2")))

    def test_kb_writes_refuse_another_agents_scene_and_dry_runs_report_it(self) -> None:
        self.assertExit(self.as_agent("a1", "alpha", ["lease", "02-hero"]), 0)
        before = (self.root / "scenes" / "02-hero.json").read_bytes()
        proc = self.as_agent("b2", "beta", ["doc", "02-hero", "set", "name", "Beta", "--json"])
        self.assertExit(proc, 1)
        out = json.loads(proc.stdout)
        self.assertEqual(out["code"], "leased")
        self.assertEqual(out["holder"]["name"], "alpha")
        self.assertIsInstance(out["untilMs"], int)
        self.assertIn("leased to alpha", out["error"])
        self.assertEqual((self.root / "scenes" / "02-hero.json").read_bytes(), before)
        plan = self.as_agent("b2", "beta", ["doc", "02-hero", "set", "name", "Beta", "--dry-run", "--json"])
        self.assertExit(plan, 0)
        self.assertEqual(json.loads(plan.stdout)["writes"][0]["refusal"]["code"], "leased")
        plan = self.as_agent("b2", "beta", ["scene", "set", "02-hero", "--name", "Beta", "--dry-run", "--json"])
        self.assertExit(plan, 0)
        refused = [w for w in json.loads(plan.stdout)["writes"] if w.get("refusal")]
        self.assertEqual([w["path"] for w in refused], ["scenes/02-hero.json"])
        self.assertExit(self.as_agent("a1", "alpha", ["doc", "02-hero", "set", "name", "Alpha"]), 0)
        self.assertEqual(read_json(self.root / "scenes" / "02-hero.json")["name"], "Alpha")

    def test_someone_elses_lease_refuses_take_and_release_until_forced(self) -> None:
        self.assertExit(self.as_agent("a1", "alpha", ["lease", "02-hero"]), 0)
        take = self.as_agent("b2", "beta", ["lease", "02-hero", "--json"])
        self.assertExit(take, 1)
        self.assertEqual(json.loads(take.stdout)["code"], "leased")
        self.assertExit(self.as_agent("b2", "beta", ["lease", "02-hero", "--release"]), 1)
        broken = self.as_agent("b2", "beta", ["lease", "02-hero", "--release", "--force", "--json"])
        self.assertExit(broken, 0)
        self.assertEqual(json.loads(broken.stdout)["action"], "broken")
        self.assertFalse(self.lease_file("02-hero").exists())
        kinds = [json.loads(line)["kind"] for line in (self.root / ".kb" / "events.jsonl").read_text().splitlines()]
        self.assertEqual(kinds, ["lease.taken", "lease.broken"])
        self.assertExit(self.as_agent("b2", "beta", ["lease", "02-hero"]), 0)
        self.assertExit(self.as_agent("b2", "beta", ["lease", "02-hero", "--release"]), 0)

    def test_expired_leases_are_ignored_and_pruned(self) -> None:
        self.assertExit(self.as_agent("a1", "alpha", ["lease", "02-hero", "--ttl", "5m"]), 0)
        lease = read_json(self.lease_file("02-hero"))
        lease["untilMs"] = int(time.time() * 1000) - 1000
        write_json(self.lease_file("02-hero"), lease)
        self.assertIsNone(self.denial(self.pre_edit("scenes/02-hero.tsx", "b2")))
        self.assertExit(self.as_agent("b2", "beta", ["doc", "02-hero", "set", "name", "Beta"]), 0)
        self.assertIn("no leases", self.kb(["leases"], cwd=self.root).stdout)
        self.assertIn("expired", self.kb(["leases", "--all"], cwd=self.root).stdout)
        self.assertExit(self.as_agent("b2", "beta", ["lease", "01-intro"]), 0)
        self.assertFalse(self.lease_file("02-hero").exists())

    def test_for_assigns_and_a_bash_pre_binding_claims_it(self) -> None:
        self.assertExit(self.as_agent("main", "lead", ["lease", "03-outro", "--for", "alpha"]), 0)
        lease = read_json(self.lease_file("03-outro"))
        self.assertEqual(lease["holder"], {"name": "alpha", "session": None, "agentId": None})
        self.assertEqual(lease["assignedBy"], "lead")
        self.assertIsNotNone(self.denial(self.pre_edit("scenes/03-outro.tsx", "a1")))
        claimed = self.as_agent("a1", "alpha", ["lease", "03-outro", "--json"])
        self.assertExit(claimed, 0)
        self.assertEqual(json.loads(claimed.stdout)["lease"]["holder"], {"name": "alpha", "session": SESSION, "agentId": "a1"})
        binding = read_json(self.root / ".kb" / "agents" / "alpha" / "identity.json")
        self.assertEqual((binding["session"], binding["agentId"]), (SESSION, "a1"))
        self.assertIsNone(self.denial(self.pre_edit("scenes/03-outro.tsx", "a1")))
        self.assertIsNotNone(self.denial(self.pre_edit("scenes/03-outro.tsx", "b2")))
        self.assertIsNotNone(self.denial(self.pre_edit("scenes/03-outro.tsx", None)))

    def test_a_main_agent_lease_covers_the_main_agent_but_not_its_subagents(self) -> None:
        self.assertExit(self.as_agent("main", "lead", ["lease", "02-hero"]), 0)
        self.assertIsNone(self.denial(self.pre_edit("scenes/02-hero.tsx", None)))
        self.assertIsNotNone(self.denial(self.pre_edit("scenes/02-hero.tsx", "b2")))
        other = hook_payload("PreToolUse", session="sess-other", cwd=str(self.root), tool_name="Edit", tool_input={"file_path": str(self.root / "scenes/02-hero.tsx")})
        self.assertIsNotNone(self.denial(self.kb(["hook", "pre-edit"], cwd=self.root, stdin=other)))

    def test_the_holders_writes_renew_a_lease_past_half_its_time(self) -> None:
        self.assertExit(self.as_agent("a1", "alpha", ["lease", "02-hero", "--ttl", "2h"]), 0)
        lease = read_json(self.lease_file("02-hero"))
        now = int(time.time() * 1000)
        lease["renewedAtMs"], lease["untilMs"] = now - 110 * 60_000, now + 10 * 60_000
        write_json(self.lease_file("02-hero"), lease)
        self.assertExit(self.as_agent("a1", "alpha", ["doc", "02-hero", "set", "name", "Renewed"]), 0)
        renewed = read_json(self.lease_file("02-hero"))
        self.assertGreater(renewed["untilMs"], now + 115 * 60_000)
        self.assertEqual(renewed["untilMs"] - renewed["renewedAtMs"], leases.DEFAULT_TTL_MS)

    def test_ttl_is_capped_and_validated(self) -> None:
        proc = self.as_agent("a1", "alpha", ["lease", "02-hero", "--ttl", "30h", "--json"])
        self.assertExit(proc, 0)
        out = json.loads(proc.stdout)
        self.assertEqual(out["lease"]["untilMs"] - out["lease"]["renewedAtMs"], leases.MAX_TTL_MS)
        self.assertIn("capped at 12h", out["notes"][0])
        self.assertExit(self.as_agent("a1", "alpha", ["lease", "02-hero", "--ttl", "soon"]), 2)
        self.assertEqual(leases.parse_ttl("1h30m")[0], 90 * 60_000)
        self.assertEqual(leases.parse_ttl("45")[0], 45 * 60_000)

    def test_scene_remove_releases_the_lease_and_refuses_someone_elses(self) -> None:
        self.assertExit(self.as_agent("a1", "alpha", ["lease", "03-outro"]), 0)
        self.assertExit(self.as_agent("a1", "alpha", ["lease", "02-hero"]), 0)
        refused = self.as_agent("b2", "beta", ["scene", "remove", "02-hero", "--json"])
        self.assertExit(refused, 1)
        self.assertEqual(json.loads(refused.stdout)["code"], "leased")
        self.assertTrue((self.root / "scenes" / "02-hero.tsx").exists())
        self.assertExit(self.as_agent("a1", "alpha", ["scene", "remove", "03-outro"]), 0)
        self.assertFalse(self.lease_file("03-outro").exists())
        self.assertTrue(self.lease_file("02-hero").exists())

    def test_status_shows_the_leases_line(self) -> None:
        self.assertExit(self.as_agent("a1", "alpha", ["lease", "02-hero"]), 0)
        self.assertExit(self.as_agent("b2", "beta", ["lease", "03-outro", "--ttl", "40m"]), 0)
        mine = self.as_agent("a1", "alpha", ["status"])
        line = next(x for x in mine.stdout.splitlines() if x.startswith("Leases:"))
        self.assertRegex(line, r"^Leases: 03-outro beta \(\d+m\) · 02-hero alpha \(yours, 1h5\dm\)$")
        data = json.loads(self.as_agent("b2", "beta", ["status", "--json"]).stdout)
        self.assertEqual(sorted((r["scene"], r["yours"]) for r in data["leases"]), [("02-hero", False), ("03-outro", True)])


class IdentityRuleTests(LeaseCase):
    def test_holder_and_same_caller_rules(self) -> None:
        root = str(self.root)
        bound = {"holder": {"name": "alpha", "session": SESSION, "agentId": "a1"}}
        unbound = {"holder": {"name": "alpha", "session": SESSION, "agentId": None}}
        main = {"holder": {"name": "lead", "session": SESSION, "agentId": "main"}}

        def hook(agent: str) -> Dict[str, Any]:
            return {"name": None, "session": SESSION, "agentId": agent}

        self.assertTrue(leases.is_holder(root, bound, hook("a1")))
        self.assertFalse(leases.is_holder(root, bound, hook("b2")))
        self.assertTrue(leases.is_holder(root, unbound, {"name": "alpha", "session": SESSION, "agentId": None}))
        self.assertFalse(leases.is_holder(root, unbound, {"name": "beta", "session": SESSION, "agentId": None}))
        self.assertTrue(leases.is_holder(root, unbound, {"name": "session-01234567", "session": SESSION, "agentId": None}))
        self.assertFalse(leases.is_holder(root, main, hook("b2")))
        self.assertTrue(leases.is_holder(root, main, hook("main")))
        self.assertFalse(leases.is_holder(root, main, {"name": None, "session": "other", "agentId": "main"}))
        self.assertFalse(leases.is_holder(root, {"holder": {"name": "alpha", "session": None, "agentId": None}}, {"name": "user", "session": None, "agentId": None}))
        self.assertTrue(leases.same_caller(root, {"name": "alpha", "session": "x"}, {"name": "alpha", "session": "y"}))
        self.assertFalse(leases.same_caller(root, {"name": "alpha", "session": SESSION, "agentId": "a1"}, {"name": "session-01234567", "session": SESSION, "agentId": None}))
        self.assertTrue(leases.same_caller(root, {"name": None, "session": SESSION, "agentId": "main"}, {"name": "session-01234567", "session": SESSION, "agentId": None}))
        self.assertFalse(leases.same_caller(root, {"name": None, "session": "other", "agentId": "main"}, {"name": None, "session": SESSION, "agentId": "main"}))


class BashLeaseTests(LeaseCase):
    def setUp(self) -> None:
        super().setUp()
        self.assertExit(self.as_agent("a1", "alpha", ["lease", "02-hero"]), 0)

    def test_visible_writes_to_a_leased_scene_are_denied(self) -> None:
        denied = [
            "sed -i '' 's/Hello/Hi/' scenes/02-hero.tsx",
            "perl -pi -e 's/a/b/' scenes/02-hero.json",
            "echo '{}' > scenes/02-hero.json",
            "cat notes.txt | tee scenes/02-hero.tsx",
            "mv scenes/02-hero.tsx /tmp/away.tsx",
            "rm scenes/02-hero.json",
            "cp /tmp/x.tsx scenes/02-hero.tsx",
            "python3 -c \"open('scenes/02-hero.tsx', 'w').write('x')\"",
            "python3 - <<'EOF'\nfrom pathlib import Path\nPath('scenes/02-hero.json').write_text('{}')\nEOF",
            "sed -i '' 's/a/b/' scenes/*.tsx",
        ]
        for command in denied:
            reason = self.denial(self.bash_pre(command, "b2"))
            self.assertIsNotNone(reason, command)
            self.assertIn("leased to alpha", reason)
        allowed = [
            "cat scenes/02-hero.tsx",
            "grep -n Hello scenes/02-hero.tsx 2>/dev/null",
            "cp scenes/02-hero.tsx /tmp/backup.tsx",
            "sed -i '' 's/a/b/' scenes/02-hero-two.tsx",
            "./kb doc 02-hero get",
        ]
        for command in allowed:
            self.assertIsNone(self.denial(self.bash_pre(command, "b2")), command)
        self.assertIsNone(self.denial(self.bash_pre("sed -i '' 's/a/b/' scenes/02-hero.tsx", "a1")))


class KbStateProtectionTests(LeaseCase):
    def test_kb_state_files_are_blocked_and_scratch_is_allowed(self) -> None:
        for rel in (".kb/lock", ".kb/leases/02-hero.json", ".kb/events.jsonl", ".kb/events.1.jsonl", ".kb/notes.md",
                    ".kb/notes.1.md", ".kb/agents/alpha/identity.json", ".kb/agents/alpha/seen.json", ".kb/.gitignore"):
            proc = self.pre_edit(rel, "a1", tool="Write")
            self.assertExit(proc, 2)
            self.assertIn("kb's own coordination state", proc.stderr)
        for rel in (".kb/agents/alpha/render.py", ".kb/agents/alpha/notes/plan.md", ".kb/captures/x/frame.png"):
            self.assertExit(self.pre_edit(rel, "a1", tool="Write"), 0)
