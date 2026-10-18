#!/usr/bin/env python3
"""Shim: `beats.py [--scene S] [--json]` runs `kb.py beats` (see kb.py beats --help).

kb video align loads this file for the analysis readers, which now live in kblib/beats/cache.py.
"""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
# Last on sys.path (python3 -I drops it): kblib resolves, yet the inspect.py shim never shadows the stdlib.
sys.path[:] = [p for p in sys.path if os.path.abspath(p or os.curdir) != _HERE] + [_HERE]

from kblib.beats.cache import (  # noqa: E402,F401
    ANALYSIS_VERSION,
    CACHE_DIR,
    MANUAL_STRENGTH,
    MARKER_MATCH_MS,
    SUPPORTED_VERSIONS,
    V1_WARNING,
    beat_times,
    build_slots,
    effective_key_moments,
    fmt_moments,
    load_analysis,
    read_json,
    scene_local,
    tempo,
)


def main() -> int:
    from kblib.cli import main as kb_main

    return kb_main(["beats"] + sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
