from __future__ import annotations

import json
import os

from .helpers import FakeApp, KbTestCase, make_project, sleeper

ROW_KEYS = [
    "appVersion", "build", "bundleId", "chosen", "exePath", "legacy", "openProject", "pid", "reason",
    "servesThisProject", "serving", "startedAtMs", "updatedAgoMs", "workspaceRoot",
]


def quiet(_req):
    return None


class StatusInstanceTests(KbTestCase):
    """kb status names the instance that serves this project and explains the rest."""

    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.other = self.tmp / "elsewhere"
        self.other.mkdir()

    def status(self):
        text = self.kb(["status"], cwd=self.root)
        self.assertExit(text, 0)
        return text.stdout, json.loads(self.kb(["status", "--json"], cwd=self.root).stdout)

    def test_one_release_instance_needs_no_instances_block(self) -> None:
        with FakeApp(self.bridge, quiet, build="release", openProject="ws:demo"):
            text, data = self.status()
        self.assertNotIn("Instances:", text)
        self.assertNotIn("DEV BUILD", text)
        self.assertIn("App: running v0.19.0-test (release), this project is open", text)
        app = data["app"]
        self.assertEqual((app["pid"], app["build"], app["bundleId"], app["servesThisProject"]), (os.getpid(), "release", "com.mpalmes.kookaburracut", True))
        self.assertEqual(app["workspaceRoot"], str(self.tmp))
        self.assertEqual(len(data["instances"]), 1)
        self.assertEqual(sorted(data["instances"][0]), ROW_KEYS)
        self.assertTrue(data["instances"][0]["chosen"])

    def test_a_dev_build_leads_with_a_warning(self) -> None:
        with FakeApp(self.bridge, quiet, checkout={"path": "/Users/x/kookaburra-cut", "worktree": False}):
            text, _data = self.status()
        first = text.splitlines()[0]
        self.assertTrue(first.startswith("DEV BUILD:"), text)
        self.assertIn("from /Users/x/kookaburra-cut", first)
        self.assertIn("packaged app", first)

    def test_two_instances_on_this_root_are_listed_and_the_open_one_wins(self) -> None:
        other_pid = sleeper(self).pid
        with FakeApp(self.bridge, quiet, build="release", startedAtMs=1), \
                FakeApp(self.bridge, quiet, pid=other_pid, openProject="ws:demo"):
            text, data = self.status()
        self.assertIn("Instances:", text)
        self.assertIn(f"  * pid {other_pid} dev", text)
        self.assertIn(f"    pid {os.getpid()} release", text)
        self.assertIn("several instances serve this workspace", text)
        self.assertTrue(text.startswith("DEV BUILD:"), text)
        self.assertEqual(data["app"]["pid"], other_pid)
        self.assertEqual([r["chosen"] for r in data["instances"]], [True, False])
        self.assertTrue(all(r["servesThisProject"] for r in data["instances"]))

    def test_no_instance_on_this_root_explains_why(self) -> None:
        passive = sleeper(self).pid
        with FakeApp(self.bridge, quiet, root=self.other, build="release"), \
                FakeApp(self.bridge, quiet, pid=passive, serving=False):
            text, data = self.status()
        self.assertIn("App: running, but no instance serves this project's workspace", text)
        self.assertIn("Instances:", text)
        self.assertIn(f"workspace {self.other} (serves another workspace)", text)
        self.assertIn(f"pid {passive} dev", text)
        self.assertIn("(bridge off: workspace root overridden by KOOKABURRA_WORKSPACE_ROOT)", text)
        self.assertNotIn("DEV BUILD", text)
        app = data["app"]
        self.assertEqual((app["running"], app["servesThisProject"], app["pid"]), (True, False, None))
        self.assertFalse(any(r["chosen"] for r in data["instances"]))
        rows = {r["pid"]: r for r in data["instances"]}
        self.assertEqual(rows[passive]["reason"], "workspace root overridden by KOOKABURRA_WORKSPACE_ROOT")
        self.assertFalse(rows[os.getpid()]["servesThisProject"])

    def test_without_any_app_status_says_not_running(self) -> None:
        text, data = self.status()
        self.assertIn("App: not running", text)
        self.assertNotIn("Instances:", text)
        self.assertEqual((data["app"]["running"], data["instances"]), (False, []))
