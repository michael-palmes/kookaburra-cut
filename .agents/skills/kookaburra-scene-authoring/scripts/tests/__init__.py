from __future__ import annotations

import os
import sys

_SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# unittest's -t puts scripts/ first on sys.path; move it last so scripts/inspect.py never shadows the stdlib.
sys.path[:] = [p for p in sys.path if os.path.abspath(p or os.curdir) != _SCRIPTS] + [_SCRIPTS]
