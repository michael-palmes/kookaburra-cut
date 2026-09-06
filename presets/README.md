# Scene presets (presets)

Each subfolder here is one **preset**: a single reusable scene, wrapped in a
single-scene project folder so the whole project pipeline (loading, editing,
capture, the verify tooling) works on it unchanged.

```
<preset-name>/
  project.json     # manifest with exactly ONE scene entry; themeId = a bundled theme
  preset.json      # the manifest that marks the folder a preset
  scenes/<stem>.tsx
  scenes/<stem>.json
  assets/          # OPTIONAL: media this scene references
```

## What ships from here

This tree is bundled into the app (`bundle.resources` in
`src-tauri/tauri.conf.json` maps `../presets` to `Resources/presets`), so
everything in it reaches customers. A folder is a preset iff it carries a
`preset.json`: that file is the only discriminator, exactly as `template.json`
marks a template under [`projects/`](../projects).

User presets mirror the same shape at `~/Kookaburra Cut/presets/<slug>/`, saved
from a scene in the app ("Save as preset") or duplicated from a bundled preset.
Open a preset from Welcome to edit it. Presets stay single-scene documents; reuse
adopts the destination project settings while preserving scene overrides and
media. See [Editable content library](../docs/content-library.md).

## preset.json

| Field      | Meaning                                                            |
| ---------- | ------------------------------------------------------------------ |
| `version`  | Manifest schema version (1)                                        |
| `name`     | Card title                                                         |
| `tagline`  | One line under the title                                           |
| `category` | `starters`, `openers`, `features`, `stats-charts`, `devices` or `closers`      |
| `tags`     | Free-text search terms                                             |
| `order`    | Within-category sort; ties break on name                           |
| `status`   | `stable` or `beta`                                                 |
| `preview`  | The card still's capture point: `{ scene, atMs?, aspect?, sceneFile? }` or a scene index |
| `source`   | Reserved: `bundled` here, `user` in the workspace, `pack` from a pack |

Everything else a card shows (scene count, length, aspects, theme) derives from
the sibling `project.json`, so it can never drift. The schema and the catalogue
live in `src/engine/presets.ts`.

## Authoring

Preset scenes obey the scene-authoring rules with extra force, because a preset
must restyle correctly the moment it is inserted into someone else's project:
colours, type and motion only through `useTheme()`, layout against
`useFormat()`, user-visible strings in the sidecar, assets project-relative.
Author with the `kookaburra-scene-authoring` skill.

Card art starts as a committed JPEG in `src/assets/preset-previews/`. Editing a
preset refreshes its authoritative `poster.png` through the background render
window at the saved preview frame and aspect (16:9 for older entries). Both
galleries use that poster when present and otherwise use the committed JPEG.
A preset without either uses a swatch.

```bash
pnpm kookaburra:run --action preset-previews                    # every bundled preset
pnpm kookaburra:run --action preset-previews --project hero-device,closing-cta
```

Each run captures the ONE frame `preview` names, promotes it to
`src/assets/preset-previews/<slug>.jpg` and records the preset in the staleness
ledger below.

## The bundled catalogue

Add a scene and App presets share all 21 entries. Scene starters contains the 15
original pictured options, in their existing order: Device + title, Device only,
Comparison, Title, Title + icon, App version, Layered screenshot, Chart, Video,
Image, Video window, Cutout start, Cutout end, Overlay title and Blank. Each has
its own editable scene document and local sample media.

The six additional presets remain:

| Slug | Category | What it is |
| ---- | -------- | ---------- |
| `title-opener` | openers | Headline over one supporting line |
| `feature-compare` | features | One handset under a wiping before/after divider |
| `stat-counter` | stats-charts | A big number counting to the result |
| `chart-reveal` | stats-charts | A titled column chart rising in |
| `hero-device` | devices | A handset playing a capture |
| `closing-cta` | closers | App mark, name and the call to action |

All presets carry `themeId: kookaburra-studio-white` and target every aspect. They
pin nothing theme-specific: colours come from tokens, animated backgrounds run
on `themeColors: true` (the live Theme preset) or name a theme gradient, and scene overrides stay explicit. Insertions inherit the destination theme,
so token-based styling adapts to the project.

## Preview staleness

`scripts/preset-preview-stale.mjs` keeps a content hash per bundled item in a
ledger committed beside the art: `src/assets/preset-previews/ledger.json` for
presets, `src/assets/template-previews/ledger.json` for templates. The
promotion step of each previews autorun writes the entries; in a DEV build the
library grid compares the ledger against the tree and badges any card whose art
is older than the item.

The hash covers the manifest (`preset.json` / `template.json`), `project.json`
and every scene sidecar. It deliberately does **not** cover the scene TSX: code
can change the pixels without touching any JSON, so a TSX-only edit goes
unbadged and still needs a manual re-render. An item with no committed art is
never badged either, since its card already degrades to the swatch.

```bash
node scripts/preset-preview-stale.mjs list preset        # stale slugs, comma separated
node scripts/preset-preview-stale.mjs list template
node scripts/preset-preview-stale.mjs backfill template  # one-off seed for existing art
```
