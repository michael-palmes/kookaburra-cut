# Fit and align: exact lengths and moments on target

## Exact length

`./kb video fit NAME --to 8` makes the render exactly `round(8 x fps)` frames (480 at 60 fps): the
timeline lands within half a frame of 8 s, then `./kb video validate NAME` and the render agree to the
frame. Check with `--dry-run` first; the report lists every step.

Shortening (auto):

1. Cleanup at normal strength (only as much of it as the target needs, safest cuts first).
2. A speed ramp: idle and loading run fastest, active slower, typing slowest; up to 4x, then 6x if
   it must, never past 2x within a tap's guard. Speeds snap to 0.05x steps and prefer a menu value
   within 4% (2x rather than 2.05x).
3. An exact landing, most invisible first: a hold's length, a cut edge inside a still stretch, the
   edge between two speeds, an idle tail, then easing one stretch by a few percent.

Lengthening (auto): restore trimmed tail then head (never into black), widen cuts inside still
stretches, slow sped-up loading back toward 1x, hold still frames (up to 2 s each, where nothing
moves), then hold the last frame.

| `--strategy` | Shortens by | Lengthens by |
| --- | --- | --- |
| `auto` | cleanup, then the speed ramp | trims, wider cuts, slower loading, holds, end hold |
| `trim` | cuts only (no speed changes) | restored trims, wider cuts, end hold |
| `speed` | every clip faster evenly | every clip slower evenly |
| `hold` | shorter holds only | holds only |

Too short to reach: exit 1 naming the shortest it can go (cleanup plus 6x everywhere, 2x by taps).
Offer that length, more cutting by hand, or a longer scene.

## Fit a scene

`./kb video fit NAME --scene 3 [--slot device]` reads the slot's start (`startMs`) and the scene's
length: the target is from the start to where the outgoing transition begins (`--end scene-end` for
the very end). The slot is picked for you when one slot in the scene shows the edit's source or
render; otherwise pass `--slot` (`background`, `media[:ID]`, `window`, `device[:ID]`,
`device-cover[:ID]`, `compare-device[:ID]`, `compare-device-cover[:ID]`).

Follow-media scenes take their length from the video, so fitting to them changes nothing: pass
`--to` with the length wanted, then `./kb video render NAME --use --scene S` and the scene follows.
Check its transition and any camera or device keys past the new length afterwards.

Prefer changing the edit over changing a scene's duration: transitions, beats and every later
scene's timing hang off scene durations.

## Anchors

`--anchor SRC@TARGET` (repeatable) lands a source moment on a timeline time while fitting:
`s1@12.4@5` (source s1 at 12.4 s lands at 5 s), `12.4@5` (one source), `t2@5` (a tap's moment). Each
stretch between anchors is fitted on its own, so every anchor lands within half a frame.

## Align one moment

```
./kb video align NAME --tap t1 --beat 4 --scene 3
./kb video align NAME --src s1@24.967 --at 20 --keep-length
./kb video align NAME --tap t1 --scene-at 2.5 --scene 3 --prefer edit
```

- The moment: `--src [SID@]T` or `--tap ID`. A tap lands 83 ms early (`--lead` changes it) so the
  highlight reads on the beat; a plain source moment lands exactly.
- The target: `--at T` (edit timeline), or in a scene: `--scene-at T`, `--beat N` (the scene's Nth
  grid beat, 1-based), `--moment N` (its Nth key moment). Beats come from `./kb beats --scene S`; with
  no beat analysis yet, ask the user to open the project in the app once.
- Scene side first: when moving the slot's `startMs` (0 to 1500 ms) alone lands it, align writes
  that to the scene's sidecar and leaves the edit and its render untouched (no re-render). Not for
  follow-media scenes, and never into the outgoing transition. `--prefer edit` skips this,
  `--prefer scene` insists on it.
- Edit side: the stretch before the moment is fitted so it lands on the target. `--keep-length`
  also fits what follows so the total stays the same; otherwise the length changes by the shift.
- After aligning, `./kb capture --scene S --at <target seconds>` and Read it: the touch should be on
  screen as the beat lands.
