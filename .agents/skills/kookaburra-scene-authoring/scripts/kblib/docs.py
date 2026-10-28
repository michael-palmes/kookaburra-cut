"""Dotted-path reads and writes on JSON documents (sidecars, project.json, themes)."""

from __future__ import annotations

import copy
import json
import re
from typing import Any, List, Tuple

from .util import KbError

_ESCAPE = re.compile(r"\\([\\nt])")
_ESCAPED = {"\\": "\\", "n": "\n", "t": "\t"}


def parse_value(raw: str, as_string: bool = False) -> Any:
    """JSON when it parses, else the raw string (so `Inter@600` and `Ship faster` need no quoting). `as_string` keeps a
    string and reads \\n, \\t and \\\\ as a newline, a tab and a backslash."""
    if as_string:
        return _ESCAPE.sub(lambda m: _ESCAPED[m.group(1)], raw)
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def split_path(path: str) -> List[str]:
    parts = [p for p in path.replace("[", ".").replace("]", "").split(".")]
    if not path or any(p == "" for p in parts):
        raise KbError(f'bad path "{path}"; use dotted keys like textStyle.titleSize or devices.0.model', 2, kind="usage")
    return parts


def _index(node: List[Any], part: str, path: str) -> int:
    try:
        i = int(part)
    except ValueError:
        raise KbError(f'"{part}" in {path} must be a list index (0, 1, ... or -1)', 2, kind="usage") from None
    if not -len(node) <= i < len(node):
        raise KbError(f"{path}: index {i} is out of range (the list has {len(node)} items)", 1)
    return i


def get_path(doc: Any, path: str) -> Tuple[bool, Any]:
    node = doc
    for part in split_path(path):
        if isinstance(node, dict):
            if part not in node:
                return False, None
            node = node[part]
        elif isinstance(node, list):
            try:
                i = int(part)
            except ValueError:
                return False, None
            if not -len(node) <= i < len(node):
                return False, None
            node = node[i]
        else:
            return False, None
    return True, node


def set_path(doc: Any, path: str, value: Any) -> Any:
    """Set, creating missing objects; a final "+" appends to a list. Returns a new document."""
    out = copy.deepcopy(doc)
    parts = split_path(path)
    node = out
    for depth, part in enumerate(parts[:-1]):
        nxt = parts[depth + 1]
        here = ".".join(parts[: depth + 1])
        if isinstance(node, dict):
            if part not in node or node[part] is None:
                if nxt.lstrip("-").isdigit():
                    raise KbError(f'{here} does not exist, so it has no index {nxt}; append with {here}.+', 1)
                node[part] = [] if nxt == "+" else {}
            elif not isinstance(node[part], (dict, list)):
                raise KbError(f"{here} is a {type(node[part]).__name__}, not an object; set {here} itself or unset it first", 1)
            node = node[part]
        elif isinstance(node, list):
            node = node[_index(node, part, path)]
        else:
            raise KbError(f"{'.'.join(parts[:depth])} is a {type(node).__name__}, not an object; cannot set {path}", 1)
    leaf = parts[-1]
    if isinstance(node, dict):
        if leaf == "+":
            raise KbError(f'{path}: "+" appends to a list, but {".".join(parts[:-1]) or "the document"} is an object', 1)
        node[leaf] = value
    elif isinstance(node, list):
        if leaf == "+":
            node.append(value)
        else:
            node[_index(node, leaf, path)] = value
    else:
        raise KbError(f"{'.'.join(parts[:-1])} is a {type(node).__name__}, not an object; cannot set {path}", 1)
    return out


def unset_path(doc: Any, path: str) -> Any:
    out = copy.deepcopy(doc)
    parts = split_path(path)
    found, parent = get_path(out, ".".join(parts[:-1])) if len(parts) > 1 else (True, out)
    leaf = parts[-1]
    if not found:
        raise KbError(f"{path} is not set", 1)
    if isinstance(parent, dict):
        if leaf not in parent:
            raise KbError(f"{path} is not set", 1)
        del parent[leaf]
    elif isinstance(parent, list):
        del parent[_index(parent, leaf, path)]
    else:
        raise KbError(f"{path} is not set", 1)
    if len(parts) > 1 and isinstance(parent, dict) and not parent:
        grand_found, grand = get_path(out, ".".join(parts[:-2])) if len(parts) > 2 else (True, out)
        if grand_found and isinstance(grand, dict) and parts[-2] in grand and grand[parts[-2]] == {}:
            del grand[parts[-2]]
    return out


def edit(doc: Any, op: str, path: str = "", value: Any = None) -> Tuple[Any, str]:
    """One kb write as an operation on a fresh document (so a conflict can re-apply it): (new document, summary)."""
    if op == "set":
        new = set_path(doc, path, value)
        return new, f"{path} = {json.dumps(get_path(new, path)[1], ensure_ascii=False)[:120]}"
    if op == "unset":
        return unset_path(doc, path), f"removed {path}"
    if not isinstance(value, dict):
        raise KbError("merge needs a JSON object (RFC 7386 merge patch: null deletes a key)", 2, kind="usage")
    return merge_patch(doc, value), f"merged {', '.join(value.keys())}"


def merge_patch(target: Any, patch: Any) -> Any:
    """RFC 7386 JSON merge patch: objects merge recursively, null deletes, anything else replaces."""
    if not isinstance(patch, dict):
        return copy.deepcopy(patch)
    out = copy.deepcopy(target) if isinstance(target, dict) else {}
    for key, value in patch.items():
        if value is None:
            out.pop(key, None)
        else:
            out[key] = merge_patch(out.get(key), value)
    return out
