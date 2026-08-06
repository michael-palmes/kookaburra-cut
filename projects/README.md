# Projects (projects)

Each subfolder here is one **project**: the file-based project format, which is
human-readable, diffable, and portable.

```
<project-name>/
  project.json     # manifest: scene order, durations, themeId, formats
  template.json    # OPTIONAL: declares this project a picker template
  scenes/       # one .tsx per scene, each a `defineScene` default export
  assets/       # images / clips / models, referenced by relative path
```

## What ships from here

This tree is bundled into the app (`bundle.resources` in
`src-tauri/tauri.conf.json` maps `../projects` to `Resources/projects`), so
everything in it reaches customers:

| Folder | Why it ships |
| ------ | ------------ |
| `blank/`, and every folder with a `template.json` | The New project picker creates from them |
| `showcase-tour/` | The shipped demo, the rolling gate project and the packaged-parity project |
| `preview-lab-theme/` | The theme-preview fixture: every user theme's previews render from it at runtime. Its scene bytes are FROZEN, a content change invalidates all 40 committed previews in `src/assets/theme-previews/` |
| `_samples/` | The shared sample media pool. `create_project` seeds these into every new project's `assets/`, so a template references them by name and ships no copy |

Dev-only projects (the gate spikes and the `preview-lab-*` option-preview
fixtures) live in the sibling [`fixtures/`](../fixtures) tree instead. They load
by the same bare id in dev and are never bundled.

A **template** is any folder here carrying a `template.json`. That file is the
only discriminator: no allowlist, and `create_project` refuses an id without one.

## project.json

| Field      | Meaning                                              |
| ---------- | ---------------------------------------------------- |
| `id`       | Stable project id                                       |
| `name`     | Human-readable title                                 |
| `themeId`  | Theme token set to apply (see `src/theme/tokens.ts`) |
| `formats`  | Aspects this project targets, e.g. `["16:9", "9:16", "1:1"]` |
| `scenes`   | Ordered list of `{ file, durationMs, transition? }`  |

A scene may carry an optional `transition` into it from the previous scene:
`{ type: "crossfade" | "dip" | "slide" | "wipe", durationMs, direction? }`
(`direction` is a `[x, y]` unit vector for `slide` / `wipe`). The overlap pulls
the next scene's start back, see [`docs/determinism.md`](../docs/determinism.md).

## Scenes

A scene is a `.tsx` file that default-exports `defineScene({ id, durationMs, Scene })`.
Author with toolkit primitives only, see
`.claude/skills/kookaburra-scene-authoring/SKILL.md` and `/new-scene`.

`showcase-tour/` is the worked example.
