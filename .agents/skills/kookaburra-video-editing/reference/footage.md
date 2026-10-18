# Footage log: what happens when, and two takes compared

`./kb video log` reads a recording once and lists what happens in it, in source ms: the screens
that hold, the changes between them, scrolls and their speed, and the best frames to show (money
frames). With the user's notes it says which change each note describes. `./kb video pair` matches
two takes of one flow. Use them to find moments to cut, land or freeze on, before any edit.

## Log a recording

```
./kb video log assets/rec.mov                     holds, changes, scrolls and money frames
./kb video log rec --notes notes.md --sheet       notes lined up; a sheet of the money frames, each stamped
./kb video log assets/rec.mov --range 10-20 --money 6
```

`./kb video log NAME|SRC [--notes FILE] [--sheet] [--range A-B] [--money N] [--refresh]
[--allow-misdecode] [--dry-run] [--wait [S]] [--json]`

- Targets: `assets/rec.mov` or `rec.mov`; an edit NAME logs its one video source; to log a render,
  pass `assets/NAME-edited.mp4`; an original in `assets/.originals/` logs its conformed file.
- Times are source ms; a frame shows from its timestamp until the next frame's. `--range` reports
  one stretch only (notes still align against the whole file).
- Writes `.kb/footage/<name>.json` (the asset path without `assets/` and the extension, `/` as
  `--`) and, with `--sheet`, `.kb/footage/<name>/money-N.png`. `log` and `sheets` in the answer are
  absolute paths: Read them. `--dry-run` writes nothing and lists `writes`; an unchanged rerun
  writes nothing.
- Cost: one decode, cached by content beside the analysis: about 10 s for a 30 s phone recording
  the first time, under 1 s after. `--refresh` decodes again.

## What the log holds

| Key | Each entry |
| --- | --- |
| `holds` | `{ id, startMs, endMs, frames, frame }`: a picture on screen 250 ms or more, from the moment it first shows; `frame` is its first decoded frame (the 60 fps slot on a conformed file) |
| `changes` | `{ id, startMs, endMs, peak, box, kind }`: `box` `[x, y, w, h]` fractions of the frame, `peak` the largest frame difference 0..255, `kind` `scroll`, `screen` (a cut to a new screen), `tap`, `typing`, `blink`, `loading`, `black` or `motion`. A change's last frame is the next hold's first |
| `scrolls` | `{ id, startMs, endMs, direction, pxPerS, pxPerFrame, region, velocity }`: source pixels; `direction` is where the content moves (`up` reveals what is below); `velocity` `[[tMs, pxPerS]]`, at most 40 points |
| `moneyFrames` | `{ id, atMs, frame, hold, change, kind, score }`: a hold's start plus half the hold (at most 500 ms), for each hold after a visible change; `score` 0..1 favours long holds after big changes; `--money N` keeps the N best |
| `intervals` | Black, lead-in and lead-out, idle and active stretches, as `./kb video analyse` finds them |

A money frame never follows a blink, loading or black, never sits inside black or loading, and
follows typing only when the hold lasts 1 s or more. Use one for a freeze (`./kb video freeze NAME
--src s1@T`), a still, a thumbnail, or the moment to land on a beat.

## Notes lined up with the footage

People write notes from memory, seconds off the file. `--notes FILE` matches each one to the change
it describes:

```
- 0:12.5 opens settings
12.5s save
* 1:02 back
1. 4 toggles
# comments are skipped
```

One note per line with a leading time (`0:12.5`, `12.5s`, `12.5`); lines without one go to
`skippedLines`. JSON works too: `{ "notes": [{ "t": 12.5, "label": "opens settings" }] }`. Each note
takes the first change between 0.25 s before and 4 s after its time, else the nearest change within
1.5 s of its time plus the median offset, keeping the notes in order; blinks, loading and black
never match. `notes` returns `{ file, medianOffsetMs, items: [{ line, label, noteMs, changeMs,
change, offsetMs, confidence }], skippedLines }`. Take times from `changeMs`, never `noteMs`.

## Decode check

An unconformed file's decode is judged first, by the same check as `./kb assets probe` (the
container's own tables, plus the app's media probe when `./kb video caps` lists `media`); `decode`
in the answer says what judged it (`via`, `checks`). A file ffmpeg misdecodes is refused (exit 1,
`invalid`, hint `./kb assets conform NAME`), since its times would be off; `--allow-misdecode` logs
it anyway with ffmpeg's times. When nothing could judge it, `decode` is null and `notesForAgent`
says so.

## Compare two takes

```
./kb video pair assets/take1.mov assets/take2.mov
```

`./kb video pair A B [--no-sheet] [--refresh] [--allow-misdecode] [--dry-run] [--wait [S]] [--json]`

- Matches the two takes' holds in order; a state only one take has stays unmatched. A brightness
  change, and anything painted over up to a tenth of one take's frame (a bar or a badge), are
  ignored.
- Returns `pairs: [{ a, b, aMs, bMs, aEndMs, bEndMs, startOffsetMs, endOffsetMs, score }]`,
  `medianOffsetMs`, `driftMsPerS`, `unmatchedA`, `unmatchedB`, plus the sheet and log paths.
  Offsets are B minus A (-150: B shows each state 150 ms earlier). `startOffsetMs` is null for a
  state that starts its clip, `endOffsetMs` for one that ends it; `driftMsPerS` is the offset's
  slope per second of A; `score` is the match cost (0 identical, 6 the limit).
- The sheet puts each pair side by side, A left and B right, stamped `A 1.23s` / `B 1.08s`. Writes
  `.kb/footage/pairs/<a>--<b>.json` and `-N.png`.
- Use it to re-sync a re-recorded take (shift the slot's `startMs`, or `./kb video align`), or to
  check a retake shows the same flow before swapping it in (`./kb assets replace` in the scene skill).

## Limits

- A scroll slower than about 160 px/s (on a 2622 px tall, 60 fps recording) reads as `motion`,
  unless it is a fling's tail.
- Camera footage gets no scroll search.
