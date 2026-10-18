from __future__ import annotations

import json
from typing import List

from kblib import check
from kblib.project import Project

from .helpers import SCENE_TSX, KbTestCase, make_project, read_json, write, write_json


def messages(report: check.Report, severity: str = "error") -> List[str]:
    return [f"{i.file} {i.path} {i.message}" for i in report.issues if i.severity == severity]


class CheckTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.project = Project(self.root)

    def run_check(self, files=None) -> check.Report:
        return check.check_project(self.project, files=files)

    def assertHasError(self, report: check.Report, *needles: str) -> None:
        errs = messages(report)
        for needle in needles:
            if not any(needle in e for e in errs):
                self.fail(f"no error containing {needle!r}; errors:\n" + "\n".join(errs))

    def test_valid_project_is_clean(self) -> None:
        report = self.run_check()
        self.assertEqual(messages(report), [])
        self.assertEqual(messages(report, "warning"), [])

    def test_cli_exit_codes(self) -> None:
        self.assertExit(self.kb(["check"], cwd=self.root), 0)
        write(self.root / "scenes" / "02-hero.tsx", "export default 1;")
        proc = self.kb(["check"], cwd=self.root)
        self.assertExit(proc, 1)
        self.assertIn("scenes/02-hero.tsx", proc.stdout)
        data = json.loads(self.kb(["check", "--json"], cwd=self.root).stdout)
        self.assertFalse(data["ok"])
        self.assertGreaterEqual(data["errors"], 1)

    def test_manifest_problems(self) -> None:
        m = read_json(self.root / "project.json")
        m["scenes"][0]["transition"] = {"type": "crossfdae", "durationMs": 600, "ease": "bouncy"}
        m["scenes"].append({"file": "scenes/09-missing.tsx", "durationMs": 1000})
        m["scenes"].append(dict(m["scenes"][1]))
        m["formats"] = ["16:9", "21:9"]
        m["themeId"] = "kookaburra-midnite"
        m["mystery"] = True
        write_json(self.root / "project.json", m)
        report = self.run_check()
        self.assertHasError(report, 'unknown transition "crossfdae". Did you mean \'crossfade\'', "unknown ease", "09-missing.tsx\" does not exist", "already scene 1", 'unknown aspect "21:9"', "kookaburra-midnight")
        self.assertTrue(any("mystery" in w for w in messages(report, "warning")))

    def test_invalid_manifest_json(self) -> None:
        write(self.root / "project.json", '{"id": "demo",')
        report = self.run_check()
        self.assertHasError(report, "not valid JSON (line 1")

    def test_legacy_manifest_warns(self) -> None:
        m = read_json(self.root / "project.json")
        del m["version"]
        write_json(self.root / "project.json", m)
        self.assertTrue(any("legacy v1" in w for w in messages(self.run_check(), "warning")))

    def test_sidecar_problems(self) -> None:
        doc = {
            "version": 1,
            "textStyle": {"titleFont": "SF Mono@400", "bodyFont": "Menlo@400", "titleSize": -1, "titleWobble": 3, "titleColor": "red"},
            "managedText": {"items": [{"key": "t", "type": "title", "text": "A"}, {"key": "t", "type": "title"}, {"key": "x", "type": "heading"}]},
            "devices": [{"id": "d1", "model": "iphone-99"}, {"id": "d1", "model": "android", "shadow": "hard"}],
            "camera": {"keys": [{"id": "k1", "tMs": 0, "pose": {}}], "segments": [{"from": "k1", "to": "k9", "ease": "inOutQaud"}]},
            "background": {"type": "scene3d", "look": "aurora"},
            "textAnimation": {"in": "fade-upp", "out": "fade", "staggerMs": 0},
            "headerIcon": "assets/Logo.png",
            "media": [{"id": "m1", "src": "assets/nope.mp4", "kind": "video"}],
            "extraThing": 1,
        }
        write_json(self.root / "scenes" / "02-hero.json", doc)
        from kblib import fonts

        fonts.record_verdicts([{"ref": "SF Mono@400", "ok": False, "error": "unknown encoding format: 1", "fallback": "Inter@400"}], "0.19.0")
        report = self.run_check(["scenes/02-hero.json"])
        self.assertHasError(
            report,
            '"SF Mono@400" failed the app\'s font check (unknown encoding format: 1); Inter@400 renders instead',
            "JetBrains Mono@400",
            "textStyle.titleSize",
            "textStyle.titleWobble",
            'duplicate key "t"',
            "must be one of title, subtitle, bullets, icon",
            'unknown device model "iphone-99"',
            'duplicate device id "d1"',
            'unknown device shadow "hard"',
            '"k9" matches no key id',
            'unknown ease "inOutQaud"',
            'unknown 3D background look "aurora"',
            'unknown text motion "fade-upp"',
            "case differs from disk (assets/logo.png)",
            '"assets/nope.mp4" does not exist',
        )
        warnings = messages(report, "warning")
        self.assertTrue(any('"Menlo@400" is not vetted yet' in w for w in warnings))
        self.assertTrue(any("extraThing" in w for w in warnings))
        self.assertTrue(any("not a #rgb" in w for w in warnings))

    def test_sidecar_motion_blur(self) -> None:
        doc = {"version": 1, "motionBlur": {"enabled": "yes", "shutterDeg": 720, "samples": 16}}
        write_json(self.root / "scenes" / "02-hero.json", doc)
        report = self.run_check(["scenes/02-hero.json"])
        self.assertHasError(report, "motionBlur.enabled", "must be 0..360")
        self.assertTrue(any("samples is project-wide" in w for w in messages(report, "warning")))
        self.assertFalse(any("unknown key" in w and "motionBlur" in w for w in messages(report, "warning")))

    def test_sidecar_version_and_json(self) -> None:
        write_json(self.root / "scenes" / "02-hero.json", {"name": "x"})
        self.assertHasError(self.run_check(["scenes/02-hero.json"]), "ignores the whole sidecar")
        write(self.root / "scenes" / "02-hero.json", "{nope")
        self.assertHasError(self.run_check(["scenes/02-hero.json"]), "not valid JSON")

    def test_tsx_rules(self) -> None:
        bad = (
            'import { defineScene, useSceneText, Bogus } from "@kookaburra/toolkit";\n'
            'import { useMemo } from "react";\n'
            'import helper from "./helper";\n'
            "export default defineScene({\n"
            '  id: "intro",\n'
            "  durationMs: 3000,\n"
            "  Scene() {\n"
            "    const v = useMemo(() => Math.random(), []);\n"
            "    const t = Date.now();\n"
            "    const w = window.innerWidth;\n"
            "    const x = useSceneDevices();\n"
            '    return <Html><img src="assets/missing.png" /></Html>;\n'
            "  },\n"
            "});\n"
        )
        write(self.root / "scenes" / "02-hero.tsx", bad)
        report = self.run_check(["scenes/02-hero.tsx"])
        self.assertHasError(
            report,
            '"Bogus" is not exported by @kookaburra/toolkit',
            'import "react" does not resolve',
            'import "./helper": scenes are single files',
            "useMemo is not available",
            "Math.random",
            "Date.now",
            "window.",
            "useSceneDevices is not imported",
            "<Html",
            '"intro" is already the id of scenes/01-intro.tsx',
            '"assets/missing.png" does not exist',
        )

    def test_tsx_default_export_and_literal_id(self) -> None:
        write(self.root / "scenes" / "02-hero.tsx", 'import { defineScene } from "@kookaburra/toolkit";\nconst s = defineScene({ id: "hero" });\nexport default s;\n')
        self.assertHasError(self.run_check(["scenes/02-hero.tsx"]), "the default export is not defineScene")
        write(self.root / "scenes" / "02-hero.tsx", 'import { defineScene } from "@kookaburra/toolkit";\nconst n = "x";\nexport default defineScene({ id: `hero-${n}`, durationMs: 1, Scene() { return null; } });\n')
        self.assertHasError(self.run_check(["scenes/02-hero.tsx"]), "needs a literal string id")
        write(self.root / "scenes" / "02-hero.tsx", 'export default defineScene({ id: "hero", durationMs: 1, Scene() { return null; } });\n')
        self.assertHasError(self.run_check(["scenes/02-hero.tsx"]), "defineScene is not imported")

    def test_strays_and_unregistered_scene(self) -> None:
        write(self.root / "scenes" / "07-stray.tsx", SCENE_TSX.format(id="stray"))
        write_json(self.root / "scenes" / "08-orphan.json", {"version": 1})
        warnings = messages(self.run_check(), "warning")
        self.assertTrue(any("07-stray.tsx" in w and "kb scene add 07-stray" in w for w in warnings))
        self.assertTrue(any("08-orphan.json" in w for w in warnings))
        scoped = messages(self.run_check(["scenes/07-stray.tsx"]), "warning")
        self.assertTrue(any("not in project.json yet" in w for w in scoped))

    def test_scoped_check_keeps_manifest_errors_but_not_its_warnings(self) -> None:
        m = read_json(self.root / "project.json")
        m["scenes"][0]["file"] = "scenes/00-gone.tsx"
        m["mystery"] = 1
        write_json(self.root / "project.json", m)
        report = self.run_check(["scenes/02-hero.json"])
        self.assertHasError(report, "00-gone.tsx")
        self.assertFalse(any("mystery" in w for w in messages(report, "warning")))

    def test_audio_and_typography(self) -> None:
        m = read_json(self.root / "project.json")
        m["audio"] = {"file": "assets/song.mp3", "fadeOutCurve": "wobbly"}
        m["typography"] = {"headline": "Monaco@400", "body": "Inter"}
        write_json(self.root / "project.json", m)
        report = self.run_check()
        self.assertHasError(report, "song.mp3")
        self.assertTrue(any("wobbly" in w for w in messages(report, "warning")))
        self.assertTrue(any("Monaco@400" in w for w in messages(report, "warning")))

    def test_repeated_font_verdicts_collapse(self) -> None:
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "textStyle": {"aFont": "Futura@500", "bFont": "Futura@500"}})
        warnings = [i for i in self.run_check(["scenes/02-hero.json"]).issues if i.severity == "warning"]
        self.assertEqual(len(warnings), 1)
        self.assertIn("textStyle.aFont, textStyle.bFont", warnings[0].path)

    def test_without_catalogue_enum_checks_fall_back_or_skip(self) -> None:
        self.env["KB_CATALOG"] = str(self.tmp / "missing.json")
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "devices": [{"id": "d1", "model": "anything"}]})
        m = read_json(self.root / "project.json")
        m["scenes"][0]["transition"]["type"] = "crossfdae"
        write_json(self.root / "project.json", m)
        proc = self.kb(["check"], cwd=self.root)
        self.assertExit(proc, 1)
        self.assertIn("crossfdae", proc.stdout)
        self.assertNotIn("anything", proc.stdout)

    def test_shared_must_be_an_object(self) -> None:
        m = read_json(self.root / "project.json")
        m["shared"] = {"palette": {"accent": "#ff6a3d"}, "beats": [0, 480]}
        write_json(self.root / "project.json", m)
        report = self.run_check()
        self.assertEqual(messages(report), [])
        self.assertFalse(any("shared" in w for w in messages(report, "warning")))
        m["shared"] = ["#ff6a3d"]
        write_json(self.root / "project.json", m)
        self.assertHasError(self.run_check(), "project.json shared must be an object")

    def test_unknown_ease_literals_warn(self) -> None:
        tsx = (
            'import { defineScene, ease, easeFn, ramp, useTimeline } from "@kookaburra/toolkit";\n'
            "export default defineScene({\n"
            '  id: "hero",\n'
            "  durationMs: 3000,\n"
            "  Scene() {\n"
            "    const { localMs } = useTimeline();\n"
            '    const a = ease("outQaud", localMs / 900);\n'
            "    const b = easeFn('inOutCubic')(0.5);\n"
            '    const c = ramp(localMs, Math.min(100, 200), 900, "outBounce", { overshoot: 2 });\n'
            '    const d = ramp(localMs, 0, 900, "linear");\n'
            "    const e = ramp(localMs, 0, 900);\n"
            '    // ease("commented")\n'
            '    const f = "ease(\"quoted\")";\n'
            "    return null;\n"
            "  },\n"
            "});\n"
        )
        write(self.root / "scenes" / "02-hero.tsx", tsx)
        report = self.run_check(["scenes/02-hero.tsx"])
        self.assertEqual(messages(report), [])
        warnings = messages(report, "warning")
        self.assertEqual(len(warnings), 2, warnings)
        self.assertIn('line 7 unknown ease "outQaud" falls back to the default ease, inOutQuad. Did you mean \'outQuad\'', warnings[0])
        self.assertIn('line 9 unknown ease "outBounce"', warnings[1])

    def test_ease_literals_ignore_local_functions(self) -> None:
        tsx = (
            'import { defineScene } from "@kookaburra/toolkit";\n'
            "const ease = (name: string, t: number) => t;\n"
            "export default defineScene({\n"
            '  id: "hero",\n'
            "  durationMs: 3000,\n"
            "  Scene() {\n"
            '    return ease("custom", 0.5) ? null : null;\n'
            "  },\n"
            "});\n"
        )
        write(self.root / "scenes" / "02-hero.tsx", tsx)
        self.assertEqual(messages(self.run_check(["scenes/02-hero.tsx"]), "warning"), [])

    def test_duplicate_ids_flag_only_the_later_scene(self) -> None:
        write(self.root / "scenes" / "03-outro.tsx", SCENE_TSX.format(id="hero"))
        errs = messages(self.run_check())
        self.assertTrue(any(e.startswith("scenes/03-outro.tsx") and "already the id of scenes/02-hero.tsx" in e for e in errs))
        self.assertFalse(any(e.startswith("scenes/02-hero.tsx") for e in errs))
