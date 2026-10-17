from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List

from kblib import verify

from .helpers import FakeApp, KbTestCase, make_project, png_bytes

FEATURES = ["scale", "width", "probe", "client", "deadline", "recycle", "debug"]
KINDS = ["capture", "check", "fonts", "insertPreset", "mediaChanged", "openEdit", "debug"]


def health() -> Dict[str, Any]:
    return {"version": 1, "captureFeatures": FEATURES, "queue": {"depth": 0, "order": [], "etaMs": [], "inFlight": None}, "gpu": {"stalled": False, "wedged": False},
            "renderWindow": {"alive": True}, "webgl": {}, "clients": []}


def cuts(stems: List[str], ms: int) -> List[Dict[str, Any]]:
    return [{"file": f"scenes/{s}.tsx", "durationMs": ms} for s in stems]


class VerifyTests(KbTestCase):
    def app(self, project: Path, check: Dict[str, Any], white: Any = None, stall: bool = False) -> FakeApp:
        """check answers `check`; captures write PNGs and probe white for scenes `white(stem, label)` picks, else black."""
        shots = self.tmp / "shots"
        shots.mkdir(exist_ok=True)

        def handler(req: Dict[str, Any]) -> Dict[str, Any]:
            if req["kind"] == "check":
                return dict({"project": req.get("project"), "scenes": [], "fonts": [], "assets": [], "warnings": [], "rendered": req.get("render")}, **check)
            if stall:
                return {"ok": False, "gpuStalled": True, "reason": "blankReadback", "recycled": True, "retryAfterMs": 0, "wedged": False, "error": "GPU stalled"}
            frames = []
            for n, f in enumerate(req["frames"]):
                path = shots / f"{req['id']}-{n}.png"
                path.write_bytes(png_bytes())
                lit = bool(white and white(f["scene"], f["at"]))
                value = 255 if lit else 0
                probes = [{"x": x, "y": y, "rgba": [value, value, value, 255], "hex": "#ffffff" if lit else "#000000"} for x, y in req.get("probe") or []]
                frames.append({"scene": f["scene"], "at": f["at"], "tMs": 0, "path": str(path), "index": n, "probes": probes})
            sheet = shots / f"{req['id']}-sheet.png"
            sheet.write_bytes(png_bytes())
            return {"ok": True, "project": req.get("project"), "format": req.get("aspect"), "frames": frames, "path": frames[0]["path"],
                    "paths": [f["path"] for f in frames], "sheetPath": str(sheet), "size": {"width": req.get("width"), "height": 720}}

        return FakeApp(self.bridge, handler, kinds=KINDS, health=health(), openProject="ws:demo")

    def verify(self, project: Path, *args: str, code: int = 0) -> Dict[str, Any]:
        proc = self.kb(["verify", "--json"] + list(args), cwd=project)
        self.assertExit(proc, code)
        return json.loads(proc.stdout)

    def steps(self, out: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        return {s["name"]: s for s in out["steps"]}

    def test_without_an_app_only_the_static_check_runs(self) -> None:
        root = make_project(self.tmp)
        out = self.verify(root)
        steps = self.steps(out)
        self.assertEqual(list(steps), ["static", "app", "captures", "handoffs", "flashes"])
        self.assertTrue(steps["static"]["ok"] and "skipped" not in steps["static"])
        for name in ("app", "captures", "handoffs", "flashes"):
            self.assertIn("skipped", steps[name], name)
        self.assertIn("not running", steps["app"]["skipped"])
        for s in out["steps"]:
            self.assertEqual(set(s) >= {"name", "ok", "ms", "errors", "warnings"}, True)
        text = self.kb(["verify"], cwd=root)
        self.assertExit(text, 0)
        self.assertIn("static checks only", text.stdout)

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
            out = self.verify(root)
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
        out = self.verify(root)
        flashes = self.steps(out)["flashes"]
        self.assertIn("older than", flashes["skipped"])
        self.assertEqual(verify.newest_film(self._project(root)), film)
        newest, name = verify.newest_source(self._project(root))
        self.assertGreater(newest, old)
        self.assertIsNotNone(name)

    def test_film_runs_kb_export_and_skips_the_film_check_when_it_fails(self) -> None:
        root = make_project(self.tmp)
        out = self.verify(root, "--film", code=1)
        steps = self.steps(out)
        self.assertEqual(list(steps)[-2:], ["export", "film"])
        self.assertFalse(steps["export"]["ok"])
        self.assertIn("skipped", steps["film"])
        self.assertNotIn("flashes", steps)

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
