# Fixtures (fixtures)

Dev-only projects. Same file-based format as [`projects/`](../projects), same
bare ids (`--project transition-spike`), but this tree is **never bundled**:
`src-tauri/tauri.conf.json` ships `../projects` alone, and every fixture glob in
`src/engine/project.ts` is behind `import.meta.env.DEV`, so a packaged app never
lists or loads one.

| Folder | Job |
| ------ | --- |
| `preview-lab-*` | Option-preview sources: one per family (text, stage, chart, chart build-ins) plus one per background. `pnpm kookaburra:run --action option-previews` renders them into `src/assets/option-previews/`, incrementally via `scripts/option-preview-stale.mjs` |
| `transition-spike`, `transition-bg-spike` | Transition determinism fixtures with recorded verify baselines (`docs/determinism.md`) |
| `compare-spike` | The before/after comparison fixture |

Adding a background means adding its `preview-lab-bg-<id>` project here; a vitest
guards the pairing. The theme-preview fixture is NOT here: it ships, as
`projects/preview-lab-theme/`.

The kooka-loop-* projects are the SOURCE for the pool's loop clips
(projects/_samples/kooka-*-loop-sample.mp4). Regenerate by copying the loop
project into ~/Kookaburra Cut and exporting the ws: copy at 9:16 (fixture
image backgrounds do not bind on the export path, so export from a workspace
copy), then re-encode to stay under 1.5 MB.
