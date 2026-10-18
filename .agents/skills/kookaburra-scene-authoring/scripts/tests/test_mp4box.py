"""kblib/mp4box.py and the static conform verdict: synthetic movies built byte by byte, plus real clips when ffmpeg is here."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from kblib import conform, mp4box

from . import mp4synth as ms
from .video_synth import REPO_BIN


def analyse(data: bytes, name: str = "clip.mov"):
    tmp = Path(tempfile.mkdtemp(prefix="kbmp4-"))
    try:
        path = ms.write(tmp / name, data)
        return mp4box.probe(path)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class EditStartTests(unittest.TestCase):
    def test_a_clean_constant_rate_clip(self) -> None:
        box = analyse(ms.movie(**ms.CLEAN))
        self.assertEqual((box["editStart"], box["edited"], box["vfr"], box["samples"]), ("first-frame", False, False, 60))
        self.assertEqual(box["expected"], {"frames": 60, "firstPtsMs": 0.0, "lastPtsMs": 983.3})
        self.assertEqual(box["editList"], [{"mediaTimeMs": 0.0, "durationMs": 1000.0, "rate": 1.0}])
        self.assertEqual(conform.evaluate(None, box, "mov")["verdict"], "ok")

    def test_no_edit_list_at_all(self) -> None:
        box = analyse(ms.movie([10] * 30))
        self.assertEqual((box["editStart"], box["edited"], box["editList"]), ("none", False, []))
        self.assertEqual(box["expected"]["frames"], 30)

    def test_an_edit_inside_a_held_frame_is_the_misdecode_class(self) -> None:
        box = analyse(ms.movie(**ms.MID_SAMPLE))
        self.assertEqual((box["editStart"], box["edited"], box["vfr"]), ("mid-sample", True, True))
        self.assertEqual(box["expected"], {"frames": 31, "firstPtsMs": 0.0, "lastPtsMs": 1216.7})
        verdict = conform.evaluate(None, box, "mov")
        self.assertEqual(verdict["verdict"], "ffmpeg-misdecodes")
        self.assertEqual(verdict["reasons"], ["vfr", "edit-list", "edit-mid-sample"])
        self.assertEqual(verdict["why"], ["vfr", "edit-list"])
        self.assertTrue(verdict["recommended"])

    def test_an_edit_on_a_frame_boundary_is_only_suspect(self) -> None:
        box = analyse(ms.movie(**ms.ON_FRAME))
        self.assertEqual((box["editStart"], box["edited"]), ("frame", True))
        self.assertEqual(box["expected"]["frames"], 90)
        verdict = conform.evaluate(None, box, "mp4")
        self.assertEqual((verdict["verdict"], verdict["why"]), ("suspect", ["edit-list"]))

    def test_the_b_frame_delay_edit_is_trivial(self) -> None:
        # I P B B as x264 stores them: composition offsets shift every frame by two, and the edit opens on the first shown.
        deltas = [10] * 8
        offsets = [20, 50, 10, 10, 50, 20, 20, 20]
        box = analyse(ms.movie(deltas, offsets=offsets, edits=[(133, 20, 1.0)]))
        self.assertEqual((box["editStart"], box["edited"], box["reorders"]), ("first-frame", False, True))
        verdict = conform.evaluate(None, box, "mp4")
        self.assertEqual((verdict["verdict"], verdict["reasons"], verdict["why"]), ("ok", ["b-frames"], []))
        trimmed = analyse(ms.movie(deltas, offsets=offsets, edits=[(100, 45, 1.0)]))
        self.assertEqual(trimmed["editStart"], "mid-sample")
        self.assertIn("b-frames", conform.evaluate(None, trimmed, "mp4")["why"])

    def test_empty_edits_several_segments_and_rates_are_complex(self) -> None:
        delay = analyse(ms.movie([10] * 30, edits=[(200, -1, 1.0), (500, 0, 1.0)]))
        self.assertEqual((delay["editStart"], delay["edited"], delay["expected"]), ("complex", True, None))
        self.assertEqual(delay["editList"][0]["mediaTimeMs"], None)
        slow = analyse(ms.movie([10] * 30, edits=[(1000, 0, 0.5)]))
        self.assertEqual(slow["editStart"], "complex")
        zero = analyse(ms.movie([10] * 30, edits=[(0, -1, 1.0), (500, 0, 1.0)]))
        self.assertEqual(zero["editStart"], "first-frame", "a zero-length empty edit is no edit")

    def test_a_gap_before_the_first_frame(self) -> None:
        box = analyse(ms.movie([10] * 30, offsets=[60] * 30, edits=[(500, 0, 1.0)]))
        self.assertEqual((box["editStart"], box["edited"]), ("gap", True))


class ContainerTests(unittest.TestCase):
    def test_vfr_from_the_sample_table(self) -> None:
        self.assertFalse(analyse(ms.movie([10] * 60))["vfr"])
        self.assertTrue(analyse(ms.movie(ms.HELD))["vfr"])
        self.assertFalse(analyse(ms.movie([10] * 59 + [11]))["vfr"], "a near-constant recording is used as it is")

    def test_colour_tags_from_the_colr_box(self) -> None:
        box = analyse(ms.movie([10] * 10, colr=ms.colr_nclx(12, 13, 1)), "p3.mp4")
        self.assertEqual(box["colour"], {"primaries": "smpte432", "transfer": "iec61966-2-1", "matrix": "bt709", "range": "tv"})
        verdict = conform.evaluate(None, box, "mp4")
        self.assertEqual((verdict["why"], verdict["recommended"]), (["primaries"], True))
        self.assertTrue(conform.needs_convert(conform.colour_of(None, box)))
        hdr = analyse(ms.movie([10] * 10, colr=ms.colr_nclx(9, 16, 9)), "hdr.mp4")
        refused = conform.evaluate(None, hdr, "mp4")
        self.assertEqual((refused["refused"]["code"], refused["recommended"]), ("hdr", False))

    def test_layouts_readers_meet(self) -> None:
        for kwargs in ({"moov_first": True}, {"large_mdat": True}, {"elst_version": 1}):
            box = analyse(ms.movie(**dict(ms.MID_SAMPLE, **kwargs)))
            self.assertEqual(box["editStart"], "mid-sample", kwargs)
        frag = analyse(ms.movie([10] * 10, fragmented=True))
        self.assertTrue(frag["fragmented"])

    def test_not_a_movie(self) -> None:
        self.assertIsNone(analyse(b"\x89PNG\r\n\x1a\n" + b"\0" * 64))
        self.assertIsNone(analyse(ms.movie([10] * 30)[:40]))
        self.assertIsNone(analyse(b""))
        good = ms.movie([10] * 30)
        self.assertIsNone(analyse(good[:-20]), "a truncated moov is unreadable, never a crash")

    def test_decoder_comparison(self) -> None:
        expected = {"frames": 91, "firstPtsMs": 0.0, "lastPtsMs": 3433.3}
        self.assertEqual(mp4box.span_reasons(expected, {"frames": 90, "firstPtsMs": 0.0, "lastPtsMs": 2483.3}), ["count-mismatch", "span-mismatch"])
        self.assertEqual(mp4box.span_reasons(expected, dict(expected)), [])
        self.assertEqual(mp4box.span_reasons(expected, {"frames": 91, "firstPtsMs": 0.0, "lastPtsMs": 3434.9}), [])

    def test_the_app_verdict_merges_with_the_container(self) -> None:
        app = {"verdict": "suspect", "reasons": ["vfr", "edit-list"], "conform": {"recommended": True, "why": ["vfr", "edit-list"], "refused": None}}
        box = analyse(ms.movie(**ms.MID_SAMPLE))
        merged = conform.merge(app, conform.evaluate(None, box, "mov"))
        self.assertEqual((merged["verdict"], merged["reasons"]), ("ffmpeg-misdecodes", ["vfr", "edit-list", "edit-mid-sample"]))
        refused = dict(app, conform={"recommended": False, "why": ["vfr"], "refused": {"code": "10-bit", "hint": "x"}})
        self.assertFalse(conform.merge(refused, conform.evaluate(None, box, "mov"))["recommended"], "the app's refusal stands")

    def test_ffprobe_facts_mirror_the_app(self) -> None:
        data = {"format": {"format_name": "mov,mp4,m4a", "duration": "2.0"},
                "streams": [{"codec_type": "video", "codec_name": "hevc", "width": 1080, "height": 1920, "r_frame_rate": "600/1", "avg_frame_rate": "30/1",
                             "has_b_frames": 2, "pix_fmt": "yuv420p10le", "color_primaries": "smpte432", "color_transfer": "unknown"},
                            {"codec_type": "audio", "codec_name": "aac"}]}
        facts = conform.ff_facts(data)
        self.assertEqual((facts["container"], facts["vfr"], facts["bits"], facts["bframes"], facts["hasAudio"]), ("mov", True, 10, 2, True))
        self.assertEqual(facts["colour"], {"primaries": "smpte432", "transfer": None, "matrix": None, "range": None})
        verdict = conform.evaluate(facts, None, "mov")
        self.assertEqual((verdict["refused"]["code"], verdict["recommended"]), ("10-bit", False))
        self.assertEqual(conform.evaluate(None, None, "webm")["refused"]["code"], "unreadable")


def _ffmpeg() -> str:
    for candidate in (str(REPO_BIN / "ffmpeg-aarch64-apple-darwin"), shutil.which("ffmpeg")):
        if candidate and Path(candidate).is_file():
            out = subprocess.run([candidate, "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
            if "libx264" in out:
                return candidate
    return ""


FFMPEG = _ffmpeg()


@unittest.skipUnless(FFMPEG, "no ffmpeg with libx264 (the kit's fixture clips are generated, never committed)")
class RealClipTests(unittest.TestCase):
    """conform.rs's barcode fixture: a held VFR MOV and a stream-copy trim whose edit opens inside a held frame."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.dir = Path(tempfile.mkdtemp(prefix="kbmp4real-"))
        expr = "if(lt(N,30),N,if(lt(N,90),29,if(lt(N,150),N,if(lt(N,210),149,N))))"
        graph = f"color=c=gray:s=320x240:r=60:d=4,format=yuv420p,geq=lum='if(lt(Y,32),if(mod(floor(({expr})/pow(2,floor(X/(W/16)))),2),235,16),lum(X,Y))':cb=128:cr=128"
        run = lambda *a: subprocess.run([FFMPEG, "-v", "error", "-y", *a], check=True, capture_output=True)  # noqa: E731
        run("-f", "lavfi", "-i", graph, "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", str(cls.dir / "held.mp4"))
        run("-i", str(cls.dir / "held.mp4"), "-vf", "mpdecimate=hi=1:lo=1:frac=0:max=0", "-fps_mode", "vfr", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", str(cls.dir / "vfr.mov"))
        run("-ss", "0.55", "-i", str(cls.dir / "vfr.mov"), "-c", "copy", str(cls.dir / "trim.mov"))

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_the_trim_reads_as_avfoundation_presents_it(self) -> None:
        box = mp4box.probe(self.dir / "trim.mov")
        self.assertEqual(box["editStart"], "mid-sample")
        # conform.rs measured AVFoundation at 91 frames to 3433.3 ms on this clip, ffmpeg at 90 to 2483.3.
        self.assertEqual(box["expected"], {"frames": 91, "firstPtsMs": 0.0, "lastPtsMs": 3433.3})
        decoded = conform.ffmpeg_decode(FFMPEG, self.dir / "trim.mov")
        self.assertEqual(decoded, {"frames": 90, "firstPtsMs": 0.0, "lastPtsMs": 2483.3})
        self.assertEqual(mp4box.span_reasons(box["expected"], decoded), ["count-mismatch", "span-mismatch"])

    def test_the_untrimmed_clips(self) -> None:
        vfr = mp4box.probe(self.dir / "vfr.mov")
        self.assertEqual((vfr["editStart"], vfr["vfr"], vfr["expected"]["frames"]), ("first-frame", True, 120))
        held = mp4box.probe(self.dir / "held.mp4")
        self.assertEqual((held["vfr"], held["samples"]), (False, 240))
        self.assertEqual(conform.ffmpeg_decode(FFMPEG, self.dir / "vfr.mov")["frames"], vfr["expected"]["frames"])


if __name__ == "__main__":
    unittest.main()
