# Design playbook

How to make Kookaburra Cut videos, decks and demos look outstanding. Mechanics live in
reference/; this file is taste. When in doubt, copy what the bundled templates do: they
were tuned by eye (`kb catalog templates` lists their scenes; read them under the app's
Resources folder, `projects/<template>/scenes/`).

## Principles

1. One idea per scene. If a scene needs two sentences to describe, split it.
2. One hero per frame: a headline, a device, a number or a chart. Everything else
   supports it, smaller and quieter.
3. Restraint. One accent colour moment per scene, two type sizes, at most two things
   moving at once. Motion that does not carry meaning is noise.
4. Continuity. One theme, one background family, one main transition, one text motion
   style per section. Changes in style should mark changes in story (a chapter, a
   reveal), never happen at random.
5. Real product beats illustration. A real screen recording on a device beats any
   amount of animated type about it.
6. Legibility first: every word readable on a phone, in both aspects, for long enough.

## Pacing

The shipped templates run 13 to 27 seconds with scenes of 2 to 5 seconds. Norms:

| Scene | Length | Notes |
| --- | --- | --- |
| Hook or title | 1.8 to 3 s | Reveal done by 0.9 s; hold the rest |
| Feature on a device | 3.2 to 4.5 s | Or the recording's length (follow-media) |
| Bullet or panel slide | 2.5 s + 0.6 s per bullet | Presentations: 5 to 8 s, or Present mode holds |
| Number or stat | 2.4 to 3.4 s | Count over 1 to 1.8 s, hold at least 1 s |
| Chart | 3.6 to 5 s | Build-in about 0.9 s, then hold or morph |
| Before/after | 4 to 4.5 s | Divider sweeps over most of the scene |
| Closing card | 2.2 to 3.8 s | Hold the call to action at least 1.5 s |

- Reading time: allow about 250 ms per word plus 1 s after the reveal completes.
- Social cuts 12 to 20 s; launch films 30 to 60 s; explainers under 2 minutes.
- Reveal windows 500 to 900 ms; subtitles 150 to 350 ms behind titles.
- Transitions 400 to 700 ms (whip and glitch 300 to 500). Long transitions eat scenes:
  the overlap comes out of both neighbours.

## Composition

The 16:9 frame is 7.364 x 4.142 world units; think of it as a 1920 x 1080 grid where one
unit is about 261 px. The safe inset is 0.249 units (65 px).

| Landmark (16:9) | x | y |
| --- | --- | --- |
| Safe edges | plus or minus 3.43 | plus or minus 1.82 |
| Thirds | plus or minus 1.23 | plus or minus 0.69 |
| Title band | 0 (or left aligned at -3.0) | 1.2 to 1.6 |
| Device beside text | plus or minus 1.4 to 1.8 | about -0.2 |

- Text and device side by side in landscape: text in one half (left aligned,
  `maxWidth` about 3 units), device centred in the other.
- Portrait (9:16 is 2.33 units wide): stack instead. Title in the top third, device
  below at about 0.8 of its landscape scale, no side by side.
- Square and 4:5: as portrait with a little more width.
- Lay out from `useFormat()` numbers, never constants; capture `--aspect 16:9` AND
  `--aspect 9:16` after every layout change.
- Breathing room: keep 0.3 units between text blocks and the device edge; nothing
  touches the safe edge except full-bleed media.

## Typography

| Role | 16:9 size (units) | Portrait | Notes |
| --- | --- | --- | --- |
| Hero title | 0.5 to 0.7 | 0.3 to 0.4 | Headline face, 600 |
| Section title | 0.4 to 0.5 | 0.26 to 0.34 | |
| Subtitle | title / scale^4 (about 0.2 to 0.25) | 0.14 to 0.18 | TitleBlock computes it; muted |
| Body and bullets | 0.2 to 0.26 | 0.14 to 0.18 | Body face |
| Labels and captions | 0.14 to 0.18 | 0.11 to 0.13 | Never smaller |

- Titles 30 to 45 characters; body lines up to about 60. Wrap with `maxWidth`, break
  deliberately with `\n` rather than letting a word orphan.
- Two families at most (the theme's headline and body). Contrast by weight and size,
  not by a third font.
- Tighten long titles with `textStyle.<key>LineHeight` 1.05 to 1.15.
- Numbers: big, single, with the unit smaller beside or below.

## Colour

- Use theme tokens: `text` for copy, `muted` for secondary, `accent` for the one thing
  to look at (a key word via `*word*` emphasis or `highlight-block`, a chip, a rule, a
  chart series).
- Pick the theme by mood (`kb catalog themes`): light themes for calm product stories,
  dark themes for drama, launches and anything with bloom or neon.
- Text over moving backgrounds: use shader or 3D presets whose mode matches the theme
  (light preset with a light theme), and keep busy looks behind, not under, copy.

### Brand from a website

1. Get the palette: ask the user for brand hexes and logo, or fetch the site when web
   tools are available and pull the primary, a dark neutral, a light neutral.
2. Map to tokens: `background` (the brand's darkest or lightest neutral), `text` (at
   least 7:1 against background), `accent` (the brand primary; at least 3:1),
   `muted` (text mixed about 40% toward background).
3. Fonts: use the brand family only if `kb fonts check` passes; otherwise the closest
   bundled family: geometric sans to Space Grotesk or Inter; humanist sans to Open Sans
   or Nunito; condensed to Barlow Condensed; editorial serif to Playfair Display, Lora
   or Cormorant Garamond; corporate sans to Libre Franklin; mono to JetBrains Mono.
4. Apply: for a whole video, a workspace theme (reference/project.md) so charts and
   backgrounds follow too; for a light touch, `project.json` `typography` plus a brand
   gradient `background` (oklch spec) and `textStyle` colours on key lines.
5. Logo: copy it to `assets/` (PNG with alpha); `BrandLockup`, `headerIcon` or an
   overlay `icon` place it. The app icon is `assets/app-icon.png`.

## Motion

Text motion by purpose (sidecar `textAnimation`):

| Purpose | Presets |
| --- | --- |
| Calm, corporate | `fade-up` (word, 70 to 90 ms), `fade`, `mask-reveal`, `rise-mask` |
| Launch energy | `fade-scale` with `shine`, `slam`, `stamp`, `spring-pop`, `tracking`, `build` |
| Tech and developer | `tracking`, `develop`, `glint-wipe`, `highlight-wipe`, `typewriter` (or `PromptBar`) |
| Editorial | `blur-in`, `weight-build`, `underline-draw` |
| Playful | `spring-pop`, `flip-cascade`, `word-cycle`, `ribbon` |
| Cinematic | `dolly`, `chromatic`, `line-stretch` |
| Exits | `fade`, `vapor` |

- Word stagger 60 to 90 ms, character 25 to 40 ms. Long copy: `by-paragraph`.
- Entrances decelerate: `outCubic`, `outQuart`, `outExpo`. Camera moves: `inOutCubic`
  or `inOutSine`. `outBack` only for small pops. `linear` only for continuous spins and
  orbits. `jump` for cuts.
- In TSX, `ramp(localMs, start, end, "outCubic")` drives one-shot moves, `sampleKeys`
  multi-step moves and `<Stamp at>` (or `stampScale()`) a stamped pop for badges, ticks
  and pills (`RoundedRect`, `Pill`). Keep timings several scenes share in `project.json`
  `shared` (`useProjectShared`).
- Product demos: show a tap where the finger lands (sidecar `taps` on the device, or a
  `Cursor` for laptop screens), one tap per beat of the story, never a tap storm.
- Devices: `push-in` or `tilt-reveal` to enter, `float` (amplitude 0.06 to 0.08) to
  idle. Avoid `turntable` while the screen matters: it turns away.
- Sync to the soundtrack where there is one (reference/beats.md): land reveals and
  cuts ON beats.

## Camera by intent

| Intent | Move |
| --- | --- |
| Focus, emphasis | `push-in`, or a 5 to 10% distance change |
| Show an object all round | `orbit-round` (3D objects, devices without critical screens) |
| Arrival, reveal | `crane-down` |
| Energy through layers | `fly-through` with `DepthStage` |
| Depth with layered content | `parallax-slide` |
| A dramatic beat | `dolly-zoom`, once per video |
| A cut on the music | Two keys with a `jump` segment |

Text-heavy scenes keep the camera still or nearly so. Depth of field (`Cinematic`
blur 0.6, range 1.2) separates a device from a busy background; keep text on the
focus plane.

## Devices for product demos

- Model: `iphone-17-pro` for iOS, `android` for Android, `ipad-pro-13` for tablet apps,
  `macbook-pro-16` for desktop and web apps, `iphone-duo` for a fold story.
- Screen media: real recordings trimmed to the feature, `startMs` timed to the caption.
  Static screenshots for stills and stacks.
- Pose: front on for clarity; editorial `[-6, 14, 0]` for style; mirror it on
  alternating scenes for rhythm.
- Shadows: `soft` clean default, `long` for drama, `wetfloor` on dark premium stages,
  `drop` or `sun` for app-store cards.
- Several devices: `toe-in` for two or three, `hero` for one main plus context,
  `cascade` for a tour, `depth-pair` for two in depth.
- Before/after: `compare` on one device (`feature-compare`) beats two devices side by
  side for the same screen.

## Transitions by feel

- Default: `crossfade` 500 to 600 ms. Most scenes.
- Sequential steps: `push` or `slide` in ONE direction (reads as progress).
- Energy: `whip`, `slice`, `zoom`. Chapter breaks: `dip`.
- Reveals: `luma` (iris), `wipe`, `lightsweep`, `glasssweep`.
- Premium and dreamy: `blur`, `rackfocus`, `flowmorph`, `dissolve`.
- Tech: `glitch`, `datamosh`, `chromasplit`, `pixelstretch`, sparingly.
- One-off moments: `shatter`, `prism`, `shockwave`.
- Pick one main transition plus one accent per video. Hard cuts on strong beats.

## Backgrounds

- Calm product: a light `mesh-gradient` or `simplex-noise` preset, or an oklch gradient.
- Premium dark: `smoke-ring`, `neuro-noise` dark presets, or a 3D look such as
  `aurora-veil`, `halo-rings` or `orb-field`.
- Data and finance: `graph-grid`, `horizon-grid`, `contour-field`.
- Moving cameras: 3D looks, so the background parallaxes.
- Use the same spec on consecutive scenes; shaders flow continuously across cuts.

## Recipes

Each starts from scene presets (`kb scene add <stem> --preset <slug>`) or a template
the user creates from the app's Welcome screen.

**Product demo (20 to 40 s).** `title-opener`, then two or three `hero-device` scenes
with real recordings and one-line captions, `feature-compare` for the key improvement,
`stat-counter` for the payoff, `closing-cta`. Theme `kookaburra-studio-white` or
`kookaburra-midnight`. `push` between feature scenes. Template: `feature-deep-dive`.

**Launch video (30 to 60 s).** Hook `title-opener` with a shine, `layeredscreenshot`
expanding to isometric, `hero-device` scenes cut on the beat, `comparison` with a
`toe-in` layout, `chart-reveal` or `stat-counter`, `appversion`, `closing-cta`. Dark
theme with bloom (`kookaburra-abyss`, `kookaburra-neon`, `kookaburra-lucid-chrome`),
music with beats. Templates: `whats-new-social-cut`, `redesign-reveal`.

**Slide deck presentation.** A deck `frame` in `project.json` for consistency, then
`overlaystart` and `overlayend` for content slides (alternate sides), `overlaypanel`
for section titles and bullet lists, `chart` with a panel mount for data. Calm motion
(`fade-up`), `crossfade` or `slide`. 5 to 8 s per slide, or Present mode holds. Mark
stills (`stills.marksMs`) and export a PDF handout.

**Feature explainer.** Problem on `overlaypanel` (two or three bullets), the feature
named on `title-opener`, the flow on `hero-device` with captions, the screens in a
`layeredscreenshot`, the payoff on `stat-counter`, `closing-cta`. Template:
`feature-deep-dive`, `onboarding-refresh`.

**Release notes.** `appversion` (BrandLockup with the version), one `overlaypanel` per
area (Added, Changed, Fixed) with bullets, a `videowindow` recording for the headline
change, `closing-cta`. Templates: `changelog-rundown`, `dev-release-notes`,
`quality-release-notes`.

**Stat or chart reveal.** One number: `stat-counter` (lead-in line, counter, unit).
Series: `chart-reveal` with `rise`; money with `ticker` and a compact `$` format; a
change over time with a data `track` morph. Hold at least 1.5 s after the build.
Template: `performance-release-stats`.

**Before and after.** One screen changing: `feature-compare` (wipe across one device).
Old and new side by side: `comparison`. Light to dark or a re-theme: `compare.b.themeId`
or `b.background`. Templates: `before-after-update`, `dark-mode-launch`,
`redesign-reveal`.

## Before you deliver

- [ ] `kb status` clean: no error cards, no font issues, no missing assets.
- [ ] `kb check --app` passes.
- [ ] Every changed scene captured in a landscape AND a portrait aspect (and every
      aspect in `formats`), mid-reveal and settled.
- [ ] All text inside the safe area, nothing clipped, nothing overlapping a device.
- [ ] Legible at phone size: no text under the sizes above; contrast holds over moving
      backgrounds.
- [ ] Durations give every line its reading time; nothing exits before it is read.
- [ ] One theme, consistent transitions, accent used once per scene.
- [ ] Fonts bundled or passed `kb fonts check`; capture confirms the face.
- [ ] Videos probed; follow-media durations match.
- [ ] Told the user what changed, in plain words.
