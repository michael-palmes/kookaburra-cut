# project.json, themes, transitions, music

`project.json` is the sequencing source of truth. Change scene order, durations and
transitions with `./kb scene ...` (manifest-safe, atomic); other fields with
`./kb project set <path> <value>`. Hand edits are legal but must stay valid JSON.

## Shape

```json
{
  "id": "product-launch",
  "name": "Launch",
  "version": 2,
  "themeId": "kookaburra-midnight",
  "formats": ["16:9", "9:16"],
  "defaultTransition": { "type": "crossfade", "durationMs": 600 },
  "scenes": [
    {
      "file": "scenes/01-title.tsx",
      "durationMs": 3000,
      "transition": { "type": "push", "durationMs": 500, "direction": [1, 0], "ease": "smooth" }
    },
    { "file": "scenes/02-demo.tsx", "durationMs": 6000 }
  ],
  "audio": { "file": "assets/track.mp3", "gainDb": -3, "fadeOutMs": 1500 },
  "render": { "toneMapping": "agx", "exposure": 1.05 }
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | The folder slug. Never change it. |
| `name` | yes | Display name. |
| `version` | | Write `2`: transitions live on the OUTGOING scene. Never mix placements. |
| `themeId` | yes | `kookaburra-*` bundled or `ws:<slug>` workspace theme. Unknown ids fall back. |
| `formats` | yes | Aspects the project targets; the first is the default preview aspect. |
| `scenes` | yes | Ordered `{ file, durationMs, transition?, effects? }`. Order is timeline order. |
| `group` | | Welcome screen group heading. |
| `typography` | | `{ headline, body, chart }`, each `"Family"` or `"Family@weight"`. Beats every theme; sidecar `textStyle` still wins. |
| `audio` | | One soundtrack (below). |
| `defaultTransition` | | Seeded onto new boundaries; `null` means hard cut. |
| `render` | | `{ toneMapping, exposure, exactText }` (reference/lighting.md) and `motionBlur` (reference/camera.md). Absent is aces at 1, tone-mapped text, no blur. |
| `lighting` | | Project lighting layer between theme and scene (reference/lighting.md). |
| `frame` | | Deck-wide overlay merged into every scene (reference/sidecar.md). |
| `camera` | | Project camera keys on the global clock (reference/camera.md). |
| `persistent` | | Module path mounted once across all scenes (reference/scenes.md). |
| `appliedBackground` | | `{ background?, backdrop? }` last applied to all scenes; new scenes inherit it. Nothing renders from it. |
| `shared` | | Author constants every scene reads with `useProjectShared` (below). |

Rules:

- Each scene file appears once. Two entries sharing a file fail the load. To repeat a
  scene, `./kb scene duplicate S` (fresh stem, fresh `defineScene` id).
- The manifest `durationMs` wins over the TSX `durationMs`.
- A scene whose sidecar says `duration.mode: "follow-media"` has its `durationMs`
  kept equal to its video by the app. If you swap that video, update `durationMs`
  too (`./kb assets probe` gives the length).
- Deleting a scene: `./kb scene remove S` (moves the TSX and sidecar to the Trash and
  drops the entry). Never leave an entry pointing at a missing file.

## Aspects

`useFormat()` lays scenes out in world units. The visible height is always 4.142
units at z = 0; width follows the aspect. Safe inset is 6% of the shorter side.

| Id | Pixels | Frame (w x h units) | Safe inset |
| --- | --- | --- | --- |
| `16:9` | 3840 x 2160 | 7.364 x 4.142 | 0.249 |
| `9:16` | 2160 x 3840 | 2.330 x 4.142 | 0.140 |
| `1:1` | 2160 x 2160 | 4.142 x 4.142 | 0.249 |
| `4:5` | 2160 x 2700 | 3.314 x 4.142 | 0.199 |
| `5:4` | 2700 x 2160 | 5.178 x 4.142 | 0.249 |
| `3:2` | 3240 x 2160 | 6.213 x 4.142 | 0.249 |
| `2:3` | 2160 x 3240 | 2.761 x 4.142 | 0.166 |
| `phone` | 1206 x 2622 | 1.905 x 4.142 | 0.114 |
| `phone-landscape` | 2622 x 1206 | 9.006 x 4.142 | 0.249 |

Which aspect the editor previews is app state, not a file. `./kb capture --aspect A`
renders any aspect for one request without changing the editor.

## Transitions

A transition plays at the END of the scene that carries it and pulls the next scene's
start back by its overlap: `overlap = min(durationMs, outgoing duration, incoming
duration)`, project length = sum of durations minus overlaps. The last scene never
carries one. No transition is a hard cut. Unknown types render as `crossfade`.

`./kb scene set S --transition push:500 --ease smooth` writes the type, duration and ease;
`--transition none` makes a hard cut. The other fields are hand edits of that scene's
`transition` object in `project.json`:
`direction` (one of `[1,0]` incoming travels left, `[-1,0]` right, `[0,1]` up,
`[0,-1]` down), `color` (dip, halftone, lightsweep), `ease` (`linear` default,
`smooth`, `snappy`), and the per-type numbers below (`intensity`, `softness`,
`center`, `blocks: [x, y]`, `steps`, `parallax`, `shape`). Exact ranges:
`./kb catalog transitions --json`.

| Type | Feel | Reads as | Default ms | Tunable |
| --- | --- | --- | --- | --- |
| `crossfade` | dissolve | Perceptual dissolve | 600 | |
| `blur` | dissolve | Soft-focus swap | 600 | intensity |
| `zoom` | dissolve | Counter-scaled drift | 600 | intensity, center |
| `dissolve` | dissolve | Organic noise wipe | 700 | intensity, softness |
| `rackfocus` | dissolve | Defocus to bokeh, refocus | 800 | intensity, softness, shape linear/hex |
| `flowmorph` | dissolve | Currents carry the frame | 900 | intensity, parallax |
| `wipe` | reveal | Hard reveal line | 500 | direction |
| `luma` | reveal | Iris wipe (shape iris; also linear, radial, image) | 600 | softness, center, shape, src |
| `dip` | reveal | Out through a colour, back in | 600 | color (default theme background) |
| `inkbleed` | reveal | Irregular wicking edge | 800 | direction, intensity, softness |
| `halftone` | reveal | Print screens through an ink plate | 700 | direction, color, blocks[0], intensity, shape |
| `lightsweep` | reveal | Anamorphic streak flare | 500 | direction, color, softness, intensity |
| `glasssweep` | reveal | Refracting bar with dispersion | 700 | direction, softness, intensity |
| `shockwave` | reveal | Refractive pressure front | 600 | center, intensity, softness, steps |
| `slide` | motion | Both scenes travel together | 600 | direction |
| `push` | motion | Incoming covers, outgoing lags | 500 | direction, parallax |
| `whip` | motion | Fast pan under motion blur | 400 | direction, intensity |
| `slice` | motion | Staggered strips slide away | 600 | direction, blocks[0], intensity |
| `spinblur` | motion | Rotational whip | 400 | center, intensity, shape |
| `warp` | motion | Lens pull with a subtle split | 500 | intensity, center |
| `prism` | motion | Faceted refraction unfold | 700 | steps, intensity, center |
| `glitch` | digital | Hashed block cut | 400 | intensity, blocks, steps |
| `datamosh` | digital | Macroblock smear and refresh | 500 | blocks[0], steps, intensity |
| `chromasplit` | digital | Channels peel and reconverge | 500 | direction, intensity, softness |
| `pixelstretch` | digital | Luma-keyed smear collapse | 600 | direction, intensity, softness |
| `shatter` | digital | Shards drift out, lit edges | 700 | direction, blocks[0], intensity, parallax |

Image mask: `luma` with `"shape": "image"` and `"src": "assets/<file>.png"` reveals the
next scene inside the image's shape, growing from `center` until it covers the frame.
A PNG with transparency uses its alpha (opaque = inside); a fully opaque image uses its
brightness (light = inside). png, jpg or webp under `assets/`, at least 1024 px on the
long side for crisp 4K edges. The edge is always one pixel wide (`softness` does not
apply). The picker only shows it, so write it by hand:
`{ "type": "luma", "durationMs": 700, "shape": "image", "src": "assets/star.png" }`.
A missing or unreadable mask fails export; a bad `src` renders the iris.

Choosing one: DESIGN.md "Transitions by feel".

## Themes

A theme sets colours, type, motion defaults, text motion, staging, lighting, background
and effects. `./kb theme list` and `./kb catalog themes` show the bundled set with a mood
line (`--json` adds palette and faces); `./kb theme show <id>` prints tokens. Set the project theme with
`./kb project set themeId kookaburra-paper`, or one scene's with
`./kb doc S set themeId kookaburra-neon`.

| Theme | Mode | Mood | Faces |
| --- | --- | --- | --- |
| `kookaburra-studio-white` | light | Clean product showcases | Inter |
| `kookaburra-pacific` | light | Calm product stories | Inter |
| `kookaburra-paper` | light | Editorial explainers | Playfair Display / Lora |
| `kookaburra-gallery` | light | Minimal portfolios | Space Grotesk / Inter |
| `kookaburra-sunrise` | light | Warm launch stories | Open Sans |
| `kookaburra-loft` | light | Lifestyle product scenes | Space Grotesk / Open Sans |
| `kookaburra-midnight` | dark | Polished technology | Space Grotesk / Inter |
| `kookaburra-neon` | dark | Bold digital energy | JetBrains Mono / Inter |
| `kookaburra-abyss` | dark | Cinematic depth | Inter |
| `kookaburra-ember` | dark | Warm crafted stories | Space Grotesk / Open Sans |

Plus 24 more in six collections (quiet technology, human-centred AI, maker energy,
sensory and surreal, digital assets, modern finance), most with an animated shader or
3D background built in: `./kb catalog themes --search finance`.

### Brands

A brand is a workspace folder `~/Kookaburra Cut/brands/<slug>/` (id `ws:<slug>`):
`brand.json` (themes, default theme, fonts, colours, gradients), `guidelines.md` and
`images/<category>/`. Picking it under Project writes `"brand": "ws:<slug>"`, switches
the project to the brand's default theme and fonts, and copies the guidelines to
`BRAND.md`. The brand's images appear in the Library, its colours in the colour picker's
Brand row, its gradients among the workspace gradients. Read `BRAND.md` as defaults and
guidance, not hard rules. Applying a brand from the terminal
is `./kb brand use <name>` (or `clear`); building or changing a brand belongs to the
kookaburra-brand-packs skill. Never hand-edit `brand` or `BRAND.md`.

### Workspace themes (brand themes)

User themes live at `~/Kookaburra Cut/themes/<slug>/theme.json`, id `ws:<slug>`,
shared by every project. Edit one with `./kb theme set <path> <value>` (the project's
theme, or `--theme ws:<slug>`). Bundled themes
are read-only: to brand, duplicate one in the app's Theme editor, or (with the user's
OK, since it is outside this project) write a new file:

```json
{
  "version": 2,
  "id": "acme",
  "name": "Acme",
  "mode": "dark",
  "colors": { "background": "#0b1020", "text": "#f4f6fb", "accent": "#ff5a36", "muted": "#8a94ab" },
  "typography": { "headline": { "family": "Space Grotesk", "weight": 600 }, "body": "Inter", "scale": 1.25 },
  "motion": {
    "durations": { "fast": 200, "base": 500, "slow": 900 },
    "easings": { "standard": "outCubic", "emphasized": "outExpo" }
  },
  "chartColors": ["#ff5a36", "#3ad1c4", "#8b5cf6", "#f5b942", "#5b8cff", "#e85d9a"],
  "textAnimation": { "in": "fade-up", "out": "fade", "staggerMs": 90, "stagger": "word" },
  "background": { "type": "gradient", "gradient": "brand" },
  "gradients": { "brand": { "type": "linear", "angleDeg": 160, "space": "oklch", "stops": [["#0b1020", 0], ["#1b2350", 1]] } }
}
```

Required: `version`, `id`, `colors` (all four), `typography` (`headline`, `body`,
`scale`), `motion` (three durations, two easings). Optional: `mode`, `gradients`,
`chartColors`, `textAnimation`, `textLook`, `card.radius` (0..0.5, screenshot card
corners), `lighting`, `environment`, `backdrop`, `background` (no video), `effects`.
An absent optional block keeps the simplest render path. A theme edit shows on the
next project reload; `./kb check --app` and captures always load it fresh.

### Theme variants (`extends`)

A brand variant (a light cut, a launch accent) is a version 3 workspace theme that
names its base and carries only what differs:

```json
{ "version": 3, "id": "acme-light", "name": "Acme Light", "extends": "ws:acme",
  "mode": "light", "colors": { "background": "#f6f7fb", "text": "#0b1020" }, "background": null }
```

- `extends` takes `ws:<slug>` or a bundled id. Objects merge key by key, arrays and
  plain values replace, the variant wins, and `null` clears an inherited block. The
  base never lends its `version`, `id`, `name` or `catalogue`, so a variant writes its
  own. Chains are fine; a loop or a missing base makes the app fall back to the
  default theme.
- Bundled themes cannot extend, and `extends` is ignored below version 3.
- Set it with `./kb theme set extends ws:acme --theme ws:acme-light`; the write is
  refused when the base is missing, loops or the merge still lacks a required block.
- Theme fonts take the sidecar grammar (`"Inter@600"`); a radial gradient may leave
  out `angleDeg`, a linear one may not; a `lighting.shadow` needs only `technique`.
- `./kb check` flags dropped blocks, and the app lists what it ignored under "Some
  settings were ignored" (`./kb status` shows the same lines).

## Typography overrides

`project.json` `typography` replaces the theme faces project-wide; `chart` sets one
face for all chart text. Use bundled families unless `./kb fonts check` passes
(reference/text.md "Fonts").

## Music

```json
"audio": {
  "file": "assets/track.mp3",
  "gainDb": -2,
  "fadeInMs": 400,
  "fadeOutMs": 1500,
  "fadeOutCurve": "smooth",
  "startOffsetMs": 0
}
```

- One soundtrack per project; remove the block to remove music. Copy the file in with
  `./kb assets add` (mp3, wav, m4a, aac, flac, ogg).
- It fades out over the last 1000 ms of its audible end unless `fadeOutMs` says
  otherwise (`0` disables). `fadeOutCurve`: `smooth` (default), `linear`, `scurve`,
  `exponential`, `logarithmic`.
- `startOffsetMs` skips into the track. `markers` holds user beat overrides
  (reference/beats.md).
- `grid` (the beat grid), `cues` (named times) and `sections` make the music addressable
  as `bar:13`, `cue:drop` and `section:chorus`. Write them with `./kb song analyse
  --accept` and `./kb beats ...`, never by hand: kb validates them as the app does and
  moves every key that follows them in the same write (reference/beats.md). A new
  soundtrack keeps them, so refit (`./kb song analyse --accept`); `./kb check` warns
  while the grid was fitted to another file.

## Effects (postprocessing)

A theme's `effects` block turns on bloom, vignette, LUT grade and grain for the
project. A scene can override fields in its manifest entry:

```json
{ "file": "scenes/03-glow.tsx", "durationMs": 4000,
  "effects": { "bloom": { "intensity": 1.8 }, "vignette": { "darkness": 0.5 } } }
```

| Effect | Fields |
| --- | --- |
| `bloom` | `intensity` (0 off), `luminanceThreshold`, `luminanceSmoothing` |
| `vignette` | `offset`, `darkness` (0 off) |
| `lut` | `url` (project `.cube`), `intensity` 0..1; all LUTs in a project share one size |
| `grain` | `intensity` (0 off) |

Overrides merge field by field onto the theme's effect. When the theme lacks that
effect, give every field. Effects blend across transitions. A LUT that fails to load is
dropped with a warning (the scene renders ungraded).

## Project camera

`camera` is a list of `{ tMs, position?, fov?, lookAt? }` keys on the GLOBAL clock,
interpolated per property. It is the only owner of `fov` unless a rig key sets one.
Prefer per-scene `camera` / `cameraRig` sidecar tracks (reference/camera.md).

## Shared constants

`shared` is an object of your own constants for scene TSX: a palette beyond the theme,
beat timings, repeated sizes. Nothing renders from it directly.

```json
"shared": { "palette": { "highlight": "#ffcc4d" }, "timing": { "beatMs": 480 } }
```

- Read it with `useProjectShared("timing.beatMs", 500)` (dotted path, array indexes as
  numbers, the fallback when missing); `useProjectShared()` returns the whole block.
- Set values with `./kb project set shared.timing.beatMs 480`. Anything but an object is
  an error and the app ignores it.
- Theme tokens stay the source of brand colour; keep `shared` for values the theme has
  no token for.
- Copying a scene into another project (or inserting a preset) brings the `shared`
  keys the destination lacks; existing keys are never overwritten.

## App icon and media library

- The app icon is the fixed path `assets/app-icon.png` (BrandLockup reads it). Replace
  that file to change it; keep it square.
- `*-sample.*` files, `sample-*-recording.mp4` and `app-icon.png` are bundled
  placeholders the app restores on load. Use them for drafts; deleting them only
  brings them back.
