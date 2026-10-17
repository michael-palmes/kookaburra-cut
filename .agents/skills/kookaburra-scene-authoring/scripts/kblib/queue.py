"""The capture queue's client side: who is asking, when kb stops waiting, waiting out a throttle, one retry after a GPU stall, and the queue position line (docs/agent-kit.md, "The capture service")."""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Dict, List, Optional

from .util import EXIT_ENV, EXIT_PROBLEMS, EXIT_TRANSIENT, KbError, bridge_dir, now_ms

# An app without the `deadline` feature drops a request nobody claimed after 120 s.
LEGACY_CLAIM_WINDOW_S = 110.0
STALL_MIN_WAIT_S = 2.0
POSITION_EVERY_S = 5.0
HEALTH_EVERY_S = 1.0
# Render window restarts in 10 minutes before the app stops and reports the GPU wedged.
RECYCLE_LIMIT = 3
WEDGED_HINT = "ask the user to quit and reopen Kookaburra Cut (or press Retry captures in the editor)"
STALL_HINT = "rerun once, with the default sheet size or --scale 0.5 and fewer frames"


def client_id(explicit: Optional[str] = None, args: Any = None, env: Optional[Dict[str, str]] = None) -> str:
    """The request's `client`: an explicit name, else the kb caller (--agent, KB_AGENT, session-<8>), else anon."""
    if explicit:
        return explicit
    try:
        from . import identity

        return identity.caller_from(args).name if args is not None else identity.current().name
    except Exception:
        pass
    env = os.environ if env is None else env
    name = getattr(args, "agent", None) or env.get("KB_AGENT")
    if name:
        return str(name)
    session = env.get("CLAUDE_CODE_SESSION_ID") or ""
    return f"session-{session[:8]}" if session else "anon"


def health_of(hb: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    health = hb.get("health") if isinstance(hb, dict) else None
    return health if isinstance(health, dict) else {}


def capture_features(hb: Optional[Dict[str, Any]]) -> List[str]:
    """What the serving app's capture service supports (none for an app that predates it)."""
    feats = health_of(hb).get("captureFeatures")
    return [f for f in feats if isinstance(f, str)] if isinstance(feats, list) else []


def require_features(hb: Optional[Dict[str, Any]], wanted: Dict[str, str]) -> None:
    """Exit 2 when the app lacks a feature a flag needs; `wanted` maps feature to the flag that asked for it."""
    have = capture_features(hb)
    missing = [flag for feature, flag in wanted.items() if feature not in have]
    if missing:
        version = hb.get("appVersion", "?") if isinstance(hb, dict) else "?"
        raise KbError(
            f"the running app (v{version}) does not support {', '.join(missing)}; ask the user to update Kookaburra Cut",
            EXIT_ENV,
            kind="env",
            hint=f"drop {', '.join(missing)}, or ask the user to update Kookaburra Cut",
        )


def recovery_line(health: Dict[str, Any], now: Optional[int] = None) -> Optional[str]:
    """`kb: the app is restarting its render window after a GPU stall (try 2 of 3)` while a stall's backoff runs or no window made since has beaten (`renderWindow.restarting`); None otherwise."""
    gpu = health.get("gpu") if isinstance(health.get("gpu"), dict) else {}
    rw = health.get("renderWindow") if isinstance(health.get("renderWindow"), dict) else {}
    stalls = gpu.get("stallsLast10Min")
    if gpu.get("wedged") or not isinstance(stalls, int) or isinstance(stalls, bool) or stalls < 1:
        return None
    now = now if now is not None else now_ms()
    line = f"kb: the app is restarting its render window after a GPU stall (try {min(stalls, RECYCLE_LIMIT)} of {RECYCLE_LIMIT}"
    until = gpu.get("stalledUntilMs")
    if isinstance(until, (int, float)) and not isinstance(until, bool) and until > now:
        return line + f", in about {max(1, int(round((until - now) / 1000)))} s)"
    return line + ")" if rw.get("restarting") is True else None


def position_line(health: Dict[str, Any], rid: str, now: Optional[int] = None) -> Optional[str]:
    """`kb: queued 3 of 5, about 40 s` while `rid` waits in the app's queue; None once it is served or unknown."""
    queue = health.get("queue") if isinstance(health.get("queue"), dict) else {}
    order = queue.get("order") if isinstance(queue.get("order"), list) else []
    if rid not in order:
        return None
    index = order.index(rid)
    eta = queue.get("etaMs") if isinstance(queue.get("etaMs"), list) else []
    line = f"kb: queued {index + 1} of {len(order)}"
    if index < len(eta) and isinstance(eta[index], (int, float)):
        line += f", about {max(1, int(round(eta[index] / 1000)))} s"
    gpu = health.get("gpu") if isinstance(health.get("gpu"), dict) else {}
    until = gpu.get("stalledUntilMs")
    if isinstance(until, (int, float)) and until > (now if now is not None else now_ms()):
        line += " (the GPU is recovering first)"
    return line


class Policy:
    """One kb request's waiting rules: built before the first write, consulted while kb waits and on every answer."""

    def __init__(self, kind: str, hb: Optional[Dict[str, Any]], timeout: float, client: Optional[str] = None) -> None:
        self.kind = kind
        self.pid = hb.get("pid") if isinstance(hb, dict) else None
        self.features = capture_features(hb)
        self.client = client_id(client)
        self.deadline_at_ms = now_ms() + int(timeout * 1000)
        self.deadline = time.monotonic() + timeout
        self.claim_window_s = float(timeout) if "deadline" in self.features else min(float(timeout), LEGACY_CLAIM_WINDOW_S)
        self.stalls = 0
        self.first_id: Optional[str] = None
        self._line: Optional[str] = None
        self._line_at = 0.0
        self._health_at = 0.0

    def payload(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """Every request names its client and when kb stops waiting (an app without the feature ignores it)."""
        out = dict(body)
        out["client"] = self.client
        out["deadlineAtMs"] = self.deadline_at_ms
        return out

    def _health(self) -> Dict[str, Any]:
        if not isinstance(self.pid, int):
            return {}
        try:
            with open(bridge_dir() / "apps" / f"{self.pid}.json", "r", encoding="utf-8") as f:
                hb = json.load(f)
        except (OSError, ValueError):
            return {}
        return health_of(hb)

    def waiting(self, rid: str) -> None:
        """While kb waits: a render window restart after a GPU stall, else the queue position, on stderr when it changes or every 5 s."""
        if self.first_id is None:
            self.first_id = rid
        now = time.monotonic()
        if now - self._health_at < HEALTH_EVERY_S:
            return
        self._health_at = now
        health = self._health()
        line = recovery_line(health) or position_line(health, rid)
        if line is None:
            return
        position = line.split(",")[0]
        if position != (self._line or "").split(",")[0] or now - self._line_at >= POSITION_EVERY_S:
            sys.stderr.write(line + "\n")
            sys.stderr.flush()
            self._line = line
            self._line_at = now

    def _sleep_within(self, seconds: float) -> bool:
        if time.monotonic() + seconds >= self.deadline:
            return False
        time.sleep(seconds)
        return True

    def after_response(self, resp: Dict[str, Any], rid: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """The request to send again (after waiting), None to take the answer, or a KbError for an answer kb cannot use."""
        if self.first_id is None:
            self.first_id = rid
        error = str(resp.get("error") or "")
        retry_ms = resp.get("retryAfterMs")
        retry_ms = int(retry_ms) if isinstance(retry_ms, (int, float)) and not isinstance(retry_ms, bool) else None
        if resp.get("gpuStalled"):
            if resp.get("wedged"):
                raise KbError(
                    f"Kookaburra Cut's GPU is wedged: {error or 'its render window stalled 3 times in 10 minutes'}",
                    EXIT_ENV,
                    kind="gpu-wedged",
                    hint=WEDGED_HINT,
                )
            self.stalls += 1
            wait = max((retry_ms or 0) / 1000, STALL_MIN_WAIT_S)
            if self.stalls > 1 or not self._sleep_within_note(wait):
                raise KbError(
                    f"the GPU stalled {'again ' if self.stalls > 1 else ''}during the {self.kind} request: {error or 'the render window lost its WebGL context'}",
                    EXIT_TRANSIENT,
                    kind="gpu-stalled",
                    hint=STALL_HINT,
                    retry_after_ms=max(retry_ms or 0, int(STALL_MIN_WAIT_S * 1000)),
                )
            again = dict(payload)
            again["retryOf"] = self.first_id
            return again
        if resp.get("throttled"):
            wait = (retry_ms or 2_000) / 1000
            if not self._sleep_within(wait):
                raise KbError(
                    f"the app throttled the {self.kind} request: {error or 'too many captures at once'}",
                    EXIT_TRANSIENT,
                    kind="throttled",
                    hint=resp.get("hint") if isinstance(resp.get("hint"), str) else None,
                    retry_after_ms=retry_ms or 2_000,
                )
            return dict(payload)
        if resp.get("tooLarge"):
            raise KbError(
                error or f"the {self.kind} request is too large",
                EXIT_PROBLEMS,
                kind="too-large",
                hint=resp.get("hint") if isinstance(resp.get("hint"), str) else None,
                data={k: resp[k] for k in ("units", "maxUnits") if k in resp},
            )
        if resp.get("transient") or resp.get("cancelled"):
            raise KbError(
                error or f"the app dropped the {self.kind} request",
                EXIT_TRANSIENT,
                kind="transient",
                hint=resp.get("hint") if isinstance(resp.get("hint"), str) else "rerun in a moment",
                retry_after_ms=2_000,
            )
        return None

    def _sleep_within_note(self, seconds: float) -> bool:
        if time.monotonic() + seconds >= self.deadline:
            return False
        sys.stderr.write("kb: GPU stalled, render window recycled; retrying once\n")
        sys.stderr.flush()
        time.sleep(seconds)
        return True
