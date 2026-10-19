from __future__ import annotations

import json
import unittest
from typing import List

from kblib import themes

from .helpers import FIXTURES
from .test_edit_conformance import same

VECTORS = FIXTURES / "theme-merge-vectors.json"


@unittest.skipUnless(VECTORS.is_file(), "fixtures/theme-merge-vectors.json is missing (pnpm agent:vectors writes it)")
class ThemeMergeConformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.vectors = json.loads(VECTORS.read_text(encoding="utf-8"))

    def test_every_merge(self) -> None:
        problems: List[str] = []
        for v in self.vectors["merge"]:
            diff = same(themes.merge_theme_docs(v["base"], v["child"]), v["out"])
            if diff:
                problems.append(f"{v['id']}: {'; '.join(diff[:3])}")
        self.assertEqual(problems, [], "\n".join(problems))

    def test_every_chain(self) -> None:
        problems: List[str] = []
        for v in self.vectors["resolve"]:
            docs = v["docs"]
            out, problem = themes.resolve_theme_document(v["raw"], v["source"], docs.get)
            if problem != v["problem"]:
                problems.append(f"{v['id']}: problem {problem!r} != {v['problem']!r}")
            diff = same(out, v["out"])
            if diff:
                problems.append(f"{v['id']}: {'; '.join(diff[:3])}")
        self.assertEqual(problems, [], "\n".join(problems))

    def test_extends_needs_version_three(self) -> None:
        self.assertEqual(themes.extends_of({"version": 3, "extends": " ws:a "}), "ws:a")
        self.assertIsNone(themes.extends_of({"version": 2, "extends": "ws:a"}))
        self.assertIsNone(themes.extends_of({"version": True, "extends": "ws:a"}))


if __name__ == "__main__":
    unittest.main()
