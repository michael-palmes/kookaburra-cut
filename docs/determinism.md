# Determinism

> The byte-identical-export contract: what must hold, what breaks it, and how to
> test it. Architecture overview: [architecture.md](./architecture.md); the
> locked-decisions log: [decisions.md](./decisions.md).

Kookaburra Cut's export must be **byte-identical on re-render**: two consecutive
exports of the same project produce identical files, in every aspect, including
multi-scene projects with transitions, effects and audio. Everything in the
engine and the authoring rules exists to protect this.

> **Frame rate: 60fps app-wide** (`FPS` in `engine/format.ts`). The export steps
> the clock at `tMs = frame × 1000 / 60`, and video clips are normalised to CFR 60
> so one frame index maps 1:1 to one source frame. Changing the frame rate
> re-baselines the byte-identical confirmation: a full re-verify across all
> aspects.

## The rule

> Frame N is a pure function of the timeline value `t`.

Given the same project and the same `t`, the rendered pixels must be identical,
run to run. (Hashes are same-machine facts: fixed-function GPU work is stable per
GPU/driver, not across fleets.)

## What breaks it (and the fix)

| Failure mode | Fix |
| --- | --- |
| Reading the wall clock (`Date.now`, `performance.now`, `new Date`, `requestAnimationFrame`, `setTimeout`) | Drive everything from `useTimeline()` / `seek(t)`. anime.js: `engine.useDefaultMainLoop = false`, advance manually. |
| Animating or capturing the DOM | Render only Three.js objects in the one canvas. WebKit taints/races on DOM capture. |
| **Fonts loaded lazily from a CDN** (troika default) | Bundle a local `.woff`; `preloadFont({ font, characters }, cb)` and await it before frame 0; set troika `unicodeFontsURL` to a self-hosted/offline path. |
| troika SDF generated async in a worker | Pre-generate glyphs (preload) and await all text sync before the first captured frame. |
| Video clips via `HTMLVideoElement` seeking | The ffmpeg sidecar pre-extracts each clip to a CFR PNG sequence (cached under `$APPDATA`, keyed by source hash); `VideoClip` samples `frameIndex = floor((localMs − startMs)/1000 × fps)` off the clock. `engine/clips.ts` + `toolkit/media/VideoClip.tsx`. |
| Reading UI state (zustand) in the export path | The exporter uses the pure clock only; it must not read the editor store. |
| **Trusting `flushSync` to commit the canvas tree**: react-dom's `flushSync` does NOT flush the react-three-fiber reconciler; the canvas subtree commits on the r3f scheduler's own timing, so per-mesh readiness hooks can belong to the PREVIOUS frame when the exporter reads them (stale clip texture / stale text) | `ExportBridge` stamps the clock value each canvas commit rendered for; the export loop awaits `awaitCanvasClockCommit(tMs)` before trusting any readiness hook. |
| **Awaiting troika `sync(cb)` naively**: troika has no `isTroikaText` mesh flag (matching on one awaits nothing), silently DROPS the callback when `_needsSync` is false (including mid-typeset), and only kicks changed text in `onBeforeRender` (one frame late) | `awaitTextSync` detects meshes via `material.isTroikaTextMaterial`, kicks a pending typeset itself pre-render, and awaits quiescence via the `synccomplete` event. |
| A mid-run window resize retriggering r3f's size handling (corrupts the export's fixed drawing buffer for every remaining frame) | The frame loop re-asserts the export size/camera aspect if drifted, after the awaits and immediately before the (synchronous) render + readback. |
| Non-preloaded textures/assets | Await all asset loads before frame 0. |
| **A cold-mount suspense holding EVERY scene out of the canvas**: all scenes share one `<Suspense fallback={null}>` (App.tsx); a suspending primitive (`ImageCard`'s `useTexture`) keeps the whole boundary uncommitted until React's retry render lands, and that retry races the export preamble on the wall clock. Frame 0 rendered first captures a scene-less (white) frame. `awaitCanvasClockCommit` cannot catch it: the clock is already committed at its initial 0. | `awaitSceneHostsCommitted(slots.length)`: the preamble's LAST barrier spins until every scene's host has registered (registration is a `useEffect`, which only runs once the boundary's content commits). The preceding asset preloads resolve whatever the suspense was waiting on, so the wait is a few ticks. |
| **A layout that depends on a measurement only the mounted tree can request**: `TitleBlock` cascades its header icon and subtitle off the title's MEASURED block height, but its props exist only once the scene is in the tree, so the preamble cannot pre-warm them the way `preloadPanelMeasures` does for overlay panels. A cold pass would render frame 0 pre-measure while a warm second pass renders it cascaded. | `awaitTitleMeasuresSettled()`, the barrier after `awaitSceneHostsCommitted`: mounted TitleBlocks report their outstanding typesets, and the spin exits only once they have landed AND the tree has re-rendered with them (`engine/titleBlockMeasure.ts`). Single-line text solves to a hard 0 growth, so standing layouts keep their authored constants bit-for-bit either way. |
| **Preview frames interleaving a Verify ×2**: between the two passes the preview driver rendered a wall-clock-varying number of frames (restored clock, preview size), leaking GPU/render state into pass B's first frames | `verifyDeterminism` holds the preview stand-down across BOTH passes; `engine/exportState` is depth-counted so the whole-run hold nests over each pass's own. Pass B starts from exactly the state pass A ended in. |
| **Parallel font preload**: troika claims shared-atlas cells at preload COMPLETION, i.e. fetch-race order, shifting multi-font projects' glyph cells per BOOT (a per-session hash lottery: every run internally consistent, every boot different) | `preloadAppFonts` preloads SEQUENTIALLY in canonical order (Inter Regular, then declaration/ref order), and `loadProject` pre-generates every project face's glyphs BEFORE the scenes mount. See "Fonts". |
| Muxer writing a wall-clock `creation_time` / encoder version tag | ffmpeg `-flags:v +bitexact -fflags +bitexact -map_metadata -1` (set in `start_export`) so the container is reproducible. |
| Hardware encoder (`h264_videotoolbox` / `hevc_videotoolbox` / `prores_videotoolbox`) bit-variance | Default to software `libx264` (deterministic); the VideoToolbox lanes are opt-in fast drafts excluded from Verify. |
| Hardware DECODE (`-hwaccel videotoolbox`) is not pixel-identical to software decode (measured: every frame differs slightly, ~5% of pixels off by 1–3/255) | Clip extraction is dual-lane: the everyday `hw` lane and the baseline `sw` lane own separate cache dirs (`<sha>-60fps-hw` / `<sha>-60fps`), and deterministic-codec exports (all Verify runs) pin to `sw`, so hardware frames can never reach a gated export. `engine/clips.ts` lane rule. |
| **WebKit kills the WebContent process near its 4 GB footprint ceiling** (measured 2026-07-25: a 4K verify's page footprint rode at ~3.9–4.5 GB, dominated by never-freed compositor/composer MSAA render-target pools, ~285–886 MB each; when a periodic check under system memory pressure catches it over 4096 MB the process is killed ("Unable to shrink memory footprint … Killed" in the unified log) and wry auto-reloads the page; window focus does NOT lift the ceiling) | Export frames release the pools they did not touch (`releaseIdlePools` in compositor.ts, `releaseComposer` in effects.ts; the multi-project autorun also resets between legs), dropping the 4K plateau to ~3.2 GB; the SDR pair is lazy so fx projects never allocate it, and verify releases confirmed-identical retained frames early. Transient fx-transition-window spikes can still crest ~4.1 GB on heavy projects (launch-2026), so `runAutoRun`'s reload latch stays the backstop: one benign reload tolerated, then a fast, retryable failure naming this mode. Deeper shave if ever needed: a shared MSAA scratch target with plain resolve textures for the A/B pairs. Diagnose with `log stream --predicate 'process == "kookaburra-cut" AND composedMessage CONTAINS "footprint"'`. |

## The loop (as implemented in `src/engine/exporter.ts`)

```
configureDeterministicEngine();               // anime.js: no rAF
await preloadAppFonts();                      // SDF glyphs ready before frame 0 (SEQUENTIAL: atlas order is contract)
await preextractClips();                      // ffmpeg → CFR frame sequences on disk (cached)
// …models/images/LUTs/environments preloads…
await awaitSceneHostsCommitted(slots.length); // LAST barrier: the scenes are actually IN the canvas
                                              // (a cold-mount suspense can hold ALL of them out)
const total = Math.max(1, Math.round(durationMs / 1000 * fps));
const rgba  = new Uint8Array(width * height * 4);   // one reused buffer
gl.setSize(width, height, false);             // size the preview canvas to 4K for the run
for (let frame = 0; frame < total; frame++) {
  const tMs = frame * (1000 / fps);
  flushSync(() => clock.setCurrentMs(tMs));   // commits the DOM tree only —
  await awaitCanvasClockCommit(tMs);          // …the CANVAS tree (r3f reconciler) commits on its
                                              // own schedule; wait for its stamp before anything else
  await awaitVideoFramesReady(scene);         // current clip frame texture uploaded
  await awaitTextSync(scene);                 // troika typesetting quiescent (kicked pre-render)
  reassertExportSizeIfDrifted();              // guard: a window resize mid-run can't corrupt capture
  renderComposited(gl, scene, camera, hosts,  // active scene(s); composite on transitions
                   resolveAt(slots, tMs));    // (single-scene frames take the direct-render path)
  ctx.readPixels(0, 0, width, height, ctx.RGBA, ctx.UNSIGNED_BYTE, rgba);
  await invoke("push_frame", rgba);           // → Rust → ffmpeg stdin (vflip there)
}
```

`gl={{ preserveDrawingBuffer: true }}` is mandatory on the `<Canvas>` or the
readback can come back cleared in WKWebView.

**Why `awaitCanvasClockCommit`.** The scene lives in the **react-three-fiber
reconciler**, and react-dom's `flushSync` does not flush it; the canvas subtree
commits on the r3f scheduler's own timing (usually during the loop's IPC awaits,
which is why the race hid for so long). Until that commit lands, per-mesh
readiness hooks (`videoFrameReady`, troika state) still describe the *previous*
frame, so awaiting them can capture a stale clip texture or stale glyphs.
`ExportBridge` stamps the clock value each canvas commit rendered for; the loop
waits for the stamp to equal `tMs`. Deterministic by construction: the wait's
duration varies, its outcome never does.

**Why `awaitTextSync` (and its sharp edges).** A primitive whose text changes
each frame (e.g. `AnimatedCounter`) triggers async troika typesetting. Three
traps, all hit in practice: troika's mesh carries **no `isTroikaText` flag**
(detect via `material.isTroikaTextMaterial`, or you await nothing); `sync(cb)`
**silently drops the callback** when `_needsSync` is false (including while a
typeset is in flight), so quiescence must be awaited via the `synccomplete`
event; and changed text is only kicked by troika in `onBeforeRender` (one frame
late), so the exporter kicks a pending typeset itself before rendering.

**Time comes from the clock store, not the editor store.** `useTimeline()` reads
`engine/clock.ts`; the export loop drives that store from a pure frame-index
value and never reads UI state.

## Multi-scene sequencing & transitions

A project is a sequence of scenes on the one global clock.
`engine/sceneTimeline.ts` (pure, unit-tested) maps a global `t` onto the 1 or 2
active scenes and their scene-local times, using the **overlap / cross-dissolve**
model: a transition pulls the next scene's start back, so
`total = Σdurations − Σoverlaps`. `useTimeline()` derives `localMs` from the
enclosing `<SceneHost>`'s start. All scenes mount at once; the compositor gates
per-frame `visible`.

Transition ownership is manifest-versioned: v2 stores each transition on the
OUTGOING scene (it plays at that scene's end); legacy unversioned manifests
stored it on the incoming scene. `outgoingSceneTransitions` shifts legacy files
in memory so both render byte-identically (the flip is a pure relabel, proven by
the standing baselines holding EQUAL), and any native scenes-array edit migrates
the file on disk before mutating it.

Rendering goes through **one** function, `engine/compositor.ts#renderComposited`,
called by both the preview (`CompositorDriver`, a `useFrame` priority-1 takeover)
and the exporter, so they cannot drift. Two paths:

- **Single active scene → direct `gl.render`** to the default framebuffer. We
  deliberately do NOT route single scenes through render targets: the 8-bit
  target round-trip would change the bytes. Most frames take this path.
- **Two active scenes (a transition) → offscreen composite.** Each scene renders
  to its own `WebGLRenderTarget`, then a fullscreen pass blends them.

Determinism rules specific to the composite path:

- **Tone-map once, encode once, per path.** No-effects: scene passes tone-map
  (ACES) via the live r3f pipeline into the 8-bit targets, whose stored bytes are
  the correctly-encoded image (hardware `SRGB8_ALPHA8`); the composite re-encodes
  its hardware-decoded samples and writes display bytes straight to the canvas:
  net zero conversions. Effects: scenes render **un-tone-mapped** into
  `HalfFloatType`/linear targets (8-bit targets would clamp >1.0 linear BEFORE
  the composer's ACES and dim highlights) and the composer still owns the
  project's single ACES + encode.
- **Blending domain.** Both composite variants mix in the **display (encoded
  sRGB) domain**: a dissolve is a perceptual effect; linear-light mixing
  back-loads the apparent fade. Sample semantics matter: three allocates hardware
  sRGB storage for `UnsignedByteType` + `SRGBColorSpace` render targets, so
  `texture2D()` returns hardware-DECODED linear; a shader that assumes encoded
  samples and decodes again displays `srgbToLinear(image)` for every transition
  frame (a whole-frame "snaps dim / snaps back" bug). The SDR shader's
  `sampleDisplay` re-encodes the sample (recovering the exact stored bytes; the
  composite at progress 0/1 equals the neighbouring solo frame byte-for-byte),
  and the effects-path shader blends through three's exact ACES forward/inverse
  pair (`engine/acesCurve.ts`, golden-pinned, self-inverting → seam-exact within
  fp32; the encoded mix is clamped ≤ 0.999 before inversion so blown-out/toe
  pixels land back at white/black after the composer re-tone-maps). Slide/wipe
  select whole pixels: display-encoded on the SDR path, raw linear HDR on the
  effects path; `dip` lands on the **authored hex**. **Accepted residual:**
  inside transition windows MSAA resolves in the sRGB target (linear-domain
  average) vs the canvas (encoded-domain average), so AA **edge** pixels sit
  ~1 LSB brighter, sub-perceptual.
- **`progress` (and `direction`) are CPU-computed** and passed as uniforms (
  never derived from time inside GLSL), so the frame stays a pure function of `t`.
- **MSAA 4×** on all A/B targets (`samples: MSAA_SAMPLES`); **`NearestFilter`**
  with targets sized 1:1 to the drawing buffer (no bilinear taps). Target
  type/colorSpace ride the verify `renderStateFingerprint` (`compositorTargets`).
- **Orientation:** the composite samples targets with straight UVs (the 2×2 plane
  maps uv(0,0)→clip(−1,−1)), so the composited default-framebuffer orientation
  equals a direct render. The existing Rust `vflip` stays correct.
- **State hygiene:** every renderer flag the compositor touches (render-target
  binding, `autoClear`, each host's `visible`) is snapshotted and restored; the
  composite always ends bound to the default framebuffer before `readPixels`.
  `preserveDrawingBuffer: true` still applies.

The extended transition types (blur, push, zoom, whip, procedural luma/iris,
glitch) live in **separate GLSL3 materials** (`engine/transitionShader.ts`) so
the original crossfade/dip/slide/wipe programs stay source-identical, and the
v14 pack (slice, dissolve, warp) is a third generation for the same reason;
legacy projects' byte-identity is structural. Glitch/slice/dissolve randomness
is an integer PCG hash (never `fract(sin)`: integer ops are exact across
compiles); all tap counts and per-type defaults are export contract; unknown
transition types degrade to crossfade with a warning. Progress easing
(`ease: smooth | snappy`) is applied CPU-side before the uniforms, endpoints
preserved; absent means linear, so stored specs keep exact bytes.

## Embedded video

`VideoClip` renders a source video without ever seeking an `HTMLVideoElement`:

- **Pre-extract, once, cached.** On demand (first preview or export), the Rust
  `extract_clip_frames` command runs the ffmpeg sidecar to decode the source into
  a **constant-frame-rate** PNG sequence at 60fps (`-vf fps=60 -fps_mode cfr`).
  This normalises variable-frame-rate sources (e.g. screen recordings) so
  sampling is exact. Frames land in `$APPDATA/cache/clips/<sha256>-60fps/` keyed
  by the source-file hash; a `.done` marker means a re-run reuses them.
  PNGs are written with `-compression_level 1 -pred 0` (identical pixels,
  roughly 2x faster and 2x larger; only decoded pixels matter downstream).
  `engine/clips.ts`.
- **Two decode lanes.** VideoToolbox hardware decode is measurably NOT
  pixel-identical to software decode, so extraction is lane-split: preview and
  hardware fast-draft exports use the `hw` lane (`-hwaccel videotoolbox`, cache
  dir `<sha256>-60fps-hw`); deterministic-codec exports — which includes every
  Verify run — pin to the `sw` lane (software decode, the unchanged
  `<sha256>-60fps` dir the standing baselines were recorded from). Separate dirs
  make cross-lane cache poisoning impossible. The lane follows the export
  codec's class (`laneForCodec`, `engine/clips.ts`); the accepted consequence is
  that preview matches fast-draft exports bit-for-bit while deterministic
  exports differ imperceptibly (Δ1–3/255) on clip pixels only.
- **Sample purely.** `VideoClip` computes
  `frameIndex = floor((localMs − startMs)/1000 × 60)`, **clamped** to
  `[0, frameCount−1]`: it holds the first frame before the clip starts and the
  last frame after its footage ends. A pure function of the clock, so preview and
  export agree. `engine/clipFrame.ts` (unit-tested). Looping consumers (video
  background fills) use the modulo branch (`((raw % n) + n) % n`, exact even for
  negative time), while the clamp path stays byte-untouched for every holding
  consumer.
- **Stream with a small LRU.** Frames load via a Rust `read_clip_frame` command
  (raw bytes → `createImageBitmap` → `THREE.Texture`); only ~12 decoded textures
  are resident at once, so a long 4K clip never holds thousands in memory.
- **Gate the capture.** Each clip publishes `userData.videoFrameReady`; the
  export loop awaits `awaitVideoFramesReady(scene)` (beside `awaitTextSync`) so
  the correct frame's texture is uploaded before `readPixels`. The clip is an
  ordinary mesh in its `<SceneHost>` group, so it flows through the compositor's
  fast and transition paths unchanged.

Layout uses `fit` (`contain` letterboxes, `cover` fills+crops) computed from
`useFormat().frame` and the clip aspect. One clip serves every aspect. Clips are
picture-only; sound belongs to the project soundtrack (below).

## Audio

A project may declare ONE soundtrack (`project.json`
`audio: { file, gainDb?, fadeInMs?, fadeOutMs?, startOffsetMs? }`,
assets-relative). The output hash covers the audio bytes, so `Verify ×2` gates
the mix like every pixel. Rules:

- **The null path is byte-frozen.** A project without `audio` produces the EXACT
  pre-audio argv (`-an` and all); no-audio baselines can never move because
  audio exists.
- **Sample-exact, never duration-approximate.** `AUDIO_RATE` is fixed at 48 kHz
  so samples-per-frame is an integer (800 at 60 fps; changing either is an audio
  rebase). The Rust-built `-af` graph trims the offset by INTEGER sample count,
  then `apad=whole_len=N,atrim=end_sample=N` with `N = total_frames × 800`:
  pad-or-cut to exactly the video's length. Never `-shortest` (muxer interleaving
  heuristics are not a duration contract). Fades are `afade` with fixed-decimal
  seconds derived from integer ms; gain is `volume=<dB>`; every filter string is
  identical run-to-run.
- **Every soundtrack fades out at the TIMELINE's end by default.** `fadeOutMs`
  omitted → `DEFAULT_AUDIO_FADE_OUT_MS` (1000); an explicit `0` opts out. The
  default is applied ONCE, in `loadProject`'s audio resolver
  (`withAudioDefaults`, engine/project.ts): preview and export read the same
  resolved object, so the lanes cannot disagree. Fade curves are `curve=qsin`
  (quarter-sine, both directions; the argv shape is pinned by
  `audio_graph_tests`), and the fade-out anchor is the padded/cut timeline
  length, never the track's own end. The null path is unaffected by ANY of this:
  no `audio` block, no `-af`.
- **Codec per container:** AAC 192k in `.mp4`, `pcm_s16le` in `.mov` (ProRes),
  both under `-flags:a +bitexact` (suppresses the encoder tag; the existing
  `-fflags +bitexact -map_metadata -1` already covers the muxer). PCM is
  trivially deterministic; **AAC's run-to-run determinism is proven by the gate,
  not assumed** (recorded contingency if a future ffmpeg breaks it: encode the
  processed track once into the `$APPDATA` cache and stream-copy).
- **Load degrades, never crashes.** `loadProject` probes the track
  (`probe_audio`); missing/unprobeable → the project loads SILENT with a warning;
  shorter-than-project → the tail pads with silence (warned, not fatal).
- **Preview audio is UI-lane only.** `engine/previewAudio.ts` (a
  decoded-`AudioBuffer` player: an `HTMLAudioElement` sync means `currentTime`
  SEEKS, and WebKit seeks VBR MP3s ±100–300 ms off target; buffer sources start
  sample-exact and steady play needs no correction, the source restarting only on
  a real clock jump >250 ms: scrub or loop wrap) never runs during
  export/autorun: `isExporting()` guards every state change and tick. The gain
  envelope mirrors the qsin afade curves per clock tick. The mux is the only
  mixdown that counts.

## Device screens

`Device` plays clip frames on a glb's `SCREEN` material via the shared
`useClipTexture` (engine/clipTexture.ts), same registry, LRU and
`videoFrameReady` barrier as `VideoClip`. Three mechanisms exist because each
fixed a real divergent-verify bug:

- **Own-subtree readiness refs.** The binding effect publishes
  `userData.videoFrameReady` on a node rendered by the consumer's OWN subtree. A
  parent's ref is still null during the mount commit; when a clip's registry
  entry resolves BEFORE mount (warm cache, load-order dependent), the effect
  would bail on the null ref with deps that never change until the clip's first
  frame advance, leaving the screen black and unawaited for its whole
  clamped-frame window. That is invisible to `boundMismatches` and heals at the
  first rebind, producing an A≠B window of exactly
  [first-visible, first-frame-advance].
- **Pinned frames + eager GPU upload.** Multiple consumers of one source
  (mount-all: the inactive scenes clamp to first/last frame) share one LRU whose
  eviction closes ImageBitmaps. Consumers pin their requested frame synchronously
  BEFORE the async load and their bound frame until replacement; binds call
  `gl.initTexture` so the GPU copy exists while the bitmap is provably alive (a
  detached bitmap uploads as an INCOMPLETE texture, which samples black).
  `awaitVideoFramesReady` also screams if a bound clip texture's bitmap is
  detached at capture.
- **UV crop via the attribute API.** Cover-fit is baked into a cloned screen-mesh
  UV attribute (never the shared textures). glTF vertex data is often
  INTERLEAVED: reading `attribute.array[i * 2]` gets positions, not UVs; use
  `getX`/`getY`.

## Postprocessing effects

A project that declares any effect (theme `effects` or a per-scene override)
routes **every** frame through one module-level `EffectComposer`
(`engine/effects.ts`); a project with no effects never touches it and keeps the
byte-identical direct paths. Composer rules: `composer.render(0)` (fixed delta:
the injected `time` uniform never advances), the effect **set** is the
project-wide union built once (per-scene overrides only drive uniforms), and only
allow-listed time-free effects exist (film grain is `DeterministicGrainEffect`,
seeded from the frame index). The composer owns the project's **single** ACES
tone-map + sRGB encode; on transition frames the scenes reach the A/B targets
un-tone-mapped and the composite feeds the composer linear.

**Colour-grade (3D LUT).** The ordering decision and its invariants:

- **The LUT sits AFTER `ToneMappingEffect`, in the same `EffectPass`.** Standard
  `.cube` grades are authored for **LDR, post-tone-map, sRGB-encoded** input.
  postprocessing handles the domain change: `LUT3DEffect.inputColorSpace` is
  sRGB, so the generated pass shader inserts a linear→sRGB conversion before the
  LUT's `mainImage`, converts back to linear after it, and the pass still
  performs its one final sRGB encode at output: grading happens in the authored
  domain with no double encode.
- **A mid-project LUT swap must never recompile.** The public `LUT3DEffect.lut`
  setter fires `setChanged()` → a full pass recompile, so `applyEffectUniforms`
  writes the `lut` **uniform directly**. That is only valid while the compiled
  shader's size defines fit every texture, so **all LUTs in one project must
  share one `LUT_3D_SIZE`** (`preloadEffectLuts` enforces this). The LUT url set
  is part of the composer's rebuild key, so a *project swap* to different LUTs
  does rebuild the chain.
- **Assets are preloaded, parsed purely, and cached by URL.** `.cube` parsing
  (`engine/lutCube.ts`, pure, unit-tested) → an 8-bit RGBA `Data3DTexture`
  (`LinearFilter`, no mipmaps, clamped: hardware trilinear, 1:1 deterministic;
  8-bit because float linear-filtering is an optional WebGL extension).
  `loadProject` awaits `preloadEffectLuts` before publishing effects to the store
  (the composer chain never builds against a missing texture); the export
  preamble awaits it again with `gl` to force GPU upload before frame 0, never a
  lazy first-use upload mid-run. Caching by URL means both Verify runs sample the
  identical texture object.
- **Across a transition** the LUT `intensity` (blend opacity, a uniform) lerps
  like any numeric param; the `url` snaps at `progress ≥ 0.5` (two 3D LUTs can't
  be blended); see `blendEffectParams`.

**`EffectComposer.setSize` trap:** never pass the drawing-buffer size: it
forwards a differing size to `renderer.setSize` and doubles the canvas every
preview frame on retina until WebGL blanks. The composer is sized at the
renderer's logical size with `updateStyle: false`.

## Persistent (hoisted morph) layers

A project's `persistent` module mounts once, outside every scene group
(`<PersistentLayer>`, no `SceneContext` → `useTimeline()` is global time), and
tweens across scene seams via the pure `sampleSharedTransform` track. Compositing
rules that keep it deterministic and ghost-free:

- **Never bake it into the A/B transition targets.** The transition path renders
  `scene` twice via visibility gating; an always-visible persistent object would
  land in both targets and cross-fade against itself. The compositor hides all
  persistent layers for the A/B renders and draws them **exactly once** over the
  composite, with the real (camera-tracked) camera.
- **No effects:** the overlay renders straight to the default framebuffer after
  the composite: color preserved, **depth-only clear** (deterministic z-test),
  `scene.background` nulled for the draw (repainting it would wipe the
  composite), `autoClear` off.
- **Effects:** the overlay must not bypass the effect chain, so it is layered
  into the composer's **pre-effect input buffer** via a dedicated overlay
  `RenderPass` (depth-only clear, `ignoreBackground`) between the main render and
  the effect pass: bloom/LUT/grain grade the morph exactly like scene content.
  The pass is always constructed (chain stays project-stable) and toggled per
  frame as a pure function of the resolved transition. `renderer.autoClear` is
  forced off around the overlaid composer render: three would otherwise clear
  the input buffer's color before the overlay draw, wiping the composite. On the
  fast (single-scene) path the persistent layer simply stays visible in the one
  render, no special casing.
- Persistent visibility is part of the compositor's snapshot/restore set, and all
  motion derives from `globalMs` only.

Remember the gate only proves byte-**stability**, not correctness: a
double-tone-map bug or a morph compositing mistake (ghosting, ungraded overlay)
is invisible to Verify ×2. Validate effect and overlay output visually after
wiring changes.

## Anti-aliasing

MSAA 4× runs on **every** render path, and its determinism is an empirical,
gated fact, not an assumption:

- **The context's `antialias: true` is a REQUEST**: WebKit decides silently
  (historically it has refused or broken it next to `preserveDrawingBuffer`, the
  exact combination we use). The Canvas `onCreated` truth log prints
  `getContextAttributes()` + `capabilities.maxSamples` into every autorun dev
  log; on this stack WKWebView GRANTS antialias and caps `maxSamples` at **4**
  (ANGLE/Metal), which is why `MSAA_SAMPLES = 4`.
- **Where the samples live:** the context/default framebuffer (solo path + the
  composite quad + the no-effects overlay draw), `samples: MSAA_SAMPLES` on the
  compositor's A/B targets (three resolves via `blitFramebuffer` when the
  composite samples them), and `multisampling: MSAA_SAMPLES` on the effects
  composer's INPUT buffer (scene geometry + the overlay RenderPass; the effect
  passes are fullscreen quads where MSAA is moot; half-float MSAA renderbuffers
  are Metal-native).
- **Why it's deterministic (same machine):** sample positions follow the standard
  pattern (D3D11/Vulkan/Metal share it) and every resolve (implicit at
  `readPixels`, blit for targets, composer) is a fixed-function box average.
  Same GPU + driver → same bytes, which Verify ×2 proves per gate exactly like
  every other render decision. Hashes were never portable across machines.
- **What MSAA does NOT fix:** shader-interior aliasing: specular shimmer on
  moving glossy surfaces. Addressed for the device pillar by **geometric specular
  AA** (below); true TAA was evaluated and REJECTED: it is history-dependent
  (frame N needs frame N−1), which breaks *frame = pure function of t* and
  random-access preview scrubbing; and three's own TAARenderPass only
  accumulates when the scene is STATIC, i.e. it does nothing exactly when things
  shimmer. If GSAA ever proves insufficient for a final, the recorded escalation
  path is per-frame jittered supersampling (K renders of the SAME instant with a
  fixed jitter table, averaged, pure in t, deterministic) as an opt-in
  export-quality setting.

**Geometric specular AA:** a titanium bezel's shimmer is textbook specular
aliasing: punctual lights on a normal-mapped metal. three's built-in
`geometryRoughness` term filters only the NON-perturbed normal, so
normal-map-induced shimmer passes through it. `Device` injects the
Kaplanyan/Tokuyoshi filter after `lights_physical_fragment` (via
`onBeforeCompile`): roughness widens by the screen-space variance of the
PERTURBED normal: `r' = sqrt(r² + min(0.25·(|dFdx n|² + |dFdy n|²), 0.18))`,
the paper's default constants, which are **export contract**. Pure per-pixel
math on fixed geometry → deterministic like any shader. Scope discipline: the
filter applies ONLY to `Device`'s private material clones, never the shared drei
glTF cache; `DeviceMockup`/`HeroObject` read the same glb.

Changing `MSAA_SAMPLES` (engine/format.ts) is a full baseline rebase.

## Per-scene camera

A scene's sidecar document may declare a `camera` track: **orbit poses**
(`{ target, azimuthDeg, elevationDeg, distance }`) at scene-local times, joined
by eased segments (`engine/ease.ts` names + `jump`). Everything samples in
`engine/sceneCamera.ts` (pure, no three.js, unit-tested); the seams apply the
result. The invariants:

- **The null path is the old path, exactly.** `resolveFrameCameras` returns
  `null` whenever no scene doc in the project declares a track, and both seams
  (`CompositorDriver`, the export loop) then run the legacy code verbatim:
  `applyCameraTrack` (project-level track, itself a hard no-op when absent) +
  `renderComposited` with no camera plan. Projects without scene tracks render
  byte-identically.
- **A tracked project gets an explicit plan EVERY frame.** Once any scene in the
  project has a track, every frame's camera is written explicitly (scenes
  without their own track fall back to the project-track sample, else the base
  pose), so the camera never inherits a stale pose from a neighbouring scene's
  track. `fov` always comes from the project-level track (scene poses own
  position/lookAt only); `camera.aspect` stays owned by the exporter's resize
  guard.
- **Transition frames apply per-target poses.** The compositor renders each
  offscreen A/B target with **its own scene's** pose (`applyCameraPose`
  immediately before each target render), and the persistent-layer overlay with
  the **dominant** scene's (`progress < 0.5 ? A : B`). The composite quad itself
  ignores the scene camera. This is the one place the camera write moved INSIDE
  `renderComposited`: passing the plan in keeps the preview/export call sites
  incapable of drifting.
- **Sampling semantics are part of the export contract.** Segments are half-open
  `[from, to)`; outside any segment the camera holds the latest key at/before `t`
  (before the first key: the first key), which is also what makes `jump` land
  its target exactly at the segment-end instant. A lone key with no segments is a
  whole-scene static reframe. Orbit parameters interpolate as plain numbers (no
  shortest-arc wrapping) with the segment's ease; ease curves are the
  golden-pinned `engine/ease.ts` set. Overhang keys (past the scene end) are
  legal: `resolveAt` clamps scene-local time, cutting a straddling segment
  mid-flight. Changing any of this re-renders every committed project with a
  camera track.
- **The UI never reaches the render.** Timeline-lane state (selection, armed
  tools, drags) lives in UI stores; the preview merges an in-flight drag as a
  draft track read imperatively inside `CompositorDriver`'s `useFrame`, which
  stands down for the entire export (`isExporting`), so the export loop samples
  only what the sidecar declares.

## Camera rig (free flight)

A scene's sidecar may instead declare a `cameraRig` block and `cameraMode: "rig"`:
**free poses** (`{ position, aim, fov?, rollDeg? }`) at scene-local times, where
`aim` is a fixed `point`, the path `tangent`, or a bound `object`. Everything
samples in `engine/sceneRig.ts` (pure, no three.js, unit-tested). The invariants:

- **A separate block, not a per-key union.** The orbit sampler is untouched code,
  so null-for-legacy is structural rather than argued: an absent `cameraMode`
  never reaches `sceneRig.ts` at all, and `buildSceneCameraTracks` only
  normalizes a rig under `cameraMode: "rig"`. Per-scene precedence is
  **rig, then orbit, then the project track, then the base pose**, and rig mode
  with ZERO rig keys falls through to orbit, so flipping the switch before
  authoring never jumps the camera.
- **Poses interpolate through a canonical form.** `{ position, forward (unit),
  aimDistance, rollDeg, fov }`, not through the look POINT: position lerps (or
  splines), `forward` slerps, `aimDistance` interpolates **logarithmically**,
  roll and fov lerp. This is what lets a 180 degree pan-in-place rotate instead
  of dragging its aim through the camera. All of it is export contract.
- **Guard rules are pinned, never "whatever the floats do".** `slerpUnit` falls
  back to a normalised lerp above dot 0.9995 and, below dot -0.9999, rotates
  about the perpendicular built from the **least-aligned basis axis** (first
  minimum wins: x, then y, then z) so an antipodal turn picks the same arc every
  run. A zero-length aim guards to forward `[0,0,-1]` at distance 1; a
  non-positive aim distance degrades to a linear mix rather than a NaN.
- **Smoothing shapes POSITION only, and is the default.** A segment's `smooth`
  flag is absent-means-true; `false` is a deliberate straight dolly. Smooth
  segments run a **centripetal Catmull-Rom** (alpha 0.5, `engine/keyframes.ts`)
  whose parameter is the already-eased progress, keeping timing separate from
  path shape. A missing end neighbour is **reflected** (`2*near - far`), not
  duplicated: duplication would give a lone segment a smoothstep speed profile
  on top of its ease and a zero start tangent. Direction still slerps between
  the two keys, because splining the aim too gives a wandering look direction.
- **Tangent aim has four rules, all of them fallbacks to the baked `at`.**
  Inside a smoothed segment it is the **analytic** spline derivative (never a
  finite difference); inside a straight one it is the segment chord; a held key
  outside any segment has no path; and a near-zero derivative or chord has none
  either. `at` is stored on every aim mode precisely so each of those degrades
  to a still-renderable shot.
- **Bindings are read at load, never written.** An `object` aim resolves at
  normalise time against the owning doc (`devices[]` by id, then the video
  window, then the layered-screenshot stack) and rewrites only the in-memory
  `at`; an unresolved id warns once and keeps the baked point. Rebaking `at`
  when the bound object moves is the inspector's job, so the engine stays pure.
- **The lens and the clamp.** `fov` is clamped to 15..90 at NORMALISE time only
  (a sample-time clamp could kink a segment mid-flight) and stays absent when
  unauthored, in which case the project-level track keeps owning fov exactly as
  before. Per-channel eases (`easePosition` / `easeRotation` / `easeLens`) are
  optional; an unknown name warns and drops back to the segment's own ease.
- **Roll is the one new camera write, behind a falsy guard.** `applyCameraPose`
  calls `rotateZ` only when `rollDeg` is present and non-zero, so every legacy
  pose still produces bit-for-bit the matrix it always did. The project-level
  track gains no roll channel.

### Depth bands and the travel envelope

A rig needs something to fly through, and a full-bleed layer sized for a static
camera stops being full-bleed once one travels. Both come from one summary:

- **The envelope is a fixed-count sample, not a frame read.** `rigOverscan`
  (`engine/sceneRig.ts`) samples the track at exactly `ENVELOPE_SAMPLES` (64)
  evenly spaced instants across its authored span. At each sample the camera's
  four frustum corner rays (aim direction and roll included, through the same
  `viewBasis` the overlay projects with) intersect the layer's plane, and the
  widest hit sets the rect. The count is EXPORT CONTRACT: sizing maths that
  depended on frame rate or scene length would resolve differently in preview
  and export.
- **Sizing only, never the pose.** `rigOverscan(track, frame, z, minimum)`
  answers "how many base frames wide must a layer at depth `z` be", takes the
  existing constant as its FLOOR and `OVERSCAN_CAP` (4) as its ceiling (a band
  the camera crosses goes edge-on and would otherwise ask for an infinite
  rect). A rig can therefore only ever ask for more; a rig-less scene resolves
  the constant unchanged, which is what keeps every existing project
  byte-identical. No layer currently reads it (`VideoWindow`'s backing stage
  did, until the stage was removed in favour of the scene's own background).
  The fixed background does NOT read it and needs nothing, because its quad is
  rewritten from the live camera every draw and so cannot show an edge at any
  pose.
- **DepthStage band depths are pinned.** `foreground` 1.8, `content` 0,
  `midground` −2.4, `backdrop` −5.5 (`toolkit/stage/DepthStage.tsx`), chosen to
  read as parallax while staying inside the cyclorama's back wall at z −6. Each
  band sizes its rect through `rigOverscan` at its own depth, so nearer bands
  (which the camera passes closer to) get more overscan than far ones.
- **The track resolves from context, not a registry.** `useRigTrack` reads the
  scene doc already provided by `SceneHost`, so preview and export compute it
  from the same input by construction rather than by a plumbing convention. The
  DepthStage *registry* exists only so the editor's bounds advisory can tell a
  banded scene from a staged one; it is UI-only and the render path never reads
  it.

## Layered screenshot

A scene's sidecar may declare a `layeredScreenshot` block (a 3D stack of
screen/text cards) and `animatedTrack` naming which one keyed track, camera or
stack pose, animates that scene. The invariants:

- **The null path is the old path, exactly.** The host-side
  `LayeredScreenshotFallback` renders nothing when the sidecar has no block (and
  stands down entirely when the scene's TSX consumes it via
  `useSceneLayeredScreenshot`), so every existing project mounts zero new nodes
  and renders byte-identically.
- **One animated track per scene.** `animatedTrack: "layeredScreenshot"` stands
  the scene's camera track down at track-build time (`buildSceneCameraTracks`
  returns null for that scene; its camera keys stay on disk untouched); absent
  or `"camera"` leaves the camera path exactly as before.
- **Everything samples pure.** Validation (`sceneLayeredScreenshot.ts`), layout
  (`layeredScreenshotLayout.ts`) and pose sampling share the camera track's
  semantics (half-open segments, hold outside, golden-pinned eases) as pure
  functions with no clock or three.js, so preview and export agree by
  construction.
- **Drafts are UI-only.** Builder gestures preview through
  `layeredScreenshotEditStore`; the primitive merges a draft in React only
  behind an `isExporting()` guard, and the export samples only the sidecar.
- **Media rides the existing pipelines.** Image cards suspend on the shared
  texture loader (settled by the export preamble); video cards bind the
  pre-extracted CFR clip frames and publish the standard readiness flag. Video
  intrinsics land behind the extract barrier before frame 0, so card layout is
  settled at capture. Text items are `useSceneText` strings under `ls-<id>`
  keys.
- **Present looping never reaches the render contract.** The animation's
  optional `presentLoop` samples through a looped wrapper only under the present
  realm's slideshow flag (the Device-sway pattern); the flag is never set in
  the editor or export realms, so preview and export always play the track
  once and hold.

## Video window

A scene's sidecar may declare a `videoWindow` block: a macOS screen recording as a
floating rounded window with an analytic drop shadow, floating over whatever the
scene stages behind it (theme backdrop, fixed background, or nothing). The
invariants:

- **The null path is the old path, exactly.** The host-side `VideoWindowFallback`
  renders nothing when the sidecar has no block (and stands down entirely when the
  scene's TSX consumes it via `useSceneVideoWindow`), so every existing project
  mounts zero new nodes and renders byte-identically (`ws:launch-2026` stays EQUAL).
- **Genuine world-space layers, not an overlay.** The shadow and window are meshes
  at distinct depths inside one group; the per-scene camera track moves through
  them with real parallax. The scene's own background shows behind them (the
  original full-bleed backing stage was removed 2026-07-29, a deliberate visual
  change re-baselining `ws:video-window-spike`).
- **Everything samples pure.** Validation, radius resolution, the recording crop
  and motion sampling (`engine/sceneVideoWindow.ts`) are pure functions with no
  clock or three.js; the window's motion presets are `f(localMs)` like
  `DeviceMotionSpec`, and the `offset` placement is a static frame-fraction
  translation composed with them.
- **Media rides the existing pipeline.** The window binds the pre-extracted CFR
  clip frames via `useClipTexture` and publishes the standard readiness flag, so
  the export preamble's `awaitVideoFramesReady` barrier gates capture; intrinsics
  land behind the extract barrier before frame 0, so window layout is settled at
  capture (the `recording` crop resolves from those intrinsics, so it is settled
  too). No new decode/preload path.
- **Radius, rim, crop and shadow are analytic.** A rounded-box SDF alpha mask +
  hairline stroke (shared with `LayeredScreenshot`, `applyCardMask`) and a blurred
  round-box shadow quad (`SHADOW_VERT`/`SHADOW_FRAG`): fixed-function per-pixel
  math on fixed geometry, the class MSAA 4× already covers; no shadow map. The
  `recording` corners mode crops the capture margins as a UV affine in the same
  program (`applyWindowMask`, key `kookaburra-vw-card-v1`); its identity transform
  (scale 1, offset 0) is IEEE-exact, so non-recording windows sample identically to
  the old chunk. Its constants (`RECORDING_INSETS` 112/76/112/148,
  `RECORDING_RADIUS_PX` 52) were measured off a Retina 2x capture (hard edges,
  radius fitted to ±0.7px on both top corners; 26pt at 2x). Tuned constants (radius
  fractions, shadow defaults, `SHADOW_BEHIND`, default `scale`) add a baseline
  rather than rebasing existing ones.

## Themes & per-scene render state

Themes (JSON documents, `src/theme/schema.ts`) may declare `lighting`,
`environment`, `backdrop` and `background` blocks, and a scene's sidecar may swap
the whole theme via `themeId`. The rendering invariants mirror the per-scene
camera exactly:

- **The null path is the old path, exactly.** `buildSceneRenderStates` returns
  `null` whenever no scene swaps the theme AND the project theme carries no
  staging block: `renderComposited` then never touches
  `scene.background`/`scene.environment` (the background stays the Canvas-root
  colour; environments stay drei's last-mount-wins). The legacy themes are
  bundled JSON with NO staging blocks: that absence is structure-pinned in
  `schema.test.ts`, and it is what keeps legacy baselines EQUAL. Same rule for
  effects: a scene's theme swap replaces the project's effect BASE wholesale
  (`sceneBaseEffects`), and a project whose themes/overrides declare no effect
  anywhere keeps the composer-free paths.
- **An opted-in project gets an explicit state EVERY frame, per target.**
  Background and environment are root-scene values, so the compositor applies
  each transition target's OWN scene state immediately before its offscreen
  render, the dominant scene's (`progress < 0.5 ? A : B`) before the composite +
  persistent overlay, and restores the pre-call values on return (root-scene
  state must not leak into the next-loaded project, the shared-camera stale-pose
  lesson). A scene whose theme declares no environment applies the pre-call
  SHARED environment explicitly, never the previous target's themed one
  (`applySceneRenderState`, unit-tested).
- **Cross-theme transitions blend pixels.** Each target renders fully in its own
  theme (background, `<SceneStage>` lighting, environment) and the existing sRGB
  composite blends the finished images: theme values themselves never
  interpolate. Effects across a cross-theme transition blend through the existing
  `blendEffectParams` (one-sided stacks fade their amount; LUT urls snap at the
  midpoint).
- **Environments are preloaded, fixed-function GPU work.** `preloadEnvironments`
  (engine/environments.ts) resolves every referenced source before frame 0 in the
  export preamble: RGBE decode (pure CPU) → PMREM (fixed-function, the
  MSAA-resolve precedent); textures cache by source id for the app's lifetime.
  The preview fire-and-forgets the same call (a reflection-less first paint is
  preview-only, healed by an invalidate).
- **Every lighting value is a pure function of the resolved timeline position.**
  `<SceneStage>` mounts the resolved rig (fixed `LIGHT_RADIUS` for the sun and
  legacy fills, export contract); staged primitives' bundled lit sets stand down
  via `useSceneStaged()` (explicit `lit` wins). Since v9, a scene doc may carry a
  lighting keyframe track (one sparse whole-rig track, `sceneLighting.ts`),
  sampled per render target at the compositor seam exactly like the camera: on a
  transition frame, targets A and B sample their own scene's track at their own
  scene-local times. Nothing reads the wall clock and nothing accumulates across
  frames; theme TOKENS remain static (tracks live on the scene-doc layer only).
  This deliberately reverses the v8 "scene motion of light is out of scope" lock;
  see docs/decisions.md.
- **A verify cannot see an orientation bug.** Verify compares run to run, so a
  light aimed the wrong way, an emitter across its own tube or a housing over its
  own aperture renders consistently WRONG and certifies EQUAL. Seven such bugs
  were found across the v9 batch and its variant comparison, all invisible to the
  gate. `ws:lighting-audit` (9 scenes: env mirror, housed props, the shadow cap,
  one per preset, all staging the same matte/glossy/rough subjects) exists to be
  LOOKED at after any lighting render-path change. It is deliberately not in a
  gate. Measure as well as look: crop to the subjects first, because a large flat
  backdrop swamps whole-frame statistics.
- **Degrade, never crash.** A malformed theme document falls back to the default
  theme (project level) or the project's theme (scene level), like a malformed
  sidecar. Gate assets (spike themes, sidecar theme swaps) are structure-pinned
  in unit tests so a silent parse-degrade fails CI, not the gate.

### Staging: backdrops & real shadows

- **Shadow maps are HYBRID and inert-by-default.** `renderer.shadowMap` is
  enabled globally (`SHADOW_MAP_TYPE` in engine/format.ts, VSM, whose radius is
  a real fixed-tap gaussian blur of the map), but three compiles shadow code into
  a material only when a shadow-CASTING light lights it; and the only casting
  light is `<SceneStage>`'s key, which casts ONLY when the scene stages a
  floor/backdrop AND the theme's shadow technique is `"map"`. Every unstaged
  project is therefore untouched; the procedural blob shadows remain the default,
  and `Device`'s blob flips to `"none"` on map-shadowed stages so the two systems
  never stack.
- **The shadow rig is export contract.** Theme tokens (mapSize, softness→radius,
  bias, catcher opacity/tint) plus the fixed constants in SceneStage
  (LIGHT_RADIUS, the ortho shadow frustum ±8 / near 0.5 / far 30, radius scale 8,
  VSM blurSamples 8): changing any of them, or `SHADOW_MAP_TYPE` itself,
  re-renders every staged project. Shadow-map rendering + the VSM blur are
  fixed-function/fixed-tap GPU work (the MSAA precedent).
- **Backdrops are unlit, exact-colour surfaces.** `Floor` (cyclorama,
  profile-swept, no horizon seam), `GradientBackdrop` (a pure-JS sRGB
  `DataTexture` rasterized from the theme's structured stops, bit-identical on
  any machine; 512² is contract) and `ImageBackdrop` (project asset, cover-fit,
  preloaded by `preloadProjectImages`) all render `MeshBasicMaterial` +
  `toneMapped: false`, so theme hexes and image pixels land exactly (ACES renders
  `#ffffff` grey, the device-screen precedent). Shadows darken them through a
  `ShadowMaterial` catcher overlay on the same geometry (polygon-offset, no depth
  write): the surface stays colour-true, the shadow composites on top. Stage
  geometry constants (cyc width/depth/wall, backdrop plane size/z) are export
  contract.
- **Sidecar staging overrides** (`backdrop`, partial `lighting`, field-level
  replacement via `mergeLighting`) resolve at mount; gate sidecars that carry
  them are structure-pinned like every other gate asset.

### The fixed background

- **A camera-locked, frame-filling layer in a SEPARATE slot.**
  `Theme.background` / `SceneDoc.background` (whole-value `doc ?? theme`,
  `{type:"none"}` cancels), separate from `backdrop` so the two COMPOSE (a fixed
  image can sit behind a shadowed cyclorama). Vocabulary: `colors.background`
  clears the frame · `background` is a camera-locked fill over that clear, behind
  all world content · `backdrop` is world-space staging. Absent spec ⇒ no mesh,
  no seam touched: legacy projects are structurally byte-safe.
- **The lock is an `onBeforeRender` matrix write, and it is pure.** The quad is
  per-scene-group content (per-target transition rendering, one-sided seams and
  the persistent-layer exclusion all work with zero compositor changes), but its
  `matrixWorld` is recomposed from the LIVE camera immediately before each draw
  (`camera.matrixWorld × translate(drift, −FIXED_BG_DISTANCE) ×
  scale(frustumW, frustumH)`). The camera state per render call is a pure
  function of the clock (the compositor applies project-track / per-scene /
  per-target poses before every render), and the write is a pure function of that
  camera state: no clock reads, no history. All math is golden-pinned in
  `toolkit/stage/fixedMath.ts`.
- **EXPORT CONTRACT constants** (fixedMath.ts): `FIXED_BG_DISTANCE = 50`,
  `FIXED_BG_RENDER_ORDER = −100` (draws first; `depthTest/depthWrite: false`, so
  world content simply paints over it; nothing else sets a renderOrder),
  `FIXED_BG_NDC_CLAMP = 2`, overscan `1.001 + 2·parallax` (kills frame-edge
  FP/MSAA seams + covers the full parallax travel). Changing any re-renders every
  project that stages a background.
- **Parallax is anchor-projection, fov-invariant.** The world origin projected
  through the current camera gives the content's screen displacement in NDC (base
  pose → 0,0); the quad offsets laterally by `parallax ×` that displacement
  (clamped ±2 NDC; held at 0 when the anchor is behind the camera). Orbits that
  keep the target at the origin produce NO drift by construction: tracks must
  pan to show it.
- **Fills follow the standing rules.** Exact-colour unlit material
  (`toneMapped:false`, ACES applies once on effects projects like every
  backdrop); the gradient fill reuses the 512² pure-JS raster verbatim (stretched
  to the frame, effective angle is per-aspect, the GradientPlane precedent);
  image fills cover-crop CENTRED with the crop baked into PER-INSTANCE geometry
  UVs: never `texture.repeat/offset` (the bundled/drei caches are shared with
  the world ImagePlane, which crops the same texture objects that way; the fixed
  path also CLONES its texture so mount order can never matter). Never a shadow
  caster or receiver (a world shadow on a camera-locked plane would swim).
- **Preloads: zero new barriers.** `kookaburra:` fills ride the
  `preloadBundledBackdrops` sync cache (never suspend); project-relative fills
  ride `preloadProjectImages` + suspense + the scene-host commit barrier, exactly
  like the world image backdrop.
- **Gradients have two interpolation modes, both pure-JS raster branches.**
  `GradientSpec` supports `type: "radial"` (centre → corners; `RADIAL_EXTENT = √½`
  is contract) and `space: "oklch"`: perceptual stop interpolation through
  `theme/oklch.ts` (Ottosson OKLab matrices + sRGB transfer, golden-pinned; hue
  takes the shortest arc, achromatic endpoints adopt the other side's hue,
  out-of-gamut results channel-clamp). The ABSENT-`space` path is the original
  per-channel sRGB byte loop, arithmetic UNTOUCHED: standing gradient projects
  stay byte-frozen. A background's gradient may carry a self-contained inline
  `spec` (picker presets/customs, theme-independent); user presets are text
  moved by `gradients.rs` and validated frontend-side like themes.
- **Video fills ride the CLIP pipeline, no extra determinism machinery.**
  `{type:"video", src, loop?, parallax?}` is SCENE-DOC only (themes are
  workspace-shared and can't reference project assets: the theme parser drops it
  with a warn). Frames come from the same pre-extracted CFR sequence + shared
  `useClipTexture` binding as VideoClip/Device: the export preamble's
  `preextractClips` covers the source (registered at mount like any clip) and the
  per-frame `awaitVideoFramesReady` barrier reaches the fill's group. Frame
  choice is a pure clock function pinned beside `clipFrame.ts`: absent `loop` ⇒
  the modulo wrap; `loop:false` ⇒ the frozen clamp (hold semantics). Cover-crop
  rides PER-INSTANCE quad UVs (frame textures are SHARED, never mutated). While
  a first extraction runs in PREVIEW the quad stays invisible (the scene's
  resolved underlay shows); at export/capture that state is unreachable by the
  preamble barriers.

### Fonts

- **Every rendered glyph comes from a file we control.** Theme typography is a
  `FontRef` (`{family, weight}`) resolved by `fontUrl` (src/theme/fonts.ts): the
  BUNDLED registry (committed OFL statics: latin-subset woffs, no variable
  axes; troika parses ttf/otf/woff only) → the workspace-PINNED library → Inter
  with a one-time warning. Weights snap to the nearest available face (ties to
  the lighter). troika never sees its CDN fallback.
- **System fonts are pinned by copy, not referenced in place.** A theme may name
  any installed family; `loadProject` auto-pins it on first reference
  (engine/systemFonts.ts → `pin_system_font`, src-tauri/src/fonts.rs): the best
  weight-matching face is copied, or EXTRACTED from its `.ttc`/`.otc` collection
  (name-table PostScript match, rebuilt table directory; per-table checksums stay
  valid, `head.checkSumAdjustment` goes stale, which troika/Typr and opentype.js
  ignore), into `~/Kookaburra Cut/fonts/` and recorded in `fonts.json`. Exports
  depend on the pinned bytes, so a macOS font update can never move a baseline;
  pinning is idempotent (an existing pin is never overwritten). Projects using
  only bundled fonts never touch the native side.
- **Variable fonts are pinned as INSTANCED statics.** troika parses no `fvar`, so
  a copied VF renders its DEFAULT instance regardless of the picked weight: the
  silent mis-render this rule fixes. Pinning a variable face bakes a true static
  via allsorts (exact-pinned; output proven outline-exact against fontTools
  varLib.instancer) at the picked descriptor's coordinates: fvar named instance
  matched by PostScript name, `wght`-only fallback clamped to the axis range.
  CFF2 flavour, GSUB feature variations, and no-match-no-wght-axis all REFUSE
  with a readable error (the frontend degrades to Inter with a warning): refuse
  over mis-render. ONE exception to pin idempotency: a pinned file that still
  CONTAINS `fvar` is a broken legacy pin and is healed (re-instanced) on next
  reference; sound static pins stay untouched forever, so an allsorts upgrade
  never silently re-instances. Provenance (`instanced: {axes, instancer}`) is
  recorded in `fonts.json`; bumping the pinned allsorts version MAY change
  instanced bytes = a rebase event for any project using such a pin. Boot
  preloads only bundled fonts, so bundled baselines cannot move.
- **The preload barrier follows the theme.** `preloadAppFonts(refs)`
  pre-generates SDF glyphs for exactly the loaded project's theme fonts (bundled
  + pinned URLs) in the export preamble; `ensureThemeFontsPinned` is awaited by
  `loadProject` BEFORE scenes render, so `fontUrl` stays a synchronous lookup at
  render time.
- **3D text stays bundled.** `ExtrudedText` typefaces (converted outlines, one
  per family at the default weight, `pnpm assets:text3d-font`) cover the bundled
  set only; system-font refs fall back to Inter there. The converter is
  byte-stable: regenerating Inter's typeface reproduced the committed file
  exactly.
- **Adding a bundled font is a REBASE EVENT.** troika-three-text keeps ONE SDF
  atlas per `sdfGlyphSize`, SHARED ACROSS EVERY FONT (`atlases[sdfGlyphSize]`):
  glyph cells are allocated in first-typeset order, so expanding `BUNDLED_FONTS`
  changes the boot preload sequence and shifts the atlas slot (cell position AND
  rgba channel) of every glyph typeset after the insertion point. Same SDF
  content in a different cell sample-rounds differently → deterministic ±LSB
  drift in text pixels. Projects whose glyphs all sit inside the FIRST font's
  preloaded block (`PRELOAD_CHARACTERS` of Inter 400) are unaffected; projects
  using later fonts, pinned system fonts, or characters outside the preload set
  rebase. When adding a face: expect these rebases, and PROVE attribution by
  stashing the font change alone and reproducing the old hash.
- **Atlas insertion order is PINNED by sequential preload.** The corollary of the
  shared atlas: with a parallel preload, cells are claimed at preload
  COMPLETION (fetch-race order), so a multi-font project's text pixels become a
  per-BOOT lottery (each run internally consistent, every boot a different hash;
  divergence starts exactly at the first second-font glyph and lives only in text
  tiles). `preloadAppFonts` awaits each face in turn (Inter Regular first, then
  declaration/ref order), and `loadProject` additionally pre-generates every
  project face's glyphs BEFORE the scenes mount, so mount-time typesets can't
  race font loads either. Two consequences: REORDERING `BUNDLED_FONTS` (or the
  collect order) is a rebase event exactly like adding a face: append new faces
  at the END to keep the blast radius minimal; and the atlas is still
  session-history-dependent: an interactive session that previews other
  multi-font projects first can legitimately export ±LSB-different text than a
  fresh-boot gate (gates always run fresh-boot via `kookaburra:run`).

## Emoji & symbol fallback

Emoji and text-default symbols route through two different mechanisms, neither
of which can move pixels for text that uses neither (proven EQUAL on
`showcase-tour` and `ws:launch-2026` when the feature landed):

- **The wedge is patched away.** troika 0.52.4's fallback resolver had no
  `.catch()`: any codepoint outside the loaded fonts CSP-blocked a CDN fetch
  and left `_isSyncing` true forever, freezing the `<Text>` on its last-good
  string. The pnpm patch (`patches/troika-three-text@0.52.4.patch`) degrades
  every failure (fallback fetch, font-file 404, parse error) to `.notdef` tofu
  and keeps sync alive; `unicodeFontsURL` points at a dead same-origin path so
  the CDN is never consulted even under a loosened CSP.
- **Symbols are real SDF glyphs from the bundled fallback face.**
  `KookaburraFallback.otf` (generated: `pnpm assets:emoji-fonts`) merges
  Noto-derived outlines for arrows/checks/stars/Mac-keys with 1024 empty
  private-use glyphs, and is wired as troika's `defaultFontURL`: tried only for
  codepoints the per-Text font lacks, so existing glyph resolution is untouched.
  It preloads LAST, appending its atlas cells after every existing glyph.
- **Emoji never reach troika.** `prepareEmojiText` swaps each RGI emoji cluster
  for a private-use placeholder (one code unit, 1.0 em advance from ONE shared
  empty glyph, the atlas gains a single cell total); troika lays out the full
  string and colour emoji render as textured quads at the caret positions,
  joining their stagger unit's transform via the shader walk's CPU twin
  (`unitIndexForKey`).
- **The raster cache is the determinism source, not the renderer.** Each unique
  cluster is drawn once with the system font (Apple Color Emoji, canvas 2D) and
  frozen as a write-once PNG in the project's own `assets/.emoji-cache/`
  (`<hex-codepoints>@<size>.png`; the size suffix doubles as the generator
  version). A macOS emoji-artwork update can never move an export baseline:
  exactly the system-font pinning contract. Cross-session EQUAL is proven: the
  generating session (blob decode) and a cache-hit session (file decode)
  produced identical hashes. Delete a cache file to re-rasterise after an OS
  update, accepting the re-baseline.
- **Barriers.** `preloadEmojiRasters` statically scans every sidecar's text
  through the same substitution the primitives run, and settles all rasters in
  BOTH the project loader and the export preamble; a per-frame
  `awaitEmojiRastersIdle` after `awaitTextSync` covers strings the scan cannot
  see (a counter's format output), so a texture can never pop in at a
  run-dependent frame.
- **Bundled projects are cache-less by design.** The packaged app's resource dir
  is read-only, so bundled demos keep a session-only in-memory cache; emoji
  belongs in workspace projects (recorded non-goal, `docs/decisions.md`).

## Generative 3D primitives

The generative toolkit primitives (`ExtrudedText`, `ParticleField`, `WireGrid`,
`Ribbon`, `HeroObject`) rest on three determinism mechanisms:

- **Seeded randomness is export contract.** All generative randomness flows
  through `createSeededRandom` (`engine/rng.ts`, mulberry32) seeded by a constant
  or scene prop, `Math.random` never. Two things are pinned: the **algorithm**
  (golden-stream unit tests hard-code exact output values) and the **draw order**
  inside each primitive (documented in-file). Changing either re-scatters every
  committed generative project: treat both like a file-format break.
- **Per-frame procedural motion is CPU-written during React commit.** Instance
  matrices (`ParticleField`), displaced vertices (`WireGrid`) and `drawRange`
  growth (`Ribbon`) are recomputed in `useLayoutEffect` keyed on the timeline
  value: pure functions of the clock, flushed in the same commit the export
  loop's `awaitCanvasClockCommit` barrier observes. No shader `time` uniforms, no
  `useFrame` deltas.
- **Glyph outlines and models are bundled and barrier-preloaded.** `ExtrudedText`
  parses a typeface JSON imported straight into the JS bundle: the parse is
  synchronous, and `preloadText3dFonts()` in the export preamble keeps the
  barrier explicit for any future fetched font. `HeroObject` mirrors the device
  contract: name-keyed bundled glTFs, fetched + parsed by `preloadHeroModels()`
  in the preamble (drei cache warmed), static after load so every frame is
  synchronous. Staged library objects (`SceneDoc.objects`) extend that to a
  DYNAMIC id set: `preloadSceneObjects()` resolves every referenced object id
  (bundled or `ws:`) into a warm asset cache, then fetches + parses each glb
  before frame 0; unknown ids resolve to nothing, deterministically. The
  preview's TransformControls gizmo is UI-only: it ATTACHES to the object's
  group (never wraps it), mounts only for the inspector-selected object AND is
  cleared by `exportPreamble` (`useObjectEditStore`), so it can never reach an
  exported frame.

**Framing is invisible to the gate.** `useFormat().frame`/`safe` are measured at
the content plane `z=0`; content offset toward the camera projects larger and can
clip at frame edges while remaining perfectly byte-stable (a caption at `z=1` did
exactly this). Eyeball exported frames in **both** orientations at every gate.

## Packaged-app parity

The packaged `.app` must reproduce dev-mode hashes on the standing projects:
"internally deterministic" is not "correct", so dev-equal output is its own gate
class, run for any packaging-adjacent change. What packaging changes (and why it
stays deterministic):

- **Static sidecar** (`scripts/build-ffmpeg-sidecar.sh`): pinned ffmpeg source
  build (GPL: libx264 + libx265 + VideoToolbox + ProRes + FFV1), self-containment
  gated by `otool -L` (system libs only). Same version ⇒ same bytes: proven by
  dev/packaged hash parity. Note: the dev `pnpm setup:ffmpeg` copy OVERWRITES the
  release sidecar; rerun `pnpm setup:ffmpeg:release` after.
- **Troika typesets on the main thread**
  (`configureTextBuilder({ useWorker: false })`): WKWebView refuses troika's blob
  worker over `tauri://`, which silently blanks a packaged app. Main-thread
  typesetting runs the identical code path (pixels unchanged, re-gated) and
  needs `'wasm-unsafe-eval'` in the CSP `script-src` (troika's font parser is
  WASM).
- **The CSP is render contract.** `connect-src` must include `blob:`.
  GLTFLoader's ImageBitmapLoader fetches blob object URLs for embedded glb
  textures, and a blocked fetch fails SILENTLY: models render untextured,
  deterministically, wrong. Any CSP/protocol change gates like a render change,
  and the catalog preload throws if a device glb parses with zero textured
  materials.
- **One file-URL seam.** Fonts, media, editor and workspace images all resolve
  through the Tauri asset protocol in dev and packaged builds alike; workspace
  scenes compile through the same esbuild loader everywhere: every dev verify
  exercises the shipping loader.
- **Boot failures can't be silent** (`engine/bootTrap.ts`): any pre-render crash
  renders as text in the window AND (in autorun mode) writes an error result: a
  packaged headless run always produces a verdict.
- **Native allowed roots must match the frontend's asset roots.** The packaged
  frontend resolves bundled-project assets against the resource dir, so
  `workspace::allowed_read_roots` must include it: release binaries prefer
  bundled resources, debug binaries the live repo tree (`templates_root`,
  cfg-gated since #8). Before the gate, a release app on a dev machine preferred
  the dev checkout, `confine_to_roots` rejected its own resource paths, clip
  extraction failed silently and device screens exported the "Preparing video…"
  card: deterministic, verifiable and wrong (`ef9ff1b2…` vs dev `da74c52b…`,
  open from v0.1.0 to 2026-07-17). End-user machines never hit it, which is
  exactly why it survived: only the dev machine could run the gate that catches
  it.
- **Diff the `renderStateFingerprint` FIRST** on any cross-build divergence: every
  verify result records tone mapping, real context attributes (AA grant, sample
  caps), environment/light state and lit-material specular values. It names a
  missing texture class in one JSON diff before any pixel archaeology. When the
  fingerprint is clean apart from cosmetics (minified constructor names), go to
  pixels next: export from both builds and map per-frame PSNR to scenes; a
  contiguous diverging frame range names the failing subsystem faster than code
  reading.

## Export presets & the encode-spec family

**The frozen-path rule.** `ExportOptions.encode` ABSENT ⇒ ffmpeg runs
`encode.rs::legacy_export_args()`: the original argv extracted VERBATIM and
byte-pinned by Rust goldens (`legacy_argv_goldens`, audio + `-an` variants).
Standing baselines and Verify ×2 never carry a spec, so presets can never move
them; an edit to the legacy builder is a deliberate full rebase.

**The spec family** (`spec_argv_goldens` pins every lane): the pinned vf chain is
`vflip[,fps=N][,scale=W:H:flags=lanczos[:out_color_matrix=bt709,format=<pix_fmt>]]`.
With **render-at-output-fps**, the export loop steps the RENDER clock at the
spec's output rate: for 30fps lanes `i·(1000/30)` is bit-identical to
`2i·(1000/60)` in float64, so the frames are the same bytes decimation would have
kept, at half the render time; and the raw input arrives `-r 30` with no fps
filter in the chain. The decimation branch stays (and stays pinned) as defence
for any input that outpaces the spec. bt709 container tags are only ever written
when the scale/format filter also performed the RGB→YUV conversion with that
matrix (untagged swscale defaults to bt601 on raw RGBA: the tags never lie).
Dims: short edge to `scaleShortEdgeTo`, aspect preserved, rounded to even, never
upscaled. HEVC-in-mp4 carries `-tag:v hvc1`. VideoToolbox lanes are bitrate-only
"fast drafts": excluded from Verify by policy. Software VBV lanes pin encoder
threads to 1 (x264 VBV under threads is non-deterministic: identical frames,
differing bytes; x265: `frame-threads=1:pools=1`).

**Two-pass = the FFV1 mezzanine.** Pass 1 consumes its input, so two-pass presets
render ONCE to a lossless FFV1 `.mkv` at OUTPUT res/fps/pix_fmt in
`$APPDATA/cache/export-mezz/` (statvfs disk guard blocks pre-flight: raw-frame
ceiling + 2 GB; swept on the next export, cleaned on success), then transcode
file-to-file (x264 `-pass N -passlogfile`; x265 `-x265-params pass=N:stats=`).
Audio joins at pass 2. FFV1 is bit-exact and both passes are deterministic given
the same mezzanine.

**Loudness is gain-only.** `measure_loudness` runs sidecar ebur128 through the
EXACT export audio graph (`audio_filter_graph`, trim/pad/fades/author gain
included), cached at `$APPDATA/cache/loudness/` keyed
`sha256(file bytes ‖ graph string)`. The delta (`target − integrated`, 2 dp) sums
with the author gain into the ONE `volume=` slot (`audio_filter_graph_gained`;
extra 0.0 = the byte-frozen legacy string). Projected true peak > −1.5 dBTP warns
and proceeds, never a limiter (a limiter is content-dependent DSP; a gain is a
constant).

**4:5, 5:4, 3:2 and 2:3 are first-class but feature-scoped**: `FORMATS["4:5"]` =
2160×2700, `FORMATS["5:4"]` = 2700×2160, `FORMATS["3:2"]` = 3240×2160,
`FORMATS["2:3"]` = 2160×3240 (2160 short edge, the house convention);
`STANDING_ASPECTS` pins Verify's "all" and the full matrices to the standing
three (16:9 / 9:16 / 1:1).

### The export modal & user presets

The Export button opens the modal (`ui/ExportModal.tsx`; all maths in unit-pinned
`ui/exportOptions.ts`). Determinism-relevant consequences:

- **The frozen path stays one honest click**: the pinned "Kookaburra Standard"
  row exports with NO `encode` and NO `outputSuffix`: argv and filename
  byte-identical to the legacy export. Custom ALWAYS sends a resolved spec (even
  at its seed values): the two argv families never blur.
- **The in-app Verify ×2 button is pinned to libx264** (the standing gate).
  ProRes verify legs ride `kookaburra:run --codec prores_ks`; preset-lane
  verifies ride `kookaburra:run --preset <id>` and are LANE proofs, not standing
  baselines.
- **Output naming**: preset/custom exports write
  `<project>-<aspect>-<preset-id>.<ext>` (`-custom` for ad-hoc specs): they can
  never overwrite the legacy `<project>-<aspect>.<ext>` the baseline tooling
  hashes. The suffix is slug-validated native-side.
- **User presets** live at `~/Kookaburra Cut/export-presets/<slug>.json`
  (`ws:<slug>` ids; atomic version-guarded writes). They are data only: the
  frontend parses (degrade-don't-crash) and resolves; a bad user preset can never
  break the modal or an export. `kookaburra:run --preset ws:<slug>` resolves them
  through the same listing.
- **Last-used** (per-project, in AppSettings) only selects a row on modal open;
  it never changes what an export produces.

## How to test it

- **In-app (the gate):** the **Verify ×2** button runs `verifyAllFormats()`: for
  **each** standing aspect (16:9 / 9:16 / 1:1) it exports the project twice
  (overwriting the per-aspect output path) and compares the SHA-256 of each file
  via the Rust `hash_file` command. All aspects identical ⇒ deterministic.
- **Terminal-driven:** `pnpm kookaburra:run --action verify --project <id>
  --aspect all` runs the same gate headlessly and writes
  `~/Kookaburra Cut/_autorun/last-run.json`.
- **On failure, the report localizes the divergence:** per-frame 8×8 tile hashes
  give the exact divergent frame ranges and where in the frame they differ; the
  bound clip-frame index per exported frame separates a stale texture bind from a
  pixel-content difference.
- **Divergence in the first frames also gets a per-pixel delta report:** the
  first 3 frames of each pass are retained raw, and a mismatch there reports
  differing-pixel counts by magnitude (±1 / ±2 / >2), the bounding box, sample
  pixel values from both runs, and downscaled PNG data-URLs of frame A, frame B
  and an amplified |Δ|×8 diff map: decode them from `last-run.json` and LOOK.
  The magnitude histogram alone separates ±LSB drift (atlas/AA class) from
  missing content (a barrier failed); the images settle what moved.
- **Manually:** run an export twice per aspect and compare (filenames are
  per-aspect):
  ```
  shasum -a 256 ~/Kookaburra Cut/<project>/<project>-16x9.mp4   # also -9x16.mp4, -1x1.mp4; ProRes writes .mov
  ```
- **Unit level:** the pure helpers (eases, formats, presets, edit math) and the
  time mapping (`buildSceneTimeline` / `resolveAt`) are unit-tested to enforce
  purity.

### Gate tiers: how much to run

Verify runs are expensive (minutes per project-aspect, one app instance at a
time). **Default to the smallest gate that covers the changed CODE PATHS:
theme/scene DATA variations (colours, light params, text) do not add code paths
and do not need their own verifies.**

- **Tier 0: statics (every change, free):** `pnpm vitest run` · `pnpm build` ·
  `pnpm lint`. Pure math (eases, presets, schemas, edit math) belongs in unit
  tests, not in verify runs.
- **Tier 1: the DEFAULT per-change gate (1 run):** ONE feature-matched
  project, Verify ×2, **16:9 only**: pick the project whose content exercises
  the changed path: `showcase-tour` for themes/staging/text/presets (the
  rolling gate project, six themes, devices, video, ImageCard, camera moves
  and bloom in one project), `ws:device-video-spike` for device/media/camera,
  `ws:fx-spike` for effects, `ws:dof-spike` for depth of field, a hand-rolled
  workspace mini-project for anything narrower. `pnpm gate` runs the
  showcase-tour leg (~2 min).
- **Pre-merge: the sentinel pair (2026-07-25 tier change):** before a PR
  merges (and at any rebase or phase close), `pnpm gate:merge` runs
  `showcase-tour` + `ws:launch-2026` Verify ×2 in ONE app boot (`--project`
  takes a comma list for verify/export; per-leg results carry a `project`
  field in `last-run.json`). `ws:launch-2026` must be EQUAL: the
  null-for-legacy proof. A legacy regression is caught per PR instead of per
  change; it still cannot merge.
- **Tier 2: escalate selectively:** changes at a SHARED render seam (compositor,
  exporter, SceneStage, effects chain, camera application) add the other class
  project and ONE 9:16 spot-check (aspect-dependent code is rare: it's layout,
  not pipeline). A hash that moves when it shouldn't is a STOP: attribute it
  first (`git stash` the suspect file and re-verify; check the render-state
  fingerprint) before running anything else.
- **Tier 3: the full matrix (all standing projects × all aspects):** ONLY for
  engine-wide constants (FPS, MSAA, shadow type, tone mapping, blending domain,
  font-atlas order), deliberate baseline rebases, phase-closing gates, and
  packaged-app parity checks.
- **Pack round trip (v13, any change under `src-tauri/src/pack/**` or
  `fonts.rs`):** export a gate project to a `.kbpack`, import it into a clean
  workspace root, verify THERE, and demand the same baseline hash. Every other
  gate compares a render against a baseline recorded from the same files in the
  same place; a pack changes the files' location, their slug, and potentially
  the font bytes behind them, so this is the only test that can catch a lossy
  pack. It catches, in one assertion, a missing font byte, an over-eager
  exclusion, a lost sidecar, a rewritten asset path, a scene dropped from the
  manifest and a theme that silently fell back.
  Boot 1 verifies and builds the pack; boot 2 runs with
  `KOOKABURRA_WORKSPACE_ROOT` pointed at a throwaway root, imports with
  everything forced to `replace`, and verifies again. **A prerequisite worth
  re-checking if it ever fails: export hashes must be independent of a
  project's slug and absolute path.** Nothing else in the suite proves that, so
  a red round trip means checking path-independence first (duplicate a gate
  project to a new slug and verify both) before suspecting the pack code.
- **Recording rebases:** once the changed code path is PROVEN deterministic by
  the Tier-1 verify, record the other affected projects' new hashes from a
  single export batch: do not Verify ×2 each one.
- Always pair a gate with an extracted-frame visual check (byte-identical wrong
  pixels pass hashing).
- `ws:` fixtures live in `~/Kookaburra Cut/`, NOT the repo, so they are SHARED
  across git worktrees: a parallel session editing one silently moves another's
  baseline with no commit to blame. Bundled projects (`projects/showcase-tour`)
  are per-worktree and immune, so gate hard on those and treat a `ws:` hash as
  advisory whenever more than one worktree is live.

### Current baselines

Baselines are same-machine SHA-256 prefixes of the frozen-path (`libx264`,
16:9 unless noted) export, recorded after a passed Verify ×2. Two projects anchor
the set: the null-for-legacy sentinel (`ws:launch-2026`, a hash-identical
workspace copy of the reel dropped from the bundled set on 2026-07-13, scene
durations re-frozen 2026-07-25, see the splice note below) and the bundled
rolling-gate project (`showcase-tour`):

| Project | 16:9 | 9:16 | 1:1 | 4:5 | 5:4 | 3:2 | 2:3 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ws:launch-2026` (legacy sentinel: must stay EQUAL) | `eb89826c…` | stale | stale | stale | — | — | — |
| `showcase-tour` (rolling gate) | `f304f1bd…` | `8cdb7481…` | stale | stale | stale | stale (pre-trim) | — |
| `transition-spike` (transition gate) | `6b058e1b…` | `74e02850…` | — | — | — | — | — |
| `transition-bg-spike` (animated-background transition gate) | `2df76336…` | — | — | — | — | — | — |
| `compare-spike` (before/after comparison gate) | `8d293536…` | `ed66045e…` | `63dfb18b…` | `aa3cb9b1…` | — | — | — |
| `ws:layered-screenshot-spike` (LS gate, machine-local) | `4ec7b223…` | — | — | — | — | — | — |
| `ws:video-window-spike` (VideoWindow gate, machine-local) | `6dfe68a6…` | — | — | — | — | — | — |
| `ws:lighting-spike-fable` (v9 lighting gate, machine-local) | `fe701549…` | — | — | — | — | — | — |
| `ws:camera-rig-spike-opus` (camera rig gate, machine-local) | `f5107f56…` | — | — | — | — | — | — |
| `ws:multi-device-spike` (deviceLayout gate, machine-local) | `fb2d4f84…` | `c940b3b2…` | `ceb8e74c…` | — | — | — | — |
| `ws:dof-spike` (depth-of-field gate, machine-local) | `a7a37eb0…` | `58d0ac28…` | — | — | — | — | — |
| `ws:chart-spike` (chart gate, machine-local) | `d58ff1f2…` | stale | stale | stale | — | — | — |
| `ws:duplicate-spike` (scene-id heal gate, machine-local) | `c1888139…` | — | — | — | — | — | — |
| `ws:overlay-spike` (overlay gate, machine-local) | `0ceda71d…` | — | — | — | — | — | — |

> **2026-08-07 (batch 18):** two deliberate re-records. `ws:chart-spike` 16:9
> (`c947c931…` → `d58ff1f2…`): a billboard `onBeforeRender` prop had shadowed
> troika's own prototype handler (the one that binds the SDF atlas uniforms),
> so every billboarded 3D chart label rendered nothing since the 2026-08-05
> billboard swap; the fix makes 3D tick, value and slice labels draw again
> (eyeballed on 3D columns and pie), and 3D bar value labels now anchor off
> the mark end like the flat renderer. The 9:16/1:1/4:5 hashes went stale
> rather than re-recorded (a chart-spike leg is 3330 frames; the full matrix
> is a phase-closing gate). `ws:overlay-spike` joins the table at `0ceda71d…`:
> the overlay shader gained panel-fill uniforms, and the recompiled program
> shifts 58 px of the hero frame by one channel LSB (proven by pixel-diffing
> against main-built frames; the full-panel frame is byte-identical). Bullet
> hanging indent and the iconed-title recentre move NO bundled project
> (`grep -rln bullets projects/` is empty, no bundled scene pairs a header
> icon with an empty subtitle); `pnpm gate:merge` EQUAL on both anchors over
> the whole batch, and `ws:overlay-polish-spike` Verify ×2 proves the deeper
> preamble (indent probes → wrap width → fit, passes raised 4 → 8) converges.

> **2026-08-06 (gizmos):** the unified-gizmo batch added one sidecar render
> input, `textStyle.<key>RotationDeg` (clockwise tilt about the block's anchor,
> folded into (-180, 180] at parse). Null-for-legacy is structural: absent or 0
> adds NO rotation prop on `AnimatedHeadline`'s legacy and staggered paths, and
> leaves the block path's existing `rotation` array bit-identical. Rotation is
> not a layout input either, so no cascade reflows around it. Everything
> else in the batch is editor chrome, gated out of exports five ways
> (`docs/gizmos.md`, "Export safety"). No baseline moved: `showcase-tour` came
> back EQUAL at `f304f1bd…` with the full diff in the tree.

> **2026-08-06 (scene identity):** duplicated scenes used to copy their TSX
> verbatim, so `defineScene` ids collided and the id-keyed React mounts
> cross-wired sidecar docs between scenes (masked on cold loads, triggered by
> any in-session insert, reorder or delete). Mount keys now derive from the
> manifest file (`sceneMountKey`), all three Rust producers mint unique ids,
> and workspace projects silently heal duplicates on load after the trust
> gate. Ids never touch pixels, proven by `pnpm gate` EQUAL on the recorded
> baseline and `ws:launch-2026` EQUAL and unwritten (mtimes untouched)
> through a full load. Fixture `ws:duplicate-spike` is the healed snapshot of
> the original broken project: every scene eyeballed showing its own sidecar
> text before its baseline was recorded, and the heal proven idempotent
> (five further boots, zero writes).

> **2026-08-05 (charts):** scenes gained a sidecar `chart` block, laid out by a
> pure core (d3-scale/shape/array) and drawn by flat or lit renderers across
> three mounts (hero, staged beside a device, overlay panel). Everything the
> export samples is a function of the timeline clock alone. Two traps were
> designed out rather than tuned: label billboarding goes through
> `chartBillboardMatrix`, because drei's `Billboard` re-aims in its own frame
> callback and races the stepped export clock, and coplanar layers separate by
> the fixed `CHART_2D_Z_STEP` world epsilon with explicit `renderOrder`, never
> driver-dependent `polygonOffset`. Fixture `ws:chart-spike` verified identical
> ×2 in all four aspects (16:9 re-verified on `main` at release time, still
> `c947c931…`); null-for-legacy holds, since a project with no chart never
> builds the chart path and both anchors came back EQUAL. Full contract:
> `docs/charts.md`.

> **2026-08-04 (depth of field):** camera poses gained a sparse `dof` block
> (depth or tilt-shift family), resolved per frame through the camera plan and
> applied by stock `postprocessing` effects at the composer chain's head, with
> transition/compare sides dof-graded individually through a dof-only side
> composer before the composite. Null-for-legacy holds: a project with no dof
> anywhere resolves a null union and takes the pre-existing paths byte for
> byte (`showcase-tour` re-verified EQUAL at `f304f1bd…`, `ws:fx-spike` frame
> byte-identical to the pre-feature chain). Display constants
> (`DOF_BOKEH_SCALE_MAX` 6, `DOF_INACTIVE_FOCUS` 100, `DOF_RESOLUTION_SCALE`
> 0.5, `TILT_FEATHER` 0.3 in `engine/effects.ts`) are export-contract
> constants: changing one is a deliberate rebase. Composer depth arrives via
> postprocessing's stable-depth target, a per-frame fixed-function
> `blitFramebuffer` alongside the gated MSAA resolve; proven EQUAL ×2 on
> WKWebView/ANGLE Metal before anything else was built. Eyeball note: with
> autofocus the aimed subject is SUPPOSED to be sharp, so judge dof frames
> with the camera-to-subject distances in hand, not by "is anything blurry".

> **2026-08-06 (dof blur styles):** the `dof` block gained four style modes
> (soft "Dream", radial "Burst", directional "Swipe", split diopter) plus the
> depth-family `squeeze` field. Burst and swipe share one convolution
> `SmearEffect` (fixed `SMEAR_TAPS` 32, spatial-hash tap jitter, a pure
> function of the pixel coordinate like the grain hash); Dream is
> `SoftFocusEffect` (fixed `SOFT_FOCUS_KERNEL` 35 Gaussian + screen blend);
> split and squeeze run on ALWAYS-PATCHED stock materials (a second focus
> plane in the CoC, an X squeeze in the bokeh kernels; `mustPatch` anchors
> throw on a postprocessing upgrade). New export-contract constants:
> `SMEAR_TAPS`, `SOFT_FOCUS_KERNEL`, `SPLIT_FEATHER` 0.08,
> `SMEAR_RADIAL_SPAN` 0.35, `SMEAR_DIR_SPAN` 0.25. The patched programs are
> uniform-neutral for plain depth scenes but different PROGRAMS, so the
> dof-active fixture was a DELIBERATE re-record: `ws:dof-spike` grew to ten
> scenes (one per style, plus an anamorphic→split crossfade proving the
> patched per-side path), every style eyeballed first. Null-for-legacy is
> untouched: dof-less projects never build the patched materials.

> **2026-08-06 (the dof-only lane):** toggling dof in an effects-free project
> visibly regraded the scene (contrast drop, whites to light grey). Root
> cause, pixel-probed A/B: the composer path decodes display-domain
> exact-colour surfaces to linear and re-encodes them around its tone map, so
> ANY real full-frame tone map bends the authored bytes the direct path shows
> raw, and on this WKWebView/ANGLE Metal stack the canvas and render-target
> program variants do not even tone-map identically (a probe pixel decoded
> ACES-minus-its-matrices in a target pass; the macOS 27 translator family).
> The fix removes the seam BY CONSTRUCTION instead of matching curves:
> effects-free dof projects render every frame on the ORIGINAL byte-identical
> paths, and an active pose is blurred IN PLACE (canvas copy or SDR-scratch
> side, dof chain over the finished pixels with `encodeOutput` off, scene
> depth from a dedicated pre-pass; `copyTexSubImage2D` forbids sRGB-tagged
> destinations, so the canvas copy stays linear-tagged raw bytes). Probe
> proof: a dof-less twin frame AND a sub-LSB-blur frame both came back
> BYTE-IDENTICAL to the direct path (max diff 0 across 8.3M pixels); a strong
> rack blurs by true depth with colours held. Effects projects keep composer
> dof unchanged. `ws:dof-spike` re-recorded for the lane: 16:9 `a7a37eb0…`,
> 9:16 `58d0ac28…`, both Verify ×2 EQUAL (the same-day `ae8b22f3…`/
> `91680399…` pair and the original `cee2ab6f…`/`09f57c3c…` are STALE).

> **2026-08-01 (macOS 27 text shader):** macOS 27's Metal compiler rejects the
> code ANGLE generates for `inout` parameters bound to hoisted globals, so
> troika's derived text material never linked and every text mesh was invisible
> in preview AND export. A missing draw is not drift: the pre-fix `c2a8c54a…`
> reading was that bug, not a determinism failure. The fix is a second troika
> patch (`troika-three-utils@0.52.4`) whose generated `troikaVertexTransform`
> takes no parameters, copying the hoisted globals into locals and back.
> Re-roll it on any troika upgrade. The rewritten body moves text pixels on
> `showcase-tour`, a DELIBERATE move from `355f9429…` to `f304f1bd…`, recorded
> Verify ×2 with an export-path frame eyeballed for glyphs and stagger colours;
> `ws:launch-2026` came back EQUAL and UNCHANGED at `eb89826c…`, so the patch is
> pixel-null on that content. Baselines recorded before the OS upgrade cannot be
> compared across it.

> **2026-07-30 (deviceLayout):** multi-device scenes gained a sidecar
> `deviceLayout` block resolved to per-aspect placements by a pure toolkit
> function (`resolveDeviceLayout`: preset base at natural size, uniform
> compression against the safe width, per-device deltas on top). Widths are
> catalog `layoutWidth` CONSTANTS, never runtime bboxes, so licensed and
> placeholder builds lay out identically. Scenes without the block render
> through the untouched raw-placement path, byte-identical by construction
> (`pnpm gate` EQUAL `355f9429…` with the resolver in the render path). New
> gate fixture `ws:multi-device-spike` (arc, hero + laptop, depth pair with
> deltas, cascade, block-less null neighbour), 16:9 `fb2d4f84…` / 9:16
> `c940b3b2…` / 1:1 `ceb8e74c…` Verify ×2 with the scenes eyeballed.

> **2026-07-29 (scene3d draw order):** transparent scene3d look geometry (the
> grid lines especially) spans huge bounds, so three's per-object distance sort
> could flip it in front of the video window or cards at oblique angles (the
> lines drew THROUGH the window). `Scene3dBackdrop` now stamps every look
> renderable with `SCENE3D_RENDER_ORDER` (-50: after the fixed layer's -100,
> before all content at 0), pinning backgrounds behind content at any angle.
> Scenes without a scene3d background are byte-identical by construction
> (`ws:video-window-spike` EQUAL `6dfe68a6…`, `pnpm gate` EQUAL `355f9429…`);
> scene3d scenes can move pixels wherever the old sort was flipping, the fix
> itself. `ws:bg3d-spike` verified identical ×2 at `8f6fc517…` with frames
> eyeballed; note the background-rethink worktree's interim `632ee44d…` record
> is superseded when that branch rebases onto this.
> **2026-08-05 correction:** the `#104` traverse also stamped GROUP nodes, and
> three.js reads a group's `renderOrder` as `groupOrder` (which outranks
> `renderOrder` in the painter sort), so the four opaque looks drew before the
> backing quad and were painted over: `8f6fc517…` encodes those broken
> (invisible) frames. Groups are now skipped; `ws:bg3d-spike` re-verified
> identical ×2 at `4e0d3840…` with all four looks eyeballed restored.

> **2026-07-29 (video window: stage removal, placement, recording crop):**
> the backing stage was removed outright (Michael's call: the scene's own
> background/backdrop shows through instead; legacy `stage` blocks are silently
> inert), the window gained a frame-fraction `offset` placement, and the new
> `recording: true` flag crops a raw macOS window capture's margins
> (`RECORDING_INSETS` 112/76/112/148 + a 2px edge trim so bilinear sampling and
> the baked corner AA never bleed in) and, under the `macos` radius preset,
> masks at the true 26pt-at-2x radius (`RECORDING_RADIUS_PX` 52); other presets
> and custom fractions stay as authored. Constants measured off a real Tahoe
> capture (hard edges; radius fitted ±0.7px on both top corners). The crop is a
> UV affine in a VideoWindow-only program (`kookaburra-vw-card-v1`) whose
> identity transform is IEEE-exact, and the LS shaders are untouched: `pnpm
> gate` EQUAL (`355f9429…`). The flag is auto-detected at pick time from the
> cached poster's black margins (editor-only, decides a doc value, never runs
> in the render path). The stage removal is a deliberate visual change to
> video-window scenes only: `ws:video-window-spike` (plus a new recording-mode
> scene) re-recorded `d67eb1d4…` → `6dfe68a6…` Verify ×2 EQUAL after
> corner-crop eyeballs via `--action screenshot`; the same hash re-verified
> EQUAL after the flag moved from an interim `radius: "recording"` value to
> the boolean (the value still degrades), proving the rework pixel-null.

> **2026-07-29 (before/after comparisons):** the compare path (one scene as
> two side hosts composited under a mask on the transition A/B pools, see
> docs/comparisons.md). Its failure modes are the transition path's: every
> mask-shader sample re-encodes via `sampleDisplay` (SDR) or round-trips
> ACES (HDR), persistent layers hide during the side renders and draw once
> over the composite, per-side root-scene state applies before each side's
> render and restores on exit, and the divider is a CPU-computed uniform.
> Two lessons of its own: a comparison holds an MSAA A/B pair for its whole
> scene (not a transition's brief window; `releaseIdlePools` carries the
> compare flags, and the all-aspect fixture legs measured a 1460 MB peak,
> well under the 4 GB WebContent ceiling), and everything derived from
> scene docs at LOAD (`compareBDocs`/`compareBThemes`) must re-derive in
> `handleDocChanged`'s in-memory patch or the after side renders empty.
> The `01-null` control scene pins the solo fast path byte-identically.

> **2026-07-26 (camera rigging, the full batch):** free-flight camera rigs
> (`cameraMode` + `cameraRig`, the canonical sampler, centripetal smoothing,
> the three aim modes, roll, per-channel eases), the Free-mode tools and ghost
> path, the rig inspector and conversions, DepthStage with envelope-driven
> layer sizing, presets, Present rig looping and cross-scene continuity.
> `ws:launch-2026` stayed EQUAL and UNCHANGED (`eb89826c…`) throughout: every
> block is null-for-legacy, and the orbit sampler is untouched code rather than
> a branch. `showcase-tour` moved DELIBERATELY, from `7ad3e821…` to
> `b65ec5fc…`, when scene 7 (`07-rig-flight`, a DepthStage fly-through) was
> added to close the batch; the gate leg grows from ~8.2 s to ~10.2 s. The rig
> fixture `ws:camera-rig-spike-opus` verifies at `27d6383b…` across ten scenes,
> one concern each.

> **2026-07-27 (variant decision and the footprint overscan):** this build won
> the two-variant race (evidence: byte-identical raw frames on seven of ten
> twinned fixture scenes; the mp4 SSIM differences on the other equal scenes
> were x264 rate-control and lookahead bleed, proven by md5-equal
> `--action screenshot` frames) and absorbed the loser's wins. Making the
> showcase backdrop actually size from the envelope exposed a real gap:
> `envelopeOverscan` ignored view direction and roll, so a banked tangent
> flight overran its rect. `rigOverscan` replaces it, intersecting the four
> frustum corner rays with the layer's plane at each of the 64 fixed samples,
> floored by the existing constant and capped at `OVERSCAN_CAP` (4).
> `showcase-tour` moved DELIBERATELY again, `b65ec5fc…` to `355f9429…` (the
> envelope-sized backdrop plus the footprint maths); the repaired rig fixture
> (roll restored after an in-hand edit zeroed it) re-recorded at `f5107f56…`.
> `ws:launch-2026` stayed EQUAL and UNCHANGED at `eb89826c…` through the whole
> port: no rig, no rect, nothing to resize. The 5:4 showcase hash #67 recorded
> on the trimmed manifest (`9db959e2…`) is stale again for the same reason:
> scene 7 changed the project; re-run it (and 3:2 if wanted) after this batch
> lands.

> **2026-07-26 (relative-light aim fix):** a camera-space light with no `target`
> aimed at the camera-space origin, which IS the camera, so every such rim light
> pointed backwards at the lens and lit nothing. A defaulted aim now resolves to
> the subject in world space, making all three spaces agree that no target means
> aim at the thing. Found by rendering `ws:lighting-audit` side by side against
> the parallel variant build, not by a gate: the dead rim rendered
> deterministically and verified EQUAL. Both anchors stayed EQUAL and UNCHANGED
> (`97af238c…` / `fe701549…`), because every light in the gate fixtures sets an
> explicit target; only the audit fixture's untargeted rims move, and they now
> match the variant's reference render pixel for pixel.

> **2026-07-25 (scene lighting v9, the full batch):** the lighting batch (schema
> v9 with the theme -> project -> scene layers, four free light types with
> World/Camera/Subject spaces resolved per render target, six new bundled
> HDRIs + user `.hdr`/`.exr` sources + `"none"`, emissive fixtures with repeat
> arrays and the env-mirror bake, preview-only placement helpers on their own
> camera layer, lighting keyframes, the preset grid, the explicit
> tone-mapping/exposure contract, and the housed practical props) landed with
> both anchors EQUAL (`97af238c…` / `eb89826c…`, the post-splice launch
> baseline) and the 16-scene lighting fixture verifying identical ×2 at
> `fe701549…` (supersedes the interim 15-scene `b5d80edb…`). Every new
> block is null-for-legacy: absent at all layers resolves the v8 path verbatim,
> pinned by the whole-lineup theme-equivalence test.

> **2026-07-25 (sentinel splice, Michael's call):** `ws:launch-2026` was
> trimmed 19.0 s → 8.2 s (5000/3000×4/5000 → 2400/1600×4/2400 ms; scenes and
> transitions untouched) to stop the sentinel becoming a growing time sink at
> PR cadence, especially with multiple worktrees queueing runs. The splice was
> done safely: the full-length hash `b70c9788…` was proven EQUAL the same
> morning on the same render code (no render-path commits between proof and
> re-freeze), then the trimmed anchor recorded EQUAL at `eb89826c…` with
> per-scene frames eyeballed. The pre-trim manifest is backed up beside the
> batch plan docs, so the old anchor remains re-verifiable. Coverage note:
> frames past each scene's cut (late counter states, clip frames past 2.4 s)
> left the proof at the splice.
>
> **2026-07-25 (gate speedup + footprint fix):** showcase-tour's scene
> durations were trimmed for gate speed (14.2 s → 8.2 s timeline, 492
> frames/pass; scene 05's camera end key 2700 → 2200 ms), `pnpm gate` became
> one comma-list boot, and the WebContent footprint fix landed (idle render
> pools released during export; a 4K export's plateau dropped 4468 → 3177 MB).
> The trimmed 16:9 baseline recorded EQUAL at `7ad3e821…` in the same gate
> that held `ws:launch-2026` EQUAL at `b70c9788…` (proof the pool lifecycle
> changes move no pixels); per-scene frames eyeballed off the gated export.
> The 3:2 baseline (`0e64593d…`) predates the trim and re-records on next
> need. Whole-pair gate wall time: ~4:20.
>
> **2026-07-25 (5:4 aspect):** `5:4` (2700×2160) joined the first-class,
> feature-scoped set. `showcase-tour` 5:4 recorded its first baseline
> `554bbd23…` (Verify ×2 EQUAL) after eyeballing 5:4 frames via
> `--action screenshot`; the frames also showed scene 0's headline overflow in
> narrow aspects is pre-existing scene authoring (1:1 crops harder than 5:4),
> not aspect plumbing. The standard 16:9 pair re-ran EQUAL with
> `ws:launch-2026` on its anchor, so the `AspectName`/`FORMATS` addition is
> null-for-legacy. `554bbd23…` anchored the pre-trim showcase manifest and is
> STALE: re-recorded `9db959e2…` on the trimmed manifest (Verify ×2 EQUAL,
> 2026-07-26), now the table's 5:4 column.

> **2026-07-24 (editor improvements batch 2 + 3:2/2:3):** the batch (inspector
> fixes, video-window loading/aspect seeding, follow-media for video windows,
> editor tap/space/progress fixes, template cleanup, device subtitles, the
> 3:2/2:3 aspects) landed with all three anchors EQUAL (`97af238c…` /
> `b70c9788…` / `d67eb1d4…`): the video-window aspect seed and preparing card
> are null-for-legacy (no `media.aspect` in existing docs; `isExporting()`
> stands the card down and the extract barrier means no captured frame can
> sample it), extraction progress is a `-progress pipe:1` observability add
> with unchanged output args, and everything else is editor/UI or template
> data. `showcase-tour` 3:2 recorded its first baseline `0e64593d…` (Verify ×2
> EQUAL) after eyeballing 3:2 and 2:3 frames via `--action screenshot`; 2:3
> stays unbaselined until a project ships in it (the 4:5 precedent). This
> merge also corrects the same-day `1ce41e1d…` re-record below: a fresh git
> worktree lacks the gitignored licensed device glbs, so both that run AND its
> "clean origin/main" comparison rendered the placeholder device (EQUAL, wrong
> pixels); with the models present the identical code reproduces `97af238c…`
> Verify ×2 EQUAL, so the standing baseline never moved. Copy
> `src/assets/models/licensed/*.glb` into a worktree before gating from one.

> **2026-07-24 (animated backgrounds through transitions):** shader background
> fills write display-domain colour raw, which the compositor's hardware-sRGB
> A/B targets encoded a second time, so every transition frame over an animated
> background rendered one sRGB encode brighter (the "flash to white" report;
> measured mean RGB 4/9/18 solo vs 32/57/79 mid-crossfade). `shaders/wrap.ts`
> now reroutes each vendored fragment's `main()` so the engine can flip the
> output to linear light (`u_linearOut`, set per draw from
> `renderer.getRenderTarget()`) for colour-managed targets only; the canvas path
> is a pass-through, so solo frames are byte-identical. New fixture
> `transition-bg-spike` (mesh-gradient → crossfade → swirl → dip-to-white →
> neuro-noise) covers the previously untested shader-background × transition
> combination, recorded `2df76336…` Verify ×2 EQUAL after eyeballing seam frames
> via `--action screenshot`. Anchors: `ws:launch-2026` EQUAL (`b70c9788…`);
> `showcase-tour` Verify ×2 EQUAL and byte-identical to a clean `origin/main`
> run on the same machine (both `1ce41e1d…`). CORRECTED same day (see the note
> above): both runs came from worktrees missing the licensed device glbs, so
> `1ce41e1d…` is the placeholder-device render; `97af238c…` stands.

> **2026-07-23 (video window):** the VideoWindow feature landed with both anchors
> EQUAL (`97af238c…` / `b70c9788…`): the host-side `VideoWindowFallback` mounts
> nothing without a sidecar block, and exposing the LayeredScreenshot card-mask /
> shadow shader helpers is an `export`-only change (no pixels move). The
> `ws:video-window-spike` fixture (a screen recording in a bordered window over a
> gradient stage, and over a gradient stage with a drift + camera orbit) recorded
> `d67eb1d4…` Verify ×2 EQUAL after eyeballing the frames via `--action
> screenshot`. The hands-on inspector pass (full-height media/stage sub-menus,
> border controls, live-drag sliders that write history-less and record one undo
> on release, tilt-reveal riding forward so it clears the stage) is editor-only
> or additive: the border default is the old hairline byte-for-byte and the
> tilt-reveal `posZ` is inert unless that preset is used, so anchors held.

> **2026-07-21 (softer stack shadows):** the card shadow opacity dropped 0.3 →
> 0.2 during Michael's hands-on pass, a deliberate visual change: re-recorded
> the spike `ade1b666…` → `4ec7b223…` (Verify ×2 EQUAL) after eyeballing the
> frame. Anchors untouched (no LS content).

> **2026-07-20 (layered screenshot):** the Layered Screenshot feature landed
> with both anchors EQUAL (`97af238c…` / `b70c9788…`): the fallback mounts
> nothing without a sidecar block, and the one exporter change (registering
> sidecar-declared screen videos before the extract barrier, closing the
> Suspense race the first spike eyeball exposed) walks an empty list for every
> existing project. The new `ws:layered-screenshot-spike` fixture (image/video
> cards, text item, all four presets, a transition and a legacy-camera scene)
> recorded `ade1b666…` Verify ×2 EQUAL after frame eyeballs.

> **2026-07-20 (present mode, float fix):** the Present feature landed with the
> legacy sentinel EQUAL throughout (`b70c9788…`; the hold clamp, timing registry
> and present-mode flag are realm-inert on the export path). The float motion
> preset now rises from the resting pose instead of dipping below it (the old
> symmetric sine clipped devices through the stage floor), a deliberate visual
> change: re-recorded `showcase-tour` `da74c52b…` → `97af238c…` (Verify ×2
> EQUAL) after eyeballing the abyss scene's raised device via
> `--action screenshot`.

> **2026-07-20 (transition ownership flip, manifest v2):** both anchors held
> EQUAL through the flip (`da74c52b…` on the migrated v2 manifest, `b70c9788…`
> through the legacy shim), proving the relabel moves no pixels; the
> `transition-spike` baselines were first recorded this session (`3cad687f…` /
> `8447d8e9…`, Verify ×2 EQUAL in both aspects, same change set).

> **2026-07-20 (later, v14 transition pack):** slice/dissolve/warp + progress
> easing landed with both anchors still EQUAL (stored specs carry no `ease`, so
> the identity path is byte-stable). `transition-spike` gained three scenes
> covering the new seams and both easing curves, a deliberate content change:
> re-recorded `3cad687f…` → `6b058e1b…` (16:9) and `8447d8e9…` → `74e02850…`
> (9:16) after eyeballing all three seams mid-transition.

> **2026-07-17 (v0.2.0 release session):** packaged parity restored on both
> anchors: `showcase-tour` packaged EQUAL `da74c52b…` (byte-identical to dev for
> the first time; was `ef9ff1b2…` since the v0.1.0 gates) and `ws:launch-2026`
> packaged EQUAL `b70c9788…`, both on the signed v0.2.0 build. Root cause and
> fix: the release-binary resource-root gate (PR #8; "Native allowed roots"
> bullet above).

> **2026-07-16:** `showcase-tour` re-recorded `226104ee…` → `cd511715…`: a
> deliberate content change (device scenes moved to the iPhone 17 Pro model at
> rotation 0), not drift; `ws:launch-2026` re-verified EQUAL at `b70c9788…` the
> same session, so the engine paths (device registries/fallbacks, fit axis, lid
> control) are pixel-null for legacy content.

> **2026-07-16 (later, text-colour session):** `showcase-tour` re-recorded
> `cd511715…` → `da74c52b…`. The cause is the licensed device glbs regenerated
> on 2026-07-15 (dev already gave `da74c52b…` before this session; `cd511715…`
> was not reproducible after the regen). Re-proven Verify ×2 EQUAL today with
> the text-colour plumbing (`textKey`/`defaultColor`) and the mask-reveal
> `clipRect` fix in tree, so both are pixel-null for the sequential export: the
> stale-clip bug only ever bit seeks that jump a whole reveal (borrowed-clock
> captures, scrubbing), never the frame-by-frame export loop. Mask-reveal
> headlines used to keep their LAST concrete `clipRect` once the sweep completed
> (r3f leaves a prop that becomes undefined at its previous value), leaving text
> invisible after such a seek (the invisible Paper-theme preview titles); the
> unclipped state is now spelled `null`. An extracted scene-2 frame was
> eyeballed, and `ws:launch-2026` re-verified EQUAL at `b70c9788…` the same
> session (the legacy path never sets `clipRect`). This note was restored on
> 2026-07-17 after the public-release history squash captured a tree from just
> before the original doc commit.
| `ws:emoji-spike` (emoji/symbol pipeline) | `fc772d5b…` | `3e0c8cfb…` | n/a | n/a |
| `ws:shader-spike` (animated background pack) | `9ed15e3e…` | n/a | n/a | n/a |

> **2026-07-13 (emoji session): the pre-emoji 16:9 hashes had already drifted**
> (`b70c9788…` → `26fc273b…`, `e967fe26…` → `d4ec139c…`): an A/B control at
> commit 697a079 (pre-emoji) reproduced the NEW hashes, so the drift sits
> somewhere in b53d2c8..697a079 (or an OS update) and pre-dates the emoji work,
> which was proven pixel-null against 697a079 on the same machine/day. The 16:9
> values above are re-recorded from that session; the non-16:9 legs are stale
> from the b53d2c8-era recording and re-record at the next full-matrix run.
> Until then, judge gates by same-machine A/B against the pre-change commit.
> `ws:emoji-spike` proved cross-SESSION equality too (fresh-raster session and
> disk-cache session, same hash).

> **2026-07-13 (TitleBlock session):** `showcase-tour` 16:9 re-recorded
> (`d4ec139c…` → `928c9cec…`) after its title scenes moved onto the `TitleBlock`
> primitive (a deliberate composition change: standardised sizes/positions from
> the theme scale). `ws:launch-2026` verified EQUAL (`26fc273b…`) in the same
> session, proving the underlying `AnimatedHeadline`/`AnimatedCounter` layout
> props (`textAlign`/`anchorX`/`maxWidth`) are byte-null at their defaults.

> **2026-07-14 (animated backgrounds session):** the unified Background editor
> (stage write-through, staging registry) and the shader background pack landed;
> `showcase-tour` (`928c9cec…`) and `ws:launch-2026` (`26fc273b…`) both verified
> EQUAL: the new render branch is structurally inert without a `shader` spec.
> New fixture `ws:shader-spike` (four scenes, one per vendored effect
> mesh-gradient / simplex-noise / swirl / neuro-noise, absolute-clock `u_time`,
> a crossfade between two different fills) gates any change to the vendored
> GLSL, the shared vertex shader or the `FixedShader` uniform plumbing.
> **Correctness lesson, same day:** the fixture's FIRST recorded hash
> (`a5e1509e…`) was two identically-BROKEN runs: every fragment failed to
> compile (`gl_FragColor` is not aliased for GLSL3 `ShaderMaterial`s in this
> three version; custom shaders must declare their own `out vec4 fragColor;`,
> the transitionShader convention) and three silently skipped the quad, so
> Verify ×2 passed on frames with no background at all. Re-recorded at
> `644864c7…` after the fix, with exported frames eyeballed. Verify proves
> DETERMINISM, never correctness: any new-visual fixture baseline must have at
> least one exported frame looked at before its hash is recorded.

> **2026-07-14 (same day, pack completed):** `warp` + `smoke-ring` joined the
> vendored set: both sample the shared randomizer texture, decoded from the
> source's embedded PNG into raw bytes at vendor time (`noiseTexture.ts`) so the
> `DataTexture` builds SYNCHRONOUSLY (no async decode, no new export preload
> barrier). `ws:shader-spike` grew to six scenes and re-baselined at
> `9ed15e3e…` (frames eyeballed first); `ws:launch-2026` verified EQUAL
> (`26fc273b…`) against the shared `FixedShader` texture wiring.

> **2026-07-15 (clip-spike removal): the 2026-07-13 "unexplained drift" is
> solved.** The Phase 0 WebCodecs clip spike (`697a079`) probed a hand-placed
> `<sha>-spike-60fps` cache dir in the LIVE clip path; on the dev machine that
> dir existed for `demo-app.mp4`/`sample-recording.mp4`, so from 10:06 that
> morning both gate projects decoded that clip via WebCodecs instead of the PNG
> sequence. The drift A/B "control" ran AT `697a079` with the spike active,
> which is why it reproduced the new hashes: the drift (`b70c9788…` →
> `26fc273b…`) WAS the spike, not an OS update. Removing the spike (throwaway
> by design, and it hardcoded dev-machine paths) reverted the clip to the PNG
> path: `ws:launch-2026` verified EQUAL back at the original `b70c9788…`
> byte-for-byte, retroactively proving everything from `b53d2c8` to now
> pixel-null for the legacy reel. `showcase-tour` re-recorded at `226104ee…`
> (EQUAL; device-scene and title frames eyeballed).

## Codec notes

The default is software `libx264` with ffmpeg `bitexact` flags for a reproducible
container. The hardware `h264_videotoolbox` encoder is selectable; it has passed
`Verify ×2` on Apple Silicon, but hardware bit-exactness is machine/OS-version
dependent, so `libx264` stays the gate codec. **ProRes:** `prores_ks`, software
ProRes 422 HQ (`-profile:v 3`, `-vendor apl0` pinned so the bitstream can't drift
across ffmpeg versions), 10-bit 4:2:2 in a `.mov` container: passes `Verify ×2`
byte-identically; the output extension and pixel format are codec-dependent in
`start_export`, and the same `bitexact` flags keep the MOV muxer reproducible.
**Hardware ProRes:** `prores_videotoolbox`, a fast-draft lane on the media
engine's dedicated ProRes blocks (`-profile:v 3`, `-pix_fmt p210le`, no
`-vendor`, profile-only like `prores_ks`); same quality class as software ProRes
but excluded from Verify like every VideoToolbox lane. The **editor's
"Render to project"** flatten also defaults to hardware
(`-hwaccel videotoolbox` decode + `h264_videotoolbox` at 0.25 bits/pixel,
one software retry on failure): contract-exempt because downstream determinism
derives from the rendered file's fixed bytes, re-extracted like any source.
