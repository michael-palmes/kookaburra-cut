from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List

from kblib import verify

from .helpers import FakeApp, KbTestCase, make_project, png_bytes

FEATURES = ["scale", "width", "probe", "client", "deadline", "recycle", "debug", "range", "texts"]
KINDS = ["capture", "check", "fonts", "insertPreset", "mediaChanged", "openEdit", "debug", "range"]
SAFE = {"x": 0.05, "y": 0.0889, "w": 0.9, "h": 0.8222}


def flash_report(issues: List[Dict[str, Any]], frames: int) -> Dict[str, Any]:
    return {"version": 1, "approximate": True, "standards": ["wcag-2.3.1", "itu-bt1702"], "source": "range", "fps": 30, "frames": frames,
            "grid": [64, 36], "ok": not any(i["severity"] == "fail" for i in issues), "issues": issues}


def health() -> Dict[str, Any]:
    return {"version": 1, "captureFeatures": FEATURES, "queue": {"depth": 0, "order": [], "etaMs": [], "inFlight": None}, "gpu": {"stalled": False, "wedged": False},
            "renderWindow": {"alive": True}, "webgl": {}, "clients": []}


def cuts(stems: List[str], ms: int) -> List[Dict[str, Any]]:
    return [{"file": f"scenes/{s}.tsx", "durationMs": ms} for s in stems]


class VerifyTests(KbTestCase):
    def app(self, project: Path, check: Dict[str, Any], white: Any = None, stall: bool = False, issues: Any = None,
            texts: Any = None, kinds: Any = None) -> FakeApp:
        """check answers `check`; captures write PNGs and probe white for scenes `white(stem, label)` picks, else black, with the
        text boxes `texts(stem, at)` gives; a ranged check reports `issues(req)`."""
        shots = self.tmp / "shots"
        shots.mkdir(exist_ok=True)

        def handler(req: Dict[str, Any]) -> Dict[str, Any]:
            if req["kind"] == "check":
                return dict({"project": req.get("project"), "scenes": [], "fonts": [], "assets": [], "warnings": [], "rendered": req.get("render")}, **check)
            if stall:
                return {"ok": False, "gpuStalled": True, "reason": "blankReadback", "recycled": True, "retryAfterMs": 0, "wedged": False, "error": "GPU stalled"}
            if req["kind"] == "range":
                frames = int((req["endMs"] - req["startMs"]) * req["fps"] / 1000)
                return {"ok": True, "project": req.get("project"), "format": req.get("aspect") or "16:9", "size": {"width": 640, "height": 360},
                        "fps": req["fps"], "startMs": req["startMs"], "endMs": req["endMs"], "firstFrame": 0, "frames": frames,
                        "flashes": flash_report(issues(req) if issues else [], frames), "strips": [], "timing": {"renderMs": 1200}}
            frames = []
            for n, f in enumerate(req["frames"]):
                path = shots / f"{req['id']}-{n}.png"
                path.write_bytes(png_bytes())
                lit = bool(white and white(f["scene"], f["at"]))
                value = 255 if lit else 0
                probes = [{"x": x, "y": y, "rgba": [value, value, value, 255], "hex": "#ffffff" if lit else "#000000"} for x, y in req.get("probe") or []]
                frame = {"scene": f["scene"], "at": f["at"], "tMs": 0, "path": str(path), "index": n, "probes": probes}
                if req.get("texts"):
                    frame["texts"] = texts(f["scene"], f["at"]) if texts else []
                frames.append(frame)
            sheet = shots / f"{req['id']}-sheet.png"
            sheet.write_bytes(png_bytes())
            out = {"ok": True, "project": req.get("project"), "format": req.get("aspect"), "frames": frames, "path": frames[0]["path"],
                   "paths": [f["path"] for f in frames], "sheetPath": str(sheet), "size": {"width": req.get("width"), "height": 720}}
            if req.get("texts"):
                out["safe"] = SAFE
            return out

        return FakeApp(self.bridge, handler, kinds=kinds or KINDS, health=health(), openProject="ws:demo")

    def verify(self, project: Path, *args: str, code: int = 0) -> Dict[str, Any]:
        proc = self.kb(["verify", "--json"] + list(args), cwd=project)
        self.assertExit(proc, code)
        return json.loads(proc.stdout)

    def steps(self, out: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        return {s["name"]: s for s in out["steps"]}

    def test_without_an_app_nothing_is_checked_and_exit_2_says_so(self) -> None:
        root = make_project(self.tmp)
        out = self.verify(root, code=2)
        steps = self.steps(out)
        self.assertEqual(list(steps), ["static", "app", "captures", "safe-areas", "handoffs", "flashes"])
        self.assertTrue(steps["static"]["ok"] and "skipped" not in steps["static"])
        self.assertTrue(steps["app"]["notRun"] and steps["flashes"]["notRun"])
        self.assertEqual(steps["app"]["code"], "no-app")
        self.assertIn("not running", steps["app"]["errors"][0])
        for name in ("captures", "safe-areas", "handoffs"):
            self.assertIn("skipped", steps[name], name)
        self.assertFalse(out["ok"])
        for s in out["steps"]:
            self.assertEqual(set(s) >= {"name", "ok", "ms", "errors", "warnings"}, True)
        text = self.kb(["verify"], cwd=root)
        self.assertExit(text, 2)
        self.assertIn("NOT CHECKED", text.stdout.splitlines()[-1])

    def test_the_last_verdict_is_saved_and_read_back_with_its_exit_code(self) -> None:
        root = make_project(self.tmp)
        self.verify(root, code=2)
        last = self.kb(["verify", "--last"], cwd=root)
        self.assertExit(last, 2)
        self.assertIn("NOT CHECKED", last.stdout)
        saved = json.loads((root / ".kb" / "verify" / "last.json").read_text(encoding="utf-8"))
        self.assertEqual((saved["exit"], saved["tier"], saved["ok"]), (2, "standard", False))
        with self.app(root, {"ok": True}):
            self.verify(root, "--quick")
        self.assertExit(self.kb(["verify", "--last"], cwd=root), 0)
        status = self.kb(["status"], cwd=root)
        self.assertIn("Last verify: ok (quick, flashes not checked)", status.stdout)
        (root / "scenes" / "02-hero.json").write_text('{"version": 1, "text": {"title": "Changed"}}\n', encoding="utf-8")
        future = time.time() + 5
        os.utime(root / "scenes" / "02-hero.json", (future, future))
        self.assertIn("stale: scenes/02-hero.json changed since", self.kb(["verify", "--last"], cwd=root).stdout)

    def test_quick_runs_no_flash_check_and_says_so(self) -> None:
        root = make_project(self.tmp)
        with self.app(root, {"ok": True}) as app:
            out = self.verify(root, "--quick")
        self.assertNotIn("flashes", self.steps(out))
        self.assertEqual(out["tier"], "quick")
        self.assertFalse([r for r in app.requests if r["kind"] == "range"])
        self.assertIn("flashes NOT checked", out["summary"])

    def test_static_errors_fail_with_exit_1(self) -> None:
        root = make_project(self.tmp)
        (root / "scenes" / "02-hero.tsx").write_text("export default 1\n", encoding="utf-8")
        out = self.verify(root, code=1)
        self.assertFalse(out["ok"])
        self.assertFalse(self.steps(out)["static"]["ok"])
        self.assertTrue(out["error"].startswith("static: "))

    def test_every_step_runs_against_the_app_in_chunks_of_16_frames(self) -> None:
        stems = [f"{i:02d}-s{i}" for i in range(1, 11)]
        root = make_project(self.tmp, scenes=stems)
        with self.app(root, {"ok": True}) as app:
            out = self.verify(root, "--aspect", "16:9")
        steps = self.steps(out)
        self.assertTrue(all(s["ok"] for s in out["steps"]), out["steps"])
        self.assertTrue(steps["app"]["rendered"])
        captures = [r for r in app.requests if r["kind"] == "capture"]
        self.assertEqual([len(r["frames"]) for r in captures], [16, 4])
        self.assertTrue(all(r["sheet"] and r["width"] == 1280 and r["aspect"] == "16:9" and len(r["probe"]) == 64 for r in captures))
        first = captures[0]["frames"][:2]
        self.assertEqual(first[0], {"scene": "01-s1", "at": 0.0})
        self.assertEqual(first[1]["scene"], "01-s1")
        self.assertAlmostEqual(first[1]["at"], (3000 - 600 - 1000 / 60) / 1000, places=2)
        self.assertEqual(captures[0]["frames"][2]["at"], 0.6)
        self.assertEqual(len(steps["captures"]["paths"]), 2)
        for p in steps["captures"]["paths"]:
            self.assertTrue(os.path.isabs(p) and Path(p).is_file(), p)
            self.assertIn(str(root / ".kb" / "captures"), p)
        self.assertEqual(sorted(Path(p).name for p in steps["captures"]["paths"]), ["sheet-1.png", "sheet-2.png"])
        self.assertEqual(len(steps["captures"]["frames"]), 20)
        self.assertEqual(len(steps["handoffs"]["seams"]), 9)
        self.assertEqual(steps["handoffs"]["warnings"], [])
        check = [r for r in app.requests if r["kind"] == "check"]
        self.assertEqual(len(check), 1)
        self.assertTrue(check[0]["render"])
        (ranged,) = [r for r in app.requests if r["kind"] == "range"]
        self.assertEqual((ranged["startMs"], ranged["endMs"], ranged["fps"], ranged["flashes"]), (0, 30000 - 9 * 600, 30, True))
        self.assertTrue(steps["flashes"]["ranged"])
        with self.app(root, {"ok": True}) as again:
            reused = self.steps(self.verify(root, "--aspect", "16:9"))["flashes"]
        self.assertFalse([r for r in again.requests if r["kind"] == "range"], "an unchanged project reuses its ranged check")
        self.assertIn("reused", reused)

    def test_no_render_and_scene_scope(self) -> None:
        root = make_project(self.tmp)
        with self.app(root, {"ok": True}) as app:
            out = self.verify(root, "--no-render", "--scene", "02-hero", "--scene", "03-outro")
        self.assertEqual(out["scenes"], ["02-hero", "03-outro"])
        (check,) = [r for r in app.requests if r["kind"] == "check"]
        self.assertFalse(check["render"])
        (cap,) = [r for r in app.requests if r["kind"] == "capture"]
        self.assertEqual([f["scene"] for f in cap["frames"]], ["02-hero", "02-hero", "03-outro", "03-outro"])
        self.assertEqual(len(self.steps(out)["handoffs"]["seams"]), 1)
        (ranged,) = [r for r in app.requests if r["kind"] == "range"]
        self.assertEqual(ranged["startMs"], 2400 - 1000, "a scene's check reaches a second before it")
        self.assertEqual(self.steps(out)["flashes"]["spans"][0]["label"], "02-hero+03-outro")

    def test_formats_capture_every_aspect_and_text_past_the_safe_area_warns(self) -> None:
        root = make_project(self.tmp)
        manifest = json.loads((root / "project.json").read_text(encoding="utf-8"))
        manifest["formats"] = ["16:9", "9:16"]
        (root / "project.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        def texts(stem: str, at: float) -> List[Dict[str, Any]]:
            if stem != "02-hero":
                return [{"text": "Fine", "x": 0.3, "y": 0.4, "w": 0.2, "h": 0.05, "scene": 1}]
            return [{"text": "Hello", "x": 0.02, "y": 0.4, "w": 0.3, "h": 0.05, "scene": 1},
                    {"text": "sliding in", "x": -0.5, "y": 0.6, "w": 0.4, "h": 0.05, "scene": 1}]

        with self.app(root, {"ok": True}, texts=texts) as app:
            out = self.verify(root, "--formats", "--quick", "--aspect", "16:9")
        aspects = sorted({r["aspect"] for r in app.requests if r["kind"] == "capture"})
        self.assertEqual(aspects, ["16:9", "9:16"])
        self.assertTrue(all(r.get("texts") for r in app.requests if r["kind"] == "capture"))
        safe = self.steps(out)["safe-areas"]
        self.assertEqual(len(safe["warnings"]), 2, safe["warnings"])
        self.assertTrue(all("text.title crosses the safe area (left by 3.0%)" in w for w in safe["warnings"]), safe["warnings"])
        self.assertEqual(sorted(w.split()[0] for w in safe["warnings"]), ["16:9", "9:16"])
        self.assertEqual(len(self.steps(out)["handoffs"]["seams"]), 2, "handoffs read the first aspect only")

    def test_a_ranged_flash_failure_fails_and_an_accepted_warning_is_a_note(self) -> None:
        root = make_project(self.tmp)
        warn = {"type": "general", "standard": "wcag", "severity": "warn", "startMs": 3500, "endMs": 4500, "tc": "00:03.500",
                "flashesPerSecond": 2.5, "areaPct": 20.0, "region": [0, 0, 0.5, 0.5], "deltaL": 0.4, "hint": "close to the limit"}
        fail = dict(warn, severity="fail", standard="itu", startMs=5000, endMs=6000, tc="00:05.000", flashesPerSecond=4.0)
        with self.app(root, {"ok": True}, issues=lambda req: [warn, fail]):
            out = self.verify(root, code=1)
        flashes = self.steps(out)["flashes"]
        self.assertEqual(len(flashes["errors"]), 1)
        self.assertIn("00:05.000", flashes["errors"][0])
        refused = self.kb(["flashes", "accept", "00:05.2", "--why", "fine"], cwd=root)
        self.assertExit(refused, 1)
        self.assertIn("never be accepted", refused.stderr)
        self.assertExit(self.kb(["flashes", "accept", "00:03.6", "--why", "a soft glint, checked by eye"], cwd=root), 0)
        saved = json.loads((root / "flashes.accepted.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["accepted"][0]["why"], "a soft glint, checked by eye")
        self.assertEqual(saved["accepted"][0]["scene"], "02-hero")
        # The fix: a changed source, so the next verify checks again instead of reusing the failing report.
        future = time.time() + 2
        os.utime(root / "scenes" / "03-outro.tsx", (future, future))
        with self.app(root, {"ok": True}, issues=lambda req: [warn]):
            out = self.verify(root)
        flashes = self.steps(out)["flashes"]
        self.assertEqual(flashes["warnings"], [])
        self.assertIn("accepted:", flashes["accepted"][0])
        listed = self.kb(["flashes"], cwd=root)
        self.assertIn("a soft glint", listed.stdout)
        self.assertExit(self.kb(["flashes", "forget", "00:03.500"], cwd=root), 0)
        self.assertEqual(json.loads((root / "flashes.accepted.json").read_text(encoding="utf-8"))["accepted"], [])

    def test_an_app_without_ranged_checks_leaves_flashes_not_checked(self) -> None:
        root = make_project(self.tmp)
        old = [k for k in KINDS if k != "range"]
        with self.app(root, {"ok": True}, kinds=old):
            out = self.verify(root, code=2)
        flashes = self.steps(out)["flashes"]
        self.assertTrue(flashes["notRun"])
        self.assertIn("update Kookaburra Cut", flashes["errors"][0])

    def test_an_app_load_error_fails_the_app_step(self) -> None:
        root = make_project(self.tmp)
        failing = {"ok": False, "scenes": [{"index": 1, "file": "scenes/02-hero.tsx", "id": "hero", "ok": False, "phase": "compile", "error": "line 3: oops", "warnings": []}]}
        with self.app(root, failing):
            out = self.verify(root, code=1)
        app = self.steps(out)["app"]
        self.assertFalse(app["ok"])
        self.assertIn("oops", app["errors"][0])
        self.assertTrue(self.steps(out)["captures"]["ok"])

    def test_cut_strobes_and_short_scene_steps_warn(self) -> None:
        stems = ["01-a", "02-b", "03-c", "04-d", "05-e"]
        root = make_project(self.tmp, scenes=stems)
        manifest = json.loads((root / "project.json").read_text(encoding="utf-8"))
        manifest["scenes"] = cuts(stems, 300)
        (root / "project.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        with self.app(root, {"ok": True}, white=lambda stem, at: stem in ("01-a", "03-c", "05-e")):
            out = self.verify(root, "--quick")
        handoffs = self.steps(out)["handoffs"]
        self.assertTrue(handoffs["ok"])
        self.assertEqual([s["kind"] for s in handoffs["seams"]], ["cut"] * 4)
        self.assertEqual([round(abs(s["deltaL"])) for s in handoffs["seams"]], [1, 1, 1, 1])
        self.assertTrue(any("strobes" in w for w in handoffs["warnings"]), handoffs["warnings"])
        self.assertTrue(any("next to a scene under" in w for w in handoffs["warnings"]))

    def test_a_second_gpu_stall_is_transient_exit_3(self) -> None:
        root = make_project(self.tmp)
        with self.app(root, {"ok": True}, stall=True):
            out = self.verify(root, "--no-render", code=3)
        captures = self.steps(out)["captures"]
        self.assertTrue(captures["transient"])
        self.assertEqual(captures["code"], "gpu-stalled")
        self.assertEqual(out["code"], "transient")
        self.assertIn("retryAfterMs", out)

    def test_flashes_check_only_a_fresh_export(self) -> None:
        root = make_project(self.tmp)
        films = root / "exports"
        films.mkdir()
        film = films / "demo-16x9.mp4"
        film.write_bytes(b"not really a film")
        old = time.time() - 600
        os.utime(film, (old, old))
        out = self.verify(root, code=2)
        flashes = self.steps(out)["flashes"]
        self.assertTrue(flashes["notRun"])
        self.assertIn("older than", flashes["errors"][0])
        self.assertEqual(verify.newest_film(self._project(root)), film)
        newest, name = verify.newest_source(self._project(root))
        self.assertGreater(newest, old)
        self.assertIsNotNone(name)

    def test_film_runs_kb_export_and_skips_the_film_check_when_it_fails(self) -> None:
        root = make_project(self.tmp)
        mine = root / "exports" / "demo-16x9-custom.mp4"
        mine.parent.mkdir(parents=True, exist_ok=True)
        mine.write_bytes(b"the user's film")
        out = self.verify(root, "--film", code=2)
        self.assertEqual(mine.read_bytes(), b"the user's film")
        steps = self.steps(out)
        self.assertEqual(list(steps)[-2:], ["export", "film"])
        self.assertFalse(steps["export"]["ok"])
        self.assertIn("skipped", steps["film"])
        self.assertNotIn("flashes", steps)

    def test_a_film_draft_never_replaces_the_users_custom_export(self) -> None:
        root = make_project(self.tmp)
        project = self._project(root)
        exports = root / "exports"
        exports.mkdir()
        mine, report, other = exports / "demo-16x9-custom.mp4", exports / "demo-16x9-custom.mp4.flashes.json", exports / "demo-16x9.mp4"
        mine.write_bytes(b"user")
        report.write_text("{}")
        other.write_bytes(b"keep")
        hold = verify.drafts_root(project) / "held-1"
        held = verify.hold_custom_exports(project, hold)
        self.assertFalse(mine.exists() or report.exists())
        self.assertTrue(other.exists())
        mine.write_bytes(b"draft")
        report.write_text('{"draft": true}')
        kept = Path(verify.keep_draft(project, str(mine), hold) or "")
        self.assertEqual(kept.read_bytes(), b"draft")
        self.assertEqual(kept.parent.parent, verify.drafts_root(project))
        self.assertTrue((kept.parent / report.name).is_file())
        self.assertEqual(verify.restore_custom_exports(held, hold), [])
        self.assertEqual((mine.read_bytes(), report.read_text(), other.read_bytes()), (b"user", "{}", b"keep"))
        self.assertFalse(hold.exists())

    def test_a_killed_runs_held_exports_come_back_next_time(self) -> None:
        import subprocess
        import sys

        root = make_project(self.tmp)
        project = self._project(root)
        (root / "exports").mkdir()
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        orphan = verify.drafts_root(project) / f"held-{dead.pid}-1"
        running = verify.drafts_root(project) / f"held-{os.getpid()}-2"
        for hold, name in ((orphan, "demo-16x9-custom.mp4"), (running, "demo-9x16-custom.mp4")):
            hold.mkdir(parents=True)
            (hold / name).write_bytes(b"user")
        notes = verify.recover_held_exports(project)
        self.assertEqual((root / "exports" / "demo-16x9-custom.mp4").read_bytes(), b"user")
        self.assertFalse(orphan.exists())
        self.assertTrue((running / "demo-9x16-custom.mp4").is_file(), "a live run keeps what it holds")
        self.assertEqual(len(notes), 1)
        self.assertIn("put back demo-16x9-custom.mp4", notes[0])

    def _project(self, root: Path) -> Any:
        from kblib.project import Project

        return Project(root)


class SoloWindowTests(KbTestCase):
    def test_frames_sit_outside_transitions(self) -> None:
        slots = [{"startMs": 0, "endMs": 3000, "durationMs": 3000, "stem": "a"},
                 {"startMs": 2400, "endMs": 5400, "durationMs": 3000, "stem": "b", "transitionIn": {"type": "crossfade", "durationMs": 600}},
                 {"startMs": 5400, "endMs": 6000, "durationMs": 600, "stem": "c"}]
        self.assertEqual(verify.solo_window(slots, 0), (0.0, 2400 - 1000 / 60))
        self.assertEqual(verify.solo_window(slots, 1), (600.0, 3000 - 1000 / 60))
        self.assertEqual(verify.solo_window(slots, 2), (0.0, 600 - 1000 / 60))

    def test_capture_size_and_probe_grid_stay_in_bounds(self) -> None:
        self.assertEqual(verify.capture_size("16:9"), (1280, 720))
        self.assertEqual(verify.capture_size("9:16"), (720, 1280))
        for aspect in ("16:9", "9:16", "1:1", "4:5"):
            w, h = verify.capture_size(aspect)
            grid = verify.probe_grid((w, h))
            self.assertEqual(len(grid), 64)
            self.assertTrue(all(0 <= x < w - 1 and 0 <= y < h - 1 for x, y in grid))
