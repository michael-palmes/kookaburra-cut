from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from typing import Any, Dict

from kblib.project import Project
from kblib.util import KbError
from kblib.video import editdoc
from kblib.video.editops import apply_op

from .helpers import KbTestCase, video_project, write_json


def raw_doc(**extra: Any) -> Dict[str, Any]:
    d: Dict[str, Any] = {
        "version": 1,
        "name": "rec",
        "sources": [{"id": "s1", "rel": "assets/rec.mp4", "width": 1920, "height": 1080, "fps": 60, "durationMs": 10000}],
        "settings": {"width": 1920, "height": 1080, "fps": 60},
        "clips": [{"id": "c1", "sourceId": "s1", "inMs": 0, "outMs": 10000, "speed": 1, "startMs": 0}],
    }
    d.update(extra)
    return d


class ParseTests(KbTestCase):
    def corrupt(self, doc: Any) -> str:
        with self.assertRaises(editdoc.DocError) as cm:
            editdoc.parse(json.dumps(doc) if not isinstance(doc, str) else doc)
        return cm.exception.message

    def test_defaults_like_serde(self) -> None:
        doc = editdoc.parse(json.dumps(raw_doc(taps=[], masks=[{"id": "m1", "sourceId": "s1", "keys": [{"sourceMs": 0, "rect": [0, 0, 0.1, 0.1]}]}], reference={"rel": "assets/b.mp4"}, extra=1, tapStyle=None)))
        self.assertEqual(doc["sources"][0]["kind"], "video")
        self.assertEqual(doc["masks"][0]["style"], "solid")
        self.assertEqual((doc["masks"][0]["startMs"], doc["masks"][0]["endMs"]), (0, 0))
        self.assertEqual(doc["reference"], {"rel": "assets/b.mp4", "offsetMs": 0})
        self.assertNotIn("taps", doc)
        self.assertNotIn("extra", doc)
        self.assertNotIn("tapStyle", doc)
        held = editdoc.parse(json.dumps(raw_doc(clips=[{"id": "c1", "sourceId": "s1", "inMs": 0, "outMs": 0, "speed": 1, "startMs": 0, "holdMs": None}])))
        self.assertNotIn("holdMs", held["clips"][0])
        self.assertEqual(editdoc.stamped_version(doc), 2)

    def test_u64_strictness(self) -> None:
        c = raw_doc()["clips"][0]
        self.assertIn("expected u64", self.corrupt(raw_doc(clips=[dict(c, inMs=1.5)])))
        self.assertIn("expected u64", self.corrupt(raw_doc(clips=[dict(c, inMs=1.0)])))
        self.assertIn("integer `-1`", self.corrupt(raw_doc(clips=[dict(c, outMs=-1)])))
        self.assertIn("expected u64", self.corrupt(raw_doc(clips=[dict(c, startMs=True)])))
        self.assertIn("expected u32", self.corrupt(raw_doc(settings={"width": 2 ** 33, "height": 1, "fps": 1})))
        self.assertIn("missing field `speed`", self.corrupt(raw_doc(clips=[{k: v for k, v in c.items() if k != "speed"}])))
        self.assertIn("duplicate field `inMs`", self.corrupt(json.dumps(raw_doc()).replace('"inMs": 0', '"inMs": 0, "inMs": 5')))
        self.assertIn("unknown variant", self.corrupt(raw_doc(sources=[dict(raw_doc()["sources"][0], kind="gif")])))
        self.assertIn("length 2", self.corrupt(raw_doc(taps=[{"id": "t1", "sourceId": "s1", "sourceMs": 0, "pos": [0, 0, 0]}])))
        self.assertIn("not valid JSON", self.corrupt(json.dumps(raw_doc()).replace('"speed": 1', '"speed": NaN')))
        self.assertIn("expected a sequence", self.corrupt(raw_doc(taps=None)))
        self.assertTrue(self.corrupt("{nope").startswith("edit is corrupt"))

    def test_newer_versions_refuse(self) -> None:
        with self.assertRaises(editdoc.DocError) as cm:
            editdoc.parse(json.dumps(raw_doc(version=3)))
        self.assertEqual(cm.exception.kind, "version")
        self.assertIn("needs a newer Kookaburra Cut", cm.exception.message)

    def test_names_follow_rust_slugify(self) -> None:
        self.assertEqual(editdoc.slugify("  Screen Recording 2026-10-16 at 09.41.22  "), "screen-recording-2026-10-16-at-09-41-22")
        self.assertEqual(editdoc.slugify("___"), "")
        self.assertEqual(editdoc.slugify("Café_Demo"), "caf-demo")
        self.assertEqual(editdoc.default_name("assets/My Clip.final.mov"), "my-clip-final")
        self.assertEqual(editdoc.default_name("assets/???.mp4"), "edit")
        self.assertTrue(editdoc.validate_slug("a_b-1"))
        self.assertFalse(editdoc.validate_slug(".x"))
        with self.assertRaises(KbError):
            editdoc.check_name("_tap_prefs")
        self.assertEqual(editdoc.name_of_output("assets/rec-edited.mp4"), "rec")
        self.assertIsNone(editdoc.name_of_output("assets/sub/rec.mp4"))

    def test_u64_problems_catch_floats(self) -> None:
        doc = editdoc.parse(json.dumps(raw_doc()))
        self.assertEqual(editdoc.u64_problems(doc), [])
        doc["clips"][0]["outMs"] = 10000.0
        self.assertEqual(editdoc.u64_problems(doc), ["clips[0].outMs = 10000.0"])


class ProjectDocTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = video_project(self.tmp)
        self.project = Project(self.root)
        write_json(self.root / "edits" / "rec.json", raw_doc())

    def test_list_skips_sidecars_and_dot_files(self) -> None:
        write_json(self.root / "edits" / "_tap_prefs.json", {})
        write_json(self.root / "edits" / ".x.json", {})
        (self.root / "edits" / "y.json.tmp").write_text("x")
        self.assertEqual(editdoc.list_names(self.project), ["rec"])

    def test_render_state(self) -> None:
        self.assertEqual(editdoc.render_state(self.project, "rec"), "none")
        out = self.root / "assets" / "rec-edited.mp4"
        out.write_bytes(b"x")
        self.assertEqual(editdoc.render_state(self.project, "rec"), "fresh")
        old = time.time() - 60
        os.utime(out, (old, old))
        self.assertEqual(editdoc.render_state(self.project, "rec"), "stale")
        sha = editdoc.file_sha(editdoc.edit_path(self.project, "rec"))
        write_json(editdoc.record_path(self.project, "rec"), {"docHash": sha})
        self.assertEqual(editdoc.render_state(self.project, "rec"), "fresh")
        write_json(editdoc.record_path(self.project, "rec"), {"docHash": "0" * 64})
        self.assertEqual(editdoc.render_state(self.project, "rec"), "stale")

    def test_static_issues(self) -> None:
        doc = editdoc.parse(json.dumps(raw_doc(
            clips=[{"id": "c1", "sourceId": "s9", "inMs": 0, "outMs": 10, "speed": 1, "startMs": 5}, {"id": "c2", "sourceId": "s1", "inMs": 0, "outMs": 20000, "speed": 0, "startMs": 0}],
            masks=[{"id": "m1", "sourceId": "s1", "color": "red", "startMs": 5, "endMs": 5, "keys": []}],
            taps=[{"id": "t1", "sourceId": "s1", "sourceMs": 99999, "pos": [2, 0]}],
            tapSize=9,
        )))
        codes = {(i["severity"], i["code"]) for i in editdoc.static_issues(doc, "other", self.project)}
        for want in [("error", "name"), ("error", "unknown-source"), ("error", "past-source"), ("error", "bad-speed"), ("error", "bad-mask"), ("warning", "tap-hidden"), ("warning", "tap-pos"), ("warning", "tap-size")]:
            self.assertIn(want, codes)
        (self.root / "assets" / "rec.mp4").unlink()
        codes = {(i["severity"], i["code"]) for i in editdoc.static_issues(doc, "rec", self.project)}
        self.assertIn(("error", "source-missing"), codes)

    def test_mutate_without_a_cli_is_exit_2_and_dry_run_needs_none(self) -> None:
        with self.assertRaises(KbError) as cm:
            editdoc.mutate(self.project, "rec", lambda d: apply_op(d, {"op": "split", "atMs": 1000}).doc)
        self.assertEqual(cm.exception.code, 2)
        dry = editdoc.mutate(self.project, "rec", lambda d: apply_op(d, {"op": "split", "atMs": 1000}).doc, dry_run=True)
        self.assertFalse(dry.saved)
        self.assertEqual(len(dry.doc["clips"]), 2)
        self.assertEqual(len(editdoc.load(self.project, "rec")[0]["clips"]), 1)

    def test_mutate_saves_through_the_cli_with_the_read_hash(self) -> None:
        log = self.tmp / "argv.log"
        self.fake_cli(log=log)
        before = editdoc.file_sha(editdoc.edit_path(self.project, "rec"))
        m = editdoc.mutate(self.project, "rec", lambda d: apply_op(d, {"op": "split", "atMs": 1000}).doc)
        self.assertTrue(m.saved)
        self.assertFalse(m.rebased)
        self.assertEqual(m.before_sha, before)
        self.assertEqual(m.after_sha, editdoc.file_sha(editdoc.edit_path(self.project, "rec")))
        saves = [json.loads(line) for line in log.read_text().splitlines() if '"save"' in line]
        self.assertIn(before, saves[0])

    def test_racing_writer_rebases(self) -> None:
        self.fake_cli(race=self.tmp / "raced")
        calls = []

        def fn(d: Dict[str, Any]) -> Dict[str, Any]:
            calls.append(d.get("tapSize"))
            return apply_op(d, {"op": "split", "atMs": 1000}).doc

        m = editdoc.mutate(self.project, "rec", fn)
        self.assertTrue(m.rebased)
        self.assertEqual(calls, [None, 2.5])
        saved = editdoc.load(self.project, "rec")[0]
        self.assertEqual(saved["tapSize"], 2.5)
        self.assertEqual(len(saved["clips"]), 2)

    def test_pinned_base_fails_at_once(self) -> None:
        self.fake_cli(race=self.tmp / "raced")
        sha = editdoc.file_sha(editdoc.edit_path(self.project, "rec"))
        with self.assertRaises(KbError) as cm:
            editdoc.mutate(self.project, "rec", lambda d: apply_op(d, {"op": "split", "atMs": 1000}).doc, base=sha)
        self.assertIn("changed since", cm.exception.message)
        with self.assertRaises(KbError):
            editdoc.mutate(self.project, "rec", lambda d: d, base="f" * 64)

    def test_mutate_refuses_new_errors(self) -> None:
        self.fake_cli()
        with self.assertRaises(KbError) as cm:
            editdoc.mutate(self.project, "rec", lambda d: dict(d, clips=[dict(d["clips"][0], sourceId="s7")]))
        self.assertIn("nothing saved", cm.exception.message)

    def test_lock_held_by_another_process(self) -> None:
        from kblib.video import cache

        lock = cache.subdir(self.project, "locks") / "rec.lock"
        code = (
            "import fcntl, json, os, sys, time\n"
            f"fd = os.open({str(lock)!r}, os.O_RDWR | os.O_CREAT)\n"
            "fcntl.flock(fd, fcntl.LOCK_EX)\n"
            "os.write(fd, json.dumps({'pid': os.getpid(), 'op': 'kb video render', 'atMs': int(time.time() * 1000)}).encode())\n"
            "print('locked', flush=True)\n"
            "time.sleep(30)\n"
        )
        child = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "locked")
            started = time.monotonic()
            with self.assertRaises(KbError) as cm:
                with editdoc.edit_lock(self.project, "rec", "kb video split", wait=0.5):
                    pass
            self.assertLess(time.monotonic() - started, 5)
            self.assertEqual((cm.exception.code, cm.exception.kind), (3, "locked"))
            self.assertIn(f"pid {child.pid}", cm.exception.message)
            self.assertIn("kb video render", cm.exception.message)
        finally:
            child.kill()
            child.wait()
            child.stdout.close()
        with editdoc.edit_lock(self.project, "rec", "kb video split", wait=2):
            with editdoc.edit_lock(self.project, "rec", "nested", wait=0):
                pass

    def test_corrupt_doc_names_reset(self) -> None:
        (self.root / "edits" / "rec.json").write_text("{broken")
        with self.assertRaises(editdoc.DocError) as cm:
            editdoc.load(self.project, "rec")
        self.assertIn("kb video reset rec --yes", cm.exception.message)
        with self.assertRaises(editdoc.DocError) as cm:
            editdoc.load(self.project, "nope")
        self.assertEqual(cm.exception.kind, "missing")


class CacheTests(KbTestCase):
    def test_video_dir_and_prune(self) -> None:
        from kblib.video import cache

        root = video_project(self.tmp)
        project = Project(root)
        base = cache.video_dir(project)
        self.assertEqual(base, self.bridge / "video" / "demo")
        for sub in cache.SUBDIRS:
            self.assertTrue((base / sub).is_dir())
        now = time.time()
        for i in range(5):
            p = base / "drafts" / f"rec.{i}.mp4"
            p.write_bytes(b"x")
            os.utime(p, (now - i * 10, now - i * 10))
        old = base / "sheets" / "old.png"
        old.write_bytes(b"x")
        os.utime(old, (now - 2 * 86400, now - 2 * 86400))
        (base / "drafts" / "other.1.mp4").write_bytes(b"x")
        cache.prune(project)
        self.assertEqual(sorted(p.name for p in (base / "drafts").iterdir()), ["other.1.mp4", "rec.0.mp4", "rec.1.mp4", "rec.2.mp4"])
        self.assertFalse(old.exists())
        self.assertTrue(cache.draft_path(project, "rec").name.startswith("rec."))
