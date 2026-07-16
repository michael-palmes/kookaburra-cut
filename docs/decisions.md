# Decisions

> The locked-decisions log: what was chosen, what shipped, and why, one row per
> durable decision. Mechanism lives elsewhere: rendering and stack rationale in
> [architecture.md](./architecture.md), the byte-identical-export contract in
> [determinism.md](./determinism.md), chrome in [design.md](./design.md), copy in
> [voice.md](./voice.md). Scene-authoring rules live in the
> `kookaburra-scene-authoring` skill.

Still-true rules are written in the present tense. A decision only appears once,
with its latest form; superseded choices are gone.

## Scaffold & stack

| Decision | Choice | Why |
| --- | --- | --- |
| Rendering surface | One WebGL canvas (react-three-fiber) for every exported pixel: text, graphics, 3D. Nothing visual is DOM/CSS | WebKit cannot deterministically capture the DOM; one synchronous surface is reproducible |
| Shell | Tauri 2 on pure WKWebView; no Chromium fallback | Small, native, and the determinism contract was proven against WebKit directly |
| Encoder | Bundled ffmpeg sidecar fed raw RGBA over stdin | WebCodecs has no ProRes encoder; ffmpeg gives full pixel-format/colour control |
| Text engine | troika-three-text (SDF glyphs) in the same canvas | Kerned, ligature-aware text without DOM capture |
| Timeline | anime.js v4 global timeline, autoplay off, manual ticking, `seek(t)` | Explicitly supports disabling its main loop: what a frame-accurate exporter needs |
| Animation licensing policy | Permissive dependencies only (GSAP and Theatre.js excluded) | Keeps the whole JS dependency tree MIT/Apache/ISC-class |
| State | zustand store-backed hooks (`useTimeline`/`useFormat`/`useTheme`), not React context | r3f renders through a separate reconciler; context does not bridge the Canvas boundary |
| Tooling | pnpm · Biome (lint + format) · Vitest | One fast tool per job; Vite-native tests house the determinism harness |
| Skills & commands | In-repo `.claude/` | Version-controlled; they travel with the code |
| Frame rate | 60fps app-wide, a single `FPS` constant | One clock constant; changing it re-baselines everything |
| Render size | Native 4K per aspect; ffmpeg scales down when an export preset asks | Render once at quality; scaling is the encoder's job |

## Export & determinism doctrine

The full contract and its failure catalogue are in
[determinism.md](./determinism.md). The rules of the road:

| Decision | Choice | Why |
| --- | --- | --- |
| The prime rule | Frame N is a pure function of the timeline value `t`. No wall clock, no `requestAnimationFrame`, no history | Byte-identical re-export is the product promise |
| UI isolation | The export path never reads UI stores; editor state merges into preview imperatively and stands down during export | Purity by construction, not by discipline |
| The gate | Verify ×2: export twice, compare SHA-256. Byte-stability only; every gate pairs with a visual check | Byte-identical wrong pixels pass hashing |
| Hash scope | Determinism is same-machine; hashes are not portable across GPUs/OS builds | Fixed-function GPU resolves are stable per machine, not per fleet |
| Default codec | Software `libx264`; VideoToolbox encoders are opt-in "fast drafts" excluded from Verify | Hardware bit-exactness is machine/OS-version dependent |
| The frozen path | No encode spec ⇒ the ffmpeg argv is byte-pinned (Rust goldens). Presets are a separate argv family and can never move standing baselines | Determinism gates stay untouched while export features grow |
| Null-for-legacy | Every feature resolves to `null` when unused, and the pre-feature code path runs verbatim; byte-identity for old projects is structural, not hoped-for | A moved hash is a stop-and-attribute event, never a shrug |
| Preload barriers | Everything loads before frame 0: fonts (sequentially, in canonical order), clip frames, models, LUTs, environments; then scene-host, canvas-clock-commit and project-commit barriers | Any async load that can race the loop eventually will |
| Randomness | Seeded RNG only (`engine/rng.ts`), golden-pinned streams; per-primitive draw order is contract. `Math.random` never | Committed scenes bake geometry from the stream |
| Shader time | No time uniforms; progress/params are CPU-computed and passed in | GLSL must not know what time it is |
| Tuned constants | Visual constants (shine band, scatter angles, shadow rig, stage geometry, ease curves) freeze as export contract once accepted | Changing one re-renders every committed project that uses it |
| Anti-aliasing | MSAA 4× on every render path; geometric specular AA on device materials; TAA rejected | TAA is history-dependent; it breaks frame purity and random-access scrubbing |
| Transition blending | Mix in the display (encoded sRGB) domain; transition endpoints are byte-equal to their solo neighbours; effects projects blend through the exact ACES forward/inverse pair | A dissolve is a perceptual effect; linear mixing back-loads the fade |
| Tone mapping | Tone-map once, encode once, per path; the effects composer owns a project's single ACES pass | Two ACES implementations are never mixed across a seam |
| Exact-colour surfaces | Backdrops, screens, fixed backgrounds and SDF text render unlit with tone mapping off; 3D bodies keep ACES | White through ACES is grey; authored colours must land exactly |
| Gate economy | The default gate is two runs: one feature-matched project + the legacy sentinel, 16:9. Full matrices only for engine-wide constants, deliberate rebases and phase closes | Data variations are not code paths; verifies are minutes each |
| Rebase discipline | Engine-wide constants (fps, MSAA, shadow type, blending domain, atlas order) are rebase events, undertaken deliberately and re-proven | The baseline set is an asset; it moves on purpose or not at all |

## Project format & authoring

| Decision | Choice | Why |
| --- | --- | --- |
| Project format | A folder: `project.json` manifest + `scenes/*.tsx` + per-scene sidecar JSON + `assets/` | Files a human, an app and an agent can all edit |
| Scene definition | One `defineScene({ id, durationMs, Scene })` default export per file | One discoverable shape |
| Sidecar documents | `scenes/<stem>.json` beside the TSX, keyed by file stem (never scene id) | The UI edits it atomically; TSX without a sidecar still renders; ids are free to differ from filenames |
| Scene text | User-visible strings live in the sidecar via `useSceneText` | "Edit text" works on every scene regardless of author |
| Duration ↔ media | Scene length follows its media until a duration is typed; explicit intent wins permanently | Media swaps re-sync length automatically without fighting the author |
| Write concurrency | Atomic tmp+rename writes with a version guard; last-writer-wins, no CAS | Acceptable at app+agent cadence; live reload surfaces either author's edit |
| One write funnel | All UI surfaces edit through one shared patch path | Two writers drift; one funnel cannot |
| Reload rule | UI writes never trigger a module reload: in-memory patching, stale-while-revalidate; only genuinely external file changes reload | Edits must not close editors or flicker the preview |
| Scene surface | Single-file, toolkit-only scenes: `@kookaburra/toolkit` (+ `react/jsx-runtime`) are the only resolvable imports; anything else is a readable authoring error | Matches every scene in existence and keeps the runtime compiler small |
| Authoring rules as skill | The scene-authoring skill is re-stamped into every project on open; skill coverage is a ship gate for new authoring surface | Agents are a first-class authoring path |
| Vocabulary | "project", "scene", "device", "media" in all user-facing copy | Plain words for a non-technical audience |
| Undo/redo | Whole-manifest snapshots, session-only, compound entries; replays ride the same atomic writers | Generic undoability without per-operation inverse logic |
| Deletes | Everything routes through the system Trash; media delete/rename is refused while any scene references the file (the error names the referencers) | A safety net beneath every destructive action; no silent scene breakage |
| Project rename | Display-name only; the slug/folder never changes | Stable ids and paths under a mutable label |

### Themes & typography

| Decision | Choice | Why |
| --- | --- | --- |
| Theme format | JSON (schema-versioned), one format for bundled and user themes; degrade-don't-crash validation, unknown fields pass through | The app, a human and an agent edit the same source of truth |
| Theme storage | Bundled themes in the app; user themes workspace-shared at `~/Kookaburra Cut/themes/<slug>/` | One theme serves all projects |
| Per-scene theming | A sidecar `themeId` swaps the whole theme for that scene; token-level tweaks mean duplicating the theme | Full swap keeps resolution trivial and previews honest |
| Cross-theme transitions | Each side renders fully in its own theme; the composite blends finished pixels. Theme values never interpolate | Matches the compositor architecture |
| Bundled fonts | OFL static faces only, committed to the repo | Exports survive OS font updates; licence-clean |
| System fonts | Pinned by copying the face (extracting from `.ttc` where needed) into `~/Kookaburra Cut/fonts/` on first reference; pins are idempotent and never overwritten | The export depends on pinned bytes, not on macOS |
| Variable fonts | Pinned as instanced statics at the picked weight (pure-Rust instancer, outline-exact); unsupported flavours refuse with a readable error | troika renders a VF's default instance silently: refuse over mis-render |
| Font atlas order | Fonts preload sequentially in canonical order; adding or reordering a bundled face is a rebase event (append at the end) | troika shares one SDF atlas across all fonts; insertion order shifts glyph cells |
| Uncovered codepoints | troika is patched (`patches/troika-three-text@0.52.4.patch`) so a failed fallback-font fetch degrades to `.notdef` tofu, and `unicodeFontsURL` points at a dead same-origin path so the CDN is never consulted | Unpatched, a blocked fetch wedges `<Text>` forever (`_isSyncing` never clears); a permissive-CSP machine would otherwise silently fetch remote fonts and render different pixels |
| Symbols fallback | `KookaburraFallback.otf` (Noto-derived subset, generated by `pnpm assets:emoji-fonts`) wired as troika's `defaultFontURL`, preloaded LAST | Arrows/checks/stars render as real SDF glyphs in the text colour; the slot only resolves codepoints the theme font lacks, so standing glyphs cannot move |
| Emoji rendering | System Apple Color Emoji, rasterised once per cluster via canvas 2D and composited as textured quads in the same canvas; emoji never reach troika (private-use placeholder substitution reserves layout). The app never bundles or redistributes Apple artwork; Twemoji (MIT/CC-BY) is the documented pluggable fallback art source if the system route is ever untenable | The user wants platform-native emoji; sbix colour bitmaps cannot render through single-channel SDF; rendering with the SYSTEM font on the user's own Mac is the same position as any macOS video editor |
| Emoji determinism | The write-once raster cache (`assets/.emoji-cache/`, per project) is the determinism source, not the renderer; first-rasterised bytes freeze forever | An OS emoji-artwork update must never move an export baseline (the system-font pinning contract) |
| Emoji scope | Workspace projects only (bundled demos are read-only in the packaged app and keep a session cache); `ExtrudedText` (3D) stays ASCII-only; counters get symbols + colour quads but their format output is scanned per frame, not statically | Each exclusion is deliberate: no product need, and the read-only resource dir is a structural boundary |
| Text animation | Closed-form presets (fade/slide/blur/mask, fade-scale, twist-scale, scatter-scale) with themeable params; a sidecar `textAnimation` overrides; resolution is prop > sidecar > theme > default, with a sidecar force-flag to override coded props | Presets are pure functions of eased progress; every surface writes the same spec |
| Paragraph delivery | A text convention: `\n` is a paragraph, a blank line separates groups; no grouping schema | Works identically from props, sidecars, themes and agent-authored text |
| Group lockups | `AnimatedGroup` samples a preset as one unit over icon+text compositions; pivot is the group origin; alpha propagates by context, CPU-side | Measured-bounds pivots depend on load timing; two material writers would be commit-order-dependent |

## Studio, workspace & packaged app

| Decision | Choice | Why |
| --- | --- | --- |
| Workspace | `~/Kookaburra Cut`, chosen at first run; projects are self-contained folders (scenes, assets, per-project `exports/`, own git repo) | Sharing or deleting a project carries everything with it; home-folder root avoids macOS privacy prompts on headless runs |
| Project trust | Every new project is `git init`-ed with an initial commit | Agent tooling persists trust for git repos; free checkpointing |
| Embedded terminal | xterm.js (DOM renderer) over a native PTY (portable-pty; raw byte channel with flow control; login shell; environment scrubbed so the session presents as plain standalone) | GUI apps inherit a bare PATH; the event system is unsuited to PTY throughput |
| Prompt insertion | Helper wizards paste composed prompts via bracketed paste and never auto-submit | The user reads, tweaks, and presses Enter |
| Live reload | Native source-fingerprint polling re-imports changed scene modules (workspace files sit outside the dev server's watchers); paused during export | An agent's edits appear live without breaking export purity |
| Media library | ffprobe as a second sidecar; content-hash-keyed poster/scrub/probe cache, app-global | Dedupes identical files across projects; one place to clear |
| Video editor | A real second window; non-destructive edit documents referencing sources read-only; single video track, magnetic/gapless timeline; renders via one ffmpeg filter graph back into the project's assets | Originals untouched; the timeline model IS the concat recipe |
| Runtime scenes | Workspace scenes compile in-webview with exact-pinned esbuild-wasm; one loader everywhere (dev included) once proven hash-equal to the dev-server path | Every dev verify exercises the shipping loader |
| Module identity | A runtime registry maps toolkit/react imports to the app's own instances as blob-URL modules, generated from the live namespaces | A duplicate three.js instance breaks everything silently; no hand-maintained export list |
| File URLs | One helper over Tauri's asset protocol serves fonts, media and images in dev and packaged builds alike | One seam, one parity argument |
| CSP is render contract | The CSP is treated as part of the render pipeline; changes gate like render changes | A blocked subresource fails silently and yields deterministic-but-wrong pixels |
| Autorun | A native config channel (env-read at boot) drives headless verify/export runs in dev and packaged builds | Build-time env is unreadable in a packaged app |
| Packaged parity | The packaged `.app` must reproduce dev hashes on the standing projects, a distinct gate class from internal determinism | "Internally deterministic" is not "correct" |
| Divergence forensics | Every verify result carries a render-state fingerprint (tone mapping, context attributes, lights, material state); diff it first on any cross-build divergence | It names a missing texture in one JSON diff |
| Distribution | Developer ID signed, hardened runtime, notarised: personal distribution | Closes Gatekeeper friction without claiming a public release |
| Signing split | Tauri signs (it walks the bundle and signs the sidecars and nested code in the right order); `scripts/sign-and-notarize.sh` notarises | Tauri's own notarisation can't use a notarytool keychain profile, and it never notarises the DMG, only the `.app` |
| DMG is ours | `bundle.targets` is `["app"]`; `scripts/make-dmg.sh` builds the installer | Tauri's DMG bundler takes only a png/jpg/gif background (no multi-resolution TIFF, so the art is blurry on Retina) and can't set a volume icon |
| Trash via NSFileManager | Deletes route through `workspace::trash_path`, never `trash::delete` | The crate's default backend drives Finder over osascript; TCC blames the Apple Event on us, so a hardened-runtime build silently fails every delete |
| No entitlements | Hardened runtime with an empty entitlement set | Nothing in the shell needs one: no in-process JIT (WebKit's lives in its own process), no `dlopen`, no `DYLD_*`, no Apple Events; sidecars are separate signed processes, not loaded code |
| Capture hygiene | Thumbnails/snapshots never run during export or autorun; list surfaces read cached thumbs only; the only legal live fallback captures the current frame without seeking | Borrowed-clock captures blip the playhead and race the exporter |

## Devices, media, camera & stage

| Decision | Choice | Why |
| --- | --- | --- |
| Device identity | Real product names with accurate licensed models ("iPhone 15 Pro, Natural Titanium") | Best UX; ubiquitous industry practice for mockup tooling |
| Device asset | The handset glb is a purchased, licensed vendor asset. It is **not committed**; it lives in a gitignored folder and is bundled into app builds only | The licence covers app embedding, not source redistribution |
| Colour variants | Material-name overrides on one glb, using the vendor's authored material values as exact replacements | Four glbs for four colours would quadruple the bundle for identical geometry |
| Device motion | Opt-in only (2026-07-17): every scaffold path (Rust scaffolder, new-scene wizard, inspector quick-add) writes `preset: "none"`; motion is a deliberate per-device sidecar choice | A device should hold still until the author asks it to move |
| Screen media | One shared clip-texture hook plays video/image media on the glb's `SCREEN` material, the same pre-extracted CFR frame pipeline as `VideoClip` | One clip pipeline for every consumer |
| Clip playback | Sources pre-extract once to a cached CFR-60 PNG sequence; frame choice is a pure clock function (clamp to hold, modulo to loop) | Seeking an `HTMLVideoElement` is neither exact nor deterministic |
| Device shadows | Procedural deterministic contact shadows by default; the stock accumulating helper was rejected | It jitters its light per frame, nondeterministic by design |
| Staged shadows | Real shadow maps (fixed-parameter key light, VSM) only when a scene stages a floor/backdrop; blob shadows stand down there | Silhouette shadows where staging demands them; unstaged projects byte-untouched |
| Backdrops | Cyclorama floor, gradient and image backdrops render unlit at exact colour, with shadows composited via catcher overlays | The surface stays colour-true; the shadow darkens on top |
| Fixed backgrounds | A separate camera-locked `background` slot (colour/gradient/image, optional parallax; video via sidecar only) that composes with world staging; the quad's matrix is rewritten from the live camera immediately before each draw | Pure function of the pose the compositor just applied; transition poses and fov ramps come free |
| Texture crop | Cover-crop baked into per-instance geometry UVs on cloned textures; shared textures are never mutated | Shared caches serve other meshes; mount order must not matter |
| Environments | Bundled CC0 HDRIs, decoded and PMREM-processed in the preload barrier | Reflections without a network or a race |
| Per-scene camera | Orbit poses (`target/azimuth/elevation/distance`) in the sidecar, eased segments, shared boundary-key objects, hold-latest sampling; transition frames render each offscreen target under its own scene's pose | "Edit the boundary, both animations move" is the data model, not a sync rule |
| Camera fallback | With no scene tracks anywhere, the resolver returns null and the legacy path runs verbatim; once any scene opts in, every frame's camera is written explicitly | No stale pose can leak across a scene seam |
| Camera UI | Overlays and edit state are DOM above the canvas, in UI-only stores | The export cannot see them by construction |
| Effects | A project declaring any effect routes every frame through one composer built from the project-wide effect union; per-scene overrides drive uniforms only; only allow-listed time-free effects exist | No mid-project shader recompiles; no effect knows the time |
| Colour grades | 3D LUTs apply post-tone-map (LDR sRGB domain); mid-project swaps are uniform writes; one LUT size per project | Standard `.cube` grades are authored for LDR input; the public setter recompiles |
| Persistent layers | A project's persistent module mounts once outside all scene groups and is drawn exactly once per frame, never into both transition targets | An always-visible object would cross-fade against itself |

## Transitions, audio & export presets

| Decision | Choice | Why |
| --- | --- | --- |
| Transition pack | Crossfade, dip, slide/push, wipe, blur, zoom, whip, procedural luma/iris, glitch: normalised specs with per-type defaults; unknown types degrade to crossfade with a warning | Hand-editable JSON must degrade, never throw |
| Glitch randomness | Integer hash (PCG), never `fract(sin)` | Integer ops are exact across shader compiles |
| Shader generations | Extended transitions are separate GLSL3 materials; the original programs stay source-identical | Legacy-project byte-identity is structural |
| Transition picker | One small live-GL preview drives the real shipping shaders over cached scene thumbs; no committed preview assets, no capture | Previews cannot drift from the shaders; capture would scrub the stage |
| Soundtrack | One per project (`project.json` `audio` block): file, gain, fades, start offset | One track covers the product need without a mixing surface |
| Audio determinism | Sample-exact 48 kHz filter graph built in Rust: integer sample counts, pad-or-trim to exactly the video's length, bitexact flags; the no-audio argv is byte-frozen | Muxer heuristics are not a duration contract; silent baselines can never move |
| Audio codecs | AAC in `.mp4`, PCM in `.mov`; AAC's run-to-run determinism is proven by gate, not assumed | Trust nothing you haven't hashed twice |
| Fade default | Every soundtrack fades out over the timeline's last second unless explicitly opted out; quarter-sine fades both directions | Endings should not clip mid-note by default |
| Preview audio | A decoded-buffer WebAudio player, clock-synced, hard-guarded out of export; restarts only on real clock jumps | WebKit seeks compressed audio hundreds of ms off target; the mux is the only mixdown that counts |
| Export presets | A curated platform-preset set (Meta/TikTok/YouTube/LinkedIn/X/Reddit/Telegram/CTV/Web + a ProRes master), data-only JSON; user presets in `~/Kookaburra Cut/export-presets/` | Updatable without a rebuild; one registry pattern everywhere |
| Encode spec | A typed spec family with a pinned filter chain (flip → fps → lanczos scale + bt709 tags only when the filter converts); H.265 via static libx265; `hvc1` tagging; faststart | Mismatched colour tags shift colours on-platform |
| Two-pass | Render once to a lossless FFV1 mezzanine at output res/fps, then two-pass file-to-file; a disk-space guard is the one blocking pre-flight | Pass 1 consumes the stream; two-pass over stdin is impossible |
| VBV determinism | Software VBV lanes pin encoder threads to 1 | x264 VBV under threads produces identical frames but differing bytes |
| Loudness | Measured gain only (cached ebur128 through the exact export graph) summed into a single volume slot; true-peak overage warns, never limits | A limiter is content-dependent DSP; a gain is a constant |
| Render at output fps | 30fps presets step the render clock at 30 directly | Half the render time; the 30fps instants are bit-identical to every second 60fps instant |
| Aspects | 16:9 / 9:16 / 1:1 standing, 4:5 first-class but feature-scoped in gates | Gate economy |
| Output naming | Preset/custom exports carry a preset suffix; the frozen path keeps the exact legacy filename | Preset output can never overwrite the files baselines hash |
| Size caps | Estimate vs platform cap with a one-click fit; informative, never blocking | Informative, not paternal |

## Chrome, identity & voice

| Decision | Choice | Why |
| --- | --- | --- |
| Identity | Kookaburra Cut · bundle `com.mpalmes.kookaburracut` · workspace `~/Kookaburra Cut` · toolkit `@kookaburra/toolkit` · env `KOOKABURRA_*` · URIs/events `kookaburra:`/`kookaburra://` | One namespace, no residue of the working name |
| Rename doctrine | Deep rename with hard cuts: no legacy aliases anywhere; "reel" became "project" all the way to the on-disk format | The app is unreleased; back-compat has no customers |
| Lexicon | "project" / "scene" / "stage" as literal working nouns; **"cut"** (the exported film) is the single themed noun, used at threshold moments only; Australian English throughout | Vocabulary law for all future copy |
| Voice | Clear, never loud; no bird-call language; errors and destructive actions stay literal | The call carries because it's clear, not because it's noisy |
| Locked lines | Tagline "Give every feature its moment." · export-done "Your cut is ready: identical, frame for frame." · About "Built after dark in South Australia. Runs entirely on your Mac." | Anchor lines fix the register |
| Design language | Night-studio: blue-black charcoal surfaces that must not read blue at a glance; the preview is the conceptual light source, with no literal glow; a dusty-blue accent and a deliberately brighter focus ring | Evolution of the dark chrome, not a new skin |
| Paint seams | The native background-colour seams (window config, HTML pre-paints, native deflash) always change together | A missed seam flashes the old colour at boot |
| Main window | 46px titlebar (identity · ⌘K action finder · one accent Export button) · right inspector with drill-ins (Scene tab follows the playhead) · segmented per-scene playback bar · camera pill + collapsible animation lane | The stage stays the centre; editing lives in one predictable panel |
| Shortcuts | Native menu accelerators are the reliable shortcut channel; DOM listeners are the fallback | AppKit owns keys like ⌘Z and ⌘K before the webview ever sees them |
| Overlay contract | Every overlay mounts on the shared modal-overlay layer; Escape closes top-most first | Transport/nudge key arbitration keys off it |
| Migration pattern | Replace a UI surface by extracting its write funnel to a shared hook, running old and new against it, then deleting the old surface | Deletion becomes a zero-behaviour-risk change |
| Icon & wordmark | The icon is original Icon Composer artwork used verbatim (never re-masked); the wordmark is a one-off SVG; no display typeface is bundled | Re-masking a finished export double-borders it; type licensing stays clean |

## Licensing posture

The project's own code is dual-licensed **MIT OR Apache-2.0** (Tauri's
convention; see `LICENSE-MIT` / `LICENSE-APACHE`, inventory in `NOTICE.md`).
The device model is a licensed, purchased asset kept out of the repository
(gitignored, bundled into the maintainer's builds); clones build against a
committed generic placeholder, and using accurate branded device models
(including the committed preview renders, shipped with disclaimers) is a
deliberate, recorded product decision. The ffmpeg sidecar **stays the GPL
build** (libx264/libx265) as the shipped default: the deterministic default
encoder outranks licence convenience; the LGPL build flag remains an escape
hatch only, and binary releases carry a corresponding-source pointer. Bundled
fonts are OFL 1.1 (`src/assets/fonts/OFL.txt`); bundled HDRIs are CC0
(Poly Haven).

## Non-goals & deferred

Deliberately out, still true today:

- **No network surface beyond the embedded terminal.** Local-only otherwise: no
  telemetry, auto-update or crash reporting. The optional embedded Claude Code
  terminal talks to Anthropic only while explicitly in use.
- **No per-clip audio.** `VideoClip` and device screens are picture-only; one
  soundtrack per project is the audio model.
- **No DOM for exported pixels**, ever. Editor chrome only.
- **No TAA or any history-dependent rendering.** The recorded escalation path
  for shimmer is jittered supersampling of a single instant, opt-in at export.
- **No animated theme tokens.** Theme values are static per scene; motion comes
  from the timeline; transitions blend pixels.
- **No multi-file workspace scenes**: no relative imports, no npm packages in
  user projects.
- **AV1, MP3, 44.1 kHz and big-endian PCM** are out; 44.1 kHz would break the
  sample-exact audio graph.
- **29.97fps** is out (frame rate must divide 48 000).

Parked (specs recorded, unbuilt):

- `AssetCycler` (judged unlikely to be used).
- By-child stagger for `AnimatedGroup` lockups.
- Scrub audio; audio cards in the media browser.
- In-canvas element selection (the inspector follows the playhead instead).
- Video-editor undo.
- Device media `contain` fit (dropped; cover is the rule).
- Mirror/reflective floors; dither-noise anti-banding (determinism unverified).
- Promoting 4:5 into the standing gate matrix.
- Threshold illustrations and a marketing page.
- HEVC software-CRF determinism is unproven: treat it as draft-class until a
  gate proves it.

## Where live detail lives

- [architecture.md](./architecture.md): rendering/export architecture, stack
  and versions, packaging notes.
- [determinism.md](./determinism.md): the export contract, failure modes, how
  to verify, current baselines.
- [design.md](./design.md): the application chrome's design language.
- [voice.md](./voice.md): voice, lexicon and the locked copy lines.
- `kookaburra-scene-authoring` skill (`.claude/skills/`): the scene rules and
  toolkit reference; `kookaburra-export-presets`: the preset schema and flows.
