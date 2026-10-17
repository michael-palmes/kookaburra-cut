#!/usr/bin/env python3
"""kb: the one tool for editing a Kookaburra Cut project safely. Run `kb.py --help`."""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))


def _pyc_prefix() -> "str | None":
    """$TMPDIR/kb-pyc/<kit.json hash>: bytecode (stdlib included) lands outside the kit, keyed so a restamp starts afresh."""
    tmp = os.environ.get("TMPDIR")
    if not tmp or not os.path.isabs(tmp):
        return None
    try:
        from _sha1 import sha1  # type: ignore[import]  # C module: hashlib.py itself would compile uncached
    except ImportError:
        return None
    try:
        with open(os.path.join(_HERE, os.pardir, "kit.json"), "rb") as f:
            key = sha1(f.read()).hexdigest()[:12]
    except OSError:
        key = "src-" + sha1(_HERE.encode("utf-8")).hexdigest()[:12]
    base = os.path.join(tmp, "kb-pyc")
    try:
        os.makedirs(base, mode=0o700, exist_ok=True)
        st = os.lstat(base)
    except OSError:
        return None
    if (st.st_mode & 0o170000) != 0o040000 or st.st_uid != os.getuid() or st.st_mode & 0o077:
        return None
    return os.path.join(base, key)


if sys.pycache_prefix is None:
    sys.pycache_prefix = _pyc_prefix()
    sys.dont_write_bytecode = sys.pycache_prefix is None
# Last on sys.path (python3 -I drops it): kblib resolves, yet the inspect.py shim never shadows the stdlib.
sys.path[:] = [p for p in sys.path if os.path.abspath(p or os.curdir) != _HERE] + [_HERE]

if __name__ == "__main__":
    if sys.argv[1:2] == ["hook"] and sys.argv[2:3] in (["bash-pre"], ["bash-post"]):
        try:
            from kblib import hookfast
        except Exception:  # the app may be swapping the kit in; hooks must fail open
            sys.exit(0)
        sys.exit(hookfast.main(sys.argv[2]))
    try:
        from kblib.cli import main
    except Exception as e:  # the app may be swapping the kit in; hooks must fail open
        if sys.argv[1:2] == ["hook"]:
            sys.exit(0)
        sys.stderr.write(f"kb: the kit is incomplete or mid-update ({e}); rerun in a moment, or reopen the project in Kookaburra Cut\n")
        sys.exit(2)
    sys.exit(main())
