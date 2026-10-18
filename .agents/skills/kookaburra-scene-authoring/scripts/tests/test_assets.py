"""kb assets add (with the ingest conform), probe, conform, replace, unused, restore, meta and list, and kb check's asset rules."""

from __future__ import annotations

import hashlib
import json
import subprocess
import time
from pathlib import Path
from unittest import mock
from typing import Any, Dict, List, Optional

from kblib import hookfast
from kblib import lock as lockmod

from . import mp4synth as ms
from .fake_app_cli import MEDIA_CAPS
from .helpers import KB, FakeApp, KbTestCase, make_project, png_bytes, python_argv, read_json, write, write_json

MEDIA = json.dumps({"media": MEDIA_CAPS})


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fake_video(path: Path, duration_ms: int = 2000, why: Optional[List[str]] = None, refused: Optional[Dict[str, str]] = None, **extra: Any) -> Path:
    """A video the fake CLI can probe and conform (its bytes are its own probe), with the app's verdict beside it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {"fakeRender": True, "frames": duration_ms * 60 // 1000, "durationMs": duration_ms, "width": 320, "height": 240, "fps": 30, "tag": str(path.name)}
    body.update(extra)
    path.write_bytes(json.dumps(body).encode("utf-8"))
    if why is not None or refused is not None:
        why = why or []
        write_json(Path(str(path) + ".media.json"), {
            "ffmpeg": {"container": "mov", "vfr": "vfr" in why, "bframes": 0, "discardedPackets": 0},
            "avfoundation": {"codec": "hvc1", "durationMs": duration_ms, "editList": []},
            "verdict": "suspect" if "edit-list" in why else "ok", "reasons": list(why) + ([refused["code"]] if refused else []),
            "conform": {"recommended": bool(why) and refused is None, "why": why, "refused": refused},
        })
    return path


class AssetsCase(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.log = self.tmp / "argv.log"

    def a(self, *args: str, code: Optional[int] = 0, env: Optional[Dict[str, str]] = None) -> subprocess.CompletedProcess:
        proc = self.kb(["assets", *args], cwd=self.root, env=env)
        if code is not None:
            self.assertExit(proc, code)
        return proc

    def j(self, *args: str, code: int = 0) -> Any:
        return json.loads(self.a(*args, "--json", code=code).stdout)

    def media_cli(self, **behaviour: Any) -> None:
        self.fake_cli(caps=MEDIA, log=self.log, **behaviour)

    def calls(self, group: str) -> List[List[str]]:
        if not self.log.exists():
            return []
        return [a for a in (json.loads(x) for x in self.log.read_text().splitlines()) if a[:1] == [group]]

    def sidecar(self, stem: str, doc: Dict[str, Any]) -> None:
        write_json(self.root / "scenes" / f"{stem}.json", dict({"version": 1}, **doc))


class AddTests(AssetsCase):
    def test_without_the_app_a_video_is_copied_and_flagged_unchecked(self) -> None:
        src = fake_video(self.tmp / "rec.mov")
        res = self.j("add", str(src))
        self.assertEqual((res["path"], res["conformed"], res["checked"], res["copied"]), ("assets/rec.mov", False, False, True))
        self.assertTrue(any("not checked" in w for w in res["warnings"]), res["warnings"])
        self.assertFalse((self.root / "assets" / ".originals").exists())

    def test_without_the_app_a_misdecoding_container_says_it_needs_conforming(self) -> None:
        src = ms.write(self.tmp / "trim.mov", ms.movie(**ms.MID_SAMPLE))
        res = self.j("add", str(src))
        self.assertEqual(res["path"], "assets/trim.mov")
        self.assertEqual(res["probe"]["verdict"], "ffmpeg-misdecodes")
        self.assertTrue(any("needs conforming" in w and "./kb assets conform" in w for w in res["warnings"]), res["warnings"])

    def test_a_flagged_video_lands_as_the_app_import_lands_it(self) -> None:
        self.media_cli()
        src = fake_video(self.tmp / "Screen Recording.mov", why=["vfr"])
        proc = self.a("add", str(src), "--name", "rec.mov")
        self.assertEqual(proc.stdout.strip(), "assets/rec.mp4")
        self.assertIn("conformed (vfr)", proc.stderr)
        assets = self.root / "assets"
        self.assertEqual((assets / ".originals" / "rec.mov").read_bytes(), src.read_bytes())
        self.assertTrue((assets / "rec.timing.json").is_file())
        self.assertFalse((assets / "rec.mov").exists())
        record = read_json(assets / "_meta.json")["assets"]["assets/rec.mp4"]
        self.assertEqual(record["sha256"], sha(assets / "rec.mp4"))
        self.assertEqual({k: record["origin"][k] for k in ("kind", "from", "sourceName", "tool")},
                         {"kind": "import", "from": "assets/.originals/rec.mov", "sourceName": "Screen Recording.mov", "tool": "kb assets add"})
        self.assertEqual(record["transforms"], [{"op": "conform", "fps": 60, "colour": "bt709"}])
        conform = [c for c in self.calls("media") if c[1] == "conform"][0]
        self.assertEqual(conform[conform.index("--source") + 1], "assets/.originals/rec.mov")
        self.assertEqual(conform[conform.index("--keep-original") + 1], "move")
        listed = self.j("list")["assets"]
        self.assertEqual([a["path"] for a in listed], ["assets/logo.png", "assets/rec.mp4"])
        rec = listed[1]
        self.assertEqual((rec["timing"]["original"], rec["timing"]["holds"], rec["origin"]["tool"], rec["stale"]), ("assets/.originals/rec.mov", 1, "kb assets add", False))
        again = self.j("add", str(src), "--name", "rec.mov")
        self.assertEqual((again["path"], again["copied"]), ("assets/rec.mp4", False))
        other = fake_video(self.tmp / "other.mov", why=["vfr"])
        self.assertEqual(self.j("add", str(other), "--name", "rec.mov")["path"], "assets/rec-2.mp4")

    def test_a_clean_video_copies_as_it_always_did(self) -> None:
        self.media_cli()
        res = self.j("add", str(fake_video(self.tmp / "clean.mp4", why=[])))
        self.assertEqual((res["path"], res["conformed"], res["checked"]), ("assets/clean.mp4", False, True))
        self.assertEqual([c[1] for c in self.calls("media")], ["probe"])

    def test_no_conform_and_dry_run(self) -> None:
        self.media_cli()
        src = fake_video(self.tmp / "rec.mov", why=["vfr"])
        plain = self.j("add", str(src), "--no-conform")
        self.assertEqual((plain["path"], plain["conformed"]), ("assets/rec.mov", False))
        self.assertEqual(self.calls("media"), [])
        dry = self.j("add", str(src), "--name", "take.mov", "--dry-run")
        self.assertEqual([w["path"] for w in dry["writes"]], ["assets/.originals/take.mov", "assets/take.mp4", "assets/take.timing.json", "assets/_meta.json"])
        self.assertFalse((self.root / "assets" / "take.mp4").exists())
        self.assertFalse((self.root / "assets" / ".originals").exists())

    def test_a_failed_conform_hands_the_file_back(self) -> None:
        self.media_cli(fail="media-conform")
        src = fake_video(self.tmp / "rec.mov", why=["vfr"])
        res = self.j("add", str(src))
        self.assertEqual((res["path"], res["conformed"]), ("assets/rec.mov", False))
        self.assertEqual((self.root / "assets" / "rec.mov").read_bytes(), src.read_bytes())
        self.assertEqual(list((self.root / "assets" / ".originals").iterdir()), [])
        self.assertTrue(any("conform failed" in w for w in res["warnings"]), res["warnings"])

    def test_a_refused_video_is_copied_with_the_reason(self) -> None:
        self.media_cli()
        src = fake_video(self.tmp / "hdr.mov", why=["vfr"], refused={"code": "hdr", "hint": "HDR video (PQ or HLG) can't be conformed: export an SDR version first"})
        res = self.j("add", str(src))
        self.assertEqual((res["path"], res["conformed"]), ("assets/hdr.mov", False))
        self.assertTrue(any("export an SDR version" in w for w in res["warnings"]))


class ProbeTests(AssetsCase):
    def test_the_container_verdict_needs_no_app(self) -> None:
        ms.write(self.root / "assets" / "trim.mov", ms.movie(**ms.MID_SAMPLE))
        proc = self.a("probe", "assets/trim.mov", "--json")
        info = json.loads(proc.stdout)
        decode = info["decode"]
        self.assertEqual(decode["verdict"], "ffmpeg-misdecodes")
        self.assertIn("edit-mid-sample", decode["reasons"])
        self.assertEqual(decode["editList"], [{"mediaTimeMs": 750.0, "durationMs": 1500.0, "rate": 1.0}])
        self.assertEqual(decode["container"]["expected"]["frames"], 31)
        self.assertEqual(decode["conform"]["command"], "./kb assets conform assets/trim.mov")
        self.assertIsNone(decode["avfoundation"])
        self.assertIn("container", decode["checks"])
        self.assertIn("ffmpeg misdecodes assets/trim.mov", proc.stderr)
        text = self.a("probe", "trim.mov").stdout
        self.assertIn("verdict: ffmpeg-misdecodes", text)
        self.assertIn("conform: recommended", text)

    def test_the_app_adds_avfoundation(self) -> None:
        self.media_cli()
        fake_video(self.root / "assets" / "rec.mov", why=["vfr", "edit-list"])
        decode = self.j("probe", "assets/rec.mov")["decode"]
        self.assertEqual((decode["verdict"], decode["avfoundation"]["codec"]), ("suspect", "hvc1"))
        self.assertIn("app", decode["checks"])
        self.assertEqual(decode["conform"]["why"], ["vfr", "edit-list"])
        deep = self.j("probe", "assets/rec.mov", "--deep")["decode"]
        self.assertIn("--pts", [c for c in self.calls("media") if c[1] == "probe"][-1])
        self.assertIn("decode", deep["checks"])

    def test_a_mezzanine_needs_nothing(self) -> None:
        self.media_cli()
        fake_video(self.root / "assets" / "rec.mov", why=["vfr"])
        self.a("conform", "assets/rec.mov")
        info = self.j("probe", "assets/rec.mov")
        self.assertEqual((info["decode"]["conform"]["recommended"], info["decode"]["conform"]["command"]), (False, None))
        self.assertEqual(info["timing"]["original"], "assets/.originals/rec.mov")


class ConformTests(AssetsCase):
    def setUp(self) -> None:
        super().setUp()
        self.media_cli()
        fake_video(self.root / "assets" / "rec.mov", why=["vfr"])
        self.sidecar("02-hero", {"name": "Hero", "devices": [{"id": "phone", "model": "android", "media": {"src": "assets/rec.mov", "kind": "video"}}]})
        tsx = self.root / "scenes" / "03-outro.tsx"
        tsx.write_text(tsx.read_text(encoding="utf-8") + 'export const clip = "./assets/rec.mov";\n', encoding="utf-8")

    def test_in_place_keeps_the_name_and_container(self) -> None:
        res = self.j("conform", "assets/rec.mov")
        self.assertEqual((res["path"], res["inPlace"], res["original"], res["timing"]), ("assets/rec.mov", True, "assets/.originals/rec.mov", "assets/rec.timing.json"))
        self.assertEqual(read_json(self.root / "scenes" / "02-hero.json")["devices"][0]["media"]["src"], "assets/rec.mov")
        record = read_json(self.root / "assets" / "_meta.json")["assets"]["assets/rec.mov"]
        self.assertEqual((record["origin"]["kind"], record["origin"]["tool"], record["origin"]["from"]), ("derived", "kb assets conform", "assets/.originals/rec.mov"))
        again = self.a("conform", "assets/rec.mov", code=1)
        self.assertIn("already conformed", again.stderr)

    def test_repoint_moves_a_mov_to_mp4_and_rewrites_the_literals(self) -> None:
        dry = self.j("conform", "assets/rec.mov", "--repoint", "--dry-run")
        actions = {(w["path"], w["action"]) for w in dry["writes"]}
        self.assertIn(("scenes/02-hero.json", "modify"), actions)
        self.assertIn(("scenes/03-outro.tsx", "modify"), actions)
        self.assertIn(("assets/rec.mov", "trash"), actions)
        self.assertTrue((self.root / "assets" / "rec.mov").is_file())
        res = self.j("conform", "assets/rec.mov", "--repoint")
        self.assertEqual((res["path"], res["inPlace"]), ("assets/rec.mp4", False))
        self.assertEqual(sorted(r["file"] for r in res["rewrites"]), ["scenes/02-hero.json", "scenes/03-outro.tsx"])
        self.assertEqual(read_json(self.root / "scenes" / "02-hero.json")["devices"][0]["media"]["src"], "assets/rec.mp4")
        self.assertIn('"./assets/rec.mp4"', (self.root / "scenes" / "03-outro.tsx").read_text(encoding="utf-8"))
        self.assertFalse((self.root / "assets" / "rec.mov").exists())
        self.assertTrue((self.trash / "rec.mov").is_file())
        self.assertTrue((self.root / "assets" / ".originals" / "rec.mov").is_file())
        self.assertEqual(self.kb(["check"], cwd=self.root).returncode, 0)

    def test_repoint_keeps_a_file_a_template_literal_still_names(self) -> None:
        tsx = self.root / "scenes" / "01-intro.tsx"
        tsx.write_text(tsx.read_text(encoding="utf-8") + "export const pick = (e: string) => `assets/rec.${e}`;\n", encoding="utf-8")
        res = self.j("conform", "assets/rec.mov", "--repoint")
        self.assertEqual(res["patterns"], [{"file": "scenes/01-intro.tsx", "pattern": "assets/rec.*"}])
        self.assertEqual(res["kept"], "assets/rec.mov")
        self.assertTrue((self.root / "assets" / "rec.mov").is_file())

    def test_refusals(self) -> None:
        (self.root / "assets" / "still.png").write_bytes(png_bytes())
        self.assertIn("not an MP4", self.a("conform", "assets/still.png", code=1).stderr)
        write_json(self.root / "edits" / "rec.json", {"version": 1})
        fake_video(self.root / "assets" / "rec-edited.mp4")
        self.assertIn("./kb video render rec", self.a("conform", "assets/rec-edited.mp4", code=1).stderr)
        self.a("conform", "assets/missing.mov", code=1)
        self.no_app_bin()
        failed = json.loads(self.a("conform", "assets/rec.mov", "--json", code=2).stdout)
        self.assertEqual(failed["code"], "env")


class ReplaceTests(AssetsCase):
    def setUp(self) -> None:
        super().setUp()
        self.sidecar("02-hero", {"name": "Hero", "headerIcon": "assets/logo.png"})
        self.old = (self.root / "assets" / "logo.png").read_bytes()
        self.new = self.tmp / "new-logo.png"
        self.new.write_bytes(png_bytes(4, 5))

    def test_in_place_archives_the_old_version(self) -> None:
        res = self.j("replace", "assets/logo.png", str(self.new))
        self.assertEqual((self.root / "assets" / "logo.png").read_bytes(), self.new.read_bytes())
        to = res["old"]["to"]
        self.assertTrue(to.startswith(".kb/archive/") and to.endswith("/assets/logo.png"), to)
        self.assertEqual((self.root / to).read_bytes(), self.old)
        self.assertEqual((res["probe"]["width"], res["probe"]["wasWidth"]), (4, 2))
        self.assertTrue(any("4x5" in w for w in res["warnings"]))
        index = [json.loads(x) for x in (self.root / ".kb" / "archive" / "index.jsonl").read_text().splitlines()]
        self.assertEqual([(e["op"], e["from"], e["to"], e["sha256"]) for e in index], [("replace", "assets/logo.png", to, hashlib.sha256(self.old).hexdigest())])
        self.assertEqual(read_json(self.root / "scenes" / "02-hero.json")["headerIcon"], "assets/logo.png")
        restored = self.j("restore")
        self.assertEqual(restored["restored"], [{"path": "assets/logo.png", "from": to}])
        self.assertEqual((self.root / "assets" / "logo.png").read_bytes(), self.old)
        self.assertTrue(restored["displacedId"])
        self.j("restore", restored["displacedId"])
        self.assertEqual((self.root / "assets" / "logo.png").read_bytes(), self.new.read_bytes())

    def test_keep_old_trash_and_none(self) -> None:
        res = self.j("replace", "logo.png", str(self.new), "--keep-old", "trash")
        self.assertEqual(Path(res["old"]["to"]).read_bytes(), self.old)
        self.assertFalse(any((self.root / ".kb" / "archive").glob("*/assets")))
        self.assertFalse((self.root / ".kb" / "archive" / "index.jsonl").exists())
        newer = self.tmp / "newer.png"
        newer.write_bytes(png_bytes(6, 6))
        res = self.j("replace", "logo.png", str(newer), "--keep-old", "none")
        self.assertIsNone(res["old"]["to"])
        self.assertEqual((self.root / "assets" / "logo.png").read_bytes(), newer.read_bytes())

    def test_refusals_and_no_ops(self) -> None:
        jpg = self.tmp / "logo.jpg"
        jpg.write_bytes(b"\xff\xd8\xff")
        self.assertIn("keeps the type", self.a("replace", "assets/logo.png", str(jpg), code=1).stderr)
        write_json(self.root / "edits" / "rec.json", {"version": 1})
        fake_video(self.root / "assets" / "rec-edited.mp4")
        clip = fake_video(self.tmp / "other.mp4")
        self.assertIn("./kb video render rec", self.a("replace", "assets/rec-edited.mp4", str(clip), code=1).stderr)
        write_json(self.root / "assets" / "_meta.json", {"version": 1, "assets": {}})
        self.a("replace", "assets/_meta.json", str(self.tmp / "new-logo.png"), code=2)
        self.a("replace", "assets/nope.png", str(self.new), code=1)
        self.a("replace", "assets/logo.png", str(self.new), "--as-new", "--keep-old", "none", code=2)
        same = self.j("replace", "assets/logo.png", str(self.root / "assets" / "logo.png"))
        self.assertTrue(same["unchanged"])
        dry = self.j("replace", "assets/logo.png", str(self.new), "--dry-run")
        self.assertEqual(sorted((w["action"], w["path"].split("/")[-1]) for w in dry["writes"]), [("create", "index.jsonl"), ("create", "logo.png"), ("modify", "logo.png")])
        self.assertEqual((self.root / "assets" / "logo.png").read_bytes(), self.old)
        self.assertFalse((self.root / ".kb" / "archive").exists())
        plan = json.loads(self.kb(["plan", "assets", "replace", "assets/logo.png", str(self.new), "--json"], cwd=self.root).stdout)
        self.assertEqual((plan["plan"], len(plan["writes"]), plan["refusals"]), ("assets replace", 3, []))

    def test_new_writes_take_dry_run_and_wait(self) -> None:
        from kblib.cli import build_parser

        from .test_envelope import leaves, options

        found = dict(leaves(build_parser()))
        for name in ("assets conform", "assets replace", "assets unused", "assets restore", "assets meta", "assets add"):
            self.assertIn("--dry-run", options(found[name]), name)
            self.assertIn("--wait", options(found[name]), name)
        self.assertNotIn("--dry-run", options(found["assets probe"]))

    def test_as_new_keeps_both_and_repoints(self) -> None:
        res = self.j("replace", "assets/logo.png", str(self.new), "--as-new")
        self.assertEqual((res["path"], res["replaced"]), ("assets/logo-2.png", "assets/logo.png"))
        self.assertEqual(read_json(self.root / "scenes" / "02-hero.json")["headerIcon"], "assets/logo-2.png")
        self.assertEqual((self.root / "assets" / "logo.png").read_bytes(), self.old)

    def test_a_record_follows_the_new_bytes(self) -> None:
        self.a("meta", "assets/logo.png", "--set", "licence.id=CC0-1.0")
        self.j("replace", "assets/logo.png", str(self.new))
        record = read_json(self.root / "assets" / "_meta.json")["assets"]["assets/logo.png"]
        self.assertEqual((record["sha256"], record["licence"]["id"], record["origin"]["tool"]), (sha(self.new), "CC0-1.0", "kb assets replace"))
        index = [json.loads(x) for x in (self.root / ".kb" / "archive" / "index.jsonl").read_text().splitlines()]
        self.assertEqual(index[0]["meta"]["licence"]["id"], "CC0-1.0")

    def test_a_running_export_refuses_unless_waited_for(self) -> None:
        with FakeApp(self.bridge, lambda r: {"ok": True}, openProject="ws:demo", exporting=True) as app:
            refused = json.loads(self.a("replace", "assets/logo.png", str(self.new), "--json", code=3).stdout)
            self.assertEqual(refused["code"], "app-busy")
            started = time.monotonic()
            run = subprocess.Popen(python_argv(KB) + ["assets", "replace", "assets/logo.png", str(self.new), "--wait", "30"],
                                   cwd=str(self.root), env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            time.sleep(1.0)
            app.heartbeat["exporting"] = False
            app.write_heartbeat()
            out, err = run.communicate(timeout=60)
        self.assertEqual(run.returncode, 0, err)
        self.assertGreater(time.monotonic() - started, 0.9)
        self.assertEqual(out.strip(), "assets/logo.png")

    def test_follow_media_scenes_take_the_new_length(self) -> None:
        self.fake_cli(log=self.log)
        fake_video(self.root / "assets" / "rec.mp4", duration_ms=2000)
        self.sidecar("02-hero", {"name": "Hero", "duration": {"mode": "follow-media"},
                                 "devices": [{"id": "phone", "model": "android", "media": {"src": "assets/rec.mp4", "kind": "video"}}]})
        longer = fake_video(self.tmp / "rec.mp4", duration_ms=5000)
        res = self.j("replace", "assets/rec.mp4", str(longer))
        self.assertEqual([(d["scene"], d["toMs"]) for d in res["durations"]], [("02-hero", 5000)])
        self.assertEqual(read_json(self.root / "project.json")["scenes"][1]["durationMs"], 5000)
        self.assertIn(res["probe"]["durationMs"], (None, 5000), "ffprobe can't read the fake bytes; the app's probe can")


class UnusedTests(AssetsCase):
    def setUp(self) -> None:
        super().setUp()
        assets = self.root / "assets"
        self.sidecar("02-hero", {"name": "Hero", "headerIcon": "assets/logo.png", "devices": [{"id": "p", "model": "android", "media": {"src": "assets/rec.mp4", "kind": "video"}}]})
        tsx = self.root / "scenes" / "03-outro.tsx"
        tsx.write_text(tsx.read_text(encoding="utf-8") + "export const glyph = (n: string) => `assets/glyph-${n}.png`;\n", encoding="utf-8")
        for name in ("orphan.png", "glyph-a.png", "app-icon.png"):
            (assets / name).write_bytes(png_bytes())
        fake_video(assets / "rec.mp4")
        write_json(assets / "rec.timing.json", {"version": 1, "mezzanine": {"path": "assets/rec.mp4"}})
        fake_video(assets / "old.mp4")
        write_json(assets / "_meta.json", {"version": 1, "assets": {"assets/orphan.png": {"sha256": sha(assets / "orphan.png"), "licence": {"id": "CC0-1.0"}, "transforms": []}}})
        samples = self.res / "projects" / "_samples"
        samples.mkdir(parents=True, exist_ok=True)
        (samples / "app-icon.png").write_bytes(png_bytes())

    def test_items_and_why_the_rest_is_kept(self) -> None:
        res = self.j("unused")
        self.assertEqual([i["path"] for i in res["items"]], ["assets/old.mp4", "assets/orphan.png"])
        self.assertEqual(res["totalBytes"], sum(i["bytes"] for i in res["items"]))
        kept = {k["path"]: k for k in res["kept"]}
        self.assertEqual(kept["assets/glyph-a.png"]["reason"], "pattern")
        self.assertEqual(kept["assets/glyph-a.png"]["pattern"], "assets/glyph-*.png")
        self.assertEqual(kept["assets/app-icon.png"]["reason"], "sample")
        self.assertEqual((kept["assets/rec.timing.json"]["reason"], kept["assets/rec.timing.json"]["file"]), ("companion", "assets/rec.mp4"))
        self.assertEqual(kept["assets/_meta.json"]["reason"], "companion")
        self.assertEqual([i["path"] for i in self.j("unused", "--kind", "video")["items"]], ["assets/old.mp4"])

    def test_archive_then_restore_with_provenance(self) -> None:
        dry = self.j("unused", "--archive", "--dry-run")
        self.assertEqual(dry["archived"]["count"], 2)
        self.assertTrue((self.root / "assets" / "orphan.png").is_file())
        res = self.j("unused", "--archive")
        ident = res["archived"]["id"]
        self.assertFalse((self.root / "assets" / "orphan.png").exists())
        self.assertTrue((self.root / ".kb" / "archive" / ident / "assets" / "orphan.png").is_file())
        self.assertNotIn("assets/orphan.png", read_json(self.root / "assets" / "_meta.json")["assets"])
        self.assertEqual(self.j("unused")["items"], [])
        listed = self.j("restore", "--list")["batches"]
        self.assertEqual([(b["id"], b["op"], b["restored"]) for b in listed], [(ident, "unused", False)])
        back = self.j("restore")
        self.assertEqual(sorted(r["path"] for r in back["restored"]), ["assets/old.mp4", "assets/orphan.png"])
        self.assertTrue((self.root / "assets" / "orphan.png").is_file())
        self.assertEqual(read_json(self.root / "assets" / "_meta.json")["assets"]["assets/orphan.png"]["licence"]["id"], "CC0-1.0")
        self.assertEqual(json.loads(self.a("restore", "--json", code=1).stdout)["code"], "invalid")
        self.a("restore", "nope", code=1)

    def test_a_custom_archive_folder(self) -> None:
        out = self.tmp / "aside"
        res = self.j("unused", "--archive", str(out), "--kind", "image")
        moved = res["archived"]["items"]
        self.assertEqual([m["from"] for m in moved], ["assets/orphan.png"])
        self.assertTrue(Path(moved[0]["to"]).is_file())
        self.assertTrue(str(moved[0]["to"]).startswith(str(out)))
        self.a("unused", "--archive", str(self.root / "assets" / "x"), code=2)
        self.j("restore")
        self.assertTrue((self.root / "assets" / "orphan.png").is_file())

    def test_a_pattern_covering_everything_says_so(self) -> None:
        tsx = self.root / "scenes" / "01-intro.tsx"
        tsx.write_text(tsx.read_text(encoding="utf-8") + 'const base = "assets/";\n', encoding="utf-8")
        res = self.j("unused")
        self.assertEqual(res["items"], [])
        self.assertTrue(any("covers every file" in n for n in res["notes"]))


class MetaAndListTests(AssetsCase):
    def test_read_set_and_stale(self) -> None:
        empty = self.j("meta", "assets/logo.png")
        self.assertIsNone(empty["record"])
        dry = self.j("meta", "assets/logo.png", "--set", "licence.id=CC-BY-4.0", "--dry-run")
        self.assertEqual(dry["writes"][0]["path"], "assets/_meta.json")
        self.assertFalse((self.root / "assets" / "_meta.json").exists())
        res = self.j("meta", "assets/logo.png", "--set", "licence.id=CC-BY-4.0", "--set", 'licence.holder="Studio"', "--set", "licence.year=2026")
        self.assertEqual(res["record"]["licence"], {"id": "CC-BY-4.0", "holder": "Studio", "year": 2026})
        self.assertEqual((res["record"]["sha256"], res["stale"]), (res["sha256"], False))
        (self.root / "assets" / "logo.png").write_bytes(png_bytes(9, 9))
        self.assertTrue(self.j("meta", "logo.png")["stale"])
        self.assertTrue(self.j("list")["assets"][0]["stale"])
        removed = self.j("meta", "assets/logo.png", "--set", "licence.year=null")
        self.assertNotIn("year", removed["record"]["licence"])
        self.a("meta", "assets/logo.png", "--set", "sha256=abc", code=2)
        self.a("meta", "assets/logo.png", "--set", "noequals", code=2)
        bad = json.loads(self.a("meta", "assets/logo.png", "--set", "origin.from=/Users/x/rec.mov", "--json", code=1).stdout)
        self.assertEqual(bad["code"], "invalid")
        write_json(self.root / "assets" / "_meta.json", {"version": 2, "assets": {}})
        self.a("meta", "assets/logo.png", "--set", "licence.id=x", code=1)

    def test_list_hides_records_and_dot_files(self) -> None:
        assets = self.root / "assets"
        write_json(assets / "_meta.json", {"version": 1, "assets": {}})
        write_json(assets / "x.timing.json", {"version": 1})
        (assets / ".hidden.png").write_bytes(png_bytes())
        (assets / ".originals").mkdir()
        (assets / ".originals" / "a.mov").write_bytes(b"x")
        self.assertEqual([a["path"] for a in self.j("list")["assets"]], ["assets/logo.png"])


class TxnFileOpTests(KbTestCase):
    """kblib.lock's copy_over and move: compare-and-swap like every other write, and taken back when a later write loses."""

    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.src = self.tmp / "new.bin"
        self.src.write_bytes(b"new bytes")
        write(self.root / "assets" / "a.bin", "old")

    def test_streaming_hash(self) -> None:
        self.assertEqual(lockmod.file_sha256(self.root / "assets" / "a.bin"), hashlib.sha256(b"old").hexdigest())
        self.assertEqual(lockmod.file_sha256(self.root / "assets" / "missing"), lockmod.ABSENT)
        self.assertEqual(lockmod.current_hash(self.root / "assets"), lockmod.ABSENT)

    def test_copy_over_and_move_land_together(self) -> None:
        def fn(tx: lockmod.Txn) -> None:
            tx.move("assets/a.bin", ".kb/archive/x/assets/a.bin")
            tx.copy_over("assets/a.bin", self.src)

        _r, tx = lockmod.transact(self.root, "test", fn)
        self.assertEqual((self.root / "assets" / "a.bin").read_bytes(), b"new bytes")
        self.assertEqual((self.root / ".kb" / "archive" / "x" / "assets" / "a.bin").read_bytes(), b"old")
        self.assertEqual([w["action"] for w in tx.writes], ["create", "modify"])

    def test_a_stale_base_conflicts_and_takes_back_the_archive_copy(self) -> None:
        with self.assertRaises(lockmod.Conflict):
            with lockmod.project_txn(self.root, "test") as tx:
                tx.move("assets/a.bin", ".kb/archive/y/a.bin")
                tx.copy_over("assets/a.bin", self.src, base="0" * 64)
        self.assertEqual((self.root / "assets" / "a.bin").read_bytes(), b"old")
        self.assertFalse((self.root / ".kb" / "archive" / "y" / "a.bin").exists())

    def test_a_move_drops_its_source_and_refuses_a_taken_name(self) -> None:
        write(self.root / "assets" / "b.bin", "b")
        with lockmod.project_txn(self.root, "test") as tx:
            tx.move("assets/b.bin", "assets/c.bin")
            self.assertEqual([w["action"] for w in tx.writes], ["create", "delete"])
        self.assertFalse((self.root / "assets" / "b.bin").exists())
        self.assertEqual((self.root / "assets" / "c.bin").read_text(), "b")
        with self.assertRaises(lockmod.Conflict):
            with lockmod.project_txn(self.root, "test") as tx:
                tx.move("assets/a.bin", "assets/c.bin")
        self.assertTrue((self.root / "assets" / "a.bin").is_file())

    def test_a_move_over_is_put_back_when_a_later_write_loses(self) -> None:
        write(self.root / "assets" / "kept.bin", "kept")
        with mock.patch.object(lockmod, "write_if_unchanged", lambda *_a: False), self.assertRaises(lockmod.Conflict):
            with lockmod.project_txn(self.root, "test") as tx:
                current = tx.hash("assets/a.bin")
                tx.move("assets/a.bin", ".kb/archive/z/a.bin", base=current)
                tx.move("assets/kept.bin", "assets/a.bin", dest_base=current)
                tx.write_text("project.json", "{}")
        self.assertEqual((self.root / "assets" / "a.bin").read_text(), "old")
        self.assertEqual((self.root / "assets" / "kept.bin").read_text(), "kept")
        self.assertFalse((self.root / ".kb" / "archive" / "z" / "a.bin").exists())


class HookTests(KbTestCase):
    def test_asset_writes_that_touch_scenes_take_the_session_checkpoint(self) -> None:
        self.assertTrue(hookfast.writes_project("./kb assets conform assets/rec.mov --repoint"))
        self.assertTrue(hookfast.writes_project("./kb assets replace assets/a.png ~/b.png"))
        self.assertTrue(hookfast.writes_project("./kb assets add ~/rec.mov"))
        self.assertFalse(hookfast.writes_project("./kb assets conform assets/rec.mov --dry-run"))
        self.assertFalse(hookfast.writes_project("./kb assets unused"))
        self.assertFalse(hookfast.writes_project("./kb assets probe assets/rec.mov"))
