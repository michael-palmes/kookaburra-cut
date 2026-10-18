# The edit document

`edits/<name>.json` is the video editor's own document. `./kb video` reads it, changes it through the
same operations the editor's buttons run, and has the app save it (hash-checked, so an open editor
and kb never overwrite each other; the editor shows a kb change as one "Claude edit" undo step).
Read it with `./kb video show NAME` or `--json`; never write it by hand.

```json
{
  "version": 1,
  "name": "sim-checkout",
  "sources": [{ "id": "s1", "rel": "assets/sim-checkout.mov", "kind": "video", "width": 1206, "height": 2622, "fps": 15.2, "durationMs": 29941 }],
  "settings": { "width": 1206, "height": 2622, "fps": 60 },
  "clips": [
    { "id": "c1", "sourceId": "s1", "inMs": 3000, "outMs": 5700, "speed": 1, "startMs": 0 },
    { "id": "c2", "sourceId": "s1", "inMs": 11166, "outMs": 17700, "speed": 4, "startMs": 2700 },
    { "id": "c3", "sourceId": "s1", "inMs": 17700, "outMs": 17700, "speed": 1, "holdMs": 800, "startMs": 4334 }
  ],
  "taps": [{ "id": "t1", "sourceId": "s1", "sourceMs": 24967, "pos": [0.694, 0.383] }],
  "tapStyle": "target", "tapColor": "blue", "tapSize": 1.25,
  "masks": []
}
```

| Field | Meaning |
| --- | --- |
| `sources` | Every file the edit uses: `s1`, `s2`... (`kind` video or image). Several clips may cut one source |
| `settings` | Output size and fps. Size comes from the first source; fps is the source's, or 60 for a variable-frame-rate recording (a Simulator capture writes a frame per screen change) |
| `clips` | The timeline in order, butted end to end. `inMs`/`outMs` are source ms, `speed` retimes, `startMs` is derived (kb relays it) |
| `holdMs` | A freeze: one source frame (`inMs` == `outMs`) held this long. Every still image clip is a hold |
| `taps` | Tap highlights anchored in SOURCE time, so they survive re-cutting; a duplicated segment shows the tap in each copy |
| `masks` | Privacy boxes in SOURCE time and source-normalised coordinates (below) |
| `version` | 1, or 2 once any mask exists (older app versions refuse version 2) |
| `reference` | The editor's side-by-side pairing; ignored by renders |

Ids: clips `c1`, sources `s1`, taps `t1`, masks `m1`; new ones take the next free number. Commands
also take `first`, `last`, a 0-based index, or `@4.5` (the clip under timeline 4.5 s).

## Limits

- A clip needs at least 100 ms of source; a hold at least 100 ms. New holds default to 2 s, and so
  does a still's time on screen.
- `outMs` may not pass the source's duration; `inMs` < `outMs` except for holds.
- Speeds are any positive number; the editor menu offers 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 6 and
  shows other values too. Fit snaps its speeds to 0.05 steps.
- Tap size 0.25 to 4 (default 1.25). Mask boxes at least 1% of the frame each way; a mask span at
  least 100 ms.
- Times in JSON plans ending in `Ms` are integers.

## Clocks (what `./kb video map` computes)

For a clip `c` on the timeline:

- Source moment `x` shows at timeline `c.startMs + (x - c.inMs) / c.speed` (once per clip that
  holds it; a freeze shows `c.inMs` for its whole hold).
- Timeline `t` inside `c` shows source `c.inMs + (t - c.startMs) * c.speed`.
- In a scene, the video starts at its slot's `startMs`: scene-local = `startMs` + timeline.
  Devices and media hold the first frame before that and the last frame after the end.
- Project time = the scene's start (after transition overlaps, as `./kb beats` reports) + scene-local.

## The frame grid

The render cuts every clip to a whole number of output frames on one cumulative grid:
`frames(c) = max(1, round(end(c) * fps / 1000) - round(start(c) * fps / 1000))`, rounding halves
up. The output therefore has `round(length * fps / 1000)` frames, and the timeline length decides
the frame count to within half a frame. `./kb video fit` aims at the centre of that window.

What each output frame shows: the source is first resampled to the output fps from 0 s (a slot
shows the latest source frame at or before it, so a held Simulator frame fills every slot until the
next one). A clip keeps the slots from `round(inMs)` to before `round(outMs)` in that grid; at speed
`s`, output frame `j` of the clip shows the latest kept slot whose index divided by `s` (rounded
down) is at most `j`. `./kb video frames --predict` uses exactly this.

## Letterbox

Each clip is scaled to fit inside the output size (keeping its aspect) and centred on black, so a
landscape recording in a portrait edit gets bars. Tap and mask coordinates are always fractions of
the SOURCE frame, never of the output, so bars never move them.

## Taps

- Placed at a source moment and a spot `pos` (0..1 across the source frame).
- Drawn on the output: a glow dot `0.07 x min(output width, height) x tapSize` pixels across, for
  550 ms of output from the moment, cut short at the end of its clip (a tap just before a cut
  truncates). Freezes never show a tap.
- Look: `./kb video tap style NAME --style target|glow|dot|ring --colour blue|light|dark|red|terracotta --size 1.25`
  (`./kb video caps` lists the current vocabulary). One look per edit.

## Masks

- A mask covers a source span `[startMs, endMs)`; it is applied to the source before cutting, so
  every clip, speed and freeze of that span is covered. A still's mask ignores the span.
- Keys `{sourceMs, rect: [x, y, w, h]}` glide linearly; the box holds before the first key and
  after the last. `./kb video mask key` adds or replaces a key at a moment; `mask hold` pins the box
  where it is so a later key only moves what follows.
- Styles: `solid` (fill `#rrggbb`, default black), `blur`, `pixelate`. Strength 0..1 (default 0.5)
  maps to a blur sigma of `(0.008 + 0.032 x strength) x min(source width, height)` pixels, or a
  pixelate block of `(0.025 + 0.075 x strength) x min(source width, height)` (even, at least 2).
  The floors keep text unreadable at strength 0.
- Edges round outward to whole pixels, so nothing leaks at the box's edge.

## Stills

`./kb video insert NAME assets/title.png --at 0 --hold 1.5` or `append`: a still joins as a hold
clip of the image source. Odd image sizes are evened for the encoder. Masks on a still use their
first key.

## Names and outputs

- An edit's name is its source's file stem, slugified (`Sim Checkout.mov` gives `sim-checkout`). A
  different recording with the same stem needs `--name`.
- The render is always `assets/<name>-edited.mp4`; reopening that file (`kb video new
  assets/<name>-edited.mp4`) reopens the edit.
- Renders have no audio track.
