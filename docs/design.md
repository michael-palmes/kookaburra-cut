# Design

Design language and build direction for **Kookaburra Cut**: the macOS application chrome.
Audience for this file: AI coding tooling (Claude Code, Cursor, Copilot) and any human collaborator.
Treat it as the source of truth for the editor interface. When a request conflicts with this file,
surface the conflict rather than quietly overriding it.

## 0. Scope & status

This document specifies **Kookaburra Cut's application chrome only**, the editor interface that
frames the work: the preview stage, timeline, scene list, inspector, transport, dialogs and menus.

It deliberately does **not** specify the look of the *rendered video*. The colours, type, motion and
gradients of exported frames are a separate, brandable, per-project concern that lives in the project's
theme and is read through `useTheme()` (see §14). **Rule of thumb: if a colour can appear
in an exported frame, it belongs in `theme/tokens.ts`, not in this file.**

- **Tech source of truth:** [architecture.md](./architecture.md). The app is **Tauri 2** (Rust core + WKWebView
  shell) + **React 19** + **TypeScript** + **Vite** + **Three.js / react-three-fiber** (one unified
  WebGL canvas) + **troika-three-text** + **anime.js v4** + an **ffmpeg sidecar** + **zustand**.
- **Vocabulary** is shared with `architecture.md`: *project* (a project folder, the user-facing
  noun and the code symbol), *scene* (a `defineScene` `.tsx` module),
  *toolkit* (the shipped scene primitives), *FormatContext* (the multi-aspect / safe-area system).
- **Theme:** dark only. There is **no light mode and no theme toggle**. Every value derives from the
  tokens in §4–§5 and the appendix in §15.

---

## 1. Thesis

**Kookaburra Cut's interface is a quiet studio after dark.** The preview is the light; everything
else stays out of the way. The preview canvas is the only saturated, colourful thing on screen; the
chrome around it is a calm, near-monochrome instrument panel in blue-black nocturnal charcoal,
like a colourist's suite at night. The chrome should recede so the work can be judged honestly.

One-line description: *A neutral, dense, single-accent instrument panel for a local video studio:
the preview is the light, the chrome is the night studio.*

We borrow the visual grammar of professional non-linear editors, **Final Cut Pro, DaVinci Resolve,
Cavalry**: dark, neutral, professional, content-first, one restrained accent. The **kookaburra**
(moonlit blue-grey wing over night charcoal) is the *palette source*, never a decorative motif in
the editor. No bird drawings on working surfaces, no outback kitsch: just the colour story.
(Threshold illustrations at first-run/About are the one sanctioned exception, per voice.md.)

The hard rule: **neutral chrome, colourful content.** The greys carry all structure; the single
accent marks only what is active, selected, or the primary action. Restraint is the house style.
The blue lean is atmosphere, not identity: **the interface must not look blue at a glance.**

---

## 2. Design principles

1. **The preview is the light.** Chrome never out-saturates content. The brightest non-content pixel
   on screen is the accent, used sparingly. When in doubt, make the chrome quieter: the room stays
   dark so the screen can glow. (No literal glow: the hierarchy is carried by the recessed matte
   staying darkest and the chrome staying quiet, §4.1.)
2. **Neutral by default, accent on intent.** Greys carry structure and grouping; the single accent
   marks the active / selected / interactive-primary state only, never decoration.
3. **Dense without clutter.** This is a pro tool: a 13px base, tight rows, honest information
   density, but generous hit targets (§11) and clear grouping so it never feels cramped.
4. **Native-leaning, honestly emulated.** Embrace macOS metaphors (SF Pro, vibrancy, traffic lights,
   focus rings) while being honest that WKWebView is CSS *approximating* native (§13). Where a real
   native effect isn't available, fall back to a flat surface, never fake it.
5. **Deterministic and legible.** Timecode and numerics are tabular and monospaced; values never
   reflow, jitter, or animate while scrubbing. The interface mirrors the renderer's determinism.
6. **Quiet motion.** Motion clarifies a state change; it never entertains. Everything respects
   `prefers-reduced-motion` (§9). This is a quality-floor requirement, not a nicety.

---

## 3. Anti-patterns (hard constraints)

These are hard constraints, not suggestions. Re-read them before generating any UI.

1. **No glassmorphism or neon on chrome.** Frosted blur is reserved for *genuine* macOS material
   surfaces (menus, popovers, the left rail; §13), never slapped on panels for decoration.
2. **No gradients in chrome.** Flat opaque surfaces only. The accent is one colour, not a gradient.
   No multi-stop washes, no "AI" gradient meshes, no moonlit gradients or atmospheric overlays:
   the night studio is flat surfaces, not a skybox.
3. **The accent never competes with the preview.** No large accent fills, no accent-coloured panels,
   no accent backgrounds behind content. The accent is a thin marker, a small fill, or text.
4. **No pure black (`#000`) or pure white (`#fff`) as base UI colours.** Near-black and off-white
   only; pure black crushes against the preview's own blacks and reads as dead pixels.
5. **No decorative drop shadows.** Elevation is communicated by surface lightness + a 1px border
   (§6.3). Only genuinely floating surfaces (popovers, dialogs) get one tight, crisp shadow.
6. **No coloured full-panel semantic washes.** Danger / success / warning appear as text, icon,
   border, or a small fill, never a full-panel background colour.
7. **No animated glow, shimmer, pulse, or "AI sparkle."** This is an instrument. Export progress is
   **real frame progress** (§8.7); an indeterminate shimmer bar is forbidden: the render is
   deterministic, so the percentage is always known.
8. **Don't fight macOS overlay scrollbars.** Thin and lightly tint them; never force always-visible
   custom bars that override the OS setting.
9. **No icon-only buttons without tooltips** in dense toolbars.
10. **No more than one accent.** Dusty wing blue is the accent (§4.4); there is no alternate accent
    set. Semantic colours (§4.5) are states, never accents.
11. **Never tint or filter the WebGL preview stage.** No vibrancy, `backdrop-filter`, blend mode, or
    CSS filter touches the canvas: colour fidelity in the preview is a product requirement (§13).
12. **No emoji or playful illustration in chrome.** Threshold surfaces (first-run, About) may carry
    the sanctioned editorial silhouette per voice.md; working screens get restrained line art at
    most. Body text is never centred or set in full-width marketing columns. This is a panelled tool.
13. **No bird motif on working surfaces.** The kookaburra appears at thresholds only, never as
    watermarks, dividers, patterns or repeated iconography in the editor.

---

## 4. Colour system

One dark theme: **blue-black nocturnal charcoal**. The neutral scale leans subtly blue (roughly
double the old slate lean, still charcoal at a glance) so the room reads as night; text is a
slightly warm "moonlit" off-white so type sits forward from the cool surfaces; the single dusty
wing blue accent is muted enough to feel professional and distinct enough to mark intent.
Implement as CSS custom properties on `:root` (see §15 for the full block).

### 4.1 Surface / background layers

Six opaque tiers. Depth is communicated by lightness + a 1px border, **not** by shadow.

| Token | Hex | Role |
|---|---|---|
| `--surface-window` | `#0D1016` | App window base / deepest backdrop (deep blue-charcoal) |
| `--surface-panel` | `#15181F` | Default panel background (scene list, inspector), night grey |
| `--surface-panel-alt` | `#1A1E26` | Striped/alternate rows, secondary panels |
| `--surface-recessed` | `#090B10` | Recessed wells: timeline tracks, preview matte, input troughs (ink-blue black) |
| `--surface-raised` | `#1F242C` | Raised controls: buttons, segmented controls, cards at rest (blue graphite) |
| `--surface-elevated` | `#232833` | Floating surfaces: popovers, menus, dialogs |
| `--surface-overlay` | `rgba(6,8,13,0.62)` | Scrim behind modal dialogs |
| `--surface-hover` | `rgba(255,255,255,0.05)` | Generic hover wash over any surface |
| `--surface-active` | `rgba(255,255,255,0.09)` | Pressed/active wash |

The **recessed** tier is *darker* than the window, so timeline tracks, input troughs and the
**preview matte stay the darkest thing on screen**: the stage is the light source, conceptually,
with no literal glow; the **elevated** tier is the lightest, so floating surfaces read forward,
all without shadows. Floating dialogs feeling slightly brighter than anchored panels IS the
night-studio hierarchy; nothing more is needed.

### 4.2 Borders & dividers

Translucent white, so a border adapts to whichever surface tier it sits on (critical with six tiers).

| Token | Value | Role |
|---|---|---|
| `--border-subtle` | `rgba(255,255,255,0.06)` | Hairline dividers between rows, internal separators |
| `--border-default` | `rgba(255,255,255,0.10)` | Panel edges, control outlines, card borders |
| `--border-strong` | `rgba(255,255,255,0.16)` | Emphasised separators, input borders |
| `--border-window` | `#000000` | 1px outer window line / panel-split lines that read against the desktop |

### 4.3 Text roles

Slightly **warm** against the cool surfaces ("moonlit white"), which lifts type forward without
extra weight. Contrast ratios are measured against `--surface-panel` (`#15181F`).

| Token | Hex | Role | Contrast | AA |
|---|---|---|---|---|
| `--text-primary` | `#F0EFEB` | Primary text, values, active labels | ~15.4:1 | AAA |
| `--text-secondary` | `#ACAFB1` | Labels, secondary info, inactive tabs | ~8.1:1 | AA (clears AAA) |
| `--text-tertiary` | `#6B737D` | Hints, units, placeholder, ruler ticks | ~3.7:1 | UI/non-essential only |
| `--text-disabled` | `#474D58` | Disabled controls | ~2.1:1 | Decorative only |
| `--text-on-accent` | `#0B1014` | Text/icon on a filled accent surface | n/a | see §4.6 |

`--text-tertiary` sits right at the UI-component threshold; use it for non-essential metadata (units,
tick numbers), **never** for primary actions or running labels you need read. `--text-disabled` is
decorative: disabled controls must also change shape or opacity, never rely on colour alone.

### 4.4 Accent: dusty wing blue

A single accent, drawn from the kookaburra's wing. Muted enough to sit naturally in the night
chrome, distinct enough to mark selection and intent, and never neon. There is **no alternate
accent**: the buff-gold and sea-blue sets retired with the previous identity.

| Token | Hex | Role |
|---|---|---|
| `--accent` | `#6F93A8` | Primary accent: active/selected, primary fill, playhead |
| `--accent-hover` | `#82A7BB` | Hover state of accent surfaces |
| `--accent-pressed` | `#5D8296` | Pressed/active (lifted from the brief's `#587C91` for AA; §4.6) |
| `--accent-subtle` | `rgba(111,147,168,0.15)` | Subtle fill: selected-row background, active-tab underlay |
| `--accent-border` | `rgba(111,147,168,0.48)` | Accent outline / selected-block frame |
| `--accent-text` | `#9EBFD0` | Accent used **as text** (links, active labels); lightened for contrast |

### 4.5 Semantic colours

Muted for dark; never candy.

| Token | Hex | Role |
|---|---|---|
| `--focus-ring` | `#4C9FEF` | Keyboard focus ring: bright saturated blue, **independent of the accent** |
| `--selection` | `rgba(76,159,239,0.30)` | Text selection / multi-select range |
| `--danger` | `#E5654B` | Destructive intent (text/icon/border); text variant `#F07A62` for AA |
| `--danger-fill` | `#C8472F` | Destructive button fill (with near-black text) |
| `--success` | `#5FB87A` | Export complete / valid; text variant `#7AC994` |
| `--warning` | `#D98C2B` | Non-blocking warnings: amber, clear of both the accent and danger |
| `--info` | `#4C9FEF` | Neutral info (shares the focus blue) |

The accent is now a blue, so the focus ring earns its keep through **brightness and saturation**,
not hue: `#4C9FEF` is vivid and unmistakably "macOS focus" where `#6F93A8` is dusty and quiet. The
ring stays fixed and independent so focus is never confused with selection, and matches the macOS
expectation.

### 4.6 Contrast rules (non-negotiable)

- Body/UI text: `--text-primary` (~15.4:1) and `--text-secondary` (~8.1:1) clear WCAG AA. Keep it so
  if you re-tune values.
- **Accent as text uses `--accent-text`** (`#9EBFD0` ≈ 9.2:1 on panel), never the base `--accent`.
- **Accent as fill** pairs with `--text-on-accent` (`#0B1014`): ≈ 5.8:1 on `--accent`, ≈ 7.5:1 on
  hover, ≈ 4.6:1 on pressed, all AA. (The brief's pressed `#587C91` measured 4.29:1 and was lifted
  to `#5D8296`; keep the pairing AA if you re-tune.)
- `--focus-ring` (`#4C9FEF`) maintains ≥3:1 against every surface tier (measured 5.3–7.0:1).
- `--text-tertiary` / `--text-disabled` are non-essential / decorative; never the sole carrier of
  meaning, never running text.

---

## 5. Typography

Native-leaning: the system font does the work. No bundled UI face, no display face.

### 5.1 Stack

```css
--font-ui: -apple-system, "SF Pro Text", "SF Pro Display", system-ui, sans-serif;
--font-mono: ui-monospace, "SF Mono", "SFMono-Regular", Menlo, monospace;
```

`-apple-system` resolves to SF Pro on macOS and auto-switches Text/Display optical sizes by size:
let the OS do it. Crisp on Retina, zero load, unmistakably a Mac app.

### 5.2 Type scale (13px base, desktop-dense)

| Token | px / line-height | Weight | Use |
|---|---|---|---|
| `--text-2xs` | 10 / 14 | 510 | Ruler tick labels, dense badges |
| `--text-xs` | 11 / 16 | 510 | Inspector unit suffixes, secondary metadata |
| `--text-sm` | 12 / 16 | 510 | Secondary labels, tab labels |
| `--text-base` | 13 / 18 | 510 | **Default UI text, inputs, menu items** |
| `--text-md` | 14 / 20 | 590 | Panel / section headers |
| `--text-lg` | 16 / 22 | 590 | Dialog titles |
| `--text-xl` | 20 / 26 | 620 | Empty-state / first-run headings |
| `--text-display` | 28 / 34 | 680 | About / first-run hero **only** |

Weights are SF numeric axes (510 ≈ a touch above Regular for crispness on dark; 590 ≈ Semibold). If
not using a variable axis, map to 510→Regular/Medium, 590→Semibold, 620/680→Bold. On dark, the
slightly heavier weight plus the off-white `--text-primary` prevents "thin grey on black" smear.

### 5.3 Numerics & timecode

```css
font-variant-numeric: tabular-nums;
```

Apply `tabular-nums` to **all** numeric inspector fields and any value that changes live. Timecode
(`HH:MM:SS:FF`) uses `--font-mono` so digit columns never jitter while scrubbing. Define a `.timecode`
utility: mono, tabular, `--text-sm`, `letter-spacing: 0`.

### 5.4 No display face (explicit decision)

A bespoke display face buys almost nothing in a tool whose hero is the video preview, and it adds a
load/licence variable. **Stay pure system.** The only brand moments (the About panel and the
first-run splash) use the Kookaburra Cut **wordmark as a one-off SVG asset**,
not a loaded text face. Record this so it doesn't get relitigated.

---

## 6. Layout & window structure

### 6.1 Window anatomy

*(Updated v13, the SHIPPED main-window redesign; the original aspirational NLE sketch is
superseded by the built layout below.)*

```
┌─────────────────────────────────────────────────────────┐
│ ●●●  ⌂ project name / path      [Find an action ⌘K] [⤓] │ ← custom titlebar (46px)
├────────────┬───────────────────────────────┬────────────┤
│ Claude     │   Preview stage               │ Inspector  │
│ Code rail  │   (letterboxed canvas)        │ (342px,    │
│ (collapsib │                               │  Project / │
│  le, 300px │   ◖camera pill◗  ← bottom-left│  Scene     │
│  clamp)    │                               │  tabs +    │
│            ├───────────────────────────────┤  drill-ins)│
│            │  Animation lane (collapsible) │            │
│            │  Playback bar (scene cells)   │            │
├────────────┴───────────────────────────────┴────────────┤
```

- **Titlebar (46px, §13):** folder icon-button (projects) · name-over-path identity ·
  "Find an action ⌘K" trigger · the Export CTA (the ONLY accent control).
- **Claude Code rail (left):** the embedded terminal + native scene wizards; collapsible;
  width `clamp(320px, 30vw, 460px)`.
- **Preview stage:** the light; the camera pill floats bottom-left (idle "Animate scene" ↔
  active orbit/pan/zoom controller, z-7 over the tool overlay).
- **Timeline dock (bottom):** the collapsible animation lane (camera keys/segments; open =
  animation mode) above the segmented per-scene playback bar; an SVG connector ties the lane
  to the active scene's cell.
- **Inspector (right, 342px):** Project / Scene tabs; rows open full-height drill-ins with
  a prominent back bar; the Scene tab follows the playhead.

The preview stage stays centred and aspect-correct as rails resize.

### 6.2 Spacing, radii, grid

```css
--space-0: 0;  --space-1: 2px; --space-2: 4px;  --space-3: 6px;
--space-4: 8px; --space-5: 12px; --space-6: 16px; --space-7: 24px; --space-8: 32px;
--radius-xs: 3px;   /* inputs, small buttons */
--radius-sm: 5px;   /* cards, segmented controls */
--radius-md: 8px;   /* popovers, panels */
--radius-lg: 12px;  /* dialogs */
--radius-full: 999px;
```

A 4px base rhythm with a 2px sub-step for dense control internals. Tight radii (3–5px) read "pro
tool"; 8–12px is reserved for floating surfaces.

### 6.3 Elevation (shadow-light)

```css
--elev-popover: 0 8px 24px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06);
--elev-dialog:  0 16px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.08);
```

Only genuinely floating surfaces (popovers, dialogs) get a shadow: one tight, crisp shadow plus a
1px ring. Everything anchored in the layout uses surface lightness + borders for depth. No shadows on
panels, cards, or buttons at rest.

---

## 7. Editor surface inventory

Each surface and what it must specify. *(v13 note: items 1–6, 9 and 12 are SHIPPED in the
main-window redesign: titlebar, stage + camera pill, playback bar, timeline dock with the
animation lane, the Claude rail as the left column, the 342px inspector, the ⌘K palette, and
right-click context menus (theme cards, animation segments). The aspect switcher lives on the
inspector's Project tab; scene management rides the rail wizards + the playback bar's New
scene.)*

1. **Window titlebar**: traffic-light inset, draggable region, project name, global
   actions (⌘K command palette, the Export CTA). Height 46px (`--titlebar-h`); define
   no-drag interactive zones (§13).
2. **Preview stage**: the light. Letterboxed canvas centred in a recessed well (`--surface-recessed`
   matte), aspect-correct mattes, an optional title-safe / safe-area guide overlay (toggle), zoom-to-
   fit / 100% controls, a current-frame badge. No chrome over the canvas except a thin floating
   control cluster. **Never tint or filter the canvas** (§13).
3. **Transport bar**: play/pause, step frame, jump to start/end, loop, current + total timecode,
   playback rate. Keyboard map: Space, J/K/L, arrows.
4. **Timeline dock**: ruler, playhead, scene blocks/tracks, zoom slider, snap toggle. The densest
   surface (§8.1).
5. **Scene list (left rail)**: ordered scene cards: thumbnail, name, duration, drag-to-reorder,
   add/duplicate/delete (§8.6).
6. **Inspector (right rail)**: context-sensitive property groups for the selected scene/element:
   numeric fields, dropdowns, toggles, colour wells. Grouped, collapsible sections (§8.4). Colour
   wells here edit **project** tokens (§14), not chrome.
7. **Format / aspect switcher**: 16:9 / 9:16 / 1:1 segmented control + resolution; re-letterboxes
   the preview live (§8.5).
8. **Export dialog**: format (H.264 / ProRes), resolution (to 4K), aspect, destination, filename,
   determinate progress (§8.7).
9. **Command palette (⌘K)**: fuzzy command list; the natural home for the "describe your video"
   authoring entry point (§8.8).
10. **Empty / first-run state**: no project open: the wordmark, New / Open / recents, restrained
    line art (the threshold illustration is sanctioned here, per voice.md). The one display-type moment.
11. **Onboarding**: minimal: where projects live (the folder model), how authoring works.
12. **Menus & context menus**: native-style menus (right-click on a scene, on a timeline block).
13. **Toasts / notifications**: export-done (success), errors (danger); corner-anchored, auto-dismiss.
14. **Settings / preferences**: render defaults, paths, reduced-motion override, accent (if exposed).
    Standard macOS prefs-window pattern.
15. **About panel**: wordmark, version, build hash (the determinism stamp). The other display moment.

---

## 8. Component patterns

### 8.1 Timeline

- **Track background**: `--surface-recessed`, reads as cut into the panel.
- **Ruler**: top strip in `--surface-panel-alt`; major ticks `--text-tertiary`, minor ticks
  `--border-subtle`; labels `--text-2xs` tabular at major intervals; tick density adapts to zoom.
- **Playhead**: a 1px vertical line in `--accent` with a small triangular head at the ruler; above all
  blocks. This is one of the few legitimate large uses of the accent.
- **Scene blocks**: `--radius-xs`, surface `--surface-raised`, `--border-default`. **Selected** =
  `--accent-border` outline + `--accent-subtle` fill (never a full accent fill). Label `--text-sm`
  truncated; duration `--text-2xs` tabular. Resize grips appear on hover at the block edges.
- **Snapping**: a 1px `--focus-ring` snap line while dragging; snap toggle in the timeline header.
- **Multi-track** (if scenes layer): tracks separated by `--border-subtle`, alternating recessed
  shades for legibility.

### 8.2 Transport bar

- Surface `--surface-panel`, top `--border-default`.
- Icon buttons: 28px hit target, 16px glyph, `--text-secondary` at rest → `--text-primary` on hover;
  active toggles (loop, play) show `--accent`.
- Centre: large timecode (mono, tabular, `--text-md`) as `current / total`, the secondary part in
  `--text-tertiary`.
- Play/pause is the only prominence button, and it is a subtle raised fill, **not** accent-filled
  (the accent stays reserved for selection and the playhead).

### 8.3 Scrub & zoom

- **Scrub**: dragging the playhead or ruler scrubs; cursor `ew-resize`; live timecode follows. **No
  animation during scrub**: frame-accurate stepping, never eased motion.
- **Zoom**: a horizontal zoom slider in the timeline header + ⌘+ / ⌘- + pinch; zoom anchors on the
  playhead. The zoom slider is a plain neutral slider, filled portion `--text-tertiary`, not accent.

### 8.4 Inspector rows & numeric fields

- **Row**: label left (`--text-secondary`, fixed ~96px column), control right, `--border-subtle`
  divider between rows, `--space-5` vertical padding.
- **Numeric field**: `--surface-recessed` trough, `--border-default`; focus → `--border-strong` +
  focus ring; value `--text-primary` tabular; unit suffix `--text-tertiary`. **Drag-on-label
  scrubbing** (FCP/Blender style): hovering the label shows `ew-resize`, dragging adjusts the value;
  stepper arrows appear on hover only.
- **Dropdown/select**: `--surface-raised`, chevron `--text-tertiary`, opens an elevated menu.
- **Toggle/switch**: off = `--surface-raised` track; on = `--accent` track. One of the few small
  accent fills allowed.
- **Colour well**: swatch + value; opens a picker. These edit **project** tokens (§14), not chrome.
- **Section header**: collapsible, `--text-sm` semibold, disclosure triangle `--text-tertiary`.

*Implemented:* the inspector ships as `ui/inspector/`: `ActionRow` (17px icon ·
13px label · right value · ›; selection = `--accent-subtle` wash + a 2px inset accent edge, never
a full fill), collapsible `SectionHeader` (trailing controls live OUTSIDE the toggle button,
never nest interactive elements), full-height drill-ins with the accent `DrillBack` bar and a
pinned `.inspector-drill-actions` footer, and the camera orbit-pose numeric grids (fields
subscribe to the TARGET KEY id, never the playhead). Drag-on-label scrubbing remains an open
nicety, not shipped.

### 8.5 Format / aspect switcher

A three-segment control (16:9 / 9:16 / 1:1) with tiny aspect glyphs; the selected segment raises to
`--surface-raised` + `--text-primary`, others `--text-secondary`, with a sliding indicator.
Resolution (e.g. 4K) sits in an adjacent dropdown. Changing aspect re-letterboxes the preview live.

### 8.6 Scene cards / scene list

- **Card**: `--surface-raised`, `--border-default`, `--radius-sm`; thumbnail (aspect-matched), name
  (`--text-base`, inline-editable), duration (`--text-xs` tabular).
- **Selected**: `--accent-border` + `--accent-subtle` (consistent with timeline blocks).
- **Drag-to-reorder**: grip dots `--text-tertiary` on hover; dragging lifts the card to
  `--surface-elevated` + `--elev-popover`; the drop indicator is a 2px `--accent` insertion line
  between cards.
- **Add scene**: a dashed `--border-strong` "+" card at the end of the list.

### 8.7 Export dialog & progress

- **Dialog**: `--surface-elevated`, `--radius-lg`, `--elev-dialog`, scrim `--surface-overlay`.
- **Fields**: format (H.264 / ProRes segmented), resolution, aspect, destination (native file picker),
  filename.
- **Progress**: a **determinate** bar: track `--surface-recessed`, fill `--accent`; percentage +
  frame count (tabular) + ETA. An indeterminate shimmer is **forbidden** (§3): the render is
  deterministic, so report real frame progress.
- **Done**: the bar/check turns `--success`; offer "Reveal in Finder" + "Open"; raise a toast.
- **Error**: `--danger` text + retained log detail; never a bare system alert.

### 8.8 Dialogs, menus, popovers, command palette

- **Menus/popovers**: `--surface-elevated`, `--elev-popover`, `--radius-md`, 1px ring; items
  `--text-base`, hover `--surface-hover`, active `--accent-subtle` + `--accent-text`; separators
  `--border-subtle`; shortcut hints right-aligned in `--text-tertiary`.
- **Command palette (⌘K)**: a centred elevated panel, input at top (`--surface-recessed` trough),
  result rows, the active row `--accent-subtle` with an `--accent` left-edge marker; category labels
  `--text-tertiary`. This is the natural home for the "describe your video" authoring flow.
- These are the surfaces where genuine macOS vibrancy may be used (§13).

*Implemented:* the palette is `ui/CommandPalette.tsx` over the full command registry
(`ui/commandRegistry.ts`), reached via the NATIVE menu accelerator (Project ▸ Find an Action…,
the reliable channel over xterm) with a capture-phase DOM fallback. It mounts on
`.modal-overlay` DELIBERATELY: the transport and lane-nudge key guards key off that class
(load-bearing; see the phase doc's keyboard-arbitration table). Right-click context menus are
the reusable `ui/ContextMenu.tsx` (viewport-clamped, Esc/outside dismiss, in-menu two-step
confirms). Theme cards and animation segments use it today.

### 8.9 Drag affordances & drop targets

- **Cursors**: `grab`/`grabbing` for reorder, `ew-resize` for trims and numeric scrub, `copy` for
  asset import.
- **Drop target**: `--accent-border` dashed outline + `--accent-subtle` wash on the valid target;
  insertion lines for ordered lists.
- **Asset import** (drag a file from Finder onto the preview / scene list): a full-panel
  `--accent-subtle` wash with a centred "Drop to import" label.

---

## 9. Motion & interaction

```css
--ease-standard: cubic-bezier(0.2, 0, 0, 1);
--ease-emphasis: cubic-bezier(0.3, 0, 0, 1);
--dur-fast: 90ms;   /* hover, toggle, button */
--dur-base: 160ms;  /* menu/popover open, panel collapse */
--dur-slow: 240ms;  /* dialog in, rail-resize settle */
```

- Hovers/toggles at 90ms; menus/popovers at 160ms (scale-from-95% + fade); dialogs at 240ms.
- **No motion on the timeline/playhead during playback or scrub**: that is frame-accurate stepping,
  not animation.
- **`prefers-reduced-motion: reduce` collapses all transitions to opacity-only at `--dur-fast`** and
  disables every scale/slide. Implement this as a single global rule, not per-component. This is a
  quality-floor requirement.
- Tooltips appear after ~500ms hover-intent; menus open immediately on click.

---

## 10. Iconography

- **SF Symbols-style line icons**: 1.5px stroke, a 16px default grid (20px for transport, 14px
  inline). Use an SF-Symbols-aligned set or a tuned subset of Lucide/Phosphor matched to SF's weight.
- Resting `--text-secondary`, hover `--text-primary`, active/selected `--accent`, disabled
  `--text-disabled`.
- **Monochrome only**: no multicolour icons in chrome. Author as SVG (inherently Retina-crisp);
  never mix stroke weights within one toolbar.

---

## 11. Density & sizing

```css
--titlebar-h: 46px;
--control-h-sm: 22px;  /* inline inspector field, small button */
--control-h-md: 28px;  /* default button, select, toolbar control */
--control-h-lg: 34px;  /* primary dialog button, segmented control */
--row-h-list: 28px;    /* dense list rows */
--row-h-inspector: 30px;
--rail-w-min: 200px;   /* left/right rail minimum */
--timeline-h-min: 140px;
--hit-min: 28px;       /* minimum interactive hit target */
```

Controls read at 22–28px but always carry a ≥28px hit target: pad the click area beyond the visible
bounds for tiny controls (timeline grips, stepper arrows).

---

## 12. Accessibility (quality floor)

- **Contrast**: enforce the §4.6 table. Accent-as-text must use `--accent-text`, never the base fill.
- **Focus**: every interactive element shows the `--focus-ring` (2px) on `:focus-visible`; never
  remove an outline without a replacement. Logical tab order: rails → stage → timeline.
- **Colour is never the sole signal**: selected/active states pair the accent with a shape change
  (border, marker, fill); danger/success pair colour with an icon. Survives colour-blindness.
- **Keyboard**: full transport + timeline map; ⌘K reachable; dialogs trap focus and restore it on
  close; Esc closes popovers/dialogs.
- **Reduced motion**: §9, respected everywhere.
- **Hit targets**: §11, ≥28px.
- **Screen reader**: label icon-only buttons (`aria-label`); announce export progress via a polite
  live region; mark the preview canvas region.
- **Definition of done per screen**: AA contrast holds; focus is visible; reduced-motion respected;
  no accent fill competing with content; and (borrowing the old discipline) **remove one decoration
  before shipping.** If a screen reads as generic chrome that distracts from the preview, quiet it.

---

## 13. macOS / Tauri implementation notes

Kookaburra Cut is a Tauri 2 app in WKWebView: the UI is web tech *approximating* native. Be honest
about where the seam is.

- **Custom titlebar + traffic lights.** Hide the native titlebar (`decorations: false` or
  `titleBarStyle: Overlay`) and inset the content. Position the traffic lights via Tauri's
  `trafficLightPosition`, not CSS fakes; reserve a no-drag safe zone (~78×28px, top-left) so titlebar
  controls don't overlap them.
- **Draggable region.** `-webkit-app-region: drag` on the titlebar background; `-webkit-app-region:
  no-drag` on *every* interactive child (buttons, the project-name input, ⌘K/export). Forgetting no-drag
  is the classic "can't click my own buttons" bug.
- **Vibrancy is a native window effect, not CSS.** `backdrop-filter` blurs *page* content, not the
  desktop behind the window. For real macOS material, apply window vibrancy natively (the
  `window-vibrancy` crate / `NSVisualEffectMaterial`, e.g. `.sidebar`, `.menu`, `.popover`) and make
  the corresponding CSS surfaces semi-transparent so the material shows through. **Allowed scope: the
  left rail + menus/popovers only.** The preview stage and timeline stay fully opaque.
- **Never fake frost on chrome.** Where native material isn't applied, use the flat opaque surface
  tiers (§4.1): do not approximate vibrancy with `backdrop-filter` over panels (§3).
- **Scrollbars.** Keep macOS overlay scrollbars; only thin/tint lightly (`::-webkit-scrollbar` ~10px,
  thumb `rgba(255,255,255,0.18)`, transparent track). Never force always-visible custom bars.
- **Focus rings.** Use `:focus-visible` so rings appear for keyboard, not mouse; keep the macOS blue.
- **Retina / 2x.** Prefer SVG (resolution-independent). For unavoidable raster, ship @1x + @2x. Snap
  1px borders to physical pixels (use `0.5px` hairlines on 2x or the translucent-border trick).
- **Monospaced numerals.** Timecode and any live-changing value use `--font-mono` + `tabular-nums`
  (§5.3): never proportional digits where a value updates, to avoid jitter.
- **The preview is untouchable.** No vibrancy, `backdrop-filter`, blend mode, or CSS filter ever
  touches the WebGL canvas: colour fidelity in the preview is a product requirement, and the render
  is deterministic.
- **Native paint seams follow the tokens.** `tauri.conf.json` `backgroundColor`, the `index.html` /
  `settings.html` pre-paint guards and the Rust `deflash_webview` colour all hardcode
  `--surface-window`: update all four together whenever that token changes.

---

## 14. Video-output tokens live elsewhere

> The tokens in this document style **Kookaburra Cut's application chrome only.** The colours, type, and
> motion of the **rendered video** are a separate, per-project concern and live in the project's
> theme, read through `useTheme()`. Those tokens are brandable, swap per project, and
> feed the Three.js / troika / anime.js render path; they are explicitly **out of scope here.**
>
> Rule of thumb: **if a colour can appear in an exported frame, it belongs in `theme/tokens.ts`, not
> in this file.** The app's accent (dusty blue) must never leak into rendered output, and a
> project's brand colours must never restyle the chrome. Colour wells in the inspector edit
> *project* tokens; everything else in this document edits chrome.

---

## 15. Token reference appendix

The single source of truth. This `:root` block mirrors `src/styles.css`; the document body
references tokens by name and introduces no ad-hoc hex outside it. There is one accent set (dusty
wing blue) and no alternate.

```css
:root {
  /* ── Surfaces (§4.1) ───────────────────────────────────────── */
  --surface-window:    #0D1016;
  --surface-panel:     #15181F;
  --surface-panel-alt: #1A1E26;
  --surface-recessed:  #090B10;
  --surface-raised:    #1F242C;
  --surface-elevated:  #232833;
  --surface-overlay:   rgba(6,8,13,0.62);
  --surface-hover:     rgba(255,255,255,0.05);
  --surface-active:    rgba(255,255,255,0.09);

  /* ── Borders (§4.2) ────────────────────────────────────────── */
  --border-subtle:  rgba(255,255,255,0.06);
  --border-default: rgba(255,255,255,0.10);
  --border-strong:  rgba(255,255,255,0.16);
  --border-window:  #000000;

  /* ── Text (§4.3) ───────────────────────────────────────────── */
  --text-primary:   #F0EFEB;
  --text-secondary: #ACAFB1;
  --text-tertiary:  #6B737D;
  --text-disabled:  #474D58;
  --text-on-accent: #0B1014;

  /* ── Accent: dusty wing blue (§4.4) ────────────────────────── */
  --accent:         #6F93A8;
  --accent-hover:   #82A7BB;
  --accent-pressed: #5D8296;
  --accent-subtle:  rgba(111,147,168,0.15);
  --accent-border:  rgba(111,147,168,0.48);
  --accent-text:    #9EBFD0;

  /* ── Semantics (§4.5) ──────────────────────────────────────── */
  --focus-ring:  #4C9FEF;
  --selection:   rgba(76,159,239,0.30);
  --danger:      #E5654B;
  --danger-fill: #C8472F;
  --success:     #5FB87A;
  --warning:     #D98C2B;
  --info:        #4C9FEF;

  /* ── Typography (§5) ───────────────────────────────────────── */
  --font-ui:   -apple-system, "SF Pro Text", "SF Pro Display", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "SFMono-Regular", Menlo, monospace;
  --text-2xs:     10px; --lh-2xs:     14px;
  --text-xs:      11px; --lh-xs:      16px;
  --text-sm:      12px; --lh-sm:      16px;
  --text-base:    13px; --lh-base:    18px;
  --text-md:      14px; --lh-md:      20px;
  --text-lg:      16px; --lh-lg:      22px;
  --text-xl:      20px; --lh-xl:      26px;
  --text-display: 28px; --lh-display: 34px;

  /* ── Spacing / radii (§6.2) ────────────────────────────────── */
  --space-1: 2px; --space-2: 4px;  --space-3: 6px;
  --space-4: 8px; --space-5: 12px; --space-6: 16px; --space-7: 24px; --space-8: 32px;
  --radius-xs: 3px; --radius-sm: 5px; --radius-md: 8px; --radius-lg: 12px; --radius-full: 999px;

  /* ── Elevation (§6.3) ──────────────────────────────────────── */
  --elev-popover: 0 8px 24px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06);
  --elev-dialog:  0 16px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.08);

  /* ── Motion (§9) ───────────────────────────────────────────── */
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ease-emphasis: cubic-bezier(0.3, 0, 0, 1);
  --dur-fast: 90ms; --dur-base: 160ms; --dur-slow: 240ms;

  /* ── Density / sizing (§11) ────────────────────────────────── */
  --control-h-sm: 22px; --control-h-md: 28px; --control-h-lg: 34px;
  --row-h-list: 28px;   --hit-min: 28px;      --titlebar-h: 46px;
}

@media (prefers-reduced-motion: reduce) {
  :root { --dur-base: 90ms; --dur-slow: 90ms; }
  /* plus: disable scale/slide transforms globally; transition opacity only */
}
```
