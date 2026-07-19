#!/usr/bin/env python3
"""Inspect (and for workspace themes, edit) the project's theme tokens.

Run from a project folder:
    theme.py show                              # resolved theme id + tokens
    theme.py set <dotted.path> <value>         # workspace (ws:) themes only

Examples:
    theme.py show
    theme.py set colors.accent "#ff5a36"
    theme.py set typography.headline '{"family": "Avenir Next", "weight": 600}'

Bundled kookaburra-* themes ship inside the app and are not editable on disk;
duplicate one into a workspace theme in the app (Theme ▸ Manage) first.
"""

import json
import sys
from pathlib import Path


def theme_path(theme_id: str) -> Path | None:
    if theme_id.startswith("ws:"):
        # A project folder sits at <workspace>/<slug>, themes at <workspace>/themes/<slug>.
        return Path("..") / "themes" / theme_id[3:] / "theme.json"
    return None


def main() -> int:
    manifest_path = Path("project.json")
    if not manifest_path.is_file():
        print("theme: no project.json here; run from a project folder", file=sys.stderr)
        return 2
    theme_id = json.loads(manifest_path.read_text()).get("themeId", "")
    path = theme_path(theme_id)
    op = sys.argv[1] if len(sys.argv) > 1 else "show"

    if op == "show":
        print(f"Theme: {theme_id}")
        if path is None:
            print("(bundled theme; tokens live in the app, not on disk — duplicate it to edit)")
            return 0
        if not path.is_file():
            print(f"theme: {path} is missing", file=sys.stderr)
            return 1
        text = path.read_text()
        json.loads(text)  # validate before showing
        print(path.resolve())
        print(text)
        return 0

    if op == "set":
        if len(sys.argv) < 4:
            print(__doc__, file=sys.stderr)
            return 2
        if path is None:
            print(f"theme: {theme_id} is bundled and not editable; duplicate it in the app first", file=sys.stderr)
            return 1
        if not path.is_file():
            print(f"theme: {path} is missing", file=sys.stderr)
            return 1
        doc = json.loads(path.read_text())
        node = doc
        parts = sys.argv[2].split(".")
        for part in parts[:-1]:
            nxt = node.get(part)
            if not isinstance(nxt, dict):
                nxt = {}
                node[part] = nxt
            node = nxt
        raw = sys.argv[3]
        try:
            node[parts[-1]] = json.loads(raw)
        except json.JSONDecodeError:
            node[parts[-1]] = raw
        path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
        print(f"theme: wrote {path}")
        return 0

    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
