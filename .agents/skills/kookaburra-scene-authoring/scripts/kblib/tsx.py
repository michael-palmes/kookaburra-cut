"""Scene TSX scanning: the app's defineScene id scanner (ported byte for byte), imports, banned APIs and asset refs."""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Set, Tuple

SCAN_BUDGET = 4096
TOOLKIT = "@kookaburra/toolkit"
JSX_RUNTIME = "react/jsx-runtime"


def _is_ident(c: str) -> bool:
    return c.isascii() and (c.isalnum() or c in "_$")


def _skip_ws(s: str, i: int) -> Optional[int]:
    while i < len(s) and s[i] in " \t\n\r\x0c":
        i += 1
    return i if i < len(s) else None


def _string_content(s: str, q: int) -> Optional[Tuple[int, int]]:
    if q >= len(s) or s[q] not in "\"'`":
        return None
    quote = s[q]
    i = q + 1
    while i < len(s):
        c = s[i]
        if c == "\\":
            i += 2
        elif c == "$" and quote == "`" and s[i + 1:i + 2] == "{":
            return None
        elif c == quote:
            return (q + 1, i)
        else:
            i += 1
    return None


def _skip_string(s: str, q: int, end: int) -> Optional[int]:
    quote = s[q]
    i = q + 1
    while i < end:
        c = s[i]
        if c == "\\":
            i += 2
        elif c == quote:
            return i + 1
        else:
            i += 1
    return None


def _scan_scene_id(s: str, open_: int) -> Optional[Tuple[int, int]]:
    end = min(len(s), open_ + SCAN_BUDGET)
    i = open_ + 1
    depth = 1
    prev = "{"
    while i < end:
        c = s[i]
        if c in " \t\n\r\x0c":
            i += 1
            continue
        if c == "/" and s[i + 1:i + 2] == "/":
            i += 2
            while i < end and s[i] != "\n":
                i += 1
            continue
        if c == "/" and s[i + 1:i + 2] == "*":
            i += 2
            while i + 1 < end and not (s[i] == "*" and s[i + 1] == "/"):
                i += 1
            i = min(end, i + 2)
            continue
        if c in "\"'`":
            nxt = _skip_string(s, i, end)
            if nxt is None:
                return None
            i = nxt
            prev = c
            continue
        if depth == 1 and prev in "{," and s.startswith("id", i):
            colon = _skip_ws(s, i + 2)
            if colon is not None and s[colon] == ":":
                q = _skip_ws(s, colon + 1)
                if q is None:
                    return None
                return _string_content(s, q)
        if c in "{[(":
            depth += 1
        elif c in "}])":
            depth -= 1
            if depth == 0:
                return None
        prev = c
        i += 1
    return None


def find_define_scene_id(src: str) -> Optional[Tuple[int, int]]:
    """Span of the `defineScene({ id: "…" })` literal content, exactly as the app's healer finds it."""
    start = 0
    token = "defineScene"
    while start < len(src):
        pos = src.find(token, start)
        if pos < 0:
            return None
        start = pos + len(token)
        if pos > 0 and _is_ident(src[pos - 1]):
            continue
        paren = _skip_ws(src, start)
        if paren is None or src[paren] != "(":
            continue
        brace = _skip_ws(src, paren + 1)
        if brace is None or src[brace] != "{":
            continue
        span = _scan_scene_id(src, brace)
        if span is not None:
            return span
    return None


def scene_id(src: str) -> Optional[str]:
    span = find_define_scene_id(src)
    return src[span[0]:span[1]] if span else None


def rewrite_scene_id(src: str, new_id: str) -> Optional[str]:
    span = find_define_scene_id(src)
    if span is None:
        return None
    return src[:span[0]] + new_id + src[span[1]:]


def blank_comments_and_strings(src: str) -> str:
    """Same length and line breaks, with comment bodies and string contents replaced by spaces."""
    out = list(src)
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "/" and src[i + 1:i + 2] == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        if c == "/" and src[i + 1:i + 2] == "*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            for k in range(i, j):
                if src[k] != "\n":
                    out[k] = " "
            i = j
            continue
        if c in "\"'`":
            j = i + 1
            while j < n and src[j] != c:
                if src[j] == "\\":
                    j += 1
                elif c != "`" and src[j] == "\n":
                    break
                j += 1
            for k in range(i + 1, min(j, n)):
                if src[k] != "\n":
                    out[k] = " "
            i = j + 1
            continue
        i += 1
    return "".join(out)


def line_of(src: str, index: int) -> int:
    return src.count("\n", 0, index) + 1


IMPORT_RE = re.compile(
    r"(?m)^[ \t]*import\s+(type\s+)?((?:[\w$]+\s*,?\s*)?(?:\{[^}]*\})?\s*(?:\*\s*as\s+[\w$]+)?)\s*from\s*([\"'])([^\"']+)\3"
)
BARE_IMPORT_RE = re.compile(r"(?m)^[ \t]*import\s*([\"'])([^\"']+)\1")
DYNAMIC_IMPORT_RE = re.compile(r"\b(import|require)\s*\(")
EXPORT_FROM_RE = re.compile(r"(?m)^[ \t]*export\s+(?:\*|\{[^}]*\})\s*from\s*([\"'])([^\"']+)\1")


class TsxImport:
    __slots__ = ("specifier", "names", "type_only", "line")

    def __init__(self, specifier: str, names: List[str], type_only: bool, line: int) -> None:
        self.specifier = specifier
        self.names = names
        self.type_only = type_only
        self.line = line


def parse_imports(src: str) -> List[TsxImport]:
    out: List[TsxImport] = []
    for m in IMPORT_RE.finditer(src):
        clause = m.group(2) or ""
        names: List[str] = []
        brace = re.search(r"\{([^}]*)\}", clause)
        if brace:
            for part in brace.group(1).split(","):
                part = part.strip()
                if not part or part.startswith("type "):
                    continue
                names.append(part.split(" as ")[0].strip())
        out.append(TsxImport(m.group(4), names, bool(m.group(1)), line_of(src, m.start())))
    for m in BARE_IMPORT_RE.finditer(src):
        out.append(TsxImport(m.group(2), [], False, line_of(src, m.start())))
    for m in EXPORT_FROM_RE.finditer(src):
        out.append(TsxImport(m.group(2), [], False, line_of(src, m.start())))
    return out


def local_bindings(src: str) -> Set[str]:
    """Names imported from the toolkit or declared in the file (so their `useX(` calls are fine)."""
    names: Set[str] = set()
    for imp in parse_imports(src):
        if imp.specifier == TOOLKIT:
            names.update(imp.names)
    for m in re.finditer(r"import\s*\{([^}]*)\}\s*from\s*[\"']@kookaburra/toolkit[\"']", src):
        for part in m.group(1).split(","):
            part = part.strip()
            if " as " in part:
                names.add(part.split(" as ")[1].strip())
    for m in re.finditer(r"\b(?:function\s+|const\s+|let\s+|var\s+)([\w$]+)", src):
        names.add(m.group(1))
    return names


BANNED: List[Tuple[re.Pattern, str]] = [
    (re.compile(r"\bDate\s*\.\s*now\b"), "Date.now reads the wall clock; derive time from useTimeline().localMs"),
    (re.compile(r"\bperformance\s*\.\s*now\b"), "performance.now reads the wall clock; derive time from useTimeline().localMs"),
    (re.compile(r"\bnew\s+Date\b"), "new Date reads the wall clock; derive time from useTimeline().localMs"),
    (re.compile(r"\bsetTimeout\b"), "setTimeout is a wall-clock timer; key motion off useTimeline().localMs"),
    (re.compile(r"\bsetInterval\b"), "setInterval is a wall-clock timer; key motion off useTimeline().localMs"),
    (re.compile(r"\brequestAnimationFrame\b"), "requestAnimationFrame runs on the wall clock; the timeline drives every frame"),
    (re.compile(r"\bMath\s*\.\s*random\b"), "Math.random differs every render; use createSeededRandom(seed) from the toolkit"),
    (re.compile(r"\bdocument\s*\.(?=\s*[A-Za-z_$])"), "document.* touches the DOM, which the export cannot capture; render with toolkit primitives"),
    (re.compile(r"\bwindow\s*\.(?=\s*[A-Za-z_$])"), "window.* touches the browser, which the export cannot capture; use useFormat() for sizes"),
    (re.compile(r"<\s*Html\b"), "<Html> is DOM text the export cannot capture; use toolkit text primitives"),
]

REACT_HOOKS = {
    "useMemo", "useState", "useEffect", "useRef", "useCallback", "useLayoutEffect", "useReducer",
    "useContext", "useId", "useTransition", "useDeferredValue", "useImperativeHandle",
    "useSyncExternalStore", "useInsertionEffect", "useFrame", "useThree", "useLoader",
}
HOOK_CALL_RE = re.compile(r"(?<![\w$.])(use[A-Z][\w$]*)\s*\(")
EXPORT_DEFAULT_RE = re.compile(r"\bexport\s+default\s+defineScene\s*\(")
ANY_EXPORT_DEFAULT_RE = re.compile(r"\bexport\s+default\b")


def banned_uses(code: str) -> List[Tuple[int, str, str]]:
    """(line, token, why) for every wall-clock, DOM or randomness use outside comments and strings."""
    found: List[Tuple[int, str, str]] = []
    for pattern, why in BANNED:
        for m in pattern.finditer(code):
            found.append((line_of(code, m.start()), m.group(0).strip(), why))
    found.sort()
    return found


def hook_calls(code: str) -> List[Tuple[int, str]]:
    return [(line_of(code, m.start()), m.group(1)) for m in HOOK_CALL_RE.finditer(code)]


# Ported from scene_doc.rs scan_asset_refs / rewrite_text_asset_refs.
def _path_byte(c: str) -> bool:
    return c.isascii() and (c.isalnum() or c in "._-/ ")


def is_project_asset_ref(value: str) -> bool:
    if not value.startswith("assets/"):
        return False
    rest = value[len("assets/"):]
    return bool(rest) and all(seg not in ("", ".", "..") for seg in value.split("/"))


def scan_asset_refs(text: str) -> List[str]:
    found: List[str] = []
    start_from = 0
    while True:
        pos = text.find("assets/", start_from)
        if pos < 0:
            break
        prev = text[pos - 1] if pos > 0 else None
        standalone = not (prev is not None and prev.isascii() and (prev.isalnum() or prev in "-_./"))
        end = pos + len("assets/")
        while end < len(text) and _path_byte(text[end]):
            end += 1
        rel = text[pos:end].rstrip(" .")
        if standalone and is_project_asset_ref(rel) and rel not in found:
            found.append(rel)
        start_from = max(end, pos + 1)
    return found


def rewrite_text_asset_refs(text: str, replacements: List[Tuple[str, str]]) -> str:
    def find_standalone(start_from: int, source: str) -> Optional[int]:
        search = start_from
        while True:
            pos = text.find(source, search)
            if pos < 0:
                return None
            end = pos + len(source)
            starts_clean = pos == 0 or not _path_byte(text[pos - 1])
            ends_clean = end == len(text) or not _path_byte(text[end])
            if starts_clean and ends_clean:
                return pos
            search = end

    out: List[str] = []
    cursor = 0
    while cursor < len(text):
        best: Optional[Tuple[int, int, str, str]] = None
        for source, replacement in replacements:
            pos = find_standalone(cursor, source)
            if pos is None:
                continue
            candidate = (pos, -len(source), source, replacement)
            if best is None or candidate[:2] < best[:2]:
                best = candidate
        if best is None:
            out.append(text[cursor:])
            break
        pos, _neg, source, replacement = best
        out.append(text[cursor:pos])
        out.append(replacement)
        cursor = pos + len(source)
    return "".join(out)


STRING_ASSET_RE = re.compile(r"([\"'`])(assets/[^\"'`\n$]+)\1")


def literal_asset_refs(src: str) -> List[Tuple[int, str]]:
    """`assets/...` string literals (not comments), with their line numbers."""
    no_comments = strip_comments(src)
    return [(line_of(src, m.start()), m.group(2)) for m in STRING_ASSET_RE.finditer(no_comments)]


def strip_comments(src: str) -> str:
    out = list(src)
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c in "\"'`":
            j = i + 1
            while j < n and src[j] != c:
                if src[j] == "\\":
                    j += 1
                elif c != "`" and src[j] == "\n":
                    break
                j += 1
            i = j + 1
            continue
        if c == "/" and src[i + 1:i + 2] == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        if c == "/" and src[i + 1:i + 2] == "*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            for k in range(i, j):
                if src[k] != "\n":
                    out[k] = " "
            i = j
            continue
        i += 1
    return "".join(out)


def scene_ids_in(texts: Dict[str, str]) -> Dict[str, List[str]]:
    """id -> files carrying it."""
    owners: Dict[str, List[str]] = {}
    for file, text in texts.items():
        sid = scene_id(text)
        if sid is not None:
            owners.setdefault(sid, []).append(file)
    return owners
