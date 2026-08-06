# Beat-matched animation

How to read the soundtrack's beat data from the terminal and author camera moves,
cuts and text timing that land on the music. Load this file only when the task
involves the soundtrack, beats, or syncing animation to music.

Everything here is editor guidance: the export path never reads beat data, so
nothing in this file can affect determinism. Camera keys you write are ordinary
sidecar data and follow the normal camera-track rules (see "Per-scene camera
tracks" in `REFERENCE.md`).

## What the app already does

When a project has a soundtrack, the app shows a beat lane above the timeline:
a waveform, a faint regular beat grid, and key-moment diamonds (strong onsets
and energy shifts, the moments worth cutting on). The user can drag, add and
delete markers there. Its right-click menu offers "Add camera keyframe here"
and "Sync scene camera to beats" (a gentle generated push-in/pull-back track).
Your value beyond those buttons is bespoke motion: jump cuts, asymmetric moves,
text timed to the music, scene cuts moved onto key moments.

## Getting the data

```bash
python3 .claude/skills/kookaburra-scene-authoring/scripts/beats.py             # per-scene summary
python3 .claude/skills/kookaburra-scene-authoring/scripts/beats.py --scene 2   # one scene, every beat, scene-local ms
python3 .claude/skills/kookaburra-scene-authoring/scripts/beats.py --json      # full machine-readable dump
```

The script reads the app's analysis cache, applies any user marker overrides,
and converts every time into project ms and scene-local ms (it accounts for
`audio.startOffsetMs` and transition overlaps, so use its numbers directly as
`tMs` values). If it reports no cached analysis, ask the user to open the
project in Kookaburra Cut once (analysis runs on load and caches), then rerun.

Under the hood, two sources:

- **Detection cache**: `~/Library/Application Support/com.mpalmes.kookaburracut/cache/beats/<sha256-of-audio-bytes>.json`,
  shape `{ version: 1, durationMs, bpm|null, beats: [ms], keyMoments: [{tMs, strength}], envelope: {hopMs, values} }`,
  all times in TRACK ms (the audio file's own clock).
- **User overrides**: `project.json` -> `audio.markers` `{ version: 1, keyMoments: [ms] }`
  in PROJECT ms. Once present it REPLACES the detected key moments wholesale
  (the beat grid stays detected). You may edit this block directly: version 1,
  sorted non-negative integers; delete the whole block to return to detection.
  Never write detection-derived data anywhere else in the project.

Vocabulary: **key moments** are the strong, cut-worthy events (each with a
0..1 `strength`); **grid beats** are the regular pulse for fine placement.

## Matching motion to the music

First settle the feel with the user (or infer from the track): **hard cuts on
beats** suit percussive, high-energy music; **smooth moves that land on beats**
suit ambient or legato tracks. Mixing both in one video is normal (cuts on the
strongest moments, drifts between them).

Both styles hinge on the same rule: **the `to` key sits ON the beat**. Motion
that completes on the beat reads as on-beat; motion that starts on the beat
lands late and reads as a miss.

Hard cut (a `"jump"` segment holds `from` for its whole span, then snaps to
`to` exactly at the `to` key's time):

```jsonc
"camera": {
  "keys": [
    { "id": "k1", "tMs": 0,    "pose": { "target": [0,0,0], "azimuthDeg": 0,  "elevationDeg": 0, "distance": 5 } },
    { "id": "k2", "tMs": 3410, "pose": { "target": [0,0,0], "azimuthDeg": 18, "elevationDeg": 6, "distance": 3.4 } }
  ],
  "segments": [{ "from": "k1", "to": "k2", "ease": "jump" }]   // 3410 = a key moment from beats.py --scene
}
```

Smooth move landing on a beat: same shape with an eased segment (`inOutQuad`
default, `outCubic` for a settle) whose `to.tMs` is the beat. Start the move
one to two grid beats earlier so the whole gesture belongs to the phrase.

Placement rules (the app's generator obeys these; so should you):

- Space camera moves at least ~1200ms apart and keep to roughly 6 per scene;
  tighter than that reads as jitter, not rhythm. Keys must be >= 17ms apart.
- Cut on the strongest key moments first (`strength` orders them); use grid
  beats only to fine-place lesser accents.
- Keep keys inside the scene's window (`beats.py --scene` prints it) and keep
  cuts out of cross-scene transitions: stay between `transitionIn ends` and
  `transitionOut starts`, or the cut fights the dissolve.
- Open composed: first key at the window start with the scene's base framing,
  then move on the beats after it.
- Free-flight (`cameraMode: "rig"`) scenes keep their authored flights: offer
  to retime existing rig keys onto nearby beats, never regenerate them.

## Beyond the camera

- **Text on beats**: time `AnimatedHeadline` `from`/`to` (or the sidecar's
  `textAnimation` delays) so reveals complete on scene-local beats.
- **Scene cuts on key moments**: adjust `durationMs` in `project.json` so a
  scene boundary lands on a strong key moment. Transition overlaps shift every
  later start, so rerun `beats.py` after each duration change rather than
  arithmetic in your head.
- After any beat edit, capture a frame or two at the beat times ("Seeing your
  work" in SKILL.md) and check the pose actually reads at that moment.
