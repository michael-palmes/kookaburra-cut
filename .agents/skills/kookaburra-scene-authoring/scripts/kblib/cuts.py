"""kb timeline: every scene's start, end, cut and transition in bars and ms, with off-beat cuts and keys outside their scene
flagged; kb timeline apply writes a plan's cuts and transitions in one checkpointed write; drift() is the lint kb check
and kb status share (cuts that sat on a beat at the last checkpoint and no longer do)."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import lock as lockmod
from . import music
from .beats import model
from .film import timeline as tl
from .project import MANIFEST, Project
from .util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, emit, js_json

PLAN_VERSION = 1
ALIGNS = ("end", "mid")
ABSENT: Any = object()
_LENGTH = re.compile(r"(\d+(?:\.\d+)?)\s*(ms|s)?\Z", re.ASCII)
_BAR = re.compile(r"(?:bar[: ]?)?(-?\d+(?:\.\d+){0,2})\Z", re.ASCII | re.IGNORECASE)
_COLUMNS = {
    "scene": "scene", "cut": "cutAt", "cutat": "cutAt", "cut at": "cutAt", "cut bar": "cutAt", "bar": "cutAt",
    "transition": "transition", "type": "transition", "length": "length", "ms": "length", "duration": "length",
    "transition length": "length", "transition ms": "length", "align": "align", "alignment": "align", "ease": "ease",
}


def fmt_ms(ms: float) -> str:
    return f"{music.js_round(ms)} ms"


def on_beat(m: Optional[Dict[str, Any]], ms: float) -> Optional[str]:
    return tl.beat_at(m, ms)


def where(m: Optional[Dict[str, Any]], ms: float) -> str:
    """A film time as the beat it sits on, else the nearest beat and how far off it is (plain ms without a grid)."""
    near = model.nearest_beat(m, ms)
    if near is None:
        return fmt_ms(ms)
    delta = ms - near["projectMs"]
    if abs(delta) <= tl.ON_BEAT_MS:
        return near["position"]
    return f"{near['position']} {'+' if delta > 0 else '-'}{fmt_ms(abs(delta))}"


def boundary_points(slots: List[Dict[str, Any]], i: int) -> List[Tuple[str, float]]:
    """A boundary's three moments, the cut first: the middle of the overlap, the outgoing scene's end, the incoming start."""
    return [("mid", tl.boundary_cut_ms(slots, i)), ("end", slots[i]["endMs"]), ("start", slots[i + 1]["startMs"])]


def beat_point(m: Optional[Dict[str, Any]], slots: List[Dict[str, Any]], i: int) -> Optional[Tuple[str, str]]:
    """(kind, position) of the first of boundary i's moments that sits on a beat, or None."""
    for kind, ms in boundary_points(slots, i):
        position = on_beat(m, ms)
        if position:
            return kind, position
    return None


# ── kb timeline ───────────────────────────────────────────────────────────────


def timeline_data(project: Project) -> Dict[str, Any]:
    manifest = dict(project.manifest(), scenes=project.scene_entries())
    m = model.project_music(manifest)
    grid = model.grid_of(m)
    slots = model.slots_of(project, manifest)
    entries = [e if isinstance(e, dict) else {} for e in manifest["scenes"]]
    outgoing = tl.outgoing_transitions(manifest)
    durations = model.manifest_durations(project, manifest)
    cuts = tl.resolve_scene_cuts([
        {"durationMs": durations[i], "transition": outgoing[i], "cutAt": e.get("cutAt"), "align": e.get("align")} for i, e in enumerate(entries)
    ], m)
    scenes: List[Dict[str, Any]] = []
    flags: List[Dict[str, Any]] = []
    for i, slot in enumerate(slots):
        entry = entries[i]
        last = i + 1 >= len(slots)
        nxt = None if last else slots[i + 1].get("transitionIn")
        cut_ms = slot["endMs"] if last else tl.boundary_cut_ms(slots, i)
        row: Dict[str, Any] = {
            "index": i, "stem": slot["stem"], "startMs": js_json(slot["startMs"]), "endMs": js_json(slot["endMs"]),
            "durationMs": js_json(slot["durationMs"]), "start": where(m, slot["startMs"]), "end": where(m, slot["endMs"]),
            "cutMs": js_json(cut_ms), "cut": where(m, cut_ms), "cutAt": entry.get("cutAt"),
            "align": tl.cut_align(entry.get("align")) if isinstance(entry.get("cutAt"), str) else None,
            "transition": {"type": nxt["type"], "durationMs": js_json(nxt["durationMs"])} if isinstance(nxt, dict) else None,
        }
        scenes.append(row)
        if grid and not last and beat_point(m, slots, i) is None:
            flags.append({"kind": "off-beat", "scene": i, "stem": slot["stem"],
                          "message": f"the cut from {slot['stem']} into {slots[i + 1]['stem']} is at {where(m, cut_ms)}, off the beat"})
        overlap_in = (slot.get("transitionIn") or {}).get("durationMs", 0)
        overlap_out = nxt["durationMs"] if isinstance(nxt, dict) else 0
        if overlap_in + overlap_out > slot["durationMs"]:
            flags.append({"kind": "short", "scene": i, "stem": slot["stem"],
                          "message": f"{slot['stem']} ({fmt_ms(slot['durationMs'])}) is shorter than its transitions in and out ({fmt_ms(overlap_in + overlap_out)})"})
        flags += key_flags(project, i, slot)
    for issue in cuts["issues"]:
        flags.append({"kind": "cut", "message": issue})
    return {
        "command": "timeline",
        "grid": dict(grid, barMs=js_json(model.bar_ms(grid))) if grid else None,
        "totalMs": js_json(tl.timeline_total_ms(slots)),
        "scenes": scenes,
        "flags": flags,
        "drift": drift(project),
    }


def key_flags(project: Project, i: int, slot: Dict[str, Any]) -> List[Dict[str, Any]]:
    try:
        doc = project.load_sidecar(slot["stem"])
    except KbError:
        return []
    out = []
    for path, keys in model.timed_tracks(doc):
        for n, key in enumerate(keys):
            t = key.get("tMs") if isinstance(key, dict) else None
            if not isinstance(t, (int, float)) or isinstance(t, bool):
                continue
            name = f'{".".join(path)} key "{key.get("id", n)}"'
            if t > slot["durationMs"]:
                out.append({"kind": "key-past-end", "scene": i, "stem": slot["stem"],
                            "message": f"scenes/{slot['stem']}.json {name} at {fmt_ms(t)} is past the scene's end ({fmt_ms(slot['durationMs'])})"})
            elif t < 0:
                out.append({"kind": "key-before-start", "scene": i, "stem": slot["stem"],
                            "message": f"scenes/{slot['stem']}.json {name} at {fmt_ms(t)} is before the scene starts"})
    return out


def timeline_text(data: Dict[str, Any]) -> List[str]:
    grid = data["grid"]
    lines = [f"Grid: {js_json(grid['bpm'])} bpm, {grid['beatsPerBar']} beats a bar, a bar is {fmt_ms(grid['barMs'])}" if grid
             else "No beat grid: times are film ms (./kb beats set-grid to cut on bars)"]
    rows = []
    for s in data["scenes"]:
        centred = ", centred" if s["align"] == "mid" else ""
        pin = (f" (pinned{centred})" if s["cut"] == s["cutAt"] else f" (pinned to {s['cutAt']}{centred})") if s["cutAt"] else ""
        tr = s["transition"]
        rows.append([
            str(s["index"]), s["stem"], f"{s['startMs']}-{s['endMs']} ms",
            f"{s['start']} to {s['end']}" if grid else "",
            "" if s["index"] + 1 == len(data["scenes"]) else f"cut {s['cut']}{pin}",
            f"{tr['type']} {tr['durationMs']} ms" if tr else ("" if s["index"] + 1 == len(data["scenes"]) else "hard cut"),
        ])
    widths = [max(len(r[c]) for r in rows) for c in range(6)] if rows else []
    for r in rows:
        lines.append("  ".join(cell.ljust(widths[c]) for c, cell in enumerate(r)).rstrip())
    lines.append(f"Total {fmt_ms(data['totalMs'])}")
    flags = data["flags"] + data["drift"]
    if flags:
        lines.append("Check:")
        lines += [f"  ! {f['message']}" for f in flags]
    elif grid:
        lines.append("Every cut sits on a beat and every key inside its scene.")
    return lines


# ── kb timeline apply ─────────────────────────────────────────────────────────


def usage(message: str, hint: str = "see ./kb timeline apply --help, or reference/beats.md for the plan shape") -> KbError:
    return KbError(message, EXIT_ENV, kind="usage", hint=hint)


def parse_length(text: str, label: str) -> int:
    hit = _LENGTH.match(text.strip())
    if hit is None:
        raise usage(f"{label}: length \"{text}\" isn't ms (600, 600ms or 0.6s)")
    value = float(hit.group(1))
    return music.js_round(value * 1000 if hit.group(2) == "s" else value)


def parse_transition(value: Any, length: Any, ease: Any, label: str) -> Any:
    """A row's transition: ABSENT (keep it), None (a hard cut) or a spec dict."""
    if value is ABSENT or value == "":
        if length not in (ABSENT, None, ""):
            raise usage(f"{label}: a length needs a transition type")
        return ABSENT
    if value is None or (isinstance(value, str) and value.strip().lower() in ("none", "cut", "hard cut", "-")):
        return None
    if isinstance(value, dict):
        spec = dict(value)
    elif isinstance(value, str):
        parts = re.split(r"[:\s]+", value.strip(), maxsplit=1)
        spec = {"type": parts[0]}
        if len(parts) > 1 and parts[1]:
            spec["durationMs"] = parse_length(parts[1], label)
    else:
        raise usage(f"{label}: transition must be TYPE, TYPE:MS, an object or null")
    if length not in (ABSENT, None, ""):
        spec["durationMs"] = parse_length(str(length), label)
    if ease not in (ABSENT, None, ""):
        spec["ease"] = ease
    if not isinstance(spec.get("type"), str) or not spec["type"]:
        raise usage(f"{label}: transition needs a type")
    if "durationMs" not in spec:
        spec["durationMs"] = 600
    if not isinstance(spec["durationMs"], (int, float)) or isinstance(spec["durationMs"], bool) or spec["durationMs"] < 0:
        raise usage(f"{label}: transition durationMs must be a number of ms >= 0")
    if spec.get("ease") == "linear":
        spec.pop("ease")
    return spec


def parse_cut(value: Any, label: str, bare_bars: bool) -> Any:
    if value is ABSENT or value == "" or value == "-":
        return ABSENT
    if value is None:
        return None
    if not isinstance(value, str):
        raise usage(f"{label}: cutAt must be a position like bar:9, or null to unpin")
    text = value.strip()
    if bare_bars:
        hit = _BAR.match(text)
        if hit:
            text = f"bar:{hit.group(1)}"
    if not model.is_time(text):
        raise usage(f'{label}: cut "{value}" isn\'t a position (bar:9, cue:drop) or a time (12.5s)')
    return text


def normalise_row(raw: Any, label: str, bare_bars: bool = False) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise usage(f"{label} must be an object with a scene")
    scene = raw.get("scene")
    if isinstance(scene, bool) or not isinstance(scene, (str, int)) or str(scene).strip() == "":
        raise usage(f"{label}: scene must be a stem or an index")
    align = raw.get("align", ABSENT)
    if align in (ABSENT, None, "", "-"):
        align = None
    elif align not in ALIGNS:
        raise usage(f'{label}: align must be "end" or "mid"')
    unknown = sorted(set(raw) - {"scene", "cutAt", "align", "transition", "length", "ease"})
    if unknown:
        raise usage(f"{label}: unknown field {', '.join(unknown)}; rows hold scene, cutAt, align and transition")
    return {
        "label": label,
        "scene": str(scene).strip(),
        "cutAt": parse_cut(raw.get("cutAt", ABSENT), label, bare_bars),
        "align": align,
        "transition": parse_transition(raw.get("transition", ABSENT), raw.get("length", ABSENT), raw.get("ease", ABSENT), label),
    }


def markdown_rows(text: str) -> List[Dict[str, Any]]:
    table = [line.strip() for line in text.splitlines() if line.strip().startswith("|")]
    cells = [[c.strip() for c in line.strip("|").split("|")] for line in table]
    cells = [row for row in cells if not all(re.fullmatch(r":?-{2,}:?", c) for c in row if c)]
    if len(cells) < 2:
        raise usage("the plan has no table: a markdown plan is a | scene | cut | transition | length | align | table")
    header = [_COLUMNS.get(h.lower()) for h in cells[0]]
    missing = [h for h, key in zip(cells[0], header) if key is None and h]
    if missing:
        raise usage(f"unknown column {', '.join(missing)}; columns are scene, cut, transition, length, align and ease")
    if "scene" not in header:
        raise usage("the plan table needs a scene column")
    rows = []
    for n, row in enumerate(cells[1:], start=1):
        raw: Dict[str, Any] = {key: row[c] for c, key in enumerate(header) if key and c < len(row) and row[c] not in ("", "-")}
        if "scene" not in raw:
            raise usage(f"table row {n}: no scene")
        rows.append(normalise_row(raw, f"table row {n}", bare_bars=True))
    return rows


def parse_plan(text: str) -> List[Dict[str, Any]]:
    """A plan's rows, from JSON ({"version": 1, "cuts": [...]}) or a markdown table."""
    if text.lstrip().startswith(("{", "[")):
        try:
            data = json.loads(text)
        except ValueError as e:
            raise usage(f"the plan isn't valid JSON: {e}") from None
        if isinstance(data, dict) and data.get("version", PLAN_VERSION) != PLAN_VERSION:
            raise usage(f"the plan's version must be {PLAN_VERSION}")
        rows = data.get("cuts") if isinstance(data, dict) else data
        if not isinstance(rows, list) or not rows:
            raise usage('a JSON plan is {"version": 1, "cuts": [{"scene": "02-hero", "cutAt": "bar:9", "align": "mid", "transition": "crossfade:600"}]}')
        return [normalise_row(r, f"cuts[{i}]") for i, r in enumerate(rows)]
    return markdown_rows(text)


def apply_plan(project: Project, rows: List[Dict[str, Any]], opts: lockmod.WriteOpts, ripple: bool = False) -> Tuple[List[str], lockmod.Txn]:
    from . import catalog as catmod
    from . import scenes as scenemod

    known = catmod.load_catalog().ids("transitions", catmod.FALLBACK_TRANSITIONS) or []
    for row in rows:
        spec = row["transition"]
        if isinstance(spec, dict) and spec["type"] not in known:
            raise usage(f'{row["label"]}: unknown transition "{spec["type"]}"', hint="list them with ./kb catalog transitions")
    pins = scenemod.Pins()

    def build(tx: lockmod.Txn) -> List[str]:
        _raw, manifest = scenemod._manifest_for_edit(tx)
        view = scenemod._view(project, manifest)
        scenes = manifest["scenes"]
        placed: Dict[int, Dict[str, Any]] = {}
        for row in rows:
            idx, stem = pins.resolve(view, row["scene"])
            if idx in placed:
                raise usage(f'{row["label"]}: {stem} is already in the plan ({placed[idx]["label"]})')
            placed[idx] = dict(row, stem=stem)
        grid = model.grid_of(model.project_music(manifest))
        changes: List[str] = []
        for idx in sorted(placed):
            row, entry = placed[idx], scenes[idx]
            name = f"scene {idx} {row['stem']}"
            spec = row["transition"]
            if spec is not ABSENT:
                if idx + 1 >= len(scenes):
                    if spec is not None:
                        raise KbError(f'{row["label"]}: {row["stem"]} is the last scene, so it has no outgoing transition', EXIT_PROBLEMS, kind="invalid")
                elif row["cutAt"] is ABSENT and grid and not ripple:
                    changes.append(f"{name}: transition = {spec or 'hard cut'}; {scenemod.keep_cuts(project, manifest, idx, spec)}")
                else:
                    if spec is None:
                        entry.pop("transition", None)
                    else:
                        entry["transition"] = spec
                    changes.append(f"{name}: transition = {spec or 'hard cut'}")
            cut = row["cutAt"]
            if cut is None:
                if model.unpin(entry):
                    changes.append(f"{name}: unpinned (durationMs {js_json(entry.get('durationMs'))} stays)")
            elif cut is not ABSENT:
                entry["durationMs"], change = model.cut_timing(cut, row["align"] or "end")(project, manifest, idx)
                changes.append(f"{name}: {change}")
                manual = scenemod.manual_length(tx, row["stem"]) if "cutAt" in entry else None
                if manual:
                    changes.append(manual)
            elif row["align"] is not None:
                if not isinstance(entry.get("cutAt"), str):
                    raise usage(f'{row["label"]}: align needs a cut; {row["stem"]} isn\'t pinned')
                if row["align"] == "mid":
                    entry["align"] = "mid"
                else:
                    entry.pop("align", None)
                changes.append(f"{name}: align = {row['align']}")
        changes += model.settle_cuts(project, manifest)
        tx.write_json(MANIFEST, manifest)
        notes: List[str] = []
        moved = model.refresh_sidecars(tx, project, manifest, notes)
        return changes + [f"refreshed tMs caches in {line}" for line in model.moved_notes(moved)] + notes

    return scenemod._run(project, "kb timeline apply", build, opts)


# ── drift ─────────────────────────────────────────────────────────────────────


def drift_between(project: Project, before: Dict[str, Any], after: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Cuts that sat on a beat in `before` and sit on none in `after` (matched by the scenes either side)."""
    m_after = model.project_music(after)
    if not model.grid_of(m_after):
        return []
    m_before = model.project_music(before)
    try:
        was, now = model.slots_of(project, before), model.slots_of(project, after)
    except KbError:
        return []
    earlier = {(was[i]["stem"], was[i + 1]["stem"]): i for i in range(len(was) - 1)}
    out = []
    for i in range(len(now) - 1):
        pair = (now[i]["stem"], now[i + 1]["stem"])
        j = earlier.get(pair)
        point = None if j is None else beat_point(m_before, was, j)
        if point is None or beat_point(m_after, now, i) is not None:
            continue
        kind, position = point
        align = "end" if kind == "end" else "mid"
        out.append({
            "kind": "drift", "scene": i, "stem": pair[0], "position": position,
            "message": f"the cut from {pair[0]} into {pair[1]} sat on {position} and is now at {where(m_after, tl.boundary_cut_ms(now, i))}: "
                       f"an earlier length or transition moved it. Pin it: ./kb scene set {pair[0]} --cut-at {position} --align {align}, or ./kb timeline apply",
        })
    return out


def drift_from_checkpoint(project: Project, manifest: Dict[str, Any]) -> List[Dict[str, Any]]:
    """drift_between the last checkpoint's project.json and manifest; empty without git or a checkpoint."""
    from . import git as gitmod

    try:
        if not gitmod.git_available() or gitmod.repo_state(project) == "foreign" or not gitmod.has_head(project):
            return []
        before = gitmod.show_json(project, "HEAD", MANIFEST)
        if not isinstance(before, dict) or not isinstance(before.get("scenes"), list):
            return []
        return drift_between(project, before, manifest)
    except (KbError, TypeError, ValueError, KeyError):
        return []


def drift(project: Project) -> List[Dict[str, Any]]:
    """drift_from_checkpoint for the project on disk."""
    try:
        return drift_from_checkpoint(project, project.manifest())
    except KbError:
        return []


# ── commands ──────────────────────────────────────────────────────────────────

EPILOG = """  ./kb timeline                      every scene's start, end, cut and transition in bars and ms
  ./kb timeline --json
  ./kb timeline apply cuts.json      write a plan's cuts and transitions in one checkpointed write
  ./kb timeline apply cuts.md --dry-run
A plan is JSON ({"version": 1, "cuts": [{"scene", "cutAt", "align", "transition"}]}) or a markdown table with
scene, cut, transition, length and align columns (reference/beats.md). A cut that is a position pins it: the scene's
length then follows the grid and earlier transitions. Flags: cuts off the beat, scenes shorter than their transitions,
keys outside their scene, and cuts that sat on a beat at the last checkpoint and no longer do."""


def cmd_timeline(ctx: Any) -> int:
    if getattr(ctx.args, "op", None) == "apply":
        return cmd_apply(ctx)
    data = timeline_data(ctx.project)
    if ctx.json:
        ctx.out(data)
        return EXIT_OK
    for line in timeline_text(data):
        emit(line)
    return EXIT_OK


def read_plan(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    try:
        return Path(path).expanduser().read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        raise KbError(f"can't read the plan {path}: {e}", EXIT_ENV, kind="usage") from None


def cmd_apply(ctx: Any) -> int:
    from . import git as gitmod

    project = ctx.project
    rows = parse_plan(read_plan(ctx.args.plan))
    saved = None
    if not ctx.dry_run and gitmod.git_available() and gitmod.repo_state(project) != "foreign" and gitmod.dirty_files(project):
        saved = gitmod.checkpoint(project, "before kb timeline apply")
    changes, tx = apply_plan(project, rows, ctx.opts, ripple=ctx.args.ripple)
    if tx.dry_run:
        if ctx.json:
            ctx.out({"changes": changes, "writes": tx.writes, "dryRun": True})
            return EXIT_OK
        emit("dry run, nothing written:")
        for c in changes:
            emit(f"  {c}")
        for w in tx.writes:
            emit(f"  {w['action']:<6} {w['path']}")
        return EXIT_OK
    data = timeline_data(project)
    if ctx.json:
        ctx.out({"changes": changes, "writes": tx.writes, "dryRun": False, "checkpoint": saved, "timeline": data})
        return EXIT_OK
    for c in changes:
        emit(c)
    if saved:
        emit(f"checkpoint {saved} holds the state before the plan (./kb undo {saved})")
    for line in timeline_text(data):
        emit(line)
    return EXIT_OK


def register(sub: Any, common: argparse.ArgumentParser, Formatter: Any) -> None:
    structural = argparse.ArgumentParser(add_help=False)
    structural.add_argument("--dry-run", action="store_true", help="list the changes and files; write nothing")
    structural.add_argument("--wait", type=float, nargs="?", const=600.0, default=None, metavar="SECONDS", help="wait for another kb write to finish (default 10 s)")
    p = sub.add_parser("timeline", help="every scene's start, end, cut and transition in bars and ms; apply a cut plan",
                       description="every scene's start, end, cut and transition in bars and ms, with off-beat cuts and keys outside their scene flagged",
                       epilog=EPILOG, formatter_class=Formatter, parents=[common])
    ops = p.add_subparsers(dest="op", metavar="OP")
    ops.required = False
    x = ops.add_parser("apply", help="write a plan's cuts and transitions in one checkpointed write",
                       description="write every cut and transition in a plan (JSON or a markdown table) in one checkpointed write",
                       epilog=EPILOG, formatter_class=Formatter, parents=[common, structural])
    x.add_argument("plan", metavar="PLAN", help="a .json or .md plan file, or - for stdin")
    x.add_argument("--ripple", action="store_true", help="rows that change only a transition let later scenes move by the overlap")
    p.set_defaults(fn=cmd_timeline)
