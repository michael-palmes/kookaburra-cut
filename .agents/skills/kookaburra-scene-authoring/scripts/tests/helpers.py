"""Temp project fixtures, a fake app bundle, a fake bridge and a kb runner."""

from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zlib
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

SCRIPTS = Path(__file__).resolve().parent.parent
KB = SCRIPTS / "kb.py"
FIXTURE_CATALOG = Path(__file__).resolve().parent / "fixtures" / "catalog.json"

def png_bytes(width: int = 2, height: int = 3) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\x00\x00\x00\xff" * width for _ in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


PNG_1x1 = png_bytes()

SCENE_TSX = """import {{ defineScene, SceneStage, TitleBlock, useSceneText }} from "@kookaburra/toolkit";

export default defineScene({{
  id: "{id}",
  durationMs: 3000,
  Scene() {{
    const title = useSceneText("title", "Hello");
    return (
      <SceneStage>
        <TitleBlock title={{title}} />
      </SceneStage>
    );
  }},
}});
"""


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def write_json(path: Path, value: Any) -> None:
    write(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def make_project(root: Path, scenes: Optional[List[str]] = None, git: bool = False, **manifest_extra: Any) -> Path:
    """A valid workspace project at root/<slug> with one TSX + sidecar per scene stem."""
    stems = scenes if scenes is not None else ["01-intro", "02-hero", "03-outro"]
    project = root / "demo"
    entries = []
    for i, stem in enumerate(stems):
        write(project / "scenes" / f"{stem}.tsx", SCENE_TSX.format(id=stem.split("-", 1)[1]))
        write_json(project / "scenes" / f"{stem}.json", {"version": 1, "name": stem.split("-", 1)[1].title(), "text": {"title": "Hello"}})
        entry: Dict[str, Any] = {"file": f"scenes/{stem}.tsx", "durationMs": 3000}
        if i < len(stems) - 1:
            entry["transition"] = {"type": "crossfade", "durationMs": 600}
        entries.append(entry)
    manifest: Dict[str, Any] = {
        "id": "demo",
        "name": "Demo",
        "version": 2,
        "themeId": "kookaburra-default",
        "formats": ["16:9", "9:16"],
        "scenes": entries,
    }
    manifest.update(manifest_extra)
    write_json(project / "project.json", manifest)
    (project / "assets").mkdir(parents=True, exist_ok=True)
    (project / "assets" / "logo.png").write_bytes(PNG_1x1)
    if git:
        git_init(project)
    return project


def git_init(project: Path) -> None:
    run_git(project, ["init", "-q"])
    run_git(project, ["add", "-A"])
    run_git(project, ["-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "init"])


def run_git(project: Path, args: List[str]) -> str:
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        env.pop(key, None)
    proc = subprocess.run(["git", "-C", str(project)] + args, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        raise AssertionError(f"git {args} failed: {proc.stderr}")
    return proc.stdout


def make_resources(root: Path) -> Path:
    """A fake app bundle Resources folder with one preset ("title") that references a project asset and a sample."""
    res = root / "Resources"
    preset = res / "presets" / "title"
    write_json(preset / "preset.json", {"version": 1, "name": "Title", "tagline": "A title on the theme background", "category": "starters", "tags": ["title", "starter"], "order": 40, "status": "stable", "preview": 0})
    write_json(preset / "project.json", {"id": "title", "name": "Title", "version": 2, "themeId": "kookaburra-default", "formats": ["16:9"], "scenes": [{"file": "scenes/01-title.tsx", "durationMs": 2500}]})
    write(preset / "scenes" / "01-title.tsx", SCENE_TSX.format(id="title").replace('"Hello"', '"assets/logo.png"'))
    write_json(preset / "scenes" / "01-title.json", {
        "version": 1,
        "name": "Title",
        "managedText": {"layout": "template", "items": [{"key": "title", "type": "title", "text": "Ship faster"}]},
        "devices": [{"id": "phone", "model": "android", "media": {"src": "assets/sample-shot.png", "kind": "image"}}],
        "deviceTrack": {"keys": [{"id": "a", "tMs": 0, "pose": {"phone": {"scale": 1}}}, {"id": "b", "tMs": 900, "pose": {"phone": {"scale": 1.2}}}], "segments": [{"from": "a", "to": "b", "ease": "inOutQuad"}]},
        "headerIcon": "assets/logo.png",
    })
    (preset / "assets").mkdir(parents=True, exist_ok=True)
    (preset / "assets" / "logo.png").write_bytes(PNG_1x1 + b"preset")
    samples = res / "projects" / "_samples"
    samples.mkdir(parents=True, exist_ok=True)
    (samples / "sample-shot.png").write_bytes(PNG_1x1)
    previews = res / "preset-previews"
    previews.mkdir(parents=True, exist_ok=True)
    (previews / "title.jpg").write_bytes(b"\xff\xd8\xff")
    return res


class KbTestCase(unittest.TestCase):
    """Every test gets a temp dir, an isolated bridge, trash and catalogue."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="kbtest-")).resolve()
        self.bridge = self.tmp / "_bridge"
        self.trash = self.tmp / "Trash"
        self.res = self.tmp / "NoApp" / "Resources"
        self.env = dict(os.environ)
        for key in ("CLAUDE_PROJECT_DIR", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
            self.env.pop(key, None)
        self.env.update({
            "KB_BRIDGE_DIR": str(self.bridge),
            "KB_TRASH_DIR": str(self.trash),
            "KB_CATALOG": str(FIXTURE_CATALOG),
            "KB_RESOURCES_DIR": str(self.res),
        })
        self._saved_env = {k: os.environ.get(k) for k in ("KB_BRIDGE_DIR", "KB_TRASH_DIR", "KB_CATALOG", "KB_RESOURCES_DIR", "CLAUDE_PROJECT_DIR")}
        for k in ("KB_BRIDGE_DIR", "KB_TRASH_DIR", "KB_CATALOG", "KB_RESOURCES_DIR"):
            os.environ[k] = self.env[k]
        os.environ.pop("CLAUDE_PROJECT_DIR", None)
        from kblib import catalog

        catalog.reset_cache()

    def tearDown(self) -> None:
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def kb(self, args: List[str], cwd: Optional[Path] = None, stdin: Optional[str] = None, env: Optional[Dict[str, str]] = None, script: Path = KB) -> subprocess.CompletedProcess:
        full_env = dict(self.env)
        if env:
            full_env.update(env)
        return subprocess.run(
            [sys.executable, "-I", "-B", str(script)] + args,
            cwd=str(cwd or self.tmp), input=stdin, capture_output=True, text=True, env=full_env, timeout=60,
        )

    def assertExit(self, proc: subprocess.CompletedProcess, code: int) -> None:
        if proc.returncode != code:
            self.fail(f"exit {proc.returncode} != {code}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}")


class FakeApp:
    """Writes a live heartbeat and answers bridge requests from a thread, like the app's render window."""

    def __init__(self, bridge: Path, handler: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]], kinds: Optional[List[str]] = None, **heartbeat: Any) -> None:
        self.bridge = bridge
        self.handler = handler
        self.kinds = kinds if kinds is not None else ["capture", "check", "fonts", "insertPreset"]
        self.heartbeat = heartbeat
        self.requests: List[Dict[str, Any]] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def write_heartbeat(self) -> None:
        body = {
            "version": 2, "pid": os.getpid(), "appVersion": "0.19.0-test", "build": "dev",
            "updatedAtMs": int(time.time() * 1000), "workspaceRoot": str(self.bridge.parent),
            "resourcesDir": None, "openProject": None, "aspect": "16:9", "playheadMs": 1000,
            "exporting": False, "playing": False, "kinds": self.kinds, "lastLoad": None,
        }
        body.update(self.heartbeat)
        self.bridge.mkdir(parents=True, exist_ok=True)
        tmp = self.bridge / ".app.json.tmp"
        tmp.write_text(json.dumps(body), encoding="utf-8")
        os.replace(tmp, self.bridge / "app.json")

    def __enter__(self) -> "FakeApp":
        self.write_heartbeat()
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def _run(self) -> None:
        requests = self.bridge / "requests"
        responses = self.bridge / "responses"
        last_beat = time.monotonic()
        while not self._stop.is_set():
            if time.monotonic() - last_beat > 2:
                self.write_heartbeat()
                last_beat = time.monotonic()
            if requests.is_dir():
                for path in sorted(requests.glob("*.json")):
                    claimed = requests / ".claimed"
                    claimed.mkdir(exist_ok=True)
                    target = claimed / path.name
                    try:
                        os.replace(path, target)
                        body = json.loads(target.read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        continue
                    self.requests.append(body)
                    answer = self.handler(body)
                    if answer is None:
                        continue
                    answer = dict({"version": 2, "id": body["id"]}, **answer)
                    responses.mkdir(parents=True, exist_ok=True)
                    tmp = responses / f"{body['id']}.json.tmp"
                    tmp.write_text(json.dumps(answer), encoding="utf-8")
                    os.replace(tmp, responses / f"{body['id']}.json")
            time.sleep(0.05)
