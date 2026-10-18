"""kb check's asset rules (full check only): a scene video ffmpeg misdecodes, and stale provenance records.

A misdecode verdict comes from `kb assets probe`'s cache when it has seen the file as it is now, else from the
container's own sample tables (no subprocess). A conformed mezzanine is never flagged. Both rules stop at a time
budget so a check stays quick on a large project.
"""

from __future__ import annotations

import time
from typing import Any, Dict, Optional

BUDGET_S = 2.0


def run(checker: Any) -> None:
    started = time.monotonic()
    misdecodes(checker, started)
    stale_provenance(checker, started)


def _verdict(project: Any, rel: str) -> Optional[Dict[str, Any]]:
    from . import assets as assetmod
    from . import conform as conformmod

    if assetmod.ext_of(rel) not in conformmod.CONFORMABLE_EXTS or assetmod.timing_record(project, rel) is not None:
        return None
    known = assetmod.known_verdict(project, rel)
    return known if known is not None else conformmod.container_verdict(project.root / rel)


def misdecodes(checker: Any, started: float) -> None:
    seen: Dict[str, Optional[Dict[str, Any]]] = {}
    for file, path, rel in checker.media_refs:
        if rel not in seen:
            if time.monotonic() - started > BUDGET_S:
                return
            seen[rel] = _verdict(checker.project, rel)
        verdict = seen[rel]
        if not verdict or verdict.get("verdict") != "ffmpeg-misdecodes":
            continue
        why = ", ".join(r for r in verdict.get("reasons") or [] if r not in ("vfr", "b-frames", "primaries")) or "edit list"
        checker.report.warn(file, path, f'"{rel}" is decoded wrong by ffmpeg ({why}), so the preview and export show other frames than QuickTime: ./kb assets conform {rel}')


def stale_provenance(checker: Any, started: float) -> None:
    from . import asset_meta
    from . import assets as assetmod

    project = checker.project
    if not (project.root / asset_meta.META_REL).is_file() or time.monotonic() - started > BUDGET_S:
        return
    for rel, _record, current in asset_meta.stale_records(project.root, assetmod._sha_memo(project)):
        why = "its file is gone" if current is None else "the file changed since (its sha256 no longer matches)"
        checker.report.info(asset_meta.META_REL, f'assets["{rel}"]', f"the provenance record of {rel} is stale: {why}; ./kb assets meta {rel}")
        if time.monotonic() - started > BUDGET_S:
            return
