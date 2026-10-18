"""Who is calling kb: { name, session, agentId } from --agent, the environment and (in hooks) the payload."""

from __future__ import annotations

import os
import re
from typing import Any, Dict, Mapping, Optional

from .util import EXIT_ENV, KbError

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_current: Optional["Caller"] = None


class Caller:
    """name from --agent (or the default); session from CLAUDE_CODE_SESSION_ID; agentId is only known to hooks."""

    __slots__ = ("name", "session", "agent_id")

    def __init__(self, name: str, session: Optional[str] = None, agent_id: Optional[str] = None) -> None:
        self.name = name
        self.session = session
        self.agent_id = agent_id

    def as_dict(self) -> Dict[str, Any]:
        return {"name": self.name, "session": self.session, "agentId": self.agent_id}

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Caller) and self.as_dict() == other.as_dict()

    def __repr__(self) -> str:
        return f"Caller({self.name!r}, session={self.session!r}, agentId={self.agent_id!r})"


def check_name(name: str) -> str:
    if not NAME_RE.match(name):
        raise KbError(
            f'--agent "{name}" is not a usable name; use letters, digits, ".", "_" or "-" (up to 64, e.g. --agent alpha)',
            EXIT_ENV,
            kind="usage",
        )
    return name


def default_name(env: Mapping[str, str]) -> str:
    session = env.get("CLAUDE_CODE_SESSION_ID") or ""
    if session:
        return f"session-{session[:8]}"
    return "claude" if env.get("CLAUDECODE") else "user"


def caller_from(args: Any = None, env: Optional[Mapping[str, str]] = None) -> Caller:
    """--agent NAME, else KB_AGENT (a plain terminal only: inside Claude Code an inherited KB_AGENT would name every agent alike), else the default."""
    env = os.environ if env is None else env
    name = getattr(args, "agent", None) if args is not None else None
    if not name and not env.get("CLAUDECODE"):
        name = env.get("KB_AGENT") or None
    name = check_name(str(name)) if name else default_name(env)
    return Caller(name, env.get("CLAUDE_CODE_SESSION_ID") or None, None)


def bind(caller: Optional[Caller]) -> None:
    """The caller for this kb process, for writers that are not handed one (kb video's re-points)."""
    global _current
    _current = caller


def current() -> Caller:
    return _current if _current is not None else caller_from()
