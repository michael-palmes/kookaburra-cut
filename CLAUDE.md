# Kookaburra Cut agent guide

Guidance for Codex and Claude Code when working in **Kookaburra Cut**, an AI driven, deterministic animated-video studio for macOS (Apple Silicon).

## Focus

Kookaburra Cut is a deterministic studio for product launch films that hold their own beside the best from leading tech and AI companies, with a human touch: the person's insight leads and AI does the heavy lifting. Draw that insight out first (what shipped, who it's for, why it matters) and build around their real product; motion carries the story, so nothing looks like a slideshow or PowerPoint, not even a deck. It runs on corporate machines holding confidential, unreleased work, so it protects the user at every step: local by default; nothing leaves the Mac without explicit consent; imported projects, packs and web content are untrusted; anything uncertain fails closed. It serves seasoned editors and first-timers alike: a finished-looking default and one obvious next step up front, depth a click further in, never a dead end. Words are sharp, concise and warm, in Australian English; comments and copy stay minimal. When these conflict, protect the user, then keep exports exact, then keep it simple, then polish.

Hold every change and review to this.

## What this is

A Tauri 2 desktop app that renders every visual (text, graphics, 3D) through **one** react-three-fiber WebGL canvas, and exports video by stepping a manual clock frame-by-frame → `gl.readPixels` → a bundled **ffmpeg sidecar** (H.264 / H.265 / ProRes). There is no Chromium fallback; it runs in pure WKWebView. Background and rationale: `docs/architecture.md`; the export contract: `docs/determinism.md`; every locked decision and why: `docs/decisions.md`.

Stack: Tauri 2 · React 19 · react-three-fiber · troika SDF text · anime.js v4 (timeline) · zustand · ffmpeg/ffprobe sidecars. Full version list in `docs/architecture.md`. Package manager: **pnpm**.

## Collaboration

Ask focused multiple-choice questions when a decision materially changes the implementation. Use `request_user_input` in Codex and `AskUserQuestion` in Claude Code.

## Commands

```bash
pnpm install            # install JS deps
pnpm setup:ffmpeg       # provision the ffmpeg sidecar (dev copy of system ffmpeg)
pnpm setup:models       # provision the beat-this model (SHA-256 pinned; every build needs it, CI uses --stub)
pnpm tauri dev          # run the app (Vite HMR + WKWebView shell)
pnpm build              # tsc --noEmit + vite build
pnpm test               # vitest + node tests + the kb suite (pnpm test:kit)
pnpm agent:catalog      # regenerate the project kit's catalog.json after any registry change
pnpm agent:vectors      # regenerate the kit's edit + re-point conformance vectors after editOps/editMath/re-point changes
pnpm lint               # biome check .
pnpm format             # biome format --write .

# Terminal-triggered (AFK) Verify ×2 / export: auto-runs in a fresh `pnpm tauri dev`,
# writes ~/Kookaburra Cut/_autorun/last-run.json, exits 0=ok / 1=fail / 2=setup·timeout.
# Runs queue behind other agents' runs and pick their own dev port, so they sit beside an
# interactive `pnpm tauri dev` (port 1420 stays yours) instead of fighting it.
# Bundled gate projects take NO prefix (showcase-tour); workspace fixtures take ws:.
pnpm kookaburra:run --action verify --project ws:launch-2026 --aspect all
pnpm kookaburra:run --action export --project ws:device-video-spike --aspect 16:9 --codec libx264
pnpm ready              # PR readiness: the statics and verify legs this branch's diff needs (--plan to preview)
pnpm gate:merge         # the ONE PR gate: showcase-tour + ws:launch-2026, 16:9, one boot, ×1 vs baseline
pnpm gate               # the showcase-tour leg alone

# Cold run: the preview stands down from boot, so no preview frame draws before the run
# whatever the window does ("gl memory before" in dev.log shows programs 0 or 1). Warm runs
# hide cold-only flakes. Export-path actions only; works with --app.
pnpm kookaburra:run --action verify --project ws:device-env-spike --aspect 16:9 --cold

# Pack round trip: export a project to .kbpack, import it into a throwaway workspace
# root, verify there, demand the SAME hash. Required for any change under
# src-tauri/src/pack/** or fonts.rs (docs/determinism.md, "Pack round trip").
pnpm kookaburra:run --action packroundtrip --project ws:launch-2026

# SEE a frame without driving the app: one deterministic frame via the export path → PNG
# (path printed + in last-run.json; --scene takes an index or file stem, --at seconds).
pnpm kookaburra:run --action screenshot --project ws:test-4 --scene 2

# Memory probe: each film through the real export, sampling render rate, every WebKit process's
# memory and the clip cache; exit 1 when a film slows below 80% or the editor grows over 512 MB.
# long-device-spike is the 60 s leak acceptance film; --lever L measures one change.
pnpm kookaburra:run --action memory --project long-device-spike

# Stills (PDF handout or PNG zip, one page per still) through the export path (docs/stills.md).
pnpm kookaburra:run --action stills --project showcase-tour --stills pdf --size 1080p
pnpm kookaburra:run --action stillsverify --project showcase-tour --stills png

# Create-from-template smoke: create_project + a full load in a throwaway workspace root.
# Required per template batch; with --app it proves the packaged resource layout.
pnpm kookaburra:run --action create --project blank

# Template card art: create each template in the throwaway root, capture its manifest's
# four preview frames (16:9, 640px JPEG), promote into src/assets/template-previews/.
pnpm kookaburra:run --action template-previews          # --project <id,...> selects

# Scene-preset card art: load each bundled preset through its scoped id, capture its
# manifest's one preview frame (16:9, 640px JPEG), promote into src/assets/preset-previews/.
pnpm kookaburra:run --action preset-previews            # --project <slug,...> selects

# Look lab: headless contact sheets of a scene3d look in seconds (no Tauri). Iterate here,
# then confirm with one or two autorun screenshots (tools/look-lab/README.md).
pnpm look-lab --look <id> --gpu                          # --compare 4,8 for motion, --grid for all 9 presets

# Release: a signed v* tag on main; .github/workflows/release.yml builds, signs (protected
# environment), verifies and drafts the GitHub release (kookaburra-release skill).
pnpm release           # tag v<version> (signed, checked against .github/allowed_signers) and push it
pnpm release:rehearse  # local ad-hoc rehearsal: build, sign ad hoc, plain DMG, verify; no key, no tag
pnpm package:signed    # local Developer ID sign + notarise + staple (needs the identity and a notary profile)
pnpm package:dmg       # styled DMG only, from release/Kookaburra Cut.app (needs a GUI session)
```

For native Computer Use verification, run `pnpm acceptance:app` and target only the full `.app` path it prints. Never use `Kookaburra Cut`, `com.mpalmes.kookaburracut` or `/Applications/Kookaburra Cut.app`; if the helper fails, stop rather than falling back.

**Gate economy:** before a PR, run `pnpm ready` once, after the last code
change (code review fixes included, see "Code review"). It maps the diff to
exactly what it needs: Tier 0 checks for the areas touched, then
`pnpm gate:merge` (the ONE PR gate: showcase-tour +
`ws:launch-2026`, which must be EQUAL as the null-for-legacy proof) only when
the export path changed, plus a feature fixture only when its area changed.
Each leg exports ONCE against its recorded baseline and falls back to Verify ×2
on a mismatch; a leg whose inputs haven't changed since an EQUAL run is
skipped. CI runs every hermetic test, so don't rerun full suites locally.
Theme/scene DATA variations don't need their own verifies; only changed CODE
PATHS do. Full matrices (all projects × all aspects) are reserved for engine-wide
constants, deliberate rebases and phase-closing gates. Full tier policy and the
current baselines: `docs/determinism.md` ("Gate tiers", "Current baselines").

**Multi-worktree runs:** every `kookaburra:run` takes a FIFO ticket in
`~/Kookaburra Cut/_autorun/queue` and waits its turn, so parallel agents
serialise instead of colliding (status lines name the run in front; `--no-wait`
fails fast instead, `KOOKABURRA_QUEUE_TIMEOUT` seconds overrides the 30 min
wait). Each run owns `_autorun/runs/<run-id>/`: its own last-run.json, dev.log,
screenshots and preview batches, with the result copied back to the legacy
`_autorun/last-run.json`. Autoruns launch in the background (no Dock icon, no
focus steal, window parked bottom-right); `--foreground` opts out.

**Rust build cache across worktrees:** every checkout keeps its own
`src-tauri/target`. Never point two checkouts at one target dir: cargo then
reuses the other checkout's app binary as fresh, with its baked-in
`CARGO_MANIFEST_DIR` and the resources tauri-build copies beside it.
Instead, `pnpm install` in a new worktree runs `scripts/seed-cargo-target.sh`,
which APFS-clones the primary checkout's third-party artefacts (seconds,
near-zero disk until either side rebuilds) and drops kookaburra-cut's own, so
the first build compiles only the app crate. `pnpm setup:target` does the same
for a Rust-only session; it never touches an existing target. `du` counts
clones in full, so judge real usage with `df`.

Rust: the native shell is in `src-tauri/` (`cargo check --manifest-path src-tauri/Cargo.toml` to typecheck without bundling).

## Layout

- `src/toolkit/`: SHIPPED authoring primitives (the `@kookaburra/toolkit` import). Don't author scenes here.
- `src/engine/`: the deterministic core: `timeline.ts` (anime.js global clock), `format.ts` (FormatContext, `FPS`, `MSAA_SAMPLES`), `compositor.ts` (the one render seam), `exporter.ts` (deterministic loop), `project.ts` (project loading).
- `src/theme/`: theme schema, bundled themes, fonts.
- `src/store/`: zustand editor/preview state. The export path deliberately does NOT read it.
- `projects/<project>/`: the file-based project format: `project.json` + `scenes/*.tsx` (+ per-scene sidecar `scenes/<stem>.json`) + `assets/`.
- `presets/<preset>/`: bundled scene presets: a single-scene project folder plus `preset.json`; user presets mirror the shape at `~/Kookaburra Cut/presets/`.
- `src-tauri/`: Rust shell, `tauri.conf.json`, `capabilities/`, `bin/` (sidecars).

**Licensed assets:** the device model glbs live at `src/assets/models/licensed/`
(gitignored, never commit them; UUID filenames, mapping table in
`src/assets/models/README.md`). Clean builds hide unavailable licensed devices
and render saved references with the committed Android fallback. Copy the
licensed directory into each worktree or regenerate it with
`pnpm assets:devices` from the licensed source archives.

## Scene-authoring hard rules

When creating or editing anything under `projects/*/scenes/`, **use the `kookaburra-scene-authoring` skill** (and `/new-scene`). The rules, all in service of byte-identical export:

1. Every scene is one `export default defineScene({ id, durationMs, Scene })`.
2. Never animate the DOM, and never read the wall clock (`requestAnimationFrame`, `setTimeout`, `Date.now`, `performance.now`, `new Date`). Instead drive all motion from `useTimeline()` / the anime.js timeline.
3. Text only via toolkit primitives (troika SDF). Never HTML/CSS/`<Html>` for exported pixels: WebKit can't deterministically capture the DOM.
4. Colours/type/motion only via `useTheme()` tokens, never hard-coded.
5. Lay out against `useFormat()` (`aspect`, `safe`) so one scene serves all aspect ratios.
6. Assets live in the project's `assets/` folder, referenced by relative path. No absolute paths or remote URLs.
7. User-visible strings come from the scene's sidecar. Code-owned scene copy uses `useSceneText`; inspector-owned scene copy uses `managedText`, while embedded labels remain in `text`. Sidecar `background`/`textAnimation`/`camera`/`stills` blocks are the app-editable surface.

## Skills & commands in this repo

Project skills are authored only in `.agents/skills`. Keep `.claude/skills` as the relative symlink `../.agents/skills`, and use `kookaburra-skill-creator` for every skill change.

- Skill `kookaburra-scene-authoring`: the kit stamped into every user project (SKILL.md loop and rules, RULES.md, DESIGN.md, `reference/` topic files, the generated `catalog.json`, the `kb` tool in `scripts/`). Users have no app source, so keep it accurate for a bare project folder.
- Skill `kookaburra-video-editing`: the sibling stamped skill for editing videos inside a project (SKILL.md + `reference/`, no scripts); it drives `kb video`, which edits the app's own edit documents through the app's headless `edit` CLI.
- Skill `kookaburra-brand-packs`: the third stamped skill; builds, checks and applies workspace brands (`~/Kookaburra Cut/brands/<slug>/`) from a brand folder and guidelines PDF with its stdlib `brand.py`. Brands are guidance, never hard rules.
- Skill `kookaburra-background-authoring`: new animated backgrounds + the preset colour contract (`docs/backgrounds.md`).
- Skill `kookaburra-lighting-authoring`: v9 scene lighting (layers, light spaces, fixtures, HDRIs, keyframes, tone mapping).
- Skill `kookaburra-export-presets`: export preset schema + terminal flows.
- Skill `kookaburra-release`: sign, notarise, DMG, packaged-parity gate, release flow.
- Skill `kookaburra-skill-creator`: create new project skills/commands/primitives.
- Skill `kookaburra-commit`: plan and create every commit (review, logical grouping, conventional messages).
- Skill `kookaburra-pr-descriptions`: the fixed PR title/description standard; use for every PR opened in this repo.
- Docs `docs/agent-kit.md`: how Claude Code edits user projects (kit layout and stamping, `kb`, hooks, the bridge v2 heartbeat and requests, load safety, conflict-aware live edits, the headless edit CLI and `kb video`, the catalogue). Read it before touching `.agents/skills/kookaburra-scene-authoring/`, `.agents/skills/kookaburra-video-editing/`, `src-tauri/src/kit.rs`, `bridge.rs`, `cli.rs`, `edit.rs`, `live_edits.rs`, `src/engine/editOps.ts`, `src/editor/editLiveSync.ts`, `src/render/bridge*.ts`, `src/engine/sceneDoc*.ts`, `src/theme/fontSafety.ts`/`fontVet.ts` or `src/agentKit/`.
- Docs `docs/content-library.md`: editable templates, the shared Add a scene/App presets catalogue and standalone theme editing, including scoped IDs, reuse and preview ownership.
- Docs `docs/brands.md`: workspace brands (the folder and `brand.json`, the project `brand` field and `BRAND.md`, the Project picker, brand images in the Library, brand colours in the colour picker, the pack kind). Read it before touching `src-tauri/src/brands.rs` or `.agents/skills/kookaburra-brand-packs/`.
- Docs `docs/packs.md`: the `.kbpack` format (archive layout, manifest, signing and TOFU, the extraction checklist, the conflict table). Read it before touching `src-tauri/src/pack/`.
- Docs `docs/charts.md`: the chart subsystem (the sidecar `chart` block, the three mounts, the appearance and build-in preset catalogues, palette and number-formatting rules, the keyframed data track). Read it before touching `src/toolkit/chart/` or `src/engine/sceneChart.ts`.
- Docs `docs/foldables.md`: folding devices (the inside and outside displays and the one screen-slot helper, the `foldDeg` track, the per-degree glb clip and its static camera half, auto-centre, auto screen power, Start when opened, the two-panel shadow, the Fold inspector group). Read it before touching `src/toolkit/device/foldPose.ts`, `src/engine/foldTransition.ts`, `src/engine/deviceScreens.ts`, `src/ui/inspector/foldEditorModel.ts` or `scripts/blender-duo-prepare.py`.
- Docs `docs/gizmos.md`: the gizmo subsystem (the 3D and 2D families, section-scoped outlines and click-to-select, the pointer-routing contract, the registries and coordinate spaces, what each drag writes, the export guards). Read it before touching `src/engine/gizmo*`, `src/engine/SceneGizmo.tsx`/`SceneOutline.tsx`, `src/ui/gizmo/`, or any gizmo host (`src/ui/TextGizmo.tsx`, `ChartHeroGizmo.tsx`, `DecorationGizmo.tsx`, `src/toolkit/device/DeviceGizmo.tsx`, `src/toolkit/objects/ObjectPrimitive.tsx`, `src/toolkit/chart/Chart.tsx`).
- Docs `docs/stills.md`: the stills export (the sidecar `stills` block and `still: true` camera keys, the automatic still's settled moment and Present holds, the page plan, the PDF and PNG zip writers, the IPC, the autorun gate). Read it before touching `src/engine/still*.ts`, `src/engine/exportFrame.ts`, `src/engine/presentHold*.ts`, `src/engine/presentTimingRegistry.ts` or `src-tauri/src/stills/`.
- Docs `docs/mdm.md`: managed preferences (the forced keys a configuration profile can set, what each locks, the sample profile, how to verify). Read it before touching `src-tauri/src/managed.rs`, `src/engine/managed.ts` or any `managed::deny_*` call.
- Commands `/new-scene <project> <name>`, `/preview [project]`, `/export <project> <format> <aspect>`.

## Committing

**ALWAYS use the `kookaburra-commit` skill to review and create commits.** It groups changes into clean conventional commits after a light review; never hand-roll `git commit` for substantive changes. Do not push unless asked.

**Branch names are `type/short-kebab-description`** with a conventional type (`feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `perf/`, `test/`, `ci/`, `build/`), for example `fix/editor-tap-alignment`. NEVER a `claude/` prefix (or any other agent or tool prefix) and NEVER a generated suffix such as `-94cd0f`. If the tooling created a branch named that way, rename it before the first commit.

## Code review

**ALWAYS run `/code-review high` before opening a PR** (in Codex, `/review`; elsewhere, the closest high-effort review available). Run it again before pushing changes to an open PR, and at major checkpoints: a finished phase, a large refactor, or before handing work over.

Never apply findings wholesale; triage each against the Focus:

1. Confirm it is real by reading the code or reproducing it; drop any that don't hold up.
2. Fix it when it protects the user, keeps exports exact, keeps a flow simple, or is a genuine bug.
3. Skip it when it is speculative or churn with no benefit to the user; when it is real but out of scope, raise it as a follow-up.
4. When findings conflict, the Focus's order decides.

Report what you fixed and what you skipped, each with a one-line reason, then run `pnpm ready` once after the last fix.

## Writing rules

- **Never commit anything from the user's own workspace.** Projects under `~/Kookaburra Cut` are private: no project, folder or scene names, slugs, on-screen copy, product, client or people's names, or local paths in committed code, tests, fixtures, docs, skills, commit messages or PR text. Use neutral placeholders instead (`product-tour`, "Highlights", `/Users/x`). This leaked once (a debugging session's project and product names reached test data and a design doc, and a pushed PR's history had to be rewritten), so `pnpm ready` and the `kookaburra-commit` skill both run `scripts/workspace-names.mjs` (the folder names under `~/Kookaburra Cut` on this Mac plus the leak shapes in `scripts/workspace-denylist.txt`, over every added line), and before every commit also grep for the names of any project opened that session, since the folder check cannot see scene copy or product names. The gate fixtures this file already names (`ws:launch-2026`, the `ws:*-spike` projects) are test infrastructure; never add a new one without the user's say-so.
- **Keep `AGENTS.md` and `CLAUDE.md` byte-identical.** Update both in the same change and verify with `cmp -s AGENTS.md CLAUDE.md`.
- **All text you write** (docs, comments, commit messages, PR descriptions, UI copy) is Australian English, short and concise, with no em dashes: use commas, colons, parentheses or full stops.
- **IMPORTANT: comments are a last resort.** Keep them to a minimum, one line max, and only where they add context the code cannot show; remove any that do not.
- **Icons by default in the UI**: EVERY toggle and option control in the app chrome (toggle rows, action rows, segmented options, preset/option chips, side selectors) carries a leading line icon; text-only is a justified exception, not a default (`docs/design.md` section 10).
- PR descriptions ALWAYS follow the `kookaburra-pr-descriptions` skill: one fixed shape (summary, What changed, a Verification line when gated), under ~120 words, nothing that lives outside the repo.

## Current state

The app is feature-complete through its planned pre-release phases: deterministic
multi-scene export in four aspects (16:9 / 9:16 / 1:1 / 4:5) with transitions,
effects, bundled and workspace user themes, devices with on-screen
media, camera rigging (orbit plus free-flight poses, depth bands),
fixed/video backgrounds, a text-motion pack, terminal scene content (live in
preview and Present, captured snapshot in export: `docs/scene-terminal.md`), one
soundtrack per project, platform export presets, stills export (a PDF handout
or PNG images, one page per still: `docs/stills.md`), the studio workspace
(`~/Kookaburra Cut`: welcome screen, media library, video editor, embedded
Claude Code terminal), a packaged signed/notarised `.app`, the night-studio
chrome (⌘K palette, right inspector, camera lane, playback bar), the
template and scene-preset library with the theme editor window (dev builds
edit the bundled sets in place), and `.kbpack`
packs: one signed file carrying projects, templates, scene presets, themes,
fonts, 3D objects, gradients, export presets and screenshots between machines
(`docs/packs.md`).

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
  no-transmission / frozen-media / half-media / no-devices / no-dof / no-motion-blur) and writes per-pass
  fps and frame-time stats to the run's `last-run.json`. It always runs
  foreground on its own dev port, so the window is visible (an occluded
  WKWebView suspends rAF), and it warns when another dev app is listening on
  1420, since a busy machine skews the fps. Each window warms up until
  frames come steadily before sampling, since a first draw can outlast the
  3 s stall guard. New suspect: add a pass, don't theorise.
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
  transmission glass, VSM shadows, canvas pixel ratio (but see the area-light
  note below). Low-poly device models are not worth building.
- **Second measured impactor (2026-07-25): area lights are FILL RATE.** One
  `rectAreaLight` cost ~15 fps (45 → 60) in a scene staging large
  Standard-material objects, while the v9 corridor holds 60fps with TWELVE of
  them because it stages only a handset. The expense is per-fragment LTC
  evaluation, so it scales with the screen coverage of the materials an area
  light lights, NOT with how many area lights there are. `dpr-1` recovers it
  almost as well as removing the light, which is also the caveat on "pixel ratio
  is a non-factor": that holds until something makes a scene fill-rate bound.
  No preview knob was added, because the existing preview-quality DPR lever
  already covers the one measured case. Probe passes: `no-extra-lights`,
  `no-fixtures`, `no-fixture-lights`, `no-area-lights`, `env-off`.
- **Third measured impactor (2026-10-02): the lit set's environment.** Every
  built-in-lit `Device`, `DeviceMockup` and `HeroObject` mounted drei's
  `<Environment frames={1}>`, which re-renders its cube and PMREM whenever its
  JSX children change, i.e. every clock tick: 0.35 to 0.6 s per export frame
  with devices against 0.19 without, plus ~4 MB of GPU memory each. They now
  share one studio environment per renderer
  (`src/toolkit/lighting/studioEnvironment.ts`; a 40-device project exports at
  ~0.21 s/frame). Never mount a drei `<Environment>` with JSX children inside
  a component that re-renders per tick.
- **Fourth measured impactor (2026-10-28): clip frame memory.** Each clip kept
  12 decoded frames for the whole session, in both decode lanes, so a long
  device film grew the editor past WebKit's WebContent limit (reloaded at about
  half way; 7.1 GB measured over five spikes). Exports now keep two a clip and
  release idle frames at start and end. Probe memory with `--action memory`
  (`docs/determinism.md`, "Memory probe"), not fps alone: a big Mac hides it.
