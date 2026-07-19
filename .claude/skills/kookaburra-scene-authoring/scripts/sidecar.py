#!/usr/bin/env python3
"""Read or edit a scene sidecar (scenes/<stem>.json) without hand-editing JSON.

Run from a project folder:
    sidecar.py <stem> get [dotted.path]
    sidecar.py <stem> set <dotted.path> <value>     # value parsed as JSON, else kept as a string
    sidecar.py <stem> unset <dotted.path>

Examples:
    sidecar.py 01-hero get
    sidecar.py 01-hero set text.title "Make it move"
    sidecar.py 01-hero set textStyle.titleSize 1.25
    sidecar.py 01-hero set background '{"type": "color", "color": "#101418"}'
    sidecar.py 01-hero unset textStyle.titleColor
"""

import json
import sys
from pathlib import Path


def resolve(doc: dict, parts: list[str], create: bool) -> tuple[dict, str] | None:
    node = doc
    for part in parts[:-1]:
        nxt = node.get(part)
        if not isinstance(nxt, dict):
            if not create:
                return None
            nxt = {}
            node[part] = nxt
        node = nxt
    return node, parts[-1]


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    stem, op = sys.argv[1], sys.argv[2]
    path = Path("scenes") / f"{stem}.json"
    if op == "get":
        if not path.is_file():
            print(f"sidecar: {path} does not exist", file=sys.stderr)
            return 2
        doc = json.loads(path.read_text())
        if len(sys.argv) > 3:
            hit = resolve(doc, sys.argv[3].split("."), create=False)
            value = hit[0].get(hit[1]) if hit else None
            print(json.dumps(value, indent=2, ensure_ascii=False))
        else:
            print(json.dumps(doc, indent=2, ensure_ascii=False))
        return 0
    if op in ("set", "unset"):
        if op == "set" and len(sys.argv) < 5:
            print("sidecar: set needs <dotted.path> <value>", file=sys.stderr)
            return 2
        doc = json.loads(path.read_text()) if path.is_file() else {"version": 1}
        parts = sys.argv[3].split(".")
        if op == "set":
            raw = sys.argv[4]
            try:
                value = json.loads(raw)
            except json.JSONDecodeError:
                value = raw
            node, leaf = resolve(doc, parts, create=True)
            node[leaf] = value
        else:
            hit = resolve(doc, parts, create=False)
            if not hit or hit[1] not in hit[0]:
                print(f"sidecar: {sys.argv[3]} is not set", file=sys.stderr)
                return 1
            del hit[0][hit[1]]
            if not hit[0] and len(parts) > 1:
                # Drop a now-empty parent map so the doc stays tidy.
                parent = resolve(doc, parts[:-1], create=False)
                if parent and isinstance(parent[0].get(parent[1]), dict) and not parent[0][parent[1]]:
                    del parent[0][parent[1]]
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
        print(f"sidecar: wrote {path}")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
