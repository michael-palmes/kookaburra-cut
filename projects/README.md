# Projects (projects)

Each subfolder here is one **project** — the file-based project format. It is
human-readable, diffable, and portable.

```
<project-name>/
  project.json     # manifest: scene order, durations, themeId, formats
  scenes/       # one .tsx per scene, each a `defineScene` default export
  assets/       # images / clips / models, referenced by relative path
```

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
the next scene's start back — see [`docs/determinism.md`](../docs/determinism.md).

## Scenes

A scene is a `.tsx` file that default-exports `defineScene({ id, durationMs, Scene })`.
Author with toolkit primitives only — see
`.claude/skills/kookaburra-scene-authoring/SKILL.md` and `/new-scene`.

`launch-2026/` is a worked example.
