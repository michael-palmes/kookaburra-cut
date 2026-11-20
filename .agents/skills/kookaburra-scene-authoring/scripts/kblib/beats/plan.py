"""kb beats plan: a scene plan drafted from the song (DESIGN.md, "Pacing"), counted from where the film starts. Each
part of the song gets scenes of the length its energy suits (quiet parts about 2 bars, peaks 1 to 2), the build into
the last peak ends in a burst, the payoff takes the final hit, and every scene says how often something new must land
in it and how many words read in it. The cuts come out as a plan ./kb timeline apply takes; --apply retimes the
project's scenes to it, and with --from starts the soundtrack on that bar in the same write."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from .. import lock as lockmod
from .. import music
from ..project import Project
from ..util import EXIT_ENV, EXIT_OK, EXIT_PROBLEMS, KbError, emit, js_json
from . import model, pulse

QUIET_BARS = 2.0
PEAK_BARS = 1.5
BURST_BARS = 4
# A stretch between the song's parts shorter than this joins its neighbour instead of taking a scene of its own.
GAP_BARS = 2
NO_SOUNDTRACK_HINT = ("ask the person for a song first: the pulse comes from it. Then ./kb assets add FILE, "
                      "./kb project set audio.file assets/<name> and ./kb song analyse --accept")

EPILOG = """\
  ./kb beats plan                          the song's parts and a scene plan in bars (writes nothing)
  ./kb beats plan --scenes 12              the same with 12 scenes
  ./kb beats plan --from bar:9 --to bar:25 plan a cut of the song (a short social edit) that starts on bar 9
  ./kb beats plan --apply                  retime the project's scenes to the plan (one checkpointed write)
  ./kb beats plan --json | ./kb timeline apply -   the same through the cut plan
The plan counts from where the film starts: bar 1, or the bar audio.startOffsetMs puts there.
--from starts the film on another bar, and --apply then sets audio.startOffsetMs in the same write.
The plan is a draft: show it to the person before writing anything, and they decide. --apply keeps the
project's scene count and order, and each scene's transition."""


def usage(message: str, hint: Optional[str] = None) -> KbError:
    return KbError(message, EXIT_ENV, kind="usage", hint=hint)


def _half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def bar_of(shape: Dict[str, Any], project_ms: float) -> float:
    """The 1-based bar a project time falls in, fractional."""
    return (project_ms + shape["startOffsetMs"] - shape["grid"]["offsetMs"]) / shape["barMs"] + 1


def ms_of(shape: Dict[str, Any], beat_index: int) -> float:
    """Project ms of a beat counted from bar 1 beat 1 (index 0)."""
    return shape["grid"]["offsetMs"] + beat_index * shape["beatMs"] - shape["startOffsetMs"]


def pos(shape: Dict[str, Any], beat_index: int) -> str:
    per = shape["beatsPerBar"]
    bar, beat = beat_index // per + 1, beat_index % per + 1
    return f"bar:{bar}" if beat == 1 else f"bar:{bar}.{beat}"


def pos_at(shape: Dict[str, Any], project_ms: float) -> str:
    """A project time as its nearest beat, nudged onto the ms when it sits off the beat."""
    beat = music.js_round((project_ms + shape["startOffsetMs"] - shape["grid"]["offsetMs"]) / shape["beatMs"])
    nudge = music.js_round(project_ms - ms_of(shape, beat))
    return pos(shape, beat) + (f"{nudge:+d}ms" if nudge else "")


def start_bar(shape: Dict[str, Any]) -> int:
    """The first bar line at or after the film's start (project time 0), a ms early counting as on it."""
    return math.ceil(bar_of(shape, 0.0) - 1.0 / shape["barMs"])


def rebased(shape: Dict[str, Any], offset: float) -> Dict[str, Any]:
    """The song's shape with the soundtrack starting offset ms into the track: bars stay, project times move."""
    shift = shape["startOffsetMs"] - offset
    out = dict(shape, startOffsetMs=offset, parts=[dict(p, fromMs=p["fromMs"] + shift, toMs=p["toMs"] + shift) for p in shape["parts"]],
               fills=[dict(f, ms=f["ms"] + shift) for f in shape["fills"]])
    for key in ("finalHitMs", "audibleEndMs"):
        if out.get(key) is not None:
            out[key] += shift
    return out


def start_offset(shape: Dict[str, Any], lo: int, moved: bool) -> float:
    """audio.startOffsetMs that starts the film on bar lo when --from moved it, else the project's own."""
    offset = shape["startOffsetMs"]
    if not moved:
        return offset
    track = shape["grid"]["offsetMs"] + (lo - 1) * shape["barMs"]
    if track < 0:
        raise KbError(f"bar:{lo} starts {-track / 1000:.2f} s before the song does, so the film can't start on it", EXIT_PROBLEMS,
                      kind="invalid", hint="--from a later bar")
    return offset if abs(track - offset) < 1 else music.round_ms(track)


def window(shape: Dict[str, Any], project: Project, manifest: Dict[str, Any], first: Optional[str], last: Optional[str]) -> Tuple[int, int, str]:
    """(first bar, the bar the film ends on, why): --from, else the bar the film starts on; --to, else a bar after the
    final hit, else the song's audible end, else the film's current end."""
    m = model.project_music(manifest)

    def bound(text: Optional[str], flag: str) -> Optional[int]:
        return None if text is None else _half_up(bar_of(shape, model.parse_time(text, m, flag)["projectMs"]))

    lo = bound(first, "--from")
    if lo is None:
        lo = start_bar(shape)
    hi, why = bound(last, "--to"), "--to"
    if hi is None and shape.get("finalHitMs") is not None:
        hi, why = math.floor(bar_of(shape, shape["finalHitMs"]) + 1e-6) + 1, "a bar after the final hit"
    if hi is None and shape.get("audibleEndMs") is not None:
        hi, why = math.floor(bar_of(shape, shape["audibleEndMs"]) + 1e-6), "at the song's audible end"
    if hi is None:
        slots = model.slots_of(project, manifest)
        hi, why = _half_up(bar_of(shape, float(slots[-1]["endMs"]) if slots else 0.0)), "where the film ends now"
    if hi <= lo:
        raise usage(f"the plan would end on bar {hi}, at or before it starts (bar {lo})", "pass --to POS after --from POS")
    return lo, hi, why


def parts_in(shape: Dict[str, Any], lo: int, hi: int) -> List[Dict[str, Any]]:
    """The song's parts within bars lo..hi (hi exclusive) with any stretch between them a quiet part; one under 2 bars
    joins the part before it, or the quiet part after it at the start (a peak keeps its downbeat). Where hand-written
    sections overlap, the earlier part keeps the bars."""
    out: List[Dict[str, Any]] = []
    cursor = lo

    def add(ident: str, kind: str, a: int, b: int, gap: bool) -> None:
        out.append({"id": ident, "kind": kind, "fromBar": a, "toBar": b, "gap": gap})

    for p in shape["parts"]:
        a, b = max(p["fromBar"], lo, cursor), min(p["toBar"], hi)
        if b > a:
            if a > cursor:
                add("unnamed", "quiet", cursor, a, True)
            add(p["id"], p["kind"], a, b, False)
            cursor = b
    if cursor < hi:
        add("unnamed" if out else "song", "quiet", cursor, hi, bool(out))
    i = 0
    while i < len(out):
        p = out[i]
        if p["gap"] and p["toBar"] - p["fromBar"] < GAP_BARS and len(out) > 1:
            if i > 0:
                out[i - 1]["toBar"] = p["toBar"]
            elif out[1]["kind"] == "quiet":
                out[1]["fromBar"] = p["fromBar"]
            else:
                p["gap"] = False
                i += 1
                continue
            del out[i]
            continue
        i += 1
    for p in out:
        p.pop("gap")
        p["bars"] = p["toBar"] - p["fromBar"]
    return out


def burst_index(parts: List[Dict[str, Any]], shape: Dict[str, Any]) -> Optional[int]:
    """The quiet part (4 bars or more) leading into the last peak that starts by the final hit: its last bars burst."""
    final = shape.get("finalHitMs")
    final_bar = bar_of(shape, final) if final is not None else None
    for i in range(len(parts) - 1, 0, -1):
        p, before = parts[i], parts[i - 1]
        if p["kind"] == "peak" and before["kind"] == "quiet" and before["bars"] >= 4 and (final_bar is None or p["fromBar"] <= final_bar):
            return i - 1
    return None


def _preferred(unit: Dict[str, Any]) -> float:
    return PEAK_BARS if unit["kind"] == "peak" else QUIET_BARS


def _most(unit: Dict[str, Any], per_bar: int) -> int:
    """Scenes a stretch can hold: a bar each when quiet, two beats each in a peak (split's half bars), one burst."""
    if unit["kind"] == "burst":
        return 1
    if unit["kind"] == "peak" and per_bar >= 4 and per_bar % 2 == 0:
        return unit["bars"] * per_bar // 2
    return max(1, unit["bars"])


def fit_counts(units: List[Dict[str, Any]], target: Optional[int], per_bar: int = 4) -> List[int]:
    """Scenes per stretch: its bars over the preferred length, then grown or shrunk to target where the scenes run
    longest or shortest against that length."""
    counts = [1 if u["kind"] == "burst" else max(1, _half_up(u["bars"] / _preferred(u))) for u in units]
    if target is None:
        return counts
    ceiling = sum(_most(u, per_bar) for u in units)
    if target > ceiling:
        raise KbError(f"{target} scenes don't fit these bars: at most {ceiling} (a bar each in quiet parts, two beats in peaks)",
                      EXIT_PROBLEMS, kind="invalid", hint="plan fewer scenes, or a longer stretch of the song with --from and --to")
    if target < len(units):
        raise KbError(f"{target} scenes are fewer than the {len(units)} stretches of the song this plan covers", EXIT_PROBLEMS, kind="invalid",
                      hint="plan a shorter stretch with --from and --to, or more scenes")

    def ratio(j: int) -> float:
        return units[j]["bars"] / counts[j] / _preferred(units[j])

    while sum(counts) < target:
        i = max((j for j in range(len(units)) if counts[j] < _most(units[j], per_bar)), key=lambda j: (ratio(j), -j))
        counts[i] += 1
    while sum(counts) > target:
        i = min((j for j in range(len(units)) if counts[j] > 1), key=lambda j: (ratio(j), j))
        counts[i] -= 1
    return counts


def split(unit: Dict[str, Any], count: int, per_bar: int) -> List[Tuple[int, int]]:
    """count scenes over the stretch as (from, to) beat indexes from bar 1 beat 1: on bar lines when each gets a bar or
    more, else on half bars."""
    start = (unit["fromBar"] - 1) * per_bar
    step = per_bar if count <= unit["bars"] else (2 if per_bar % 2 == 0 else 1)
    steps = unit["bars"] * per_bar // step
    count = min(count, steps)
    edges = [start + _half_up(i * steps / count) * step for i in range(count + 1)]
    return [(a, b) for a, b in zip(edges, edges[1:]) if b > a]


def draft(project: Project, scenes: Optional[int] = None, first: Optional[str] = None, last: Optional[str] = None) -> Dict[str, Any]:
    manifest = project.manifest()
    shape = pulse.song_shape(project, manifest)
    if shape["gridSource"] != "authored":
        if not shape["soundtrack"]:
            raise KbError("this project has no soundtrack, so there is no song to plan from", EXIT_PROBLEMS, kind="invalid", hint=NO_SOUNDTRACK_HINT)
        raise KbError("the soundtrack has no beat grid yet", EXIT_PROBLEMS, kind="invalid", hint="./kb song analyse --accept fits one and finds the song's parts")
    lo, hi, why = window(shape, project, manifest, first, last)
    per = shape["beatsPerBar"]
    was = shape["startOffsetMs"]
    offset = start_offset(shape, lo, first is not None)
    now_shape, shape = shape, rebased(shape, offset) if offset != was else shape
    parts = parts_in(shape, lo, hi)
    burst_at = burst_index(parts, shape)
    units: List[Dict[str, Any]] = []
    for i, p in enumerate(parts):
        if i == burst_at:
            size = min(BURST_BARS, p["bars"] // 2)
            units.append(dict(p, toBar=p["toBar"] - size, bars=p["bars"] - size, part=i))
            units.append(dict(p, kind="burst", fromBar=p["toBar"] - size, bars=size, part=i))
        else:
            units.append(dict(p, part=i))
    counts = fit_counts(units, scenes, per)
    first_peak = next((p["fromBar"] for p in parts if p["kind"] == "peak"), None)
    # The film starts at project 0, so a pickup before bar lo's line joins the first scene.
    pickup = ms_of(shape, (lo - 1) * per) >= 1
    slots: List[Dict[str, Any]] = []
    for unit, count in zip(units, counts):
        each = pulse.pulse_beats(unit["kind"], per)
        for a, b in split(unit, count, per):
            start, end = ms_of(shape, a), ms_of(shape, b)
            beats: float = b - a
            label = pos(shape, a)
            if not slots:
                start = 0.0
                if pickup:
                    beats, label = end / shape["beatMs"], pos_at(shape, 0.0)
            role = "open: the hook" if not slots else ""
            if first_peak is not None and a == (first_peak - 1) * per:
                role = "reveal: lands on the downbeat"
            if unit["kind"] == "burst":
                role = "burst: a cut every beat inside one scene, pictures not words"
            slots.append({"index": len(slots), "part": unit["id"], "partIndex": unit["part"], "kind": unit["kind"],
                          "from": label, "cutAt": pos(shape, b), "fromMs": round(start), "toMs": round(end),
                          "lengthMs": round(end - start), "bars": round(beats / per, 2), "pulse": pulse.pulse_words(each, per),
                          "changes": max(1, math.ceil(beats / each - 1e-6)),
                          "maxWords": 0 if unit["kind"] == "burst" else max(0, int((end - start - pulse.READ_SETTLE_MS) // pulse.READ_WORD_MS)),
                          "role": role})
    final = shape.get("finalHitMs")
    hit = next((s for s in slots if final is not None and s["fromMs"] - 1 <= final < s["toMs"] - 1), None)
    if hit is not None:
        hit["role"] = f"payoff: lands on the final hit ({shape['finalHit']})"
    else:
        slots[-1]["role"] = "payoff: lands on its first downbeat"
    stems = project.stems()
    named = len(stems) == len(slots)
    entries = manifest.get("scenes") if isinstance(manifest.get("scenes"), list) else []
    current = model.slots_of(project, manifest) if named else []
    rows = []
    for s in slots:
        s["scene"] = stems[s["index"]] if named else f"scene-{s['index'] + 1:02d}"
        if named and s["index"] < len(current):
            now = current[s["index"]]
            s["now"] = f"{pulse.position(now_shape, now['startMs'])} to {pulse.position(now_shape, now['endMs'])}"
        row = {"scene": s["scene"], "cutAt": s["cutAt"]}
        entry = entries[s["index"]] if named and s["index"] < len(entries) else None
        if isinstance(entry, dict) and entry.get("align") == "mid":
            row["align"] = "mid"
        rows.append(row)
    part_rows = []
    for i, p in enumerate(parts):
        mine = [s for s in slots if s["partIndex"] == i]
        burst = next((s for s in mine if s["kind"] == "burst"), None)
        part_rows.append({"id": p["id"], "kind": p["kind"], "fromBar": p["fromBar"], "toBar": p["toBar"], "scenes": len(mine),
                          "pulse": pulse.pulse_words(pulse.pulse_beats(p["kind"], per), per),
                          "burst": f"{burst['from']} to {burst['cutAt']}" if burst else None})
    notes = []
    if not shape["parts"]:
        notes.append("no song parts found, so every bar counts as quiet (./kb song analyse finds them)")
    if scenes is None and stems and not named:
        notes.append(f"the project has {len(stems)} scenes and this plan {len(slots)}; --scenes {len(stems)} plans for the ones it has")
    film = {"fromBar": lo, "from": slots[0]["from"], "toBar": hi, "endsAt": why, "lengthMs": round(ms_of(shape, (hi - 1) * per)),
            "scenes": len(slots), "matchesProject": named, "startOffsetMs": offset}
    if offset != was:
        film["startOffsetWas"] = was
        notes.append(f"the film starts on bar:{lo} once audio.startOffsetMs is {offset}: --apply sets it; ./kb timeline apply leaves it, "
                     f"so run ./kb project set audio.startOffsetMs {offset} before that")
    return {
        "version": 1, "cuts": rows, "slots": slots, "parts": part_rows, "notes": notes,
        "song": {"bpm": shape["grid"]["bpm"], "beatsPerBar": per, "barMs": round(shape["barMs"], 3), "partsSource": shape["partsSource"],
                 "finalHit": shape["finalHit"], "finalHitMs": round(final) if final is not None else None},
        "film": film,
    }


def print_plan(data: Dict[str, Any]) -> None:
    song, film = data["song"], data["film"]
    source = {"sections": "the project's sections", "analysis": "the song analysis"}.get(song["partsSource"] or "", "none found")
    final = f"; final hit {song['finalHit']}" if song.get("finalHit") else ""
    emit(f"Song: {song['bpm']:g} bpm, {song['beatsPerBar']} beats a bar (a bar is {song['barMs'] / 1000:.2f} s); parts from {source}{final}")
    emit(f"Film: {film['from']} to bar:{film['toBar']}, {film['lengthMs'] / 1000:.1f} s (ends {film['endsAt']}), {film['scenes']} scenes")
    if "startOffsetWas" in film:
        emit(f"Start: the soundtrack starts on bar:{film['fromBar']}, so --apply sets audio.startOffsetMs to {film['startOffsetMs']} "
             f"(now {js_json(film['startOffsetWas'])})")
    emit("")
    emit(f"{'Part':<14}{'Bars':<9}{'Kind':<7}{'New every':<15}Scenes")
    for p in data["parts"]:
        extra = f" (a burst {p['burst']})" if p.get("burst") else ""
        emit(f"{p['id']:<14}{str(p['fromBar']) + '-' + str(p['toBar'] - 1):<9}{p['kind']:<7}{p['pulse']:<15}{p['scenes']}{extra}")
    emit("")
    now = film["matchesProject"]
    emit(f"{'#':>2}  {'Scene':<16}{'From':<11}{'Cut at':<11}{'Length':<8}{'New every':<15}{'Changes':<9}{'Words':<7}"
         + (f"{'Now':<22}" if now else "") + "Role")
    for s in data["slots"]:
        emit(f"{s['index'] + 1:>2}  {s['scene']:<16}{s['from']:<11}{s['cutAt']:<11}{s['lengthMs'] / 1000:<8.2f}{s['pulse']:<15}"
             f"{s['changes']:<9}{s['maxWords']:<7}" + (f"{s.get('now') or '':<22}" if now else "") + s["role"])
    emit("")
    emit("Changes: the fewest things that land in the scene, its cut included. Words: the most one line holds and still reads once.")
    for n in data["notes"]:
        emit(f"note: {n}")
    if film["matchesProject"]:
        emit("A draft: show the person first, and check each scene's role (the reveal, a montage, the payoff) lands in a slot")
        emit("that suits it; --apply keeps the scene order. ./kb beats plan --apply then retimes them in one checkpointed write,")
        emit("or edit the cuts (--json) and ./kb timeline apply them.")
    else:
        emit("A draft: show the person first, then write the scenes; ./kb beats plan --apply retimes them once the count matches.")


def cmd_plan(ctx: Any) -> int:
    from .. import cuts
    from .. import git as gitmod

    a = ctx.args
    project = ctx.project
    count = a.scenes
    if count is not None and count < 1:
        raise usage("--scenes takes 1 or more")
    if a.apply:
        have = len(project.stems())
        if count is not None and count != have:
            raise usage(f"--apply retimes the project's {have} scenes, so leave --scenes out or make it {have}")
        count = have
    data = draft(project, count, a.from_, a.to)
    if not a.apply:
        if ctx.json:
            ctx.out(data)
            return EXIT_OK
        print_plan(data)
        return EXIT_OK
    rows = [cuts.normalise_row(r, f"cuts[{i}]") for i, r in enumerate(data["cuts"])]
    offset = data["film"]["startOffsetMs"] if "startOffsetWas" in data["film"] else None
    saved = None
    if not ctx.dry_run and gitmod.git_available() and gitmod.repo_state(project) != "foreign" and gitmod.dirty_files(project):
        cuts.apply_plan(project, rows, lockmod.WriteOpts(True, ctx.wait, ctx.caller), start_offset=offset)
        saved = gitmod.checkpoint(project, "before kb beats plan --apply")
    changes, tx = cuts.apply_plan(project, rows, ctx.opts, start_offset=offset)
    if ctx.json:
        ctx.out(dict(data, changes=changes, writes=tx.writes, dryRun=tx.dry_run, checkpoint=saved))
        return EXIT_OK
    print_plan(data)
    emit("")
    emit("dry run, nothing written:" if tx.dry_run else "retimed:")
    for c in changes:
        emit(f"  {c}")
    if saved:
        emit(f"checkpoint {saved} holds the state before the plan (./kb undo {saved})")
    return EXIT_OK
