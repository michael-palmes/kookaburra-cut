"""Font refs ("Family" or "Family@weight"): bundled faces are safe; any other face needs the app's real-parser verdict."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .catalog import Catalog
from .util import atomic_write_text, bridge_dir, is_int, now_ms

# Mirrors BUNDLED_FONTS in src/theme/fonts.ts.
FALLBACK_BUNDLED: Dict[str, List[int]] = {
    "Inter": [400, 600],
    "Space Grotesk": [400, 600],
    "Open Sans": [400, 600],
    "JetBrains Mono": [400],
    "Playfair Display": [600],
    "Lora": [400],
    "Barlow Condensed": [600],
    "Nunito": [600],
    "Cormorant Garamond": [600],
    "Libre Franklin": [600],
}

# Known system families whose weights skip 400, so the app substitutes the nearest weight.
KNOWN_WEIGHTS: Dict[str, List[int]] = {
    "futura": [500, 700, 800],
}

VERDICTS_FILE = "font-verdicts.json"


def parse_ref(value: str) -> Tuple[str, Any]:
    """parseFontString: a bad or missing weight means the whole string at 400."""
    at = value.rfind("@")
    if at > 0:
        try:
            weight = float(value[at + 1:])
        except ValueError:
            weight = -1.0
        if 1 <= weight <= 1000:
            return value[:at], int(weight) if weight == int(weight) else weight
    return value, 400


def canonical(value: str) -> str:
    family, weight = parse_ref(value)
    return f"{family}@{weight}"


def bundled_fonts(cat: Catalog) -> Dict[str, List[int]]:
    raw = cat.get("fonts.bundled")
    out: Dict[str, List[int]] = {}
    if isinstance(raw, dict):
        for family, weights in raw.items():
            if isinstance(weights, list):
                out[str(family)] = sorted(w for w in weights if is_int(w))
            elif isinstance(weights, dict):
                ws = weights.get("weights")
                out[str(family)] = sorted(w for w in ws if is_int(w)) if isinstance(ws, list) else []
    elif isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, str):
                out[entry] = []
            elif isinstance(entry, dict):
                family = entry.get("family") or entry.get("id") or entry.get("label")
                if not family:
                    continue
                ws = entry.get("weights")
                out[str(family)] = sorted(w for w in ws if is_int(w)) if isinstance(ws, list) else []
    return out or dict(FALLBACK_BUNDLED)


def nearest(available: List[int], target: float) -> int:
    best, best_dist = available[0], float("inf")
    for w in sorted(available):
        d = abs(w - target)
        if d < best_dist:
            best, best_dist = w, d
    return best


def verdict_path() -> Path:
    return bridge_dir() / VERDICTS_FILE


def load_verdicts() -> Dict[str, Dict[str, Any]]:
    try:
        with open(verdict_path(), "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return {}
    verdicts = raw.get("verdicts") if isinstance(raw, dict) else None
    return verdicts if isinstance(verdicts, dict) else {}


def record_verdicts(results: List[Dict[str, Any]], app_version: Optional[str]) -> None:
    """Remember the app's real-parser verdicts so static checks stop calling those faces unverified."""
    if not results:
        return
    verdicts = load_verdicts()
    for r in results:
        ref = r.get("ref")
        if not isinstance(ref, str) or not isinstance(r.get("ok"), bool):
            continue
        verdicts[canonical(ref)] = {
            "ok": r["ok"],
            "error": r.get("error"),
            "fallback": r.get("fallback"),
            "appVersion": app_version,
            "atMs": now_ms(),
        }
    try:
        atomic_write_text(verdict_path(), json.dumps({"version": 1, "verdicts": verdicts}, indent=2, ensure_ascii=False) + "\n")
    except OSError:
        pass


class FontVerdict:
    __slots__ = ("severity", "message")

    def __init__(self, severity: Optional[str], message: str) -> None:
        self.severity = severity
        self.message = message


def static_verdict(
    value: str,
    cat: Catalog,
    verdicts: Optional[Dict[str, Dict[str, Any]]] = None,
    load_issues: Optional[List[Dict[str, Any]]] = None,
) -> FontVerdict:
    """severity None = safe, "warning" = not vetted yet or a substituted weight, "error" = the app reported it failing."""
    family, weight = parse_ref(value)
    ref = f"{family}@{weight}"
    bundled = bundled_fonts(cat)
    for issue in load_issues or []:
        if isinstance(issue, dict) and isinstance(issue.get("ref"), str) and canonical(issue["ref"]) == ref:
            fallback = issue.get("fallback")
            tail = f"; {fallback} renders instead" if fallback else ""
            return FontVerdict("error", f'"{value}" failed in the app ({issue.get("message", "unreadable")}){tail}. Use a bundled face such as "{suggest(family, weight, bundled)}"')
    if family in bundled:
        weights = bundled[family]
        if weights and weight not in weights:
            w = nearest(weights, weight)
            return FontVerdict("warning", f'"{value}": bundled {family} ships weights {", ".join(map(str, weights))}; it renders at {w}. Write "{family}@{w}" to say what you get')
        return FontVerdict(None, f'"{value}" is bundled (always safe)')
    if verdicts is None:
        verdicts = load_verdicts()
    cached = verdicts.get(ref)
    if isinstance(cached, dict) and isinstance(cached.get("ok"), bool):
        if not cached["ok"]:
            reason = cached.get("error") or "unreadable"
            fallback = cached.get("fallback")
            tail = f"; {fallback} renders instead" if fallback else "; the theme face renders instead"
            return FontVerdict("error", f'"{value}" failed the app\'s font check ({reason}){tail}. Use a bundled face such as "{suggest(family, weight, bundled)}"')
        substituted = weight_note(family, weight)
        if substituted:
            return FontVerdict("warning", f'"{value}": {substituted}')
        return FontVerdict(None, f'"{value}" passed the app\'s font check')
    note = weight_note(family, weight)
    extra = f" ({note})" if note else ""
    return FontVerdict("warning", f'"{value}" is not vetted yet: run kb fonts check "{value}"{extra}, or use a bundled face (kb fonts safe)')


def weight_note(family: str, weight: Any) -> Optional[str]:
    weights = KNOWN_WEIGHTS.get(family.strip().lower())
    if not weights or weight in weights:
        return None
    w = nearest(weights, weight)
    return f"{family} has no {weight} weight; the nearest, {w}, is substituted. Write \"{family}@{w}\""


def suggest(family: str, weight: float, bundled: Dict[str, List[int]]) -> str:
    lower = family.lower()
    if any(k in lower for k in ("mono", "code", "courier", "menlo", "monaco")):
        pick = "JetBrains Mono"
    elif any(k in lower for k in ("serif", "times", "georgia", "garamond", "baskerville", "didot")):
        pick = "Lora"
    else:
        pick = "Inter"
    weights = bundled.get(pick) or FALLBACK_BUNDLED.get(pick) or [400]
    return f"{pick}@{nearest(weights, weight)}"
