# CLAUDE.md

Guidance for Claude Code when working in **Kookaburra Cut**, a local, deterministic animated-video studio for macOS (Apple Silicon).

## What this is

A Tauri 2 desktop app that renders every visual (text, graphics, 3D) through **one** react-three-fiber WebGL canvas, and exports video by stepping a manual clock frame-by-frame → `gl.readPixels` → a bundled **ffmpeg sidecar** (H.264 / H.265 / ProRes). There is no Chromium fallback; it runs in pure WKWebView. Background and rationale: `docs/architecture.md`; the export contract: `docs/determinism.md`; every locked decision and why: `docs/decisions.md`.

Stack: Tauri 2 · React 19 · react-three-fiber · troika SDF text · anime.js v4 (timeline) · zustand · ffmpeg/ffprobe sidecars. Full version list in `docs/architecture.md`. Package manager: **pnpm**.

## Commands

```bash
pnpm install            # install JS deps
pnpm setup:ffmpeg       # provision the ffmpeg sidecar (dev copy of system ffmpeg)
pnpm tauri dev          # run the app (Vite HMR + WKWebView shell)
pnpm build              # tsc --noEmit + vite build
pnpm test               # vitest
pnpm lint               # biome check .
pnpm format             # biome format --write .

# Terminal-triggered (AFK) Verify ×2 / export: auto-runs in a fresh `pnpm tauri dev`,
# writes ~/Kookaburra Cut/_autorun/last-run.json, exits 0=ok / 1=fail / 2=setup·timeout.
# Bundled gate projects take NO prefix (showcase-tour); workspace fixtures take ws:.
pnpm kookaburra:run --action verify --project ws:launch-2026 --aspect all
pnpm kookaburra:run --action export --project ws:device-video-spike --aspect 16:9 --codec libx264
pnpm gate               # the standard two-leg gate pair (showcase-tour + ws:launch-2026, 16:9)

# SEE a frame without driving the app: one deterministic frame via the export path → PNG
# (path printed + in last-run.json; --scene takes an index or file stem, --at seconds).
pnpm kookaburra:run --action screenshot --project ws:test-4 --scene 2

# Release. Needs KOOKABURRA_SIGNING_IDENTITY + KOOKABURRA_NOTARY_PROFILE, the pinned
# static sidecar (pnpm setup:ffmpeg:release), and a GUI session (Finder styles the DMG).
pnpm package:signed    # build + Developer ID sign + notarise + staple: app and DMG
pnpm package:dmg       # DMG only, from an already-built release/Kookaburra Cut.app
pnpm release           # guards -> package:signed -> zip + checksum -> tag -> draft GH release
```

**Gate economy:** verifies are slow (~2–3 min each); default to **1–2 runs**:
ONE feature-matched project Verify ×2 in 16:9 (`showcase-tour` is the rolling gate
project) + `ws:launch-2026` 16:9 (must be EQUAL: the null-for-legacy proof).
Theme/scene DATA variations don't need their own verifies; only changed CODE
PATHS do. Full matrices (all projects × all aspects) are reserved for engine-wide
constants, deliberate rebases and phase-closing gates. Full tier policy and the
current baselines: `docs/determinism.md` ("Gate tiers", "Current baselines").

Rust: the native shell is in `src-tauri/` (`cargo check --manifest-path src-tauri/Cargo.toml` to typecheck without bundling).

## Layout

- `src/toolkit/`: SHIPPED authoring primitives (the `@kookaburra/toolkit` import). Don't author scenes here.
- `src/engine/`: the deterministic core: `timeline.ts` (anime.js global clock), `format.ts` (FormatContext, `FPS`, `MSAA_SAMPLES`), `compositor.ts` (the one render seam), `exporter.ts` (deterministic loop), `project.ts` (project loading).
- `src/theme/`: theme schema, bundled themes, fonts.
- `src/store/`: zustand editor/preview state. The export path deliberately does NOT read it.
- `projects/<project>/`: the file-based project format: `project.json` + `scenes/*.tsx` (+ per-scene sidecar `scenes/<stem>.json`) + `assets/`.
- `src-tauri/`: Rust shell, `tauri.conf.json`, `capabilities/`, `bin/` (sidecars).

**Licensed assets:** the device model glbs live at `src/assets/models/licensed/`
(gitignored, never commit them; UUID filenames, mapping table in
`src/assets/models/README.md`). Builds fall back to the committed placeholder
when absent; regenerate with `pnpm assets:devices` from the licensed source
archives.

## Scene-authoring hard rules

When creating or editing anything under `projects/*/scenes/`, **use the `kookaburra-scene-authoring` skill** (and `/new-scene`). The rules, all in service of byte-identical export:

1. Every scene is one `export default defineScene({ id, durationMs, Scene })`.
2. Never animate the DOM, and never read the wall clock (`requestAnimationFrame`, `setTimeout`, `Date.now`, `performance.now`, `new Date`). Instead drive all motion from `useTimeline()` / the anime.js timeline.
3. Text only via toolkit primitives (troika SDF). Never HTML/CSS/`<Html>` for exported pixels: WebKit can't deterministically capture the DOM.
4. Colours/type/motion only via `useTheme()` tokens, never hard-coded.
5. Lay out against `useFormat()` (`aspect`, `safe`) so one scene serves all aspect ratios.
6. Assets live in the project's `assets/` folder, referenced by relative path. No absolute paths or remote URLs.
7. User-visible strings come from the scene's sidecar via `useSceneText`; sidecar `background`/`textAnimation`/`camera` blocks are the app-editable surface.

## Skills & commands in this repo

- Skill `kookaburra-scene-authoring`: scene rules + toolkit `REFERENCE.md`.
- Skill `kookaburra-background-authoring`: new animated backgrounds + the preset colour contract (`docs/backgrounds.md`).
- Skill `kookaburra-export-presets`: export preset schema + terminal flows.
- Skill `kookaburra-release`: sign, notarise, DMG, packaged-parity gate, release flow.
- Skill `kookaburra-skill-creator`: create new project skills/commands/primitives.
- Commands `/new-scene <project> <name>`, `/preview [project]`, `/export <project> <format> <aspect>`.

## Committing

**Use the `/ps-commit` skill to review and create commits.** It groups changes into clean conventional commits after a light review. Don't hand-roll `git commit` for substantive changes. Do not push unless asked.

## Current state

The app is feature-complete through its planned pre-release phases: deterministic
multi-scene export in four aspects (16:9 / 9:16 / 1:1 / 4:5) with transitions,
effects, themes (10 bundled + workspace user themes), devices with on-screen
media, per-scene cameras, fixed/video backgrounds, a text-motion pack, one
soundtrack per project, platform export presets, the studio workspace
(`~/Kookaburra Cut`: welcome screen, media library, video editor, embedded
Claude Code terminal), a packaged signed/notarised `.app`, and the night-studio
chrome (⌘K palette, right inspector, camera lane, playback bar).

Operational anchors for any change:

- **Determinism first.** Every render/export-path change gates through
  `docs/determinism.md`: the failure catalogue, gate tiers and current
  baselines live there. `ws:launch-2026` EQUAL is the null-for-legacy proof;
  `showcase-tour` is the rolling gate project.
- **Locked decisions** (and their whys) are in `docs/decisions.md`; don't
  re-litigate them casually; changing an export-contract constant is a
  deliberate rebase.
- The **export gotcha**: the ffmpeg sidecar is spawned **from Rust** by basename:
  `app.shell().sidecar("ffmpeg")`, not `"bin/ffmpeg"` (Tauri strips the `bin/`
  prefix + target-triple when copying it beside the exe). Run `pnpm setup:ffmpeg`
  before exporting (dev copy), or `pnpm setup:ffmpeg:release` for the pinned
  self-contained static build (the dev copy OVERWRITES it). More Tauri-2
  mechanics: `docs/architecture.md` (Implementation notes).

## Performance

Preview slowdowns: measure first, never guess (the 2026-07 hunt disproved every
intuition before the probe settled it).

- **Probe:** `pnpm kookaburra:run --action perf --project ws:<slug>` plays every
  scene under elimination passes (baseline / dpr-1 / no-shadows /
  no-transmission / frozen-media / half-media / no-devices) and writes per-pass
  fps and frame-time stats to `~/Kookaburra Cut/_autorun/last-run.json`. Needs
  the app window visible (occluded WKWebView suspends rAF) and no other
  `pnpm tauri dev` holding port 1420. New suspect: add a pass, don't theorise.
- **Method:** one lever per change, re-run the probe, keep only what the data
  keeps. Clip prefetching was reverted this way: decode work is main-thread, so
  reading ahead made heavy scenes worse. Any clip or render-path change then
  re-gates through the standard verifies (`docs/determinism.md`).
- **Measured impactor:** clip frame decode dominates everything, roughly
  25-30ms per operation (IPC read + PNG decode + texture upload). Shipped
  fixes: off-playhead scenes hold their last frame; playback binds a lazy 960px
  JPEG preview tier (`ensure_clip_previews`; paused, scrubbing and export
  always bind exact full PNGs); Balanced/Performance halve the bind rate.
  Preview-only knobs live in `src/engine/previewMedia.ts` and never leak into
  exports (`isExporting()` guards plus App pinning).
- **Measured non-factors:** device GLB complexity (94k tris holds 60fps),
  transmission glass, VSM shadows, canvas pixel ratio. Low-poly device models
  are not worth building.
