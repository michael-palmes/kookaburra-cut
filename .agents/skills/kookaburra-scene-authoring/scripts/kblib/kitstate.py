"""The kit as this project has it: is the shim there, is it the app's, and which writes only the app may make.

Light enough for the UserPromptSubmit and Bash hooks. Only the app restores the kit: a hand-made ./kb has no marker, so the
stamp takes it for the person's own and the project stops healing.
"""

from __future__ import annotations

import os
from typing import List, Optional

SHIM = "kb"
SHIM_MARKER = "# kookaburra-cut kb shim"
KB_PY = ".claude/skills/kookaburra-scene-authoring/scripts/kb.py"
MANAGED = (".claude/skills/kookaburra-scene-authoring", ".claude/skills/kookaburra-video-editing", ".claude/skills/kookaburra-brand-packs")
REPLACED = (".kb", "kit-replaced")
RESTORE = "Ask the person to reopen the project in Kookaburra Cut, which restores it; never rebuild it by hand."


def shim_state(root: str) -> str:
    """missing, app (carries the marker) or own (anything else at that name, which the app leaves alone)."""
    path = os.path.join(root, SHIM)
    if not os.path.lexists(path):
        return "missing"
    if os.path.islink(path) or not os.path.isfile(path):
        return "own"
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            head = [f.readline() for _ in range(3)]
    except OSError:
        return "own"
    return "app" if any(line.startswith(SHIM_MARKER) for line in head) else "own"


def missing_shim_lines(root: str) -> List[str]:
    """A stamped kit that lost its shim. An unstamped copy (no kit.json) never had one, so it says nothing."""
    if shim_state(root) != "missing" or not os.path.isfile(os.path.join(root, MANAGED[0], "kit.json")):
        return []
    return [f"./kb is missing from this project. {RESTORE} Until then run python3 -I {KB_PY} <command>."]


def replaced_note(root: str) -> Optional[str]:
    """The newest set of edited kit files a restamp kept aside."""
    folder = os.path.join(root, *REPLACED)
    try:
        stamps = [name for name in os.listdir(folder) if name.isdigit()]
    except OSError:
        return None
    if not stamps:
        return None
    newest = max(stamps, key=int)
    return f"The app restored edited kit files and kept the edits at {'/'.join(REPLACED)}/{newest}; the kit is managed, so project notes belong in CLAUDE.md"


def problem_lines(root: str) -> List[str]:
    """For kb status and the session briefing."""
    lines = missing_shim_lines(root)
    if shim_state(root) == "own":
        lines.append("./kb is not the app's shim, so don't run it. The app moves it to kb.moved-aside and writes its own when the project next opens: ask the person to reopen it in Kookaburra Cut.")
    note = replaced_note(root)
    if note:
        lines.append(note)
    return lines


def write_reason(root: str, rel: str) -> Optional[str]:
    """Why a hand write to the shim or a managed skill is refused. A kb that isn't the app's is the app's to move aside, not kb's to guard."""
    # APFS opens any case-folded spelling as the same file.
    folded = rel.casefold()
    if folded == SHIM and shim_state(root) != "own":
        return f"./kb is the app's shim. {RESTORE}"
    for skill in MANAGED:
        if folded == skill or folded.startswith(skill + "/"):
            return f"{rel} is the managed kit; the app replaces it, so edits are lost. {RESTORE} Project notes belong in CLAUDE.md."
    return None
