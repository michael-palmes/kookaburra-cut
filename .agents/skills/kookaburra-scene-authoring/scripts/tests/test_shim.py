from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from .helpers import SCRIPTS, KbTestCase, make_project

TEMPLATE = SCRIPTS.parents[3] / "src-tauri" / "templates" / "project-kb.sh"
KIT = Path(".claude") / "skills" / "kookaburra-scene-authoring"


@unittest.skipUnless(TEMPLATE.is_file(), "the shim template lives in the app repo")
class ShimTests(KbTestCase):
    def stamp(self, project: Path) -> Path:
        shim = project / "kb"
        shutil.copyfile(TEMPLATE, shim)
        os.chmod(shim, 0o755)
        return shim

    def run_shim(self, shim: Path, args: list, cwd: Path) -> subprocess.CompletedProcess:
        return subprocess.run([str(shim)] + args, cwd=str(cwd), capture_output=True, text=True, env=self.env, timeout=60)

    def test_the_template_is_the_managed_shim(self) -> None:
        text = TEMPLATE.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("#!/bin/sh\n# kookaburra-cut kb shim v1 (managed by Kookaburra Cut; replaced on update)\n"))
        self.assertIn('exec python3 -I "$kb" "$@"', text)

    def test_a_missing_kit_exits_2(self) -> None:
        project = make_project(self.tmp)
        proc = self.run_shim(self.stamp(project), ["status"], project)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("kb: the kit is missing; reopen the project in Kookaburra Cut", proc.stderr)

    def test_the_shim_runs_the_stamped_kb_from_any_folder(self) -> None:
        project = make_project(self.tmp)
        shutil.copytree(SCRIPTS, project / KIT / "scripts", ignore=shutil.ignore_patterns("tests", "__pycache__"))
        shim = self.stamp(project)
        proc = self.run_shim(shim, ["--version"], project)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(proc.stdout.startswith("kb "))
        proc = self.run_shim(shim, ["scenes", "--json"], project / "scenes")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["command"], "scenes")
        proc = self.run_shim(shim, ["doc", "02-hero", "set", "text.title", "two words", "--json"], project)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads((project / "scenes" / "02-hero.json").read_text(encoding="utf-8"))["text"]["title"], "two words")
