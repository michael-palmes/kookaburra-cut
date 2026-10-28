# Music: the beat grid and beat-matched motion

How to give the soundtrack an authored beat grid, name its moments, and land camera
moves, kicks, cuts and text on the music.

## The grid is data

`project.json` `audio.grid` (`bpm`, `offsetMs` of bar 1 beat 1, `beatsPerBar`) is the
music's clock. Once it exists, everything uses it: `bar:` positions in sidecars,
`./kb beats`, `./kb capture --at bar:N`, the app's beat lane, snapping and "Sync scene
camera to beats". Keys with an `at`, `bar:` kicks and `useBeatGrid()` render from it, so changing
the grid moves them. The song analysis only suggests a grid; until one is authored,
`./kb beats` shows the analysis's detected beats (`beatSource: "detected"`) and every `bar:`
position refuses (`no-grid`).

```bash
./kb song analyse --accept     # analyse the soundtrack and make its fitted grid the project's
./kb beats                     # the grid, each scene's bars and beats, cues and sections
./kb beats --scene 2           # one scene: every bar line (bar@ms), beat, cue and key moment, scene-local ms
./kb beats --json              # everything
```

Times account for `audio.startOffsetMs` and transition overlaps. The user can also set the
grid in the app: the Music inspector's Beat grid group, or the beat lane's right-click
"Set downbeat here" and "Make this bar 1".

## Song analysis

```bash
./kb song analyse [--force] [--tracker nn|dsp] [--lyrics] [--accept] [--dry-run]
```

- Runs the app's own analyser, with the app closed too; cached by the file's SHA-256, and
  copied to `.kb/song/<sha12>.json` (Read it for the per-beat data). `project.json` changes
  only with `--accept`.
- Prints the tempo (bpm, beat period, residual, max drift, steady or drifting), the
  downbeat (track and film ms), sections (bar ranges where the music changes; author the
  ones you use with `./kb beats section set`), breaths (silences and sharp dips, worth
  holding on) and the stab histogram (where in the bar the hits fall, per sixteenth: kick
  the strong slots). Lyrics print only with `--lyrics`.
- A drifting tempo (`constantTempo` false: live playing, tempo changes) can't take one
  grid, so `--accept` refuses it. Place keys at the detected beats and key moments that
  `./kb beats --scene S` prints, as plain `tMs`. `./kb beats set-grid --from-analysis
  --force` takes the grid anyway, its bar lines off by up to the reported max drift.
- Tell the user the bpm and where bar 1 landed: you can't hear it. If they say bar 1 is
  off, `./kb beats set-downbeat` (below).
- Exit 2 `env` "can't analyse songs from the terminal": the app is too old; ask the user to
  update it. Exit 1 `invalid`: no soundtrack (`./kb assets add FILE`, then
  `./kb project set audio.file assets/<name>`).

## Setting the grid

```bash
./kb beats set-grid --from-analysis [--force] [--beats-per-bar N]   # the fit, with grid.source provenance
./kb beats set-grid --bpm 120 --offset 250 [--beats-per-bar 4]      # by hand; --offset is TRACK ms of bar 1 beat 1
./kb beats set-downbeat 12.48s          # the nearest bar line moves to 12.48 s of film time; bars keep their numbers
./kb beats set-downbeat bar:9 --bar 1   # that moment becomes bar 1 beat 1 (the tempo is kept)
./kb beats clear-grid                   # keys keep their last tMs and stop following
```

bpm is 30..300 (kept to 3 decimals), beats per bar 1..16. Every grid write also rewrites
the cached `tMs` of every sidecar key with an `at`, in the same transaction (a sidecar
another agent leases is left, with a note; the app re-resolves it on load). `./kb check`
warns when the grid was fitted to a different file than `audio.file`.

## Positions

`bar:B[.beat[.16th]]` (1-based; bar 0 and below are pickups), `cue:ID`, `section:ID` (its
start), each with an optional `+40ms` or `-40ms` nudge. Where kb takes a time, `12.5s`,
`12500ms` or bare seconds (film time) work too.

```bash
./kb beats resolve bar:13.3+40ms [--scene S]   # project ms, the owning scene and its local ms, the nearest beat
```

Errors: any `bar:` position (and `--duration-bars`, `--cut-at`, a plan's `cutAt`) without a
grid is exit 1 `no-grid`; bad syntax or a beat past the bar is exit 2 `usage`; a position outside the film
is exit 1 `invalid`.

## Cues and sections

Named times, so keys and kicks follow the music's structure rather than bar numbers:

```bash
./kb beats cue set drop bar:29        # a position (kept as text) or a time (stored as whole ms)
./kb beats cue rm drop
./kb beats section set chorus --from bar:17 --to bar:25 --label Chorus
./kb beats section rm chorus
```

They live in `audio.cues` and `audio.sections`. Ids are 1 to 40 lowercase letters, digits
and dashes. A cue or section never points at another cue or section, and a section's
`from` comes before its `to` (exit 1 `invalid`, nothing written).

## Keys that follow the music

Camera, rig, lighting, `deviceTrack` and `compare.track` keys (and `compare.b.lighting`
keys) take a sibling `at`: `{ "id": "k2", "tMs": 21000, "at": "bar:13" }`. The `at` rules;
`tMs` caches where it lands in scene-local ms.

Screen and media videos start on the music the same way, with an `at` beside `startMs`:
`devices[].media` and `coverMedia`, `compare.b.media` and `coverMedia`, and
`media[].video` (any host). An `at` on a device screen needs a video that doesn't
`startOn: "open"`, and can't land before the scene starts when the screen trims with `inMs`.

```bash
./kb doc 03-drop set camera.keys.1.at bar:13        # kb sets tMs to match now
./kb doc 03-drop set camera.keys.1.tMs 21400        # moves the key off the music: its at is dropped
./kb doc 03-drop unset camera.keys.1.at             # keep tMs, stop following
./kb doc 03-drop set devices.0.media.at cue:drop    # the screen video starts on the drop
```

Every `./kb doc` write refreshes the other caches. `./kb doc merge` keeps each `at` (its time
follows the music) unless the patch gives `"at": null`. Never hand-edit the time of a field
with an `at`: the app puts it back on load (`./kb check` warns). Dragging the key, a new start
in the inspector, `./kb video start` and `./kb video align` detach it. Chart and layered
screenshot keys, taps, split-field reveals, scene durations and edit documents take plain ms:
`./kb doc` refuses an `at` there (exit 2 `usage`). To land a recording's tap on a beat, use
`./kb video align NAME --tap ID --beat N --scene S`.

## Kicks and pulses

- `cameraKicks`: a short push (zoom, offset or roll) on top of whatever camera drives the
  scene, at a position: `{ "at": "bar:13", "zoom": 1.04, "releaseMs": 300 }`
  (reference/camera.md). Kicks are accents for the strongest hits (a section's first
  downbeat, a drop cue); a kick on every beat reads as shake.
- In TSX, `useBeatGrid()`, `useCues()` and `pulse()` time scale, glow or opacity to the
  grid (reference/scenes.md).

## Capture on the beat

```bash
./kb capture --at bar:13                       # the scene that owns that moment (mid-transition: the incoming one past halfway)
./kb capture --scene 03-drop --at cue:drop     # refused (exit 1) when the moment is outside that scene; the hint names the owner
./kb capture --frames bars:13-16 --sheet       # each downbeat; beats:13-14 for every beat; mix with S@SEC and S@POS; 48 at most
```

Responses carry `position` and `projectMs` (per frame for `--frames`).

## Scene cuts on the beat

Pin cuts to the music, never to ms: a transition pulls the next scene in by its overlap,
so an unpinned length drifts every later scene off its bar.

```bash
./kb timeline                                            # every scene's start, end, cut and transition in bars and ms
./kb scene set 03-drop --cut-at bar:17 [--align mid]     # pin: end on bar 17, or centre the outgoing transition on it
./kb timeline apply cuts.json                            # every cut and transition from a plan, one checkpointed write
./kb scene set 03-drop --duration-bars 4                 # four bars as whole ms (unpinned)
```

- A position in `--cut-at` (or a plan) pins the cut: `project.json` stores `cutAt` and
  `align`, and `durationMs` caches the length that lands it. kb and the app re-resolve
  it whenever the grid, an earlier transition or an earlier length changes, so later
  cuts stay on their bars. A time (`12.5s`) writes the length once, unpinned.
- `align`: `end` (default) means the scene is gone at the position; `mid` centres its
  outgoing transition on it, the usual choice for a crossfade on a downbeat.
- `--duration` and `--duration-bars` unpin. Keys with an `at` are refreshed in the same
  write.
- With a grid, `./kb scene set S --transition T:MS` keeps every later cut where it is
  (the app's transition picker does the same). `--ripple` lets them move.
- `./kb timeline` flags cuts off the beat, scenes shorter than their transitions, keys
  past their scene's end or before its start, and cuts that sat on a beat at the last
  checkpoint and no longer do. `./kb check` and `./kb status` repeat that last warning.

### The cut plan

A plan sets cuts and transitions for any scenes at once; rows apply in scene order, and
nothing is written if any row is invalid. JSON:

```json
{
  "version": 1,
  "cuts": [
    { "scene": "01-open", "cutAt": "bar:5", "align": "mid", "transition": { "type": "crossfade", "durationMs": 800 } },
    { "scene": "02-hero", "cutAt": "bar:9", "transition": "push:500" },
    { "scene": "03-demo", "cutAt": "cue:drop", "transition": null },
    { "scene": "04-outro", "cutAt": "bar:21" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `scene` | Stem (best) or 0-based index. Required; once per plan. |
| `cutAt` | A position (pins the cut), a time like `12.5s` (a length, once), or `null` to unpin. Absent leaves the cut alone. |
| `align` | `end` (default) or `mid`. Alone, it changes an existing pin. |
| `transition` | `{ type, durationMs, ease?, ... }` (project.json's shape), `"TYPE:MS"`, or `null`/`"none"` for a hard cut. Absent leaves it alone; the last scene takes none. A row that changes only a transition keeps later cuts in place, as `kb scene set` does (`--ripple` to let them move). |

Or a markdown table with `scene`, `cut`, `transition`, `length` and `align` columns
(`ease` optional; a bare number in `cut` is a bar, an empty cell leaves that field alone):

```
| Scene    | Cut | Transition | Length | Align |
| -------- | --- | ---------- | ------ | ----- |
| 01-open  | 5   | crossfade  | 800    | mid   |
| 02-hero  | 9   | push       | 0.5s   |       |
| 03-demo  | 13  | cut        |        |       |
```

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
    { "id": "k2", "tMs": 3410, "at": "bar:5", "pose": { "target": [0, 0, 0], "azimuthDeg": 18, "elevationDeg": 6, "distance": 3.4 } }
  ],
  "segments": [{ "from": "k1", "to": "k2", "ease": "jump" }]
}
```

Its `tMs` is wherever `bar:5` lands in the scene: write the `at` with
`./kb doc S set camera.keys.1.at bar:5` and kb sets it.

Smooth move: the same with an eased segment (`inOutQuad`, or `outCubic` for a settle)
whose `to` key is on the beat; start it one or two beats earlier.

Placement rules:

- Space camera moves at least about 1200 ms apart, roughly 6 per scene at most; tighter
  reads as jitter. Keys at least 17 ms apart.
- Land on downbeats, section starts and cues first; use other beats for lesser accents.
  Without a grid, cut on the strongest key moments.
- Stay inside the scene's window and out of transitions (between the end of the
  incoming transition and the start of the outgoing one; `./kb beats --scene` prints both).
- Open composed: first key at the window start with the base framing.
- Free-flight (`cameraMode: "rig"`) scenes: retime existing rig keys onto nearby beats;
  never regenerate a designed flight.

## Beyond the camera

- Text: time `from`/`to` (or the sidecar `textAnimation.delayMs`) so reveals COMPLETE on
  scene-local beats (`./kb beats --scene S`, or `useBeatGrid()` in TSX).
- A moment inside a recording (a tap, a screen change): `./kb video align <edit> --tap tN
  --beat N --scene S` lands it on the scene's Nth beat (the grid's, else the analysis's),
  shifting the video's start when that is enough, else retiming the edit (the
  kookaburra-video-editing skill).
- Scene cuts: `./kb scene set S --cut-at bar:B [--align mid]` or a plan (above), not hand
  arithmetic.
- Key moments (strong onsets worth cutting on, 0..1 `strength`) come from the analysis;
  `project.json` `audio.markers` `{ "version": 1, "keyMoments": [ms, ...] }` in PROJECT ms
  replaces them (sorted, non-negative integers; delete the block to return to detection).
- After any beat edit, `./kb capture --frames bars:A-B --sheet` and check each pose reads.
