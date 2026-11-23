"""Variant lab: writes a git-ignored dev fixture of scene variants from a bundled project, for one stills run and one sheet.

usage: python3 -I tools/variant-lab/lab.py BASE VARIANTS.py
BASE is a folder under projects/ or fixtures/; the lab lands in fixtures/lab-<BASE>/ (README.md has the round trip).
"""

from __future__ import annotations

import copy
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / ".agents" / "skills" / "kookaburra-scene-authoring" / "scripts"))

from kblib.docs import merge_patch as merge  # noqa: E402
from kblib.docs import set_path  # noqa: E402
MARKER = "lab.json"
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
ASSET_RE = re.compile(r"^(?:\./)?assets/([^/\n]+)$")
TSX_ASSET_RE = re.compile(r"""["'`](?:\./)?assets/([^/"'`\n]+)["'`]""")


def fail(message: str) -> None:
    sys.exit(f"variant-lab: {message}")


class Lab:
    """What a variants module gets: the base project, its scenes by name (the stem map) and the edit helpers."""

    def __init__(self, base: Path) -> None:
        self.base = base
        self.project: Dict[str, Any] = json.loads((base / "project.json").read_text())
        self.entries: Dict[str, Dict[str, Any]] = {}
        for entry in self.project["scenes"]:
            stem = Path(entry["file"]).stem
            self.entries[stem] = entry

    def stem(self, name: str) -> str:
        """A base scene by stem, stem without its number (`reveal` for `04-reveal`) or sidecar name, never by position."""
        wanted = name.lower()
        for stem in self.entries:
            if wanted in (stem, stem.split("-", 1)[-1]):
                return stem
        named = [s for s in self.entries if str(self._doc(s).get("name", "")).lower() == wanted]
        if len(named) == 1:
            return named[0]
        fail(f'no scene "{name}" in {self.base.name} (scenes: {", ".join(self.entries)})')
        raise AssertionError

    def _doc(self, stem: str) -> Dict[str, Any]:
        path = self.base / "scenes" / f"{stem}.json"
        return json.loads(path.read_text()) if path.is_file() else {"version": 1}

    def doc(self, name: str) -> Dict[str, Any]:
        return copy.deepcopy(self._doc(self.stem(name)))

    def tsx(self, name: str) -> str:
        return (self.base / "scenes" / f"{self.stem(name)}.tsx").read_text()

    def entry(self, name: str) -> Dict[str, Any]:
        return copy.deepcopy(self.entries[self.stem(name)])

    merge = staticmethod(merge)
    set = staticmethod(set_path)


def unmusical(node: Any, path: str, notes: List[str]) -> None:
    """Lab scenes start at different bars, so a key's musical `at` goes and its `tMs` stays; anything else is named."""
    if isinstance(node, dict):
        at = node.get("at")
        if isinstance(at, str):
            if "tMs" in node:
                node.pop("at")
            else:
                notes.append(f"{path}.at is {at!r}; give it a number of ms in the variants file")
        if node.get("still") is True:
            node.pop("still")
        for key, child in node.items():
            unmusical(child, f"{path}.{key}" if path else key, notes)
    elif isinstance(node, list):
        for i, child in enumerate(node):
            unmusical(child, f"{path}.{i}", notes)


def asset_refs(node: Any, found: set) -> None:
    if isinstance(node, str):
        m = ASSET_RE.match(node)
        if m:
            found.add(m.group(1))
    elif isinstance(node, dict):
        for child in node.values():
            asset_refs(child, found)
    elif isinstance(node, list):
        for child in node:
            asset_refs(child, found)


def link_assets(lab: Path, base: Path, names: set, notes: List[str]) -> None:
    for name in sorted(names):
        for source in (base / "assets" / name, REPO / "projects" / "_samples" / name):
            if source.is_file():
                os.symlink(source, lab / "assets" / name)
                break
        else:
            notes.append(f"assets/{name} is in neither {base.name}/assets nor projects/_samples")


def scene_tsx(source: str, stem: str, duration: Optional[int]) -> str:
    at = source.find("defineScene(")
    if at < 0:
        fail(f"{stem}: the TSX has no defineScene")
    head, body = source[:at], source[at:]
    body, count = re.subn(r'\bid:\s*"[^"]*"', f'id: "lab-{stem}"', body, count=1)
    if not count:
        fail(f"{stem}: the TSX has no literal defineScene id")
    if duration is not None:
        body = re.sub(r"\bdurationMs:\s*\d+", f"durationMs: {duration}", body, count=1)
    return head + body


def build(base_name: str, variants_file: Path) -> Path:
    if not NAME_RE.match(base_name):
        fail(f'"{base_name}" is not a project folder name')
    base = next((r / base_name for r in (REPO / "projects", REPO / "fixtures") if (r / base_name / "project.json").is_file()), None)
    if base is None:
        fail(f"no projects/{base_name} or fixtures/{base_name}")
    lab_id = f"lab-{base_name}"
    lab = REPO / "fixtures" / lab_id
    if lab.exists():
        if not (lab / MARKER).is_file():
            fail(f"fixtures/{lab_id} exists and is not a lab; move it before writing a lab there")
        shutil.rmtree(lab)
    spec: Dict[str, Any] = {"__name__": "variants"}
    exec(compile(variants_file.read_text(), str(variants_file), "exec"), spec)
    helper = Lab(base)
    variants = spec["variants"](helper)
    if not variants:
        fail("variants() returned nothing")
    (lab / "scenes").mkdir(parents=True)
    (lab / "assets").mkdir()
    (lab / MARKER).write_text(json.dumps({"base": base_name, "pages": []}) + "\n")
    notes: List[str] = []
    refs: set = set()
    entries, pages = [], []
    for stem, v in variants.items():
        if not NAME_RE.match(stem):
            fail(f'"{stem}" is not a scene stem (lowercase letters, digits and hyphens)')
        source = helper.stem(v.get("from", stem))
        doc = copy.deepcopy(v["doc"]) if "doc" in v else helper.doc(source)
        doc = merge(doc, v.get("patch", {}))
        for path, value in v.get("set", {}).items():
            doc = set_path(doc, path, value)
        unmusical(doc, stem, notes)
        marks = sorted({round(m) for m in v.get("marks", [])})
        doc["name"] = stem
        doc.pop("stills", None)
        if marks:
            doc["stills"] = {"marksMs": marks}
        asset_refs(doc, refs)
        entry = helper.entry(source)
        duration = int(v.get("durationMs", entry["durationMs"]))
        tsx = scene_tsx(v.get("tsx") or helper.tsx(source), stem, duration)
        refs.update(TSX_ASSET_RE.findall(tsx))
        (lab / "scenes" / f"{stem}.json").write_text(json.dumps(doc, indent=2) + "\n")
        (lab / "scenes" / f"{stem}.tsx").write_text(tsx)
        lab_entry: Dict[str, Any] = {"file": f"scenes/{stem}.tsx", "durationMs": duration}
        if "effects" in entry:
            lab_entry["effects"] = entry["effects"]
        entries.append(lab_entry)
        pages.append({"stem": stem, "label": v.get("label", stem), "marks": marks})
    project = copy.deepcopy(helper.project)
    project.update({"id": lab_id, "name": f"{project.get('name', base_name)} lab", "scenes": entries})
    if spec.get("AUDIO") and isinstance(project.get("audio"), dict):
        asset_refs(project["audio"], refs)
    else:
        project.pop("audio", None)
    if isinstance(spec.get("RENDER"), dict):
        project["render"] = merge(project.get("render", {}), spec["RENDER"])
    link_assets(lab, base, refs, notes)
    (lab / "project.json").write_text(json.dumps(project, indent=2) + "\n")
    (lab / MARKER).write_text(json.dumps({"base": base_name, "pages": pages}, indent=2) + "\n")
    print(f"fixtures/{lab_id}: {len(entries)} scene(s), {sum(max(1, len(p['marks'])) for p in pages)} still(s)")
    for note in notes:
        print(f"  note: {note}")
    print(f"next: pnpm kookaburra:run --action stills --project {lab_id} --stills png --size 720p")
    print(f"then: python3 -I tools/variant-lab/sheet.py {lab_id} <the zip it prints>")
    return lab


def main(argv: List[str]) -> int:
    if len(argv) != 2:
        print(__doc__.strip())
        return 2
    build(argv[0], Path(argv[1]).resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
