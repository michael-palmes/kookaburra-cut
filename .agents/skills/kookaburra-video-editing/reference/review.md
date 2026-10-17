# Looking at the result

Never judge an edit by its numbers. Every change gets a sheet or frames, Read before you report.

## Frames

```
./kb video frames NAME --at 1,2.5,end-0.1 --grid          timeline times of the edit
./kb video frames NAME --src s1@24.967 --grid             the raw source frame (where to put a tap)
./kb video frames NAME --tap t1                           -100, 0, +83, +275 and +550 ms around tap t1
./kb video frames NAME --mask m1                          span start, every key, both ends, and a zoom
./kb video frames assets/rec.mov --at 3 --zoom 0.1,0.6,0.5,0.2
```

- Edit frames come from a draft render of the edit (half size, software, cached in the scratch
  folder until the edit or its sources change), so taps and masks show exactly as rendered. The
  first call renders (seconds for a short edit, longer for a long one); later calls reuse it.
- `--predict` skips the render and shows the source frame the render would pick for that output
  frame (exact, pinned by the app's frame tests), but without taps or masks. Use it for timing.
- `--src` always shows the raw source frame the editor would show for that moment.
- Masks are always checked on the render.
- `--grid`: white lines every tenth of the frame, yellow at the halves, a red square at the top
  left (0,0). Read positions off it as fractions: `--pos 0.69,0.38` for a tap, `--rect x,y,w,h` for a
  mask. Coordinates are fractions of the SOURCE frame; letterbox bars are cropped off first.
- `--zoom x,y,w,h` crops that part of the frame (fractions) and enlarges it: use it to read small
  text, check a mask's edges or find the exact spot of a touch.
- `--overlay taps,masks` outlines taps (green square and cross, while visible) and masks (white
  solid, cyan blur, magenta pixelate).
- A single frame is at most 1568 px on its long edge, which Read shows whole.

## Sheets

```
./kb video sheet NAME                  12 frames spread over the edit
./kb video sheet NAME --every 2        every 2 s (at most 48 cells)
./kb video sheet NAME --at 1,4,9       chosen times
./kb video sheet NAME --seams          the last frame before and first after every jump, with a seam diff
./kb video sheet NAME --changes        jumps and speed changes (what cleanup or fit just did)
./kb video sheet NAME --compare        raw source beside the edit at the same moments
./kb video sheet assets/rec.mov        a source before any edit
```

- Each cell has a 6 px bar on top: light grey 1x, orange faster, blue slower, purple a hold or still,
  grey a raw source frame. A red left edge marks the first frame after a jump.
- There is no text on the image. The legend (cell, row and column, timeline and source time, clip,
  speed, notes) prints with the path and is saved beside it as a `.json` of the same name.
- Seam diff: the mean difference between the two frames of a jump, in percent. Under 0.05% is
  seamless (a cut inside a still stretch); larger is a visible jump, fine at a screen change and
  worth a look anywhere else.
- Sheets stay within 1568 px and 1.15 megapixels with cells at least 160 px across; more cells split
  into `-1`, `-2`... Read each.

## Where files go

Everything lands under `~/Kookaburra Cut/_bridge/video/<project>/` (`analysis`, `drafts`, `frames`,
`sheets`), which Read can open. Old drafts and frames are cleared after a day or past 1 GB. Nothing
review makes ever goes into `assets/`.

## After rendering

The render (`assets/<name>-edited.mp4`) is what scenes show. After `./kb video render NAME --use ...`
check it in place: `./kb check --app`, then `./kb capture --scene S --frames S@1,S@3 --sheet` and Read.
