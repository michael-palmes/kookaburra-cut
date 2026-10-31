"""Asset provenance in assets/_meta.json v1, the app's asset_meta.rs record read and written from kb.

{ version, assets: { rel: { sha256, origin { kind, from, sourceName, tool, atMs }, licence?, transforms[] } } }.
Project-relative paths only; a record whose sha256 no longer matches its file is stale. Fields kb does not know
survive a rewrite. Writes go through kblib.lock.mutate_json.
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import lock as lockmod
from .util import EXIT_PROBLEMS, KbError, now_ms

META_REL = "assets/_meta.json"
META_VERSION = 1
ORIGIN_KINDS = ("import", "derived", "generated", "capture")


def project_rel(rel: str) -> bool:
    return (
        rel.startswith("assets/")
        and len(rel) > len("assets/")
        and "\\" not in rel
        and all(part not in ("", ".", "..") for part in rel.split("/"))
    )


def check_origin(origin: Any) -> None:
    """asset_meta.rs check_origin: origin.from is another asset and origin.sourceName a bare file name, never an absolute path."""
    if not isinstance(origin, dict):
        raise KbError("origin must be an object", EXIT_PROBLEMS, kind="invalid")
    source = origin.get("from")
    if source is not None and (not isinstance(source, str) or not project_rel(source)):
        raise KbError(f"origin.from must be a project path under assets/, not {source!r}", EXIT_PROBLEMS, kind="invalid")
    name = origin.get("sourceName")
    if name is not None:
        if not isinstance(name, str) or not name or "/" in name or "\\" in name or name in (".", ".."):
            raise KbError(f"origin.sourceName must be a bare file name, not {name!r}", EXIT_PROBLEMS, kind="invalid")


def _fresh() -> Dict[str, Any]:
    return {"version": META_VERSION, "assets": {}}


def _checked(doc: Any) -> Dict[str, Any]:
    """The document as read_meta in asset_meta.rs takes it: an object at version 1, with an assets object."""
    if doc is None:
        return _fresh()
    if not isinstance(doc, dict):
        raise KbError(f"{META_REL} must be a JSON object", EXIT_PROBLEMS, kind="invalid")
    version = doc.get("version")
    if version != META_VERSION or isinstance(version, bool):
        raise KbError(f"{META_REL} is version {version}; this kit reads version {META_VERSION}", EXIT_PROBLEMS, kind="invalid", hint="ask the user to update Kookaburra Cut")
    if not isinstance(doc.get("assets"), dict):
        doc["assets"] = {}
    return doc


def read(root: Path) -> Dict[str, Any]:
    """The whole record file (an empty v1 document when it is missing)."""
    path = Path(root) / META_REL
    if not path.is_file():
        return _fresh()
    data, _sha = lockmod.read_with_hash(path)
    return _checked(lockmod.decode_json(data or b"", META_REL))


def file_hash(root: Path, rel: str, memo: Optional[Path] = None) -> Optional[str]:
    """The file's content hash (memoised by size and mtime when memo is given), None when it is gone."""
    path = Path(root) / rel
    if not path.is_file():
        return None
    if memo is not None:
        from .video import passes

        try:
            return passes.file_sha256(path, memo)
        except OSError:
            return None
    found = lockmod.file_sha256(path)
    return None if found == lockmod.ABSENT else found


def is_stale(record: Any, current: Optional[str]) -> bool:
    recorded = record.get("sha256") if isinstance(record, dict) else None
    return current is None or recorded != current


def record_of(root: Path, rel: str, memo: Optional[Path] = None) -> Dict[str, Any]:
    """{ path, record (or None), stale, sha256 } for one asset."""
    doc = read(root)
    record = doc["assets"].get(rel)
    current = file_hash(root, rel, memo)
    return {"path": rel, "record": record, "stale": record is not None and is_stale(record, current), "sha256": current}


def stale_records(root: Path, memo: Optional[Path] = None) -> List[Tuple[str, Dict[str, Any], Optional[str]]]:
    """(rel, record, current hash) for each stale record."""
    try:
        doc = read(root)
    except KbError:
        return []
    out = []
    for rel, record in sorted(doc["assets"].items()):
        current = file_hash(root, rel, memo) if project_rel(rel) else None
        if is_stale(record, current):
            out.append((rel, record, current))
    return out


def record_origin(project: Any, rel: str, origin: Dict[str, Any], transforms: List[Dict[str, Any]], *, sha256: Optional[str] = None, opts: Any = None) -> lockmod.Mutation:
    """asset_meta.rs record_asset_origin: hash the file as it is now, replace origin and transforms, keep the rest (a licence)."""
    if not project_rel(rel):
        raise KbError(f"provenance paths are project-relative under assets/, not {rel!r}", EXIT_PROBLEMS, kind="invalid")
    check_origin(origin)
    root = project.root if hasattr(project, "root") else Path(project)
    sha = sha256 or file_hash(root, rel)
    if sha is None:
        raise KbError(f"{rel} does not exist, so its provenance can't be recorded", EXIT_PROBLEMS, kind="invalid")

    def fn(doc: Any) -> Any:
        doc = _checked(doc)
        record = doc["assets"].get(rel)
        if not isinstance(record, dict):
            record = {}
        record["sha256"] = sha
        record["origin"] = copy.deepcopy(origin)
        record["transforms"] = copy.deepcopy(transforms)
        doc["assets"][rel] = record
        return doc

    return _mutate(project, fn, "kb assets: provenance", opts)


def record_origins(project: Any, records: List[Dict[str, Any]], opts: Any = None) -> Optional[lockmod.Mutation]:
    """record_origin for a batch in one write: each { rel, origin, transforms }, hashed as the file is now."""
    root = project.root if hasattr(project, "root") else Path(project)
    rows = []
    for r in records:
        if not project_rel(r["rel"]):
            raise KbError(f"provenance paths are project-relative under assets/, not {r['rel']!r}", EXIT_PROBLEMS, kind="invalid")
        check_origin(r["origin"])
        sha = file_hash(root, r["rel"])
        if sha is not None:
            rows.append((r, sha))
    if not rows:
        return None

    def fn(doc: Any) -> Any:
        doc = _checked(doc)
        for r, sha in rows:
            record = doc["assets"].get(r["rel"])
            if not isinstance(record, dict):
                record = {}
            record.update(sha256=sha, origin=copy.deepcopy(r["origin"]), transforms=copy.deepcopy(r["transforms"]))
            doc["assets"][r["rel"]] = record
        return doc

    return _mutate(project, fn, "kb assets: provenance", opts)


def forget(project: Any, rel: str, opts: Any = None) -> lockmod.Mutation:
    def fn(doc: Any) -> Any:
        if doc is None:
            return None
        doc = _checked(doc)
        if rel not in doc["assets"]:
            return None
        del doc["assets"][rel]
        return doc

    return _mutate(project, fn, "kb assets: provenance", opts)


def set_fields(project: Any, rel: str, changes: List[Tuple[str, Any]], opts: Any = None) -> lockmod.Mutation:
    """Dotted keys inside rel's record (licence.id, origin.tool ...); None deletes. A new record gets the file's hash."""
    root = project.root if hasattr(project, "root") else Path(project)
    for key, _value in changes:
        head = key.split(".", 1)[0]
        if not key or any(not p for p in key.split(".")):
            raise KbError(f"{key!r} is not a dotted key", 2, kind="usage")
        if head == "sha256":
            raise KbError("sha256 is the file's content hash; kb keeps it, so it can't be set", 2, kind="usage")
        if head == "transforms" and key != "transforms":
            raise KbError("transforms is a list: set the whole list as JSON", 2, kind="usage")
    current = file_hash(root, rel)

    def fn(doc: Any) -> Any:
        doc = _checked(doc)
        record = doc["assets"].get(rel)
        if not isinstance(record, dict):
            if current is None:
                raise KbError(f"{rel} does not exist and has no record to edit", EXIT_PROBLEMS, kind="invalid")
            record = {"sha256": current, "transforms": []}
        for key, value in changes:
            parts = key.split(".")
            node = record
            for part in parts[:-1]:
                child = node.get(part)
                if not isinstance(child, dict):
                    if value is None:
                        node = None
                        break
                    child = {}
                    node[part] = child
                node = child
            if node is None:
                continue
            if value is None:
                node.pop(parts[-1], None)
            else:
                node[parts[-1]] = value
        if "origin" in record:
            check_origin(record["origin"])
        if "transforms" in record and not isinstance(record["transforms"], list):
            raise KbError("transforms must be a list", EXIT_PROBLEMS, kind="invalid")
        doc["assets"][rel] = record
        return doc

    return _mutate(project, fn, "kb assets meta", opts)


def _mutate(project: Any, fn: Any, op: str, opts: Any) -> lockmod.Mutation:
    return lockmod.mutate_json(
        project,
        META_REL,
        fn,
        op=op,
        caller=getattr(opts, "caller", None),
        wait=getattr(opts, "wait", None),
        dry_run=bool(getattr(opts, "dry_run", False)),
    )


def origin(kind: str, tool: str, *, source: Optional[str] = None, source_name: Optional[str] = None, source_sha256: Optional[str] = None) -> Dict[str, Any]:
    out: Dict[str, Any] = {"kind": kind}
    if source:
        out["from"] = source
    if source_name:
        out["sourceName"] = source_name
    if source_sha256:
        out["sourceSha256"] = source_sha256
    out["tool"] = tool
    out["atMs"] = now_ms()
    return out
