from __future__ import annotations

import unittest

from kblib import tsx


class SceneIdScannerTests(unittest.TestCase):
    """Cases mirror the Rust healer's own tests (scene_doc.rs)."""

    def test_finds_the_first_key_id(self) -> None:
        src = 'import { defineScene } from "@kookaburra/toolkit";\nexport default defineScene({\n  id: "hero",\n  durationMs: 3000,\n});\n'
        self.assertEqual(tsx.scene_id(src), "hero")

    def test_skips_import_line_and_comment_mentions(self) -> None:
        src = '/** Built with `defineScene`. */\nimport { defineScene } from "x";\nexport default defineScene({ durationMs: 1, id: \'real\' });'
        self.assertEqual(tsx.scene_id(src), "real")

    def test_ignores_nested_ids_and_jsx_props(self) -> None:
        src = 'export default defineScene({ cfg: { id: "inner" }, Scene() { return <A key={d.id} />; }, id: "outer" });'
        self.assertEqual(tsx.scene_id(src), "outer")

    def test_refuses_interpolated_template(self) -> None:
        self.assertIsNone(tsx.scene_id("export default defineScene({ id: `x-${n}` });"))
        self.assertEqual(tsx.scene_id("export default defineScene({ id: `plain` });"), "plain")

    def test_rewrite_is_a_pure_splice(self) -> None:
        src = 'export default defineScene({\n  id: "hero", // keep\n  durationMs: 3000,\n});\n'
        out = tsx.rewrite_scene_id(src, "hero-2")
        self.assertEqual(out, src.replace('"hero"', '"hero-2"'))

    def test_identifier_prefix_is_not_define_scene(self) -> None:
        self.assertIsNone(tsx.scene_id('mydefineScene({ id: "x" })'))


class ScanTests(unittest.TestCase):
    def test_banned_uses_skip_comments_and_strings(self) -> None:
        src = 'const a = "Date.now in a string";\n// Math.random in a comment\nconst t = Date.now();\nwindow.innerWidth;\nnew Date();\n'
        code = tsx.blank_comments_and_strings(src)
        tokens = [(line, tok.split("(")[0]) for line, tok, _ in tsx.banned_uses(code)]
        self.assertIn((3, "Date.now"), tokens)
        self.assertIn((4, "window."), tokens)
        self.assertIn((5, "new Date"), tokens)
        self.assertFalse(any(line in (1, 2) for line, _ in tokens))

    def test_html_and_timers(self) -> None:
        code = tsx.blank_comments_and_strings("setTimeout(f, 1); requestAnimationFrame(g); <Html>x</Html>")
        found = {tok for _, tok, _ in tsx.banned_uses(code)}
        self.assertTrue({"setTimeout", "requestAnimationFrame"} <= found)
        self.assertTrue(any(t.startswith("<") for t in found))

    def test_imports_parse_multiline_and_aliases(self) -> None:
        src = 'import {\n  defineScene,\n  useTheme as theme,\n  type Foo,\n} from "@kookaburra/toolkit";\nimport React from "react";\nimport "./side";\n'
        imports = tsx.parse_imports(src)
        specs = [i.specifier for i in imports]
        self.assertEqual(specs[:2], ["@kookaburra/toolkit", "react"])
        self.assertIn("./side", specs)
        self.assertEqual(imports[0].names, ["defineScene", "useTheme"])
        self.assertIn("theme", tsx.local_bindings(src))

    def test_hook_calls(self) -> None:
        code = "const m = useMemo(() => 1, []); const t = useTimeline(); obj.useThing();"
        self.assertEqual([n for _, n in tsx.hook_calls(code)], ["useMemo", "useTimeline"])

    def test_asset_scan_and_rewrite_match_rust(self) -> None:
        text = 'src="assets/a b.png" other="xassets/no.png" "assets/a b.png" assets/dir/c.jpg.'
        self.assertEqual(tsx.scan_asset_refs(text), ["assets/a b.png", "assets/dir/c.jpg"])
        out = tsx.rewrite_text_asset_refs('"assets/a.png" "assets/a.png.bak" "assets/a.png"', [("assets/a.png", "assets/a-2.png")])
        self.assertEqual(out, '"assets/a-2.png" "assets/a.png.bak" "assets/a-2.png"')

    def test_literal_asset_refs_ignore_comments(self) -> None:
        src = '// "assets/old.png"\nconst a = "assets/new.png";'
        self.assertEqual(tsx.literal_asset_refs(src), [(2, "assets/new.png")])
