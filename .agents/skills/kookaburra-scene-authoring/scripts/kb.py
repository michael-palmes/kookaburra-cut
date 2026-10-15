#!/usr/bin/env python3
"""kb: the one tool for editing a Kookaburra Cut project safely. Run `kb.py --help`."""

from __future__ import annotations

import os
import sys

sys.dont_write_bytecode = True
_HERE = os.path.dirname(os.path.abspath(__file__))
# Last on sys.path (python3 -I drops it): kblib resolves, yet the inspect.py shim never shadows the stdlib.
sys.path[:] = [p for p in sys.path if os.path.abspath(p or os.curdir) != _HERE] + [_HERE]

if __name__ == "__main__":
    try:
        from kblib.cli import main
    except Exception as e:  # the app may be swapping the kit in; hooks must fail open
        if sys.argv[1:2] == ["hook"]:
            sys.exit(0)
        sys.stderr.write(f"kb: the kit is incomplete or mid-update ({e}); rerun in a moment, or reopen the project in Kookaburra Cut\n")
        sys.exit(2)
    sys.exit(main())
