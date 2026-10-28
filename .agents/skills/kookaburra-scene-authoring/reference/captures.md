# Captures: frames, motion and joins

A capture renders frames in the running app through the export path; Read every PNG kb
prints (the copies in `.kb/captures/`). One request at a time, at most 48 frames.

```
./kb capture --scene 03-x --at 1.5                    one frame at its native size
./kb capture --frames 0@1,3@2.5 --sheet               several frames (1280 px long edge) plus a contact sheet
./kb capture --scene 03-x --around 1.5 --count 8      8 consecutive frames at 60 fps around 1.5 s: is the motion smooth?
./kb capture --around bar:13 --count 6                the same around a musical position
./kb capture --scene 03-x --at 2 --crop 0.6,0,0.4,0.3 a native-resolution crop (fractions, or native pixels)
./kb capture --diff 02-a@last 03-b@first              a join: both sides, their difference and how much changed
./kb capture --scene 03-x --scale 0.5 --probe 1920,1080   exact pixels; points are native pixels or fractions at any size
./kb preview --range bar:13-16                        a low-resolution clip of a span plus a sheet (reference/export.md)
```

- `--around` keeps its frames inside the scene (or the film) and says when it moved them;
  each frame carries its export frame index and project time.
- `--crop` shows small detail (a hairline, a glyph edge, a device bezel) at the export's own
  resolution. It renders one native frame, so not with `--width`, `--scale` or `--sheet`.
- A frame inside a transition is labelled `02-a → 03-b (crossfade, 40%)`, in the printed
  line, the copy's name and the contact sheet, instead of one scene's name.
- `--diff` captures both frames in one request at the same size and writes `diff.png` (A,
  B, and their difference made four times brighter) with the mean, changed and largest
  change as percentages. `S@first` and `S@last` are a scene's first and last frames outside
  its transitions, the frames `./kb verify` checks. A seamless cut should change almost
  nothing; a match cut changes only what moves.
- `--probe` points are native pixels (whole numbers) or fractions (`0.5,0.5` is the centre)
  whatever the capture size; kb maps them into the returned image and prints both.
- `./kb verify --formats` captures every scene's first and last frames in each aspect in
  `formats`, and warns when text crosses the safe area, by key and aspect.
