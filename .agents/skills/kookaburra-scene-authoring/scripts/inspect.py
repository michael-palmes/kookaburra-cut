#!/usr/bin/env python3
"""One-shot project summary: scenes, durations, sidecar text and overrides.

Run from a project folder (where project.json lives):
    python3 .claude/skills/kookaburra-scene-authoring/scripts/inspect.py
"""

import json
import sys
from pathlib import Path


def main() -> int:
    manifest_path = Path("project.json")
    if not manifest_path.is_file():
        print("inspect: no project.json here; run from a project folder", file=sys.stderr)
        return 2
    manifest = json.loads(manifest_path.read_text())

    print(f"Project: {manifest.get('name', '?')}")
    print(f"Theme:   {manifest.get('themeId', '?')}   Formats: {' '.join(manifest.get('formats', []))}")
    audio = manifest.get("audio")
    if audio:
        print(f"Audio:   {audio.get('file')}")
    print()

    total = 0
    for i, entry in enumerate(manifest.get("scenes", [])):
        file = entry.get("file", "?")
        duration = entry.get("durationMs", 0)
        total += duration
        stem = Path(file).stem
        doc_path = Path("scenes") / f"{stem}.json"
        doc = {}
        if doc_path.is_file():
            try:
                doc = json.loads(doc_path.read_text())
            except json.JSONDecodeError as e:
                print(f"{i:2}  {stem:24} !! sidecar unreadable: {e}")
                continue
        name = doc.get("name", "")
        line = f"{i:2}  {stem:24} {duration / 1000:6.1f}s"
        if name:
            line += f"  \"{name}\""
        if entry.get("transition"):
            line += f"  transition={entry['transition'].get('type', '?')}"
        print(line)
        text = doc.get("text") or {}
        for key, value in text.items():
            flat = value.replace("\n", "\\n")
            shown = flat if len(flat) <= 60 else flat[:57] + "..."
            print(f"      text.{key} = \"{shown}\"")
        overrides = []
        if doc.get("themeId"):
            overrides.append(f"themeId={doc['themeId']}")
        if doc.get("background"):
            overrides.append(f"background={doc['background'].get('type', '?')}")
        if doc.get("backdrop"):
            overrides.append("backdrop")
        if doc.get("lighting"):
            overrides.append("lighting")
        if doc.get("textAnimation"):
            overrides.append("textAnimation")
        if doc.get("textStyle"):
            overrides.append(f"textStyle({', '.join(sorted(doc['textStyle']))})")
        if doc.get("camera"):
            overrides.append(f"camera({len(doc['camera'].get('keys', []))} keys)")
        devices = doc.get("devices") or []
        if devices:
            d = devices[0]
            media = (d.get("media") or {}).get("src", "")
            overrides.append(f"device={d.get('model', '?')}/{d.get('colour', 'default')}"
                             + (f" media={media}" if media else ""))
        if overrides:
            print(f"      {'; '.join(overrides)}")
    print(f"\nTotal: {total / 1000:.1f}s across {len(manifest.get('scenes', []))} scenes (before transition overlaps)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
