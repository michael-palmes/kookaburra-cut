# Look lab

A dev-only harness for scene3d looks. It renders the real look components through
react-three-fiber in headless Chrome and writes a contact sheet PNG in about ten seconds, without
booting the app or waiting in the autorun queue. It never touches Tauri and is not part of the app
build (its page is not a `vite.config.ts` input).

## Commands

```bash
node tools/look-lab/sheet.mjs --look wash-dome                 # p1 + p6 at t 8 s: five cameras plus a 9:16 tile
node tools/look-lab/sheet.mjs --look wash-dome --compare 4,8   # motion: both times plus a |difference| row
node tools/look-lab/sheet.mjs --look wash-dome --grid          # all nine presets as the picker stills
node tools/look-lab/sheet.mjs --look wash-dome --presets p3 --params coverage=0.6,edge=0.4 --out /tmp/p3.png
node tools/look-lab/sheet.mjs --look wash-dome --width 1920 --ss 2 --cams lab --tall none   # export-scale lines
node tools/look-lab/sheet.mjs --look wash-dome --serve         # live page in a browser, with HMR
```

`pnpm look-lab --look wash-dome` is the same runner.

| Flag | Default | Meaning |
|---|---|---|
| `--look <id>` | required | Any `SCENE3D_BACKGROUNDS` id, built-in or discovered |
| `--presets p1,p6` | `p1,p6` (grid: all nine) | Rows |
| `--t 8` / `--compare 4,8` | `8` | Look seconds on the absolute clock; two times add a motion row |
| `--cams front,lab,wide,behind,far` | those five (grid: `preview`) | Columns, named or `orbit:az:el:dist[:targetY]` |
| `--tall lab` | `lab` | Camera for the 9:16 tile, or `none` |
| `--grid` | off | One tile per preset, three across, no stand-ins (`--content` adds them) |
| `--width 480` | 480 (grid 640) | 16:9 tile width in pixels |
| `--ss 2` | 1 | Render at that multiple and box-filter down |
| `--params k=v,...` | none | Param overrides on every preset |
| `--headline "..."`, `--no-content`, `--theme <id>` | | Stand-in text, hide the stand-ins, theme (font and clear colour) |
| `--raw` | off | One bare tile, no labels (pixel comparisons) |
| `--out file.png` | `$TMPDIR/look-lab/<stem>.png` | Output path (printed) |
| `--gpu` | off | Metal ANGLE instead of SwiftShader: about 3x faster, same pixels in the proof below |
| `--timeout 180`, `--retries 1`, `--verbose` | | Per-attempt limit, fresh-Chrome retries, progress lines |

Cameras: `front` is the app default (0, 0, 5) at fov 45; `lab` the generated preview-lab pose (az
20, el 6, dist 7, target y 0.6); `static` the grids' preview pose; `wide` (32, 20, 22); `behind`
(180, 10, 9); `far` (20, 14, 45); `low` and `top` for floors and domes; `preview` the look's
picker-still pose (`static` for `previewCamera: "static"` and grids, else `lab`).

Exit codes: 0 clean, 1 rendered but the page logged errors (printed under the sheet and in the
terminal), 2 setup failure or timeout. Warnings print too; fix them rather than ignore them.

## What it replicates

- The look mounted exactly as a scene does: `FixedBackdrop` with the preset's scene3d spec (the
  backing quad, then `Scene3dBackdrop`: slot colours, clamped params, the backing tone, the render
  order stamp), under the scene's theme, `FormatContext` at the aspect's export size (so `uPx`,
  `uResolution` and the ink raster floor match export) and the clock store at `--t`.
- The renderer the app canvas gets: sRGB output, ACES at exposure 1 (`applyRenderSettings`), MSAA
  4 on the default framebuffer, VSM shadows, fov 45 with near 0.1 and far 1000, and a direct
  `gl.render` like the compositor's single-scene fast path.
- A toolkit `AnimatedHeadline` (troika SDF, theme font, the preset's AA text colour) and an unlit
  handset at the Device auto-fit size, both at the bg3d-atlas layout.

Proof (wash-dome, pulsar-ridges and rain-canopy p6 against `--action screenshot` of
ws:bg3d-atlas, 4K box-filtered to 1080p, content masked): background pixels match within 1 code
value at p99 (max 1, 5 and 13 on rare edge pixels).

## What it does not

- Transitions, the effects composer (grain, DOF, LUTs), overlays, environment maps, lighting
  keyframes and camera tracks: every tile is one static pose.
- Real devices: no glb, screen media or analytic contact shadow. Lit looks get only the theme's
  stage lighting, never the preset's companion lighting.
- WKWebView itself: SwiftShader differs by a code value on edges, and engine-only failures (the
  macOS 27 ANGLE `inout` rejection, the 4 GB WebContent ceiling) cannot show.
- Frame rates: tile times are SwiftShader (or headless Metal) costs; use `--action perf` for
  preview speed.

So iterate here, then confirm with one or two `pnpm kookaburra:run --action screenshot` frames.

## Parallel runs

Each run takes its own port and Chrome profile, kills Chrome's process group when done and gets
the PNG posted by the page itself, so there is no screenshot race; a hung or crashed Chrome is
retried. Vite start-up and the first page load hold a short lock
(`node_modules/.vite-look-lab/.startup-lock`) because a cold dep cache is rewritten in place.
