"""kb's authored music: the sanitise and resolve mirrors, kb beats, the detach rule in kb doc, kb scene set timing and kb check's music rules."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Dict, List, Optional

from kblib import hookfast
from kblib.beats import model
from kblib.project import Project

from .helpers import KbTestCase, make_project, read_json, write_json
from .test_leases import SESSION, hook_payload

SONG = b"not really audio, a steady click"
DIGEST = hashlib.sha256(SONG).hexdigest()
GRID = {"bpm": 120, "offsetMs": 250, "beatsPerBar": 4}


def music(**over: Any) -> Dict[str, Any]:
    return dict({"grid": dict(GRID), "startOffsetMs": 0, "cues": {"drop": "bar:5"}, "sections": {}}, **over)


def camera(keys: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"keys": [dict(k, pose={"target": [0, 0, 0], "azimuthDeg": 0, "elevationDeg": 10, "distance": 6}) for k in keys],
            "segments": [{"from": keys[0]["id"], "to": keys[-1]["id"], "ease": "inOutQuad"}]}


def analysis(**fit: Any) -> Dict[str, Any]:
    body = {"bpm": 120.0, "offsetMs": 250.0, "beatsPerBar": 4, "periodMs": 500.0, "phaseMs": 250, "residualMs": 0.9, "maxDriftMs": 3, "constantTempo": True}
    body.update(fit)
    return {"version": 2, "sha256": DIGEST, "tracker": "nn", "durationMs": 60000, "fit": body,
            "beats": [{"ms": 250 + 500 * k, "bar": k // 4 + 1, "beat": k % 4 + 1, "conf": 0.9} for k in range(40)],
            "keyMoments": [{"tMs": 4250, "strength": 0.9}], "envelope": {"hopMs": 21.333, "values": []}}


class SanitiseMirrorTests(KbTestCase):
    """The cases of src/engine/projectMusic.test.ts, through the Python mirror."""

    def test_keeps_a_valid_grid_cues_and_sections(self) -> None:
        source = {"sha256": "x", "analysisVersion": 2, "tracker": "nn"}
        out, problems = model.sanitise_music({
            "file": "a.mp3", "grid": {"bpm": 135.11, "offsetMs": 101.7, "source": source},
            "cues": {"drop": "bar:9", "raw": 4000, "nudged": "bar:9-40ms"},
            "sections": [{"id": "chorus", "label": "Chorus", "from": "bar:17", "to": "bar:25"}],
        })
        self.assertEqual(problems, [])
        self.assertEqual(out, {
            "grid": {"bpm": 135.11, "offsetMs": 101.7, "beatsPerBar": 4, "source": source},
            "cues": {"drop": "bar:9", "raw": 4000, "nudged": "bar:9-40ms"},
            "sections": [{"id": "chorus", "label": "Chorus", "from": "bar:17", "to": "bar:25"}],
        })

    def test_drops_a_grid_with_a_bad_field(self) -> None:
        for grid in ({"bpm": 20, "offsetMs": 0}, {"bpm": 301, "offsetMs": 0}, {"bpm": math.nan, "offsetMs": 0}, {"bpm": 120, "offsetMs": math.inf},
                     {"bpm": 120, "offsetMs": 0, "beatsPerBar": 0}, {"bpm": 120, "offsetMs": 0, "beatsPerBar": 17},
                     {"bpm": 120, "offsetMs": 0, "beatsPerBar": 3.5}, "120", {"bpm": True, "offsetMs": 0}):
            out, problems = model.sanitise_music({"file": "a.mp3", "grid": grid})
            self.assertEqual(out, {}, grid)
            self.assertEqual(len(problems), 1, grid)
        out, _ = model.sanitise_music({"file": "a.mp3", "grid": {"bpm": 30, "offsetMs": -5, "beatsPerBar": 16}})
        self.assertEqual(out, {"grid": {"bpm": 30, "offsetMs": -5, "beatsPerBar": 16}})
        out, _ = model.sanitise_music({"file": "a.mp3", "grid": {"bpm": 120, "offsetMs": 0, "beatsPerBar": 3.0}})
        self.assertIs(type(out["grid"]["beatsPerBar"]), int)

    def test_drops_bad_cues(self) -> None:
        out, problems = model.sanitise_music({"file": "a.mp3", "grid": {"bpm": 120, "offsetMs": 0}, "cues": {
            "ok": "bar:2", "Bad": "bar:2", "loop": "cue:ok", "part": "section:intro", "wrong": "bar 2", "beat": "bar:2.5", "inf": math.inf, "flag": True,
        }})
        self.assertEqual(out["cues"], {"ok": "bar:2"})
        self.assertEqual(len(problems), 7)
        self.assertEqual(model.sanitise_music({"file": "a.mp3", "cues": {"drop": "bar:9"}})[0]["cues"], {"drop": "bar:9"})

    def test_sections_need_unique_ids_and_from_before_to(self) -> None:
        out, problems = model.sanitise_music({"file": "a.mp3", "grid": {"bpm": 120, "offsetMs": 0}, "sections": [
            {"id": "a", "from": "bar:1", "to": "bar:5"}, {"id": "a", "from": "bar:5", "to": "bar:9"}, {"id": "back", "from": "bar:9", "to": "bar:5"},
            {"id": "same", "from": 4000, "to": "bar:3"}, {"id": "ms", "from": 0, "to": 2000}, {"id": "nest", "from": "cue:x", "to": "bar:9"},
        ]})
        self.assertEqual([s["id"] for s in out["sections"]], ["a", "ms"])
        self.assertEqual(len(problems), 4)

    def test_project_music_is_the_resolvers_view(self) -> None:
        self.assertIsNone(model.project_music({"audio": {"file": "a.mp3", "gainDb": -3}}))
        self.assertIsNone(model.project_music({"audio": {"file": "a.mp3", "grid": {"bpm": 5, "offsetMs": 0}}}))
        self.assertEqual(model.project_music({"audio": {
            "file": "a.mp3", "startOffsetMs": 1500, "grid": {"bpm": 120, "offsetMs": 250}, "sections": [{"id": "outro", "from": "bar:9", "to": 30000}],
            "cues": {"loop": "cue:x"},
        }}), {"grid": {"bpm": 120, "offsetMs": 250, "beatsPerBar": 4}, "startOffsetMs": 1500, "cues": {}, "sections": {"outro": {"from": "bar:9", "to": 30000}}})


class TimelineMirrorTests(KbTestCase):
    def slots(self) -> List[Dict[str, Any]]:
        root = make_project(self.tmp)
        return model.slots_of(Project(root))

    def test_owner_follows_the_attribution_window_across_a_crossfade(self) -> None:
        slots = self.slots()
        # 3000 ms scenes, 600 ms crossfades: scene 1 starts at 2400, owns from 2700; scene 2 starts at 4800, owns from 5100.
        self.assertEqual([s["startMs"] for s in slots], [0, 2400, 4800])
        self.assertEqual([model.owner_index(slots, ms) for ms in (0, 2699, 2700, 5099, 5100, 7800, 9000)], [0, 0, 1, 1, 2, 2, 2])
        self.assertEqual(model.attribution_starts(slots), [0, 2700, 5100])
        self.assertTrue(model.in_slot(slots, 2, 3000))
        self.assertFalse(model.in_slot(slots, 0, 3000))

    def test_grid_beats_use_the_resolvers_order(self) -> None:
        m = {"grid": {"bpm": 135.11, "offsetMs": 447.5, "beatsPerBar": 4}, "startOffsetMs": 300, "cues": {}, "sections": {}}
        beats, bars = model.grid_beats(m, 10000)
        for bar, t in bars:
            self.assertEqual(t, model.resolve(f"bar:{bar}", m)["projectMs"])
        self.assertEqual(model.resolve("bar:1.2", m)["projectMs"], beats[1])
        self.assertEqual(model.nearest_beat(m, beats[5] + 30)["position"], "bar:2.2")
        self.assertIsNone(model.nearest_beat(None, 100))

    def test_downbeat_edits_mirror_the_app(self) -> None:
        authored = dict(GRID, source={"sha256": "sha", "analysisVersion": 2, "tracker": "nn", "residualMs": 0.9})
        self.assertEqual(model.downbeat_grid(authored, None, 4300, None), dict(authored, offsetMs=300))
        self.assertEqual(model.downbeat_grid(authored, None, 3200, None), dict(authored, offsetMs=1200))
        a = dict(analysis(), sha256="sha")
        self.assertEqual(model.downbeat_grid(None, a, 4300, None), dict(authored, offsetMs=300))
        self.assertIsNone(model.downbeat_grid(None, None, 4300, None))
        self.assertEqual(model.downbeat_grid(authored, None, 4300, 3)["offsetMs"], 300)
        self.assertEqual(model.downbeat_grid(authored, None, 4300, 1)["offsetMs"], 4300)
        self.assertEqual(model.detected_grid(a), authored)
        self.assertIsNone(model.detected_grid(dict(a, fit=dict(a["fit"], bpm=400))))

    def test_times_and_ranges(self) -> None:
        m = music()
        self.assertEqual(model.parse_time("12.5", m)["projectMs"], 12500)
        self.assertEqual(model.parse_time("12.5s", m)["projectMs"], 12500)
        self.assertEqual(model.parse_time("1200ms", m)["projectMs"], 1200)
        self.assertEqual(model.parse_time("bar:2", m)["projectMs"], 2250)
        with self.assertRaises(Exception) as caught:
            model.parse_time("bar:2", None)
        self.assertEqual(caught.exception.kind, "no-grid")  # type: ignore[attr-defined]
        self.assertEqual(model.expand_range("bars:2-4", m), ["bar:2", "bar:3", "bar:4"])
        self.assertEqual(model.expand_range("beats:2", m), ["bar:2", "bar:2.2", "bar:2.3", "bar:2.4"])
        self.assertIsNone(model.expand_range("bar:2", m))


class SettleTests(KbTestCase):
    def test_resolve_returns_the_same_doc_when_nothing_moves(self) -> None:
        doc = {"version": 1, "camera": camera([{"id": "k1", "tMs": 0}, {"id": "k2", "tMs": 8250, "at": "bar:5"}])}
        self.assertIs(model.refresh_doc(doc, music(), 0)[0], doc)
        plain = {"version": 1, "camera": camera([{"id": "k1", "tMs": 0}])}
        self.assertIs(model.refresh_doc(plain, None, 0)[0], plain)
        self.assertIs(model.settle_written(plain, plain, music(), 0)[0], plain)

    def test_every_timed_track_refreshes_in_scene_local_ms(self) -> None:
        doc = {
            "version": 1, "camera": camera([{"id": "k1", "tMs": 0}, {"id": "k2", "tMs": 1, "at": "bar:5"}]),
            "cameraRig": {"keys": [{"id": "r1", "tMs": 1, "at": "cue:drop", "pose": {"position": [0, 0, 5], "aim": {"mode": "point", "at": [0, 0, 0]}}}], "segments": []},
            "lighting": {"keys": [{"id": "l1", "tMs": 1, "at": "bar:2.3", "pose": {"ambient": 1}}]},
            "compare": {"b": {"lighting": {"keys": [{"id": "b1", "tMs": 1, "at": "bar:3", "pose": {}}]}}},
        }
        new, changes, issues = model.refresh_doc(doc, music(), 1000)
        self.assertEqual(issues, [])
        self.assertEqual([c["toMs"] for c in changes], [7250, 7250, 2250, 3250])
        self.assertEqual(new["cameraRig"]["keys"][0]["pose"]["aim"]["at"], [0, 0, 0])
        self.assertEqual(doc["camera"]["keys"][1]["tMs"], 1)

    def test_a_moved_key_drops_at_and_an_unresolvable_one_keeps_both(self) -> None:
        before = {"version": 1, "camera": camera([{"id": "k1", "tMs": 0, "at": "cue:gone"}, {"id": "k2", "tMs": 8250, "at": "bar:5"}, {"id": "k3", "tMs": 9, "at": "bar:6"}])}
        after = json.loads(json.dumps(before))
        after["camera"]["keys"][1]["tMs"] = 9000
        settled, notes = model.settle_written(before, after, music(), 0)
        keys = settled["camera"]["keys"]
        self.assertNotIn("at", keys[1])
        self.assertEqual(keys[1]["tMs"], 9000)
        self.assertEqual((keys[0]["tMs"], keys[0]["at"]), (0, "cue:gone"))
        self.assertEqual(keys[2]["tMs"], 10250)
        self.assertTrue(any("no longer follows" in n for n in notes))

    def test_a_stale_cache_on_disk_is_never_a_move(self) -> None:
        before = {"version": 1, "camera": camera([{"id": "k2", "tMs": 4000, "at": "bar:5"}])}
        settled, _ = model.settle_written(before, json.loads(json.dumps(before)), music(), 0)
        self.assertEqual(settled["camera"]["keys"][0], dict(before["camera"]["keys"][0], tMs=8250))
        moved_home = json.loads(json.dumps(before))
        moved_home["camera"]["keys"][0]["tMs"] = 8250
        settled, _ = model.settle_written(before, moved_home, music(), 0)
        self.assertEqual(settled["camera"]["keys"][0]["at"], "bar:5")

    def test_a_new_at_wins_over_its_tms(self) -> None:
        before = {"version": 1, "camera": camera([{"id": "k2", "tMs": 4000}])}
        after = json.loads(json.dumps(before))
        after["camera"]["keys"][0].update(tMs=5000, at="bar:5")
        settled, _ = model.settle_written(before, after, music(), 0)
        self.assertEqual((settled["camera"]["keys"][0]["tMs"], settled["camera"]["keys"][0]["at"]), (8250, "bar:5"))


class MusicProjectCase(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.env["KB_BEATS_CACHE_DIR"] = str(self.tmp / "beats-cache")
        self.root = make_project(self.tmp, audio={"file": "assets/track.mp3"})
        (self.root / "assets" / "track.mp3").write_bytes(SONG)
        write_json(self.root / "scenes" / "02-hero.json", {
            "version": 1, "name": "Hero", "text": {"title": "Hello"},
            "camera": camera([{"id": "k1", "tMs": 0}, {"id": "k2", "tMs": 1, "at": "bar:3"}]),
        })

    def j(self, *args: str, code: int = 0) -> Dict[str, Any]:
        proc = self.kb(list(args) + ["--json"], cwd=self.root)
        self.assertExit(proc, code)
        return json.loads(proc.stdout)

    def manifest(self) -> Dict[str, Any]:
        return read_json(self.root / "project.json")

    def keys(self, stem: str = "02-hero") -> List[Dict[str, Any]]:
        return read_json(self.root / "scenes" / f"{stem}.json")["camera"]["keys"]

    def write_analysis(self, body: Optional[Dict[str, Any]] = None) -> None:
        write_json(self.root / ".kb" / "song" / f"{DIGEST[:12]}.json", body or analysis())


class BeatsShowTests(MusicProjectCase):
    def test_no_soundtrack(self) -> None:
        root = make_project(self.tmp / "other")
        proc = self.kb(["beats"], cwd=root)
        self.assertExit(proc, 0)
        self.assertIn("no soundtrack", proc.stdout)

    def test_the_grid_bars_cues_and_sections_resolve_per_scene(self) -> None:
        self.assertExit(self.kb(["beats", "set-grid", "--bpm", "120", "--offset", "250"], cwd=self.root), 0)
        self.assertExit(self.kb(["beats", "cue", "set", "drop", "bar:3"], cwd=self.root), 0)
        data = self.j("beats")
        self.assertEqual(data["command"], "beats")
        self.assertEqual(data["grid"]["barMs"], 2000)
        self.assertEqual(data["beatSource"], "authored")
        self.assertEqual(data["scenes"][1]["bars"], [{"bar": 3, "localMs": 1850}])
        self.assertEqual(data["cues"], [{"id": "drop", "value": "bar:3", "projectMs": 4250, "scene": {"index": 1, "stem": "02-hero", "localMs": 1850}}])
        self.assertEqual(data["scenes"][1]["cues"], [{"id": "drop", "localMs": 1850}])
        text = self.kb(["beats", "--scene", "02-hero"], cwd=self.root)
        self.assertExit(text, 0)
        self.assertIn("bars: 3@1850", text.stdout)

    def test_the_analysis_stands_in_until_a_grid_is_authored(self) -> None:
        self.write_analysis()
        data = self.j("beats")
        self.assertIsNone(data["grid"])
        self.assertEqual((data["beatSource"], data["analysisVersion"], data["tracker"], data["bpm"]), ("detected", 2, "nn", 120.0))
        self.assertEqual(data["keyMoments"], [{"tMs": 4250, "strength": 0.9}])
        self.assertTrue(data["analysisPath"].endswith(f".kb/song/{DIGEST[:12]}.json"))

    def test_resolve(self) -> None:
        none = self.j("beats", "resolve", "bar:3", code=1)
        self.assertEqual(none["code"], "no-grid")
        self.assertEqual(none["hint"], "./kb song analyse, then ./kb beats set-grid --from-analysis")
        self.kb(["beats", "set-grid", "--bpm", "120", "--offset", "250"], cwd=self.root)
        r = self.j("beats", "resolve", "bar:3.2+40ms")
        self.assertEqual((r["projectMs"], r["owner"]), (4790, {"index": 1, "stem": "02-hero", "localMs": 2390}))
        r = self.j("beats", "resolve", "bar:3", "--scene", "2")
        self.assertEqual(r["scene"], {"index": 2, "stem": "03-outro", "localMs": -550, "inside": False})
        r = self.j("beats", "resolve", "2.6s")
        self.assertEqual((r["kind"], r["nearestBeat"]["position"]), ("seconds", "bar:2.2"))
        bad = self.j("beats", "resolve", "bar:3.9", code=2)
        self.assertEqual(bad["code"], "usage")


class BeatsWriteTests(MusicProjectCase):
    def test_set_grid_writes_the_manifest_and_moved_caches_in_one_transaction(self) -> None:
        dry = self.j("beats", "set-grid", "--bpm", "120", "--offset", "250", "--dry-run")
        self.assertEqual(sorted(w["path"] for w in dry["writes"]), ["project.json", "scenes/02-hero.json"])
        self.assertNotIn("grid", self.manifest()["audio"])
        out = self.j("beats", "set-grid", "--bpm", "120.00049", "--offset", "250")
        self.assertEqual(self.manifest()["audio"]["grid"], {"bpm": 120, "offsetMs": 250, "beatsPerBar": 4})
        self.assertEqual(out["moved"][0]["keys"], [{"track": "camera", "id": "k2", "at": "bar:3", "fromMs": 1, "toMs": 1850}])
        self.assertEqual(self.keys()[1], dict(self.keys()[1], tMs=1850, at="bar:3"))
        self.assertEqual(self.j("beats", "set-grid", "--bpm", "500", "--offset", "0", code=1)["code"], "invalid")
        self.assertEqual(self.j("beats", "set-grid", "--bpm", "120", code=2)["code"], "usage")

    def test_from_analysis_records_the_source_and_refuses_a_drifting_tempo(self) -> None:
        missing = self.j("beats", "set-grid", "--from-analysis", code=1)
        self.assertEqual(missing["hint"], "./kb song analyse --accept")
        self.write_analysis(analysis(constantTempo=False, residualMs=24.5))
        drift = self.j("beats", "set-grid", "--from-analysis", code=1)
        self.assertIn("drifts", drift["error"])
        self.assertIn("--force", drift["hint"])
        self.j("beats", "set-grid", "--from-analysis", "--force")
        self.assertEqual(self.manifest()["audio"]["grid"], {
            "bpm": 120, "offsetMs": 250, "beatsPerBar": 4, "source": {"sha256": DIGEST, "analysisVersion": 2, "tracker": "nn", "residualMs": 24.5}})

    def test_set_downbeat_keeps_the_tempo(self) -> None:
        none = self.j("beats", "set-downbeat", "4.3", code=1)
        self.assertEqual(none["code"], "no-grid")
        self.write_analysis()
        self.j("beats", "set-downbeat", "4300ms")
        grid = self.manifest()["audio"]["grid"]
        self.assertEqual((grid["bpm"], grid["offsetMs"], grid["source"]["tracker"]), (120, 300, "nn"))
        self.j("beats", "set-downbeat", "bar:2", "--bar", "1")
        self.assertEqual(self.manifest()["audio"]["grid"]["offsetMs"], 2300)
        self.assertEqual(self.keys()[1]["tMs"], 3900)

    def test_clear_grid_keeps_the_last_tms(self) -> None:
        self.kb(["beats", "set-grid", "--bpm", "120", "--offset", "250"], cwd=self.root)
        out = self.j("beats", "clear-grid")
        self.assertNotIn("grid", self.manifest()["audio"])
        self.assertEqual(self.keys()[1], dict(self.keys()[1], tMs=1850, at="bar:3"))
        self.assertTrue(any("keep their last tMs" in n for n in out["notes"]))

    def test_cues_and_sections_validate_like_the_app(self) -> None:
        self.kb(["beats", "set-grid", "--bpm", "120", "--offset", "250"], cwd=self.root)
        self.assertEqual(self.j("beats", "cue", "set", "Drop", "bar:3", code=1)["code"], "invalid")
        self.assertEqual(self.j("beats", "cue", "set", "loop", "cue:drop", code=1)["code"], "invalid")
        self.assertEqual(self.j("beats", "cue", "set", "drop", "nonsense", code=2)["code"], "usage")
        self.j("beats", "cue", "set", "flash", "4.5s")
        self.j("beats", "cue", "set", "drop", "bar:3")
        self.assertEqual(self.manifest()["audio"]["cues"], {"flash": 4500, "drop": "bar:3"})
        write_json(self.root / "scenes" / "03-outro.json", {"version": 1, "lighting": {"keys": [{"id": "l1", "tMs": 0, "at": "cue:drop+100ms", "pose": {}}]}})
        out = self.j("beats", "cue", "set", "drop", "bar:4")
        self.assertEqual(read_json(self.root / "scenes" / "03-outro.json")["lighting"]["keys"][0]["tMs"], 1550)
        self.assertEqual([m["file"] for m in out["moved"]], ["scenes/03-outro.json"])
        rm = self.j("beats", "cue", "rm", "drop")
        self.assertIn("cue:drop", rm["notes"][0])
        self.assertEqual(self.j("beats", "cue", "rm", "drop", code=1)["code"], "invalid")
        self.assertEqual(self.j("beats", "section", "set", "back", "--from", "bar:5", "--to", "bar:3", code=1)["code"], "invalid")
        self.j("beats", "section", "set", "chorus", "--from", "bar:2", "--to", "bar:4", "--label", "Chorus")
        self.j("beats", "section", "set", "chorus", "--from", "bar:2", "--to", "8s")
        self.assertEqual(self.manifest()["audio"]["sections"], [{"id": "chorus", "label": "Chorus", "from": "bar:2", "to": 8000}])
        self.j("beats", "section", "rm", "chorus")
        self.assertNotIn("sections", self.manifest()["audio"])

    def test_no_soundtrack_refuses_writes(self) -> None:
        root = make_project(self.tmp / "silent")
        proc = self.kb(["beats", "set-grid", "--bpm", "120", "--offset", "0", "--json"], cwd=root)
        self.assertExit(proc, 1)
        self.assertIn("no soundtrack", json.loads(proc.stdout)["error"])

    def test_a_sidecar_leased_to_someone_else_keeps_its_cache(self) -> None:
        self.env.update({"CLAUDE_PROJECT_DIR": str(self.root), "CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": SESSION, "TMPDIR": str(self.tmp)})

        def as_agent(agent: str, name: str, args: List[str]) -> Any:
            body = hook_payload("PreToolUse", agent=agent, cwd=str(self.root), tool_name="Bash", tool_input={"command": "./kb " + " ".join(args + ["--agent", name])})
            self.assertExit(self.kb(["hook", "bash-pre"], cwd=self.root, stdin=body), 0)
            return self.kb(args + ["--agent", name], cwd=self.root)

        self.assertExit(as_agent("b2", "beta", ["lease", "02-hero"]), 0)
        proc = as_agent("a1", "alpha", ["beats", "set-grid", "--bpm", "120", "--offset", "250", "--json"])
        self.assertExit(proc, 0)
        out = json.loads(proc.stdout)
        self.assertEqual(out["moved"], [])
        self.assertIn("leased to beta", out["notes"][0])
        self.assertEqual(self.keys()[1]["tMs"], 1)


class DocDetachTests(MusicProjectCase):
    def setUp(self) -> None:
        super().setUp()
        self.kb(["beats", "set-grid", "--bpm", "120", "--offset", "250"], cwd=self.root)

    def test_moving_a_keys_tms_drops_its_at(self) -> None:
        out = self.j("doc", "02-hero", "set", "camera.keys.1.tMs", "900")
        self.assertEqual(self.keys()[1]["tMs"], 900)
        self.assertNotIn("at", self.keys()[1])
        self.assertIn("no longer follows", out["summary"])

    def test_setting_at_refreshes_tms_and_other_writes_refresh_the_rest(self) -> None:
        self.j("doc", "02-hero", "set", "camera.keys.0.at", "bar:2")
        self.assertEqual(self.keys()[0]["tMs"], -150)
        doc = read_json(self.root / "scenes" / "02-hero.json")
        doc["camera"]["keys"][1]["tMs"] = 7
        write_json(self.root / "scenes" / "02-hero.json", doc)
        self.j("doc", "02-hero", "set", "name", "Hero two")
        self.assertEqual(self.keys()[1]["tMs"], 1850)
        merged = self.j("doc", "02-hero", "merge", json.dumps({"camera": camera([{"id": "k1", "tMs": 0}, {"id": "k2", "tMs": 1850, "at": "bar:4"}])}))
        self.assertEqual(self.keys()[1]["tMs"], 3850, merged)

    def test_a_sidecar_without_at_is_written_exactly_as_before(self) -> None:
        write_json(self.root / "scenes" / "01-intro.json", {"version": 1, "camera": camera([{"id": "k1", "tMs": 0}, {"id": "k2", "tMs": 50}])})
        self.j("doc", "01-intro", "set", "camera.keys.1.tMs", "75")
        self.assertEqual(read_json(self.root / "scenes" / "01-intro.json")["camera"]["keys"][1], dict(camera([{"id": "k2", "tMs": 75}])["keys"][0]))


class SceneTimingTests(MusicProjectCase):
    def setUp(self) -> None:
        super().setUp()
        self.kb(["beats", "set-grid", "--bpm", "120", "--offset", "250"], cwd=self.root)

    def durations(self) -> List[int]:
        return [s["durationMs"] for s in self.manifest()["scenes"]]

    def test_duration_bars(self) -> None:
        out = self.j("scene", "set", "1", "--duration-bars", "2.5")
        self.assertEqual(self.durations()[1], 5000)
        self.assertIn("2.5 bars", out["changes"][0])
        self.assertEqual(self.j("scene", "set", "1", "--duration-bars", "0", code=2)["code"], "usage")

    def test_cut_at_end_and_mid_and_the_caches_that_follow(self) -> None:
        # Scene 0 starts at 0 and crossfades 600 ms into scene 1; bar:3 is 4250 ms into the film.
        self.j("scene", "set", "0", "--cut-at", "bar:3")
        self.assertEqual(self.durations()[0], 4250)
        out = self.j("scene", "set", "0", "--cut-at", "bar:3", "--align", "mid")
        self.assertEqual(self.durations()[0], 4550)
        self.assertEqual(self.keys()[1]["tMs"], 300)
        self.assertTrue(any("refreshed tMs caches" in c for c in out["changes"]))
        self.assertEqual(self.j("scene", "set", "0", "--cut-at", "bar:0", code=1)["code"], "invalid")
        self.assertEqual(self.j("scene", "set", "0", "--cut-at", "bar:3", "--duration", "4000", code=2)["code"], "usage")
        self.assertEqual(self.j("scene", "set", "0", "--align", "mid", code=2)["code"], "usage")

    def test_no_grid_is_exit_1(self) -> None:
        self.kb(["beats", "clear-grid"], cwd=self.root)
        out = self.j("scene", "set", "1", "--duration-bars", "4", code=1)
        self.assertEqual(out["code"], "no-grid")


class MusicCheckTests(MusicProjectCase):
    def issues(self) -> List[Dict[str, Any]]:
        proc = self.kb(["check", "--json"], cwd=self.root)
        return json.loads(proc.stdout)["issues"]

    def test_what_the_app_drops_is_an_error(self) -> None:
        m = self.manifest()
        m["audio"].update(grid={"bpm": 500, "offsetMs": 0}, cues={"loop": "cue:x"})
        write_json(self.root / "project.json", m)
        found = {(i["path"], i["severity"]) for i in self.issues()}
        self.assertIn(("audio.grid.bpm", "error"), found)
        self.assertIn(("audio.cues.loop", "error"), found)

    def test_positions_that_cannot_resolve_and_stale_caches(self) -> None:
        write_json(self.root / "scenes" / "03-outro.json", {
            "version": 1, "camera": camera([{"id": "k1", "tMs": 0, "at": "bar 3"}, {"id": "k2", "tMs": 5, "at": "cue:nope"}]),
            "cameraKicks": [{"at": "bar:2", "releaseMs": 300}],
        })
        found = {(i["file"], i["path"], i["severity"]) for i in self.issues()}
        self.assertIn(("scenes/03-outro.json", "camera.keys[0].at", "error"), found)
        self.assertIn(("scenes/03-outro.json", "camera.keys[1].at", "warning"), found)
        self.assertIn(("scenes/03-outro.json", "cameraKicks[0].at", "warning"), found)
        self.assertIn(("scenes/02-hero.json", "camera.keys[1].at", "warning"), found)
        self.kb(["beats", "set-grid", "--bpm", "120", "--offset", "250"], cwd=self.root)
        doc = read_json(self.root / "scenes" / "02-hero.json")
        doc["camera"]["keys"][1]["tMs"] = 1700
        write_json(self.root / "scenes" / "02-hero.json", doc)
        stale = [i for i in self.issues() if i["path"] == "camera.keys[1].tMs"]
        self.assertEqual(stale[0]["severity"], "warning")
        self.assertIn("the app rewrites it on load", stale[0]["message"])
        self.assertIn("./kb doc 02-hero unset camera.keys.1.at", stale[0]["message"])

    def test_a_grid_fitted_to_another_file_warns(self) -> None:
        self.write_analysis()
        self.kb(["beats", "set-grid", "--from-analysis"], cwd=self.root)
        self.assertFalse([i for i in self.issues() if "another file" in i["message"]])
        (self.root / "assets" / "track.mp3").write_bytes(SONG + b" remastered")
        found = [i for i in self.issues() if i["path"] == "audio.grid.source.sha256"]
        self.assertEqual(found[0]["severity"], "warning")


class HelpAndPlanTests(MusicProjectCase):
    def test_every_new_command_has_help(self) -> None:
        for cmd in (["beats"], ["beats", "set-grid"], ["beats", "set-downbeat"], ["beats", "cue", "set"], ["beats", "section", "set"],
                    ["beats", "resolve"], ["song"], ["song", "analyse"]):
            proc = self.kb(cmd + ["--help"], cwd=self.root)
            self.assertExit(proc, 0)
            self.assertIn("usage: kb", proc.stdout)

    def test_plan_reports_a_musical_scene_set(self) -> None:
        self.kb(["beats", "set-grid", "--bpm", "120", "--offset", "250"], cwd=self.root)
        before = (self.root / "project.json").read_bytes()
        plan = self.j("plan", "scene", "set", "0", "--cut-at", "bar:3", "--align", "mid")
        self.assertEqual(sorted(w["path"] for w in plan["writes"]), ["project.json", "scenes/02-hero.json"])
        self.assertEqual((self.root / "project.json").read_bytes(), before)


class HookTests(KbTestCase):
    def test_beats_writes_take_the_session_checkpoint(self) -> None:
        for cmd in ("./kb beats set-grid --from-analysis", "./kb beats cue set drop bar:3", "./kb beats section rm x",
                    "./kb beats clear-grid", "./kb song analyse --accept"):
            self.assertTrue(hookfast.KB_WRITE.search(cmd), cmd)
        for cmd in ("./kb beats", "./kb beats resolve bar:3", "./kb song analyse"):
            self.assertFalse(hookfast.KB_WRITE.search(cmd), cmd)


if __name__ == "__main__":
    import unittest

    unittest.main()
