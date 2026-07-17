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
| **Preview frames interleaving a Verify ×2**: between the two passes the preview driver rendered a wall-clock-varying number of frames (restored clock, preview size), leaking GPU/render state into pass B's first frames | `verifyDeterminism` holds the preview stand-down across BOTH passes; `engine/exportState` is depth-counted so the whole-run hold nests over each pass's own. Pass B starts from exactly the state pass A ended in. |
| **Parallel font preload**: troika claims shared-atlas cells at preload COMPLETION, i.e. fetch-race order, shifting multi-font projects' glyph cells per BOOT (a per-session hash lottery: every run internally consistent, every boot different) | `preloadAppFonts` preloads SEQUENTIALLY in canonical order (Inter Regular, then declaration/ref order), and `loadProject` pre-generates every project face's glyphs BEFORE the scenes mount. See "Fonts". |
| Muxer writing a wall-clock `creation_time` / encoder version tag | ffmpeg `-flags:v +bitexact -fflags +bitexact -map_metadata -1` (set in `start_export`) so the container is reproducible. |
| Hardware encoder (`h264_videotoolbox` / `hevc_videotoolbox` / `prores_videotoolbox`) bit-variance | Default to software `libx264` (deterministic); the VideoToolbox lanes are opt-in fast drafts excluded from Verify. |
| Hardware DECODE (`-hwaccel videotoolbox`) is not pixel-identical to software decode (measured: every frame differs slightly, ~5% of pixels off by 1–3/255) | Clip extraction is dual-lane: the everyday `hw` lane and the baseline `sw` lane own separate cache dirs (`<sha>-60fps-hw` / `<sha>-60fps`), and deterministic-codec exports (all Verify runs) pin to `sw`, so hardware frames can never reach a gated export. `engine/clips.ts` lane rule. |

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
the original crossfade/dip/slide/wipe programs stay source-identical; legacy
projects' byte-identity is structural. Glitch randomness is an integer PCG hash
(never `fract(sin)`: integer ops are exact across compiles); all tap counts and
per-type defaults are export contract; unknown transition types degrade to
crossfade with a warning.

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
- **Theme lighting is static per scene.** `<SceneStage>` mounts plain lights from
  theme tokens (fixed `LIGHT_RADIUS`, azimuth/elevation → position, export
  contract); staged primitives' bundled lit sets stand down via
  `useSceneStaged()` (explicit `lit` wins). No token is ever time-derived; scene
  "motion" of light is out of scope by design.
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
  synchronous.

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
- **Diff the `renderStateFingerprint` FIRST** on any cross-build divergence: every
  verify result records tone mapping, real context attributes (AA grant, sample
  caps), environment/light state and lit-material specular values. It names a
  missing texture class in one JSON diff before any pixel archaeology.

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

**4:5 is first-class but feature-scoped**: `FORMATS["4:5"]` = 2160×2700;
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
- **Tier 1: the DEFAULT gate (1–2 runs):**
  1. ONE feature-matched project, Verify ×2, **16:9 only**: pick the project
     whose content exercises the changed path: `showcase-tour` for
     themes/staging/text/presets (the rolling gate project, six themes, devices,
     video, ImageCard, camera moves and bloom in one project),
     `ws:device-video-spike` for device/media/camera, `ws:fx-spike` for effects, a
     hand-rolled workspace mini-project for anything narrower.
  2. `ws:launch-2026` Verify ×2 16:9: must be EQUAL (the null-for-legacy proof).
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
- **Recording rebases:** once the changed code path is PROVEN deterministic by
  the Tier-1 verify, record the other affected projects' new hashes from a
  single export batch: do not Verify ×2 each one.
- Always pair a gate with an extracted-frame visual check (byte-identical wrong
  pixels pass hashing).

### Current baselines

Baselines are same-machine SHA-256 prefixes of the frozen-path (`libx264`,
16:9 unless noted) export, recorded after a passed Verify ×2. Two projects anchor
the set: the null-for-legacy sentinel (`ws:launch-2026`, a hash-identical
workspace copy of the reel dropped from the bundled set on 2026-07-13) and the
bundled rolling-gate project (`showcase-tour`):

| Project | 16:9 | 9:16 | 1:1 | 4:5 |
| --- | --- | --- | --- | --- |
| `ws:launch-2026` (legacy sentinel: must stay EQUAL) | `b70c9788…` | stale | stale | stale |
| `showcase-tour` (rolling gate) | `da74c52b…` | stale | stale | stale |

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
