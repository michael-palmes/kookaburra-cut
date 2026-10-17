from __future__ import annotations

import random
import unittest

from kblib.video import editmath as em
from kblib.video import fit as f

from . import video_synth as vs


def tap_shown_ms(clips, tap) -> float:
    windows = em.tap_windows(em.relayout(clips), tap)
    return max((w["endMs"] - w["startMs"] for w in windows), default=0.0)


class FitKeepsTapHighlightsWhole(unittest.TestCase):
    def test_a_ramped_guard_still_shows_the_full_highlight(self) -> None:
        tap = {"id": "t1", "sourceId": "s1", "sourceMs": 24967, "pos": [0.694, 0.383]}
        doc = vs.screen_doc(taps=[tap])
        for target in (8000, 9000, 10000, 12000):
            res = f.fit(doc, {"s1": vs.screen_analysis()}, target)
            self.assertGreaterEqual(tap_shown_ms(res.clips, tap), em.TAP_DURATION_MS - 1, target)

    def test_random_taps_survive_a_fit(self) -> None:
        rng = random.Random(7)
        analysis = vs.screen_analysis()
        for _ in range(20):
            ms = rng.randrange(4000, 26000)
            tap = {"id": "t1", "sourceId": "s1", "sourceMs": ms, "pos": [0.5, 0.5]}
            try:
                res = f.fit(vs.screen_doc(taps=[tap]), {"s1": analysis}, rng.choice((8000, 10000, 14000)))
            except f.FitError:
                continue
            if any(c["inMs"] <= ms < c["outMs"] for c in res.clips):
                self.assertGreaterEqual(tap_shown_ms(res.clips, tap), em.TAP_DURATION_MS - 1, ms)


if __name__ == "__main__":
    unittest.main()
