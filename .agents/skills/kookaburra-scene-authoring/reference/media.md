# Assets, images, video, screenshot stacks, terminal, website

## Assets

- Everything a scene shows lives in `assets/` and is referenced as `assets/<file>`
  (exact case). Never absolute paths or URLs.
- Bring files in with `kb assets add <path> [--name <name>]`: it copies, never
  overwrites (renames on collision) and prints the final path to use.
- `kb assets probe assets/<file>` reports duration, size and frame rate (the app's
  ffprobe). Probe every video before referencing it.
- Formats: images png, jpg, jpeg, webp; video mp4, mov, m4v, webm; audio mp3, wav, m4a,
  aac, flac, ogg; environments hdr, exr; grades `.cube`.
- Before deleting or renaming an asset, search `scenes/*.json` and `scenes/*.tsx` for
  its path. A dangling reference renders a missing card or screen.
- Adding a file to `assets/` does not reload the project; the sidecar edit that uses it
  does.
- Bundled placeholders (`*-sample.*`, `sample-phone-recording.mp4`,
  `sample-laptop-recording.mp4`, `app-icon.png`) are safe drafting media.

Videos are pre-extracted to 60 fps frames on first use (the first preview of a long clip
takes a moment), then sampled from the clock, so preview and export match.

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
- Ids are stable (`img1`, `vid1`); camera rigs can aim at them.

Presets: `image` (full-frame still), `video` (full-frame clip), `videowindow`
(floating screen recording).

## Scene length from a video

```json
"duration": { "mode": "follow-media", "source": "media", "sourceMediaId": "vid1" }
```

The app keeps the scene's `project.json` `durationMs` equal to the video. Variants:
`{ "mode": "follow-media", "sourceDeviceId": "hero" }` follows a device's screen
video; with no pin the longest device video wins, else a video background.
`{ "mode": "manual" }` turns it off. When you change the source, update `durationMs`
yourself too (`kb assets probe`).

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
- Animation: `"animation": { "keys": [{ "id", "tMs", "pose" }], "segments": [...], "presentLoop": { "mode": "jump" } }`
  plays ONLY with `"animatedTrack": "layeredScreenshot"` (which also stands the camera
  track down). Recipes the app's presets use:
  - Expand to isometric: two keys over 1200 ms, `inOutCubic`, to spread 1, azimuth 18, elevation 12.
  - Flatten: the reverse, to spread 0, azimuth 0, elevation 0.
  - Zoom to a screen: two keys over 1000 ms to a front-on pose with larger `zoom` and a
    `pan` centring the screen.
  - Slow drift: four keys over up to 7 s, `inOutSine`, small azimuth (+6, -5), elevation
    and zoom wobbles, last pose equal to the first, `presentLoop: { "mode": "jump" }`.
- Edit in place with paths: `kb doc S set layeredScreenshot.pose.spread 0.6`,
  `kb doc S set layeredScreenshot.layers.0.items.1.src assets/detail.png`.

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
