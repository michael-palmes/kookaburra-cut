"""`kb export`: the finished film, made exactly as the app's Export button makes it, through the editor that has the
project open (the bridge's `export` kind), or with the app closed through a packaged release bundle's autorun
(`--headless`). Progress lines, cancellation, the flash gate and the export record `kb verify-export` reads."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import bridge, identity, queue
from .catalog import load_catalog
from .film import flashes as fl
from .film import report as rp
from .film import timeline as tl
from .project import MANIFEST, Project
from .util import (
    EXIT_ENV,
    EXIT_OK,
    EXIT_PROBLEMS,
    EXIT_TRANSIENT,
    WORKSPACE_DIR_NAME,
    KbError,
    atomic_write_json,
    bridge_dir,
    emit,
    emit_err,
    home,
    is_number,
    now_ms,
    ok_envelope,
)

DEFAULT_TIMEOUT_S = 3600.0
DEFAULT_PROGRESS_EVERY_S = 10.0
# Long enough for a pointer-up or a closed modal; a field left focused needs the person.
BUSY_WAIT_S = 30.0
CANCEL_WAIT_S = 15.0
POLL_S = 0.25
# The native loop claims within a poll (300 ms); this long unclaimed means its bridge is stuck.
CLAIM_WINDOW_S = 110.0
PID_CHECK_S = 1.0
KEEP_RECORDS = 50
EXIT_INTERRUPTED = 130
STANDARD = "kookaburra-standard"
CAFFEINATE = "/usr/bin/caffeinate"
TERM_GRACE_S = 5.0

# The app's answer codes as kb exit codes and kinds (docs/agent-kit.md, "kb export").
APP_CODES: Dict[str, Tuple[int, str]] = {
    "busy": (EXIT_TRANSIENT, "app-busy"),
    "editing": (EXIT_TRANSIENT, "app-busy"),
    "notOpen": (EXIT_ENV, "not-open"),
    "wrongProject": (EXIT_ENV, "wrong-project"),
    "invalid": (EXIT_ENV, "usage"),
    "refused": (EXIT_PROBLEMS, "invalid"),
    "stale": (EXIT_TRANSIENT, "stale"),
    "cancelled": (EXIT_PROBLEMS, "cancelled"),
    "gpuStalled": (EXIT_TRANSIENT, "gpu-stalled"),
    "gpuWedged": (EXIT_ENV, "gpu-wedged"),
    "interrupted": (EXIT_ENV, "app-reloaded"),
    "acceptTimeout": (EXIT_TRANSIENT, "bridge-timeout"),
    "verifyMismatch": (EXIT_PROBLEMS, "verify-mismatch"),
    "failed": (EXIT_PROBLEMS, "failed"),
}

EPILOG = """\
Exports the project open in Kookaburra Cut exactly as its Export button does (same encode, same
file name, into this project's exports/), under an overlay with the user's own Cancel. Defaults
match the button: High quality, the editor's aspect, the poster frame as the app is set.

  --preset ID           a bundled preset (./kb catalog exportPresets) or ws:<slug>
  --fps / --short-edge  the Custom panel: 30 or 60, and 1440, 1080 or 720
  --verify              render twice and compare (refuses VideoToolbox presets); with
                        --poster-frame off this is one 16:9 leg of the app's Verify x2
  --headless            the app closed: a packaged release build renders it in the background
                        (the project must be one the user has opened since its code changed)

Prints a progress line per stage and every --progress-every seconds; --json prints one JSON
object per line, the final envelope last. Ctrl-C or --timeout cancels the export (exit 130 or 1).
Exit 1 when the film flashes (the file is kept; check it, then --allow-flashes), 2 when the
editor shows another project or the Welcome screen, 3 while the user is mid-edit or the app is busy.

  kb export
  kb export --aspect 9:16 --preset tiktok
  kb export --verify --poster-frame off
  kb export --headless --json"""


# ── shared ────────────────────────────────────────────────────────────────────


def source_hashes(project: Project) -> Dict[str, str]:
    """kb's view of the project: SHA-256 of project.json and every file under scenes/, the set the app's source stamps walk."""
    out: Dict[str, str] = {}
    files = [MANIFEST]
    for dirpath, dirnames, filenames in os.walk(project.scenes_dir):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        rel_dir = Path(dirpath).relative_to(project.root).as_posix()
        files += [f"{rel_dir}/{name}" for name in sorted(filenames) if not name.startswith(".") and not name.endswith(".tmp")]
    for rel in files:
        try:
            out[rel] = hashlib.sha256((project.root / rel).read_bytes()).hexdigest()
        except OSError:
            continue
    return out


def music_file(project: Project) -> Optional[Path]:
    audio = project.manifest(reload=True).get("audio")
    rel = audio.get("file") if isinstance(audio, dict) else None
    return project.root / rel if isinstance(rel, str) and rel else None


def source_state(project: Project, sources: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """The sources plus the music, as kb read them; compared again once the film is done."""
    state = dict(sources) if sources is not None else source_hashes(project)
    music = music_file(project)
    if music is not None and music.is_file():
        state[music.relative_to(project.root).as_posix()] = file_hash(music)
    return state


def changed_since(before: Dict[str, str], after: Dict[str, str]) -> List[str]:
    return sorted(f for f in set(before) | set(after) if before.get(f) != after.get(f))


def renders_from(sources: Dict[str, str], music: Optional[str]) -> str:
    scenes = sum(1 for f in sources if f.startswith("scenes/"))
    what = f"project.json and {scenes} scene file{'s' if scenes != 1 else ''}" + (f", music {music}" if music else "")
    return (f"renders the project as the editor loads it now ({what}); editing is safe, "
            "edits saved during the export land in the next one, not this film")


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def preset_entry(preset: Optional[str]) -> Optional[Dict[str, Any]]:
    return rp.preset_entry(load_catalog(), preset or STANDARD)


def fmt_eta(ms: Any) -> str:
    if not is_number(ms):
        return ""
    s = max(0, int(round(ms / 1000.0)))
    if s >= 3600:
        return f"{s // 3600}h{(s % 3600) // 60:02d}m"
    if s >= 60:
        return f"{s // 60}m{s % 60:02d}s"
    return f"{s}s"


def progress_text(p: Dict[str, Any]) -> str:
    """`render 1234/3901 32% 4.1 fps eta 10m45s`, or the stage alone."""
    stage = str(p.get("stage") or "waiting")
    if stage == "preparing" and p.get("prepareLabel"):
        return f"preparing ({p['prepareLabel']})"
    if stage in ("pass1", "pass2"):
        return f"encoding pass {stage[-1]}/2"
    if stage != "render":
        return stage
    bits = [f"render {p.get('frame', 0)}/{p.get('total', 0)}"]
    if is_number(p.get("runs")) and p["runs"] > 1:
        bits.append(f"({p.get('run', 1)}/{p['runs']})")
    if is_number(p.get("percent")):
        bits.append(f"{int(p['percent'])}%")
    if is_number(p.get("renderFps")):
        bits.append(f"{p['renderFps']:.1f} fps")
    eta = fmt_eta(p.get("etaMs"))
    if eta:
        bits.append(f"eta {eta}")
    return " ".join(bits)


class Reporter:
    """One line per stage change, else at most one per --progress-every seconds (JSON lines with --json)."""

    def __init__(self, as_json: bool, every_s: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.as_json = as_json
        self.every_s = max(0.0, every_s)
        self.clock = clock
        self.stage: Optional[str] = None
        self.last = -1e18
        self.seen: Optional[Any] = None

    def progress(self, p: Dict[str, Any]) -> bool:
        stamp = (p.get("updatedAtMs"), p.get("stage"), p.get("frame"))
        if stamp == self.seen:
            return False
        self.seen = stamp
        stage = p.get("stage")
        now = self.clock()
        if stage == self.stage and now - self.last < self.every_s:
            return False
        self.stage, self.last = stage, now
        if self.as_json:
            line = {"event": "progress"}
            line.update({k: p[k] for k in ("stage", "run", "runs", "prepareLabel", "frame", "total", "percent", "renderFps",
                                           "etaMs", "elapsedMs") if k in p})
            sys.stdout.write(json.dumps(line, separators=(",", ":")) + "\n")
        else:
            emit(f"kb export: {progress_text(p)}")
        sys.stdout.flush()
        return True

    def note(self, text: str) -> None:
        if self.as_json:
            sys.stdout.write(json.dumps({"event": "note", "message": text}, separators=(",", ":")) + "\n")
            sys.stdout.flush()
        else:
            emit_err(f"kb export: {text}")


def read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def rel_to(project: Project, path: str) -> str:
    try:
        return str(Path(path).resolve().relative_to(project.root.resolve()))
    except (ValueError, OSError):
        return path


class Interrupted(Exception):
    """Ctrl-C or SIGTERM while kb export waits."""


def _raise_interrupt(signum: int, frame: Any) -> None:
    raise Interrupted()


# ── the export record ─────────────────────────────────────────────────────────


def record_body(project: Project, result: Dict[str, Any], served: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The schema in docs/agent-kit.md ("Film checks and verify-export")."""
    entry = preset_entry(result.get("preset"))
    manifest = project.manifest(reload=True)
    return {
        "version": rp.RECORD_VERSION,
        "sha256": result["sha256"],
        "path": result["path"],
        "project": project.project_id,
        "aspect": result.get("aspect"),
        "preset": result.get("preset"),
        "lane": result.get("lane"),
        "codec": result.get("codec"),
        "fps": result.get("fps"),
        "width": result.get("width"),
        "height": result.get("height"),
        "posterFrame": result.get("posterFrame"),
        "frames": result.get("frames"),
        "totalMs": result.get("totalMs"),
        "audio": isinstance(manifest.get("audio"), dict),
        "loudnessTarget": entry.get("loudnessTarget") if entry else None,
        "timeline": result.get("timeline") or [],
        "flashes": result.get("flashes"),
        "exportedAtMs": now_ms(),
        "appVersion": (served or {}).get("appVersion"),
    }


def save_record(project: Project, body: Dict[str, Any]) -> Path:
    path = rp.record_path(project.slug, body["sha256"])
    atomic_write_json(path, body)
    try:
        records = sorted(path.parent.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in records[KEEP_RECORDS:]:
            old.unlink()
    except OSError:
        pass
    return path


# ── the bridge export ─────────────────────────────────────────────────────────


def app_failure(resp: Dict[str, Any], data: Optional[Dict[str, Any]] = None) -> KbError:
    code = str(resp.get("code") or "failed")
    exit_code, kind = APP_CODES.get(code, (EXIT_PROBLEMS, "failed"))
    if code == "stale" and resp.get("reloadFailed"):
        exit_code, kind = EXIT_PROBLEMS, "invalid"
    retry = resp.get("retryAfterMs") if exit_code == EXIT_TRANSIENT else None
    extra = {"appCode": code}
    extra.update(data or {})
    hint = resp.get("hint") if isinstance(resp.get("hint"), str) else None
    if hint is None and kind in ("not-open", "wrong-project"):
        hint = "ask the user to open this project in Kookaburra Cut, then rerun"
    return KbError(str(resp.get("error") or "the export failed"), exit_code, kind=kind, hint=hint,
                   retry_after_ms=int(retry) if is_number(retry) else None, data=extra)


def request_body(project: Project, a: argparse.Namespace) -> Dict[str, Any]:
    poster = {"on": True, "off": False}.get(a.poster_frame)
    return {
        "project": project.project_id,
        "aspect": a.aspect,
        "preset": a.preset,
        "fps": a.fps,
        "shortEdge": a.short_edge,
        "posterFrame": poster,
        "verify": bool(a.verify),
        "clientPid": os.getpid(),
        "detach": False,
        "sources": source_hashes(project),
    }


def cancel_and_wait(inst: bridge.Instance, project: Project, rid: str, client: Optional[str]) -> Optional[Dict[str, Any]]:
    """Asks the app to cancel `rid`, then waits up to 15 s for the export's own answer."""
    try:
        bridge.write_request(bridge.address({"kind": "cancelExport", "project": project.project_id, "target": rid}, inst, project, client))
    except OSError:
        return None
    path = bridge_dir() / "responses" / f"{rid}.json"
    deadline = time.monotonic() + CANCEL_WAIT_S
    while time.monotonic() < deadline:
        resp = read_json(path)
        if resp is not None:
            return resp
        if not bridge.pid_alive(inst.pid):
            return None
        time.sleep(POLL_S)
    return None


def wait_for_export(inst: bridge.Instance, project: Project, payload: Dict[str, Any], timeout: float, reporter: Reporter,
                    client: Optional[str]) -> Dict[str, Any]:
    """Sends the export and waits for its answer, printing progress; busy answers retry for up to 30 s."""
    deadline = time.monotonic() + timeout
    rid = bridge.write_request(payload)
    sent = checked = time.monotonic()
    claimed = False
    first_busy: Optional[float] = None
    busy: Optional[Dict[str, Any]] = None
    responses = bridge_dir() / "responses"
    try:
        while True:
            now = time.monotonic()
            resp = read_json(responses / f"{rid}.json")
            if resp is not None:
                bridge.check_served_by(resp, "export", project)
                if resp.get("busy"):
                    busy = resp
                    first_busy = first_busy if first_busy is not None else now
                    if now - first_busy >= min(BUSY_WAIT_S, timeout):
                        raise app_failure(resp)
                    if first_busy == now:
                        reporter.note(f"waiting: {resp.get('error') or 'the app is busy'}")
                    time.sleep(bridge.BUSY_RETRY_S)
                    if not bridge.pid_alive(inst.pid):
                        raise bridge._quit_error(inst, "export")
                    rid = bridge.write_request(payload)
                    sent, claimed = time.monotonic(), False
                    continue
                return resp
            progress = read_json(responses / f"{rid}.progress.json")
            if progress is not None:
                busy = None
                reporter.progress(progress)
            if now - checked >= PID_CHECK_S:
                checked = now
                if not bridge.pid_alive(inst.pid):
                    bridge._cleanup(rid)
                    raise bridge._quit_error(inst, "export")
            if not claimed and not (bridge_dir() / "requests" / f"{rid}.json").exists():
                claimed = True
            if not claimed and now - sent > CLAIM_WINDOW_S:
                bridge._cleanup(rid)
                raise KbError("the app did not pick up the export request; its bridge may be stuck", EXIT_TRANSIENT, kind="bridge-timeout",
                              hint="rerun shortly; if it keeps happening, ask the user to check Kookaburra Cut", retry_after_ms=5_000)
            if now >= deadline and busy is not None:
                bridge._cleanup(rid)
                raise app_failure(busy)
            if now >= deadline:
                reporter.note(f"--timeout {int(timeout)} s reached; cancelling the export")
                cancel_and_wait(inst, project, rid, client)
                raise KbError(f"the export did not finish within {int(timeout)} s, so kb cancelled it", EXIT_PROBLEMS, kind="timeout",
                              hint="rerun with a longer --timeout (a 4K export of a long project can take an hour)")
            time.sleep(POLL_S)
    except Interrupted:
        if not claimed and (bridge_dir() / "requests" / f"{rid}.json").exists():
            bridge._cleanup(rid)
        else:
            reporter.note("interrupted; cancelling the export")
            cancel_and_wait(inst, project, rid, client)
        raise


def finish_success(kbctx: Any, project: Project, result: Dict[str, Any], allow_flashes: bool, surface: str) -> int:
    """The record, the flash gate and the last line, shared by the bridge and headless exports."""
    flashes = result.get("flashes") if isinstance(result.get("flashes"), dict) else None
    if flashes is not None:
        poster_ms = 1000.0 / float(result.get("fps") or 60) if result.get("posterFrame") else 0.0
        slots = [dict(s) for s in result.get("timeline") or [] if isinstance(s, dict)] or tl.project_slots(project)
        flashes.setdefault("gate", "export")
        fl.place_issues(flashes, slots, poster_ms)
        result["flashes"] = flashes
    record = save_record(project, record_body(project, result, result.get("servedBy")))
    payload = dict(result)
    payload.pop("ok", None)
    payload.update({"surface": surface, "record": str(record), "file": rel_to(project, result["path"])})
    fails = fl.failures(flashes)
    if not kbctx.json:
        for line in fl.summary_lines(flashes):
            emit(f"kb export: {line.strip()}")
        for warning in result.get("warnings") or []:
            emit_err(f"kb export: warning: {warning}")
        seconds = (result.get("durationMs") or 0) / 1000.0
        emit(f"kb export: done {payload['file']} sha256 {result['sha256'][:16]}... {result.get('frames')} frames {seconds:.2f} s")
    if fails and not allow_flashes:
        first = fails[0]
        raise KbError(f"{payload['file']} flashes: {len(fails)} failure{'s' if len(fails) != 1 else ''}, the first at {first.get('tc')}; "
                      "the file is kept", EXIT_PROBLEMS, kind="flashes", data=payload)
    if kbctx.json:
        sys.stdout.write(json.dumps(ok_envelope("export", payload), separators=(",", ":"), ensure_ascii=False) + "\n")
    return EXIT_OK


def reload_warning(inst: bridge.Instance) -> Optional[str]:
    editor = queue.health_of(inst.hb).get("editor")
    if not isinstance(editor, dict) or not editor.get("restartRecommended"):
        return None
    return ("the editor has reloaded since Kookaburra Cut opened, and a reloaded editor slows down and fails long exports; "
            "if this one fails, ask the user to quit and reopen Kookaburra Cut")


def bridge_export(kbctx: Any, a: argparse.Namespace, reporter: Reporter) -> int:
    project: Project = kbctx.project
    inst = bridge._require_instance("export", "kb export", project)
    client = identity.current().name
    payload = bridge.address(dict(request_body(project, a), kind="export"), inst, project, client)
    before = source_state(project, payload["sources"])
    music = music_file(project)
    reporter.note(renders_from(payload["sources"], music.relative_to(project.root).as_posix() if music else None))
    warning = reload_warning(inst)
    if warning:
        reporter.note(f"warning: {warning}")
    resp = wait_for_export(inst, project, payload, float(a.timeout), reporter, client)
    if not resp.get("ok"):
        data = {k: resp[k] for k in ("path", "sha256", "verify", "by") if k in resp}
        raise app_failure(resp, data)
    for key in ("path", "sha256"):
        if not isinstance(resp.get(key), str):
            raise KbError(f"the app's export answer has no {key}", EXIT_PROBLEMS)
    stale = changed_since(before, source_state(project))
    if stale:
        resp["staleSources"] = stale
        resp["warnings"] = list(resp.get("warnings") or []) + [
            f"{', '.join(stale)} changed during the export, so this film shows the version from before; rerun kb export to include it"]
    return finish_success(kbctx, project, resp, a.allow_flashes, "editor")


# ── --headless ────────────────────────────────────────────────────────────────


def autorun_dir() -> Path:
    """`~/Kookaburra Cut/_autorun`, the wrapper's queue and run folders (KB_AUTORUN_DIR in tests)."""
    override = os.environ.get("KB_AUTORUN_DIR")
    return Path(override) if override else home() / WORKSPACE_DIR_NAME / "_autorun"


def ticket_pid(path: Path) -> Optional[int]:
    data = read_json(path)
    pid = data.get("pid") if data else None
    return pid if isinstance(pid, int) and not isinstance(pid, bool) else None


class Ticket:
    """A FIFO place in the autorun queue, exactly as scripts/kookaburra-run.sh takes one: `<12-digit epoch>-<pid>.json`,
    sorted names are the order, a ticket whose pid died is swept. Another run's process is never touched."""

    def __init__(self, queue: Path, action: str, project: Project) -> None:
        self.queue = queue
        self.path = queue / f"{int(time.time()):012d}-{os.getpid()}.json"
        self.body = {"pid": os.getpid(), "action": action, "project": project.project_id, "worktree": str(project.root),
                     "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    def write(self) -> None:
        self.queue.mkdir(parents=True, exist_ok=True)
        tmp = self.queue / f".{self.path.name}.tmp"
        tmp.write_text(json.dumps(self.body, separators=(",", ":")) + "\n", encoding="utf-8")
        os.replace(tmp, self.path)

    def sweep(self) -> None:
        for other in self.queue.glob("*.json"):
            if other != self.path and not bridge.pid_alive(ticket_pid(other)):
                try:
                    other.unlink()
                except OSError:
                    pass

    def front(self) -> Optional[Path]:
        names = sorted(self.queue.glob("*.json"))
        return names[0] if names else None

    def wait(self, deadline: float, reporter: Reporter, sleep: Callable[[float], None] = time.sleep) -> None:
        self.write()
        noted = False
        while True:
            self.sweep()
            if not self.path.exists():
                self.write()
            front = self.front()
            if front == self.path:
                return
            if time.monotonic() >= deadline:
                raise KbError(f"another autorun ({front.name if front else '?'}) held the queue past --timeout", EXIT_TRANSIENT,
                              kind="locked", hint="rerun once the other run finishes", retry_after_ms=30_000)
            if not noted and front is not None:
                other = read_json(front) or {}
                reporter.note(f"queued behind {other.get('action', '?')} {other.get('project', '?')} (pid {other.get('pid', '?')})")
                noted = True
            sleep(2.0)

    def release(self) -> None:
        try:
            self.path.unlink()
        except OSError:
            pass


def headless_gate(caps: Dict[str, Any], action: str) -> None:
    """Only a release build that knows stored-only trust, the poster switch and progress may run headless."""
    auto = caps.get("autorun") if isinstance(caps.get("autorun"), dict) else {}
    ok = (caps.get("build") == "release" and action in (auto.get("actions") or []) and "stored-only" in (auto.get("trust") or [])
          and auto.get("poster") is True and auto.get("progress") is True)
    if not ok:
        version = caps.get("appVersion") or "?"
        why = "a development build needs its dev server" if caps.get("build") != "release" else "it predates headless exports"
        raise KbError(f"Kookaburra Cut {version} can't export headless ({why})", EXIT_ENV, kind="env",
                      hint="ask the user to open the project in Kookaburra Cut and drop --headless, or update the app")


def headless_refusal(project: Project) -> None:
    """The open app is the export surface: a live instance on this workspace, or any packaged app (shared caches), refuses."""
    for inst in bridge.instances():
        if inst.serves(project.workspace_root):
            raise KbError("Kookaburra Cut is open on this workspace, so kb export runs through it; drop --headless", EXIT_ENV, kind="usage",
                          hint="./kb export (the user must have this project open)")
        if inst.build == "release":
            raise KbError(f"a packaged Kookaburra Cut is running ({inst.label()}); a headless export would share its caches", EXIT_ENV,
                          kind="env", hint="ask the user to quit Kookaburra Cut, or open this project there and drop --headless")


def headless_aspect(project: Project, a: argparse.Namespace) -> Optional[str]:
    """The aspect the editor would start in (the project's first format), kept when the preset allows it, as the modal keeps it."""
    if a.aspect:
        return str(a.aspect)
    formats = project.manifest().get("formats")
    first = formats[0] if isinstance(formats, list) and formats and isinstance(formats[0], str) else "16:9"
    if not a.preset or a.preset == STANDARD:
        return first
    entry = preset_entry(a.preset)
    if entry is None:
        return None
    allowed = entry.get("aspects") or []
    return first if first in allowed else (entry.get("favouredAspect") or None)


def headless_env(project: Project, a: argparse.Namespace, run_dir: Path, action: str) -> Dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("KOOKABURRA_")}
    env.update({
        "KOOKABURRA_ACTION": action,
        "KOOKABURRA_PROJECT": project.project_id,
        "KOOKABURRA_CODEC": "libx264",
        "KOOKABURRA_RESULT_DIR": str(run_dir),
        "KOOKABURRA_WORKSPACE_ROOT": str(project.workspace_root),
        "KOOKABURRA_TRUST": "stored-only",
        "KOOKABURRA_POSTER": a.poster_frame,
        "KOOKABURRA_PROGRESS": "1",
    })
    aspect = headless_aspect(project, a)
    if aspect:
        env["KOOKABURRA_ASPECT"] = aspect
    if a.preset and a.preset != STANDARD:
        env["KOOKABURRA_PRESET"] = a.preset
    return env


class Run:
    """The headless app: its own process group, so a cancel stops it and nothing else."""

    def __init__(self, argv: List[str], env: Dict[str, str], log: Path) -> None:
        self.log = log
        with open(log, "wb") as out:
            self.proc = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                         start_new_session=True)

    def alive(self) -> bool:
        return self.proc.poll() is None

    def stop(self) -> None:
        if not self.alive():
            return
        for sig, grace in ((signal.SIGTERM, TERM_GRACE_S), (signal.SIGKILL, 2.0)):
            try:
                os.killpg(self.proc.pid, sig)
            except OSError:
                return
            try:
                self.proc.wait(timeout=grace)
                return
            except subprocess.TimeoutExpired:
                continue

    def tail(self, n: int = 12) -> str:
        try:
            lines = self.log.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return ""
        return "\n".join(lines[-n:])


def remove_partials(project: Project) -> None:
    """A killed export leaves `.<stem>.part.<ext>` in exports/ (Rust's partial path); the finished files stay."""
    try:
        for stray in (project.root / "exports").glob(".*.part.*"):
            stray.unlink()
    except OSError:
        pass


def headless_result(project: Project, a: argparse.Namespace, row: Dict[str, Any], aspect: Optional[str]) -> Dict[str, Any]:
    """The bridge answer's shape from the autorun row and kb's own reading of the project and catalogue."""
    path = row.get("path")
    if not isinstance(path, str) or not Path(path).is_file():
        raise KbError("the headless export reported no file", EXIT_PROBLEMS)
    film = Path(path)
    preset = a.preset or STANDARD
    entry = preset_entry(preset)
    poster = row.get("posterFrame") is True
    slots = tl.project_slots(project)
    total_ms = tl.timeline_total_ms(slots)
    fps = row.get("fps") if is_number(row.get("fps")) else (entry or {}).get("fps")
    frames = tl.export_frames(total_ms, float(fps)) + (1 if poster else 0) if fps else None
    aspect_entry = next((x for x in load_catalog().entries("aspects") or [] if x.get("id") == aspect), None)
    width = height = None
    if entry and aspect_entry and is_number(aspect_entry.get("width")) and is_number(aspect_entry.get("height")):
        width, height = rp.out_dims(int(aspect_entry["width"]), int(aspect_entry["height"]), entry.get("shortEdge"))
    timeline = [{"index": s["index"], "stem": s.get("stem"), "startMs": s["startMs"], "endMs": s["endMs"],
                 "durationMs": s["durationMs"], "transitionIn": s.get("transitionIn")} for s in slots]
    return {
        "ok": True, "surface": "headless", "project": project.project_id, "aspect": aspect, "preset": preset,
        "lane": "spec" if preset != STANDARD or poster else "frozen", "codec": (entry or {}).get("codec") or "libx264",
        "fps": int(fps) if fps else None, "width": width, "height": height, "posterFrame": poster, "frames": frames,
        "durationMs": round(frames * 1000.0 / float(fps), 2) if frames and fps else None, "totalMs": total_ms,
        "timeline": timeline, "path": str(film), "bytes": film.stat().st_size, "sha256": file_hash(film),
        "verify": ({"identical": row.get("identical"), "hashA": row.get("hashA"), "hashB": row.get("hashB")} if a.verify else None),
        "flashes": row.get("flashes") if isinstance(row.get("flashes"), dict) else None,
        "warnings": [row["flashesUnavailable"]] if isinstance(row.get("flashesUnavailable"), str) else [],
    }


def headless_export(kbctx: Any, a: argparse.Namespace, reporter: Reporter) -> int:
    from .video import appcli

    project: Project = kbctx.project
    if a.fps is not None or a.short_edge is not None:
        raise KbError("--fps and --short-edge are the Custom panel, which needs the open editor", EXIT_ENV, kind="usage",
                      hint="drop --headless (the user opens the project), or pick a preset: ./kb catalog exportPresets")
    headless_refusal(project)
    info = appcli.locate()
    action = "verify" if a.verify else "export"
    headless_gate(appcli.caps(info), action)
    deadline = time.monotonic() + float(a.timeout)
    queue = Ticket(autorun_dir() / "queue", action, project)
    run: Optional[Run] = None
    try:
        queue.wait(deadline, reporter)
        run_dir = autorun_dir() / "runs" / f"kb-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{os.getpid()}"
        run_dir.mkdir(parents=True, exist_ok=True)
        env = headless_env(project, a, run_dir, action)
        argv = ([CAFFEINATE, "-dimsu"] if os.access(CAFFEINATE, os.X_OK) else []) + [info.path]
        run = Run(argv, env, run_dir / "dev.log")
        result_path, progress_path = run_dir / "last-run.json", run_dir / "progress.json"
        while True:
            result = read_json(result_path)
            if result is not None:
                break
            progress = read_json(progress_path)
            if progress is not None:
                reporter.progress(progress)
            if not run.alive():
                result = read_json(result_path)
                if result is not None:
                    break
                tail = run.tail()
                raise KbError("the headless app exited without a result" + (f"; its log ends:\n{tail}" if tail else ""), EXIT_PROBLEMS,
                              hint=f"see {run.log}")
            if time.monotonic() >= deadline:
                reporter.note(f"--timeout {int(a.timeout)} s reached; stopping the headless export")
                run.stop()
                remove_partials(project)
                raise KbError(f"the headless export did not finish within {int(a.timeout)} s, so kb stopped it", EXIT_PROBLEMS,
                              kind="timeout", hint="rerun with a longer --timeout")
            time.sleep(POLL_S)
    except Interrupted:
        if run is not None:
            reporter.note("interrupted; stopping the headless export")
            run.stop()
            remove_partials(project)
        raise
    finally:
        queue.release()
    if result.get("needsTrust"):
        raise KbError(str(result.get("error") or "the project changed since the user last opened it"), EXIT_ENV, kind="needs-trust",
                      hint="open the project once in Kookaburra Cut (it asks to allow the new code), then rerun")
    rows = [r for r in result.get("results") or [] if isinstance(r, dict)]
    if not result.get("ok") or not rows:
        if rows and a.verify and rows[0].get("identical") is False:
            raise KbError("the two renders were not byte-identical, so this export is not deterministic", EXIT_PROBLEMS,
                          kind="verify-mismatch", data={"verify": {k: rows[0].get(k) for k in ("hashA", "hashB", "divergentCount")}})
        raise KbError(f"the headless export failed: {result.get('error') or 'no result'}", EXIT_PROBLEMS)
    row = rows[0]
    out = headless_result(project, a, row, row.get("aspect") if isinstance(row.get("aspect"), str) else headless_aspect(project, a))
    return finish_success(kbctx, project, out, a.allow_flashes, "headless")


# ── the command ───────────────────────────────────────────────────────────────


def cmd_export(kbctx: Any) -> int:
    a = kbctx.args
    reporter = Reporter(kbctx.json, float(a.progress_every))
    previous = signal.signal(signal.SIGTERM, _raise_interrupt)
    try:
        if a.verify and a.preset:
            entry = preset_entry(a.preset)
            if entry and entry.get("hardware"):
                raise KbError(f"--verify needs a software encoder, and {a.preset} encodes with VideoToolbox (not bit-exact)", EXIT_ENV,
                              kind="usage", hint="drop --verify, or pick a libx264, libx265 or ProRes preset")
        return headless_export(kbctx, a, reporter) if a.headless else bridge_export(kbctx, a, reporter)
    except (Interrupted, KeyboardInterrupt):
        error = KbError("interrupted; the export was cancelled and nothing was saved", EXIT_INTERRUPTED, kind="interrupted",
                        hint="rerun kb export")
        return report_failure(kbctx, error)
    except KbError as e:
        return report_failure(kbctx, e)
    finally:
        signal.signal(signal.SIGTERM, previous)


def report_failure(kbctx: Any, e: KbError) -> int:
    """A stream's last line: the failure envelope as one compact object (the text on stderr either way)."""
    if kbctx.json:
        sys.stdout.write(json.dumps(e.envelope("export"), separators=(",", ":"), ensure_ascii=False) + "\n")
    emit_err(e.text())
    return e.code


def positive(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{raw!r} is not a whole number") from None
    if value <= 0:
        raise argparse.ArgumentTypeError(f"{raw} must be above 0")
    return value


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """Adds `kb export` to kb's top-level subparsers."""
    p = sub.add_parser("export", help="export the film as the app's Export button does (the open project), or --headless",
                       description="export the finished film exactly as Kookaburra Cut's Export button does", epilog=EPILOG,
                       formatter_class=Formatter, parents=[common])
    p.add_argument("--aspect", metavar="A", help="16:9, 9:16, 1:1, 4:5 ... (default: the editor's, as the modal opens)")
    p.add_argument("--preset", metavar="ID", help="an export preset id or ws:<slug> (default: High quality)")
    p.add_argument("--fps", type=int, choices=[30, 60], help="Custom: the frame rate")
    p.add_argument("--short-edge", type=positive, metavar="N", help="Custom: 1440, 1080 or 720 (native without it)")
    p.add_argument("--poster-frame", choices=["on", "off", "app"], default="app", help="the opening poster frame (default: the app's setting)")
    p.add_argument("--verify", action="store_true", help="render twice and compare the two files")
    p.add_argument("--headless", action="store_true", help="the app closed: a packaged release build exports in the background")
    p.add_argument("--allow-flashes", action="store_true", help="exit 0 even when the film fails the flash check")
    p.add_argument("--timeout", type=positive, default=int(DEFAULT_TIMEOUT_S), metavar="SECONDS", help="give up (and cancel) after this long (default 3600)")
    p.add_argument("--progress-every", type=float, default=DEFAULT_PROGRESS_EVERY_S, metavar="SECONDS",
                   help="seconds between progress lines (default 10; stage changes always print)")
    p.set_defaults(fn=cmd_export)
