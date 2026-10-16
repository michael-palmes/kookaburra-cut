from __future__ import annotations

import json
import os
import time
from typing import Any, Dict

from kblib import git

from .helpers import KbTestCase, read_json, run_git, video_project, write_json
from .test_hooks import payload


def edit_doc(**extra: Any) -> Dict[str, Any]:
    d: Dict[str, Any] = {
        "version": 1, "name": "rec",
        "sources": [{"id": "s1", "rel": "assets/rec.mp4", "kind": "video", "width": 1920, "height": 1080, "fps": 60, "durationMs": 10000}],
        "settings": {"width": 1920, "height": 1080, "fps": 60},
        "clips": [{"id": "c1", "sourceId": "s1", "inMs": 0, "outMs": 10000, "speed": 1.0, "startMs": 0}],
    }
    d.update(extra)
    return d


class GitTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        if not git.git_available():
            self.skipTest("git is not available")
        self.root = video_project(self.tmp)
        self.fake_cli()

    def tracked(self) -> list:
        return run_git(self.root, ["ls-tree", "-r", "--name-only", "HEAD"]).split()

    def test_checkpoints_hold_edit_docs_but_not_renders(self) -> None:
        self.assertExit(self.kb(["video", "new", "assets/rec.mp4"], cwd=self.root), 0)
        write_json(self.root / "edits" / ".renders" / "rec.json", {"docHash": "x"})
        (self.root / "edits" / ".rec.json.1-2.tmp").write_text("x")
        (self.root / "edits" / "rec.json.tmp").write_text("x")
        (self.root / "assets" / ".kc-render").mkdir()
        self.assertExit(self.kb(["checkpoint", "edit"], cwd=self.root), 0)
        files = self.tracked()
        self.assertIn("edits/rec.json", files)
        self.assertFalse([f for f in files if ".renders" in f or f.endswith(".tmp")])
        exclude = (self.root / ".git" / "info" / "exclude").read_text()
        for line in git.EXCLUDES:
            self.assertIn(line, exclude.splitlines())

    def test_undo_restores_the_doc_and_names_the_stale_render(self) -> None:
        self.assertExit(self.kb(["video", "new", "assets/rec.mp4"], cwd=self.root), 0)
        self.assertExit(self.kb(["video", "render", "rec"], cwd=self.root), 0)
        self.assertExit(self.kb(["checkpoint", "rendered"], cwd=self.root), 0)
        proc = self.kb(["video", "cut", "rec", "0-2"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertEqual(read_json(self.root / "edits" / "rec.json")["clips"][0]["inMs"], 2000)
        write_json(self.root / "edits" / "later.json", edit_doc(name="later"))
        undo = self.kb(["undo"], cwd=self.root)
        self.assertExit(undo, 0)
        self.assertIn("edits/rec.json changed; assets/rec-edited.mp4 is stale (renders are not versioned): kb video render rec", undo.stdout)
        self.assertEqual(read_json(self.root / "edits" / "rec.json")["clips"][0]["inMs"], 0)
        self.assertTrue((self.root / "edits" / "later.json").is_file())
        self.assertFalse(list(self.trash.glob("*.json")) if self.trash.exists() else [])


class CheckTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = video_project(self.tmp)

    def check(self) -> Dict[str, Any]:
        return json.loads(self.kb(["check", "--json"], cwd=self.root).stdout)

    def messages(self, out: Dict[str, Any], severity: str) -> list:
        return [f"{i['file']}: {i['message']}" for i in out["issues"] if i["severity"] == severity]

    def test_edit_doc_problems(self) -> None:
        write_json(self.root / "edits" / "rec.json", edit_doc(
            clips=[{"id": "c1", "sourceId": "s9", "inMs": 0, "outMs": 100, "speed": 1, "startMs": 0}, {"id": "c2", "sourceId": "s1", "inMs": 0, "outMs": 11000, "speed": 1, "startMs": 100}],
            masks=[{"id": "m1", "sourceId": "s1", "color": "blue", "startMs": 0, "endMs": 500, "keys": [{"sourceMs": 0, "rect": [0, 0, 0.1, 0.1]}]}],
        ))
        (self.root / "edits" / "bad.json").write_text("{broken")
        write_json(self.root / "edits" / "new.json", edit_doc(name="new", version=7))
        write_json(self.root / "edits" / "empty.json", edit_doc(name="empty", clips=[], sources=[dict(edit_doc()["sources"][0], rel="assets/Rec.mp4")]))
        out = self.check()
        errors = "\n".join(self.messages(out, "error"))
        warnings = "\n".join(self.messages(out, "warning"))
        self.assertIn("edits/bad.json: edit is corrupt", errors)
        self.assertIn("kb video reset bad --yes", errors)
        self.assertIn("edits/new.json: this edit uses document version 7", errors)
        self.assertIn("references unknown source s9", errors)
        self.assertIn("mask colour must be #rrggbb", errors)
        self.assertIn("case differs", warnings)
        self.assertIn("ends at 11000 ms, past its source", warnings)
        self.assertIn("edits/empty.json: this edit has no clips", warnings)
        self.assertFalse(out["ok"])

    def test_scenes_playing_renders(self) -> None:
        write_json(self.root / "edits" / "rec.json", edit_doc())
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "devices": [{"id": "p", "model": "iphone-17-pro", "media": {"src": "assets/rec-edited.mp4", "kind": "video"}}]})
        errors = self.messages(self.check(), "error")
        self.assertTrue(any("is not rendered yet (edits/rec.json exists): kb video render rec" in e for e in errors), errors)
        out = self.root / "assets" / "rec-edited.mp4"
        out.write_bytes(b"x")
        old = time.time() - 120
        os.utime(out, (old, old))
        warnings = self.messages(self.check(), "warning")
        self.assertTrue(any("older than edits/rec.json" in w and "kb video render rec" in w for w in warnings), warnings)
        scoped = json.loads(self.kb(["check", "scenes/02-hero.json", "--json"], cwd=self.root).stdout)
        self.assertFalse(any("older than" in i["message"] for i in scoped["issues"]))


class HookStatusTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = video_project(self.tmp)
        self.env["CLAUDE_PROJECT_DIR"] = str(self.root)

    def test_edits_and_both_skills_are_blocked(self) -> None:
        proc = self.kb(["hook", "pre-edit"], cwd=self.root, stdin=payload(self.root / "edits" / "rec.json"))
        self.assertExit(proc, 2)
        self.assertIn("edits/ holds video edit documents; change them only with kb video (kb video show rec)", proc.stderr)
        for rel in (".claude/skills/kookaburra-video-editing/SKILL.md", ".claude/skills/kookaburra-scene-authoring/scripts/kb.py"):
            proc = self.kb(["hook", "pre-edit"], cwd=self.root, stdin=payload(self.root / rel))
            self.assertExit(proc, 2)
            self.assertIn("managed kit", proc.stderr)

    def test_status_and_context_show_edits(self) -> None:
        write_json(self.root / "edits" / "rec.json", edit_doc())
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "media": [{"id": "v", "kind": "video", "src": "assets/rec-edited.mp4"}]})
        (self.root / "assets" / "rec-edited.mp4").write_bytes(b"x")
        text = self.kb(["status"], cwd=self.root).stdout
        self.assertIn("Edits: rec 10.0s (render fresh, in 02-hero)", text)
        data = json.loads(self.kb(["status", "--json"], cwd=self.root).stdout)
        self.assertEqual(data["edits"], [{"name": "rec", "durationMs": 10000.0, "render": {"state": "fresh"}, "usedBy": ["02-hero"]}])
        self.assertFalse(data["videoCli"]["ok"])
        self.assertIn("KB_APP_BIN", data["videoCli"]["error"])
        self.fake_cli(ran=self.tmp / "ran")
        data = json.loads(self.kb(["status", "--json"], cwd=self.root).stdout)
        self.assertTrue(data["videoCli"]["ok"])
        self.assertFalse((self.tmp / "ran").exists())
        context = self.kb(["context"], cwd=self.root).stdout
        self.assertIn("Edits: rec", context)
        self.assertIn("kookaburra-video-editing", context)
        self.assertLess(len(context.encode("utf-8")), 4000)

    def test_assets_usage_counts_edit_docs(self) -> None:
        write_json(self.root / "edits" / "rec.json", edit_doc())
        items = json.loads(self.kb(["assets", "list", "--json"], cwd=self.root).stdout)
        rec = next(i for i in items if i["path"] == "assets/rec.mp4")
        self.assertEqual(rec["usedBy"], ["edits/rec.json"])
