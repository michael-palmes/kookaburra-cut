# Text, fonts, text motion and looks

All exported text is troika SDF text drawn by toolkit primitives. Never DOM, HTML or
drei `Html`. Copy lives in the sidecar; styling exceptions in `textStyle`; motion in
`textAnimation`; style in `textLook`.

## Who owns the copy

Read the sidecar first (`kb doc S get`):

| Sidecar has | Owner | Edit |
| --- | --- | --- |
| no `managedText` | Code-owned: TSX reads `text.<key>` via `useSceneText(key, fallback)` | `kb doc S set text.title "New title"` |
| `managedText` with `"layout": "template"` | The scene's own composition renders the managed items; `useSceneText(key)` returns the item with that key (blank if none) | Edit the item's `text`; keep `text.<key>` mirrored |
| `managedText` without `layout` | The generic responsive stack (ManagedTextStack) renders the items; TSX headlines with the default role stand down | Edit `managedText.items` |

```json
"managedText": {
  "layout": "template",
  "groups": [{ "key": "text", "itemKeys": ["title", "subtitle", "bullets"], "align": "left" }],
  "items": [
    { "key": "title", "type": "title", "text": "Ship faster" },
    { "key": "subtitle", "type": "subtitle", "text": "Three things in 2.4" },
    { "key": "bullets", "type": "bullets", "text": "Offline mode\nShared lists", "marker": "dot",
      "points": [{ "key": "bullets-point-1", "text": "Offline mode" }, { "key": "bullets-point-2", "text": "Shared lists" }] },
    { "key": "icon", "type": "icon", "icon": "assets/app-icon.png" }
  ]
}
```

- Item types: `title`, `subtitle`, `bullets` (`points` plus a newline `text` mirror;
  `marker`: `dot`, `dash`, `tick`, `number`, `none`; `pointGap`, `indent` in world
  units), `icon` (emoji or `assets/` image).
- Keys are stable: styles and motion attach to them. Never rename a key to change copy.
- `groups` (optional) make atomic rows with their own `align`; absent means one group.
- Empty `items` deliberately renders no scene text. Adding, removing or reordering
  items (or changing a type) on a template scene: also delete `layout`, which moves the
  scene to the generic stack.
- Positioned composition labels (compare chips, axis notes) use
  `useSceneText(key, fallback, "embedded")` and `managedTextRole="embedded"` so they
  stay in `text` and never become managed lines.
- The host draws `text.title` / `text.subtitle` (or managed items) on any scene whose
  TSX does not render those keys, so a title can be added with no TSX change.
- An overlay `frame` with `claimsSceneText` (default) takes title, subtitle and bullets
  into its panel.

## textStyle (per text key)

Keys are `<textKey><Suffix>`; a primitive must carry `textKey` (or be managed text).

| Suffix | Value |
| --- | --- |
| `Color` | Token `text`, `muted`, `accent`, or a hex |
| `Font` | `"Family"` or `"Family@weight"` (see Fonts) |
| `Size` | Multiplier of the designed size (1 = unchanged; portrait and landscape defaults both scale) |
| `OffsetX`, `OffsetY` | World-unit nudges from the layout position |
| `LineHeight` | Multiple of font size, 0.8..2; absent is the font's own |
| `RotationDeg` | Clockwise tilt about the anchor |

Also `iconSize`, `frameIconSize` and `chipSize` scale icons and chips. Layered
screenshot text items use `ls-<itemId>` keys.

## Primitives

`AnimatedHeadline` (the core):

| Prop | Default | Notes |
| --- | --- | --- |
| `text` | | `\n` breaks lines |
| `from`, `to` | 0, 600 | In window, scene-local ms |
| `outAt` | | Out start; plays over the in's length. Exits need this prop |
| `preset`, `outPreset` | theme `textAnimation` | Prefer the sidecar spec (below) |
| `stagger`, `staggerMs`, `delivery`, `delayMs`, `startScale`, `shine`, `direction`, `ease` | theme | As the spec fields |
| `durationMs` | `"authored"` | A number pins the whole reveal, first unit's start to last unit's settle, whatever the copy's word or letter count (stagger and unit duration scale together); `"authored"` keeps the per-unit timing. `AnimatedGroup` takes it too |
| `textKey` | | ALWAYS set it: enables sidecar styling and the inspector row |
| `face` | `headline` | Or `body` |
| `defaultColor` | `text` | Design default that stays app-editable |
| `color` | | Pins the fill (token or hex); the inspector can no longer change it. Avoid |
| `position`, `fontSize` | [0,0,0], 0.6 | World units |
| `anchorX`, `anchorY`, `textAlign`, `maxWidth`, `lineHeight` | centre, middle | Layout; `maxWidth` wraps |
| `look`, `lookParams` | | Text look (below); prefer the sidecar |
| `fontRef` | | Explicit `{ family, weight }`; prefer `textStyle.<key>Font` |

- `TitleBlock title subtitle align from to fontSize position maxWidth titleColor subtitleColor subtitleDelayMs icon`:
  title plus optional subtitle with theme-scale sizing and safe-area alignment; an
  empty subtitle recentres the title; title 0.56 landscape, 0.34 portrait; the
  subtitle sits four modular steps smaller, 350 ms behind; alignment prop, else
  `textLayout.align`, else centre; icon defaults to `headerIcon`.
- `BrandLockup title subtitle icon from to position iconWidth titleSize subtitleSize titleColor subtitleColor`:
  app icon (default `assets/app-icon.png`) beside a small title over a large subtitle,
  revealed as one unit; scales down for square and portrait.
- `AnimatedCounter from to durationMs format position fontSize anchorX anchorY textKey startMs ease steps`:
  counts over `durationMs` from `startMs` (default 0, scene start), linear unless `ease`
  names an ease, in `steps` equal jumps when set (landing on `to`); `format` returns the
  string, for example `(n) => "$" + n.toFixed(1) + "M"`; default size 0.5, anchored
  centre/middle.
- `ExtrudedText`: lit 3D text, bundled families only, no emoji.
- `ManagedTextStack`: the generic managed renderer the host mounts; rarely mounted by hand.

## Text motion (`textAnimation`)

Write the spec in the sidecar so the app's Text motion panel stays live:

```json
"textAnimation": { "in": "fade-up", "out": "fade", "staggerMs": 90, "stagger": "word", "delayMs": 150 }
```

| Field | Values |
| --- | --- |
| `in`, `out` (required) | Preset ids (table); unknown names play as `fade` |
| `staggerMs` | Per-unit delay; `stagger` is only honoured when this is above 0 |
| `staggerExact` | `true` makes `staggerMs: 0` mean no stagger. Without it a 0 under a granularity (a letter or word preset, `by-paragraph`, a TSX `stagger`) plays that granularity's default delay; the app and `kb doc set` write it with a 0, and `kb check` warns where it is missing |
| `stagger` | `char` or `word` |
| `delivery` | `all-at-once` (forces one block), `by-paragraph` (`\n`), `by-paragraph-group` (blank lines) |
| `delayMs` | Hold before the in starts |
| `durationMs` | In and out window length (absent keeps each primitive's timing) |
| `startScale`, `shine` | `fade-scale` (startScale 0.05..4, default 0.8; shine is one soft band sweep) |
| `direction` | `from-left`, `from-right` (`twist-scale`, `orbit`) |
| `distance` | Travel in em (`fade-up`, `slide`, `scatter-scale`) |
| `ease` | An ease name (reference/sidecar.md) |
| `motionBlur` | `{ enabled, amount? }`: keep text sharp or scale its trail under motion blur (reference/camera.md); lower `amount` on presets that already smear |

Resolution: TSX props > sidecar `textAnimationOverrides.<key>` or `textAnimation` >
theme `textAnimation` > the plain linear reveal. `textAnimationForce: true` makes the
sidecar and theme beat TSX animation props (timing props `from`, `to`, `outAt` still
apply). To make coded motion editable, remove the TSX preset props instead.

| Preset | Motion | Unit |
| --- | --- | --- |
| `none` | Plain linear reveal | block |
| `static` | Fully still | block |
| `fade` | Opacity fade | block |
| `fade-up` | Fades in while rising | block |
| `blur-in` | Sharpens out of a blur | block |
| `slide` | Slides in from the left | block |
| `mask-reveal` | Wipes on left to right | block |
| `fade-scale` | Grows or settles to size, optional shine | block |
| `twist-scale` | Perspective card turn to rest | block |
| `scatter-scale` | Every character flies in from the camera | char |
| `tracking` | Letters spread and sharpen into place | char |
| `slam` | Drops in oversized, lands with a soft snap | block |
| `dolly` | Words pull forward out of the deep | word |
| `chromatic` | Colour-split echoes converge | block |
| `line-stretch` | A glowing line stretches open into text | block |
| `highlight-wipe` | An accent block sweeps each word in | word |
| `rise-mask` | Words rise through a baseline mask | word |
| `word-cycle` | Words take the stage one at a time | word |
| `ribbon` | Words turn in like a ribbon settling | word |
| `stand-up` | Words tip upright from lying flat | word |
| `spring-pop` | Pops up on a damped spring | word |
| `spotlight` | A walking emphasis lights each word | word |
| `underline-draw` | Underline draws, then text rises | block |
| `orbit` | Letters sweep in along an arc | char |
| `weight-build` | Thickens from hairline to full weight | block |
| `develop` | Letters sharpen in random order | char |
| `flip-cascade` | Letters flip up from face-down | char |
| `converge` | Letters streak in from both edges | char |
| `glint-wipe` | Wipes on behind a bright glint | block |
| `vapor` | Condenses out of drifting vapour (a good out) | char |

"Unit" is the default granularity; `stagger` or `delivery` overrides it. Default
delays: char 35 ms, word 90, paragraph 160, group 260. Per-character units ignore line
breaks, so on multi-line copy prefer `by-paragraph`.

## Measuring text

Size a pill, underline or panel to a headline from its font, not from a captured frame.
`useTextMetrics(textKey, text, opts)` takes the props the headline gets (`fontSize`,
`face`, `fontRef`, `lineHeight`, `letterSpacing`) and applies the same sidecar
`<key>Font`, `<key>Size` and `<key>LineHeight` overrides, so the box follows inspector
edits. It returns world units, `{ width, height, ascent, descent, lines }`: `ascent`
runs from the block top to the first baseline, `descent` from the last baseline to the
bottom. Null means the font is still loading (one preview frame); exports and captures
wait for it.

```tsx
const title = useSceneText("title", "Ship faster");
const box = useTextMetrics("title", title, { fontSize: 0.5 });
// ...
{box && <Pill width={box.width + 0.5} height={box.height + 0.2} position={[0, 0, -0.01]} />}
<AnimatedHeadline text={title} textKey="title" fontSize={0.5} />
```

Under a middle-anchored single line the baseline is at `y = box.height / 2 - box.ascent`,
so an underline sits a little below that. `measureText(text, { font, fontSize, letterSpacing?, lineHeight? })` is
the plain version (`font` is a theme `FontRef` or `"Family@weight"`). Explicit `\n`
breaks count; `maxWidth` wrapping is not measured.

## Text looks (`textLook`)

```json
"textLook": { "preset": "gradient", "colorA": "#7cd6ff", "colorB": "#2b6bff", "angleDeg": 90 }
```

| Look | Style | Params |
| --- | --- | --- |
| `none` | Plain theme fill | |
| `gradient` | Two-stop fill | `colorA`, `colorB` (default darkened A), `angleDeg` (90 vertical, A on top) |
| `outline` | Stroke per glyph | `colorA`, `strokeEm` (0.035, max 0.2), `hollow` (true hides the fill) |
| `neon` | Glow halo | `colorA`, `intensity` 0..1 (0.6) |
| `offset-print` | Tinted under-layer offset down-right | `colorA`, `offsetEm` (0.06) |
| `highlight-block` | Accent block behind each word | `colorA` |
| `frosted` | Soft glass read with a faint shine | `intensity` |
| `arc` | Baseline bent on an arc | `curveDeg` (60, positive arcs up) |
| `glass-3d` | Extruded transmission glass | `colorA` tint, `intensity` |
| `chrome-3d` | Extruded mirror metal | `colorA` tint |

Absent `colorA` uses the theme accent. Same resolution as motion: TSX `look` props >
sidecar `textLookOverrides.<key>` or `textLook` > theme; `textLookForce` flips it.
3D looks render extruded geometry lit by the scene, in bundled families only; text
with emoji drops the look.

## Emoji and symbols

Emoji work in AnimatedHeadline and AnimatedCounter text (cached as images under
`assets/.emoji-cache/`, which the app owns). Symbols like arrows, ticks and stars
render as glyphs in the text colour. No emoji in ExtrudedText, 3D looks or chart labels.

## Fonts

Font strings are `"Family"` (weight 400) or `"Family@weight"`. Set them in the theme,
`project.json` `typography`, `textStyle.<key>Font`, `chart.font` or a frame text
decoration's `font`.

Bundled families are always safe (`kb fonts safe`):

| Family | Weights |
| --- | --- |
| Inter | 400, 600 |
| Space Grotesk | 400, 600 |
| Open Sans | 400, 600 |
| JetBrains Mono | 400 |
| Playfair Display | 600 |
| Lora | 400 |
| Barlow Condensed | 600 |
| Nunito | 600 |
| Cormorant Garamond | 600 |
| Libre Franklin | 600 |

A bundled family snaps to its nearest weight (ties go lighter): `Inter@700` renders 600.

Any other family installed in Font Book can work. The first use copies the exact face
into `~/Kookaburra Cut/fonts/` so exports never follow a macOS update, and the app vets
it with the text engine's own parser. A face that still fails (SF Mono and LastResort
do) falls back to the theme face of the nearest weight (else Inter) with a warning
banner and a font issue in `kb status`: the text renders, just not in your font. So:

1. Prefer bundled families.
2. Before writing any other family: `kb fonts check "Family@weight"`. It runs the real
   parser when the app is open and pins the face on success. `kb fonts list` shows
   installed families and their weights.
3. Name a weight the family has. Futura has no 400 (Medium 500, Bold 700): write
   `Futura@500` or `Futura@700`.
4. After using one, `kb check --app` and capture a frame with that text to confirm it is
   your font and not the fallback.
