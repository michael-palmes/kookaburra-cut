from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Dict

from .helpers import KbTestCase, make_project


def tree_hash(root: Path) -> Dict[str, str]:
    """Every file under the project except git's own, by content."""
    out: Dict[str, str] = {}
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if p.is_file() and ".git" not in rel.parts:
            out[rel.as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


class PlanTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp, git=True)

    def plan(self, *args: str, code: int = 0) -> dict:
        proc = self.kb(["plan", "--json"] + list(args), cwd=self.root)
        self.assertExit(proc, code)
        return json.loads(proc.stdout)

    def test_plans_write_nothing_and_list_their_writes(self) -> None:
        self.assertExit(self.kb(["lease", "03-outro", "--agent", "beta"], cwd=self.root), 0)
        (self.root / "scenes" / "02-hero.json").write_text('{"version": 1, "name": "Hero", "text": {"title": "Edited"}}\n', encoding="utf-8")
        before = tree_hash(self.root)
        add = self.plan("scene", "add", "pricing", "--after", "01-intro")
        self.assertEqual(add["plan"], "scene add")
        self.assertEqual([(w["path"], w["action"]) for w in add["writes"]],
                         [("scenes/04-pricing.tsx", "create"), ("scenes/04-pricing.json", "create"), ("project.json", "modify")])
        self.assertEqual(add["writes"][0]["base"], "absent")
        self.assertTrue(any("at index 1" in n for n in add["notes"]))
        remove = self.plan("scene", "remove", "01-intro")
        self.assertIn(("scenes/01-intro.tsx", "trash"), [(w["path"], w["action"]) for w in remove["writes"]])
        self.plan("scene", "move", "0", "--to", "2")
        self.plan("scene", "set", "1", "--duration", "4000")
        self.plan("doc", "02-hero", "set", "text.title", "Hi")
        self.plan("project", "set", "name", "Renamed")
        self.plan("checkpoint", "--scene", "02-hero")
        self.plan("undo", "--scene", "02-hero", "--agent", "alpha")
        self.plan("lease", "02-hero", "--agent", "alpha")
        self.plan("assets", "add", str(self.root / "assets" / "logo.png"), "--name", "copy.png")
        self.assertEqual(tree_hash(self.root), before)
        self.assertFalse((self.root / "scenes" / "04-pricing.tsx").exists())

    def test_a_lease_refusal_is_listed_on_its_write_and_exits_1(self) -> None:
        self.assertExit(self.kb(["lease", "02-hero", "--agent", "beta"], cwd=self.root), 0)
        out = self.plan("doc", "02-hero", "set", "text.title", "Hi", "--agent", "alpha", code=1)
        self.assertFalse(out["ok"])
        self.assertEqual(out["code"], "leased")
        (write,) = out["writes"]
        self.assertEqual((write["path"], write["refusal"]["code"]), ("scenes/02-hero.json", "leased"))
        self.assertEqual(write["refusal"]["holder"]["name"], "beta")
        self.assertEqual(out["refusals"][0]["path"], "scenes/02-hero.json")
        lease = self.plan("lease", "02-hero", "--agent", "alpha", code=1)
        self.assertEqual(lease["refusals"][0]["code"], "leased")
        self.assertEqual(lease["writes"][0]["path"], ".kb/leases/02-hero.json")
        mine = self.plan("doc", "02-hero", "set", "text.title", "Hi", "--agent", "beta")
        self.assertEqual(mine["refusals"], [])

    def test_a_write_that_would_add_errors_is_a_refusal(self) -> None:
        out = self.plan("project", "set", "themeId", "no-such-theme", code=1)
        self.assertEqual(out["refusals"][0]["code"], "invalid")
        self.assertEqual(out["writes"][0]["path"], "project.json")

    def test_text_prints_one_line_per_write(self) -> None:
        proc = self.kb(["plan", "scene", "remove", "1"], cwd=self.root)
        self.assertExit(proc, 0)
        lines = proc.stdout.splitlines()
        self.assertIn("nothing written", lines[0])
        self.assertTrue(any(line.split()[:2] == ["trash", "scenes/02-hero.tsx"] for line in lines))
        self.assertTrue(any(line.split()[:2] == ["modify", "project.json"] for line in lines))

    def test_trailing_json_and_uncovered_commands(self) -> None:
        proc = self.kb(["plan", "scene", "set", "0", "--duration", "2500", "--json"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertEqual(json.loads(proc.stdout)["plan"], "scene set")
        proc = self.kb(["plan", "--json", "capture", "--scene", "0"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertEqual(json.loads(proc.stdout)["code"], "usage")
        self.assertExit(self.kb(["plan"], cwd=self.root), 2)
        self.assertExit(self.kb(["plan", "plan", "checkpoint"], cwd=self.root), 2)
