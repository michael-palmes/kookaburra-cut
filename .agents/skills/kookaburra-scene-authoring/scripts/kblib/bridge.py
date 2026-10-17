"""The app bridge: which running app instance serves this project, and the addressed request/response queue."""

from __future__ import annotations

import json
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .project import MANIFEST, Project, find_root
from .util import EXIT_ENV, EXIT_PROBLEMS, EXIT_TRANSIENT, KbError, bridge_dir, now_ms

HEARTBEAT_FRESH_MS = 30_000
POLL_S = 0.25
PID_CHECK_S = 1.0
BUSY_RETRY_S = 2.0
MAX_FRAMES = 48
DEFAULT_RESOURCES = Path("/Applications/Kookaburra Cut.app/Contents/Resources")

_bound: Optional[Project] = None


def bind(project: Optional[Project]) -> None:
    """The project this kb process works on; requests and the election use its workspace root."""
    global _bound
    _bound = project


def bound_project() -> Optional[Project]:
    if _bound is not None:
        return _bound
    try:
        return Project(find_root())
    except KbError:
        return None


def _project_for(body: Optional[Dict[str, Any]] = None, project: Optional[Project] = None) -> Optional[Project]:
    """The project a request is about: the caller's, the body's projectPath, the bound one, else the cwd's."""
    if project is not None:
        return project
    path = body.get("projectPath") if isinstance(body, dict) else None
    if isinstance(path, str) and path and (Path(path) / MANIFEST).is_file():
        return Project(Path(path))
    return bound_project()


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _read_app_json() -> Optional[Dict[str, Any]]:
    return _read_json(bridge_dir() / "app.json")


def pid_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def app_alive(hb: Optional[Dict[str, Any]]) -> bool:
    if not hb:
        return False
    updated = hb.get("updatedAtMs")
    if not isinstance(updated, (int, float)) or now_ms() - updated > HEARTBEAT_FRESH_MS:
        return False
    return pid_alive(hb.get("pid"))


def same_dir(a: Any, b: Any) -> bool:
    """One folder by device and inode, so case, symlinks and firmlinks never split a workspace root."""
    try:
        sa, sb = os.stat(str(a)), os.stat(str(b))
    except (OSError, ValueError):
        return False
    return sa.st_dev == sb.st_dev and sa.st_ino == sb.st_ino and os.path.isdir(str(a))


class Instance:
    """One live app process, from its `apps/<pid>.json` heartbeat (or, from an older app, `app.json`)."""

    def __init__(self, hb: Dict[str, Any]) -> None:
        self.hb = hb
        role = hb.get("bridge")
        # Apps before per-process heartbeats serve every request they see and cannot be addressed by pid.
        self.legacy = not isinstance(role, dict)
        self.pid: int = hb.get("pid") if isinstance(hb.get("pid"), int) else -1
        self.serving = True if self.legacy else bool(role.get("serving"))  # type: ignore[union-attr]
        reason = None if self.legacy else role.get("reason")  # type: ignore[union-attr]
        self.reason: Optional[str] = reason if isinstance(reason, str) else None
        root = hb.get("workspaceRoot")
        self.root: Optional[str] = root if isinstance(root, str) and root else None
        self.build = hb.get("build")
        started = hb.get("startedAtMs")
        self.started_at_ms: Optional[int] = started if isinstance(started, int) and not isinstance(started, bool) else None

    def on_root(self, root: Optional[Path]) -> bool:
        return root is None or (self.root is not None and same_dir(self.root, root))

    def serves(self, root: Optional[Path]) -> bool:
        return self.serving and self.on_root(root)

    def label(self) -> str:
        bits = [f"pid {self.pid}", str(self.build or "?"), str(self.hb.get("appVersion") or "?")]
        if self.hb.get("bundleId"):
            bits.append(str(self.hb["bundleId"]))
        return " ".join(bits)

    def why_not(self, root: Optional[Path]) -> str:
        if not self.serving:
            return f"bridge off: {self.reason or 'not serving'}"
        if self.root is None:
            return "no workspace configured"
        return "serves another workspace" if not self.on_root(root) else "serves this workspace"


def instances() -> List[Instance]:
    """Every live instance: fresh `apps/*.json` heartbeats with a live pid, plus a live `app.json` whose writer has none (an older app)."""
    out: List[Instance] = []
    seen = set()
    try:
        entries = sorted(p for p in (bridge_dir() / "apps").iterdir() if p.suffix == ".json" and not p.name.startswith("."))
    except OSError:
        entries = []
    for path in entries:
        hb = _read_json(path)
        if hb is None or not app_alive(hb) or hb.get("pid") in seen:
            continue
        seen.add(hb.get("pid"))
        out.append(Instance(hb))
    primary = _read_app_json()
    if primary is not None and app_alive(primary) and primary.get("pid") not in seen:
        out.append(Instance(primary))
    return out


def elect(candidates: List[Instance], root: Optional[Path], project_id: Optional[str]) -> Optional[Instance]:
    """The serving instance kb addresses: the one with the project open, then release over dev, then the earliest start, then the lowest pid."""
    serving = [i for i in candidates if i.serves(root)]
    if not serving:
        return None

    def rank(i: Instance) -> Any:
        open_here = project_id is not None and i.hb.get("openProject") == project_id
        started = i.started_at_ms if i.started_at_ms is not None else float("inf")
        return (not open_here, i.build != "release", started, i.pid)

    return min(serving, key=rank)


def serving_for(root: Optional[Path], project_id: Optional[str]) -> Optional[Instance]:
    return elect(instances(), root, project_id)


def chosen(project: Optional[Project] = None) -> Optional[Instance]:
    """The elected instance for this project (any serving instance when kb runs outside a project)."""
    project = _project_for(None, project)
    if project is None:
        return serving_for(None, None)
    return serving_for(project.workspace_root, project.project_id)


def live_heartbeat(project: Optional[Project] = None) -> Optional[Dict[str, Any]]:
    """The heartbeat of the instance that serves this project, or None."""
    inst = chosen(project)
    return inst.hb if inst else None


def read_heartbeat(project: Optional[Project] = None) -> Optional[Dict[str, Any]]:
    """The serving instance's heartbeat, else whatever `app.json` last said (stale is fine for locating resources)."""
    return live_heartbeat(project) or _read_app_json()


def instance_rows(project: Optional[Project] = None) -> List[Dict[str, Any]]:
    """Every live instance for kb status, the elected one first."""
    project = _project_for(None, project)
    root = project.workspace_root if project else None
    found = instances()
    pick = elect(found, root, project.project_id if project else None)
    now = now_ms()
    rows: List[Dict[str, Any]] = []
    for i in found:
        updated = i.hb.get("updatedAtMs")
        rows.append({
            "pid": i.pid,
            "bundleId": i.hb.get("bundleId"),
            "build": i.build,
            "appVersion": i.hb.get("appVersion"),
            "workspaceRoot": i.root,
            "serving": i.serving,
            "reason": i.reason,
            "servesThisProject": i.serves(root),
            "chosen": i is pick,
            "openProject": i.hb.get("openProject"),
            "startedAtMs": i.started_at_ms,
            "updatedAgoMs": max(0, now - int(updated)) if isinstance(updated, (int, float)) else None,
            "exePath": i.hb.get("exePath"),
            "legacy": i.legacy,
        })
    rows.sort(key=lambda r: (not r["chosen"], not r["servesThisProject"], not r["serving"], r["pid"]))
    return rows


def resources_dir(hb: Optional[Dict[str, Any]] = None) -> Path:
    override = os.environ.get("KB_RESOURCES_DIR")
    if override:
        return Path(override)
    hb = hb if hb is not None else read_heartbeat()
    if hb and isinstance(hb.get("resourcesDir"), str) and Path(hb["resourcesDir"]).is_dir():
        return Path(hb["resourcesDir"])
    for candidate in (DEFAULT_RESOURCES, Path(os.path.expanduser("~/Applications/Kookaburra Cut.app/Contents/Resources"))):
        if candidate.is_dir():
            return candidate
    return DEFAULT_RESOURCES


def _hb_dir(hb: Optional[Dict[str, Any]], key: str) -> Optional[Path]:
    value = hb.get(key) if isinstance(hb, dict) else None
    return Path(value) if isinstance(value, str) and value and Path(value).is_dir() else None


def presets_dir(hb: Optional[Dict[str, Any]] = None) -> Path:
    """Bundled presets: the heartbeat's presetsDir (dev and release), else <resources>/presets."""
    if os.environ.get("KB_RESOURCES_DIR"):
        return resources_dir() / "presets"
    hb = hb if hb is not None else read_heartbeat()
    return _hb_dir(hb, "presetsDir") or resources_dir(hb) / "presets"


def preset_previews_dir(hb: Optional[Dict[str, Any]] = None) -> Path:
    if os.environ.get("KB_RESOURCES_DIR"):
        return resources_dir() / "preset-previews"
    hb = hb if hb is not None else read_heartbeat()
    return _hb_dir(hb, "presetPreviewsDir") or resources_dir(hb) / "preset-previews"


def samples_dir(hb: Optional[Dict[str, Any]] = None) -> Path:
    """The sample media pool bundled presets fall back to (projects/_samples beside presets/)."""
    return presets_dir(hb).parent / "projects" / "_samples"


def not_running_message(action: str) -> str:
    hb = _read_app_json()
    if hb is None:
        why = "no heartbeat at ~/Kookaburra Cut/_bridge/app.json"
    elif not pid_alive(hb.get("pid")):
        why = "its last heartbeat names a process that has exited"
    else:
        why = f"its heartbeat is stale (updated {int((now_ms() - (hb.get('updatedAtMs') or 0)) / 1000)} s ago)"
    return f"Kookaburra Cut is not running ({why}). {action} needs the app: ask the user to open it, then rerun."


def no_app_error(action: str, project: Optional[Project]) -> KbError:
    """No live instance serves this project's root: name the live ones and why each does not serve."""
    live = instances()
    if not live:
        return KbError(not_running_message(action), EXIT_ENV, kind="no-app")
    root = project.workspace_root if project else None
    where = f" ({root})" if root else ""
    listed = "; ".join(f"{i.label()} on {i.root or 'no workspace'} ({i.why_not(root)})" for i in live)
    return KbError(
        f"no running Kookaburra Cut serves this project's workspace{where}. Live: {listed}. {action} needs the app on this workspace.",
        EXIT_ENV,
        kind="no-app",
        hint="ask the user to open this project in Kookaburra Cut (the installed app), then rerun; ./kb status lists the instances",
        data={"instances": instance_rows(project)},
    )


def _require_instance(kind: str, action: str, project: Optional[Project]) -> Instance:
    inst = chosen(project) if project is not None else serving_for(None, None)
    if inst is None:
        raise no_app_error(action, project)
    kinds = inst.hb.get("kinds")
    if isinstance(kinds, list) and kind not in kinds:
        raise KbError(f"the running app (v{inst.hb.get('appVersion', '?')}) does not answer {kind} requests; ask the user to update Kookaburra Cut", EXIT_ENV)
    return inst


def require_app(kind: str, action: str, project: Optional[Project] = None) -> Dict[str, Any]:
    return _require_instance(kind, action, _project_for(None, project)).hb


def new_id() -> str:
    return f"{now_ms():016d}-{os.getpid()}-{secrets.token_hex(3)}"


def write_request(body: Dict[str, Any]) -> str:
    rid = new_id()
    payload = dict(body)
    payload["version"] = 2
    payload["id"] = rid
    payload["requestedAtMs"] = now_ms()
    requests = bridge_dir() / "requests"
    requests.mkdir(parents=True, exist_ok=True)
    tmp = requests / f".{rid}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, requests / f"{rid}.json")
    return rid


def address(body: Dict[str, Any], inst: Instance, project: Optional[Project], client: Optional[str] = None) -> Dict[str, Any]:
    """The request as sent: the workspace root and project folder kb works in, the elected pid (not for an older app) and the caller."""
    payload = dict(body)
    if project is not None:
        where = project.address()
        payload.setdefault("workspaceRoot", where["workspaceRoot"])
        if payload.get("project") == project.project_id:
            payload.setdefault("projectPath", where["projectPath"])
    if not inst.legacy:
        payload["instancePid"] = inst.pid
    if client:
        payload["client"] = client
    return payload


def served_line(resp: Any) -> Optional[str]:
    """Which instance answered, for a stderr note; None for an older app."""
    served = resp.get("servedBy") if isinstance(resp, dict) else None
    if not isinstance(served, dict):
        return None
    return (
        f"served by Kookaburra Cut {served.get('appVersion', '?')} ({served.get('build', '?')}, "
        f"pid {served.get('pid', '?')}, {served.get('bundleId', '?')})"
    )


def check_served_by(resp: Dict[str, Any], kind: str, project: Optional[Project]) -> None:
    """An answer from an instance on another workspace is wrong by construction: discard it."""
    served = resp.get("servedBy")
    if project is None or not isinstance(served, dict) or "workspaceRoot" not in served:
        return
    root = served.get("workspaceRoot")
    if isinstance(root, str) and same_dir(root, project.workspace_root):
        return
    raise KbError(
        f"Kookaburra Cut pid {served.get('pid', '?')} answered the {kind} request from {root or 'no workspace'}, "
        f"not this project's workspace ({project.workspace_root}); kb discarded the answer",
        EXIT_ENV,
        kind="no-app",
        hint="another Kookaburra Cut instance answered; check ./kb status, then rerun",
    )


def _cleanup(rid: str) -> None:
    for path in (bridge_dir() / "requests" / f"{rid}.json", bridge_dir() / "requests" / ".claimed" / f"{rid}.json"):
        try:
            path.unlink()
        except OSError:
            pass


def _quit_error(inst: Instance, kind: str) -> KbError:
    return KbError(f"Kookaburra Cut ({inst.label()}) quit while kb waited for the {kind} request", EXIT_ENV, kind="no-app")


def request(kind: str, body: Dict[str, Any], timeout: float, action: str, client: Optional[str] = None) -> Dict[str, Any]:
    """Send one request to the instance that serves this project and wait for its answer; retries while it is busy exporting, and the capture queue's policy (kblib/queue.py) adds the deadline, throttle waits and one retry after a GPU stall."""
    from . import queue

    project = _project_for(body)
    inst = _require_instance(kind, action, project)
    deadline = time.monotonic() + timeout
    policy = queue.Policy(kind, inst.hb, timeout, client)
    payload = policy.payload(address(dict(body, kind=kind), inst, project, policy.client))
    rid = write_request(payload)
    sent = time.monotonic()
    checked = sent
    claimed = False
    busy_note: Optional[str] = None
    responses = bridge_dir() / "responses"
    while time.monotonic() < deadline:
        path = responses / f"{rid}.json"
        if path.is_file():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    resp = json.load(f)
            except (OSError, ValueError):
                time.sleep(POLL_S)
                continue
            if not isinstance(resp, dict):
                raise KbError(f"the app answered {kind} with something that is not a JSON object", EXIT_PROBLEMS)
            check_served_by(resp, kind, project)
            again = policy.after_response(resp, rid, payload)
            if again is not None:
                rid = write_request(again)
                sent = time.monotonic()
                claimed = False
                continue
            if resp.get("busy"):
                busy_note = str(resp.get("error") or "the app is busy")
                time.sleep(BUSY_RETRY_S)
                if not pid_alive(inst.pid):
                    raise _quit_error(inst, kind)
                rid = write_request(payload)
                sent = time.monotonic()
                claimed = False
                continue
            if resp.get("needsTrust"):
                raise KbError(
                    str(resp.get("error") or "the app needs the user to open this project once to trust its code"),
                    EXIT_ENV,
                    kind="needs-trust",
                )
            return resp
        now = time.monotonic()
        if now - checked >= PID_CHECK_S:
            checked = now
            if not pid_alive(inst.pid):
                _cleanup(rid)
                raise _quit_error(inst, kind)
        if not claimed and not (bridge_dir() / "requests" / f"{rid}.json").exists():
            claimed = True
        if not claimed and now - sent > policy.claim_window_s:
            break
        policy.waiting(rid)
        time.sleep(POLL_S)
    _cleanup(rid)
    if busy_note:
        raise KbError(f"{busy_note}; still busy after {int(timeout)} s", EXIT_TRANSIENT, kind="app-busy", retry_after_ms=10_000)
    if not pid_alive(inst.pid):
        raise _quit_error(inst, kind)
    if claimed:
        raise KbError(
            f"the app is still working on the {kind} request after {int(timeout)} s (a many-frame sheet or a render check of a large project takes the longest)",
            EXIT_TRANSIENT,
            kind="bridge-timeout",
            hint="rerun with --timeout 600",
            retry_after_ms=5_000,
        )
    raise KbError(
        f"the app did not pick up the {kind} request within {int(policy.claim_window_s)} s; it may still be busy with an earlier request, or its window is stuck",
        EXIT_TRANSIENT,
        kind="bridge-timeout",
        hint="rerun shortly; if it keeps happening, ask the user to check Kookaburra Cut",
        retry_after_ms=5_000,
    )


def notify(kind: str, body: Dict[str, Any], timeout: float = 30, warn: Any = None) -> Optional[Dict[str, Any]]:
    """A soft request: the app's answer, or None (after warn(reason)) when no instance serves it, it lacks the kind or fails."""
    say = warn or (lambda text: sys.stderr.write(f"kb: note: {text}\n"))
    project = _project_for(body)
    inst = chosen(project) if project is not None else serving_for(None, None)
    if inst is None:
        if instances():
            say("no running Kookaburra Cut serves this project's workspace; it picks the change up when it next opens the project")
        else:
            say("Kookaburra Cut is not running; it picks the change up when it next opens the project")
        return None
    kinds = inst.hb.get("kinds")
    if isinstance(kinds, list) and kind not in kinds:
        say(f"the running app (v{inst.hb.get('appVersion', '?')}) does not take {kind} requests; it refreshes on its next reload (ask the user to update Kookaburra Cut)")
        return None
    try:
        resp = request(kind, body, timeout, f"kb {kind}")
    except KbError as e:
        say(f"the app did not take the {kind} request: {e.message}")
        return None
    if not resp.get("ok"):
        say(f"the app rejected the {kind} request: {resp.get('error') or 'no reason given'}")
        return None
    return resp


def require_ok(resp: Dict[str, Any], kind: str) -> Dict[str, Any]:
    if resp.get("ok"):
        return resp
    raise KbError(f"the app rejected the {kind} request: {resp.get('error') or 'no reason given'}", EXIT_PROBLEMS)


def frames_arg(spec: str) -> List[Dict[str, Any]]:
    """"S@T,S@T" -> [{scene, at}]; T is seconds into the scene."""
    out: List[Dict[str, Any]] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "@" in part:
            scene, at = part.rsplit("@", 1)
            try:
                seconds = float(at)
            except ValueError:
                raise KbError(f'--frames "{part}": the time after @ must be seconds, e.g. 3@1.5', 2) from None
            out.append({"scene": scene.strip(), "at": seconds})
        else:
            out.append({"scene": part})
    if not out:
        raise KbError('--frames needs scene@seconds pairs, e.g. "0@1,3@2.5"', 2)
    if len(out) > MAX_FRAMES:
        raise KbError(f"--frames takes at most {MAX_FRAMES} frames per request; split it", 2)
    return out
