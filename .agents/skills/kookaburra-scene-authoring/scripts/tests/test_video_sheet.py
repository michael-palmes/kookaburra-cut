from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from kblib.video import review as rv
from kblib.video import sheetlayout as sl

from . import video_synth as vs

ASPECTS = (360 / 784, 1206 / 2622, 9 / 16, 1.0, 4 / 5, 16 / 10, 16 / 9, 21 / 9)


class LayoutTests(unittest.TestCase):
    def test_every_sheet_fits_read(self) -> None:
        for aspect in ASPECTS:
            for count in range(1, sl.MAX_CELLS + 1):
                with self.subTest(aspect=round(aspect, 3), count=count):
                    sheets = sl.plan_sheets(count, aspect)
                    self.assertEqual(sum(s["cells"] for s in sheets), count)
                    for s in sheets:
                        self.assertLessEqual(max(s["width"], s["height"]), sl.MAX_LONG)
                        self.assertLessEqual(s["width"] * s["height"], sl.MAX_PIXELS)
                        self.assertGreaterEqual(s["cols"] * s["rows"], s["cells"])
                        self.assertEqual((s["cellW"] % 2, s["cellH"] % 2), (0, 0))
                        if s["cells"] > 1:
                            self.assertGreaterEqual(min(s["cellW"], s["cellH"]), sl.MIN_CELL_SHORT)

    def test_sheet_dims_include_margins_bars_and_padding(self) -> None:
        s = sl.layout_one(6, 16 / 9, cols=3)
        self.assertEqual(s["width"], 2 * sl.MARGIN + 3 * s["cellW"] + 2 * sl.PADDING)
        self.assertEqual(s["height"], 2 * sl.MARGIN + 2 * (s["cellH"] + sl.BAR) + sl.PADDING)

    def test_many_portrait_cells_split(self) -> None:
        sheets = sl.plan_sheets(48, 360 / 784)
        self.assertGreater(len(sheets), 1)
        self.assertEqual([s["index"] for s in sheets], list(range(1, len(sheets) + 1)))

    def test_pairs_stay_side_by_side(self) -> None:
        for aspect in ASPECTS:
            for count in range(2, sl.MAX_CELLS + 1, 2):
                for s in sl.plan_sheets(count, aspect, pairs=True):
                    self.assertEqual((s["cols"] % 2, s["cells"] % 2), (0, 0), (aspect, count, s))

    def test_fixed_columns(self) -> None:
        s = sl.plan_sheets(8, 16 / 9, cols=2)[0]
        self.assertEqual((s["cols"], s["rows"]), (2, 4))

    def test_single_frames(self) -> None:
        self.assertEqual(sl.frame_size(1206, 2622), (720, 1568))
        self.assertEqual(sl.frame_size(360, 784), (360, 784))
        w, h = sl.frame_size(1206, 2622, grid=True)
        self.assertEqual((w % 20, h % 20), (0, 0))
        self.assertLessEqual(max(w, h), 1568)
        self.assertEqual(sl.frame_size(72, 78, upscale=True), (1446, 1568))


@unittest.skipUnless(vs.tools(), "no ffmpeg")
class ComposeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="kb-sheet-"))
        self.ff = vs.tools()[0]  # type: ignore[index]

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_composed_png_matches_the_layout(self) -> None:
        cells = []
        for i, colour in enumerate(("red", "green", "blue", "white", "yellow")):
            png = self.tmp / f"c{i}.png"
            subprocess.run([self.ff, "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={colour}:s=360x784", "-frames:v", "1", str(png)], check=True)
            cells.append({"png": png, "cls": ("1x", "faster", "slower", "hold", "raw")[i], "seam": i == 2})
        layout = sl.plan_sheets(len(cells), 360 / 784)[0]
        out = rv.compose_sheet(self.ff, cells, self.tmp / "sheet.png", layout)
        data = out.read_bytes()
        self.assertEqual((int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")), (layout["width"], layout["height"]))
        raw = subprocess.run([self.ff, "-v", "error", "-i", str(out), "-vf", f"crop=1:1:{sl.MARGIN + 1}:{sl.MARGIN + 1},format=rgb24",
                              "-f", "rawvideo", "-"], capture_output=True).stdout
        self.assertEqual(raw, bytes.fromhex(rv.COLOURS["1x"][2:]))


if __name__ == "__main__":
    unittest.main()
