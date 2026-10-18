from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from typing import Any, Dict, List

from kblib import events, identity
from kblib.project import Project

from .helpers import KB, FakeApp, KbTestCase, make_project, python_argv, write

SESSION = "sess-events-01"


def lines(text: str) -> List[Dict[str, Any]]:
    return [json.loads(x) for x in text.splitlines() if x.strip()]


class EventCase(KbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = make_project(self.tmp)
        self.project = Project(self.root)
        self.env.update({"CLAUDE_PROJECT_DIR": str(self.root), "CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": SESSION, "TMPDIR": str(self.tmp)})
        self.alpha = identity.Caller("alpha", SESSION, None)
        self.beta = identity.Caller("beta", SESSION, None)

    def journal(self) -> List[Dict[str, Any]]:
        return lines((self.root / ".kb" / "events.jsonl").read_text())


class JournalTests(EventCase):
    def test_append_writes_one_compact_line_per_event(self) -> None:
        first = events.append(self.project, "lease.taken", self.alpha, scene="02-hero")
        events.journal(self.project, "files.changed", self.beta, [f"scenes/{i:03d}-a-long-scene-name.tsx" for i in range(300)], via="kb")
        raw = (self.root / ".kb" / "events.jsonl").read_bytes().splitlines()
        self.assertEqual(len(raw), 2)
        self.assertTrue(all(len(x) < events.LINE_MAX for x in raw))
        self.assertNotIn(b": ", raw[0])
        got = self.journal()
        self.assertEqual(got[0], first)
        self.assertTrue(set(got[0]) >= {"v", "id", "atMs", "kind", "by"})
        self.assertEqual(got[0]["by"], {"name": "alpha", "session": SESSION, "agentId": None})
        self.assertRegex(got[0]["id"], rf"^{got[0]['atMs']}-{os.getpid()}-[0-9a-f]{{6}}$")
        self.assertEqual((len(got[1]["files"]), got[1]["filesMore"], got[1]["via"]), (8, 292, "kb"))
        self.assertEqual((self.root / ".kb" / ".gitignore").read_text(), "*\n")

    def test_kb_writes_journal_files_changed(self) -> None:
        self.assertExit(self.kb(["doc", "02-hero", "set", "name", "X", "--agent", "alpha"], cwd=self.root), 0)
        changed = self.journal()[-1]
        self.assertEqual((changed["kind"], changed["files"], changed["via"], changed["by"]["name"]), ("files.changed", ["scenes/02-hero.json"], "kb", "alpha"))

    def test_rotation_keeps_one_old_file_and_reads_across_it(self) -> None:
        path = self.root / ".kb" / "events.jsonl"
        events.append(self.project, "note", self.alpha, text="first")
        old_cursor = events.cursor(str(self.root))
        while not (self.root / ".kb" / "events.1.jsonl").exists():
            events.append(self.project, "note", self.alpha, text="x" * 3000)
        events.append(self.project, "note", self.alpha, text="after the rotation")
        self.assertTrue((self.root / ".kb" / "events.1.jsonl").exists())
        self.assertLess(path.stat().st_size, 10_000)
        found, _cursor = events.read_since(str(self.root), ("all", None))
        self.assertEqual(found[0]["text"], "first")
        self.assertEqual(found[-1]["text"], "after the rotation")
        resumed, _cursor = events.read_since(str(self.root), events.parse_since(old_cursor))
        self.assertEqual(resumed[-1]["text"], "after the rotation")
        self.assertNotEqual(resumed[0]["text"], "first")

    def test_cursor_resume_and_the_default_filters(self) -> None:
        events.append(self.project, "lease.taken", self.alpha, scene="02-hero")
        events.append(self.project, "note", self.beta, text="mine")
        events.journal(self.project, "files.changed", self.alpha, ["scenes/02-hero.json"])
        first = json.loads(self.kb(["events", "--since", "all", "--json", "--agent", "beta"], cwd=self.root).stdout)
        self.assertEqual([e["kind"] for e in first["events"]], ["lease.taken"])
        everyone = json.loads(self.kb(["events", "--since", "all", "--all-agents", "--kinds", "note,files", "--json", "--agent", "beta"], cwd=self.root).stdout)
        self.assertEqual([e["kind"] for e in everyone["events"]], ["note", "files.changed"])
        events.append(self.project, "lease.released", self.alpha, scene="02-hero")
        since = json.loads(self.kb(["events", "--since", first["cursor"], "--json", "--agent", "beta"], cwd=self.root).stdout)
        self.assertEqual([e["kind"] for e in since["events"]], ["lease.released"])
        again = json.loads(self.kb(["events", "--json", "--agent", "beta"], cwd=self.root).stdout)
        self.assertEqual(again["events"], [])
        text = self.kb(["events", "--since", "all", "--agent", "beta"], cwd=self.root).stdout
        self.assertRegex(text, r"\d\d:\d\d:\d\d alpha lease.taken 02-hero")
        self.assertIn("./kb events --since", text)
        self.assertExit(self.kb(["events", "--since", "yesterday-ish"], cwd=self.root), 2)


class FollowTests(EventCase):
    def test_follow_streams_new_events_and_ends_with_a_cursor(self) -> None:
        events.append(self.project, "note", self.alpha, text="before")
        env = dict(self.env)
        proc = subprocess.Popen(python_argv(KB) + ["events", "--follow", "--since", "all", "--exit-after", "1.5", "--agent", "beta"], cwd=str(self.root),
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(0.6)
        events.append(self.project, "lease.taken", self.alpha, scene="03-outro")
        events.append(self.project, "note", self.beta, text="my own")
        out, err = proc.communicate(timeout=20)
        self.assertEqual(proc.returncode, 0, err)
        got = lines(out)
        self.assertEqual([e["kind"] for e in got], ["note", "lease.taken", "follow.end"])
        end = got[-1]
        self.assertEqual(end["cursor"], events.cursor(str(self.root)))
        seen = json.loads((self.root / ".kb" / "agents" / "beta" / "seen.json").read_text())
        self.assertEqual(seen["eventsCursor"], end["cursor"])
        quick = self.kb(["events", "--follow", "--exit-after", "0", "--agent", "beta"], cwd=self.root)
        self.assertEqual([e["kind"] for e in lines(quick.stdout)], ["follow.end"])

    def test_follow_crosses_a_rotation(self) -> None:
        events.append(self.project, "note", self.alpha, text="start")
        out: List[str] = []

        class Sink:
            def write(self, s: str) -> None:
                out.append(s)

            def flush(self) -> None:
                pass

        def writer() -> None:
            time.sleep(0.4)
            while not (self.root / ".kb" / "events.1.jsonl").exists():
                events.append(self.project, "note", self.alpha, text="y" * 3000)
            events.append(self.project, "lease.taken", self.alpha, scene="after-rotation")

        t = threading.Thread(target=writer)
        t.start()
        events.follow(self.project, self.beta, ("end", None), ["lease"], False, 2.5, Sink(), app_events=False)
        t.join()
        got = lines("".join(out))
        self.assertEqual([e.get("scene") for e in got if e["kind"] == "lease.taken"], ["after-rotation"])
        self.assertEqual(got[-1]["kind"], "follow.end")


class AppEventTests(EventCase):
    def test_app_events_are_synthesised_from_heartbeat_changes(self) -> None:
        app = FakeApp(self.bridge, lambda body: None, root=self.root.parent)
        watch = events.AppWatch(self.project)
        self.assertEqual(watch.poll(), [])
        app.write_heartbeat()
        opened = watch.poll()
        self.assertEqual([e["kind"] for e in opened], ["app.opened"])
        self.assertEqual(opened[0]["by"], events.APP_BY)
        app.heartbeat.update(openProject="ws:demo", lastLoad={"project": "ws:demo", "ok": False, "atMs": 1, "error": None,
                                                              "sceneErrors": [{"index": 1}], "fontIssues": [], "warnings": []})
        app.write_heartbeat()
        load = watch.poll()
        self.assertEqual([(e["kind"], e["ok"], e["sceneErrors"]) for e in load], [("load", False, 1)])
        self.assertEqual(watch.poll(), [])
        app.heartbeat.update(exporting=True, exportJob={"id": "j1", "origin": "bridge", "stage": "frames", "frame": 0, "total": 100})
        app.write_heartbeat()
        self.assertEqual([e["kind"] for e in watch.poll()], ["export.started"])
        progress = []
        for frame in (5, 12, 19, 25, 61, 99):
            app.heartbeat["exportJob"] = dict(app.heartbeat["exportJob"], frame=frame)
            app.write_heartbeat()
            progress += [e["percent"] for e in watch.poll() if e["kind"] == "export.progress"]
        self.assertEqual(progress, [10, 20, 60, 90])
        app.heartbeat.update(exporting=False, exportJob=None, health={"gpu": {"stalled": True, "wedged": False}})
        app.write_heartbeat()
        self.assertEqual([e["kind"] for e in watch.poll()], ["export.done", "render.stalled"])
        app.heartbeat["health"] = {"gpu": {"stalled": False}}
        app.write_heartbeat()
        self.assertEqual([e["kind"] for e in watch.poll()], ["render.recovered"])
        for name in ("apps", "app.json"):
            target = self.bridge / name
            if target.is_dir():
                for f in target.iterdir():
                    f.unlink()
            elif target.exists():
                target.unlink()
        self.assertEqual([e["kind"] for e in watch.poll()], ["app.closed"])

    def test_follow_includes_app_events(self) -> None:
        app = FakeApp(self.bridge, lambda body: None, root=self.root.parent)
        app.write_heartbeat()
        proc = subprocess.Popen(python_argv(KB) + ["events", "--follow", "--exit-after", "2.5", "--agent", "beta", "--kinds", "load"], cwd=str(self.root),
                                env=dict(self.env), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(1.0)
        app.heartbeat.update(lastLoad={"project": "ws:demo", "ok": True, "atMs": 5, "error": None, "sceneErrors": [], "fontIssues": [], "warnings": []})
        app.write_heartbeat()
        out, err = proc.communicate(timeout=20)
        got = lines(out)
        self.assertEqual([e["kind"] for e in got], ["load", "follow.end"], err)
        self.assertTrue(got[0]["ok"])


class NoteTests(EventCase):
    def test_notes_reach_the_other_agents_status_once(self) -> None:
        self.assertExit(self.kb(["note", "hero copy is final", "--scene", "02-hero", "--agent", "alpha"], cwd=self.root), 0)
        self.assertExit(self.kb(["note", "multi\nline   note", "--agent", "alpha"], cwd=self.root), 0)
        text = (self.root / ".kb" / "notes.md").read_text()
        self.assertRegex(text, r"^- \d{4}-\d\d-\d\d \d\d:\d\d · alpha · 02-hero: hero copy is final\n- \d{4}-\d\d-\d\d \d\d:\d\d · alpha: multi line note\n$")
        status = self.kb(["status", "--agent", "beta"], cwd=self.root).stdout
        self.assertIn("2 new notes since your last status (./kb notes)", status)
        self.assertRegex(status, r"\n  \d\d:\d\d alpha · 02-hero: hero copy is final\n")
        self.assertNotIn("new note", self.kb(["status", "--agent", "beta"], cwd=self.root).stdout)
        self.assertNotIn("new note", self.kb(["status", "--agent", "alpha"], cwd=self.root).stdout)
        self.assertExit(self.kb(["note", "x" * 400, "--agent", "alpha"], cwd=self.root), 0)
        data = json.loads(self.kb(["status", "--json", "--agent", "beta"], cwd=self.root).stdout)
        self.assertEqual(len(data["notes"]), 1)
        shown = self.kb(["status", "--agent", "gamma"], cwd=self.root).stdout
        self.assertIn("3 new notes since your last status", shown)
        self.assertTrue(all(len(x) <= 162 for x in shown.splitlines() if x.startswith("  ")))
        self.assertEqual([e["kind"] for e in self.journal()], ["note", "note", "note"])

    def test_more_than_three_unseen_shows_the_newest_three(self) -> None:
        for i in range(5):
            events.add_note(self.project, self.alpha, f"note {i}")
        out = events.notes_lines(events.unseen_notes(self.project, self.beta))
        self.assertEqual(out[0], "5 new notes since your last status; the newest 3 (./kb notes shows all):")
        self.assertEqual([x.rsplit(": ", 1)[1] for x in out[1:]], ["note 2", "note 3", "note 4"])
        self.assertEqual(events.unseen_notes(self.project, self.beta), [])

    def test_notes_rotate_and_list(self) -> None:
        while not (self.root / ".kb" / "notes.1.md").exists():
            events.add_note(self.project, self.alpha, "z" * 1000)
        events.add_note(self.project, self.alpha, "fresh after rotation")
        self.assertTrue((self.root / ".kb" / "notes.1.md").exists())
        recent = json.loads(self.kb(["notes", "--json", "--agent", "beta"], cwd=self.root).stdout)
        self.assertEqual(recent["notes"][-1]["text"], "fresh after rotation")
        everything = json.loads(self.kb(["notes", "--all", "--json", "--agent", "beta"], cwd=self.root).stdout)
        self.assertGreater(everything["total"], recent["total"])

    def test_session_start_shows_leases_and_the_newest_two_notes(self) -> None:
        for i in range(3):
            events.add_note(self.project, self.alpha, f"note {i}")
        self.assertExit(self.kb(["lease", "02-hero", "--agent", "alpha"], cwd=self.root), 0)
        start = json.dumps({"session_id": "sess-new", "cwd": str(self.root), "hook_event_name": "SessionStart", "source": "startup"})
        proc = self.kb(["hook", "session-start"], cwd=self.root, stdin=start)
        self.assertExit(proc, 0)
        self.assertRegex(proc.stdout, r"Leases: 02-hero alpha \(1h5\dm\)")
        self.assertIn("Notes (newest; ./kb notes):", proc.stdout)
        self.assertNotIn("note 0", proc.stdout)
        self.assertIn("alpha: note 2", proc.stdout)
        self.assertLess(len(proc.stdout.encode("utf-8")), 4096)


class SeenTests(EventCase):
    def test_seen_marks_are_per_agent(self) -> None:
        events.save_seen(self.project, "alpha", eventsCursor="1:2")
        events.save_seen(self.project, "alpha", notesOffset=10)
        self.assertEqual(events.load_seen(str(self.root), "alpha"), {"eventsCursor": "1:2", "notesOffset": 10})
        self.assertEqual(events.load_seen(str(self.root), "beta"), {})
        write(self.root / ".kb" / "agents" / "beta" / "seen.json", "not json")
        self.assertEqual(events.load_seen(str(self.root), "beta"), {})
