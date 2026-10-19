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
