# Kookaburra Cut chrome — build conventions

This is the **application chrome** of a macOS video studio: a dark, dense, near-monochrome instrument panel with ONE buff-gold accent. Dark only — there is no light mode. Read `guidelines/design.md` (bound with this DS) before styling anything; it is the source of truth.

## Setup

No provider or wrapper is needed — components are styled by the stylesheet alone. The stylesheet sets the app's dark base on `body` (`--surface-window`, 13px SF Pro, `overflow: hidden` — **the window never scrolls; every panel manages its own overflow**). Build screens as fixed-viewport layouts: a `.app`-style grid (40px titlebar row → content → transport), panels dividing the space with 1px borders, not gaps.

## Styling idiom

Tokens + a small fixed class vocabulary. For your own layout glue use the CSS custom properties — never ad-hoc hex, never gradients, never pure `#000`/`#fff`:

- **Surfaces** (depth = lightness + 1px border, no shadows): `--surface-window` < `--surface-recessed` (wells/troughs) < `--surface-panel` < `--surface-panel-alt` < `--surface-raised` (controls) < `--surface-elevated` (popovers/dialogs); washes `--surface-hover`/`--surface-active`; scrim `--surface-overlay`.
- **Borders**: `--border-subtle` (hairlines), `--border-default` (panel/control edges), `--border-strong` (focus/emphasis).
- **Text**: `--text-primary`, `--text-secondary` (labels), `--text-tertiary` (hints/units only), `--text-disabled`, `--text-on-accent`.
- **Accent (buff-gold, on intent only)**: `--accent`, `--accent-hover`, `--accent-pressed`, `--accent-subtle` (selected fill), `--accent-border` (selected outline), `--accent-text` (accent as text — never base `--accent` as text). Selection = `--accent-border` + `--accent-subtle`, never a full accent fill.
- **Semantics**: `--focus-ring` (fixed blue, independent of accent), `--danger`, `--danger-fill`, `--success`, `--warning`, `--info`.
- **Type**: `--font-ui` / `--font-mono` (system stacks — nothing to load); sizes `--text-2xs…--text-display` with matching `--lh-*`; live numerics get `font-variant-numeric: tabular-nums`.
- **Space/shape**: `--space-1…8` (4px rhythm), `--radius-xs/sm/md/lg/full` (3–5px on controls; 8–12px only on floating surfaces); `--elev-popover`/`--elev-dialog` only on genuinely floating surfaces.
- **Motion**: `--dur-fast/base/slow` + `--ease-standard/emphasis`; motion clarifies state, never entertains.
- **Sizing**: `--control-h-sm/md/lg` (22/28/34px), `--titlebar-h`.

Class vocabulary (already styled — reuse, don't reinvent): `btn`, `btn primary` (THE one accent CTA — exactly this pair, at most one per surface), `btn btn-small`; `chip` / `chip selected` in a `chip-row`; `select`; `muted`; `modal-overlay > modal` (+ `wizard-wide`, `modal-title-row`, `modal-close`, `modal-input`, `modal-error`, `modal-hint`, `modal-actions`); `wizard-field` + `wizard-label` + `wizard-textarea`; `settings-row` (+ `-text`/`-title`/`-detail`); `rail-more > rail-menu > rail-menu-item`; `toast` (+ `toast-error`, `toast-msg`, `toast-action`, `toast-close`); `titlebar` (+ `titlebar-identity` > `titlebar-name`/`titlebar-path`, `titlebar-title`, `spacer`); `playback-bar` (+ `pb-left`/`pb-center`/`pb-right`, `play-btn`, `pb-mute`, `pb-track` > `pb-cell`, `pb-playhead`, `pb-labels` > `pb-label`, `pb-readout`, `pb-new-scene`); `stage` + `stage-frame` (the recessed preview matte).

## Where the truth lives

Read `styles.css` (imports `_ds_bundle.css` — the full chrome stylesheet with its `:root` token block) and `guidelines/design.md` (design language, anti-patterns, layout anatomy). Per-component usage: each component's docs in `components/`.

## Idiomatic example

```tsx
<div style={{ display: "grid", gridTemplateRows: "var(--titlebar-h) 1fr auto", height: "100vh", background: "var(--surface-window)", overflow: "hidden" }}>
  <Titlebar title="launch-2026" subtitle="~/Kookaburra Cut/launch-2026">
    <Button small>Media</Button>
    <Button small primary>Export</Button>
  </Titlebar>
  <div className="stage">
    <div className="stage-frame" style={{ background: "#000" }}>{/* preview */}</div>
  </div>
  <PlaybackBar
    scenes={[
      { name: "Opening", durationMs: 2400 },
      { name: "Device", durationMs: 3100 },
    ]}
    activeIndex={0}
    fraction={0.29}
    readout="00:02.4 / 00:05.5"
  />
</div>
```

Hard rules from the spec: neutral chrome, accent on intent only; no gradients, glassmorphism, glow or shimmer; no decorative shadows; danger/success as text/border/small fill, never full-panel washes; every live-updating number is mono + tabular; respect `prefers-reduced-motion`.
