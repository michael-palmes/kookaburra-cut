#!/usr/bin/env python3
"""Shim: `sidecar.py <stem> get|set|unset ...` runs `kb.py doc <stem> get|set|unset ...` (validated writes)."""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
# Last on sys.path (python3 -I drops it): kblib resolves, yet the inspect.py shim never shadows the stdlib.
sys.path[:] = [p for p in sys.path if os.path.abspath(p or os.curdir) != _HERE] + [_HERE]

from kblib.cli import main  # noqa: E402

if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(main(["doc", "--help"]))
    sys.exit(main(["doc"] + sys.argv[1:]))
