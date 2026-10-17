from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import types
from pathlib import Path
from typing import Any, Dict, List
from unittest import mock

from kblib import git, identity, lock, scenes
from kblib.project import Project
from kblib.util import KbError

from .helpers import KbTestCase, make_project, read_json, run_git, write_json

HOLD = (
    "import fcntl, json, os, sys, time\n"
    "fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT)\n"
    "fcntl.flock(fd, fcntl.LOCK_EX)\n"
    "os.ftruncate(fd, 0)\n"
    "os.write(fd, json.dumps({'pid': os.getpid(), 'op': 'kb scene add', 'agent': 'beta', 'atMs': int(time.time() * 1000)}).encode())\n"
    "print('locked', flush=True)\n"
    "time.sleep(30)\n"
)
TRY = (
    "import fcntl, os, sys\n"
    "fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT)\n"
    "try:\n"
    "    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
    "    print('free')\n"
    "except OSError:\n"
    "    print('held')\n"
)


def tree_hash(root: Path) -> str:
    h = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file() and ".git" not in p.parts):
        h.update(str(path.relative_to(root)).encode() + b"\0" + path.read_bytes())
    return h.hexdigest()


def racing(path: Path, change: Any, times: int = 1) -> Any:
    """A write_if_unchanged that lets someone else save `path` first, `times` times."""
    real = lock.write_if_unchanged
    calls = {"n": 0}

    def write(target: Any, base: Any, data: Any) -> bool:
        if Path(target) == path and calls["n"] < times:
            calls["n"] += 1
            doc = read_json(path)
            change(doc)
            write_json(path, doc)
        return real(target, base, data)

    write.calls = calls  # type: ignore[attr-defined]
    return write


class LockTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.project = Project(self.root)
        self.lock_path = self.root / ".kb" / "lock"

    def hold(self) -> subprocess.Popen:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        child = subprocess.Popen([sys.executable, "-c", HOLD, str(self.lock_path)], stdout=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (child.kill(), child.wait(), child.stdout.close()))  # type: ignore[union-attr]
        self.assertEqual(child.stdout.readline().strip(), "locked")  # type: ignore[union-attr]
        return child

    def held_by_other(self) -> str:
        return subprocess.run([sys.executable, "-c", TRY, str(self.lock_path)], capture_output=True, text=True).stdout.strip()

    def test_a_held_project_lock_is_exit_3_naming_the_holder(self) -> None:
        child = self.hold()
        before = (self.root / "scenes" / "02-hero.json").read_bytes()
        proc = self.kb(["doc", "02-hero", "set", "name", "Other", "--wait", "0.3"], cwd=self.root)
        self.assertExit(proc, 3)
        self.assertIn(f"pid {child.pid} (beta) is running kb scene add", proc.stderr)
        self.assertIn("hint: rerun in a moment, or pass --wait SECONDS", proc.stderr)
        out = json.loads(self.kb(["scene", "add", "extra", "--wait", "0", "--json"], cwd=self.root).stdout)
        self.assertEqual((out["ok"], out["command"], out["code"]), (False, "scene add", "locked"))
        self.assertEqual(out["holder"]["agent"], "beta")
        self.assertGreater(out["retryAfterMs"], 0)
        self.assertEqual((self.root / "scenes" / "02-hero.json").read_bytes(), before)
        self.assertFalse((self.root / "scenes" / "04-extra.tsx").exists())

    def test_reentrant_and_released(self) -> None:
        with lock.project_lock(self.project, "outer", wait=0, caller=identity.Caller("alpha")):
            with lock.project_lock(self.project, "inner", wait=0):
                self.assertEqual(self.held_by_other(), "held")
                info = json.loads(self.lock_path.read_text())
                self.assertEqual((info["op"], info["agent"], info["pid"]), ("outer", "alpha", os.getpid()))
            self.assertEqual(self.held_by_other(), "held")
        self.assertEqual(self.held_by_other(), "free")
        self.assertEqual(self.lock_path.read_text(), "")

    def test_kb_dir_ignores_itself(self) -> None:
        if not git.git_available():
            self.skipTest("git is not available")
        run_git(self.root, ["init", "-q"])
        self.assertExit(self.kb(["doc", "02-hero", "set", "name", "Hero 2"], cwd=self.root), 0)
        self.assertEqual((self.root / ".kb" / ".gitignore").read_text(), "*\n")
        self.assertIn(".kb/", (self.root / ".git" / "info" / "exclude").read_text().splitlines())
        self.assertNotIn(".kb", run_git(self.root, ["status", "--porcelain", "--untracked-files=all"]))

    def test_a_bad_agent_name_is_a_usage_error(self) -> None:
        proc = self.kb(["--agent", "two words", "scenes", "--json"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertEqual(json.loads(proc.stdout)["code"], "usage")


class CompareAndSwapTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.project = Project(self.root)
        self.sidecar = self.root / "scenes" / "02-hero.json"

    def test_hashes_and_writes(self) -> None:
        data, sha = lock.read_with_hash(self.sidecar)
        self.assertEqual(sha, hashlib.sha256(data or b"").hexdigest())
        self.assertEqual(lock.read_with_hash(self.root / "nope.json"), (None, "absent"))
        self.assertFalse(lock.write_if_unchanged(self.sidecar, "0" * 64, b"{}\n"))
        self.assertEqual(self.sidecar.read_bytes(), data)
        self.assertTrue(lock.write_if_unchanged(self.sidecar, sha, b"{}\n"))
        self.assertFalse(lock.write_if_unchanged(self.sidecar, "absent", b"[]\n"))
        self.assertTrue(lock.write_if_unchanged(self.root / "new.json", "absent", b"[]\n"))
        self.assertEqual([p.name for p in self.root.iterdir() if p.name.endswith(".kbtmp")], [])

    def test_a_forced_race_reapplies_the_op(self) -> None:
        def rename(doc: Dict[str, Any]) -> None:
            doc["name"] = "Edited by the app"

        race = racing(self.sidecar, rename)
        with mock.patch.object(lock, "write_if_unchanged", side_effect=race):
            mut = lock.mutate_json(self.project, "scenes/02-hero.json", lambda d: dict(d, headerIcon="assets/logo.png"))
        doc = read_json(self.sidecar)
        self.assertEqual((doc["name"], doc["headerIcon"]), ("Edited by the app", "assets/logo.png"))
        self.assertTrue(mut.written and mut.rebased)
        self.assertEqual(mut.after_hash, hashlib.sha256(self.sidecar.read_bytes()).hexdigest())

    def test_a_cli_write_reapplies_through_the_race(self) -> None:
        def rename(doc: Dict[str, Any]) -> None:
            doc["name"] = "Edited by the app"

        from kblib.cli import main

        self.addCleanup(identity.bind, None)
        with mock.patch.object(lock, "write_if_unchanged", side_effect=racing(self.sidecar, rename)), mock.patch("sys.stdout"):
            code = main(["-C", str(self.root), "doc", "02-hero", "set", "textStyle.titleSize", "1.5"])
        self.assertEqual(code, 0)
        doc = read_json(self.sidecar)
        self.assertEqual((doc["name"], doc["textStyle"]["titleSize"]), ("Edited by the app", 1.5))

    def test_retries_run_out_with_exit_3(self) -> None:
        race = racing(self.sidecar, lambda d: d.update(n=d.get("n", 0) + 1), times=10)
        with mock.patch.object(lock, "write_if_unchanged", side_effect=race):
            with self.assertRaises(KbError) as cm:
                lock.mutate_json(self.project, "scenes/02-hero.json", lambda d: dict(d, name="Mine"))
        self.assertEqual((cm.exception.code, cm.exception.kind), (3, "conflict"))
        self.assertIn("kept changing", cm.exception.message)
        self.assertEqual(race.calls["n"], 4)
        self.assertNotEqual(read_json(self.sidecar)["name"], "Mine")

    def test_a_pinned_base_refuses_at_once(self) -> None:
        calls: List[Any] = []
        with self.assertRaises(KbError) as cm:
            lock.mutate_json(self.project, "scenes/02-hero.json", lambda d: calls.append(d) or d, base="f" * 64)
        self.assertEqual((cm.exception.code, cm.exception.kind), (1, "conflict"))
        self.assertEqual(calls, [])

    def test_an_index_that_moved_refuses(self) -> None:
        def insert_first(manifest: Dict[str, Any]) -> None:
            manifest["scenes"].insert(0, dict(manifest["scenes"][2]))

        path = self.root / "project.json"
        with mock.patch.object(lock, "write_if_unchanged", side_effect=racing(path, insert_first)):
            with self.assertRaises(KbError) as cm:
                scenes.set_scene(self.project, "1", 4500, None, None, None)
        self.assertEqual((cm.exception.code, cm.exception.kind), (1, "conflict"))
        self.assertIn("scene 1 is now 01-intro, not 02-hero", cm.exception.message)
        self.assertEqual([e.get("durationMs") for e in read_json(path)["scenes"]], [3000, 3000, 3000, 3000])

    def test_a_stem_follows_its_scene_through_the_race(self) -> None:
        def insert_first(manifest: Dict[str, Any]) -> None:
            manifest["scenes"].insert(0, dict(manifest["scenes"][2]))

        path = self.root / "project.json"
        with mock.patch.object(lock, "write_if_unchanged", side_effect=racing(path, insert_first)):
            out = scenes.set_scene(self.project, "02-hero", 4500, None, None, None)
        manifest = read_json(path)
        self.assertEqual(out["index"], 2)
        self.assertEqual([e.get("durationMs") for e in manifest["scenes"]], [3000, 3000, 4500, 3000])


class TransactionTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.project = Project(self.root)

    def test_new_files_first_and_project_json_last(self) -> None:
        order: List[str] = []
        real = lock.write_if_unchanged

        def record(target: Any, base: Any, data: Any) -> bool:
            order.append(Path(target).relative_to(self.root).as_posix())
            return real(target, base, data)

        with mock.patch.object(lock, "write_if_unchanged", side_effect=record):
            result = scenes.add_blank(self.project, "pricing", None, None)
        self.assertEqual(order, [".kb/.gitignore", "scenes/04-pricing.tsx", "scenes/04-pricing.json", "project.json"])
        self.assertEqual([w["action"] for w in result.writes], ["create", "create", "modify"])
        self.assertFalse(result.dry_run)

    def test_a_lost_race_mid_commit_takes_back_the_new_files(self) -> None:
        with self.assertRaises(KbError):
            with lock.project_txn(self.project, "test") as tx:
                tx.write_text("scenes/09-new.tsx", "x", create_only=True)
                tx.read("project.json")
                tx.write_json("project.json", {"changed": True})
                manifest = read_json(self.root / "project.json")
                manifest["name"] = "Saved by the app meanwhile"
                real = lock.write_if_unchanged

                def late(target: Any, base: Any, data: Any) -> bool:
                    if Path(target).name == "project.json":
                        write_json(self.root / "project.json", manifest)
                    return real(target, base, data)

                patcher = mock.patch.object(lock, "write_if_unchanged", side_effect=late)
                patcher.start()
                self.addCleanup(patcher.stop)
        self.assertFalse((self.root / "scenes" / "09-new.tsx").exists())
        self.assertEqual(read_json(self.root / "project.json")["name"], "Saved by the app meanwhile")

    def test_lease_guard_and_journal_hooks(self) -> None:
        calls: List[Any] = []

        def guard(project: Any, caller: Any, rels: List[str]) -> None:
            calls.append(("guard", caller.name, list(rels)))
            if "scenes/01-intro.json" in rels:
                raise KbError("scenes/01-intro.json is leased to beta", kind="leased")

        def journal(project: Any, kind: str, caller: Any, rels: List[str], via: str) -> None:
            calls.append((kind, caller.name, list(rels), via))

        leases = types.ModuleType("kblib.leases")
        leases.guard = guard  # type: ignore[attr-defined]
        events = types.ModuleType("kblib.events")
        events.journal = journal  # type: ignore[attr-defined]
        with mock.patch.dict(sys.modules, {"kblib.leases": leases, "kblib.events": events}):
            alpha = lock.WriteOpts(caller=identity.Caller("alpha"))
            scenes.set_scene(self.project, "02-hero", 4000, None, None, None, alpha)
            before = (self.root / "scenes" / "01-intro.json").read_bytes()
            with self.assertRaises(KbError) as cm:
                scenes.set_scene(self.project, "01-intro", None, None, None, "Leased", alpha)
        self.assertEqual(cm.exception.kind, "leased")
        self.assertEqual((self.root / "scenes" / "01-intro.json").read_bytes(), before)
        self.assertEqual(calls[:2], [("guard", "alpha", ["project.json"]), ("files.changed", "alpha", ["project.json"], "kb")])
        self.assertEqual(calls[2], ("guard", "alpha", ["scenes/01-intro.json"]))
        self.assertEqual(len(calls), 3)

    def test_missing_lease_and_event_modules_are_skipped(self) -> None:
        self.assertIsNone(lock._optional("no_such_module"))
        with mock.patch.object(lock, "_optional", return_value=None):
            alpha = lock.WriteOpts(caller=identity.Caller("alpha"))
            scenes.set_scene(self.project, "02-hero", 4100, None, None, None, alpha)
        self.assertEqual(read_json(self.root / "project.json")["scenes"][1]["durationMs"], 4100)
        self.assertFalse((self.root / ".kb" / "events.jsonl").exists())


class DryRunTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)

    def plan(self, *args: str) -> Dict[str, Any]:
        before = tree_hash(self.root)
        proc = self.kb(list(args) + ["--dry-run", "--json"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertEqual(tree_hash(self.root), before, args)
        self.assertFalse((self.root / ".kb").exists())
        out = json.loads(proc.stdout)
        self.assertTrue(out["ok"] and out["dryRun"], out)
        return out

    def actions(self, out: Dict[str, Any]) -> List[Any]:
        return [(w["action"], w["path"]) for w in out["writes"]]

    def test_dry_runs_write_nothing_and_list_their_writes(self) -> None:
        added = self.plan("scene", "add", "pricing", "--after", "01-intro")
        self.assertEqual(self.actions(added), [("create", "scenes/04-pricing.tsx"), ("create", "scenes/04-pricing.json"), ("modify", "project.json")])
        self.assertEqual((added["file"], added["index"]), ("scenes/04-pricing.tsx", 1))
        sha = hashlib.sha256((self.root / "project.json").read_bytes()).hexdigest()
        self.assertEqual(added["writes"][2]["base"], sha)
        self.assertEqual(added["writes"][0]["base"], "absent")
        removed = self.plan("scene", "remove", "02-hero")
        self.assertEqual(self.actions(removed), [("modify", "project.json"), ("trash", "scenes/02-hero.tsx"), ("trash", "scenes/02-hero.json")])
        self.assertEqual(self.actions(self.plan("scene", "duplicate", "1")), [("create", "scenes/04-hero-copy.tsx"), ("create", "scenes/04-hero-copy.json"), ("modify", "project.json")])
        self.assertEqual(self.plan("scene", "move", "0", "--to", "2")["to"], 2)
        self.assertEqual(self.actions(self.plan("scene", "set", "0", "--duration", "4000", "--name", "Opening")), [("modify", "scenes/01-intro.json"), ("modify", "project.json")])
        doc = self.plan("doc", "02-hero", "set", "name", "Changed")
        self.assertEqual((doc["written"], self.actions(doc)), (False, [("modify", "scenes/02-hero.json")]))
        self.assertEqual(self.actions(self.plan("doc", "02-hero", "merge", '{"headerIcon": "assets/logo.png"}')), [("modify", "scenes/02-hero.json")])
        self.assertEqual(self.actions(self.plan("project", "set", "themeId", "kookaburra-midnight")), [("modify", "project.json")])
        src = self.tmp / "shot.png"
        src.write_bytes(b"new image")
        self.assertEqual(self.actions(self.plan("assets", "add", str(src))), [("create", "assets/shot.png")])

    def test_dry_run_text_says_nothing_was_written(self) -> None:
        before = tree_hash(self.root)
        proc = self.kb(["doc", "02-hero", "set", "name", "Changed", "--dry-run"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("dry run, nothing written: would write scenes/02-hero.json: name = \"Changed\"", proc.stdout)
        proc = self.kb(["scene", "add", "pricing", "--dry-run"], cwd=self.root)
        self.assertIn("create scenes/04-pricing.tsx", proc.stdout)
        self.assertEqual(tree_hash(self.root), before)

    def test_dry_run_still_refuses_a_write_that_adds_errors(self) -> None:
        proc = self.kb(["doc", "02-hero", "set", "devices", '[{"id": "d1", "model": "iphone-99"}]', "--dry-run", "--json"], cwd=self.root)
        self.assertExit(proc, 1)
        out = json.loads(proc.stdout)
        self.assertEqual(out["code"], "invalid")
        self.assertIn("iphone-99", out["issues"][0]["message"])

    def test_checkpoint_and_undo_dry_runs(self) -> None:
        if not git.git_available():
            self.skipTest("git is not available")
        self.assertExit(self.kb(["checkpoint", "base"], cwd=self.root), 0)
        self.assertExit(self.kb(["scene", "add", "extra"], cwd=self.root), 0)
        head = run_git(self.root, ["rev-parse", "HEAD"])
        cp = self.kb(["checkpoint", "--dry-run", "--json"], cwd=self.root)
        self.assertExit(cp, 0)
        self.assertIn("scenes/04-extra.tsx", json.loads(cp.stdout)["files"])
        undo = self.kb(["undo", "--dry-run", "--json"], cwd=self.root)
        self.assertExit(undo, 0)
        plan = json.loads(undo.stdout)
        self.assertTrue(plan["checkpointFirst"])
        self.assertIn(("trash", "scenes/04-extra.tsx"), [(w["action"], w["path"]) for w in plan["writes"]])
        self.assertIn(("modify", "project.json"), [(w["action"], w["path"]) for w in plan["writes"]])
        self.assertEqual(run_git(self.root, ["rev-parse", "HEAD"]), head)
        self.assertTrue((self.root / "scenes" / "04-extra.tsx").exists())
