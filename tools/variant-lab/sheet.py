"""Variant lab sheet: a lab's stills zip as labelled contact sheets, one tile per still, drawn by the kit's sheet writer.

usage: python3 -I tools/variant-lab/sheet.py LAB ZIP [--out DIR] [--cell 768]
LAB is the lab fixture (`lab-unveil`); ZIP is what `kookaburra:run --action stills --stills png` printed.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import List

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / ".agents" / "skills" / "kookaburra-scene-authoring" / "scripts"))

from kblib import contact  # noqa: E402

PAGE_RE = re.compile(r"(?:^|/)(\d+)-[a-z0-9-]*\.png$")
MAX_PAGE_BYTES = 256 * 1024 * 1024


def labels_for(lab: Path) -> List[str]:
    plan = json.loads((lab / "lab.json").read_text())
    out = []
    for page in plan["pages"]:
        marks = page["marks"] or [None]
        for ms in marks:
            out.append(page["label"] if ms is None else f"{page['label']} @ {ms / 1000:g}s")
    return out


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description="a lab's stills zip as labelled contact sheets")
    ap.add_argument("lab")
    ap.add_argument("zip", type=Path)
    ap.add_argument("--out", type=Path, help="folder for the sheets (default: beside the zip)")
    ap.add_argument("--cell", type=int, default=768, help="tile width in pixels (16:9 tiles; default 768)")
    a = ap.parse_args(argv)
    lab = REPO / "fixtures" / a.lab
    if not (lab / "lab.json").is_file():
        sys.exit(f"variant-lab: fixtures/{a.lab} is not a lab (no lab.json)")
    labels = labels_for(lab)
    with zipfile.ZipFile(a.zip) as z, tempfile.TemporaryDirectory(prefix="variant-lab-") as tmp:
        pages = sorted((int(m.group(1)), info) for info in z.infolist() if (m := PAGE_RE.search(info.filename)))
        if len(pages) != len(labels):
            sys.exit(f"variant-lab: the zip holds {len(pages)} still(s) but the lab plans {len(labels)}; was it rendered from this lab?")
        cells = []
        for n, ((_, info), label) in enumerate(zip(pages, labels)):
            if info.file_size > MAX_PAGE_BYTES:
                sys.exit(f"variant-lab: {info.filename} is too large to be a still")
            path = Path(tmp) / f"page-{n}.png"
            path.write_bytes(z.read(info))
            cells.append({"label": label, "image": path, "surface": "on-dark"})
        out = (a.out or a.zip.parent).resolve()
        out.mkdir(parents=True, exist_ok=True)
        box = (a.cell, a.cell * 9 // 16)
        sheets, _ = contact.write_sheets(cells, out, box, name=f"{a.lab}-sheet", label_scale=2)
    for sheet in sheets:
        print(sheet)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
