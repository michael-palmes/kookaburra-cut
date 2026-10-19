"""Theme `extends`: the kit's mirror of src/theme/extends.ts, replayed against fixtures/theme-merge-vectors.json.

A v3 workspace theme may name a base with "extends". Objects merge key by key, arrays and scalars
replace, the child wins, null clears an inherited value, and the base never lends its identity.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Tuple

EXTENDS_VERSION = 3
MAX_CHAIN = 16
OWN_KEYS = {"id", "name", "catalogue", "version", "extends"}

Doc = Dict[str, Any]
Lookup = Callable[[str], Any]


def extends_of(raw: Any) -> Optional[str]:
    """The base a document names, when its version honours extends."""
    if not isinstance(raw, dict):
        return None
    value = raw.get("extends")
    if not isinstance(value, str) or not value.strip():
        return None
    version = raw.get("version")
    if isinstance(version, bool) or not isinstance(version, (int, float)) or version < EXTENDS_VERSION:
        return None
    return value.strip()


def _merge_record(base: Doc, patch: Doc) -> Doc:
    out = dict(base)
    for key, value in patch.items():
        if value is None:
            out.pop(key, None)
        elif isinstance(value, dict):
            prior = out.get(key)
            out[key] = _merge_record(prior if isinstance(prior, dict) else {}, value)
        else:
            out[key] = value
    return out


def merge_theme_docs(base: Doc, child: Doc) -> Doc:
    inherited = {k: v for k, v in base.items() if k not in OWN_KEYS}
    merged = _merge_record(inherited, child)
    merged.pop("extends", None)
    return merged


def resolve_theme_document(raw: Any, source: str, lookup: Lookup) -> Tuple[Any, Optional[str]]:
    """(document, problem): raw itself when it extends nothing, the merged chain, or (None, why) when broken."""
    if not isinstance(raw, dict) or "extends" not in raw:
        return raw, None
    base_id = extends_of(raw)
    if base_id is None:
        value = raw.get("extends")
        problem = "version" if isinstance(value, str) and value.strip() else "invalid"
        return {k: v for k, v in raw.items() if k != "extends"}, problem
    chain: List[Doc] = [raw]
    seen = [source]
    nxt: Optional[str] = base_id
    while nxt is not None:
        if nxt in seen:
            return None, "cycle"
        if len(chain) > MAX_CHAIN:
            return None, "too-long"
        base = lookup(nxt)
        if not isinstance(base, dict):
            return None, "missing"
        seen.append(nxt)
        chain.append(base)
        nxt = extends_of(base)
    merged = chain[-1]
    for doc in reversed(chain[:-1]):
        merged = merge_theme_docs(merged, doc)
    return merged, None
