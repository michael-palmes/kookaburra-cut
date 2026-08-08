#!/usr/bin/env python3
"""Beat guidance from the soundtrack's cached analysis: bpm, the beat grid and key
moments, mapped into project time and each scene's local time.

Run from a project folder (where project.json lives):
    python3 .claude/skills/kookaburra-scene-authoring/scripts/beats.py             # per-scene summary
    python3 .claude/skills/kookaburra-scene-authoring/scripts/beats.py --scene 2   # one scene, every beat listed
    python3 .claude/skills/kookaburra-scene-authoring/scripts/beats.py --json      # machine-readable dump

Reads the analysis cache the app writes when a project with a soundtrack opens.
If it is missing, ask the user to open this project in Kookaburra Cut once, then rerun.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

CACHE_DIR = Path.home() / "Library/Application Support/com.mpalmes.kookaburracut/cache/beats"
ANALYSIS_VERSION = 1
MARKER_MATCH_MS = 30
MANUAL_STRENGTH = 0.8


def build_slots(scenes):
    """Mirror engine/sceneTimeline.ts: a scene's outgoing transition pulls the next start back."""
    slots = []
    for i, sc in enumerate(scenes):
        duration = sc.get("durationMs", 0)
        start = 0
        t_in = 0
        if i:
            prev = slots[-1]
            spec = scenes[i - 1].get("transition") or {}
            t_in = max(0, min(spec.get("durationMs", 0) or 0, prev["durationMs"], duration))
            start = prev["endMs"] - t_in
        slots.append({
            "index": i,
            "stem": Path(sc.get("file", f"scene-{i}")).stem,
            "startMs": start,
            "durationMs": duration,
            "endMs": start + duration,
            "transitionInMs": t_in,
        })
    for i, slot in enumerate(slots):
        next_in = slots[i + 1]["transitionInMs"] if i + 1 < len(slots) else 0
        slot["windowStartMs"] = slot["transitionInMs"] / 2
        slot["windowEndMs"] = slot["durationMs"] - next_in / 2
        slot["transitionOutStartMs"] = (
            slot["durationMs"] - next_in if next_in else slot["windowEndMs"]
        )
    return slots


def effective_key_moments(analysis, markers, start_offset, total):
    """Mirror engine/beatState.ts: markers replace detection wholesale, in project time."""
    detected = [
        {"tMs": m["tMs"] - start_offset, "strength": m.get("strength", 0)}
        for m in analysis.get("keyMoments", [])
    ]
    detected = [m for m in detected if 0 <= m["tMs"] <= total]
    if not markers:
        return detected, "detected"
    moments = []
    for t in markers.get("keyMoments", []):
        if not 0 <= t <= total:
            continue
        near = next((m for m in detected if abs(m["tMs"] - t) <= MARKER_MATCH_MS), None)
        moments.append({"tMs": t, "strength": near["strength"] if near else MANUAL_STRENGTH})
    return sorted(moments, key=lambda m: m["tMs"]), "project.json audio.markers"


def scene_local(slot, times):
    return [t - slot["startMs"] for t in times if slot["startMs"] <= t <= slot["endMs"]]


def fmt_moments(moments):
    return ", ".join(f"{round(m['tMs'])} ({m['strength']:.2f})" for m in moments) or "none"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--scene", help="scene index or file stem for full beat detail")
    ap.add_argument("--json", action="store_true", help="machine-readable dump")
    args = ap.parse_args()

    manifest_path = Path("project.json")
    if not manifest_path.is_file():
        print("beats: no project.json here; run from a project folder", file=sys.stderr)
        return 2
    manifest = json.loads(manifest_path.read_text())
    audio = manifest.get("audio") or {}
    if not audio.get("file"):
        print("beats: this project has no soundtrack (no audio block in project.json)")
        return 0
    audio_path = Path(audio["file"])
    if not audio_path.is_file():
        print(f"beats: soundtrack missing on disk: {audio['file']}", file=sys.stderr)
        return 2

    digest = hashlib.sha256(audio_path.read_bytes()).hexdigest()
    cache_path = CACHE_DIR / f"{digest}.json"
    if not cache_path.is_file():
        print(
            "beats: no cached analysis for this soundtrack yet.\n"
            "Open this project in Kookaburra Cut once (analysis runs on load), then rerun.",
            file=sys.stderr,
        )
        return 3
    analysis = json.loads(cache_path.read_text())
    if analysis.get("version") != ANALYSIS_VERSION:
        print(f"beats: cache version {analysis.get('version')} unsupported", file=sys.stderr)
        return 2

    slots = build_slots(manifest.get("scenes", []))
    total = slots[-1]["endMs"] if slots else 0
    offset = audio.get("startOffsetMs", 0) or 0
    beats = [t - offset for t in analysis.get("beats", []) if 0 <= t - offset <= total]
    moments, source = effective_key_moments(analysis, audio.get("markers"), offset, total)
    bpm = analysis.get("bpm")
    interval = round(60_000 / bpm) if bpm else None

    if args.json:
        print(json.dumps({
            "bpm": bpm,
            "beatIntervalMs": interval,
            "keyMomentSource": source,
            "projectTotalMs": total,
            "startOffsetMs": offset,
            "keyMoments": [{"tMs": round(m["tMs"]), "strength": round(m["strength"], 3)} for m in moments],
            "beats": [round(t) for t in beats],
            "scenes": [{
                "index": s["index"],
                "stem": s["stem"],
                "startMs": round(s["startMs"]),
                "durationMs": s["durationMs"],
                "windowStartMs": round(s["windowStartMs"]),
                "windowEndMs": round(s["windowEndMs"]),
                "transitionInMs": round(s["transitionInMs"]),
                "transitionOutStartMs": round(s["transitionOutStartMs"]),
                "keyMoments": [
                    {"tMs": round(m["tMs"] - s["startMs"]), "strength": round(m["strength"], 3)}
                    for m in moments
                    if s["startMs"] <= m["tMs"] <= s["endMs"]
                ],
                "beats": [round(t) for t in scene_local(s, beats)],
            } for s in slots],
        }, indent=2))
        return 0

    slot = None
    if args.scene is not None:
        slot = next((s for s in slots if args.scene in (str(s["index"]), s["stem"])), None)
        if not slot:
            print(f"beats: no scene '{args.scene}' (use an index or file stem)", file=sys.stderr)
            return 2

    bpm_line = f"{bpm:.1f} (beat every {interval}ms)" if bpm else "unknown (no regular grid found)"
    print(f"Soundtrack: {audio['file']}   bpm: {bpm_line}")
    print(f"Key moments: {len(moments)} ({source})   grid beats: {len(beats)}   startOffsetMs: {offset}")

    if slot:
        print(f"\nScene {slot['index']} {slot['stem']}  (project {slot['startMs'] / 1000:.1f}s"
              f" - {slot['endMs'] / 1000:.1f}s, all times below scene-local ms)")
        print(f"  window: {round(slot['windowStartMs'])} - {round(slot['windowEndMs'])}"
              f"   transitionIn ends: {round(slot['transitionInMs'])}"
              f"   transitionOut starts: {round(slot['transitionOutStartMs'])}")
        local_moments = [
            {"tMs": m["tMs"] - slot["startMs"], "strength": m["strength"]}
            for m in moments
            if slot["startMs"] <= m["tMs"] <= slot["endMs"]
        ]
        shown = ", ".join(
            f"{round(m['tMs'])} ({m['strength']:.2f})"
            + ("" if slot["windowStartMs"] <= m["tMs"] <= slot["windowEndMs"] else " outside window")
            for m in local_moments
        ) or "none"
        print(f"  key moments: {shown}")
        local_beats = [round(t) for t in scene_local(slot, beats)]
        print(f"  beats: {' '.join(str(t) for t in local_beats) or 'none'}")
        return 0

    print()
    for s in slots:
        local_moments = [
            {"tMs": m["tMs"] - s["startMs"], "strength": m["strength"]}
            for m in moments
            if s["startMs"] <= m["tMs"] <= s["endMs"]
        ]
        n_beats = len(scene_local(s, beats))
        print(f"{s['index']:2}  {s['stem']:24} {s['startMs'] / 1000:5.1f}s -{s['endMs'] / 1000:5.1f}s"
              f"  beats: {n_beats:3}  key moments (local ms): {fmt_moments(local_moments)}")
    print("\nRerun with --scene <index|stem> for every beat time, or --json for the full dump.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
