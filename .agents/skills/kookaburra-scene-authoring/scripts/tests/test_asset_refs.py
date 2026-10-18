"""The shared in-use rule: kblib/asset_refs.py replays asset-ref-vectors.json exactly as media.rs's cargo test does."""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from kblib import asset_refs as ar

from .helpers import FIXTURES

VECTORS = FIXTURES / "asset-ref-vectors.json"
REPO = Path(__file__).resolve().parents[5]


def write_case(root: Path, case: dict) -> Path:
    """media.rs write_case: the project at <root>/product-tour, workspace themes at <root>/themes/<slug>/theme.json."""
    project = root / "product-tour"

    def put(path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    for rel in case["files"]:
        put(project / rel, "")
    if case.get("project") is not None:
        put(project / "project.json", json.dumps(case["project"], separators=(",", ":"), ensure_ascii=False))
    for name, doc in (case.get("sidecars") or {}).items():
        put(project / "scenes" / name, json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    for name, text in (case.get("tsx") or {}).items():
        put(project / "scenes" / name, text)
    for name, doc in (case.get("edits") or {}).items():
        put(project / "edits" / name, json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    (root / "themes").mkdir(parents=True, exist_ok=True)
    for slug, doc in (case.get("themes") or {}).items():
        put(root / "themes" / slug / "theme.json", json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    return project


class VectorTests(unittest.TestCase):
    def test_every_case_agrees_with_the_app(self) -> None:
        doc = json.loads(VECTORS.read_text(encoding="utf-8"))
        self.assertEqual(doc["version"], 1)
        self.assertGreaterEqual(len(doc["cases"]), 8)
        for i, case in enumerate(doc["cases"]):
            with self.subTest(case["name"]):
                root = Path(tempfile.mkdtemp(prefix=f"kbguard-{i}-"))
                try:
                    project = write_case(root, case)
                    refs = ar.AssetRefs.of(project)
                    files = sorted(case["files"])
                    self.assertEqual([f for f in files if refs.in_use(f, files)], sorted(case["referenced"]), "referenced")
                    self.assertEqual(refs.unused(files, case.get("samplePool") or []), sorted(case["unused"]), "unused")
                    self.assertEqual(refs.patterns(), sorted(case.get("patterns") or []), "patterns")
                    self.assertEqual(ar.asset_files(project), files)
                finally:
                    shutil.rmtree(root, ignore_errors=True)


class PatternTests(unittest.TestCase):
    def test_literal_globs(self) -> None:
        cases = [
            ("`assets/a-${x}-${y}.png`", ["assets/a-*-*.png"]),
            ("`assets/${a}${b}.png`", ["assets/*.png"]),
            ("'assets/frame-'  +  n", ["assets/frame-*"]),
            ('"assets/dir/"', ["assets/dir/*"]),
            ('"assets/x.png"', []),
            ('"assets/broken\n"', []),
            ('"assets/esc\\"x"', []),
            ("`assets/${open", []),
            ("`assets/${a{b}c}.png`", ["assets/*.png"]),
            ("see assets/x + y", []),
            ('"./assets/shots/" + n', ["assets/shots/*"]),
            ('"assets/a-" + x; "assets/a-" + y', ["assets/a-*"]),
            ('"assets/k-" + n', ["assets/k-*"]),
        ]
        for text, want in cases:
            self.assertEqual(ar.literal_patterns(text), want, text)

    def test_globs_match_across_folders(self) -> None:
        self.assertTrue(ar.glob_matches("assets/*", "assets/a/b.png"))
        self.assertTrue(ar.glob_matches("assets/g-*.png", "assets/g-1.png"))
        self.assertFalse(ar.glob_matches("assets/g-*.png", "assets/g-1.jpg"))
        self.assertTrue(ar.glob_matches("assets/a*b*c", "assets/abxbc"))
        self.assertFalse(ar.glob_matches("assets/a*b*b", "assets/ab"))
        self.assertTrue(ar.glob_matches("assets/x.png", "assets/x.png"))
        self.assertFalse(ar.glob_matches("assets/x.png", "assets/x.png.bak"))

    def test_kept_reasons(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="kbkept-"))
        try:
            case = {
                "files": ["assets/a.png", "assets/g-1.png", "assets/wall.png", "assets/app-icon.png", "assets/_meta.json", "assets/rec.mp4", "assets/rec.timing.json", "assets/x.png"],
                "project": {"themeId": "ws:brand", "audio": {"file": "assets/a.png"}},
                "tsx": {"01-a.tsx": "const f = (n) => `assets/g-${n}.png`;\nconst rec = 'assets/rec.mp4';\n"},
                "themes": {"brand": {"background": {"src": "assets/wall.png"}}},
            }
            project = write_case(root, case)
            refs = ar.AssetRefs.of(project)
            files = sorted(case["files"])
            got = {f: refs.kept(f, files, ["app-icon.png"]) for f in files}
            self.assertIsNone(got["assets/a.png"], "plainly in use")
            self.assertIsNone(got["assets/x.png"], "unused")
            self.assertEqual(got["assets/g-1.png"], {"path": "assets/g-1.png", "reason": "pattern", "pattern": "assets/g-*.png", "file": "scenes/01-a.tsx"})
            self.assertEqual(got["assets/wall.png"], {"path": "assets/wall.png", "reason": "theme", "file": "themes/brand/theme.json"})
            self.assertEqual(got["assets/app-icon.png"]["reason"], "sample")
            self.assertEqual(got["assets/_meta.json"]["reason"], "companion")
            self.assertEqual(got["assets/rec.timing.json"], {"path": "assets/rec.timing.json", "reason": "companion", "file": "assets/rec.mp4"})
        finally:
            shutil.rmtree(root, ignore_errors=True)


@unittest.skipUnless((REPO / "projects" / "_samples").is_dir(), "not inside the app's repository")
class SamplePoolTests(unittest.TestCase):
    def test_the_catalogue_lists_the_restored_pool(self) -> None:
        catalog = json.loads((REPO / ".agents" / "skills" / "kookaburra-scene-authoring" / "catalog.json").read_text(encoding="utf-8"))
        exts = ("png", "jpg", "jpeg", "webp", "mp4", "mov", "m4a")
        folder = REPO / "projects" / "_samples"
        want = sorted(p.name for p in folder.iterdir() if p.is_file() and not p.name.startswith(".") and p.suffix[1:].lower() in exts)
        self.assertEqual([e["id"] for e in catalog["samplePool"]], want)


if __name__ == "__main__":
    unittest.main()
