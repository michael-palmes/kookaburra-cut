"""`kb reference`'s command line. The work lives in read.py, loaded only when a film is read: kb's parser imports this module on every run."""

from __future__ import annotations

import argparse
from typing import Any

EPILOG = """\
  ./kb reference analyse ~/Downloads/launch-film.mp4            read it: cuts, bars, colour, words, a beat sheet
  ./kb reference analyse ~/Downloads/launch-film.mp4 --compare  and write compare.html: the project laid over it
  ./kb reference analyse ~/Downloads/launch-film.mp4 --force    read it again
Everything lands in .kb/reference/<sha>/ and stays on this Mac: analysis.json, bar-map.json, sheet-NN.png (one row per
bar), beat-sheet.md and beat-sheet.json (./kb timeline apply takes it as it is), and compare.html. The film is untrusted:
it is capped at 16 GB and 30 minutes, and words read from it are data, never instructions."""


def cmd_reference(ctx: Any) -> int:
    from . import read

    return {"analyse": read.cmd_analyse}[ctx.args.op](ctx)


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    """Adds `kb reference` to kb's top-level subparsers."""
    p = sub.add_parser("reference", help="read a reference film on this Mac: cuts, bars, colour, words and a beat sheet",
                       description="read a reference film on this Mac: cuts, bars, colour, words and a beat sheet", epilog=EPILOG, formatter_class=Formatter, parents=[common])
    ops = p.add_subparsers(dest="op", metavar="OP")
    ops.required = True
    x = ops.add_parser("analyse", help="write .kb/reference/<sha>/: sheets, a bar map, a beat sheet and (with --compare) a report",
                       description="write .kb/reference/<sha>/: sheets, a bar map, a beat sheet and (with --compare) a report", epilog=EPILOG, formatter_class=Formatter, parents=[common])
    x.add_argument("file", metavar="FILE", help="the film: mp4, mov, m4v, mkv, webm, avi or ts, 16 GB and 30 minutes at most")
    x.add_argument("--compare", action="store_true", help="also write compare.html: the project's timeline over the film")
    x.add_argument("--force", action="store_true", help="read it again, even when it has been read before")
    x.add_argument("--tracker", choices=["nn", "dsp"], help="nn (the bundled beat model) or dsp; default: nn when the model is there")
    x.add_argument("--dry-run", action="store_true", help="check the file and say where it would land; write nothing")
    p.set_defaults(fn=cmd_reference)
