from __future__ import annotations

import argparse
import json
import subprocess
from typing import Any, Dict, Iterator, List, Tuple
from unittest import mock

from kblib import git, identity
from kblib.cli import build_parser
from kblib.util import KbError, ok_envelope

from .helpers import KbTestCase, make_project, make_resources, write_json

STRUCTURAL = {
    "scene add", "scene duplicate", "scene move", "scene remove", "scene set", "doc set", "doc unset", "doc merge",
    "project set", "project unset", "theme set", "assets add", "checkpoint", "undo",
}


def leaves(parser: argparse.ArgumentParser, path: Tuple[str, ...] = ()) -> Iterator[Tuple[str, argparse.ArgumentParser]]:
    subs = [a for a in parser._actions if isinstance(a, argparse._SubParsersAction)]
    if not subs:
        yield " ".join(path), parser
        return
    seen = set()
    for action in subs:
        for name, child in action.choices.items():
            if id(child) in seen:
                continue
            seen.add(id(child))
            yield from leaves(child, path + (name,))


def options(parser: argparse.ArgumentParser) -> List[str]:
    return [o for a in parser._actions for o in a.option_strings]


class ParserTests(KbTestCase):
    def test_every_leaf_takes_json_and_agent_and_writes_take_dry_run(self) -> None:
        found = dict(leaves(build_parser()))
        self.assertGreater(len(found), 60)
        self.assertTrue(STRUCTURAL <= set(found), STRUCTURAL - set(found))
        for name, parser in found.items():
            opts = options(parser)
            self.assertIn("--json", opts, name)
            self.assertIn("--agent", opts, name)
            if name in STRUCTURAL:
                self.assertIn("--dry-run", opts, name)
                self.assertIn("--wait", opts, name)
        for name in ("video split", "video cut", "video apply", "video cleanup"):
            self.assertIn("--dry-run", options(found[name]), name)

    def test_ok_envelope(self) -> None:
        self.assertEqual(ok_envelope("scenes", {"scenes": []}), {"ok": True, "command": "scenes", "scenes": []})
        report = ok_envelope("check", {"ok": False, "errors": 2}, code="invalid", error="2 errors")
        self.assertEqual(report, {"ok": False, "command": "check", "code": "invalid", "error": "2 errors", "errors": 2})
        self.assertEqual(ok_envelope("x", {"ok": True, "command": "spoofed"})["command"], "x")
        self.assertEqual(KbError("busy", 3, kind="locked", retry_after_ms=500).envelope("scene add")["retryAfterMs"], 500)

    def test_identity(self) -> None:
        self.assertEqual(identity.caller_from(argparse.Namespace(agent="alpha"), {}).name, "alpha")
        self.assertEqual(identity.caller_from(None, {"KB_AGENT": "me"}).name, "me")
        claude = {"CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "3f2a9c41-aaaa", "KB_AGENT": "inherited"}
        caller = identity.caller_from(None, claude)
        self.assertEqual(caller.as_dict(), {"name": "session-3f2a9c41", "session": "3f2a9c41-aaaa", "agentId": None})
        self.assertEqual(identity.caller_from(argparse.Namespace(agent="beta"), claude).name, "beta")
        self.assertEqual(identity.caller_from(None, {}).name, "user")
        self.assertEqual(identity.caller_from(None, {"CLAUDECODE": "1"}).name, "claude")
        with self.assertRaises(KbError) as cm:
            identity.caller_from(argparse.Namespace(agent="../x"), {})
        self.assertEqual((cm.exception.code, cm.exception.kind), (2, "usage"))


class EnvelopeTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.res = make_resources(self.tmp)
        self.env["KB_RESOURCES_DIR"] = str(self.res)

    def j(self, *args: str, code: int = 0) -> Dict[str, Any]:
        proc = self.kb(list(args) + ["--json"], cwd=self.root)
        self.assertExit(proc, code)
        out = json.loads(proc.stdout)
        self.assertIsInstance(out, dict)
        self.assertEqual(out["ok"], code == 0, out)
        return out

    def test_reports_are_envelopes(self) -> None:
        cases = [
            (("status",), "status", "app"),
            (("context",), "context", "text"),
            (("scenes",), "scenes", "scenes"),
            (("check",), "check", "issues"),
            (("doc", "02-hero", "get", "name"), "doc get", "value"),
            (("project", "get"), "project get", "value"),
            (("theme", "list"), "theme list", "bundled"),
            (("theme", "show"), "theme show", "theme"),
            (("fonts", "safe"), "fonts safe", "faces"),
            (("fonts", "check", "Inter@400", "--static"), "fonts check", "results"),
            (("fonts", "list", "--static"), "fonts list", "bundled"),
            (("presets",), "presets list", "presets"),
            (("presets", "show", "title"), "presets show", "tagline"),
            (("catalog",), "catalog", "families"),
            (("catalog", "transitions"), "catalog", "items"),
            (("catalog", "--search", "neon"), "catalog", "items"),
            (("assets", "list"), "assets list", "assets"),
            (("assets", "probe", "logo.png"), "assets probe", "width"),
            (("video", "list"), "video list", "edits"),
        ]
        for args, command, key in cases:
            out = self.j(*args)
            self.assertEqual(out["command"], command, args)
            self.assertIn(key, out, args)
        self.assertIsInstance(self.j("fonts", "safe")["faces"], list)
        self.assertEqual(self.j("doc", "02-hero", "get", "name")["value"], "Hero")
        self.assertEqual(self.j("--agent", "alpha", "scenes")["command"], "scenes")

    def test_writes_are_envelopes(self) -> None:
        added = self.j("scene", "add", "pricing")
        self.assertEqual((added["command"], added["file"], added["dryRun"]), ("scene add", "scenes/04-pricing.tsx", False))
        self.assertEqual([w["action"] for w in added["writes"]], ["create", "create", "modify"])
        self.assertTrue(added["check"]["ok"])
        doc = self.j("doc", "02-hero", "set", "name", "Hero two")
        self.assertEqual((doc["file"], doc["written"], doc["summary"]), ("scenes/02-hero.json", True, 'name = "Hero two"'))
        self.assertEqual(len(doc["hash"]), 64)
        self.assertEqual(self.j("scene", "move", "0", "--to", "1")["to"], 1)
        self.assertEqual(self.j("scene", "set", "0", "--duration", "4000")["changes"], ["durationMs = 4000"])
        self.assertEqual(self.j("scene", "remove", "04-pricing")["trashed"], ["scenes/04-pricing.tsx", "scenes/04-pricing.json"])
        self.assertTrue(self.j("project", "set", "themeId", "kookaburra-midnight")["written"])

    def test_problem_reports_carry_code_and_error(self) -> None:
        (self.root / "scenes" / "02-hero.tsx").write_text("export default 1;")
        out = self.j("check", code=1)
        self.assertEqual(out["code"], "invalid")
        self.assertIn("error", out["error"])
        self.assertGreaterEqual(out["errors"], 1)
        miss = self.j("catalog", "--search", "zzzz", code=1)
        self.assertEqual((miss["items"], miss["code"]), ([], "failed"))

    def test_failures_print_the_error_envelope(self) -> None:
        proc = self.kb(["doc", "02-hero", "set", "devices", '[{"id": "d1", "model": "iphone-99"}]', "--json"], cwd=self.root)
        self.assertExit(proc, 1)
        out = json.loads(proc.stdout)
        self.assertEqual((out["ok"], out["command"], out["code"]), (False, "doc set", "invalid"))
        self.assertEqual(out["hint"], "fix the value, or pass --force to write it anyway")
        self.assertIn("iphone-99", out["error"])
        self.assertEqual(out["issues"][0]["severity"], "error")
        self.assertIn("kb: nothing written", proc.stderr)
        self.assertIn("  hint: fix the value", proc.stderr)
        missing = self.j("doc", "02-hero", "get", "nope", code=1)
        self.assertEqual((missing["code"], missing["error"]), ("failed", "nope is not set in scenes/02-hero.json"))
        bad = self.j("scene", "set", "0", "--ease", "bouncy", code=2)
        self.assertEqual((bad["code"], bad["hint"]), ("usage", "run ./kb <command> --help"))
        outside = self.kb(["scenes", "--json"], cwd=self.tmp)
        self.assertExit(outside, 2)
        self.assertEqual(json.loads(outside.stdout)["code"], "env")

    def test_argparse_usage_errors_are_envelopes_in_json_mode(self) -> None:
        proc = self.kb(["scene", "move", "--json", "--to"], cwd=self.root)
        self.assertExit(proc, 2)
        out = json.loads(proc.stdout)
        self.assertEqual((out["ok"], out["command"], out["code"]), (False, "scene move", "usage"))
        self.assertEqual(out["hint"], "run ./kb scene move --help")
        self.assertIn("usage: kb scene move", proc.stderr)
        top = self.kb(["nonsense", "--json"], cwd=self.root)
        self.assertExit(top, 2)
        self.assertEqual(json.loads(top.stdout)["code"], "usage")
        doc = self.kb(["doc", "02-hero", "frobnicate", "--json"], cwd=self.root)
        self.assertEqual(json.loads(doc.stdout)["command"], "doc")
        plain = self.kb(["scene", "move", "--to"], cwd=self.root)
        self.assertExit(plain, 2)
        self.assertEqual(plain.stdout, "")

    def test_bare_arrays_moved_under_keys(self) -> None:
        if git.git_available():
            self.assertExit(self.kb(["checkpoint", "first"], cwd=self.root), 0)
            hist = self.j("history")
            self.assertEqual(hist["checkpoints"][0]["subject"], "checkpoint: first")
            self.assertIsInstance(hist["checkpoints"][0]["atMs"], int)
            self.assertEqual(self.j("diff")["command"], "diff")
            self.assertTrue(self.j("checkpoint")["ok"])
        self.assertEqual(self.j("fonts", "check", "Inter@400", "--static")["results"][0]["ref"], "Inter@400")
        self.assertEqual(self.j("presets")["presets"][0]["id"], "title")
        self.assertIn("textLooks: neon", " ".join(self.j("catalog", "--search", "neon")["items"]))
        self.assertIn("assets/logo.png", [a["path"] for a in self.j("assets", "list")["assets"]])

    def test_check_film_dispatch(self) -> None:
        proc = self.kb(["check", "film", "flashes", "--file", "x.mp4", "--json"], cwd=self.root)
        try:
            import kblib.film.cli  # noqa: F401
        except ModuleNotFoundError:
            self.assertExit(proc, 2)
            out = json.loads(proc.stdout)
            self.assertEqual((out["command"], out["error"]), ("check film", "kb check film is not in this kit"))
            return
        self.assertNotIn("unrecognized arguments", proc.stderr)


class ExitCodeRemapTests(KbTestCase):
    def test_git_timeout_is_transient(self) -> None:
        root = make_project(self.tmp)
        with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired(["git"], 30)):
            with self.assertRaises(KbError) as cm:
                git.run(root, ["status"])
        self.assertEqual((cm.exception.code, cm.exception.kind), (3, "transient"))
        self.assertGreater(cm.exception.retry_after_ms or 0, 0)

    def test_cas_retries_exhausted_in_a_re_point_is_exit_3(self) -> None:
        from kblib import lock
        from kblib.project import Project
        from kblib.video import repoint

        from .helpers import read_json, video_project

        root = video_project(self.tmp)
        sidecar = root / "scenes" / "02-hero.json"
        write_json(sidecar, {"version": 1, "devices": [{"id": "phone", "model": "android", "media": {"src": "assets/rec.mp4", "kind": "video"}}]})
        real = lock.write_if_unchanged

        def always(target: Any, base: Any, data: Any) -> bool:
            doc = read_json(sidecar)
            doc["n"] = doc.get("n", 0) + 1
            write_json(sidecar, doc)
            return real(target, base, data)

        with mock.patch.object(lock, "write_if_unchanged", side_effect=always):
            with self.assertRaises(KbError) as cm:
                repoint.set_start(Project(root), "02-hero", "device:phone", 500)
        self.assertEqual((cm.exception.code, cm.exception.kind), (3, "conflict"))

    def test_edit_save_conflicts_exhausted_is_exit_3(self) -> None:
        from kblib.project import Project
        from kblib.video import appcli, editdoc

        from .helpers import video_project
        from .test_video_doc import raw_doc

        root = video_project(self.tmp)
        write_json(root / "edits" / "rec.json", raw_doc())

        def conflict(*_a: Any, **_k: Any) -> Any:
            raise appcli.CliError("conflict", "conflict: changed outside the editor", {"hash": "0" * 64})

        with mock.patch.object(appcli, "save", side_effect=conflict):
            with self.assertRaises(KbError) as cm:
                editdoc.mutate(Project(root), "rec", lambda d: dict(d, tapSize=2.0))
        self.assertEqual((cm.exception.code, cm.exception.kind), (3, "conflict"))
