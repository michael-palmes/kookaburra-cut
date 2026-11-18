"""Patterns over project files and command text stay linear, and answer exactly as the backtracking ones they replaced."""

from __future__ import annotations

import random
import re
import time
import unittest
from typing import Callable, List

from kblib import check, hookfast, leases, scene_ops, tsx
from kblib.film import pacing
from kblib.util import KbError

LIMIT_S = 1.0
OLD_QUOTED = re.compile(r"([\"'`])((?:\\.|(?!\1).)*)\1")
OLD_KB_WRITE = re.compile(hookfast.KB_WRITE.pattern.replace(r"(?:-[\w-]+", r"(?:--?[\w-]+", 1))
OLD_KB_VIDEO = re.compile(r"\bkb(?:\.py)?[\"']?\s+(?:--?\S+\s+)*video\b")
OLD_IMPORT = re.compile(r"(?m)^[ \t]*import\s+(type\s+)?((?:[\w$]+\s*,?\s*)?(?:\{[^}]*\})?\s*(?:\*\s*as\s+[\w$]+)?)\s*from\s*([\"'])([^\"']+)\3")
OLD_TOOLKIT_BRACES = re.compile(r"import\s*\{([^}]*)\}\s*from\s*[\"']@kookaburra/toolkit[\"']")
OLD_DEFINED_DURATION = re.compile(r"defineScene\(\s*\{[^}]*?\bdurationMs\s*:\s*([0-9]+(?:\.[0-9]+)?)")
OLD_EMBEDDED = re.compile(r"""useSceneText\(\s*["']([\w.-]+)["'][^;]*?["']embedded["']""")
OLD_FONT_SIZE = re.compile(r"\bfontSize\s*=\s*\{\s*([0-9]*\.?[0-9]+)\s*\}")
OLD_DEVICE_MODEL = re.compile(r"(?<![\w$.])model\s*=\s*\{?\s*([\"'])([\w-]+)\1")
OLD_REMOTE_SRC = re.compile(r"\b(?:src|href|url|map|texture|file|image|path)\s*[=:]\s*\{?\s*[\"'`]https?:", re.I)
OLD_SED_I = re.compile(r"\b(?:g?sed|perl)\b[^;&|\n]*?\s-[A-Za-z]*i")
OLD_SCENE_TOKEN = re.compile(r"(?:[^\s\"'=;&|<>()]*/)?scenes/[^\s\"';&|<>(),]*")
OLD_ASSET_TOKEN = re.compile(r"(?<![\w.-])(?:[^\s\"'=;&|<>()]*/)?(?:a(?:ss|ß)ets/|\.originals/)[^\s\"';&|<>(),]*", re.IGNORECASE)
OLD_TTL = r"(\d+)\s*([hms])"
COMMAND_TOKENS = ["kb", "kb.py", "./kb", " ", "  ", "\t", "-", "--", "---", "x", "=", "!", "'", '"', "scene", "add", "video", "cut", "list", "doc", "set", ";"]
IMPORT_TOKENS = ["import ", "import", "\nimport{", "type ", "a", "$b", " ", "\n", ",", "{ b }", "{b as c, type d}", "{", "}", "* as n", "*", " from ", "from",
                 "'x'", '"@kookaburra/toolkit"', "'@kookaburra/toolkit'", '"', "'"]
SCENE_TOKENS = ["defineScene({", "defineScene( {", " ", "durationMs", "durationMs: 1", ": ", "2.5", "}", "x", "{", "useSceneText(", "'k'", '"j.k"', "'embedded'",
                '"embedded"', "embedded", ";", "'", "fontSize={", "fontSize = { ", "1", ".", "5", "model=", "model = {", "'phone'", "src=", "url: {", "'https:", "`http:"]
SHELL_TOKENS = ["sed", "gsed", "perl", " ", "-i", "-ni", "-n", "x", "\n", ";", "|", "&", "/", "scenes/", "a.tsx", "assets/", "ASSETS/", "aßets/", ".originals/",
                "=", "(", ",", "'", "-", "+", "_"]
GLOB_TOKENS = ["*", "?", "a", "b", ".", "-", "/", "scenes/", "tsx", "json"]


def seconds(run: Callable[[], object]) -> float:
    start = time.perf_counter()
    run()
    return time.perf_counter() - start


def old_glob(token: str, path: str) -> bool:
    rx = "".join("[^/]*" if c == "*" else "[^/]" if c == "?" else re.escape(c) for c in token)
    return bool(re.match(rx + "$", path))


def mutated(rng: random.Random, text: str) -> str:
    for _ in range(rng.randint(0, 2)):
        at = rng.randint(0, len(text))
        text = text[:at] + rng.choice(["", " ", "\n", "{", "}", "*", ",", "'", '"', "a"]) + text[at + rng.randint(0, 1):]
    return text


def statements(seed: int, count: int = 20_000) -> List[str]:
    rng = random.Random(seed)
    space = ["", " ", "  ", "\n", "\t"]
    clauses = ["a", "a,", "a ,", "{ b }", "{b as c, type d}", "* as n", "a, { b }", "a, * as n", "{ b } * as n", "", "$x"]
    sources = ["'x'", '"@kookaburra/toolkit"', "'@kookaburra/toolkit'", "\"x'", "'"]
    sizes = ["12", "1.5", ".5", "1.", "..5", "", "1 2"]
    out = []
    for _ in range(count):
        imp = (rng.choice(["", "\n", "  ", "x"]) + "import" + rng.choice(space[1:]) + rng.choice(["", "type "]) + rng.choice(space).join(rng.choice(clauses) for _ in range(rng.randint(1, 3)))
               + rng.choice(space) + "from" + rng.choice(space) + rng.choice(sources))
        size = "fontSize" + rng.choice(space) + "=" + rng.choice(space) + "{" + rng.choice(space) + rng.choice(sizes) + rng.choice(space) + "}"
        out.append(mutated(rng, imp if rng.random() < 0.7 else imp + rng.choice(space) + size))
    return out


def texts(alphabet: List[str], seed: int, count: int = 20_000, longest: int = 12) -> List[str]:
    rng = random.Random(seed)
    return ["".join(rng.choice(alphabet) for _ in range(rng.randint(0, longest))) for _ in range(count)]


class LinearTests(unittest.TestCase):
    def assertQuick(self, run: Callable[[], object], label: str) -> None:
        self.assertLess(seconds(run), LIMIT_S, label)

    def test_an_unclosed_run_of_escapes_scans_quickly(self) -> None:
        for quote in "\"'`":
            text = quote + "\\a" * 50_000 + "\n"
            self.assertQuick(lambda: list(scene_ops.quoted_runs(text)), quote)

    def test_an_import_with_a_crafted_string_still_refuses_an_absolute_path(self) -> None:
        text = 'const a = "' + "\\a" * 50_000 + '\nconst b = "/Users/x/a.png";\n'
        start = time.perf_counter()
        with self.assertRaises(KbError):
            scene_ops.vet_tsx("scenes/a.tsx", text)
        self.assertLess(time.perf_counter() - start, LIMIT_S)

    def test_repeated_dashes_in_a_command_check_quickly(self) -> None:
        for pattern, unit in ((hookfast.KB_WRITE, "--- "), (hookfast.KB_WRITE, "-- -"), (hookfast.KB_VIDEO, "--! "), (hookfast.KB_VIDEO, "-! -")):
            command = "kb " + unit * 20_000 + "x"
            self.assertQuick(lambda: pattern.search(command), unit)

    def test_crafted_scene_text_checks_quickly(self) -> None:
        cases = {
            "imports": lambda: tsx.parse_imports("import a" + " " * 100_000 + "!"),
            "toolkit braces": lambda: tsx.local_bindings("import{" * 15_000),
            "duration": lambda: tsx.defined_duration("defineScene({" * 8_000),
            "embedded copy": lambda: pacing._EMBEDDED_RE.findall("useSceneText('a'" * 6_000),
            "font size": lambda: pacing._FONT_SIZE_RE.search('<T fontSize={' + "1" * 100_000),
            "device model": lambda: list(check.Checker.DEVICE_MODEL_RE.finditer("model=" + " " * 100_000 + "x")),
            "remote source": lambda: scene_ops.REMOTE_SRC.search("src=" + " " * 100_000 + "x"),
        }
        for label, run in cases.items():
            self.assertQuick(run, label)

    def test_crafted_commands_check_quickly(self) -> None:
        cases = {
            "scene tokens": lambda: hookfast.scene_tokens("a" * 100_000),
            "asset tokens": lambda: hookfast.asset_tokens("+" * 100_000),
            "in-place edits": lambda: hookfast.edits_in_place("sed " * 25_000),
            "globs": lambda: hookfast.names_scene("scenes/" + "*" * 10_000 + "!", "hero"),
            "lease time": lambda: self.assertRaises(KbError, leases.parse_ttl, "1" * 100_000 + "x"),
        }
        for label, run in cases.items():
            self.assertQuick(run, label)


class SameAnswerTests(unittest.TestCase):
    def test_quoted_runs_match_the_old_scan(self) -> None:
        for text in texts(["\"", "'", "`", "\\", "a", "/", "\n"], 7, 30_000, 14):
            self.assertEqual(list(scene_ops.quoted_runs(text)), [m.group(2) for m in OLD_QUOTED.finditer(text)], repr(text))

    def test_the_command_checks_match_the_old_ones(self) -> None:
        for command in texts(COMMAND_TOKENS, 11, 30_000, 10):
            self.assertEqual(bool(hookfast.KB_WRITE.search(command)), bool(OLD_KB_WRITE.search(command)), repr(command))
            self.assertEqual(bool(hookfast.KB_VIDEO.search(command)), bool(OLD_KB_VIDEO.search(command)), repr(command))

    def test_the_command_checks_still_tell_writes_from_reads(self) -> None:
        self.assertTrue(hookfast.KB_WRITE.search("./kb --agent a scene add hero"))
        self.assertTrue(hookfast.KB_WRITE.search("kb -q --project=x video cut a"))
        self.assertFalse(hookfast.KB_WRITE.search("kb --agent a video list"))
        self.assertTrue(hookfast.KB_VIDEO.search("kb --agent=a video cut"))
        self.assertFalse(hookfast.KB_VIDEO.search("kb scene add video"))

    def test_scene_text_patterns_match_the_old_ones(self) -> None:
        for text in texts(IMPORT_TOKENS, 13, 20_000, 10) + statements(37):
            new = [(m.span(), m.group(1), m.group(3), m.group(4)) for m in tsx.IMPORT_RE.finditer(text)]
            old = [(m.span(), m.group(1), m.group(3), m.group(4)) for m in OLD_IMPORT.finditer(text)]
            self.assertEqual(new, old, repr(text))
            self.assertEqual([(i.specifier, i.names) for i in tsx.parse_imports(text)],
                             [(m.group(4), _brace_names(m.group(2))) for m in OLD_IMPORT.finditer(text)] + _bare_and_exports(text), repr(text))
            self.assertEqual([m.group(1) for m in tsx.TOOLKIT_BRACES.finditer(text) if m.group(2)], OLD_TOOLKIT_BRACES.findall(text), repr(text))
        for text in texts(SCENE_TOKENS, 31, 20_000, 10) + statements(41):
            new_d, old_d = tsx._DEFINED_DURATION.search(text), OLD_DEFINED_DURATION.search(text)
            self.assertEqual(new_d and (new_d.group(1), new_d.span(1)), old_d and (old_d.group(1), old_d.span(1)), repr(text))
            self.assertEqual({k for k, q in pacing._EMBEDDED_RE.findall(text) if q}, set(OLD_EMBEDDED.findall(text)), repr(text))
            new_f, old_f = pacing._FONT_SIZE_RE.search(text), OLD_FONT_SIZE.search(text)
            self.assertEqual(new_f and new_f.group(1), old_f and old_f.group(1), repr(text))
            self.assertEqual([m.group(2) for m in check.Checker.DEVICE_MODEL_RE.finditer(text)], [m.group(2) for m in OLD_DEVICE_MODEL.finditer(text)], repr(text))
            self.assertEqual(bool(scene_ops.REMOTE_SRC.search(text)), bool(OLD_REMOTE_SRC.search(text)), repr(text))

    def test_command_patterns_match_the_old_ones(self) -> None:
        for command in texts(SHELL_TOKENS, 17):
            self.assertEqual(hookfast.scene_tokens(command), OLD_SCENE_TOKEN.findall(command), repr(command))
            self.assertEqual(hookfast.asset_tokens(command), OLD_ASSET_TOKEN.findall(command), repr(command))
            self.assertEqual(hookfast.edits_in_place(command), bool(OLD_SED_I.search(command)), repr(command))

    def test_globs_match_the_old_ones(self) -> None:
        rng = random.Random(19)
        for token in texts(GLOB_TOKENS, 23, 20_000, 8):
            for path in (f"scenes/{rng.choice(['a', 'ab', 'a-b', 'b.a'])}.{rng.choice(['tsx', 'json'])}", "".join(rng.choice("ab./*?") for _ in range(6))):
                self.assertEqual(hookfast._globbed(token, path), old_glob(token, path), (token, path))

    def test_lease_times_match_the_old_reading(self) -> None:
        for text in texts(["1", "2", "0", " ", "h", "m", "s", "x"], 29, 20_000, 8):
            self.assertEqual(re.findall(r"(?<!\d)(\d+)\s*([hms])", text), re.findall(OLD_TTL, text), repr(text))
            self.assertEqual(re.sub(r"(?<!\d)(\d+)\s*([hms])", "", text), re.sub(OLD_TTL, "", text), repr(text))


def _brace_names(clause: str) -> List[str]:
    brace = re.search(r"\{([^}]*)\}", clause or "")
    if not brace:
        return []
    return [p.strip().split(" as ")[0].strip() for p in brace.group(1).split(",") if p.strip() and not p.strip().startswith("type ")]


def _bare_and_exports(text: str) -> List[tuple]:
    return [(m.group(2), []) for m in tsx.BARE_IMPORT_RE.finditer(text)] + [(m.group(2), []) for m in tsx.EXPORT_FROM_RE.finditer(text)]


if __name__ == "__main__":
    unittest.main()
