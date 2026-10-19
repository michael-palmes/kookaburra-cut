# Assets, screen recordings, images, video, screenshot stacks, terminal, website

## Assets

- Everything a scene shows lives in `assets/` and is referenced as `assets/<file>`
  (exact case). Never absolute paths or URLs.
- Bring files in with `./kb assets add <path> [--name <name>] [--dir D]`: it copies, never
  overwrites (renames on collision) and prints the path to use. Always use the printed
  path: a video can land under another name (Screen recordings, below). `--dry-run` lists
  the writes.
- `./kb assets probe assets/<file> [--deep]`: duration, size, frame rate, codecs; for a
  video `decode.verdict` (`ok`; `suspect`, a non-trivial edit list; `ffmpeg-misdecodes`,
  preview and export show other frames than QuickTime), `reasons`, `colour.needsConvert`
  and `conform` (`recommended`, `why`, `refused`, `command`). It reads the container
  itself, so it works without the app; the app adds AVFoundation's view, and `--deep` also
  decodes and compares the two decoders. Probe every video before referencing it.
- `./kb assets replace NAME FILE` gives an asset new bytes under the same name, so every
  scene picks them up; the old version goes to `.kb/archive/<id>/` (`--keep-old trash|none`
  otherwise). Same extension only; refuses `*-edited.mp4` (`./kb video render NAME`); exits
  3 (`app-busy`) while the app exports a project using it, unless `--wait SECONDS`. It warns
  when the file is an edit's source or its size changed. Follow-media scenes re-sync their
  length and the running app refreshes. `--as-new` keeps both: the new file comes in as
  `<name>-2.<ext>` and the references move to it.
- `./kb assets list` shows every file and who uses it. Before deleting or renaming one,
  also run `./kb video usages <asset>`: an edit may cut it. A dangling reference renders a
  missing card or screen.
- `./kb assets unused [--kind K]` lists files nothing references, by the app's own rule
  (its Delete unused sheet's); `kept` names why others stay (`sample`, `companion` for
  `_meta.json` and a used clip's timing record, `pattern` for a template literal that
  matches, `theme`). `--archive [DIR]` moves them to `.kb/archive/<id>/` (DIR outside
  `assets/`); `./kb assets restore [ID]` puts a batch back (`--list` shows batches).
- `./kb assets meta NAME [--set KEY=VALUE]...` shows or edits the provenance record in
  `assets/_meta.json` (`origin`, `licence`, `transforms`). Values are JSON when they parse,
  else strings; `null` removes a key; `sha256` is kb's. `stale: true` means the file changed
  since; `./kb check` notes it as info.
- Never overwrite or re-encode an asset by hand (no ffmpeg or copies into `assets/`):
  `./kb assets replace`, `./kb assets conform` and `./kb video render` are the only ways to
  change an asset's bytes. To trim, speed up, freeze, add taps or blur part of a video, use
  `./kb video` (the kookaburra-video-editing skill): its render is
  `assets/<name>-edited.mp4` and the source stays untouched.
- Never hand-edit `assets/_meta.json` or `*.timing.json`, and never touch
  `assets/.originals/` (the only copy of a conformed clip's source frames): the hooks
  block an Edit, Write or Bash write to them. Provenance goes through `./kb assets meta`,
  a timing record only through `./kb assets conform`, and new bytes for a conformed clip
  through `./kb assets replace` (its timing record moves aside with the old file;
  `./kb assets restore` undoes it). `./kb assets list` folds a conformed clip's timing and
  provenance into its entry.
- Formats: images png, jpg, jpeg, webp; video mp4, mov, m4v, webm; audio mp3, wav, m4a,
  aac, flac, ogg; environments hdr, exr; grades `.cube`.
- Adding a file to `assets/` does not reload the project; the sidecar edit that uses it
  does. New bytes under an existing name refresh the preview within a couple of seconds.
- Bundled placeholders (`*-sample.*`, `sample-phone-recording.mp4`,
  `sample-laptop-recording.mp4`, `app-icon.png`) are safe drafting media.

Videos are pre-extracted to 60 fps frames on first use (the first preview of a long clip
takes a moment), then sampled from the clock, so preview and export match.

## Screen recordings

Screen recordings (from a phone or the Simulator) are the usual footage. ffmpeg, which
preview and export decode with, misplays some of them, so they are checked on the way in:

- `./kb assets add rec.mov` asks the app's media probe whether the clip decodes faithfully.
  A recording from a phone usually imports as it is, unless it carries an edit list (a
  trim saved without re-encoding). Simulator recordings (a variable frame rate, P3
  colour), edit lists, and clips the two decoders disagree on are conformed the way the
  app's drop does it.
- A conformed import lands as a constant 60 fps `assets/<stem>.mp4` (so `rec.mov` prints
  `assets/rec.mp4`; `--dir` doesn't apply), with the original in
  `assets/.originals/<stem>.<ext>` and `assets/<stem>.timing.json` recording which source
  frame every frame shows. HDR and 10-bit clips are copied as they are, with a warning.
  `--no-conform` copies a flagged video as it is. Without the app kb copies and says the
  file wasn't checked; a failed conform gives the file back, copied as it is.
- Clips already in a project are flagged, never changed: the app's media library marks
  them "Needs conform" by the same rules as `./kb assets probe` (an edit list opening
  inside a frame included), and `./kb check` warns when a scene shows a video ffmpeg
  misdecodes. `./kb assets conform assets/<file>` conforms one in place through the app
  (same name and container, original kept in `assets/.originals/`, nothing to re-point).
  `--repoint` turns a `.mov` or `.m4v` into `assets/<stem>.mp4` and rewrites the JSON
  strings and TSX literals that name it; template literals, edit documents and themes
  are listed, not rewritten, and the old file then stays. It needs the app (exit 2
  `env`), and refuses `*-edited.mp4` and an already conformed clip (exit 1).
- A recording the user drops into the app conforms in the background (10 to 20 s; the
  library shows a Conforming card). Scenes can point at its final `assets/<stem>.mp4`
  straight away: the preview shows the original's poster under a progress ring until the
  frames land, and exports wait for or refuse it. Until it lands `./kb check` notes the
  path as `info` (still conforming from its original in `assets/.originals/`), not an
  error; rerun it once the library's card is gone. A missing `assets/<stem>.mp4` with no
  original beside it, or one whose timing record already exists, is still an error.
- Originals stay (packs never carry them) until the user removes them in the app: Remove
  original in a clip's ⋯ menu, or Remove originals in the library's ⋯ menu, moves them to
  the Trash.
- Then edit what the recording shows with `./kb video` (the kookaburra-video-editing
  skill), and time it on a device screen with the timing keys in reference/devices.md.

## Scene media (`media`)

One array for stills and videos. Where an entry draws depends only on its `host`.

```json
"media": [
  {
    "id": "vid1",
    "kind": "video",
    "src": "assets/screencast.mp4",
    "host": "window",
    "stage": { "position": [0, 0, 0], "size": 5.3, "rotationDeg": [0, 0, 0] },
    "overlay": { "position": [0, 0], "size": 0.72, "rotationDeg": 0, "shape": "none", "layer": "below" },
    "window": { "radius": "macos", "recording": true, "shadow": { "opacity": 0.34, "blur": 0.16, "offset": [0, -0.06] } },
    "motion": { "preset": "float", "amplitude": 0.08 },
    "video": { "startMs": 0, "loop": false }
  }
]
```

| Host | Draws | `size` means |
| --- | --- | --- |
| `stage` | In world space among devices; the camera orbits it with real parallax | World-unit width (`stage` placement) |
| `overlay` | On the overlay's frame layer, camera-locked; nothing without an overlay | Fraction of frame width (`overlay` placement) |
| `window` | A floating window in world space; VIDEO only (a still falls back to overlay) | Fraction of the frame it fits inside (reads the `overlay` numbers) |

- Keep both `stage` and `overlay` placements; switching host keeps the numbers.
  `overlay.position` is -1..1 frame-relative; `shape` `none` or `circle`; `layer`
  `above` or `below` the overlay window.
- `window` chrome (either kind, any host): `radius` (`sharp`, `subtle`, `macos`,
  `rounded` or `{ "custom": 0..0.5 }`), `recording: true` crops a raw macOS window
  capture's margins, `border` `{ enabled, color, width, opacity }`, `shadow`
  `{ opacity, blur, offset }` (short-edge fractions).
- `motion.preset`: `none`, `float`, `tilt-reveal`, `push-in` (both kinds), `turntable`
  (stills), `drift` (videos); tuning `amplitude`, `hz`, `degPerSec`, `durationMs`.
- `video`: `startMs` (scene-local), `loop` (default false: holds the last frame).
- `castShadow: true` for stage-hosted stills.
- `motionBlur: { enabled, amount? }` keeps an item sharp or scales its trail under
  motion blur (reference/camera.md).
- Ids are stable (`img1`, `vid1`); camera rigs can aim at them.

Presets: `image` (full-frame still), `video` (full-frame clip), `videowindow`
(floating screen recording).

## Scene length from a video

```json
"duration": { "mode": "follow-media", "source": "media", "sourceMediaId": "vid1" }
```

The app keeps the scene's `project.json` `durationMs` equal to the video, and ignores the
video's `startMs` when it does: a nonzero `startMs` then hides the video's last `startMs` ms.
A device screen with timing keys (`inMs`, `outMs`, `speed`, `loop`, `posterMs`) counts its
delay, trim and speed instead (reference/devices.md).
To make the video itself a set length, `./kb video fit <edit> --to T` (or `--scene S` for a
fixed-length scene) and `./kb video render <edit> --use --scene S`. Variants:
`{ "mode": "follow-media", "sourceDeviceId": "hero" }` follows a device's screen
video; with no pin the longest device video wins, else a video background.
`{ "mode": "manual" }` turns it off. When you change the source by hand, update `durationMs`
yourself too (`./kb assets probe`); `./kb video render <edit> --use` does it for edited videos.

## Full-frame video or image

A camera-locked fill: `"background": { "type": "video", "src": "assets/bg.mp4" }` (loops;
`"loop": false` holds; `"fit": "fit"` letterboxes) or `{ "type": "image", "src": ... }`.
See reference/backgrounds.md.

## TSX media primitives

- `<ImageCard src="assets/logo.png" width={1.2} maxHeight position from to />`: flat,
  colour-exact plane; PNG alpha shapes it; optional linear fade window.
- `<VideoClip src="assets/clip.mp4" startMs={0} fit="contain" | "cover" position scale />`:
  a video plane; holds the first frame before `startMs` and the last after the end.

## Layered screenshot (3D stack of screens)

The `layeredScreenshot` block renders on any scene with no TSX (template scenes may
mount `<LayeredScreenshot title={...} />`). Preset: `layeredscreenshot`.

```json
"layeredScreenshot": {
  "layers": [
    { "id": "l1", "visible": true, "z": 0, "gap": 0.18, "items": [
      { "id": "i1", "kind": "screen", "src": "assets/home.png", "media": "image", "attach": null },
      { "id": "i2", "kind": "screen", "src": "assets/detail.mp4", "media": "video", "startMs": 0,
        "attach": { "to": "i1", "side": "right" } },
      { "id": "i3", "kind": "text", "width": 2.2, "attach": { "to": "i1", "side": "bottom" } }
    ] }
  ],
  "pose": { "spread": 0.6, "azimuthDeg": 18, "elevationDeg": 12, "zoom": 1, "pan": [0, 0] },
  "placement": { "position": [0, 0], "size": 1, "rotationDeg": 0 }
}
```

- Each layer has EXACTLY one root item (`attach: null`); others chain off a neighbour's
  `left`, `right`, `top` or `bottom`. Unrooted, cyclic or duplicate items drop.
- Screens in a layer share a height; widths follow each image or video aspect. Text
  items take `width`; their copy is `text["ls-<itemId>"]` and styles
  `textStyle["ls-<itemId>Color"]` and so on.
- `gap` (world units) per item, else per layer, else the default. `flat: true` (item
  or layer) drops the card treatment (theme `card.radius` corners, hairline, shadow).
- `z` orders layers back to front; `visible: false` hides one.
- `pose`: `spread` 0 (flattest) to 1 (fully expanded), `azimuthDeg`/`elevationDeg`
  (0/0 front on; 18/12 isometric), `zoom` (1 is auto-fit), `pan` [x, y] world units.
- `placement`: frame-relative offset -1..1, `size` multiplier, clockwise `rotationDeg`.
- `motionBlur`: `{ enabled, amount? }` for the stack's own moves (reference/camera.md).
- Animation: `"animation": { "keys": [{ "id", "tMs", "pose" }], "segments": [...], "presentLoop": { "mode": "jump" } }`
  plays ONLY with `"animatedTrack": "layeredScreenshot"` (which also stands the camera
  track down). Recipes the app's presets use:
  - Expand to isometric: two keys over 1200 ms, `inOutCubic`, to spread 1, azimuth 18, elevation 12.
  - Flatten: the reverse, to spread 0, azimuth 0, elevation 0.
  - Zoom to a screen: two keys over 1000 ms to a front-on pose with larger `zoom` and a
    `pan` centring the screen.
  - Slow drift: four keys over up to 7 s, `inOutSine`, small azimuth (+6, -5), elevation
    and zoom wobbles, last pose equal to the first, `presentLoop: { "mode": "jump" }`.
- Edit in place with paths: `./kb doc S set layeredScreenshot.pose.spread 0.6`,
  `./kb doc S set layeredScreenshot.layers.0.items.1.src assets/detail.png`.

## Terminal panel

```json
"terminal": { "theme": "match-theme", "chrome": { "style": "mac", "title": "zsh" },
  "cols": 80, "rows": 24, "fontPx": 13, "startCommand": "npm test", "position": [0, 0], "size": 0.55 }
```

Live and interactive in preview and Present; exports show the captured `snapshot` (a
raster under `assets/` that the app records). Themes: `match-theme`, `graphite`,
`abyss`, `phosphor`, `amber`, `paper`. `chrome.style` `mac` or `bare`.
`startCommand` is typed into the prompt but never run. `position` -1..1 frame-relative;
`size` a fraction of frame width. After changing the setup, ask the user to capture a
fresh snapshot in the app.

## Website panel

```json
"website": { "url": "https://example.com", "viewport": { "preset": "desktop" },
  "frame": { "appearance": "match-theme", "cornerRadius": 14, "shadow": "soft" },
  "position": [0, 0], "size": 0.72 }
```

`viewport.preset`: `desktop` 1440 x 900, `tablet` 1024 x 768, `mobile` 390 x 844, or
`custom` with `width`, `height`, `orientation`; `zoom` 0.5..2. `frame.appearance`
`match-theme`, `light`, `dark`; `shadow` `none`, `soft`, `strong`. Exports render the
captured PNG (`capture`), which the app records after the user allows the site; ask the
user to capture after changing the URL.
