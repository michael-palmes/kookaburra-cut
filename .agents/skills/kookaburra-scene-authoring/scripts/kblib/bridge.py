"""The app bridge (v2): heartbeat detection and the file-drop request/response queue."""

from __future__ import annotations

import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .util import EXIT_ENV, EXIT_PROBLEMS, KbError, bridge_dir, now_ms

HEARTBEAT_FRESH_MS = 30_000
POLL_S = 0.25
BUSY_RETRY_S = 2.0
CLAIM_WINDOW_S = 110.0
MAX_FRAMES = 48
DEFAULT_RESOURCES = Path("/Applications/Kookaburra Cut.app/Contents/Resources")


def read_heartbeat() -> Optional[Dict[str, Any]]:
    try:
        with open(bridge_dir() / "app.json", "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


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


def live_heartbeat() -> Optional[Dict[str, Any]]:
    hb = read_heartbeat()
    return hb if app_alive(hb) else None


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
    hb = read_heartbeat()
    if hb is None:
        why = "no heartbeat at ~/Kookaburra Cut/_bridge/app.json"
    elif not pid_alive(hb.get("pid")):
        why = "its last heartbeat names a process that has exited"
    else:
        why = f"its heartbeat is stale (updated {int((now_ms() - (hb.get('updatedAtMs') or 0)) / 1000)} s ago)"
    return f"Kookaburra Cut is not running ({why}). {action} needs the app: ask the user to open it, then rerun."


def require_app(kind: str, action: str) -> Dict[str, Any]:
    hb = live_heartbeat()
    if hb is None:
        raise KbError(not_running_message(action), EXIT_ENV)
    kinds = hb.get("kinds")
    if isinstance(kinds, list) and kind not in kinds:
        raise KbError(f"the running app (v{hb.get('appVersion', '?')}) does not answer {kind} requests; ask the user to update Kookaburra Cut", EXIT_ENV)
    return hb


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


def _cleanup(rid: str) -> None:
    for path in (bridge_dir() / "requests" / f"{rid}.json", bridge_dir() / "requests" / ".claimed" / f"{rid}.json"):
        try:
            path.unlink()
        except OSError:
            pass


def request(kind: str, body: Dict[str, Any], timeout: float, action: str) -> Dict[str, Any]:
    """Send one request and wait for its answer; retries while the app is busy exporting."""
    require_app(kind, action)
    deadline = time.monotonic() + timeout
    payload = dict(body, kind=kind)
    rid = write_request(payload)
    sent = time.monotonic()
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
            if resp.get("busy"):
                busy_note = str(resp.get("error") or "the app is busy")
                time.sleep(BUSY_RETRY_S)
                if live_heartbeat() is None:
                    raise KbError(not_running_message(action), EXIT_ENV)
                rid = write_request(payload)
                sent = time.monotonic()
                claimed = False
                continue
            if resp.get("needsTrust"):
                raise KbError(str(resp.get("error") or "the app needs the user to open this project once to trust its code; ask them to, then rerun"), EXIT_ENV)
            return resp
        if not claimed and not (bridge_dir() / "requests" / f"{rid}.json").exists():
            claimed = True
        if not claimed and time.monotonic() - sent > CLAIM_WINDOW_S:
            break
        time.sleep(POLL_S)
    _cleanup(rid)
    if busy_note:
        raise KbError(f"{busy_note}; still busy after {int(timeout)} s. Wait for the export to finish, then rerun", EXIT_ENV)
    if live_heartbeat() is None:
        raise KbError(not_running_message(action), EXIT_ENV)
    if claimed:
        raise KbError(f"the app is still working on the {kind} request after {int(timeout)} s (a many-frame sheet or a render check of a large project takes the longest); rerun with --timeout 600", EXIT_ENV)
    raise KbError(f"the app did not pick up the {kind} request within {int(min(timeout, CLAIM_WINDOW_S))} s; it may still be busy with an earlier request (rerun shortly) or its window is stuck (ask the user to check Kookaburra Cut)", EXIT_ENV)


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
