from __future__ import annotations

import copy

from kblib import scenes, tsx

from .helpers import PNG_1x1, SCENE_TSX, KbTestCase, make_project, make_resources, read_json, write, write_json


class RemintTests(KbTestCase):
    def test_remint_matches_the_rust_rules(self) -> None:
        doc = {
            "version": 1,
            "devices": [{"id": "phoneA", "model": "android"}, {"id": "phoneB", "model": "android"}],
            "duration": {"mode": "follow-media", "sourceDeviceId": "phoneB"},
            "deviceLayout": {"preset": "row", "devices": {"phoneB": {"scale": 2}, "phoneA": {"scale": 1}}},
            "deviceTrack": {"keys": [{"id": "x", "tMs": 0, "pose": {"phoneA": {"scale": 1}}}, {"id": "y", "tMs": 5, "pose": {"phoneB": {}}}], "segments": [{"from": "x", "to": "y", "ease": "linear"}]},
            "cameraRig": {"keys": [{"id": "r", "tMs": 0, "pose": {"aim": {"mode": "object", "id": "phoneB"}}}], "segments": []},
            "camera": {"keys": [{"id": "c7", "tMs": 0}, {"id": "c9", "tMs": 9}], "segments": [{"from": "c7", "to": "c9", "ease": "jump"}]},
            "chart": {"type": "column", "data": {"categories": ["a"], "series": [{"id": "rev", "values": [1]}]}, "track": {"keys": [{"id": "q", "tMs": 0}], "segments": []}},
            "frame": {"decorations": [{"id": "logo"}, {"id": "badge"}]},
            "media": [{"id": "keep-me", "src": "assets/a.png"}],
            "compare": {"b": {"media": {"phoneA": {"src": "assets/b.png"}}, "deviceAppearance": {"phoneB": {"colour": "silver"}}}},
            "layeredScreenshot": {"layers": [{"id": "L", "items": [{"id": "it1"}, {"id": "it2", "attach": {"to": "it1"}}]}], "animation": {"keys": [{"id": "z", "tMs": 0}], "segments": []}},
            "text": {"ls-it1": "One", "title": "T"},
            "textStyle": {"ls-it2Color": "#fff", "titleSize": 1},
        }
        out = copy.deepcopy(doc)
        scenes.remint_scene_doc_ids(out)
        self.assertEqual([d["id"] for d in out["devices"]], ["d1", "d2"])
        self.assertEqual(out["duration"]["sourceDeviceId"], "d2")
        self.assertEqual(set(out["deviceLayout"]["devices"]), {"d1", "d2"})
        self.assertEqual(out["deviceLayout"]["devices"]["d2"], {"scale": 2})
        self.assertEqual([k["id"] for k in out["deviceTrack"]["keys"]], ["k1", "k2"])
        self.assertEqual(out["deviceTrack"]["keys"][0]["pose"], {"d1": {"scale": 1}})
        self.assertEqual(out["deviceTrack"]["segments"][0], {"from": "k1", "to": "k2", "ease": "linear"})
        self.assertEqual(out["cameraRig"]["keys"][0]["pose"]["aim"]["id"], "d2")
        self.assertEqual(out["camera"]["segments"][0]["from"], "k1")
        self.assertEqual(out["chart"]["data"]["series"][0]["id"], "s1")
        self.assertEqual(out["chart"]["track"]["keys"][0]["id"], "k1")
        self.assertEqual([d["id"] for d in out["frame"]["decorations"]], ["dec1", "dec2"])
        self.assertEqual(out["media"][0]["id"], "keep-me")
        self.assertEqual(list(out["compare"]["b"]["media"]), ["d1"])
        self.assertEqual(list(out["compare"]["b"]["deviceAppearance"]), ["d2"])
        layer = out["layeredScreenshot"]["layers"][0]
        self.assertEqual(layer["id"], "l1")
        self.assertEqual([i["id"] for i in layer["items"]], ["i1", "i2"])
        self.assertEqual(layer["items"][1]["attach"]["to"], "i1")
        self.assertIn("ls-i1", out["text"])
        self.assertIn("ls-i2Color", out["textStyle"])
        self.assertEqual(out["layeredScreenshot"]["animation"]["keys"][0]["id"], "k1")

    def test_preset_context_inherits_background_and_frame_icon(self) -> None:
        manifest = {"appliedBackground": {"background": {"type": "color", "color": "#000000"}}, "frame": {"cutout": {"shape": "rounded-rect"}, "icon": "🚀"}}
        doc = {"version": 1, "managedText": {"items": [{"key": "title", "type": "title", "text": "x"}]}}
        out = scenes.inherit_preset_context(doc, manifest)
        self.assertEqual(out["background"]["type"], "color")
        self.assertEqual(out["managedText"]["items"][0], {"key": "frameIcon", "type": "icon", "icon": "🚀"})
        self.assertIsNotNone(scenes.inherit_preset_context(None, manifest))
        kept = scenes.inherit_preset_context({"version": 1, "backdrop": {"type": "none"}}, manifest)
        self.assertNotIn("background", kept)

    def test_seed_and_migrate(self) -> None:
        rows = [{"file": "a"}, {"file": "b"}]
        scenes.seed_inserted_scene_transitions(rows, 1, {"type": "crossfade", "durationMs": 600})
        self.assertEqual(rows[0]["transition"]["type"], "crossfade")
        legacy = {"scenes": [{"file": "a"}, {"file": "b", "transition": {"type": "dip"}}, {"file": "c"}]}
        scenes.migrate_manifest_transitions(legacy)
        self.assertEqual(legacy["version"], 2)
        self.assertEqual(legacy["scenes"][0]["transition"]["type"], "dip")
        self.assertNotIn("transition", legacy["scenes"][1])
        self.assertIsNone(scenes.project_default_transition({"defaultTransition": None}))
        self.assertEqual(scenes.project_default_transition({})["type"], "crossfade")


class SceneCommandTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)

    def manifest(self):
        return read_json(self.root / "project.json")

    def files(self):
        return [s["file"] for s in self.manifest()["scenes"]]

    def test_add_blank_numbers_and_registers(self) -> None:
        proc = self.kb(["scene", "add", "pricing plans", "--after", "01-intro", "--duration", "4000"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertEqual(self.files()[1], "scenes/04-pricing-plans.tsx")
        entry = self.manifest()["scenes"][1]
        self.assertEqual(entry["durationMs"], 4000)
        self.assertEqual(entry["transition"]["type"], "crossfade")
        text = (self.root / "scenes" / "04-pricing-plans.tsx").read_text()
        self.assertEqual(tsx.scene_id(text), "pricing-plans")
        doc = read_json(self.root / "scenes" / "04-pricing-plans.json")
        self.assertEqual(doc["name"], "Pricing plans")
        self.assertExit(self.kb(["check"], cwd=self.root), 0)

    def test_add_keeps_a_free_numbered_stem_and_mints_unique_ids(self) -> None:
        write(self.root / "scenes" / "notes.txt", "x")
        self.assertExit(self.kb(["scene", "add", "20-intro"], cwd=self.root), 0)
        self.assertEqual(self.files()[-1], "scenes/20-intro.tsx")
        self.assertEqual(tsx.scene_id((self.root / "scenes" / "20-intro.tsx").read_text()), "intro-2")
        self.assertEqual(self.manifest()["scenes"][-2]["transition"]["type"], "crossfade")

    def test_add_registers_an_existing_unregistered_file(self) -> None:
        write(self.root / "scenes" / "05-custom.tsx", SCENE_TSX.format(id="intro"))
        proc = self.kb(["scene", "add", "05-custom", "--at", "0"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("registered the existing", proc.stdout)
        self.assertEqual(self.files()[0], "scenes/05-custom.tsx")
        self.assertEqual(tsx.scene_id((self.root / "scenes" / "05-custom.tsx").read_text()), "custom")
        again = self.kb(["scene", "add", "05-custom"], cwd=self.root)
        self.assertExit(again, 1)
        self.assertIn("already scene 0", again.stderr)

    def test_duplicate_mirrors_the_app(self) -> None:
        doc = read_json(self.root / "scenes" / "02-hero.json")
        doc["devices"] = [{"id": "x", "model": "android"}]
        write_json(self.root / "scenes" / "02-hero.json", doc)
        self.assertExit(self.kb(["scene", "duplicate", "02-hero"], cwd=self.root), 0)
        files = self.files()
        self.assertEqual(files[2], "scenes/04-hero-copy.tsx")
        self.assertEqual(self.manifest()["scenes"][2]["transition"], self.manifest()["scenes"][1]["transition"])
        copy_doc = read_json(self.root / "scenes" / "04-hero-copy.json")
        self.assertEqual(copy_doc["name"], "Hero copy")
        self.assertEqual(copy_doc["devices"][0]["id"], "d1")
        self.assertEqual(tsx.scene_id((self.root / "scenes" / "04-hero-copy.tsx").read_text()), "hero-copy")

    def test_copy_with_a_chosen_stem(self) -> None:
        self.assertExit(self.kb(["scene", "add", "recap", "--copy", "1", "--name", "Recap"], cwd=self.root), 0)
        self.assertEqual(self.files()[-1], "scenes/04-recap.tsx")
        self.assertEqual(read_json(self.root / "scenes" / "04-recap.json")["name"], "Recap")

    def test_move_and_remove(self) -> None:
        self.assertExit(self.kb(["scene", "move", "03-outro", "--to", "0"], cwd=self.root), 0)
        self.assertEqual(self.files()[0], "scenes/03-outro.tsx")
        self.assertExit(self.kb(["scene", "move", "03-outro", "--after", "02-hero"], cwd=self.root), 0)
        self.assertEqual(self.files()[-1], "scenes/03-outro.tsx")
        proc = self.kb(["scene", "remove", "02-hero"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertNotIn("scenes/02-hero.tsx", self.files())
        self.assertFalse((self.root / "scenes" / "02-hero.tsx").exists())
        self.assertTrue((self.trash / "02-hero.tsx").exists())
        self.assertTrue((self.trash / "02-hero.json").exists())

    def test_remove_refuses_the_last_scene_and_trash_names_are_unique(self) -> None:
        root = make_project(self.tmp / "solo", scenes=["01-only"])
        self.assertExit(self.kb(["scene", "remove", "0"], cwd=root), 1)
        self.trash.mkdir(parents=True)
        (self.trash / "02-hero.tsx").write_text("older")
        self.assertExit(self.kb(["scene", "remove", "1"], cwd=self.root), 0)
        self.assertTrue((self.trash / "02-hero 2.tsx").exists())

    def test_set_duration_transition_ease_name(self) -> None:
        self.assertExit(self.kb(["scene", "set", "0", "--duration", "4500", "--transition", "glasssweep:700", "--ease", "smooth", "--name", "Opening"], cwd=self.root), 0)
        entry = self.manifest()["scenes"][0]
        self.assertEqual(entry["durationMs"], 4500)
        self.assertEqual(entry["transition"], {"type": "glasssweep", "durationMs": 700, "ease": "smooth"})
        self.assertEqual(read_json(self.root / "scenes" / "01-intro.json")["name"], "Opening")
        self.assertExit(self.kb(["scene", "set", "0", "--transition", "none"], cwd=self.root), 0)
        self.assertNotIn("transition", self.manifest()["scenes"][0])
        last = self.kb(["scene", "set", "2", "--transition", "dip"], cwd=self.root)
        self.assertExit(last, 1)
        self.assertIn("last scene", last.stderr)
        typo = self.kb(["scene", "set", "0", "--transition", "crosfade"], cwd=self.root)
        self.assertExit(typo, 2)
        self.assertIn("crossfade", typo.stderr)

    def test_unknown_scene_selector(self) -> None:
        proc = self.kb(["scene", "duplicate", "hero"], cwd=self.root)
        self.assertExit(proc, 1)
        self.assertIn("02-hero", proc.stderr)
        self.assertExit(self.kb(["scene", "remove", "9"], cwd=self.root), 1)

    def test_scene_ops_migrate_legacy_manifests(self) -> None:
        m = self.manifest()
        del m["version"]
        m["scenes"][0].pop("transition")
        m["scenes"][1]["transition"] = {"type": "dip", "durationMs": 300}
        m["scenes"][2]["transition"] = {"type": "wipe", "durationMs": 300}
        write_json(self.root / "project.json", m)
        self.assertExit(self.kb(["scene", "set", "0", "--duration", "3100"], cwd=self.root), 0)
        out = self.manifest()
        self.assertEqual(out["version"], 2)
        self.assertEqual(out["scenes"][0]["transition"]["type"], "dip")
        self.assertEqual(out["scenes"][1]["transition"]["type"], "wipe")
        self.assertNotIn("transition", out["scenes"][2])


class PresetOfflineTests(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp, appliedBackground={"background": {"type": "color", "color": "#101418"}})
        self.res = make_resources(self.tmp)
        self.env["KB_RESOURCES_DIR"] = str(self.res)

    def test_presets_list_and_show(self) -> None:
        proc = self.kb(["presets"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("title", proc.stdout)
        self.assertIn(str(self.res / "preset-previews" / "title.jpg"), proc.stdout)
        shown = self.kb(["presets", "show", "title"], cwd=self.root)
        self.assertExit(shown, 0)
        self.assertIn("A title on the theme background", shown.stdout)
        self.assertExit(self.kb(["presets", "show", "titel"], cwd=self.root), 1)

    def test_offline_insert_copies_assets_and_mints_ids(self) -> None:
        proc = self.kb(["scene", "add", "--preset", "title", "--at", "1"], cwd=self.root)
        self.assertExit(proc, 0)
        self.assertIn("copied from the app bundle", proc.stdout)
        manifest = read_json(self.root / "project.json")
        entry = manifest["scenes"][1]
        self.assertEqual(entry["file"], "scenes/04-title.tsx")
        self.assertEqual(entry["durationMs"], 2500)
        self.assertEqual(entry["transition"]["type"], "crossfade")
        text = (self.root / "scenes" / "04-title.tsx").read_text()
        self.assertEqual(tsx.scene_id(text), "title")
        self.assertIn('"assets/logo-2.png"', text)
        self.assertEqual((self.root / "assets" / "logo.png").read_bytes(), PNG_1x1)
        self.assertTrue((self.root / "assets" / "logo-2.png").read_bytes().endswith(b"preset"))
        self.assertTrue((self.root / "assets" / "sample-shot.png").is_file())
        doc = read_json(self.root / "scenes" / "04-title.json")
        self.assertEqual(doc["headerIcon"], "assets/logo-2.png")
        self.assertEqual(doc["devices"][0]["id"], "d1")
        self.assertEqual(doc["deviceTrack"]["keys"][1]["pose"], {"d1": {"scale": 1.2}})
        self.assertEqual(doc["deviceTrack"]["segments"][0], {"from": "k1", "to": "k2", "ease": "inOutQuad"})
        self.assertEqual(doc["background"], {"type": "color", "color": "#101418"})
        self.assertExit(self.kb(["check"], cwd=self.root), 0)

    def test_second_insert_reuses_identical_assets(self) -> None:
        self.assertExit(self.kb(["scene", "add", "first", "--preset", "title"], cwd=self.root), 0)
        self.assertExit(self.kb(["scene", "add", "second", "--preset", "title", "--name", "Second"], cwd=self.root), 0)
        self.assertFalse((self.root / "assets" / "sample-shot-2.png").exists())
        self.assertTrue((self.root / "assets" / "logo-3.png").exists())
        doc = read_json(self.root / "scenes" / "05-second.json")
        self.assertEqual(doc["name"], "Second")
        self.assertEqual(tsx.scene_id((self.root / "scenes" / "05-second.tsx").read_text()), "second")

    def test_missing_preset_folder_is_an_environment_error(self) -> None:
        self.env["KB_RESOURCES_DIR"] = str(self.tmp / "Nowhere")
        proc = self.kb(["scene", "add", "x", "--preset", "title"], cwd=self.root)
        self.assertExit(proc, 2)
        self.assertIn("no folder on disk", proc.stderr)
