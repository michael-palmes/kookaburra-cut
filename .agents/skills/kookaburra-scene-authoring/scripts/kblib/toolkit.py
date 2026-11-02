"""kb toolkit: the toolkit reference generated from the app's source (toolkit.json, beside catalog.json)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from .catalog import SKILL_DIR
from .check import did_you_mean
from .util import EXIT_ENV, EXIT_OK, KbError, emit


def reference_path() -> Path:
    return SKILL_DIR / "toolkit.json"


def load_reference() -> Dict[str, Any]:
    try:
        with open(reference_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise KbError(f"toolkit.json is unreadable ({e}); ask the user to reopen the project in Kookaburra Cut", EXIT_ENV)
    if not isinstance(data, dict):
        raise KbError("toolkit.json is not an object", EXIT_ENV)
    return data


def prop_lines(prop: Dict[str, Any]) -> List[str]:
    mark = "" if prop.get("required") else "?"
    head = f"  {prop.get('name')}{mark}: {prop.get('type')}"
    if prop.get("default") is not None:
        head += f"  (default {prop['default']})"
    if prop.get("units"):
        head += f"  [{prop['units']}]"
    lines = [head]
    if prop.get("doc"):
        lines.append(f"      {prop['doc']}")
    return lines


def entry_text(name: str, entry: Dict[str, Any]) -> str:
    lines = [f"{name}  ({entry.get('kind')})"]
    if entry.get("summary"):
        lines.append(str(entry["summary"]))
    if entry.get("signature"):
        lines += ["", str(entry["signature"])]
    props = entry.get("props")
    if isinstance(props, list) and props:
        lines += ["", "Props (types, defaults, units):"]
        for prop in props:
            lines += prop_lines(prop)
    if entry.get("example"):
        lines += ["", "Example:"]
        lines += [f"  {line}" for line in str(entry["example"]).split("\n")]
    timing = entry.get("timing")
    if isinstance(timing, list) and timing:
        lines += ["", "Timing:"]
        lines += [f"  - {line}" for line in timing]
    return "\n".join(lines)


def cmd_toolkit_show(ctx: Any) -> int:
    name = ctx.args.name
    reference = load_reference()
    entry = reference.get(name)
    if not isinstance(entry, dict):
        raise KbError(f'nothing named "{name}" in the toolkit.{did_you_mean(name, reference)} kb toolkit list lists them', 2, kind="usage")
    if ctx.json:
        ctx.out({"name": name, **entry})
        return EXIT_OK
    emit(entry_text(name, entry))
    return EXIT_OK


def cmd_toolkit_list(ctx: Any) -> int:
    kind: Optional[str] = ctx.args.kind
    reference = load_reference()
    rows = [(n, e) for n, e in sorted(reference.items()) if isinstance(e, dict) and (not kind or e.get("kind") == kind)]
    if ctx.json:
        ctx.out({"items": [{"name": n, "kind": e.get("kind"), "summary": e.get("summary")} for n, e in rows]})
        return EXIT_OK
    for name, entry in rows:
        emit(f"{name} ({entry.get('kind')})" + (f" - {entry['summary']}" if entry.get("summary") else ""))
    return EXIT_OK


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    s = sub.add_parser(
        "toolkit",
        help="the @kookaburra/toolkit reference, from the app's source: props, types, defaults, units, examples, timing",
        description="The @kookaburra/toolkit reference, generated from the app's source (toolkit.d.ts holds the same types).",
        epilog="  kb toolkit show AnimatedHeadline\n  kb toolkit show ScreenLayer --json\n  kb toolkit list --kind component",
        formatter_class=Formatter,
        parents=[common],
    )
    verbs = s.add_subparsers(dest="verb", metavar="VERB", required=True)
    show = verbs.add_parser("show", help="one export: props, types, defaults, units, example and timing", parents=[common], formatter_class=Formatter)
    show.add_argument("name", metavar="NAME")
    show.set_defaults(fn=cmd_toolkit_show)
    listing = verbs.add_parser("list", help="every export, one line each", parents=[common], formatter_class=Formatter)
    listing.add_argument("--kind", choices=["component", "hook", "function", "constant", "type"], help="only this kind")
    listing.set_defaults(fn=cmd_toolkit_list)
