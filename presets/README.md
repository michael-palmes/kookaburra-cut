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

## preset.json

| Field      | Meaning                                                            |
| ---------- | ------------------------------------------------------------------ |
| `version`  | Manifest schema version (1)                                        |
| `name`     | Card title                                                         |
| `tagline`  | One line under the title                                           |
| `category` | `openers`, `features`, `stats-charts`, `devices` or `closers`      |
| `tags`     | Free-text search terms                                             |
| `order`    | Within-category sort; ties break on name                           |
| `status`   | `stable` or `beta`                                                 |
| `preview`  | The card still's capture point: `{ scene, atMs? }` or a scene index |
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

Card art is one committed JPEG per preset in `src/assets/preset-previews/`,
rendered by the preset-previews autorun. A preset with no still degrades to the
swatch card rather than failing the build.
