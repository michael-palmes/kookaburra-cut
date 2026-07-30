#!/usr/bin/env python3
"""Capture one deterministic frame from the RUNNING Kookaburra Cut app (dev or packaged).

Writes a request into ~/Kookaburra Cut/_bridge/requests/ and polls for the app's
response; the app renders the frame through its export path and answers with a PNG.
The requested project must be the one open in the app window.

    python3 capture.py                       # current playhead of this project
    python3 capture.py --scene 01-hero --at 1.5
    python3 capture.py --scene 2             # scene by index, midpoint
    python3 capture.py --timeout 45

Prints the PNG path on success (exit 0); exit 1 = the app rejected the request,
exit 2 = no response before the timeout (is the app running?).
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

BRIDGE = Path.home() / "Kookaburra Cut" / "_bridge"
POLL_S = 0.3
BUSY_RETRY_S = 2.0


def app_running() -> bool:
    try:
        out = subprocess.run(
            ["pgrep", "-if", "kookaburra"], capture_output=True, timeout=5
        )
        return out.returncode == 0
    except Exception:
        return True  # best effort only; never block on the check


def write_request(project: str | None, scene: str | None, at: float | None) -> str:
    rid = f"{int(time.time() * 1000):013d}-{os.getpid()}-{secrets.token_hex(3)}"
    body = {
        "version": 1,
        "id": rid,
        "project": project,
        "scene": scene,
        "at": at,
        "requestedAtMs": int(time.time() * 1000),
    }
    requests = BRIDGE / "requests"
    requests.mkdir(parents=True, exist_ok=True)
    tmp = requests / f".{rid}.tmp"
    tmp.write_text(json.dumps(body))
    tmp.rename(requests / f"{rid}.json")
    return rid


def cleanup(rid: str) -> None:
    for path in (
        BRIDGE / "requests" / f"{rid}.json",
        BRIDGE / "requests" / ".claimed" / f"{rid}.json",
    ):
        try:
            path.unlink()
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", help="scene index or file stem (default: whole-project time)")
    parser.add_argument("--at", type=float, help="seconds into the scene (or project)")
    parser.add_argument("--project", help='override the project id (default: "ws:<this folder>")')
    parser.add_argument("--timeout", type=float, default=30, help="seconds to wait (default 30)")
    args = parser.parse_args()

    project = args.project or f"ws:{Path.cwd().name}"
    if not app_running():
        print("no Kookaburra Cut process detected; start the app first", file=sys.stderr)
        return 2

    deadline = time.time() + args.timeout
    rid = write_request(project, args.scene, args.at)
    response = BRIDGE / "responses"
    while time.time() < deadline:
        path = response / f"{rid}.json"
        if path.is_file():
            try:
                body = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                time.sleep(POLL_S)
                continue
            if body.get("ok"):
                print(body["path"])
                return 0
            if body.get("busy"):
                # The app is mid-export: resubmit after a breather, within the budget.
                time.sleep(BUSY_RETRY_S)
                rid = write_request(project, args.scene, args.at)
                continue
            print(body.get("error", "the app rejected the capture"), file=sys.stderr)
            return 1
        time.sleep(POLL_S)
    cleanup(rid)
    print("no response from Kookaburra Cut before the timeout; is the app running?", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
