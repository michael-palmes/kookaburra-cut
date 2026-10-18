"""The shared in-use rule for project assets: a mirror of media.rs `AssetRefs` (the app's Delete unused sheet and pack review).

Both sides replay tests/fixtures/asset-ref-vectors.json, so they agree on every case. The corpus is project.json,
every scenes/**/*.json and *.tsx (dot names skipped), edits/*.json and the workspace themes a themeId names. A file
is referenced when its rel appears in a corpus file, or matches a glob a string literal stands for. Standard library only.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

MANIFEST = "project.json"
META_REL = "assets/_meta.json"
TIMING_SUFFIX = ".timing.json"
THEMES_DIR = "themes"
LIBRARY_DIRS = ("templates", "presets")
PREFIX = "assets/"
# Rust's char::is_whitespace (the White_Space property), which str.isspace() does not match exactly.
RUST_WHITESPACE = frozenset("\t\n\x0b\x0c\r \x85\xa0                　")


class ProjectText:
    __slots__ = ("display", "text", "kind")

    def __init__(self, display: str, text: str, kind: str) -> None:
        self.display = display
        self.text = text
        self.kind = kind  # "manifest" | "scene" | "edit" | "theme"


def _read(path: Path) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def project_texts(root: Path) -> List[ProjectText]:
    """media.rs project_texts: every file a reference can live in, read once; unreadable files are skipped."""
    texts: List[ProjectText] = []
    text = _read(root / MANIFEST)
    if text is not None:
        texts.append(ProjectText(MANIFEST, text, "manifest"))
    scenes = root / "scenes"
    folders = [scenes]
    while folders:
        folder = folders.pop()
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        for entry in entries:
            if entry.name.startswith("."):
                continue
            path = Path(entry.path)
            if path.is_dir():
                folders.append(path)
                continue
            if path.is_file() and path.suffix in (".json", ".tsx"):
                text = _read(path)
                if text is not None:
                    texts.append(ProjectText(f"scenes/{path.relative_to(scenes).as_posix()}", text, "scene"))
    edits = root / "edits"
    try:
        entries = list(os.scandir(edits))
    except OSError:
        entries = []
    for entry in entries:
        path = Path(entry.path)
        if path.is_file() and path.suffix == ".json":
            text = _read(path)
            if text is not None:
                texts.append(ProjectText(f"edits/{entry.name}", text, "edit"))
    themes = workspace_themes_dir(root)
    if themes is not None:
        for slug in workspace_theme_slugs(texts):
            text = _read(themes / slug / "theme.json")
            if text is not None:
                texts.append(ProjectText(f"{THEMES_DIR}/{slug}/theme.json", text, "theme"))
    return texts


def workspace_themes_dir(root: Path) -> Optional[Path]:
    """The workspace's themes folder beside a project (<root>/<slug>) or a library item (<root>/templates/<slug>)."""
    parent = Path(root).parent
    base = parent.parent if parent.name in LIBRARY_DIRS else parent
    themes = base / THEMES_DIR
    return themes if themes.is_dir() else None


def valid_slug(slug: str) -> bool:
    """workspace.rs validate_slug."""
    return bool(slug) and not slug.startswith(".") and all(c.isascii() and (c.isalnum() or c in "-_") for c in slug)


def workspace_theme_slugs(texts: Iterable[ProjectText]) -> List[str]:
    """Every ws:<slug> any manifest or sidecar names through a themeId, sorted."""
    found: Set[str] = set()

    def collect(value: Any) -> None:
        if isinstance(value, dict):
            ident = value.get("themeId")
            if isinstance(ident, str) and ident.startswith("ws:") and valid_slug(ident[3:]):
                found.add(ident[3:])
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    for file in texts:
        if not file.display.endswith(".json") or file.display.startswith("edits/"):
            continue
        try:
            collect(json.loads(file.text))
        except ValueError:
            continue
    return sorted(found)


def literal_patterns(text: str) -> List[str]:
    """media.rs literal_patterns: the globs the string literals in text stand for; plain literals are left to the substring match."""
    out: List[str] = []
    start_from = 0
    while True:
        start = text.find(PREFIX, start_from)
        if start < 0:
            return out
        start_from = start + len(PREFIX)
        before = text[:start]
        if before.endswith("./"):
            before = before[:-2]
        quote = before[-1:] if before[-1:] in ('"', "'", "`") else None
        if quote is None:
            continue
        body = text[start + len(PREFIX):]
        glob = PREFIX
        end: Optional[int] = None
        i = 0
        broken = False
        while i < len(body):
            c = body[i]
            if c == quote:
                end = i
                break
            if c in ("\n", "\\"):
                broken = True
                break
            if quote == "`" and c == "$" and body[i + 1:i + 2] == "{":
                depth = 0
                j = i + 1
                closed = False
                while j < len(body):
                    n = body[j]
                    if n == "{":
                        depth += 1
                    elif n == "}":
                        depth -= 1
                        if depth == 0:
                            closed = True
                            break
                    j += 1
                if not closed:
                    broken = True
                    break
                if not glob.endswith("*"):
                    glob += "*"
                i = j + 1
                continue
            glob += c
            i += 1
        if broken or end is None:
            continue
        rest = body[end + 1:]
        trimmed = rest
        while trimmed and trimmed[0] in RUST_WHITESPACE:
            trimmed = trimmed[1:]
        if (trimmed.startswith("+") or glob.endswith("/")) and not glob.endswith("*"):
            glob += "*"
        if "*" in glob and glob not in out:
            out.append(glob)


def glob_matches(glob: str, rel: str) -> bool:
    """media.rs glob_matches: * matches any run of characters, / included."""
    parts = glob.split("*")
    first = parts[0]
    if not rel.startswith(first):
        return False
    rest = rel[len(first):]
    tail = parts[1:]
    if not tail:
        return rest == ""
    for part in tail[:-1]:
        at = rest.find(part)
        if at < 0:
            return False
        rest = rest[at + len(part):]
    return rest.endswith(tail[-1])


class AssetRefs:
    """The in-use rule over a project's text files, read once (media.rs AssetRefs)."""

    def __init__(self, texts: List[ProjectText]) -> None:
        self.texts = texts
        self._patterns: List[Tuple[str, str]] = []
        for file in texts:
            for glob in literal_patterns(file.text):
                self._patterns.append((glob, file.display))

    @classmethod
    def of(cls, root: Path) -> "AssetRefs":
        return cls(project_texts(Path(root)))

    def substring_hits(self, rel: str) -> List[ProjectText]:
        return [f for f in self.texts if rel in f.text]

    def pattern_hits(self, rel: str) -> List[Tuple[str, str]]:
        """(glob, file) for each literal glob matching rel."""
        return [(g, d) for g, d in self._patterns if glob_matches(g, rel)]

    def references(self, rel: str) -> List[str]:
        """The files that reference rel, sorted, each once."""
        hits = {f.display for f in self.substring_hits(rel)}
        hits.update(d for _g, d in self.pattern_hits(rel))
        return sorted(hits)

    def in_use(self, rel: str, files: List[str]) -> bool:
        """The provenance record always is; a timing record is exactly when its mezzanine (assets/<stem>.<ext>) is."""
        if rel == META_REL:
            return True
        if rel.endswith(TIMING_SUFFIX):
            return self.mezzanine_in_use(rel, files) is not None
        return bool(self.references(rel))

    def mezzanine_in_use(self, timing_rel: str, files: List[str]) -> Optional[str]:
        prefix = timing_rel[: -len(TIMING_SUFFIX)] + "."
        for f in files:
            ext = f[len(prefix):] if f.startswith(prefix) else None
            if ext and "." not in ext and self.references(f):
                return f
        return None

    def patterns(self) -> List[str]:
        return sorted({g for g, _d in self._patterns})

    def unused(self, rels: List[str], pool: Iterable[str]) -> List[str]:
        """The entries of rels not in use and not a restored sample (pool names sit flat under assets/), order kept."""
        names = set(pool)
        return [r for r in rels if not self.in_use(r, rels) and not is_pooled(r, names)]

    def kept(self, rel: str, files: List[str], pool: Iterable[str]) -> Optional[Dict[str, Any]]:
        """Why kb keeps a file nothing in the project names directly: None when a project file does (it is plainly in
        use) or nothing keeps it (it is unused); else { reason: companion | sample | theme | pattern, pattern?, file? }."""
        if rel == META_REL:
            return {"path": rel, "reason": "companion"}
        if rel.endswith(TIMING_SUFFIX):
            clip = self.mezzanine_in_use(rel, files)
            return {"path": rel, "reason": "companion", "file": clip} if clip else None
        direct = [f for f in self.substring_hits(rel) if f.kind != "theme"]
        if direct:
            return None
        themes = [f for f in self.substring_hits(rel) if f.kind == "theme"]
        if themes:
            return {"path": rel, "reason": "theme", "file": themes[0].display}
        globs = self.pattern_hits(rel)
        if globs:
            return {"path": rel, "reason": "pattern", "pattern": globs[0][0], "file": globs[0][1]}
        if is_pooled(rel, set(pool)):
            return {"path": rel, "reason": "sample"}
        return None


def is_pooled(rel: str, pool: Set[str]) -> bool:
    if not rel.startswith(PREFIX):
        return False
    name = rel[len(PREFIX):]
    return name in pool


def asset_files(root: Path) -> List[str]:
    """Every file under assets/ (dot files and dot folders skipped), project-relative, sorted."""
    base = Path(root) / "assets"
    out: List[str] = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in filenames:
            if name.startswith("."):
                continue
            out.append((Path(dirpath) / name).relative_to(root).as_posix())
    return sorted(out)
