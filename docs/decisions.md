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
| Gate economy | The default gate is ONE run: the feature-matched project, 16:9 (`pnpm gate` = showcase-tour). The legacy sentinel (`ws:launch-2026`) gates PRE-MERGE (`pnpm gate:merge`, one boot) and at rebases/phase closes, not per change (2026-07-25, Michael). Full matrices only for engine-wide constants, deliberate rebases and phase closes | Data variations are not code paths; verifies are minutes each; a legacy regression still cannot merge, it is just caught per PR instead of per change |
| Sentinel trimmed via a documented splice | `ws:launch-2026` re-frozen at 8.2 s on 2026-07-25 (Michael): full-length EQUAL proven same-session, then the trimmed anchor recorded (`eb89826c…`); pre-trim manifest backed up. Any future sentinel edit must follow the same splice procedure | Early in the project the sentinel was a growing per-run time sink (multi-worktree queueing); the splice preserves the evidence chain through the cut, at the accepted cost of dropping past-the-cut frames from the legacy proof |
| Rebase discipline | Engine-wide constants (fps, MSAA, shadow type, blending domain, atlas order) are rebase events, undertaken deliberately and re-proven | The baseline set is an asset; it moves on purpose or not at all |

## Project format & authoring

| Decision | Choice | Why |
| --- | --- | --- |
| Project format | A folder: `project.json` manifest + `scenes/*.tsx` + per-scene sidecar JSON + `assets/` | Files a human, an app and an agent can all edit |
| Scene definition | One `defineScene({ id, durationMs, Scene })` default export per file | One discoverable shape |
| Scene ids are unique | Reverses "ids may collide by design" (2026-08-06): files stay the identity, but a project's `defineScene` ids must be distinct. `duplicate_scene`, `copy_scene_to_project` and `scaffold_scene` mint unique ids; workspace projects silently heal duplicate ids on load, after the trust gate; React mount keys derive from the manifest file, never the TSX id | Duplicate React keys orphan fibers: ghost scene hosts and overlay panels leak and render stale text |
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
| Paragraph delivery | Within one copy leaf, `\n` is a paragraph and a blank line separates animation-delivery groups | Works identically from props, sidecars, themes and agent-authored text |
| Inspector Text content | One stable Text group owns an ordered list of Icon, Title, Subtitle and Bullets leaves, including repeated types, plus group alignment; existing flat managed blocks resolve as one implicit group without a load-time rewrite | Content duplicate/delete stays atomic, while repeated leaves let one group build richer lockups and leaf keys preserve style, motion and older scene data |
| Group lockups | `AnimatedGroup` samples a preset as one unit over icon+text compositions; pivot is the group origin; alpha propagates by context, CPU-side | Measured-bounds pivots depend on load timing; two material writers would be commit-order-dependent |
| Text looks (2026-08-24) | Named text styles ("Text style" in the UI) live in a `textLook` spec: theme default, whole-spec sidecar override with `textLookForce`/`textLookOverrides`, TSX `look`/`lookParams` props. `outline`/`neon` ride plain troika material props; `gradient`/`offset-print`/`highlight-block`/`frosted`/`arc` extend the v2 stagger material; the 3D looks (`glass-3d`/`chrome-3d`) re-render as extruded twins with motion degraded to whole-block transforms and emoji falling back flat, look dropped. The wave-2 motion pack's and the looks' constants are golden-pinned; the pack shader path strips troika's edge discard via a rewriter pinned to troika 0.52.4's exact bytes | The `textStyle` record was already the per-element override map, so the spec took a fresh name; changing a pinned constant re-renders every project using the pack; troika props keep the block path byte-safe where no shader variant is needed; extrusion gets real scene lighting SDF text cannot, and emoji cannot extrude; the discard strip is what lets bolder weights and soft halos paint past troika's zero-coverage discard, and it must be re-checked on any troika upgrade |

## Studio, workspace & packaged app

| Decision | Choice | Why |
| --- | --- | --- |
| Workspace | `~/Kookaburra Cut`, created silently at first run (2026-07-28: no chooser, Settings moves it); projects are self-contained folders (scenes, assets, per-project `exports/`, own git repo) | Sharing or deleting a project carries everything with it; home-folder root avoids macOS privacy prompts on headless runs, and asking on launch put people in TCC-guarded folders they had to be talked back out of |
| Project trust | Every new project is `git init`-ed with an initial commit | Agent tooling persists trust for git repos; free checkpointing |
| Embedded terminal | xterm.js (DOM renderer) over a native PTY (portable-pty; raw byte channel with flow control; login shell; environment scrubbed so the session presents as plain standalone) | GUI apps inherit a bare PATH; the event system is unsuited to PTY throughput |
| Prompt insertion | Helper wizards paste composed prompts via bracketed paste and never auto-submit | The user reads, tweaks, and presses Enter |
| Scene terminals | The `terminal` sidecar block is interactive DOM in preview and Present but exports its captured snapshot (a styled-run grid in the sidecar plus a baked PNG, the export truth); the start command is PRE-TYPED, never auto-run; scene sessions may opt out of the F-006 workspace cwd confinement to open a user-chosen start path (the path must still exist) | `gl.readPixels` never sees DOM, so interactivity carries zero determinism risk; a `.kbpack` that auto-ran a command on slide view would be arbitrary code execution, while a start path alone executes nothing |
| Live reload | Native source-fingerprint polling re-imports changed scene modules (workspace files sit outside the dev server's watchers); paused during export | An agent's edits appear live without breaking export purity |
| Media library | ffprobe as a second sidecar; content-hash-keyed poster/scrub/probe cache, app-global | Dedupes identical files across projects; one place to clear |
| Image posters | Image posters encode `-pix_fmt rgba`, and every cache entry carries a `POSTER_VERSION` stamp that regenerates IMAGE entries only | Left to negotiate, a pal8 (+tRNS) source encodes a pal8 poster: swscale requantises into a fixed palette and drops transparency, baking an opaque green matte behind transparent PNGs. Videos keep their poster and ~10 scrub frames across a bump |
| Scene thumbs | One centre-frame PNG per scene, stamped per scene (its module plus its sidecar) and captured only when a thumb grid mounts | The whole-project fingerprint moved on every insert, so adding one scene re-scrubbed the playhead through every scene the next time a wizard opened |
| Background ffmpeg cap | Bulk background ffmpeg (poster/scrub generation, clip extraction) queues on a 3-permit semaphore and runs at lowered scheduling priority; exports, the editor render and header-only ffprobe probes are exempt | N media files used to mean N simultaneous full-decode ffmpeg processes saturating every core; foreground work must win |
| Hardware video toggle | Settings › Video: one switch (default on) over every non-gated hardware path (thumbnail decode, clip-extraction lane, editor render), with the sidecar's VideoToolbox support probed live beside it; deterministic exports pin to software regardless | Visibility and a kill switch if VideoToolbox ever misbehaves, without ever making the export contract configurable |
| Video editor | A real second window; non-destructive edit documents referencing sources read-only; single video track, magnetic/gapless timeline; renders via one ffmpeg filter graph back into the project's assets | Originals untouched; the timeline model IS the concat recipe |
| Editor render encoder | The flatten render defaults to VideoToolbox (hardware decode + `h264_videotoolbox` at 0.25 bits/pixel), retrying once with the old `libx264 -crf 18 -preset veryfast` argv on failure | Near-instant renders of an intermediate that final export re-encodes anyway; contract-exempt since downstream determinism reads the rendered file's fixed bytes |
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
| Auto-update (2026-07-16) | Opt-in via tauri-plugin-updater: tri-state consent asked once after first run; launch checks (20h throttle) only while enabled; manual checks work while opted out but persist nothing; installs verify the ed25519 signature, swap in place and relaunch; updater artefacts are hand-rolled post-staple in the release scripts (`createUpdaterArtifacts` would tar the pre-staple bundle) | Supersedes the "no auto-update" non-goal, on the SturtBar privacy model: no network until consent, no identifiers, one ordinary HTTPS request to GitHub; all checks run Rust-side so the webview CSP keeps zero external hosts |
| Capture hygiene | Thumbnails/snapshots never run during export or autorun; list surfaces read cached thumbs only; the only legal live fallback captures the current frame without seeking | Borrowed-clock captures blip the playhead and race the exporter |
| Packs are zip (2026-07-27) | `.kbpack` is a zip with per-entry methods (store already-compressed media, deflate text), not tar+zstd | Zstd would win 8-13% on paper, but packs are dominated by mp4/png/glb where every compressor saves 1-3%, and the zip central directory lets import verify `manifest.json` without inflating a 500 MB payload, which is the whole consent flow |
| Pack provenance is TOFU | Ed25519 keypair per install, detached signature over the manifest's exact stored bytes, `keyId` remembered in settings; no CA, no Developer ID | The realistic threats are corruption, tampering in a forwarding chain and a typed-in author field; a paid cert would conflate "Apple knows this developer" with "this pack is safe" and make community packs second-class. The UI states plainly that a publisher NAME is never verified |
| Packs use a Save dialog | The one place the frontend supplies a path, against the standing "paths are computed in Rust" rule | The path comes from a native OS surface the user drove, and `pack::commands::validate_destination` re-checks extension, absoluteness, a writable parent, and refuses `/System`, `/Library`, `/usr`, `/bin`, `/sbin`, `/private/var/db`, the app's own `$APPDATA` and anywhere inside the `.app`; the writer never goes near a shell |
| Pack trust is not code trust | Importing writes files and never compiles; each imported project still hits F-001 on first open | Two distinct consents ("I accept these files", "I will run this code"), and a trust grant is path plus fingerprint bound so an imported project cannot inherit one |
| Packs ship font BYTES | A pack carries the pinned `.ttf`/`.otf` and its `instanced` provenance, never just `(family, weight)` | `fonts.rs` exact-pins `allsorts` because instancer output participates in export baselines; re-pinning on the recipient's machine would silently diverge exports with nothing able to catch it. Faces whose OS/2 `fsType` says Restricted travel as a name-only reference instead |

## Devices, media, camera & stage

| Decision | Choice | Why |
| --- | --- | --- |
| Device identity | Real product names with accurate licensed models ("iPhone 15 Pro, Natural Titanium") | Best UX; ubiquitous industry practice for mockup tooling |
| Device assets | Paid product glbs are **not committed**; they live in a gitignored folder and are bundled into maintainer builds only. The original Android glb is committed and freely distributable | Paid licences cover app embedding, not source redistribution; a clean clone still needs one honest, functional device |
| Device availability | Pickers show only models whose complete glb is in the build. Unknown and unavailable saved ids render through the Android specification without rewriting the document | A saved project remains portable, screen media keeps working, and restoring licensed assets restores the requested model |
| Colour variants | Material-name overrides on one glb, using the vendor's authored material values as exact replacements | Four glbs for four colours would quadruple the bundle for identical geometry |
| Device motion | Opt-in only (2026-07-17): every scaffold path (Rust scaffolder, new-scene wizard, inspector quick-add) writes `preset: "none"`; motion is a deliberate per-device sidecar choice | A device should hold still until the author asks it to move |
| Screen media | One shared clip-texture hook plays video/image media on each glb's declared screen material, using the same pre-extracted CFR frame pipeline as `VideoClip` | One clip pipeline for every consumer |
| Media hosting (2026-08-23) | Where a scene media entry renders follows its authored HOST alone, never its kind or its chrome: `stage` is a world card, `overlay` is the frame layer for both kinds, `window` is the floating world-space clip (video only, reading the overlay placement numbers so it needs no block of its own) | A kind is not a placement. Inferring hosting from kind meant an Edit render, which re-points a still to a rendered mp4, silently moved a placed frame-layer image into the scene's world and shrank it to the window's contain fit |
| Clip playback | Sources pre-extract once to a cached CFR-60 PNG sequence; frame choice is a pure clock function (clamp to hold, modulo to loop) | Seeking an `HTMLVideoElement` is neither exact nor deterministic |
| Clip decode lanes | Extraction is dual-lane: everyday preview and hardware fast-draft exports decode via VideoToolbox into `<sha>-60fps-hw`; deterministic-codec exports (all Verify runs) pin to software decode in the unchanged `<sha>-60fps` dir | Hardware decode is measurably not pixel-identical to software; separate dirs keep the baseline lane unpoisonable while everyday extraction gets the media engine |
| Device shadows | Procedural deterministic contact shadows by default; the stock accumulating helper was rejected | It jitters its light per frame, nondeterministic by design |
| Staged shadows | Real shadow maps (fixed-parameter key light, VSM) only when a scene stages a floor/backdrop; the devices' own presentation shadows stand down there | Silhouette shadows where staging demands them; unstaged projects byte-untouched |
| Backdrops | Cyclorama floor, gradient and image backdrops render unlit at exact colour, with shadows composited via catcher overlays | The surface stays colour-true; the shadow darkens on top |
| Fixed backgrounds | A separate camera-locked `background` slot (colour/gradient/image, optional parallax; video via sidecar only) that composes with world staging; the quad's matrix is rewritten from the live camera immediately before each draw | Pure function of the pose the compositor just applied; transition poses and fov ramps come free |
| Texture crop | Cover-crop baked into per-instance geometry UVs on cloned textures; shared textures are never mutated | Shared caches serve other meshes; mount order must not matter |
| Environments | Bundled CC0 HDRIs, decoded and PMREM-processed in the preload barrier; v9 adds `"none"`, project-relative `.hdr`/`.exr` user maps (missing files throw at resolve time) and the env-mirror `fromScene` bake | Reflections without a network or a race |
| Scene lighting (v9) | Per-scene authored lighting: theme -> project -> scene layers, whole-field replacement; sun + free lights (directional/point/spot/area) + emissive fixtures; hard caps 16 lights / 4 shadow casters / 64 fixture instances, identical in preview and export; Kelvin fit vendored and golden-pinned | Lighting became the primary creative control; caps bound shader permutations, the pinned fit keeps kelvin colours stable forever |
| Lighting keyframes (2026-07-25) | REVERSES the v8 "scene motion of light is out of scope" lock: one sparse whole-rig track per scene (the camera precedent), sampled per render target at the compositor seam, Kelvin-space colour lerp; theme tokens stay static | v8's rule guarded shared theme tokens; v9 lighting is per-scene authored data with the same standing as the camera track, and a keyed value stays a pure function of the timeline |
| Tone mapping + exposure (v9) | The display transform is an explicit per-project contract (`render` block): ACES at 1.0 default (the previous implicit r3f default, so nothing moves), AgX/Neutral/Linear opt in; BOTH render paths switch together (r3f pipeline + the composer's ToneMappingEffect, exposure as a pre-tone-map multiply in each); the transition composite keeps blending in ACES space (self-inverting pair, seam-exact regardless of display curve) | Neutral exists precisely for product-accurate brand colours; two implicit ACES sites drifting independently was the latent bug |
| Fixtures ignore exposure | Fixture glow meshes are `toneMapped: false`, so neither the curve nor exposure touches them (emitters, not surfaces); their paired lights' CONTRIBUTION to surfaces still follows the display transform | A deliberate statement, not an accident: the visible tube should read identically hot at any exposure |
| Per-scene camera | Orbit poses (`target/azimuth/elevation/distance`) in the sidecar, eased segments, shared boundary-key objects, hold-latest sampling; transition frames render each offscreen target under its own scene's pose | "Edit the boundary, both animations move" is the data model, not a sync rule |
| Camera fallback | With no scene tracks anywhere, the resolver returns null and the legacy path runs verbatim; once any scene opts in, every frame's camera is written explicitly | No stale pose can leak across a scene seam |
| Camera rig storage (2026-07-26) | Free flight is a SEPARATE sidecar block (`cameraRig`) behind a `cameraMode` discriminator, not a per-key union on the orbit pose; rig mode with no rig keys falls through to orbit | Null-for-legacy becomes structural: the orbit sampler is untouched code rather than a branch that has to be argued identical. The cost is that no single segment can run orbit-to-free, which scene-level convert covers |
| Rig interpolation | Through a canonical pose (position + unit forward + aim distance), with the distance interpolating logarithmically | A look POINT swings through the camera on a 180 degree pan-in-place; a direction plus a distance simply rotates, and log distance makes a 6 -> 1 push read evenly |
| Rig smoothing | Per-segment `smooth`, ABSENT means smooth; centripetal Catmull-Rom over POSITION only, parameterised by the already-eased progress, with missing end neighbours REFLECTED rather than duplicated | Rig paths should curve out of the box, and the block is new so the default carries no legacy risk. Splining the aim as well gives a wandering look direction; duplicating an endpoint double-eases a lone segment and leaves it no start tangent to aim along |
| Rig aim | Per-key `point` / `tangent` / `object`, with a baked `at` stored on every mode; bindings resolve at load and the engine never writes them back | A deleted device or a degenerate tangent degrades to the last known shot instead of swinging to the origin, and rebaking stays an editor concern so the sampler stays pure |
| DepthStage bands | Four pinned depths (`foreground` 1.8, `content` 0, `midground` -2.4, `backdrop` -5.5) as named child slots, each sizing its rect from the scene's rig travel envelope | A fly-through needs layers at known depths, and a full-bleed layer sized for a static camera stops being full-bleed the moment one travels. Named slots keep the depths a contract rather than a per-scene guess |
| Depth of field storage (2026-08-04) | A sparse `dof` block on camera pose keys in BOTH modes, per-field carry-forward along the track, first authored mode (depth/tilt) is the scene's; artistic fields (`blur`/`range`/`focus`, tilt `band`/`offset`/`angleDeg`) with autofocus following the pose's aim distance when `focus` is absent | Riding the existing keyframe machinery means rack focus needs no new lane or linking concept, and carry-forward makes a rack restate only `focus`. Artistic-over-physical was the locked product call; the schema stays implementation-neutral so the stock effects could be replaced without a data migration |
| Depth of field rendering (2026-08-04, lanes 2026-08-06) | TWO lanes by project. Effects projects: stock `postprocessing` DepthOfField/TiltShift at the composer chain's head, project-stable union, per-frame CPU uniforms, HDR side composer for transitions/compare. Effects-FREE projects: every frame renders on the original byte-identical paths and an ACTIVE pose is blurred in place (finished pixels copied, dof chain over them with the output encode off, scene depth from a dedicated pre-pass); display constants are rebase-class | A composer-owned tone map regrades display-domain exact-colour surfaces the direct path shows raw (and canvas/target tone-map program variants diverge on ANGLE Metal), so toggling dof in an effects-free project visibly washed the frame; blurring the finished bytes makes a zero-blur frame BIT-IDENTICAL to the composer-free path, which no curve-matching can guarantee. Per-side dof either way keeps a rack riding INTO a crossfade |
| Depth of field crisp rule (2026-08-04) | Everything blurs by its true depth, device screens and SDF text included; no exclusion masks | That is what depth of field IS; the exact-colour contract holds at the focal plane, so whatever is focused stays exact. Authoring guidance keeps critical text near focus |
| Depth of field styles (2026-08-05) | Four more `mode`s on the same block: soft ("Dream", fixed-kernel diffusion + glow), radial ("Burst") and directional ("Swipe") as one convolution smear effect, and split (two focus distances across a divider). Split and the depth `squeeze` field run on ALWAYS-PATCHED stock materials (CoC gains the second plane, the bokeh kernels an X squeeze), uniform-neutral by default, with anchors that throw on a postprocessing upgrade | One patched program everywhere beats union-keyed shader variants (no chain-shape explosion, one code path); the neutral uniforms keep depth VALUES identical to stock, but the forked programs made dof-active fixtures a deliberate re-record, accepted when tilt already proved screen-space modes. One smear effect serves burst and swipe because EffectPass allows a single convolution member and the modes are exclusive per scene |
| Envelope sizing | A fixed 64-sample summary of the track feeds SIZING maths only, with each existing constant as its floor | Sampling tied to frame rate or scene length would resolve differently in preview and export; taking the constant as a floor means a rig can only ask for MORE, so no rig-less scene moves and no global rebase happens |
| Rig roll | `rollDeg` applies as a `rotateZ` after `lookAt`, behind a falsy guard, and only from the per-scene rig | `lookAt` cannot express roll (fixed world up); the guard is what keeps every legacy pose's matrix bit-for-bit unchanged, and the project-level track is a compatibility path, not a feature |
| Cross-scene continuity | An opt-in flag on a rig's first key, resolved at LOAD as a pose substitution; the resolver, compositor and export loop are untouched | Continuity is an authoring convenience, not a new render concept. A project-level track would have re-opened the per-scene contract for one feature |
| Ghost path overlay | The rig's path renders as DOM above the canvas via a pure world-to-stage recompute (`cameraProject.ts`), never a live-camera read or r3f bridge; dots drag in the view plane | Export cannot see any of it by construction, and the overlay needs no render-path hooks |
| Camera UI | Overlays and edit state are DOM above the canvas, in UI-only stores | The export cannot see them by construction |
| Effects | A project declaring any effect routes every frame through one composer built from the project-wide effect union; per-scene overrides drive uniforms only; only allow-listed time-free effects exist | No mid-project shader recompiles; no effect knows the time |
| Colour grades | 3D LUTs apply post-tone-map (LDR sRGB domain); mid-project swaps are uniform writes; one LUT size per project | Standard `.cube` grades are authored for LDR input; the public setter recompiles |
| Persistent layers | A project's persistent module mounts once outside all scene groups and is drawn exactly once per frame, never into both transition targets | An always-visible object would cross-fade against itself |
| Overlay cutout vs panel fill (2026-08-23) | The cutout SHAPE alone decides whether a scene's world renders through a window (`framesThroughCutout`, read by the layout narrowing, the compositor's scene target and the gizmo seam); the panel fill only decides what paints outside it. A transparent panel takes the framed path like any other and fills the outside with the scene's own backdrop; only `shape: "none"` renders full-bleed | Owner ruling: layout and render must agree. `SceneHost` had always narrowed `useFormat()` on the shape, while the compositor skipped the slide pass for a transparent panel, so those scenes were laid out for a window they never got |
| Layered-screenshot storage | One singular sidecar block (`layeredScreenshot`) whose `layers[]` carries the multiplicity, plus `animatedTrack: "camera" \| "layeredScreenshot"` (absent = camera) | Closer to the singular `camera` block than the `devices` array; the toggle stands one track down without deleting the other's keys |
| Layered-screenshot layout | Chained strips: one root per layer (`attach: null`), every other item hangs off a neighbour's side; the pure solver walks the graph, re-centres on the bounding box and auto-fits the safe frame at spread 0 | Rows and columns grow in any direction under one invariant (rooted, acyclic), which validation can actually enforce |
| Layered-screenshot pose | The pose (`spread/azimuth/elevation/zoom/pan`) is the stack group's own scene-local transform, sampled from `localMs` inside the primitive, never the world camera | Zero compositor/exporter changes; the camera track keeps its one meaning |
| Card treatment | Rounded-rect SDF mask + hairline stroke patched into the stock material, analytic soft-shadow quads; radius from an optional `Theme.card` token with a tuned constant fallback | Cards follow any theme that opts in without editing the bundled themes |
| Global screenshots | Flat `~/Kookaburra Cut/screenshots/` folder behind a Project/Global picker toggle; picking always copies into the project's `assets/` (copy-on-use) | Projects stay self-contained; deleting a global file can never break one |

## Transitions, audio & export presets

| Decision | Choice | Why |
| --- | --- | --- |
| Transition pack | Crossfade, dip, slide/push, wipe, blur, zoom, whip, procedural luma/iris, glitch, slice, dissolve, warp: normalised specs with per-type defaults; unknown types degrade to crossfade with a warning | Hand-editable JSON must degrade, never throw |
| Transition easing | Optional per-spec `ease` (smooth/snappy), applied CPU-side to progress with endpoints preserved; absent means linear, so stored specs keep exact bytes and the picker only defaults NEW transitions to smooth | Better feel without moving one existing pixel |
| Transition ownership | Manifest v2 stores a transition on the OUTGOING scene (plays at its end); legacy files are read-shimmed to identical output and migrated on the first scenes-array write | The authoring model matches editing intuition without moving a single rendered pixel |
| Glitch randomness | Integer hash (PCG), never `fract(sin)` | Integer ops are exact across shader compiles |
| Shader generations | Extended transitions are separate GLSL3 materials, and the v14 pack (slice/dissolve/warp) a third generation; earlier programs stay source-identical | Legacy-project byte-identity is structural |
| Transition picker | One small live-GL preview drives the real shipping shaders over cached scene thumbs; no committed preview assets, no capture | Previews cannot drift from the shaders; capture would scrub the stage |
| Soundtrack | One per project (`project.json` `audio` block): file, gain, fades, start offset | One track covers the product need without a mixing surface |
| Audio determinism | Sample-exact 48 kHz filter graph built in Rust: integer sample counts, pad-or-trim to exactly the video's length, bitexact flags; the no-audio argv is byte-frozen | Muxer heuristics are not a duration contract; silent baselines can never move |
| Audio codecs | AAC in `.mp4`, PCM in `.mov`; AAC's run-to-run determinism is proven by gate, not assumed | Trust nothing you haven't hashed twice |
| Fade default | Every soundtrack fades out over the timeline's last second unless explicitly opted out; quarter-sine fades both directions | Endings should not clip mid-note by default |
| Preview audio | A decoded-buffer WebAudio player, clock-synced, hard-guarded out of export; restarts only on real clock jumps | WebKit seeks compressed audio hundreds of ms off target; the mux is the only mixdown that counts |
| Export presets | A curated platform-preset set (Meta/TikTok/YouTube/LinkedIn/X/Reddit/Telegram/CTV/Web + a ProRes master), data-only JSON; user presets in `~/Kookaburra Cut/export-presets/` | Updatable without a rebuild; one registry pattern everywhere |
| Encode spec | A typed spec family with a pinned filter chain (flip → fps → lanczos scale + bt709 tags only when the filter converts); H.265 via static libx265; `hvc1` tagging; faststart | Mismatched colour tags shift colours on-platform |
| Hardware ProRes | `prores_videotoolbox` as a fast-draft lane beside `prores_ks`: profile-only (`-profile:v 3`), `p210le` surface format, no `-vendor` (a `prores_ks`-only option), excluded from Verify like every VideoToolbox lane | The M-series ProRes engines encode at the same quality class as software in a fraction of the time; masters that must be byte-reproducible keep `prores_ks` |
| Two-pass | Render once to a lossless FFV1 mezzanine at output res/fps, then two-pass file-to-file; a disk-space guard is the one blocking pre-flight | Pass 1 consumes the stream; two-pass over stdin is impossible |
| VBV determinism | Software VBV lanes pin encoder threads to 1 | x264 VBV under threads produces identical frames but differing bytes |
| Loudness | Measured gain only (cached ebur128 through the exact export graph) summed into a single volume slot; true-peak overage warns, never limits | A limiter is content-dependent DSP; a gain is a constant |
| Render at output fps | 30fps presets step the render clock at 30 directly | Half the render time; the 30fps instants are bit-identical to every second 60fps instant |
| Aspects | 16:9 / 9:16 / 1:1 standing; 4:5 / 5:4 / 3:2 / 2:3 plus Phone / Phone Landscape (`phone` / `phone-landscape`, the iPhone 17 Pro panel at its native 1206×2622, under the 2160 short edge by choice) first-class but feature-scoped in gates (whether any joins the standing matrix stays an open question) | Gate economy; a phone cut should match the panel it plays on |
| Aspect ids | Slug-safe ids (`phone`, not a ratio) with `aspectLabel()` owning the display names | The export path slugs the aspect into filenames through the Rust slug check |
| Output naming | Preset/custom exports carry a preset suffix; the frozen path keeps the exact legacy filename | Preset output can never overwrite the files baselines hash |
| Size caps | Estimate vs platform cap with a one-click fit; informative, never blocking | Informative, not paternal |
| Comparison model | A before/after comparison is ONE scene: side A is the doc itself, `compare.b` overrides derive side B, composited under a mask on the transition A/B pools (docs/comparisons.md) | Self-contained scenes round-trip through packs, verify and the timeline like any other |
| Comparison blending | Each side renders fully in its own theme/lighting/background and only finished pixels mix under the mask, in the display domain (the cross-theme transition rule); chrome colours are theme tokens | Perceptual masking, and per-side looks stay self-consistent |
| Divider semantics | `value` is the mask line's position along the sweep axis with the before on the origin side; the divider track rides the shared KeyedTrack model (eased segments, hold outside) | The slider's spatial mapping, and one keyed-track vocabulary everywhere |
| Comparison display transform | Both sides share the project's tone mapping/exposure (v1) | The one renderer-level knob; per-side curves are deliberate-rebase territory |
| Comparison transitions | A transition adjacent to a comparison blends its BEFORE side only during the window, said in the picker; hard cuts show the full comparison | A nested composite costs another pooled target; measured need first |

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
The paid product models are licensed, purchased assets kept out of the
repository (gitignored, bundled into the maintainer's builds). Clones offer the
committed, freely distributable Android model only; saved references to unavailable models
render as Android without rewriting the document. Using accurate branded device
models (including the committed preview renders, shipped with disclaimers)
remains a deliberate, recorded product decision. The ffmpeg sidecar **stays the GPL
build** (libx264/libx265) as the shipped default: the deterministic default
encoder outranks licence convenience; the LGPL build flag remains an escape
hatch only, and binary releases carry a corresponding-source pointer. Bundled
fonts are OFL 1.1 (`src/assets/fonts/OFL.txt`); bundled HDRIs are CC0
(Poly Haven).

## Non-goals & deferred

Deliberately out, still true today:

- **No network surface beyond the embedded terminal and the opt-in update
  check.** Local-only otherwise: no telemetry, no crash reporting. The optional
  embedded Claude Code terminal talks to Anthropic only while explicitly in
  use; the update check (off by default, asked once, see the auto-update
  decision above) asks GitHub for the release manifest and sends no
  identifiers.
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
- `kookaburra-scene-authoring` skill (`.agents/skills/`): the scene rules and
  toolkit reference; `kookaburra-export-presets`: the preset schema and flows.
