"""Single-line text motions meeting copy with more than one line: catalogue-driven, one warning per sighting."""

from __future__ import annotations

import re
from typing import Any, Dict, Iterator, List, Optional, Tuple

TAG_RE = re.compile(r"<AnimatedHeadline\b([^<]*?)/?>", re.S)
STRING_ATTR = r"""\b{name}\s*=\s*(?:\{{\s*)?(["'`])((?:\\.|(?!\1).)*)\1"""
ATTR_RE = r"\b{name}\s*="


def string_attr(attrs: str, name: str) -> Optional[str]:
    hit = re.search(STRING_ATTR.format(name=name), attrs, re.S)
    return hit.group(2) if hit else None


def has_attr(attrs: str, name: str) -> bool:
    return re.search(ATTR_RE.format(name=name), attrs) is not None


def motion_lines(entries: Optional[List[Dict[str, Any]]]) -> Dict[str, Dict[str, Any]]:
    return {str(e.get("id")): e for e in entries or []}


def is_single_line(motions: Dict[str, Dict[str, Any]], preset: Any, stagger: Any = None) -> bool:
    entry = motions.get(preset) if isinstance(preset, str) else None
    if not entry:
        return False
    if entry.get("lines") == "single":
        return True
    return bool(stagger) and entry.get("wordStaggerLines") == "single"


def sidecar_copy(doc: Dict[str, Any]) -> Iterator[Tuple[str, str, str]]:
    """Every string of copy in a sidecar with its text key and its dotted path."""
    text = doc.get("text")
    if isinstance(text, dict):
        for key, value in text.items():
            if isinstance(value, str):
                yield key, f"text.{key}", value
    managed = doc.get("managedText")
    items = managed.get("items") if isinstance(managed, dict) else None
    if isinstance(items, list):
        for i, item in enumerate(items):
            if isinstance(item, dict) and isinstance(item.get("key"), str) and isinstance(item.get("text"), str):
                yield item["key"], f"managedText.items[{i}].text", item["text"]


def sidecar_warnings(doc: Dict[str, Any], motions: Dict[str, Dict[str, Any]]) -> Iterator[Tuple[str, str]]:
    """(path, message) for sidecar copy that breaks lines under a single-line motion, the item's override over the scene's."""
    overrides = doc.get("textAnimationOverrides")
    overrides = overrides if isinstance(overrides, dict) else {}
    scene = doc.get("textAnimation") if isinstance(doc.get("textAnimation"), dict) else {}
    for key, path, value in sidecar_copy(doc):
        if "\n" not in value:
            continue
        spec = overrides.get(key)
        spec = spec if isinstance(spec, dict) else scene
        preset = spec.get("in")
        if is_single_line(motions, preset, spec.get("stagger")):
            if preset == "build":
                yield path, "build is single line; this copy breaks lines, so it plays a plain word fade"
            else:
                yield path, f"{preset} is a single-line motion and this copy breaks lines; pick a two-line one (kb catalog textMotion) or one line of copy"


def tsx_warnings(source: str, doc: Optional[Dict[str, Any]], motions: Dict[str, Dict[str, Any]]) -> Iterator[Tuple[int, str]]:
    """(line, message) for an AnimatedHeadline whose literal preset is single line and whose copy breaks or can wrap."""
    copy = {key: value for key, _path, value in sidecar_copy(doc)} if isinstance(doc, dict) else {}
    for match in TAG_RE.finditer(source):
        attrs = match.group(1)
        preset = string_attr(attrs, "preset")
        if not is_single_line(motions, preset, string_attr(attrs, "stagger")):
            continue
        line = source.count("\n", 0, match.start()) + 1
        literal = string_attr(attrs, "text")
        key = string_attr(attrs, "textKey")
        breaks = (literal is not None and "\\n" in literal) or (key is not None and "\n" in copy.get(key, ""))
        if breaks:
            yield line, f'{preset} is a single-line motion and this copy breaks lines; pick a two-line one (kb catalog textMotion) or one line of copy'
        elif has_attr(attrs, "maxWidth") and string_attr(attrs, "fit") != "width":
            yield line, f'{preset} is a single-line motion and maxWidth can wrap this copy; add fit="width" or pick a two-line one (kb catalog textMotion)'
