"""kb video log and pair, pure: holds, changes, scrolls, money frames, notes and pairing on synthetic byte frames; labels."""

from __future__ import annotations

import math
import random
import unittest
from typing import Callable, List, Optional, Sequence, Tuple

from kblib.video import footage as fo
from kblib.video import labels, passes

SW, SH, PW, PH = 54, 118, 6, 480
STEP = 1000.0 / 60


def page(seed: int, length: int) -> List[float]:
    """A tall UI-like page: flat blocks of random grey with sharp edges, so rows are distinct along y."""
    rng = random.Random(seed)
    out, v = [], 128.0
    for _ in range(length):
        if rng.random() < 0.02:
            v = rng.uniform(30, 230)
        out.append(v)
    return out


class Painter:
    """Renders the page at a vertical offset into small frames and row profiles, area-averaged like ffmpeg's scale=flags=area."""

    def __init__(self, height: int = 2622, seed: int = 4) -> None:
        self.height = height
        self.page = page(seed, height * 4)
        self.prefix = [0.0]
        for v in self.page:
            self.prefix.append(self.prefix[-1] + v)

    def mean(self, a: float, b: float) -> float:
        ia, ib = int(a), int(b)
        if ia == ib:
            return self.page[ia]
        total = (ia + 1 - a) * self.page[ia] + (self.prefix[ib] - self.prefix[ia + 1]) + (b - ib) * self.page[ib]
        return total / (b - a)

    def frame(self, offset: float, rows: int, cols: int) -> bytes:
        k = self.height / rows
        return b"".join(bytes([max(0, min(255, int(self.mean(offset + r * k, offset + (r + 1) * k) + 0.5)))]) * cols for r in range(rows))


def flat(value: int, w: int = SW, h: int = SH) -> bytes:
    return bytes([value]) * (w * h)


def with_box(base: bytes, x: int, y: int, w: int, h: int, value: int, width: int = SW) -> bytes:
    out = bytearray(base)
    for r in range(y, y + h):
        out[r * width + x:r * width + x + w] = bytes([value]) * w
    return bytes(out)


def noisy(base: bytes, seed: int) -> bytes:
    """Encoder-like noise: a few pixels off by one or two levels."""
    rng = random.Random(seed)
    out = bytearray(base)
    for _ in range(40):
        i = rng.randrange(len(out))
        out[i] = max(0, min(255, out[i] + rng.choice((-2, -1, 1, 2))))
    return bytes(out)


def frames_of(smalls: Sequence[bytes], rows: Optional[Sequence[bytes]] = None, pts: Optional[Sequence[float]] = None,
              end_ms: Optional[float] = None, height: int = 2622) -> fo.Frames:
    n = len(smalls)
    rows = rows or [flat(128, PW, PH)] * n
    pts = pts if pts is not None else [i * STEP for i in range(n)]
    end = end_ms if end_ms is not None else n * STEP
    return fo.Frames(b"".join(smalls), SW, SH, b"".join(rows), PW, PH, pts, end, 1206, height)


def screen_story() -> Tuple[List[bytes], List[float]]:
    """1 s of screen A, a cut to B held 1 s, a 6-frame fade to C, C held, then a small badge appears on C."""
    a, b, c = flat(220), with_box(flat(240), 0, 0, SW, 12, 60), with_box(flat(30), 10, 30, 30, 40, 200)
    smalls: List[bytes] = []
    smalls += [noisy(a, i) if i % 7 == 0 else a for i in range(60)]
    smalls += [b] * 60
    for k in range(1, 7):
        smalls.append(bytes(int(x + (y - x) * k / 6) for x, y in zip(b, c)))
    smalls += [c] * 69
    smalls += [with_box(c, 45, 100, 2, 2, 255)] * 45
    return smalls, [i * STEP for i in range(len(smalls))]


class HoldsAndChangesTests(unittest.TestCase):
    def test_holds_are_exact_and_noise_never_breaks_one(self) -> None:
        smalls, _pts = screen_story()
        out = fo.analyse(frames_of(smalls))
        holds = [(fo.round_ms(h["startMs"]), fo.round_ms(h["endMs"])) for h in out["holds"]]
        self.assertEqual(holds, [(0, 1000), (1000, 2000), (2083, 3250), (3250, 4000)])
        changes = [(c["kind"], fo.round_ms(c["startMs"]), fo.round_ms(c["endMs"])) for c in out["changes"]]
        self.assertEqual(changes, [("screen", 1000, 1017), ("motion", 2000, 2100), ("motion", 3250, 3267)])

    def test_a_badge_the_frame_mean_misses_still_counts(self) -> None:
        smalls, _pts = screen_story()
        badge = fo.analyse(frames_of(smalls))["changes"][-1]
        self.assertEqual(badge["box"], [round(45 / SW, 3), round(100 / SH, 3), round(2 / SW, 3), round(2 / SH, 3)])
        self.assertLess(badge["peak"], fo.CHANGE_MAD)

    def test_variable_rate_holds_run_until_the_next_frame(self) -> None:
        a, b = flat(200), flat(40)
        pts = [0.0, 16.7, 33.3, 1400.0, 1416.7, 4000.0]
        out = fo.analyse(frames_of([a, a, a, b, b, a], pts=pts, end_ms=6000.0))
        self.assertEqual([(h["startMs"], h["endMs"]) for h in out["holds"]], [(0.0, 1400.0), (1400.0, 4000.0), (4000.0, 6000.0)])
        cut = out["changes"][0]
        self.assertEqual((cut["startMs"], round(cut["endMs"], 1)), (1400.0, 1416.7))

    def test_a_slow_fade_is_never_a_hold(self) -> None:
        # A fifth of the pixels step up by one each frame: every frame repeats its predecessor, the picture still drifts.
        fade = [bytes(100 + (i + p % 5) // 5 for p in range(SW * SH)) for i in range(240)]
        out = fo.analyse(frames_of(fade))
        self.assertEqual(out["holds"], [])
        self.assertTrue(out["changes"])
        still = fo.analyse(frames_of([noisy(flat(100), i) for i in range(240)]))
        self.assertEqual([(fo.round_ms(h["startMs"]), fo.round_ms(h["endMs"])) for h in still["holds"]], [(0, 4000)])
        self.assertEqual(still["changes"], [])

    def test_money_frames_skip_the_lead_in_and_quiet_changes(self) -> None:
        smalls, _pts = screen_story()
        fr = frames_of(smalls)
        out = fo.analyse(fr)
        money = [(m["hold"], fo.round_ms(m["atMs"]), m["kind"]) for m in out["moneyFrames"]]
        self.assertEqual(money, [("h2", 1500, "screen"), ("h3", 2583, "motion"), ("h4", 3625, "motion")])
        ctx = fo.context_from({"intervals": [{"kind": "idle", "sub": "blink", "startMs": 3000, "endMs": 4000}]})
        quiet = fo.analyse(fr, {"intervals": [{"id": "i1", "kind": "idle", "sub": "blink", "startMs": 3000, "endMs": 4000}]})
        self.assertEqual(quiet["changes"][-1]["kind"], "blink")
        self.assertNotIn("h4", [m["hold"] for m in quiet["moneyFrames"]])
        self.assertEqual(ctx["blink"], [[3000.0, 4000.0]])

    def test_a_cursor_on_a_steady_beat_is_a_blink_without_detect(self) -> None:
        screen = with_box(flat(230), 0, 0, SW, 10, 40)
        cursor = with_box(screen, 8, 60, 1, 3, 0)
        smalls = [flat(120)] * 30 + [(cursor if (i // 30) % 2 else screen) for i in range(240)]
        out = fo.analyse(frames_of(smalls))
        self.assertEqual(out["changes"][0]["kind"], "screen")
        self.assertEqual({c["kind"] for c in out["changes"][1:]}, {"blink"})
        self.assertEqual([m["hold"] for m in out["moneyFrames"]], ["h2"])

    def test_best_money_keeps_the_top_scores_in_time_order(self) -> None:
        items = [{"atMs": float(t), "score": s} for t, s in ((100, 0.2), (200, 0.9), (300, 0.5), (400, 0.9))]
        self.assertEqual([m["atMs"] for m in fo.best_money(items, 2)], [200.0, 400.0])
        self.assertEqual(len(fo.best_money(items, None)), 4)

    def test_report_rounds_and_filters_a_range(self) -> None:
        smalls, _pts = screen_story()
        rep = fo.report(fo.analyse(frames_of(smalls)), (1500.0, 2500.0))
        self.assertEqual([h["id"] for h in rep["holds"]], ["h2", "h3"])
        self.assertEqual(rep["holds"][0], {"id": "h2", "startMs": 1000, "endMs": 2000, "frames": 60, "frame": 60})
        self.assertEqual([c["id"] for c in rep["changes"]], ["ch2"])
        self.assertTrue(all(isinstance(m["atMs"], int) for m in rep["moneyFrames"]))


class ScrollTests(unittest.TestCase):
    def scroll(self, offset: Callable[[float], float], seconds: float = 4.0, height: int = 2622) -> dict:
        p = Painter(height)
        n = int(seconds * 60)
        smalls, rows = [], []
        for i in range(n):
            o = offset(i / 60.0)
            smalls.append(p.frame(o, SH, SW))
            rows.append(p.frame(o, PH, PW))
        return fo.analyse(frames_of(smalls, rows, height=height))

    def test_a_steady_scroll_has_an_exact_span_and_speed(self) -> None:
        for speed in (450.0, 600.0, 1234.0):
            out = self.scroll(lambda t: 0.0 if t < 1 else min(3.0, t - 1) * speed)
            self.assertEqual(len(out["scrolls"]), 1, speed)
            sc = out["scrolls"][0]
            self.assertEqual((fo.round_ms(sc["startMs"]), fo.round_ms(sc["endMs"])), (1017, 4000))
            self.assertEqual(sc["direction"], "up")
            self.assertLess(abs(sc["pxPerS"] - speed) / speed, 0.01, sc)
            self.assertAlmostEqual(sc["pxPerFrame"], speed / 60, delta=speed / 60 * 0.01)
            self.assertLessEqual(len(sc["velocity"]), fo.VELOCITY_MAX_BINS)
            self.assertEqual([c["kind"] for c in out["changes"]], ["scroll"])

    def test_a_fling_keeps_its_slow_tail_and_reads_down_when_reversed(self) -> None:
        fling = self.scroll(lambda t: 0.0 if t < 1 else 3000 * 0.5 * (1 - math.exp(-(t - 1) / 0.5)))
        sc = fling["scrolls"][0]
        travelled = 3000 * 0.5 * (1 - math.exp(-(sc["endMs"] - 1000 - STEP) / 1000 / 0.5))
        self.assertLess(abs(sc["pxPerS"] - travelled / ((sc["endMs"] - sc["startMs"] - STEP) / 1000)) / sc["pxPerS"], 0.05)
        self.assertLess(sc["velocity"][-1][1], 120)
        self.assertGreater(sc["endMs"], 3000)
        back = self.scroll(lambda t: 2000.0 - (0.0 if t < 1 else min(2.0, t - 1) * 700))
        self.assertEqual(back["scrolls"][0]["direction"], "down")
        self.assertLess(abs(back["scrolls"][0]["pxPerS"] - 700) / 700, 0.01)

    def test_a_recording_hiccup_mid_scroll_keeps_one_scroll(self) -> None:
        p = Painter(2622)
        smalls, rows = [], []
        for i in range(300):
            k = 119 if 120 <= i <= 123 else i
            o = max(0.0, min(4.0, k / 60.0 - 0.5)) * 600
            smalls.append(p.frame(o, SH, SW))
            rows.append(p.frame(o, PH, PW))
        out = fo.analyse(frames_of(smalls, rows))
        self.assertEqual([c["kind"] for c in out["changes"]], ["scroll", "scroll"])
        self.assertEqual(len(out["scrolls"]), 1)
        sc = out["scrolls"][0]
        self.assertEqual((fo.round_ms(sc["startMs"]), fo.round_ms(sc["endMs"])), (517, 4517))
        self.assertLess(abs(sc["pxPerS"] - 600) / 600, 0.01)

    def test_best_shift_resolves_a_fraction_of_a_row(self) -> None:
        p = Painter(2622)
        a = fo.row_means(p.frame(100.0, PH, PW), PW, PH)
        for rows in (2.0, 3.3, 6.12, -4.75):
            b = fo.row_means(p.frame(100.0 + rows * 2622 / PH, PH, PW), PW, PH)
            s, err, zero = fo.best_shift(a, b)
            self.assertAlmostEqual(s, rows, delta=0.06)
            self.assertLess(err, zero)

    def test_unrelated_screens_are_not_a_scroll(self) -> None:
        smalls = [flat(200)] * 30 + [with_box(flat(50), 0, k, SW, 10, 250) for k in range(0, 60, 7)] + [flat(90)] * 30
        rows = [flat(128, PW, PH)] * 30 + [bytes(random.Random(k).randrange(256) for _ in range(PW * PH)) for k in range(9)] + [flat(90, PW, PH)] * 30
        self.assertEqual(fo.analyse(frames_of(smalls, rows))["scrolls"], [])


class NotesTests(unittest.TestCase):
    TEXT = "# take one\n- 0:01.5 opens settings\n* 4s toggles dark mode\n1. 1:02.25 \u2013 saves\n[0:07] taps back\nno time here\n\n12.5sec: done\n"

    def test_lines_bullets_and_comments(self) -> None:
        notes, skipped = fo.parse_notes(self.TEXT)
        self.assertEqual([(n["line"], n["noteMs"], n["label"]) for n in notes],
                         [(2, 1500.0, "opens settings"), (3, 4000.0, "toggles dark mode"), (5, 7000.0, "taps back"),
                          (8, 12500.0, "done"), (4, 62250.0, "saves")])
        self.assertEqual(skipped, [6])

    def test_json_notes(self) -> None:
        notes, skipped = fo.parse_notes('{"notes": [{"t": "0:03.5", "label": "b"}, {"t": 1.25, "label": "a"}]}')
        self.assertEqual([(n["noteMs"], n["label"]) for n in notes], [(1250.0, "a"), (3500.0, "b")])
        self.assertEqual(skipped, [])
        with self.assertRaises(fo.NotesError):
            fo.parse_notes('{"notes": [{"label": "no time"}]}')
        with self.assertRaises(fo.NotesError):
            fo.parse_notes('{"notes": [{"t": "soon"}]}')

    @staticmethod
    def changes(starts: Sequence[float], kinds: Optional[Sequence[str]] = None) -> List[dict]:
        return [{"id": f"ch{i + 1}", "startMs": float(t), "kind": (kinds[i] if kinds else "screen")} for i, t in enumerate(starts)]

    def test_notes_one_to_two_seconds_early_align(self) -> None:
        truth = [3000, 7500, 12000, 16200, 22000]
        for seed in range(20):
            rng = random.Random(seed)
            notes = [{"line": i + 1, "label": f"n{i}", "noteMs": t - rng.uniform(1000, 2000)} for i, t in enumerate(truth)]
            # Other changes land before each note, and cursor blinks between a note and its change never match.
            others = [(t - 2600, "screen") for t in truth] + [(t - 500, "blink") for t in truth] + [(30000, "screen")]
            timeline = sorted([(t, "screen") for t in truth] + others)
            out = fo.align_notes(notes, self.changes([t for t, _k in timeline], [k for _t, k in timeline]))
            self.assertEqual([it["changeMs"] for it in out["items"]], truth, seed)
            self.assertTrue(1000 <= out["medianOffsetMs"] <= 2000, seed)
            self.assertTrue(all(it["confidence"] > 0.3 for it in out["items"]), seed)

    def test_the_median_pass_fixes_an_early_first_match(self) -> None:
        notes = [{"line": i, "label": "", "noteMs": t} for i, t in enumerate((1000, 5000, 9000, 13000))]
        changes = self.changes([2500, 6500, 9100, 10500, 14500])
        out = fo.align_notes(notes, changes)
        self.assertEqual(out["medianOffsetMs"], 1500)
        self.assertEqual([it["changeMs"] for it in out["items"]], [2500, 6500, 10500, 14500])

    def test_quiet_changes_never_match_and_order_holds(self) -> None:
        notes = [{"line": 1, "label": "", "noteMs": 1000.0}, {"line": 2, "label": "", "noteMs": 1100.0}]
        out = fo.align_notes(notes, self.changes([1200, 1500, 9000], ["blink", "tap", "screen"]))
        self.assertEqual(out["items"][0]["changeMs"], 1500)
        self.assertNotEqual(out["items"][1]["changeMs"], 1500)
        empty = fo.align_notes(notes, [])
        self.assertIsNone(empty["medianOffsetMs"])
        self.assertEqual([it["changeMs"] for it in empty["items"]], [None, None])


class PairTests(unittest.TestCase):
    @staticmethod
    def take(shift: int = 0, bright: int = 0, bar: bool = False, extra: Optional[int] = None) -> fo.Frames:
        """Eight distinct screens held 30 to 80 frames; B drops the first `shift` frames, brightens and paints a bar."""
        rng = random.Random(3)
        smalls: List[bytes] = []
        for k in range(8):
            screen = bytearray(flat(rng.randrange(60, 200)))
            for _ in range(5):
                x, y = rng.randrange(SW - 12), rng.randrange(SH - 20)
                screen = bytearray(with_box(bytes(screen), x, y, 12, 20, rng.randrange(256)))
            hold = 30 + 7 * k
            smalls += [bytes(screen)] * hold
            if extra is not None and k == extra:
                smalls += [flat(250)] * 40
            smalls += [bytes(rng.randrange(256) for _ in range(SW * SH))] * 2
        out = []
        for f in smalls[shift:]:
            f = bytes(min(255, v + bright) for v in f)
            if bar:
                f = with_box(f, 0, 100, SW, 8, 20)
            out.append(f)
        return frames_of(out)

    def states(self, fr: fo.Frames) -> List[dict]:
        return fo.states_of(fr, fo.holds_of(fr, fo.segments(fr, fo.Motion(fr))))

    def test_a_trimmed_brighter_take_with_a_bar_pairs_every_state_at_minus_150(self) -> None:
        a, b = self.states(self.take()), self.states(self.take(shift=9, bright=15, bar=True))
        out = fo.pair(a, b)
        self.assertEqual(len(out["pairs"]), 8)
        self.assertEqual({p["startOffsetMs"] for p in out["pairs"][1:]}, {-150})
        self.assertIsNone(out["pairs"][0]["startOffsetMs"])
        self.assertEqual(out["medianOffsetMs"], -150)
        self.assertEqual(out["driftMsPerS"], 0.0)
        self.assertEqual((out["unmatchedA"], out["unmatchedB"]), ([], []))

    def test_a_state_only_one_take_has_is_left_unmatched(self) -> None:
        a, b = self.states(self.take()), self.states(self.take(extra=3))
        out = fo.pair(a, b)
        self.assertEqual(len(out["pairs"]), 8)
        self.assertEqual(len(out["unmatchedB"]), 1)
        self.assertEqual(out["unmatchedA"], [])

    def test_drift_fit(self) -> None:
        self.assertAlmostEqual(fo.drift_fit([(t, -150 + 2.0 * t) for t in range(1, 10)]), 2.0, places=6)
        self.assertEqual(fo.drift_fit([(1.0, -150)]), 0.0)
        self.assertIsNone(fo.drift_fit([]))
        self.assertAlmostEqual(fo.drift_fit([(1, 0), (2, 0), (3, 0), (4, 900), (5, 0)]), 0.0, places=6)

    def test_signature_ignores_brightness_and_shape(self) -> None:
        f = with_box(flat(100), 10, 10, 20, 40, 220)
        self.assertEqual(len(fo.signature(f, SW, SH)), 18 * 40)
        self.assertLess(fo.sig_cost(fo.signature(f, SW, SH), fo.signature(bytes(v + 20 for v in f), SW, SH)), 0.01)
        self.assertEqual(len(fo.signature(flat(5, 54, 30), 54, 30)), 40 * 18)
        self.assertEqual(fo.sig_cost([1.0], [1.0, 2.0]), math.inf)


class LabelTests(unittest.TestCase):
    def test_stamps(self) -> None:
        self.assertEqual(labels.fmt_stamp(12345), "12.35s")
        self.assertEqual(labels.fmt_stamp(62250), "1:02.25")
        self.assertEqual(labels.fmt_stamp(-5), "0.00s")

    def test_label_png_round_trips_with_ink_on_a_backing(self) -> None:
        w, h, rows = labels.read_png_rgba(labels.label_png("1", scale=2))
        self.assertEqual((w, h), labels.text_size("1", 2))
        pixel = lambda x, y: tuple(rows[y][x * 4:x * 4 + 4])  # noqa: E731
        self.assertEqual(pixel(0, 0), labels.BACKING)
        self.assertEqual(pixel(4 + 2 * 2, 4), labels.INK)
        self.assertEqual(pixel(4, 4), labels.BACKING)

    def test_overlay_is_transparent_outside_its_labels(self) -> None:
        w, h, rows = labels.read_png_rgba(labels.overlay_png(40, 30, [(10, 5, "A")], scale=1))
        self.assertEqual((w, h), (40, 30))
        self.assertEqual(tuple(rows[0][0:4]), (0, 0, 0, 0))
        self.assertEqual(tuple(rows[5][40:44]), labels.BACKING)

    def test_every_glyph_is_five_by_seven(self) -> None:
        for ch, rows in labels.GLYPHS.items():
            self.assertEqual(len(rows), 7, ch)
            self.assertTrue(all(0 <= r < 32 for r in rows), ch)
        self.assertEqual(labels.glyph("\u00e9"), labels.GLYPHS["?"])


class PlumbingTests(unittest.TestCase):
    def test_showinfo_timing_uses_integer_pts(self) -> None:
        lines = [
            "[Parsed_showinfo_3 @ 0x1] config in time_base: 1/15360, frame_rate: 60/1",
            "[Parsed_showinfo_3 @ 0x1] n:   0 pts:      0 pts_time:0       duration:    256 duration_time:0.0166667 fmt:gray",
            "[Parsed_showinfo_3 @ 0x1] n:   1 pts:  15360000 pts_time:1000    duration:    256 duration_time:0.0166667 fmt:gray",
            "[Parsed_showinfo_3 @ 0x1] n:   2 pts:NOPTS pts_time:NOPTS duration:    256 duration_time:0.0166667 fmt:gray",
        ]
        rows = passes.parse_showinfo(lines)
        self.assertEqual(rows[1], (1000000.0, 256 / 15360 * 1000))
        self.assertEqual(rows[2][0], None)
        pts, end = passes.frame_times(rows, 900000.0)
        self.assertEqual(pts, [0.0, 1000000.0, round(1000000.0 + 256 / 15360 * 1000, 3)])
        self.assertEqual(end, round(pts[-1] + 256 / 15360 * 1000, 3))
        self.assertEqual(passes.profile_size(1206, 2622), (54, 118))
        self.assertEqual(passes.profile_size(1920, 1080), (54, 30))



if __name__ == "__main__":
    unittest.main()
