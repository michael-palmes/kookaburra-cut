"""Temp project fixtures, a fake app bundle, a fake bridge and a kb runner."""

from __future__ import annotations

import atexit
import hashlib
import importlib.util
import json
import locale
import os
import plistlib
import py_compile
import shlex
import shutil
import signal
import socket
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
FIXTURES = Path(__file__).resolve().parent / "fixtures"
FIXTURE_CATALOG = FIXTURES / "catalog.json"
FAKE_CLI = Path(__file__).resolve().parent / "fake_app_cli.py"
FORKSERVER = Path(__file__).resolve().parent / "kb_forkserver.py"
# KB_TESTS_SUBPROCESS=1 runs every kb call as its own python3 -I -B kb.py, skipping the fork server.
FORCE_PROCESS = os.environ.get("KB_TESTS_SUBPROCESS") == "1"
ENV_KEYS = ("KB_BRIDGE_DIR", "KB_TRASH_DIR", "KB_CATALOG", "KB_RESOURCES_DIR", "KB_APP_BIN", "CLAUDE_PROJECT_DIR", "PATH")
_RUN_DIR: Optional[Path] = None
_PYC: Optional[str] = None
_GIT_DIR: Optional[str] = None
_GIT_SEARCHED = False
_SHIMS: List[Path] = []
_FORK: Optional["ForkServer"] = None
_FORK_TRIED = False


def run_dir() -> Path:
    """Scratch shared by every test in this run, removed at exit."""
    global _RUN_DIR
    if _RUN_DIR is None:
        _RUN_DIR = Path(tempfile.mkdtemp(prefix="kbtest-run-")).resolve()
        atexit.register(shutil.rmtree, str(_RUN_DIR), True)
    return _RUN_DIR


_LIST_IMPORTS = """import importlib, pkgutil, sys
sys.path.append(sys.argv[1])
import kblib
for m in pkgutil.walk_packages(kblib.__path__, "kblib."):
    try:
        importlib.import_module(m.name)
    except Exception:
        pass
print("\\n".join(sorted({f for f in (getattr(m, "__file__", None) for m in list(sys.modules.values())) if f and f.endswith(".py")})))
"""


def pycache_prefix() -> str:
    """Everything a kit child imports (stdlib too), compiled once per run outside the kit; kblib's pycs are hash-checked."""
    global _PYC
    if _PYC is None:
        prefix = run_dir() / "pyc"
        listed = subprocess.run([sys.executable, "-I", "-B", "-c", _LIST_IMPORTS, str(SCRIPTS)], capture_output=True, text=True, timeout=120)
        sources = {Path(p) for p in listed.stdout.splitlines() if p} | set((SCRIPTS / "kblib").rglob("*.py"))
        saved = sys.pycache_prefix
        sys.pycache_prefix = str(prefix)
        try:
            for src in sorted(sources):
                ours = SCRIPTS in src.parents
                mode = py_compile.PycInvalidationMode.CHECKED_HASH if ours else py_compile.PycInvalidationMode.TIMESTAMP
                try:
                    py_compile.compile(str(src), cfile=importlib.util.cache_from_source(str(src)), doraise=True, invalidation_mode=mode)
                except (py_compile.PyCompileError, OSError):
                    continue
        finally:
            sys.pycache_prefix = saved
        _PYC = str(prefix)
    return _PYC


def python_argv(script: Path) -> List[str]:
    """How tests run a kit script: python3 -I -B like the hooks, reading this run's precompiled kblib."""
    return [sys.executable, "-I", "-B", "-X", f"pycache_prefix={pycache_prefix()}", str(script)]


def git_dir() -> Optional[str]:
    """On macOS, a folder whose git links past the /usr/bin/git xcrun shim to the same binary (about 15 ms less a call)."""
    global _GIT_DIR, _GIT_SEARCHED
    if _GIT_SEARCHED:
        return _GIT_DIR
    _GIT_SEARCHED = True
    exe = shutil.which("git")
    if sys.platform != "darwin" or not exe or os.path.realpath(exe) != "/usr/bin/git":
        return None
    try:
        real = subprocess.run(["xcrun", "--find", "git"], capture_output=True, text=True, timeout=20).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    if not real or not os.access(real, os.X_OK):
        return None
    folder = run_dir() / "git-bin"
    folder.mkdir(exist_ok=True)
    os.symlink(real, folder / "git")
    _GIT_DIR = str(folder)
    return _GIT_DIR


def shim_behaviour_path(shim: str) -> Path:
    """Where fake_cli keeps a shim's FAKE_CLI_* knobs; fake_app_cli.py reads them back by its own path."""
    return run_dir() / "fake-cli" / f"{hashlib.sha256(os.path.realpath(shim).encode('utf-8')).hexdigest()}.json"


def shim_master(index: int) -> Path:
    """The index-th identical shim script; tests hard-link one, since macOS vets every new executable on its first run.
    A re-shim at the same path takes the next one, so the CLI's identity (path, size, mtime) still changes."""
    while len(_SHIMS) <= index:
        folder = run_dir() / "fake-cli"
        folder.mkdir(exist_ok=True)
        master = folder / f"shim-{len(_SHIMS)}"
        exports = f"export FAKE_CLI_SHIM=\"$0\" FAKE_CLI_BEHAVIOUR={shlex.quote(str(folder))}\n"
        master.write_text(f"#!/bin/sh\n{exports}exec {shlex.join(python_argv(FAKE_CLI))} \"$@\"\n", encoding="utf-8")
        master.chmod(0o755)
        _SHIMS.append(master)
    return _SHIMS[index]


def _send_msg(sock: socket.socket, obj: Dict[str, Any]) -> None:
    data = json.dumps(obj).encode("utf-8")
    sock.sendall(struct.pack(">I", len(data)) + data)


def _recv_msg(sock: socket.socket) -> Optional[Dict[str, Any]]:
    head = b""
    while len(head) < 4:
        chunk = sock.recv(4 - len(head))
        if not chunk:
            return None
        head += chunk
    size = struct.unpack(">I", head)[0]
    body = b""
    while len(body) < size:
        chunk = sock.recv(size - len(body))
        if not chunk:
            return None
        body += chunk
    return json.loads(body.decode("utf-8"))


def _drain(fd: int, sink: List[bytes]) -> None:
    while True:
        data = os.read(fd, 65536)
        if not data:
            break
        sink.append(data)
    os.close(fd)


def _feed(fd: int, data: bytes) -> None:
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
    except OSError:
        pass
    finally:
        os.close(fd)


def _text(data: bytes, encoding: str) -> str:
    """What subprocess.run(text=True) makes of a pipe's bytes."""
    return data.decode(encoding).replace("\r\n", "\n").replace("\r", "\n")


class ForkServer:
    """Client for kb_forkserver.py: every call is still its own kb process, minus about 50 ms of interpreter start-up."""

    def __init__(self) -> None:
        ours, theirs = socket.socketpair()
        env = {k: v for k, v in os.environ.items() if not k.startswith(("KB_", "FAKE_CLI_")) and k != "CLAUDE_PROJECT_DIR"}
        # Anything kblib read at import time would point here and fail loudly, never at the user's workspace.
        sentinel = run_dir() / "forkserver-env"
        env.update({k: str(sentinel / k) for k in ("KB_BRIDGE_DIR", "KB_TRASH_DIR", "KB_CATALOG", "KB_RESOURCES_DIR", "KB_APP_BIN")})
        self.proc = subprocess.Popen(python_argv(FORKSERVER) + [str(theirs.fileno())], pass_fds=[theirs.fileno()], cwd=str(run_dir()), env=env,
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        theirs.close()
        self.sock = ours
        hello = _recv_msg(ours)
        self.ok = bool(hello and hello.get("ok"))
        self.lock = threading.Lock()

    def alive(self) -> bool:
        return self.ok and self.proc.poll() is None

    def close(self) -> None:
        self.sock.close()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()

    def run(self, cmd: List[str], args: List[str], cwd: str, stdin: Optional[str], env: Dict[str, str], timeout: float) -> subprocess.CompletedProcess:
        encoding = locale.getpreferredencoding(False)
        with self.lock:
            out_r, out_w = os.pipe()
            err_r, err_w = os.pipe()
            if stdin is None:
                in_r, in_w = (0, None) if _fd_open(0) else (os.open(os.devnull, os.O_RDONLY), None)
            else:
                in_r, in_w = os.pipe()
            try:
                socket.send_fds(self.sock, [b"F"], [in_r, out_w, err_w])
                _send_msg(self.sock, {"argv": args, "cwd": cwd, "env": env})
            finally:
                os.close(out_w)
                os.close(err_w)
                if in_r != 0:
                    os.close(in_r)
            started = _recv_msg(self.sock)
            if started is None:
                raise RuntimeError("the kb fork server died")
            out: List[bytes] = []
            err: List[bytes] = []
            readers = [threading.Thread(target=_drain, args=(out_r, out), daemon=True), threading.Thread(target=_drain, args=(err_r, err), daemon=True)]
            if in_w is not None:
                threading.Thread(target=_feed, args=(in_w, (stdin or "").encode(encoding)), daemon=True).start()
            for t in readers:
                t.start()
            deadline = time.monotonic() + timeout
            for t in readers:
                t.join(max(0.0, deadline - time.monotonic()))
            timed_out = any(t.is_alive() for t in readers)
            if timed_out:
                os.kill(started["pid"], signal.SIGKILL)
            done = _recv_msg(self.sock)
            if done is None:
                raise RuntimeError("the kb fork server died")
            stdout, stderr = _text(b"".join(out), encoding), _text(b"".join(err), encoding)
            if timed_out:
                raise subprocess.TimeoutExpired(cmd, timeout, stdout, stderr)
            return subprocess.CompletedProcess(cmd, done["returncode"], stdout, stderr)


def _fd_open(fd: int) -> bool:
    try:
        os.fstat(fd)
        return True
    except OSError:
        return False


def fork_server() -> Optional[ForkServer]:
    """The run's kb fork server, or None (no fork, KB_TESTS_SUBPROCESS=1, or kb would not import) for a plain subprocess."""
    global _FORK, _FORK_TRIED
    if not _FORK_TRIED:
        _FORK_TRIED = True
        if not FORCE_PROCESS and hasattr(os, "fork") and hasattr(socket, "send_fds"):
            try:
                server = ForkServer()
            except OSError:
                server = None
            if server is not None and server.ok:
                _FORK = server
                atexit.register(server.close)
    return _FORK if _FORK is not None and _FORK.alive() else None


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


def fake_worktree(main: Path, tree: Path) -> Path:
    """A linked-worktree lookalike of main at tree: a copy whose .git file points into main/.git/worktrees/."""
    shutil.copytree(main, tree, ignore=shutil.ignore_patterns(".git"))
    gitdir = main / ".git" / "worktrees" / tree.name
    gitdir.mkdir(parents=True, exist_ok=True)
    write(tree / ".git", f"gitdir: {gitdir}\n")
    return tree


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

    # True runs this test's kb calls as real python3 -I -B kb.py processes rather than fork-server children.
    real_process = False

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="kbtest-")).resolve()
        self.bridge = self.tmp / "_bridge"
        self.trash = self.tmp / "Trash"
        self.res = self.tmp / "NoApp" / "Resources"
        self.env = dict(os.environ)
        for key in ("CLAUDE_PROJECT_DIR", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
            self.env.pop(key, None)
        for key in [k for k in self.env if k.startswith("FAKE_CLI_")]:
            self.env.pop(key)
        self.env.update({
            "KB_BRIDGE_DIR": str(self.bridge),
            "KB_TRASH_DIR": str(self.trash),
            "KB_CATALOG": str(FIXTURE_CATALOG),
            "KB_RESOURCES_DIR": str(self.res),
            "KB_APP_BIN": str(self.tmp / "NoApp" / "kookaburra-cut"),
        })
        git_link = git_dir()
        if git_link:
            self.env["PATH"] = git_link + os.pathsep + self.env.get("PATH", "")
        self._saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ("KB_BRIDGE_DIR", "KB_TRASH_DIR", "KB_CATALOG", "KB_RESOURCES_DIR", "KB_APP_BIN", "PATH"):
            if k in self.env:
                os.environ[k] = self.env[k]
        os.environ.pop("CLAUDE_PROJECT_DIR", None)
        from kblib import bridge, catalog, identity

        catalog.reset_cache()
        bridge.bind(None)
        identity.bind(None)

    def tearDown(self) -> None:
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def kb(self, args: List[str], cwd: Optional[Path] = None, stdin: Optional[str] = None, env: Optional[Dict[str, str]] = None, script: Path = KB,
           process: bool = False) -> subprocess.CompletedProcess:
        """Runs kb in its own process: forked from the run's fork server, or a real python3 -I -B kb.py when process=True."""
        full_env = dict(self.env)
        if env:
            full_env.update(env)
        cmd = python_argv(script) + args
        server = fork_server() if script == KB and not (process or self.real_process) else None
        if server is not None:
            return server.run(cmd, list(args), os.path.abspath(str(cwd or self.tmp)), stdin, full_env, 60)
        return subprocess.run(cmd, cwd=str(cwd or self.tmp), input=stdin, capture_output=True, text=True, env=full_env, timeout=60)

    def assertExit(self, proc: subprocess.CompletedProcess, code: int) -> None:
        if proc.returncode != code:
            self.fail(f"exit {proc.returncode} != {code}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}")

    def fake_cli(self, path: Optional[Path] = None, **behaviour: Any) -> Path:
        """An executable shim running fake_app_cli.py; behaviour keys become FAKE_CLI_<KEY> env vars. Sets KB_APP_BIN to it."""
        target = path or (self.tmp / "bin" / "kookaburra-cut")
        target.parent.mkdir(parents=True, exist_ok=True)
        write_json(shim_behaviour_path(str(target)), {f"FAKE_CLI_{k.upper()}": str(v) for k, v in behaviour.items()})
        uses = self.__dict__.setdefault("_shim_uses", {})
        master = shim_master(uses.get(target, 0))
        uses[target] = uses.get(target, 0) + 1
        if target.exists() or target.is_symlink():
            target.unlink()
        try:
            os.link(master, target)
        except OSError:
            shutil.copy2(master, target)
        if path is None:
            self.env["KB_APP_BIN"] = str(target)
            os.environ["KB_APP_BIN"] = str(target)
        return target

    def fake_bundle(self, plist: Dict[str, Any], **behaviour: Any) -> Path:
        """A fake Kookaburra Cut.app whose binary runs the fake CLI; returns the .app folder."""
        app = self.tmp / "Apps" / "Kookaburra Cut.app"
        (app / "Contents" / "Resources").mkdir(parents=True, exist_ok=True)
        with open(app / "Contents" / "Info.plist", "wb") as f:
            plistlib.dump(plist, f)
        self.fake_cli(app / "Contents" / "MacOS" / "kookaburra-cut", **behaviour)
        return app

    def no_app_bin(self) -> None:
        self.env.pop("KB_APP_BIN", None)
        os.environ.pop("KB_APP_BIN", None)


def write_probe(path: Path, **info: Any) -> None:
    """A media file the fake CLI can probe: some bytes plus <file>.probe.json."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_bytes(b"\x00\x00\x00\x18ftypmp42 fake video " + path.name.encode("utf-8"))
    body = {"kind": "video", "width": 1920, "height": 1080, "fps": 60, "durationMs": 10000, "vfr": False}
    body.update(info)
    write_json(Path(str(path) + ".probe.json"), body)


def video_project(root: Path, git: bool = False, **probe: Any) -> Path:
    """make_project plus assets/rec.mp4 (10 s, 1920x1080, 60 fps unless probe says otherwise)."""
    project = make_project(root, git=False)
    write_probe(project / "assets" / "rec.mp4", **probe)
    if git:
        git_init(project)
    return project


def sleeper(test: unittest.TestCase) -> subprocess.Popen:
    """A live process of our own whose pid stands in for another app instance (reaped at cleanup; kill() and wait() to make it quit)."""
    proc = subprocess.Popen(["sleep", "300"])

    def stop() -> None:
        proc.kill()
        proc.wait()

    test.addCleanup(stop)
    return proc


def _same_dir(a: Any, b: Any) -> bool:
    try:
        sa, sb = os.stat(str(a)), os.stat(str(b))
    except OSError:
        return False
    return (sa.st_dev, sa.st_ino) == (sb.st_dev, sb.st_ino)


class FakeApp:
    """Writes a live heartbeat and answers bridge requests from a thread, like a serving app instance.

    By default a current app: `apps/<pid>.json` plus `app.json`, claiming requests addressed to its pid (else its
    workspace root) and stamping `servedBy`. legacy=True is an older app (only `app.json`, claims everything, no
    `servedBy`); serving=False is a passive instance that writes its heartbeat and claims nothing; serve_filter
    replaces the claim rule.
    """

    def __init__(self, bridge: Path, handler: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]], kinds: Optional[List[str]] = None, *,
                 pid: Optional[int] = None, root: Optional[Path] = None, serving: bool = True, legacy: bool = False,
                 serve_filter: Optional[Callable[[Dict[str, Any]], bool]] = None, **heartbeat: Any) -> None:
        self.bridge = bridge
        self.handler = handler
        self.kinds = kinds if kinds is not None else ["capture", "check", "fonts", "insertPreset", "mediaChanged", "openEdit"]
        self.heartbeat = heartbeat
        self.pid = pid if pid is not None else os.getpid()
        self.root = Path(root) if root is not None else bridge.parent
        self.serving = serving
        self.legacy = legacy
        self.serve_filter = serve_filter
        self.started_at_ms = int(time.time() * 1000)
        self.requests: List[Dict[str, Any]] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def body(self) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "version": 2, "pid": self.pid, "appVersion": "0.19.0-test", "build": "dev",
            "updatedAtMs": int(time.time() * 1000), "workspaceRoot": str(self.root),
            "resourcesDir": None, "openProject": None, "aspect": "16:9", "playheadMs": 1000,
            "exporting": False, "playing": False, "kinds": self.kinds, "lastLoad": None,
        }
        if not self.legacy:
            body.update({
                "version": 3, "startedAtMs": self.started_at_ms, "bundleId": "com.mpalmes.kookaburracut", "exePath": None,
                "checkout": None, "rootSource": "settings", "primary": self.serving, "exportJob": None, "health": None,
                "bridge": {"serving": self.serving, "reason": None if self.serving else "workspace root overridden by KOOKABURRA_WORKSPACE_ROOT"},
            })
        body.update(self.heartbeat)
        return body

    def served_by(self) -> Dict[str, Any]:
        body = self.body()
        return {k: body.get(k) for k in ("pid", "bundleId", "build", "appVersion", "workspaceRoot")}

    def write_heartbeat(self) -> None:
        text = json.dumps(self.body())
        targets = [] if self.legacy else [self.bridge / "apps" / f"{self.pid}.json"]
        if self.legacy or self.serving:
            targets.append(self.bridge / "app.json")
        for target in targets:
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.parent / f".{target.name}.{self.pid}.tmp"
            tmp.write_text(text, encoding="utf-8")
            os.replace(tmp, target)

    def claims(self, body: Dict[str, Any]) -> bool:
        if self.serve_filter is not None:
            return self.serve_filter(body)
        if not self.serving:
            return False
        if self.legacy:
            return True
        if body.get("instancePid") is not None:
            return body["instancePid"] == self.pid
        if body.get("workspaceRoot") is not None:
            return _same_dir(body["workspaceRoot"], self.root)
        return True

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
            if requests.is_dir() and (self.serving or self.serve_filter is not None):
                for path in sorted(requests.glob("*.json")):
                    try:
                        body = json.loads(path.read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        continue
                    if not isinstance(body, dict) or not self.claims(body):
                        continue
                    claimed = requests / ".claimed"
                    claimed.mkdir(exist_ok=True)
                    try:
                        os.replace(path, claimed / path.name)
                    except OSError:
                        continue
                    self.requests.append(body)
                    answer = self.handler(body)
                    if answer is None:
                        continue
                    answer = dict({"version": 2, "id": body["id"]}, **answer)
                    if not self.legacy:
                        answer.setdefault("servedBy", self.served_by())
                    responses.mkdir(parents=True, exist_ok=True)
                    tmp = responses / f"{body['id']}.json.tmp"
                    tmp.write_text(json.dumps(answer), encoding="utf-8")
                    os.replace(tmp, responses / f"{body['id']}.json")
            time.sleep(0.05)
