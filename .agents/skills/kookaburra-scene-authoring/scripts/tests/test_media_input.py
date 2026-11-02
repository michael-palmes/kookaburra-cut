"""Every kb lane that opens a file takes the whitelist, and a playlist named as a song is refused."""

from __future__ import annotations

import ast
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from kblib.media_input import INPUT_ARGS, STILL_INPUT_ARGS, input_args

SCRIPTS = Path(__file__).resolve().parents[1]
# kb's own numbered capture frames, never a file it was named.
OWN_SEQUENCES = {"kblib/preview.py"}
PROBE_FLAGS = {"-show_streams", "-show_format", "-show_entries", "-select_streams", "-count_packets"}


def opens_a_file(node: ast.List) -> bool:
    words = {e.value for e in node.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)}
    return "-i" in words or bool(words & PROBE_FLAGS)


class EveryLane(unittest.TestCase):
    def test_every_lane_takes_the_whitelist(self) -> None:
        seen = 0
        for path in sorted(p for p in SCRIPTS.rglob("*.py") if "tests" not in p.relative_to(SCRIPTS).parts):
            rel = path.relative_to(SCRIPTS).as_posix()
            if rel == "kblib/media_input.py" or rel in OWN_SEQUENCES:
                continue
            text = path.read_text()
            for statement in ast.walk(ast.parse(text)):
                if not isinstance(statement, ast.stmt) or isinstance(statement, (ast.FunctionDef, ast.ClassDef, ast.If, ast.For, ast.Try, ast.While, ast.With)):
                    continue
                if not any(isinstance(n, ast.List) and opens_a_file(n) for n in ast.walk(statement)):
                    continue
                seen += 1
                source = ast.get_source_segment(text, statement) or ""
                self.assertTrue("input_args(" in source or "INPUT_ARGS" in source, f"{rel}:{statement.lineno} opens a file with no whitelist: use media_input.input_args")
        self.assertGreater(seen, 15, "the scan should reach the lanes")

    def test_the_name_picks_the_list(self) -> None:
        self.assertEqual(input_args(Path("a.MP4")), INPUT_ARGS)
        self.assertEqual(input_args(Path("a.JPG")), STILL_INPUT_ARGS)
        self.assertNotIn("image2", INPUT_ARGS[3])
        for playlist in ("concat", "ffconcat", "hls", "dash", "lavfi"):
            self.assertNotIn(playlist, INPUT_ARGS[3].split(","))
            self.assertNotIn(playlist, STILL_INPUT_ARGS[3].split(","))


@unittest.skipUnless(shutil.which("ffprobe") and shutil.which("ffmpeg"), "needs ffmpeg")
class RealTools(unittest.TestCase):
    def test_supported_kinds_open_and_a_playlist_does_not(self) -> None:
        ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            picture = ["-f", "lavfi", "-i", "color=c=gray:s=32x32:d=0.1"]
            for name, args in (("a.mp4", picture), ("a.mov", picture), ("a.png", picture + ["-frames:v", "1"]), ("a.jpg", picture + ["-frames:v", "1"]),
                               ("a.wav", ["-f", "lavfi", "-i", "sine=d=0.1"]), ("a.mp3", ["-f", "lavfi", "-i", "sine=d=0.1"])):
                subprocess.run([ffmpeg, "-v", "error", "-y", "-nostdin", *args, str(root / name)], check=True, stdin=subprocess.DEVNULL)
                proc = subprocess.run([ffprobe, "-v", "error", *input_args(root / name), "-show_format", str(root / name)], capture_output=True, text=True, stdin=subprocess.DEVNULL)
                self.assertEqual(proc.returncode, 0, f"{name}: {proc.stderr}")
            for name in ("list.mp3", "list.mp4", "list.jpg"):
                (root / name).write_text("ffconcat version 1.0\nfile a.mp4\n")
                proc = subprocess.run([ffprobe, "-v", "error", *input_args(root / name), "-show_format", str(root / name)], capture_output=True, text=True, stdin=subprocess.DEVNULL)
                self.assertNotEqual(proc.returncode, 0, f"{name} should be refused")
                self.assertIn("not on whitelist", proc.stderr)


if __name__ == "__main__":
    unittest.main()
