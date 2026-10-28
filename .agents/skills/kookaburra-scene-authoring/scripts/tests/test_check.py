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

    def test_image_mask_transition(self) -> None:
        m = read_json(self.root / "project.json")
        mask = {"type": "luma", "durationMs": 600, "shape": "image", "src": "assets/star.png"}
        m["scenes"][0]["transition"] = dict(mask)
        write_json(self.root / "project.json", m)
        self.assertHasError(self.run_check(), 'assets/star.png" does not exist')
        (self.root / "assets").mkdir(exist_ok=True)
        (self.root / "assets" / "star.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        self.assertFalse([e for e in messages(self.run_check()) if ".transition.s" in e])
        m["scenes"][0]["transition"] = {**mask, "src": "assets/star.gif"}
        write_json(self.root / "project.json", m)
        self.assertHasError(self.run_check(), "not a supported mask image")
        m["scenes"][0]["transition"] = {k: v for k, v in mask.items() if k != "src"}
        write_json(self.root / "project.json", m)
        self.assertHasError(self.run_check(), 'shape "image" needs "src"')
        m["scenes"][0]["transition"] = {**mask, "type": "glasssweep"}
        write_json(self.root / "project.json", m)
        report = self.run_check()
        self.assertEqual(messages(report), [])
        self.assertTrue(any("only applies to luma" in w for w in messages(report, "warning")))
        m["scenes"][0]["transition"] = {"type": "luma", "durationMs": 600, "src": "assets/star.png"}
        write_json(self.root / "project.json", m)
        self.assertTrue(any("src is only read" in w for w in messages(self.run_check(), "warning")))

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
        self.assertTrue(any("is not a theme token" in w for w in warnings))

    def test_text_colour_takes_theme_tokens(self) -> None:
        doc = {"version": 1, "textStyle": {"titleColor": "text", "subtitleColor": "muted", "statColor": "accent", "bodyColor": "#ff5a36"}}
        write_json(self.root / "scenes" / "02-hero.json", doc)
        self.assertEqual(messages(self.run_check(["scenes/02-hero.json"]), "warning"), [])

    def test_a_clip_placed_while_it_conforms_is_info_until_it_lands(self) -> None:
        doc = {"version": 1, "devices": [{"id": "d1", "model": "android", "media": {"src": "assets/rec.mp4", "kind": "video"}}]}
        write_json(self.root / "scenes" / "02-hero.json", doc)
        write(self.root / "assets" / ".originals" / "rec.MOV", "original")
        report = self.run_check(["scenes/02-hero.json"])
        self.assertEqual(messages(report), [])
        self.assertTrue(any('"assets/rec.mp4" is still conforming from assets/.originals/rec.MOV' in i for i in messages(report, "info")))

        # A landed conform writes its timing record last, so a missing mezzanine beside one is gone, not conforming.
        write_json(self.root / "assets" / "rec.timing.json", {"version": 1})
        self.assertHasError(self.run_check(["scenes/02-hero.json"]), '"assets/rec.mp4" does not exist')
        (self.root / "assets" / "rec.timing.json").unlink()
        for src in ("assets/clips/rec.mp4", "assets/rec.mov", "assets/other.mp4"):
            doc["devices"][0]["media"]["src"] = src
            write_json(self.root / "scenes" / "02-hero.json", doc)
            self.assertHasError(self.run_check(["scenes/02-hero.json"]), f'"{src}" does not exist')

    def test_emphasis_and_build_checks(self) -> None:
        doc = {
            "version": 1,
            "text": {"title": "Ship *twice*\nas fast", "tag": "One line", "sub": "Two\nlines"},
            "textStyle": {"titleEmphasis": "accent@700", "tagEmphasis": "bold", "subEmphasis": "#fff@2000"},
            "textAnimation": {"in": "build", "out": "none", "staggerMs": 200, "buildShiftEm": "far"},
            "textAnimationOverrides": {"sub": {"in": "fade", "out": "none", "staggerMs": 0}},
            "textLook": {"preset": "offset-print", "offsetDir": "left", "offsetOpacity": 2},
        }
        write_json(self.root / "scenes" / "02-hero.json", doc)
        report = self.run_check(["scenes/02-hero.json"])
        self.assertHasError(report, "textStyle.tagEmphasis", "textStyle.subEmphasis", "buildShiftEm", "textLook.offsetDir")
        self.assertFalse(any("titleEmphasis" in e for e in messages(report)))
        warnings = messages(report, "warning")
        self.assertTrue(any("text.title" in w and "build is single line" in w for w in warnings))
        self.assertFalse(any("text.sub" in w and "build is single line" in w for w in warnings))
        self.assertFalse(any("text.tag" in w and "build is single line" in w for w in warnings))
        self.assertTrue(any("offsetOpacity" in w for w in warnings))

    def test_sidecar_motion_blur(self) -> None:
        doc = {"version": 1, "motionBlur": {"enabled": "yes", "shutterDeg": 720, "samples": 16}}
        write_json(self.root / "scenes" / "02-hero.json", doc)
        report = self.run_check(["scenes/02-hero.json"])
        self.assertHasError(report, "motionBlur.enabled", "must be 0..360")
        self.assertTrue(any("samples is project-wide" in w for w in messages(report, "warning")))
        self.assertFalse(any("unknown key" in w and "motionBlur" in w for w in messages(report, "warning")))

    def test_zero_stagger_warns_only_where_a_default_delay_applies(self) -> None:
        doc = {
            "version": 1,
            "textAnimation": {"in": "tracking", "out": "fade", "staggerMs": 0},
            "textAnimationOverrides": {
                "title": {"in": "fade", "out": "none", "staggerMs": 0, "delivery": "by-paragraph"},
                "plain": {"in": "fade", "out": "none", "staggerMs": 0},
                "exact": {"in": "tracking", "out": "none", "staggerMs": 0, "staggerExact": True},
            },
        }
        write_json(self.root / "scenes" / "02-hero.json", doc)
        warned = [w for w in messages(self.run_check(["scenes/02-hero.json"]), "warning") if "staggerExact" in w]
        self.assertEqual(len(warned), 2, warned)
        self.assertTrue(any("textAnimation.staggerMs" in w for w in warned))
        self.assertTrue(any("textAnimationOverrides.title.staggerMs" in w for w in warned))

    def test_kb_writes_stamp_a_new_zero_stagger_exact(self) -> None:
        spec = {"in": "fade-up", "out": "fade", "staggerMs": 90, "delivery": "by-paragraph"}
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "textAnimation": spec})
        self.assertExit(self.kb(["doc", "02-hero", "set", "textAnimation.staggerMs", "0"], cwd=self.root), 0)
        self.assertIs(read_json(self.root / "scenes" / "02-hero.json")["textAnimation"]["staggerExact"], True)
        seed = {"version": 1, "textAnimation": {"in": "fade", "out": "none", "staggerMs": 0}}
        stamped = check.stamp_stagger_exact(seed, dict(seed, name="Hero"))
        self.assertNotIn("staggerExact", stamped["textAnimation"])
        added = check.stamp_stagger_exact(seed, dict(seed, textAnimationOverrides={"t": {"in": "fade", "out": "none", "staggerMs": 0}}))
        self.assertIs(added["textAnimationOverrides"]["t"]["staggerExact"], True)

    def test_sidecar_room(self) -> None:
        doc = {
            "version": 1,
            "lighting": {"lights": [{"id": "wash", "type": "point", "intensity": 4, "placement": {"mode": "point", "position": [0, 1, 2]}}]},
            "room": {
                "keys": [
                    {"at": "bar:2", "colour": "#ff0000"},
                    {"at": 0, "color": "#00ff00", "colour": "teal"},
                    {"at": 100, "themeId": "kookaburra-nope", "transition": "flood", "ease": "inOutQaud", "durationMs": 900},
                    {"at": 500, "lighting": {"lights": {"wsh": {"intensity": 2}}}},
                    {"at": 700},
                ]
            },
        }
        write_json(self.root / "scenes" / "02-hero.json", doc)
        report = self.run_check(["scenes/02-hero.json"])
        self.assertFalse(any("room.keys[0].at" in e for e in messages(report)))
        self.assertHasError(
            report,
            "room.keys[1].colour",
            'unknown theme "kookaburra-nope"',
            'unknown ease "inOutQaud"',
            "room.keys[4] needs a colour, a themeId or lighting",
        )
        warnings = messages(report, "warning")
        self.assertTrue(any("room.keys[1].color" in w and "colour" in w for w in warnings))
        self.assertTrue(any("runs past the next key at 500ms" in w for w in warnings))
        self.assertTrue(any("lights.wsh" in w and "wash" in w for w in warnings))
        write(self.root / "scenes" / "02-hero.tsx", "export default 1;")
        report = self.run_check(["scenes/02-hero.json"])
        self.assertTrue(any("stage the scene" in w for w in messages(report, "warning")))

    def test_sidecar_taps(self) -> None:
        doc = {
            "version": 1,
            "devices": [{"id": "d1", "model": "android"}],
            "taps": [
                {"at": 400, "screenUv": [0.5, 0.6], "device": "d1"},
                {"at": 900, "position": [0, 0, 0], "colour": "accent", "size": 1.5},
                {"at": -5, "position": [0, 0]},
                {"at": 100, "screenUv": [1.2, 0.5], "device": "d9", "colour": "teal", "size": 0, "when": 1},
            ],
        }
        write_json(self.root / "scenes" / "02-hero.json", doc)
        report = self.run_check(["scenes/02-hero.json"])
        self.assertHasError(report, "taps[2].at", "taps[2] needs a position", "taps[3].colour", "taps[3].size")
        self.assertFalse(any("taps[0]" in e or "taps[1]" in e for e in messages(report)))
        warnings = messages(report, "warning")
        for needle in ("taps[3].when", 'no sidecar device "d9"', "taps[3].screenUv is off the screen"):
            self.assertTrue(any(needle in w for w in warnings), (needle, warnings))
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "taps": {"at": 0}})
        self.assertHasError(self.run_check(["scenes/02-hero.json"]), "taps must be an array")

    def test_sidecar_mosaic(self) -> None:
        write(self.root / "assets" / "a.jpg", "jpg")
        doc = {
            "version": 1,
            "mosaic": {
                "tiles": [
                    {"src": "assets/a.jpg"},
                    {"colour": "accent"},
                    {"src": "assets/missing.mp4", "loop": True},
                    {"src": "assets/notes.txt"},
                    {"src": "assets/a.jpg", "startMs": 100},
                    {"colour": "teal", "tint": 1},
                ],
                "columns": 0,
                "gap": -1,
                "reveal": {"order": "diagonal", "ease": "outCubc", "staggerMs": -2},
                "layout": "grid",
            },
        }
        write_json(self.root / "scenes" / "02-hero.json", doc)
        report = self.run_check(["scenes/02-hero.json"])
        self.assertHasError(
            report,
            "mosaic.tiles[2].src",
            "mosaic.tiles[3].src must be an assets/ image",
            "mosaic.tiles[5].colour",
            "mosaic.columns",
            "mosaic.gap",
            "mosaic.reveal.order",
            'unknown ease "outCubc"',
            "mosaic.reveal.staggerMs",
        )
        warnings = messages(report, "warning")
        for needle in ("mosaic.layout", "mosaic.tiles[5].tint", "mosaic.tiles[4] startMs and loop only apply"):
            self.assertTrue(any(needle in w for w in warnings), (needle, warnings))
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "mosaic": {"tiles": [{"src": "x.png"}]}})
        self.assertHasError(self.run_check(["scenes/02-hero.json"]), "mosaic.tiles has no usable tile")

    def test_window_shadow_colour(self) -> None:
        doc = {
            "version": 1,
            "media": [
                {"id": "v1", "kind": "video", "src": "assets/demo.mp4", "host": "window", "window": {"radius": "macos", "shadow": {"opacity": 1, "blur": 0, "offset": [0.03, -0.03], "colour": "accent"}}},
            ],
        }
        write_json(self.root / "scenes" / "02-hero.json", doc)
        self.assertHasError(self.run_check(["scenes/02-hero.json"]), "media[0].window.shadow.colour must be #rrggbb")

    def test_room_reaches_project_lights_and_clamps_negative_at(self) -> None:
        manifest = read_json(self.root / "project.json")
        manifest["lighting"] = {"lights": [{"id": "key", "type": "point", "intensity": 2, "placement": {"mode": "point", "position": [0, 1, 2]}}]}
        write_json(self.root / "project.json", manifest)
        doc = {
            "version": 1,
            "lighting": {"lights": [{"id": "wash", "type": "point", "intensity": 4, "placement": {"mode": "point", "position": [0, 1, 2]}}]},
            "room": {"keys": [{"at": -200, "colour": "#ff0000", "lighting": {"lights": {"key": {"intensity": 1}}}}]},
        }
        write_json(self.root / "scenes" / "02-hero.json", doc)
        report = self.run_check(["scenes/02-hero.json"])
        self.assertFalse(any("room.keys[0].at" in e for e in messages(report)))
        warnings = messages(report, "warning")
        self.assertTrue(any("room.keys[0].at" in w and "from 0" in w for w in warnings))
        self.assertFalse(any("lights.key" in w for w in warnings), warnings)

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

    def probe_cache(self, rel: str, duration_ms: int) -> None:
        st = (self.root / rel).stat()
        write_json(self.tmp / "_bridge" / "video" / "demo" / "probe-cache.json", {f"/x/kookaburra-cut|1|2|{rel}|{st.st_size}|{st.st_mtime_ns}": {"ok": True, "kind": "video", "durationMs": duration_ms}})

    def test_device_media_keys(self) -> None:
        (self.root / "assets" / "rec.mp4").write_bytes(b"fake video")
        self.probe_cache("assets/rec.mp4", 4000)
        video = {"src": "assets/rec.mp4", "kind": "video"}
        write_json(self.root / "scenes" / "02-hero.json", {
            "version": 1,
            "devices": [
                {"id": "d1", "model": "iphone-17-pro", "media": dict(video, inMs=5000, outMs=6000, speed=8, posterMs=10, mystery=1)},
                {"id": "d2", "model": "iphone-17-pro", "media": dict(video, startMs=-100, inMs=100, loop="yes", outMs=10)},
                {"id": "d3", "model": "iphone-17-pro", "media": {"src": "assets/logo.png", "kind": "image", "speed": 2}},
                {"id": "d4", "model": "iphone-17-pro", "media": dict(video, startMs=300, inMs=500, outMs=3000, speed=2, posterMs=0), "coverMedia": dict(video, inMs=1.5)},
                {"id": "d5", "model": "iphone-17-pro", "media": dict(video, outMs=4500, startOn="open", posterMs=0)},
            ],
            "compare": {"b": {"media": {"d1": dict(video, speed=0)}}},
        })
        report = self.run_check(["scenes/02-hero.json"])
        errors = messages(report)
        for path, needle in (
            ("devices[0].media.inMs", "at or past the end of assets/rec.mp4 (4000 ms)"),
            ("devices[1].media.inMs", "use inMs for a trim and startMs for a delay"),
            ("devices[1].media.loop", "isn't a boolean"),
            ("devices[1].media.outMs", "trims the whole video"),
            ("devices[2].media.speed", "only applies to a video"),
            ("devices[3].coverMedia.inMs", "isn't a whole number of ms"),
            ('compare.b.media["d1"].speed', "above 0 and at most 16"),
        ):
            self.assertTrue(any(f"{path} " in e and needle in e for e in errors), f"{path}: {needle}\n" + "\n".join(errors))
        self.assertEqual(len(errors), 7, "\n".join(errors))
        warnings = messages(report, "warning")
        for path, needle in (
            ("devices[0].media.outMs", "past the end of assets/rec.mp4"),
            ("devices[0].media.speed", "outside the editor's 0.25x to 6x"),
            ("devices[0].media.posterMs", "is inert"),
            ("devices[0].media.mystery", "unknown media key"),
            ("devices[4].media.outMs", "past the end"),
        ):
            self.assertTrue(any(f"{path} " in w and needle in w for w in warnings), f"{path}: {needle}\n" + "\n".join(warnings))
        self.assertFalse(any("devices[3].media" in w or "devices[4].media.posterMs" in w for w in warnings), "\n".join(warnings))
        (self.root / "assets" / "rec.mp4").write_bytes(b"a re-encoded video")
        self.assertFalse(any("past the end" in i.message for i in self.run_check(["scenes/02-hero.json"]).issues))
        proc = self.kb(["check", "--json", "scenes/02-hero.json"], cwd=self.root)
        self.assertExit(proc, 1)
        self.assertEqual(json.loads(proc.stdout)["code"], "invalid")

    def test_retimed_render_warns(self) -> None:
        write_json(self.root / "edits" / "rec.json", {"version": 1})
        (self.root / "assets" / "rec-edited.mp4").write_bytes(b"render")
        media = {"src": "assets/rec-edited.mp4", "kind": "video", "speed": 2, "loop": True}
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "devices": [{"id": "d1", "model": "iphone-17-pro", "media": media}]})
        warnings = messages(self.run_check(["scenes/02-hero.json"]), "warning")
        self.assertTrue(any("devices[0].media " in w and "retimes the render of edits/rec.json with speed" in w for w in warnings), "\n".join(warnings))
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "devices": [{"id": "d1", "model": "iphone-17-pro", "media": {k: v for k, v in media.items() if k != "speed"}}]})
        self.assertFalse(any("retimes the render" in w for w in messages(self.run_check(["scenes/02-hero.json"]), "warning")))

    def test_device_media_keys_follow_the_real_catalogue(self) -> None:
        from kblib import catalog

        cat = catalog.Catalog(read_json(catalog.SKILL_DIR / "catalog.json"), catalog.SKILL_DIR / "catalog.json")
        self.assertEqual(catalog.device_media_keys(cat), catalog.FALLBACK_DEVICE_MEDIA_KEYS)
        self.assertEqual(catalog.scene_doc_keys(cat), catalog.FALLBACK_SCENE_DOC_KEYS)

    def kick_scene(self, kicks: object, tsx: str = "", **extra: object) -> check.Report:
        write(self.root / "scenes" / "02-hero.tsx", SCENE_TSX.format(id="hero").replace("<SceneStage>", f"<SceneStage>{tsx}"))
        write_json(self.root / "scenes" / "02-hero.json", dict({"version": 1, "cameraKicks": kicks}, **extra))
        return self.run_check(["scenes/02-hero.json"])

    def test_camera_kicks(self) -> None:
        (self.root / "assets" / "track.mp3").write_bytes(b"fake audio")
        m = read_json(self.root / "project.json")
        m["audio"] = {"file": "assets/track.mp3", "grid": {"bpm": 120, "offsetMs": 0, "beatsPerBar": 4}, "cues": {"drop": "bar:3"}}
        write_json(self.root / "project.json", m)
        kicks = [
            {"at": "bar:3", "zoom": 1.04, "releaseMs": 300},
            {"at": "cue:drop+40ms", "zoom": 1.1, "releaseMs": 200, "ease": "outQuad"},
            {"at": "cue:nope", "zoom": 1.1, "releaseMs": 200},
            {"at": -5, "zoom": 1.1, "releaseMs": 200},
            {"at": 100, "zoom": 9, "releaseMs": 200},
            {"at": 100, "offset": [0, 0, 0.2], "releaseMs": 200, "ease": "bouncy", "wobble": 1},
            {"at": 100, "rollDeg": "x", "releaseMs": 200},
            {"at": 100, "zoom": 1.1},
            "nope",
        ]
        report = self.kick_scene(kicks, tsx="<DepthStage />")
        errors = messages(report)
        for path, needle in (
            ("cameraKicks[3].at", "scene ms >= 0 or a position"),
            ("cameraKicks[4].zoom", "0.25 to 4"),
            ("cameraKicks[4] ", "no valid zoom, offset or rollDeg"),
            ("cameraKicks[5].ease", 'unknown ease "bouncy"'),
            ("cameraKicks[6].rollDeg", "degrees"),
            ("cameraKicks[7].releaseMs", "required"),
            ("cameraKicks[8] ", "must be an object"),
        ):
            self.assertTrue(any(path in e and needle in e for e in errors), f"{path}: {needle}\n" + "\n".join(errors))
        self.assertFalse(any("cameraKicks[0]" in e or "cameraKicks[1]" in e or "cameraKicks[2]" in e for e in errors), "\n".join(errors))
        warnings = messages(report, "warning")
        self.assertTrue(any("cameraKicks[2].at" in w and 'no cue "nope"' in w for w in warnings), "\n".join(warnings))
        self.assertTrue(any("cameraKicks[5].wobble" in w and "unknown kick field" in w for w in warnings), "\n".join(warnings))
        self.assertTrue(any("cameraKicks[5] " in w and "DepthStage" in w for w in warnings), "\n".join(warnings))
        self.assertFalse(any("cameraKicks[0]" in w or "cameraKicks[1]" in w or "unknown key" in w for w in warnings), "\n".join(warnings))
        pull = [{"at": 100, "zoom": 0.9, "releaseMs": 100}]
        self.assertFalse(any("DepthStage" in i.message for i in self.kick_scene(pull).issues))
        rig = self.kick_scene(pull, tsx="<DepthStage />", cameraMode="rig", cameraRig={"keys": [], "segments": []})
        self.assertFalse(any("DepthStage" in i.message for i in rig.issues))
        self.assertTrue(any("DepthStage" in i.message for i in self.kick_scene(pull, tsx="<DepthStage />").issues))
        self.assertHasError(self.kick_scene({"at": 0}), "cameraKicks must be an array")
        del m["audio"]["grid"]
        write_json(self.root / "project.json", m)
        self.project = Project(self.root)
        unresolved = [i.message for i in self.kick_scene([{"at": "bar:2", "zoom": 1.1, "releaseMs": 100}]).issues if i.severity == "warning"]
        self.assertTrue(any("no audio.grid" in w and "./kb beats set-grid" in w for w in unresolved), unresolved)

    def test_duplicate_ids_flag_only_the_later_scene(self) -> None:
        write(self.root / "scenes" / "03-outro.tsx", SCENE_TSX.format(id="hero"))
        errs = messages(self.run_check())
        self.assertTrue(any(e.startswith("scenes/03-outro.tsx") and "already the id of scenes/02-hero.tsx" in e for e in errs))
        self.assertFalse(any(e.startswith("scenes/02-hero.tsx") for e in errs))

    def device_scene(self, props: str) -> str:
        return (
            'import { defineScene, Device, useSceneDevices } from "@kookaburra/toolkit";\n'
            "export default defineScene({\n"
            '  id: "hero",\n'
            "  durationMs: 3000,\n"
            "  Scene() {\n"
            "    const [d] = useSceneDevices();\n"
            "    return (\n"
            f"      <Device {{...d}} {props}>\n"
            "        <group position={[0, 0, 0]} />\n"
            "      </Device>\n"
            "    );\n"
            "  },\n"
            "});\n"
        )

    def test_devices_this_build_lacks_warn(self) -> None:
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "devices": [{"id": "d1", "model": "iphone-17-pro"}]})
        write(self.root / "scenes" / "02-hero.tsx", self.device_scene('model="macbook-pro-16"'))
        files = ["scenes/02-hero.json", "scenes/02-hero.tsx"]
        build = {"lastLoad": {"project": "ws:other", "availableDevices": ["android"]}}
        warnings = messages(check.check_project(self.project, files=files, heartbeat=build), "warning")
        self.assertTrue(any(w.startswith("scenes/02-hero.json devices[0].model") and '"iphone-17-pro" is not in this build' in w and "DeviceScreenAnchor" in w for w in warnings), warnings)
        self.assertTrue(any(w.startswith("scenes/02-hero.tsx line 8") and '"macbook-pro-16" is not in this build' in w for w in warnings), warnings)
        # Unknown without a heartbeat (or an older app's), and silent for models the build has.
        for heartbeat in (None, {"lastLoad": {"project": "ws:demo"}}, {"lastLoad": {"availableDevices": ["android", "iphone-17-pro", "macbook-pro-16"]}}):
            warnings = messages(check.check_project(self.project, files=files, heartbeat=heartbeat), "warning")
            self.assertFalse(any("not in this build" in w for w in warnings), (heartbeat, warnings))

    def test_device_layout_owns_tsx_poses(self) -> None:
        write(self.root / "scenes" / "02-hero.tsx", self.device_scene("placement={{ ...d.placement, position: [1, 0, 0], ground: true, scale: 0.8 }}"))
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "devices": [{"id": "d1", "model": "android"}]})
        self.assertEqual(messages(self.run_check(["scenes/02-hero.tsx"]), "warning"), [])
        write_json(self.root / "scenes" / "02-hero.json", {"version": 1, "devices": [{"id": "d1", "model": "android"}], "deviceLayout": {"preset": "row"}})
        warnings = messages(self.run_check(["scenes/02-hero.tsx"]), "warning")
        self.assertEqual(len(warnings), 2, warnings)
        self.assertIn("line 8 passes position to Device, but scenes/02-hero.json has a deviceLayout", warnings[0])
        self.assertIn("line 8 passes ground to Device", warnings[1])

    def test_catalog_lines_carry_screen_rects(self) -> None:
        from kblib import catalog

        rect = {"width": 3.307, "height": 2.1448, "centre": [0.0004, 0.17], "z": -0.7783, "cornerRadius": 0.0552, "frame": {"lidDeg": 90}}
        line = catalog.entry_line({"id": "macbook-pro-16", "label": "MacBook", "screen": rect})
        self.assertEqual(line, "macbook-pro-16 (MacBook) [screen 3.307 x 2.1448 at (0.0004, 0.17, -0.7783) r 0.0552 at lid 90]")
        self.assertEqual(catalog.entry_line({"id": "fade", "label": "Fade"}), "fade (Fade)")
