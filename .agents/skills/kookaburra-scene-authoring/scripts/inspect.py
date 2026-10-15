#!/usr/bin/env python3
"""Shim: `inspect.py` runs `kb.py scenes` (the scene roster with text and overrides)."""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
# Last on sys.path (python3 -I drops it): kblib resolves, yet the inspect.py shim never shadows the stdlib.
sys.path[:] = [p for p in sys.path if os.path.abspath(p or os.curdir) != _HERE] + [_HERE]

from kblib.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(["scenes"] + sys.argv[1:]))
