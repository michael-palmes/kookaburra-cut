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
| `image-flip-spike` | One image staged BOTH ways in one frame (device screen + plain stage plane), so an orientation regression is visible in a single `--action screenshot` |
| `flash-spike` | The flash and kb export parity fixture (about 4 s): a title, a crossfade, one second of 100 ms full-frame cuts between two theme colours (fails the flash gate), then one second at 2 Hz (the control). Copied into a throwaway root for kb runs; never in `gate`, `gate:merge`, CI or release parity |

Adding a background means adding its `preview-lab-bg-<id>` project here; a vitest
guards the pairing. The theme-preview fixture is NOT here: it ships, as
`projects/preview-lab-theme/`.

The pool loop clips (kooka-*-loop-sample.mp4) regenerate from the Kooka stills



via scripts/make-kooka-loops.sh (ffmpeg xfade at the native 828x1792 screen ratio; the export path only renders the fixed aspects, which cover-crop inside handset screens).
