# Sample product family

The screens, recordings and icons the launch templates show, rendered from HTML and
CSS so every pixel is reproducible. Three fictional products share one world (the
same week, the same people, the same release):

| Product | What it is | Look | Surfaces |
| --- | --- | --- | --- |
| Fairywren | A calm planner | Warm grey, sage and coral, Inter Tight titles | Phone (light, dark, focus, an older design, insights, month), five feature flows (`features.html`, each with a dark twin), tablet and laptop week, web share flow |
| Thornbill | A developer CLI and SDK | Midnight, cyan and lime, JetBrains Mono | Terminal (an upgrade and a change list on the beat), docs site, migration diff, benchmarks, dashboard, editor |
| Songlark | An AI assistant | White canvas and violet | Three prompt and answer pairs and a streamed follow-up on the web, the same on a phone, voice mode |

## Run it

```bash
pnpm assets:sample-product                       # everything into projects/_samples
pnpm assets:sample-product --only fairywren      # names containing a word
pnpm assets:sample-product --only songlark-ask-window.mp4 --at 2,4 --out /tmp/peek   # stills of chosen moments
pnpm assets:sample-product --list
```

It needs Google Chrome (`SAMPLE_PRODUCT_CHROME` overrides the path), ImageMagick, pngquant,
oxipng and the ffmpeg sidecar (`pnpm setup:ffmpeg`; it falls back to `ffmpeg` on the PATH).

## How it works

- `manifest.mjs` lists every output: its page, device and, for a recording, its length.
  Device sizes are CSS pixels times scale, matching the device catalogue's screens:
  phone 1206x2622 (iPhone 17 Pro), tablet 2752x2064 (iPad Pro 13), laptop 3456x2234
  (MacBook Pro 16) and window 2560x1600 (a 16:10 browser or terminal window).
- Each page defines `window.render(ms)`, a pure function of the frame time. CSS
  animation and transitions are off and nothing reads the wall clock (`shared/motion.js`
  holds the easing, typing and tap helpers), so a still at `at` seconds is exactly that
  frame of the recording.
- `render.mjs` serves the pages and the bundled fonts on 127.0.0.1, drives headless
  Chrome over the DevTools protocol in sRGB, steps 30 frames a second to PNG and
  encodes H.264 yuv420p with BT.709 tags and faststart, raising the CRF until a clip
  fits 1.5 MB. Stills are JPEG; icons are 1024 PNG with transparent corners.
- Fairywren's icon tile holds painted artwork (`fairywren/icon-art.jpg`); `mark.svg`
  stays the small mark inside its screens.
- Type is the bundled OFL faces only (Inter, Inter Tight, JetBrains Mono, Space
  Grotesk). They are Latin subsets, so symbols such as ticks and arrows are inline SVG.

## Rules for new screens

- Draw phone screens for the camera, not for a thumb: Fairywren's titles are 20 px on a
  402 px wide screen, nothing that matters sits under 13 px, and a screen holds four plans.
  `fairywren/parts.js` has the shared header, week strip, plan card and dock.
- Motion is eased and settles; no linear slides. Add `&mode=dark` for a dark twin and name
  it `<name>-dark-<device>`.

- Fictional names, people and data only. No real products, marks, domains or package
  installs (`npx` or `brew` lines invite someone to squat the name).
- Keep each recording 4 to 6 seconds, settled at its first and last frame, and the
  whole family under 18 MB.
- The names were checked against IP Australia, USPTO, the App Store, npm and PyPI on
  6 Nov 2026. Whipbird and Bellbird clashed with live software marks (WHIPBIRD SIGNALS
  in AU classes 9, 38 and 42; BELLBIRD in US classes 9, 38 and 42), so the developer
  tool and the assistant became Thornbill and Songlark. Check again before adding a name.
