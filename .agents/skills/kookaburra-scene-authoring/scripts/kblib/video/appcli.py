"""The app's headless edit CLI (`<app>/Contents/MacOS/kookaburra-cut edit ...`): find it, gate it, run it.

An old GUI binary given `edit caps` would launch the whole app, so a bundle binary only runs once its Info.plist
carries KookaburraEditCli >= 1. Dev binaries are only found through the heartbeat's cliPath or _bridge/cli.json,
which only CLI-capable builds write.
"""

from __future__ import annotations

import json
import os
import plistlib
import queue
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .. import bridge
from ..util import EXIT_ENV, EXIT_PROBLEMS, KbError, bridge_dir

BIN_NAME = "kookaburra-cut"
APP_BUNDLES = (
    Path("/Applications/Kookaburra Cut.app"),
    Path(os.path.expanduser("~/Applications/Kookaburra Cut.app")),
)
NEEDED_COMMANDS = ("caps", "probe", "create", "validate", "save", "render")
CLI_MIN = 1
CAPS_TIMEOUT_S = 20.0
PROBE_TIMEOUT_S = 60.0
CREATE_TIMEOUT_S = 120.0
SAVE_TIMEOUT_S = 30.0
RENDER_TIMEOUT_S = 3600.0
UPDATE_HINT = "ask the user to update the app"


class CliError(KbError):
    """The CLI answered {"ok": false, "code", "error"}: cli_code is that code, code the kb exit code, data the whole answer."""

    def __init__(self, cli_code: str, message: str, data: Optional[Dict[str, Any]] = None, exit_code: int = EXIT_PROBLEMS) -> None:
        super().__init__(message, exit_code)
        self.cli_code = cli_code
        self.data = data or {}


class CliInfo:
    def __init__(self, path: str, source: str, app_version: Optional[str] = None, build: Optional[str] = None) -> None:
        self.path = path
        self.source = source
        self.app_version = app_version
        self.build = build

    def as_dict(self) -> Dict[str, Any]:
        return {"path": self.path, "source": self.source, "appVersion": self.app_version, "build": self.build}

    def __repr__(self) -> str:
        return f"CliInfo({self.path!r}, {self.source!r}, {self.app_version!r})"


class TooOld(Exception):
    pass


def _executable(path: Path) -> bool:
    return path.is_file() and os.access(str(path), os.X_OK)


def _bundle_of(binary: Path) -> Optional[Path]:
    """The .app folder when binary sits at <app>/Contents/MacOS/<bin>, else None."""
    if binary.parent.name == "MacOS" and binary.parent.parent.name == "Contents":
        return binary.parent.parent.parent
    return None


def bundle_info(app: Path) -> Dict[str, Any]:
    try:
        with open(app / "Contents" / "Info.plist", "rb") as f:
            data = plistlib.load(f)
    except (OSError, plistlib.InvalidFileException, ValueError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


def gate_bundle(binary: Path) -> Optional[str]:
    """The bundle's app version once its plist allows terminal editing; raises TooOld otherwise. Never runs it."""
    app = _bundle_of(binary)
    if app is None:
        return None
    info = bundle_info(app)
    version = info.get("CFBundleShortVersionString") or info.get("CFBundleVersion") or "?"
    marker = info.get("KookaburraEditCli")
    if isinstance(marker, bool) or not isinstance(marker, int) or marker < CLI_MIN:
        raise TooOld(f"Kookaburra Cut {version} predates terminal video editing; {UPDATE_HINT}")
    return str(version)


def _candidate(path: Path, source: str, version: Optional[str] = None, build: Optional[str] = None) -> Optional[CliInfo]:
    if not _executable(path):
        return None
    gated = gate_bundle(path)
    return CliInfo(str(path), source, gated or version, build)


def _cli_json() -> Optional[Dict[str, Any]]:
    try:
        data = json.loads((bridge_dir() / "cli.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def locate() -> CliInfo:
    """KB_APP_BIN (exclusive), the live heartbeat's cliPath, _bridge/cli.json, then the bundles; raises KbError (exit 2)."""
    override = os.environ.get("KB_APP_BIN")
    if override is not None:
        path = Path(override).expanduser()
        if not _executable(path):
            raise KbError(f"KB_APP_BIN={override} is not an executable file; unset it to find the app normally", EXIT_ENV)
        try:
            return CliInfo(str(path), "KB_APP_BIN", gate_bundle(path))
        except TooOld as e:
            raise KbError(str(e), EXIT_ENV) from None
    too_old: List[str] = []

    def take(path: Optional[Path], source: str, version: Optional[str] = None, build: Optional[str] = None) -> Optional[CliInfo]:
        if path is None:
            return None
        try:
            return _candidate(path, source, version, build)
        except TooOld as e:
            too_old.append(str(e))
            return None

    hb = bridge.live_heartbeat()
    if hb and isinstance(hb.get("cliPath"), str) and hb["cliPath"]:
        version = hb.get("cliVersion")
        if not isinstance(version, int) or version >= CLI_MIN:
            found = take(Path(hb["cliPath"]), "heartbeat", hb.get("appVersion"), hb.get("build"))
            if found:
                return found
    record = _cli_json()
    if record and isinstance(record.get("path"), str) and record["path"]:
        level = record.get("cli")
        if not isinstance(level, int) or level >= CLI_MIN:
            found = take(Path(record["path"]), "cli.json", record.get("appVersion"), record.get("build"))
            if found:
                return found
    resources = os.environ.get("KB_RESOURCES_DIR")
    if resources:
        candidates = [(Path(resources).parent / "MacOS" / BIN_NAME, "KB_RESOURCES_DIR")]
    else:
        candidates = []
        stale = bridge.read_heartbeat()
        rdir = stale.get("resourcesDir") if isinstance(stale, dict) else None
        if isinstance(rdir, str) and rdir:
            candidates.append((Path(rdir).parent / "MacOS" / BIN_NAME, "heartbeat resourcesDir"))
        for app in APP_BUNDLES:
            candidates.append((app / "Contents" / "MacOS" / BIN_NAME, str(app.parent)))
    for path, source in candidates:
        found = take(path, source)
        if found:
            return found
    if too_old:
        raise KbError(too_old[0], EXIT_ENV)
    raise KbError(
        "no Kookaburra Cut with terminal video editing was found (looked at the running app, ~/Kookaburra Cut/_bridge/cli.json "
        f"and /Applications); {UPDATE_HINT}, or to install Kookaburra Cut in /Applications",
        EXIT_ENV,
    )


def locate_status() -> Dict[str, Any]:
    """For kb status: where the CLI is, from files and plists only (never runs it)."""
    try:
        info = locate()
    except KbError as e:
        return {"path": None, "source": None, "appVersion": None, "ok": False, "error": e.message}
    return {"path": info.path, "source": info.source, "appVersion": info.app_version, "ok": True, "error": None}


# ── running it ────────────────────────────────────────────────────────────────


def _identity(path: str) -> str:
    try:
        st = os.stat(path)
    except OSError:
        return f"{path}|?"
    return f"{path}|{st.st_size}|{st.st_mtime_ns}"


def _read_cache(path: Path) -> Dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_cache(path: Path, data: Dict[str, Any]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


def _tail(text: str, n: int = 400) -> str:
    text = (text or "").strip()
    return text[-n:]


def run_json(args: List[str], *, timeout: float, stdin: Optional[str] = None, info: Optional[CliInfo] = None) -> Dict[str, Any]:
    """One `edit <args>` call: one JSON object on stdout. Exit 1 with ok:false raises CliError; anything odd is exit 2."""
    info = info or locate()
    argv = [info.path, "edit"] + args
    try:
        proc = subprocess.run(
            argv,
            input=stdin.encode("utf-8") if stdin is not None else None,
            stdin=None if stdin is not None else subprocess.DEVNULL,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise KbError(f"Kookaburra Cut's edit {args[0]} did not answer within {int(timeout)} s ({info.path})", EXIT_ENV) from None
    except OSError as e:
        raise KbError(f"could not run {info.path}: {e.strerror}", EXIT_ENV) from None
    out = proc.stdout.decode("utf-8", "replace").strip()
    err = proc.stderr.decode("utf-8", "replace")
    data: Any = None
    for candidate in (out, out.splitlines()[-1] if out else ""):
        try:
            data = json.loads(candidate)
            break
        except ValueError:
            continue
    if not isinstance(data, dict):
        raise KbError(f"Kookaburra Cut's edit {args[0]} gave no JSON (exit {proc.returncode}): {_tail(out or err) or 'no output'}", EXIT_ENV)
    if proc.returncode == 0:
        return data
    code = str(data.get("code") or "error")
    message = str(data.get("error") or f"edit {args[0]} failed")
    if proc.returncode == 1:
        raise CliError(code, message, data, EXIT_PROBLEMS)
    if proc.returncode == 130:
        raise KbError(f"edit {args[0]} was interrupted", EXIT_ENV)
    raise CliError(code, message, data, EXIT_ENV)


def caps(info: Optional[CliInfo] = None) -> Dict[str, Any]:
    """`edit caps`, cached per binary (path, size, mtime); refuses a CLI older than this kit needs."""
    info = info or locate()
    cache_path = bridge_dir() / "video" / "cli-caps.json"
    key = _identity(info.path)
    cache = _read_cache(cache_path)
    data = cache.get(key) if isinstance(cache.get(key), dict) else None
    if data is None:
        data = run_json(["caps"], timeout=CAPS_TIMEOUT_S, info=info)
        _write_cache(cache_path, {key: data})
    level = data.get("cli")
    missing = [c for c in NEEDED_COMMANDS if c not in (data.get("commands") or [])]
    if not data.get("ok") or not isinstance(level, int) or isinstance(level, bool) or level < CLI_MIN or missing:
        what = f"cli {level}" if not missing else f"no {', '.join(missing)}"
        raise KbError(f"Kookaburra Cut {data.get('appVersion') or info.app_version or '?'} has an older edit CLI ({what}); {UPDATE_HINT}", EXIT_ENV)
    return data


def _tool(name: str) -> str:
    data = caps()
    tool = data.get(name) if isinstance(data.get(name), dict) else {}
    path = tool.get("path")
    if not tool.get("ok") or not isinstance(path, str) or not path:
        raise KbError(f"the app's bundled {name} is missing or broken ({path or 'no path'}); {UPDATE_HINT}", EXIT_ENV)
    return path


def ffmpeg_path() -> str:
    return _tool("ffmpeg")


def ffprobe_path() -> str:
    return _tool("ffprobe")


def _project_arg(project: Any) -> str:
    root = Path(project) if isinstance(project, (str, os.PathLike)) else project.root
    return str(Path(root).resolve())


def probe(project: Any, rel: str) -> Dict[str, Any]:
    """`edit probe --source REL`, cached per file (path, size, mtime) and CLI binary."""
    root = Path(_project_arg(project))
    abs_path = root / rel
    try:
        st = abs_path.stat()
    except OSError:
        raise KbError(f"{rel} does not exist; see kb assets list") from None
    info = locate()
    from . import cache as cachemod

    cache_path = cachemod.video_dir(project) / "probe-cache.json"
    key = f"{_identity(info.path)}|{rel}|{st.st_size}|{st.st_mtime_ns}"
    store = _read_cache(cache_path)
    hit = store.get(key)
    if isinstance(hit, dict):
        return hit
    data = run_json(["probe", "--project", str(root), "--source", rel], timeout=PROBE_TIMEOUT_S, info=info)
    store = {k: v for k, v in store.items() if not k.startswith(f"{_identity(info.path)}|{rel}|")}
    store[key] = data
    if len(store) > 300:
        store = dict(list(store.items())[-300:])
    _write_cache(cache_path, store)
    return data


def probe_file(project: Any, path: str) -> Dict[str, Any]:
    return run_json(["probe", "--project", _project_arg(project), "--file", str(Path(path).resolve())], timeout=PROBE_TIMEOUT_S)


def source_meta(project: Any, rel: str) -> Dict[str, Any]:
    """The editOps SourceMeta for an asset, from the app's probe (what the editor's mediaMeta returns)."""
    p = probe(project, rel)
    kind = p.get("kind")
    if kind not in ("video", "image"):
        raise KbError(f"{rel} is not a video or image the editor can use ({kind or 'unknown kind'})")
    return {
        "rel": rel,
        "kind": kind,
        "width": int(p.get("width") or 0),
        "height": int(p.get("height") or 0),
        "fps": p.get("fps") or 0,
        "durationMs": int(p.get("durationMs") or 0),
    }


def create(project: Any, source_rel: str, name: Optional[str] = None, *, reuse: bool = False, force: bool = False) -> Dict[str, Any]:
    args = ["create", "--project", _project_arg(project), "--source", source_rel]
    if name:
        args += ["--name", name]
    if reuse:
        args.append("--reuse")
    if force:
        args.append("--force")
    return run_json(args, timeout=CREATE_TIMEOUT_S)


def validate(project: Any, name: Optional[str] = None, doc: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    args = ["validate", "--project", _project_arg(project)]
    if doc is not None:
        return run_json(args + ["--doc", "-"], timeout=PROBE_TIMEOUT_S, stdin=json.dumps(doc))
    if not name:
        raise ValueError("validate needs a name or a doc")
    return run_json(args + ["--name", name], timeout=PROBE_TIMEOUT_S)


def save(project: Any, name: str, doc: Dict[str, Any], base: Optional[str]) -> Dict[str, Any]:
    args = ["save", "--project", _project_arg(project), "--name", name, "--doc", "-", "--base", base or "absent"]
    return run_json(args, timeout=SAVE_TIMEOUT_S, stdin=json.dumps(doc, ensure_ascii=False))


def render(
    project: Any,
    *,
    name: Optional[str] = None,
    doc: Optional[Dict[str, Any]] = None,
    out: Optional[str] = None,
    draft: bool = False,
    scale: Optional[float] = None,
    software: bool = False,
    expect_hash: Optional[str] = None,
    on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
    timeout: Optional[float] = None,
) -> Dict[str, Any]:
    """`edit render`, streaming its JSON lines to on_event; returns the done line. SIGINT/SIGTERM pass to the CLI,
    which kills ffmpeg and removes its staging file; a timeout kills it."""
    info = locate()
    args = ["render", "--project", _project_arg(project)]
    if doc is not None:
        if not out:
            raise ValueError("a doc render needs out")
        args += ["--doc", "-", "--out", str(out)]
    elif name:
        args += ["--name", name]
    else:
        raise ValueError("render needs a name or a doc")
    if software:
        args.append("--software")
    if draft:
        args.append("--draft")
    elif scale is not None:
        args += ["--scale", f"{scale:g}"]
    if expect_hash:
        args += ["--expect-hash", expect_hash]
    limit = RENDER_TIMEOUT_S if timeout is None else timeout
    try:
        proc = subprocess.Popen(
            [info.path, "edit"] + args,
            stdin=subprocess.PIPE if doc is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as e:
        raise KbError(f"could not run {info.path}: {e.strerror}", EXIT_ENV) from None
    lines: "queue.Queue[Optional[bytes]]" = queue.Queue()
    errs: List[bytes] = []

    def pump_out() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            lines.put(line)
        lines.put(None)

    def pump_err() -> None:
        assert proc.stderr is not None
        for chunk in proc.stderr:
            errs.append(chunk)
            del errs[:-40]

    threads = [threading.Thread(target=pump_out, daemon=True), threading.Thread(target=pump_err, daemon=True)]
    for t in threads:
        t.start()
    if doc is not None and proc.stdin is not None:
        try:
            proc.stdin.write(json.dumps(doc).encode("utf-8"))
            proc.stdin.close()
        except OSError:
            pass
    interrupted: List[int] = []
    previous: Dict[int, Any] = {}

    def forward(signum: int, _frame: Any) -> None:
        interrupted.append(signum)
        try:
            proc.send_signal(signum)
        except OSError:
            pass

    if threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, forward)
    done: Optional[Dict[str, Any]] = None
    error: Optional[Dict[str, Any]] = None
    deadline = time.monotonic() + limit
    grace: Optional[float] = None
    timed_out = False
    try:
        while True:
            now = time.monotonic()
            if interrupted and grace is None:
                grace = now + 10
            if (not timed_out and now > deadline) or (grace is not None and now > grace):
                timed_out = not interrupted
                _stop(proc)
                break
            try:
                line = lines.get(timeout=0.2)
            except queue.Empty:
                continue
            if line is None:
                break
            try:
                event = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            if on_event is not None:
                on_event(event)
            if event.get("event") == "done":
                done = event
            elif event.get("event") == "error" or event.get("ok") is False:
                error = event
        try:
            code = proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            _stop(proc)
            code = proc.wait()
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    for t in threads:
        t.join(timeout=1)
    for pipe in (proc.stdout, proc.stderr):
        try:
            if pipe is not None:
                pipe.close()
        except OSError:
            pass
    if interrupted:
        raise KeyboardInterrupt
    if timed_out:
        raise KbError(f"the render took longer than {int(limit)} s and was stopped (the old render, if any, is untouched); rerun with --timeout or --draft", EXIT_ENV)
    if error is not None:
        exit_code = EXIT_ENV if error.get("code") in ("usage", "env") else EXIT_PROBLEMS
        raise CliError(str(error.get("code") or "error"), str(error.get("error") or "the render failed"), error, exit_code)
    if done is None or not done.get("ok", True):
        tail = _tail(b"".join(errs).decode("utf-8", "replace"))
        raise KbError(f"the render ended without a result (exit {code}){': ' + tail if tail else ''}", EXIT_PROBLEMS)
    return done


def _stop(proc: "subprocess.Popen[bytes]") -> None:
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    except OSError:
        pass
