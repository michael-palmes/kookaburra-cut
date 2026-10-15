# Beat-matched animation

How to read the soundtrack's beats and land camera moves, cuts and text on the music.
Beat data is editor guidance only: exports never read it.

## What the app already does

With a soundtrack the app shows a beat lane: waveform, a faint beat grid and key-moment
diamonds (strong onsets and energy shifts worth cutting on). Its menu offers "Add camera
keyframe here" and "Sync scene camera to beats" (a gentle push-in and pull-back). Your
value is bespoke motion: jump cuts, asymmetric moves, text timed to the music and scene
cuts moved onto key moments.

## Getting the data

```bash
kb beats              # per-scene summary
kb beats --scene 2    # one scene: every beat and key moment in scene-local ms
kb beats --json       # the full dump
```

Times account for `audio.startOffsetMs` and transition overlaps: use them directly as
`tMs`. With no cached analysis, ask the user to open the project in the app once
(analysis runs on load), then rerun.

- Key moments: strong, cut-worthy events with a 0..1 `strength`.
- Grid beats: the regular pulse for fine placement.
- User overrides: `project.json` `audio.markers` `{ "version": 1, "keyMoments": [ms, ...] }`
  in PROJECT ms replaces the detected key moments (the grid stays detected). Sorted,
  non-negative integers; delete the block to return to detection.

## Matching motion to the music

Settle the feel first: hard cuts on beats suit percussive, high-energy music; smooth
moves that land on beats suit ambient tracks. Mixing both is normal (cut on the
strongest moments, drift between them).

Either way the `to` key sits ON the beat: motion that completes on the beat reads
on-beat; motion that starts on it reads late.

Hard cut (a `jump` segment holds `from`, then snaps at the `to` key):

```json
"camera": {
  "keys": [
    { "id": "k1", "tMs": 0, "pose": { "target": [0, 0, 0], "azimuthDeg": 0, "elevationDeg": 0, "distance": 5 } },
    { "id": "k2", "tMs": 3410, "pose": { "target": [0, 0, 0], "azimuthDeg": 18, "elevationDeg": 6, "distance": 3.4 } }
  ],
  "segments": [{ "from": "k1", "to": "k2", "ease": "jump" }]
}
```

Smooth move: the same with an eased segment (`inOutQuad`, or `outCubic` for a settle)
whose `to.tMs` is the beat; start it one or two grid beats earlier.

Placement rules:

- Space camera moves at least about 1200 ms apart, roughly 6 per scene at most; tighter
  reads as jitter. Keys at least 17 ms apart.
- Cut on the strongest key moments first; use grid beats for lesser accents.
- Stay inside the scene's window and out of transitions (between the end of the
  incoming transition and the start of the outgoing one; `kb beats --scene` prints both).
- Open composed: first key at the window start with the base framing.
- Free-flight (`cameraMode: "rig"`) scenes: retime existing rig keys onto nearby beats;
  never regenerate a designed flight.

## Beyond the camera

- Text: time `from`/`to` (or the sidecar `textAnimation.delayMs`) so reveals COMPLETE on
  scene-local beats.
- Scene cuts: adjust `durationMs` (`kb scene set S --duration MS`) so a boundary lands
  on a strong key moment. Overlaps shift every later start, so rerun `kb beats` after
  each change instead of doing the arithmetic.
- After any beat edit, capture frames at the beat times and check the pose reads.
