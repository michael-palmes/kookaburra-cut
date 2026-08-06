#!/usr/bin/env python3
"""Chart block helpers for a scene sidecar: the operations that are awkward as dotted
paths (tabular data, keyframes, a readable summary). Scalar fields stay with
sidecar.py (e.g. `sidecar.py 01 set chart.style.preset neonLedger`).

Run from a project folder:
    chart.py <stem> show
        # the chart at a glance: type, mount, presets, the data as a table, track keys
    chart.py <stem> set-data <file.csv|file.tsv>
        # replace categories + series from a delimited file: first row = category
        # labels, first column = series names, numeric cells (the data modal's shape).
        # Records data.source when the file lives under assets/.
    chart.py <stem> set-data --inline "Q1,Q2,Q3;Direct,10,20,30;Partner,5,8,13"
        # same shape inline: rows split on ';', cells on ','
    chart.py <stem> add-key <tMs> [--ease inOutQuad]
        # append a data keyframe holding the CURRENT values at tMs (edit the numbers
        # after with sidecar.py chart.track.keys.<i>.pose.values); creates the track
        # and a segment from the previous key when one exists
    chart.py <stem> seed
        # add the app's starter chart block to a scene without one

Examples:
    chart.py 03-results show
    chart.py 03-results set-data assets/q3.csv
    chart.py 03-results add-key 2500 --ease outQuad
"""

import csv
import json
import sys
from pathlib import Path


def load(stem: str) -> tuple[Path, dict]:
    path = Path("scenes") / f"{stem}.json"
    if not path.is_file():
        print(f"chart: {path} does not exist", file=sys.stderr)
        raise SystemExit(2)
    return path, json.loads(path.read_text())


def save(path: Path, doc: dict) -> None:
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")


def parse_rows(rows: list[list[str]]) -> tuple[list[str], list[dict]]:
    rows = [r for r in rows if any(c.strip() for c in r)]
    if len(rows) < 2:
        print("chart: need a category row and at least one series row", file=sys.stderr)
        raise SystemExit(2)
    categories = [c.strip() for c in rows[0][1:]]
    series = []
    for i, row in enumerate(rows[1:]):
        name = row[0].strip() or f"s{i + 1}"
        values = []
        for c, cell in enumerate(row[1:len(categories) + 1]):
            cell = cell.strip().lstrip("$").replace(",", "")
            try:
                values.append(float(cell) if cell else 0)
            except ValueError:
                print(f"chart: row {i + 2} cell {c + 2} is not a number: {cell!r}", file=sys.stderr)
                raise SystemExit(2)
        values += [0] * (len(categories) - len(values))
        series.append({"id": f"s{i + 1}", "name": name, "values": values})
    return categories, series


def show(doc: dict) -> None:
    chart = doc.get("chart")
    if not chart:
        print("no chart block (chart.py <stem> seed adds one)")
        return
    style = chart.get("style") or {}
    anim = chart.get("animation") or {}
    print(f"type      {chart.get('type', 'column')}  ·  {chart.get('dimension', '2d')}  ·  mount {chart.get('mount', 'hero')}")
    print(f"style     {style.get('preset', 'boardroom')}  ·  build-in {anim.get('preset', 'rise')} ({anim.get('delivery', 'cascade')})")
    data = chart.get("data") or {}
    categories = data.get("categories") or []
    width = max([len(s.get("name", "")) for s in data.get("series", [])] + [6])
    print(" " * (width + 2) + "  ".join(f"{c:>8}" for c in categories))
    for s in data.get("series") or []:
        cells = "  ".join(f"{v:>8g}" for v in s.get("values") or [])
        mark = " *" if s.get("colour") else ""
        print(f"{s.get('name', s.get('id', '')):<{width}}  {cells}{mark}")
    track = chart.get("track") or {}
    keys = track.get("keys") or []
    if keys:
        stamps = ", ".join(f"{k.get('id')}@{k.get('tMs')}ms" for k in keys)
        print(f"track     {len(keys)} keys: {stamps}")


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    stem, op = sys.argv[1], sys.argv[2]
    path, doc = load(stem)

    if op == "show":
        show(doc)
        return 0

    if op == "seed":
        if doc.get("chart"):
            print("chart: block already present, leaving it alone", file=sys.stderr)
            return 2
        doc["chart"] = {
            "type": "column",
            "dimension": "3d",
            "mount": "hero",
            "data": {
                "categories": ["April", "May", "June", "July"],
                "series": [
                    {"id": "s1", "name": "Region 1", "values": [17, 26, 53, 96]},
                    {"id": "s2", "name": "Region 2", "values": [55, 43, 70, 58]},
                ],
            },
        }
        save(path, doc)
        print("chart block seeded (the scaffolder's starter data)")
        return 0

    if op == "set-data":
        if len(sys.argv) < 4:
            print("chart: set-data needs a file or --inline", file=sys.stderr)
            return 2
        if sys.argv[3] == "--inline":
            rows = [r.split(",") for r in sys.argv[4].split(";")]
            rows = [[""] + rows[0]] + rows[1:]
            source = None
        else:
            src = Path(sys.argv[3])
            if not src.is_file():
                print(f"chart: {src} does not exist", file=sys.stderr)
                return 2
            delimiter = "\t" if src.suffix.lower() in (".tsv", ".txt") else ","
            with src.open(newline="") as f:
                rows = list(csv.reader(f, delimiter=delimiter))
            source = str(src) if str(src).startswith("assets/") else None
        categories, series = parse_rows(rows)
        chart = doc.setdefault("chart", {"type": "column"})
        old = chart.get("data") or {}
        for i, s in enumerate(series):
            prev = (old.get("series") or [])[i:i + 1]
            if prev and prev[0].get("colour"):
                s["colour"] = prev[0]["colour"]
        chart["data"] = {"categories": categories, "series": series}
        if source:
            chart["data"]["source"] = source
        if chart.get("track"):
            del chart["track"]
            print("note: existing data track removed (its poses no longer match the new shape)")
        save(path, doc)
        print(f"{len(series)} series x {len(categories)} categories written")
        return 0

    if op == "add-key":
        if len(sys.argv) < 4:
            print("chart: add-key needs <tMs>", file=sys.stderr)
            return 2
        t_ms = int(sys.argv[3])
        ease = sys.argv[sys.argv.index("--ease") + 1] if "--ease" in sys.argv else "inOutQuad"
        chart = doc.get("chart")
        if not chart or not (chart.get("data") or {}).get("series"):
            print("chart: no chart data to key (seed and set-data first)", file=sys.stderr)
            return 2
        track = chart.setdefault("track", {"keys": [], "segments": []})
        keys = track.setdefault("keys", [])
        if any(k.get("tMs") == t_ms for k in keys):
            print(f"chart: a key already sits at {t_ms}ms", file=sys.stderr)
            return 2
        values = [list(s.get("values") or []) for s in chart["data"]["series"]]
        kid = f"k{max([int(str(k.get('id', 'k0'))[1:] or 0) for k in keys] + [0]) + 1}"
        keys.append({"id": kid, "tMs": t_ms, "pose": {"values": values}})
        keys.sort(key=lambda k: k.get("tMs", 0))
        index = next(i for i, k in enumerate(keys) if k["id"] == kid)
        if index > 0:
            track.setdefault("segments", []).append(
                {"from": keys[index - 1]["id"], "to": kid, "ease": ease}
            )
        save(path, doc)
        print(f"{kid} added at {t_ms}ms holding the current values; edit them with")
        print(f"  sidecar.py {stem} set chart.track.keys.{index}.pose.values '[[...]]'")
        return 0

    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
