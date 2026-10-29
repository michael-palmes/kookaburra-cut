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
| Loading a live Website during playback or export | Website content is author-time native UI only; playback and export render the saved project PNG through deterministic WebGL chrome (`docs/scene-website.md`). |
| **Fonts loaded lazily from a CDN** (troika default) | Bundle a local `.woff`; `preloadFont({ font, characters }, cb)` and await it before frame 0; set troika `unicodeFontsURL` to a self-hosted/offline path. |
| troika SDF generated async in a worker | Pre-generate glyphs (preload) and await all text sync before the first captured frame. |
| Video clips via `HTMLVideoElement` seeking | The ffmpeg sidecar pre-extracts each clip to a CFR PNG sequence (cached under `$APPDATA`, keyed by source hash); `VideoClip` samples `frameIndex = floor((localMs − startMs)/1000 × fps)` off the clock. `engine/clips.ts` + `toolkit/media/VideoClip.tsx`. |
| Reading UI state (zustand) in the export path | The exporter uses the pure clock only; it must not read the editor store. |
| **Trusting `flushSync` to commit the canvas tree**: react-dom's `flushSync` does NOT flush the react-three-fiber reconciler; the canvas subtree commits on the r3f scheduler's own timing, so per-mesh readiness hooks can belong to the PREVIOUS frame when the exporter reads them (stale clip texture / stale text) | `ExportBridge` stamps the clock value each canvas commit rendered for; the export loop awaits `awaitCanvasClockCommit(tMs)` before trusting any readiness hook. |
| **Awaiting troika `sync(cb)` naively**: troika has no `isTroikaText` mesh flag (matching on one awaits nothing), silently DROPS the callback when `_needsSync` is false (including mid-typeset), and only kicks changed text in `onBeforeRender` (one frame late) | `awaitTextSync` matches troika's `Text` by class (its `material` is an `[outline, main]` array for outlined text: neon, whole-block blur-in), kicks a pending typeset itself pre-render, awaits quiescence via the `synccomplete` event, and fails the run, naming the text, if a typeset never lands. |
| A mid-run window resize retriggering r3f's size handling (corrupts the export's fixed drawing buffer for every remaining frame) | The frame loop re-asserts the export size/camera aspect if drifted, after the awaits and immediately before the (synchronous) render + readback. |
| Non-preloaded textures/assets | Await all asset loads before frame 0. |
| **Rendering into a plain render target** (2026-10-19): three r185 tone-maps, encodes sRGB in-shader and converts the clear colour only for the canvas or an `isXRRenderTarget` target, so `toneMapped` materials land raw in a plain one, and hardware `SRGB8_ALPHA8` storage then blends and resolves MSAA in linear light. Transition frames showed raw-colour, bolder text; comparison and framed scenes were never tone-mapped, and a comparison inside a transition was encoded twice. | Every SDR compositor target is a display target (`engine/displayTarget.ts`: the XR flag plus `RGBA8` storage), and its samplers read raw; `displayTarget.test.ts` pins three's gate and every SDR sampler. On any three upgrade, re-check each `isXRRenderTarget` read in three's WebGL renderer (`node_modules/three/src/renderers` outside `common/`, `webgpu/`, `webgl-fallback/` and `webxr/`: six in r185 and r186, `shaders/UniformsUtils.js` among them) and eyeball `transition-spike` frames. |
| **Shader colours read through three's `Color`** (2026-10-22): with colour management on, `new Color(hex)` holds linear light, so the 2D shader fills (which write display-domain values raw) rendered every hex as if decoded twice: `#efede8` landed `#dcd8ce` and dark glows crushed to black | `hexToRgba` (FixedBackdrop.tsx) reads the sRGB bytes back (`getHex(SRGBColorSpace)`), pinned by `shaderColours.test.ts`. A deliberate rebase for projects with 2D shader backgrounds only; 3D looks convert through `colorspace_fragment` and never had it. |
| **A cold-mount suspense holding EVERY scene out of the canvas**: all scenes share one `<Suspense fallback={null}>` (App.tsx); a suspending primitive (`ImageCard`'s `useTexture`) keeps the whole boundary uncommitted until React's retry render lands, and that retry races the export preamble on the wall clock. Frame 0 rendered first captures a scene-less (white) frame. `awaitCanvasClockCommit` cannot catch it: the clock is already committed at its initial 0. | `awaitSceneHostsCommitted(slots.length)`: the preamble's LAST barrier spins until every scene's host has registered (registration is a `useEffect`, which only runs once the boundary's content commits). The preceding asset preloads resolve whatever the suspense was waiting on, so the wait is a few ticks. |
| **A layout that depends on a measurement only the mounted tree can request**: `TitleBlock` cascades its header icon and subtitle off the title's MEASURED block height, but its props exist only once the scene is in the tree, so the preamble cannot pre-warm them the way `preloadPanelMeasures` does for overlay panels. A cold pass would render frame 0 pre-measure while a warm second pass renders it cascaded. | `awaitTitleMeasuresSettled()`, the barrier after `awaitSceneHostsCommitted`: mounted TitleBlocks report their outstanding typesets, and the spin exits only once they have landed AND the tree has re-rendered with them (`engine/titleBlockMeasure.ts`). Single-line text solves to a hard 0 growth, so standing layouts keep their authored constants bit-for-bit either way. |
| **Layout derived from measured text** (a pill sized by `useTextMetrics`, a pinned `durationMs` reveal waiting on its unit count): the derived state lands one re-render after its face parses or its first typeset, so a frame captured in between draws the pre-measure layout. | Pending reports (`engine/textDerivedState.ts`, from layout effects): `awaitTextSync` settles typesets, spins (bounded at 5000) until nothing is outstanding, then settles once more for typesets the settling commit queued. A tree that reports nothing takes the old path exactly. Preview captures (`captureFrameAt`) also run the export's clip, text and emoji barriers, in that order. |
| **Preview frames interleaving a Verify ×2**: between the two passes the preview driver rendered a wall-clock-varying number of frames (restored clock, preview size), leaking GPU/render state into pass B's first frames | `verifyDeterminism` holds the preview stand-down across BOTH passes; `engine/exportState` is depth-counted so the whole-run hold nests over each pass's own. Pass B starts from exactly the state pass A ended in. |
| **Parallel font preload**: troika claims shared-atlas cells at preload COMPLETION, i.e. fetch-race order, shifting multi-font projects' glyph cells per BOOT (a per-session hash lottery: every run internally consistent, every boot different) | `preloadAppFonts` preloads SEQUENTIALLY in canonical order (Inter Regular, then declaration/ref order), and `loadProject` pre-generates every project face's glyphs BEFORE the scenes mount. See "Fonts". |
| Muxer writing a wall-clock `creation_time` / encoder version tag | ffmpeg `-flags:v +bitexact -fflags +bitexact -map_metadata -1` (set in `start_export`) so the container is reproducible. |
| Hardware encoder (`h264_videotoolbox` / `hevc_videotoolbox` / `prores_videotoolbox`) bit-variance | Default to software `libx264` (deterministic); the VideoToolbox lanes are opt-in fast drafts excluded from Verify. |
| Hardware DECODE (`-hwaccel videotoolbox`) is not pixel-identical to software decode (measured: every frame differs slightly, ~5% of pixels off by 1–3/255) | Clip extraction is dual-lane: the everyday `hw` lane and the baseline `sw` lane own separate cache dirs (`<sha>-60fps-hw` / `<sha>-60fps`), and deterministic-codec exports (all Verify runs) pin to `sw`, so hardware frames can never reach a gated export. `engine/clips.ts` lane rule. |
| **A GPU-process stall mid-readback** (2026-10-01: the unified log shows `WebContent Connection::waitForSyncReply: Timed-out while waiting for reply for RemoteGraphicsContextGL_ReadPixelsSharedMemory`, then a GPU process restart). The timed-out `readPixels` delivers no pixels: a fresh buffer comes back all zero (the black preview cards), and the export reuses one buffer, so there a stall could silently repeat the previous frame instead. The restored context renders with every render target emptied (PMREM environments, mirror bakes, cached by content key and never rebuilt), so later frames look plausible and are wrong. Verify cannot be trusted with it: stalls show only as a mismatch, and a restart before both passes is EQUAL and wrong. | `readFrameOrThrow` (`engine/readback.ts`) zeroes the reused buffer before every export and `captureFrameRgba` readback, then fails the run, before the frame reaches `push_frame`, on an all-zero result, a lost context, or any context loss on the live canvas since it opened (`ExportBridge` counts `webglcontextlost` per canvas). Exports and captures also refuse to start on such a canvas. The error reads "GPU stalled (…): … quit and reopen Kookaburra Cut, then rerun"; autoruns are a fresh boot, so rerunning `kookaburra:run` is the reopen. A delivered read overwrites every byte, so good frames are untouched (gate:merge EQUAL 2026-10-03). |
| **A poisoned render window kept alive by queued requests** (a multi-agent session, 2026-10-16): after a stall the render window correctly refused every capture, but idle teardown waited for an empty queue and agents' retries kept it alive for about 50 minutes | The capture service answers `gpuStalled` and destroys the window, so the next request gets a fresh realm; recycles back off 0, 15 and 60 s and the GPU counts as wedged after three in 10 minutes; a silent-window watchdog destroys a window that sends no first beat within 30 s of its create (90 s in dev builds), or none for 45 s while render requests wait, and counts it like any stall (reason `silent`); a wake from sleep restarts its clocks, and kb's waiting line names the restart. Measured 2026-10-17: a killed GPU process recovers through a fresh window in about 4 s; one frozen and resumed did not recover within 5 minutes, so wedged means quit and reopen |
| **A lit primitive's environment rebuilt every frame** (measured 2026-10-02): `Device`, `DeviceMockup` and `HeroObject` each mounted drei's `<Environment frames={1}>`, whose layout effect re-runs whenever its children change, and the parent re-renders every clock tick, so every mounted lit primitive re-rendered its cube (six renders) and rebuilt its PMREM every frame: a 2 to 3x export slowdown and about 4 MB of GPU memory each. On a cold boot (hidden window or `--cold`, no preview frames) frame 0 used the mount-time build and every later frame a mid-run rebuild, and the two differed on a few highlight pixels (2 px, 131 vs 187), so cold pass A diverged from pass B at frame 0: a gate that passed or failed on window visibility. | One studio environment per renderer (`toolkit/lighting/studioEnvironment.ts`): the same three Lightformer rects, one cube render and one PMREM, built at the first lit mount and held on the root scene while any lit primitive is mounted (restored when the last unmounts). Nothing rebuilds it per frame, so cold and warm runs light devices identically. Frame 0 also draws twice and captures the second, so no frame is ever a run's first draw. |
| **A screen video registered after the extract barrier** (2026-10-10): a Device's screen clip registered only when the Device mounted, behind its model's suspense. With a cold clip cache (an acceptance bundle's first launch: it owns its own `$APPDATA`) the mount landed after `preextractClips` had read the registry, nothing awaited the extraction, and the consumer's pending readiness resolved at once, so pass A's frame 0 captured the black pending screen and pass B (cache now warm) the video. Not `--cold` or packaging: a dev run with the clip's cache dirs moved aside fails the same way. | The preamble registers every sidecar device video (`deviceVideoSlots`: both displays, both comparison sides) beside the media entries, and runs `prepareExportClips` again after `awaitSceneHostsCommitted` for anything registered at mount. A pending consumer's readiness (`pendingFrameReady`) waits for its current extraction (following a lane switch) and then its first completed bind; a cancelled bind run never releases it, a failed extraction or an unmount does, and a bind that has not started `FIRST_BIND_STALL_MS` after its extraction fails the run (one timer: hidden pages throttle spin chains). `useClipEntry` re-renders even when extraction settles between render and effect. |
| **Dev React's performance entries** (React 19.2 development builds, which every autorun and gate runs): react-dom and r3f's reconciler record a `performance.measure` with a props diff for every re-render whose props changed, and WebKit never evicts them. Every mounted scene re-renders per tick, about 1 MB a frame on a 40-scene project, so a Verify reached the 4 GB WebContent ceiling near frame 1250, and live preview playback of `ws:device-env-40` in `pnpm tauri dev` grew about 1.3 GB a minute (measured 2026-10-09). The packaged app runs production React and records none. | Every window entry installs a dev-only drain (`installDevPerformanceDrain` in `engine/devPerformance.ts`: a `PerformanceObserver` that clears marks and measures as they land), so preview, Present, the editor windows and DOM-only re-renders are all covered; the export loop also clears them synchronously every frame. The same preview playback holds flat at 1.2 to 1.6 GB. |
| **WebKit kills the WebContent process near its 4 GB footprint ceiling** (measured 2026-07-25: a 4K verify's page footprint rode at ~3.9–4.5 GB, dominated by never-freed compositor/composer MSAA render-target pools, ~285–886 MB each; when a periodic check under system memory pressure catches it over 4096 MB the process is killed ("Unable to shrink memory footprint … Killed" in the unified log) and wry auto-reloads the page; window focus does NOT lift the ceiling) | Export frames release the pools they did not touch (`releaseIdlePools` in compositor.ts, `releaseComposer` in effects.ts; the multi-project autorun also resets between legs), dropping the 4K plateau to ~3.2 GB; the SDR pair is lazy so fx projects never allocate it, and verify releases confirmed-identical retained frames early. Transient fx-transition-window spikes can still crest ~4.1 GB on heavy projects (launch-2026), so `runAutoRun`'s reload latch stays the backstop: one benign reload tolerated, then a fast, retryable failure naming this mode. Deeper shave if ever needed: a shared MSAA scratch target with plain resolve textures for the A/B pairs. Diagnose with `log stream --predicate 'process == "kookaburra-cut" AND composedMessage CONTAINS "footprint"'`. |
| **Stills: Present holds leaking into a video export or capture.** A held scene's text, groups and decorations freeze at the hold, so a frame rendered while the stills export holds scenes is not a pure function of `t`. | Guarded: `exportProjectHeld` and `captureFrameRgbaHeld` refuse to start while `hasSceneHolds()` (`assertNoSceneHolds`). The stills run writes its holds once (`replaceSceneHolds`) and clears them in `finally` before `setExporting(false)`, so the preview never draws a held scene either. |
| **Stills: a hold change the clock barrier cannot see.** When the playhead already sits on page 1's time, the clock flush is a no-op, so page 1 could render before the canvas tree commits the new holds. | `ExportBridge` stamps the hold version (`sceneHoldsVersion`) in a layout effect, in the same reconciler commit as every `useHeldLocalMs` reader, and `awaitHoldsCommitted(version)` waits for it before the first page. |
| **Stills: staggered headline timings landing late.** An `AnimatedHeadline`'s stagger spread is only known after its first typeset, so a timing snapshot taken too early misses it and a cold run's automatic still lands earlier than a warm run's. | A pending barrier: the headline reports pending (`reportPresentTimingPending`) until its units exist, and `awaitPresentTimingsSettled` spins text sync and a macrotask until no scene reports pending (failing after 5000 spins) before the snapshot. |
| **Stills: a late-mounted media registration.** A settle input that only a mounted primitive can report would move an automatic still whenever it lands after the page plan. | Media motion ends come from the sidecar (`sceneMediaMotionEndMs`, pure), never a mount-time registry; registered timings are read only after the preamble's asset preloads and `awaitSceneHostsCommitted`, and after the pending barrier above. |
| **Stills: capturing from `resolveAt(tMs)` instead of the page's plan.** An automatic still that settles in its outgoing transition is planned as the scene alone; resolving the clock time again composites the transition instead, and the text layer then describes a different frame. | `renderFrameInto` takes `resolved` as an argument, and the stills loop always passes `page.resolved` (the compare frame and text roots read the same value). |

## The loop (as implemented in `src/engine/exporter.ts`)

```
configureDeterministicEngine();               // anime.js: no rAF
await preloadAppFonts();                      // SDF glyphs ready before frame 0 (SEQUENTIAL: atlas order is contract)
await prepareExportClips(declared, …);        // ffmpeg → the CFR frame chunks each slot shows (cached)
// …models/images/LUTs/environments preloads…
await awaitSceneHostsCommitted(slots.length); // LAST barrier: the scenes are actually IN the canvas
                                              // (a cold-mount suspense can hold ALL of them out)
await prepareExportClips(declared, …);        // second pass: every mounted consumer's own frames
const total = Math.max(1, Math.round(durationMs / 1000 * fps));
const rgba  = new Uint8Array(width * height * 4);   // one reused buffer
gl.setSize(width, height, false);             // size the preview canvas to 4K for the run
for (let frame = 0; frame < total; frame++) {
  dropDevPerformanceEntries();                // dev React's per-render measures, never evicted by WebKit
  const tMs = frame * (1000 / fps);
  flushSync(() => clock.setCurrentMs(tMs));   // commits the DOM tree only —
  await awaitCanvasClockCommit(tMs);          // …the CANVAS tree (r3f reconciler) commits on its
                                              // own schedule; wait for its stamp before anything else
  await awaitVideoFramesReady(scene);         // current clip frame texture uploaded
  await awaitTextSync(scene);                 // troika typesetting quiescent (kicked pre-render)
  reassertExportSizeIfDrifted();              // guard: a window resize mid-run can't corrupt capture
  renderComposited(gl, scene, camera, hosts,  // active scene(s); composite on transitions
                   resolveAt(slots, tMs));    // (single-scene frames take the direct-render path;
                                              // frame 0 draws twice: never the run's first draw)
  readFrameOrThrow(ctx, width, height, rgba); // zero, readPixels, then fail on a blank frame or
                                              // any context loss: a GPU stall never reaches ffmpeg
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
(match troika's `Text` by class: material sniffing misses outlined text, whose
`material` is an `[outline, main]` array); `sync(cb)`
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

A scene entry may pin its cut to the music (`cutAt` and `align`,
`engine/sceneCuts.ts`): its `durationMs` caches the length that lands the cut
there, and the loader re-resolves every pinned length in scene order before
building the timeline. A project with no `cutAt` takes the same durations
array unchanged (null-for-legacy), and the kit mirrors the resolver
operation for operation (`timeline-vectors.json`).

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

- **One owner per target.** `tgtA`/`tgtB` hold the two sides until the
  composite samples them, and a comparison renders its own Before and After
  through the same pair before flattening into a comp target. So an incoming
  comparison after a plain outgoing scene renders FIRST; rendered second, it
  overwrote the outgoing side and the transition played as a hard cut (fixed
  2026-10-28). Verify ×2 can't see a wrong-but-stable frame, so
  `kookaburra:run --action transitioncheck --project compare-transition-spike`
  measures each crossfade's midpoint against the solo frames either side (the
  outgoing scene's least-squares weight must sit within 0.15 of the eased
  progress); `pnpm ready` runs it whenever the compositor or timeline changes.

- **Tone-map once, encode once, per path.** No-effects: every SDR target is a
  **display target** (`engine/displayTarget.ts`): three (r185, r186) applies tone
  mapping, the in-shader sRGB encode and the sRGB clear colour only when the
  current target is `null` or flagged `isXRRenderTarget`, so the flag makes
  scene passes render into the target exactly as onto the canvas (the same
  programs; the target takes the renderer's `outputColorSpace` as its tag, and
  the pools re-allocate if it changes), and explicit `RGBA8` storage keeps
  those display bytes raw. The
  composite reads them untouched and writes display bytes straight to the
  canvas: net zero conversions. Before 2026-10-19 the targets were plain
  hardware `SRGB8_ALPHA8`, so three never tone-mapped inside them: text and lit
  bodies jumped to their raw colour for every transition frame, and comparison
  and framed scenes were never tone-mapped at all. Effects: scenes render **un-tone-mapped** into
  `HalfFloatType`/linear targets (8-bit targets would clamp >1.0 linear BEFORE
  the composer's ACES and dim highlights) and the composer still owns the
  project's single ACES + encode.
- **Blending domain.** Both composite variants mix in the **display (encoded
  sRGB) domain**: a dissolve is a perceptual effect; linear-light mixing
  back-loads the apparent fade. Sample semantics matter: a display target
  stores encoded bytes raw, so the SDR shaders' `sampleDisplay` / `S()` read
  `texture()` untouched (the composite at progress 0/1 equals the neighbouring
  solo frame byte-for-byte); any decode or re-encode there shows a whole-frame
  "snaps dim / snaps back" or a washed-out double encode. Without
  `internalFormat: "RGBA8"`, three allocates hardware `SRGB8_ALPHA8` for an
  `UnsignedByteType` + `SRGBColorSpace` target and `texture()` returns
  hardware-DECODED linear (the pre-2026-10-19 contract), and the effects-path shader blends through three's exact ACES forward/inverse
  pair (`engine/acesCurve.ts`, golden-pinned, self-inverting → seam-exact within
  fp32; the encoded mix is clamped ≤ 0.999 before inversion so blown-out/toe
  pixels land back at white/black after the composer re-tone-maps). Slide/wipe
  select whole pixels: display-encoded on the SDR path, raw linear HDR on the
  effects path; `dip` lands on the **authored hex**. Alpha blending and the
  MSAA resolve run in the encoded domain inside display targets, as on the
  canvas, so AA and alpha edges match the solo frames too. (The old
  hardware-sRGB targets blended and resolved in linear light; the "~1 LSB,
  sub-perceptual" edge residual recorded here was wrong: about 77 % of glyph-edge
  pixels differed by 9 LSB or more, which read as bolder text in transitions.)
- **`progress` (and `direction`) are CPU-computed** and passed as uniforms (
  never derived from time inside GLSL), so the frame stays a pure function of `t`.
- **MSAA 4×** on all A/B targets (`samples: MSAA_SAMPLES`); **`NearestFilter`**
  with targets sized 1:1 to the drawing buffer (no bilinear taps). Target
  type, colour space, storage and the display flag ride the verify
  `renderStateFingerprint` (`compositorTargets`, for example
  `1009/srgb/RGBA8/display`).
- **Orientation:** the composite samples targets with straight UVs (the 2×2 plane
  maps uv(0,0)→clip(−1,−1)), so the composited default-framebuffer orientation
  equals a direct render. The existing Rust `vflip` stays correct.
- **State hygiene:** every renderer flag the compositor touches (render-target
  binding, `autoClear`, each host's `visible`) is snapshotted and restored; the
  composite always ends bound to the default framebuffer before `readPixels`.
  `preserveDrawingBuffer: true` still applies.

The extended transition types (blur, push, zoom, whip, procedural luma/iris,
glitch) live in **separate GLSL3 materials** (`engine/transitionShader.ts`) so
the original crossfade/dip/slide/wipe programs stay source-identical, the
v14 pack (slice, dissolve, warp) is a third generation for the same reason,
and the v15 pack (inkbleed, flowmorph, shockwave, glasssweep, rackfocus,
halftone, lightsweep, shatter, pixelstretch, chromasplit, datamosh, prism,
spinblur) is a fourth; legacy projects' byte-identity is structural. All
hashed randomness is an integer PCG hash (never `fract(sin)`: integer ops are
exact across compiles); all tap counts, kernel positions, noise octaves and
per-type defaults are export contract; unknown transition types degrade to
crossfade with a warning. The v15 body opens with an explicit endpoint guard
(progress <= 0 selects A raw, >= 1 selects B raw) on top of the bell
convention, so seam frames stay byte-equal to the solo neighbours even for
accumulation-heavy types (weighted bokeh sums, rotation resampling). Progress
easing (`ease: smooth | snappy`) is applied CPU-side before the uniforms,
endpoints preserved; absent means linear, so stored specs keep exact bytes.

The image mask (`luma` with `shape: "image"` and a project-relative `src`) is a
**fifth generation** (`fragmentShaderMask` / `fragmentShaderMaskHdr`), selected
only for that shape, so every earlier program stays source-identical. The mask's
signed distance field is built once per image at preload
(`engine/transitionMaskSdf.ts`, pure and golden-hashed): coverage is the alpha
when any pixel is translucent, else the Rec. 709 luma of the stored bytes (0.5
is the edge); an exact Felzenszwalb-Huttenlocher EDT runs on both sides of the
edge, seeded with sub-pixel offsets from partial coverage; values are
normalised to the field's longest side (at most 1024 px, box-downsampled
above) and packed as round-to-nearest-even half floats for a linear-filtered
R16F texture. The shader never derives the field: it samples it, extends it
past the stored box by the box distance, and caps it by `|u| - inset` (the
inscribed disc about the anchor, a bound the true SDF always meets). Scale
(linear), dilation (cubic) and the one-pixel edge width are CPU uniforms
(`maskReveal`), and that cap lets the schedule guarantee every frame pixel is
inside the shape at progress 1; the body keeps the ext3 endpoint guard, so the
seams stay raw selections. `engine/transitionMask.ts` caches each texture by
URL; the export preamble and the project-open settle await
`preloadTransitionMasks` (upload included), a missing or unreadable mask
rejects there and fails the run, and a render-time miss throws during export.
In preview a miss renders the procedural iris for a frame and repaints when
the field lands.

## Embedded video

`VideoClip` renders a source video without ever seeking an `HTMLVideoElement`:

- **Extract on demand, in chunks, cached.** The ffmpeg sidecar decodes the
  source into a **constant-frame-rate** PNG sequence at 60fps, the frames the
  whole-clip extraction (`-vf fps=60 -fps_mode cfr`) would write. This
  normalises variable-frame-rate sources (e.g. screen recordings) so sampling is
  exact. Frames land in `$APPDATA/cache/clips/<sha256>-60fps/frame-%05d.png`
  keyed by the source-file hash. PNGs are written with
  `-compression_level 1 -pred 0` (identical pixels, roughly 2x faster and 2x
  larger; only decoded pixels matter downstream). `src-tauri/src/clip_cache.rs`,
  `engine/clips.ts`.
  - `clip_info` hashes the source and runs a **decode-only count pass**
    (`fps=60` + cfr into the null muxer, plus one PNG for the size) into
    `count.json` `{ frames, width, height }`, so `frameCount` is the whole
    clip's count before any frame exists.
  - Frames fill in **120-frame chunks** (`ensure_clip_chunks`), each extracted
    with **no seek** and trimmed by frame number:
    `fps=60:start_time=0,trim=start_frame=A:end_frame=B,setpts=PTS-STARTPTS`
    with `-fps_mode passthrough -start_number A`. Input seeks are not
    frame-exact (a fixed pre-roll fails across a held frame), and
    `start_time=0` is what makes the fps filter pad a late first frame the way
    the whole extraction's cfr sync does (without it every index after an
    11 ms late first frame shifts by one). Consecutive missing chunks run as one
    pass; a second request for a chunk waits for the first. Each chunk is staged
    inside the entry, renamed in frame by frame and marked `.chunk-<A>`; a short
    pass fails loudly. Every chunk present means `.done`, so an entry from
    before chunking is a valid whole hit (and is adopted on sight: its
    `count.json` and markers are written, its frames untouched).
  - **The proof:** the `#[ignore]` `chunk_barcode_conformance` test
    (`cargo test --manifest-path src-tauri/Cargo.toml --lib chunk_barcode_conformance -- --ignored`)
    extracts CFR 60, 30 fps, a VFR clip with a four-second held frame, a
    late-start clip and an HEVC clip VideoToolbox decodes differently (so the
    hardware lane is shown to be its own) whole and in chunks, on both lanes, one chunk per pass (last
    first, so each is cold of its neighbours) and as one run, and demands equal
    PNG file bytes and decoded pixels for every frame, chunk boundaries 0, 120
    and the last partial chunk included, plus the count pass equal to the PNG
    count. The bytes are identical, so the cache key keeps no argv version.
  - **The export preamble awaits exactly what it binds** (`prepareExportClips`,
    twice). The first pass extracts each sidecar slot's frames over its scene
    window `[−500, duration + 500]` ms (the consumers' near gate): device screens
    through `deviceClipFrameIndex`, media entries and layered-screenshot cards
    through `clipFrameIndex` with their loop semantics, both comparison sides. The
    pass after `awaitSceneHostsCommitted` adds every mounted consumer's own
    mapping over its window and the frame it holds off the playhead; a declared
    source nobody can time (a screen started by a fold opening, still behind its
    model's suspense) takes the whole clip. A window too long to sample takes the
    whole clip too, which covers a loop and a held last frame. Sampling every
    1 ms is exact, since no clip frame lasts under 1.04 ms (60 fps at 16x). A
    one-frame capture (a thumb, a bridge capture) takes only the frames its
    instant shows.
    Nothing extracts ahead of need, so a chunk missed by both passes still
    extracts inside the frame's own `videoFrameReady` barrier (logged), and a
    chunk that cannot be extracted fails the export rather than capturing black.
  - **Preview** asks for a missing chunk when it binds a frame there and holds
    the previous bound frame meanwhile; no read-ahead (decode is main-thread
    work, and prefetching was measured worse once). A load its consumer moved
    past while the chunk extracted is dropped before decode. The preview JPEG
    tier (`ensure_clip_previews`) is made per chunk, after playback first binds
    the chunk's PNGs.
  - **The cap:** Settings holds `clipCacheCapGb` (default 20). After an
    extraction pushes the cache past it, whole chunks go least recently used
    first (a chunk's marker mtime, touched on read at most once a minute) down to
    90% of the cap. Each window pins the entries its mounted clips and a running
    export or capture use (`set_clip_cache_pins`), and those are never evicted.
    Eviction waits while another terminal run is queued
    (`~/Kookaburra Cut/_autorun/queue`: other sessions' gates read this cache)
    or an export runs; Settings' Clear is refused mid-export and deferred while
    another run is queued. A reader whose chunk another app instance evicted
    extracts it again, once.
  - **Pending conforms:** a clip whose file a conform job is still writing
    (`clip_conform_pending`) waits with no extraction, no error and no texture;
    `clipPendingState(srcAbs)` gives consumers its progress, and the job's landing
    (`media-changed` with `origin: "conform"`) releases it. An export waits for
    it, with a status line, and fails with a clear message after 15 minutes or
    when the conform fails.
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
  the correct frame's texture is uploaded before `readPixels`. A clip still
  extracting publishes a readiness that holds until its first bind, never an
  instant resolve, so a late-registered clip delays frame 0 instead of
  capturing black. The clip is an
  ordinary mesh in its `<SceneHost>` group, so it flows through the compositor's
  fast and transition paths unchanged.
- **Conformed sources.** The ingest conform (`conform.rs`) swaps a flagged
  recording for a constant 60 fps libx264 mezzanine before a scene uses it. The
  export path is untouched: the mezzanine is an ordinary clip with fixed bytes,
  written once (staged in `assets/.kc-render/`, renamed into place) and never
  re-encoded behind a project's back. Existing clips are flagged, not migrated,
  so a hash moves only when someone conforms a clip a scene already shows.

Layout uses `fit` (`contain` letterboxes, `cover` fills+crops) computed from
`useFormat().frame` and the clip aspect. One clip serves every aspect. Clips are
picture-only; sound belongs to the project soundtrack (below).

## Audio

A project may declare ONE soundtrack (`project.json`
`audio: { file, gainDb?, fadeInMs?, fadeOutMs?, fadeOutCurve?, startOffsetMs? }`,
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
- **Every soundtrack fades out at its AUDIBLE end by default.** `fadeOutMs`
  omitted → `DEFAULT_AUDIO_FADE_OUT_MS` (1000); an explicit `0` opts out. The
  default is applied ONCE, in `loadProject`'s audio resolver
  (`withAudioDefaults`, engine/project.ts): preview and export read the same
  resolved object, so the lanes cannot disagree. The fade-in is `curve=qsin`;
  the fade-out takes `fadeOutCurve` ("smooth" qsin default, "linear" tri,
  "scurve" hsin, "exponential" exp, "logarithmic" log; unknown ids degrade to
  qsin) and anchors at the AUDIBLE end: the earlier of the track running out
  (post-offset, via the probed `trackDurationMs`) and the padded/cut timeline
  length. A track that outlasts the video therefore keeps the legacy timeline
  anchor byte-for-byte (the argv shape is pinned by `audio_graph_tests`). The
  null path is unaffected by ANY of this: no `audio` block, no `-af`.
- **Codec per container:** AAC 192k in `.mp4`, `pcm_s16le` in `.mov` (ProRes),
  both under `-flags:a +bitexact` (suppresses the encoder tag; the existing
  `-fflags +bitexact -map_metadata -1` already covers the muxer). PCM is
  trivially deterministic; **AAC's run-to-run determinism is proven by the gate,
  not assumed** (recorded contingency if a future ffmpeg breaks it: encode the
  processed track once into the `$APPDATA` cache and stream-copy).
- **ffmpeg reads a snapshot.** `start_export` copies the track into
  `$APPDATA/cache/export-audio/<pid>-<ms>.<ext>` (an APFS clone) and points the
  argv's `-i` at the copy, so music saved mid-export can't change the film; the
  copy goes with the run's cleanup. The path never reaches the output (bitexact,
  `-map_metadata -1`), so the bytes are unchanged and the argv goldens, which
  build from the options, still hold.
- **Sync is proven, not assumed.** `export_lanes_keep_cuts_on_the_beat`
  (`src-tauri/src/encode/av_sync_tests.rs`, `cargo test --lib av_sync --
  --nocapture`) pipes a flash on the first frame at or after each beat, with a
  click track on the beats, through every lane's real argv and the real sidecar
  (legacy, spec with `-bf 2`, poster frame, two-pass, x265, ProRes with PCM,
  VideoToolbox; 30 and 60 fps) and times both from the file as a player does.
  Every cut lands `ceil(B × fps) / fps − B` after its beat, 0 to 1 frame (33.3 ms
  at 30 fps, 16.7 at 60), and every click within 1 ms. Larger numbers are the
  reading, not the file: ignoring edit lists adds the B-frame delay minus AAC
  priming (+45.3 ms at 30 fps, +12.0 at 60), and timing a poster-frame film
  against the project grid without taking the poster off adds a frame (the
  2026-10 field report's 37 to 65 ms). `kb sync-check` measures it right.
  Snapping cuts to the nearest frame or dropping edit lists would change bytes:
  a deliberate rebase.
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
- **Song analysis never feeds render.** The beat lane's and `<exe> song
  analyse`'s output (`src-tauri/src/song/`, cached as `<sha>-v2.json`) is
  editor and agent guidance only; an autorun never starts it, and only an
  authored `audio.grid` copied from it reaches a frame.

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

### Foldables

A folding device (`docs/foldables.md`) adds a posed skeleton and a second
display to this path. What keeps it a pure function of the frame:

- **The fold is a lookup, not a simulation.** The glb carries a clip keyed one
  frame per degree. `Device` evaluates its tracks at `foldDeg / degPerSecond` in
  a layout effect, the lid's precedent. There is no `AnimationMixer`, which
  carries state between frames, and no `useFrame`, which does not fire under
  `frameloop="demand"`.
- **Display brightness goes through a level ref.** Clip binds land
  asynchronously, after `Device` has set the frame's brightness, and used to
  force the material white. A colour set directly on a screen material is
  overwritten before capture; `onBound` reads the ref instead.
- **Legacy stays literally untouched.** Only a catalogue entry with a `fold`
  spec takes `SkeletonUtils.clone`, the auto-centre wrapper group and the
  shadow's yaw basis branch. Every other device keeps `scene.clone(true)`, its
  scene graph and its slab arithmetic, which a test pins deep-equal.
- **Contract constants:** `FOLD_SWITCH_DEG` 45 and `FOLD_POWER_WINDOW_DEG` 15
  (`foldTransition.ts`), the cos²(θ/2) auto-centre curve (`foldPose.ts`), and
  the glb's clip itself: re-exporting the model is a rebase of every foldable
  baseline.
- "Start when opened" steps the frames that will render (`foldOpenedAtMs`), so
  preview and export agree on the inside video's first frame by construction.
- **The blur handover adds no render target.** It is an `onBeforeCompile` patch
  on the two foldable screen materials (one stable `customProgramCacheKey`): the
  fragment's root-frame position (taken after skinning) is projected from a fixed
  front eye onto the display's home plane, then a fixed 32 tap kernel with a
  per-pixel PCG-hashed rotation blurs up one measured ramp. No mipmaps,
  `textureGrad` inside per-fragment control flow, uniforms CPU-written per frame,
  and the root's inverse world matrix refreshed in `onBeforeRender`, when world
  matrices are final. Idle, it runs the stock sample statement.
- **It plays only inside a fold segment** (`deviceFoldRangeAt`), on the device's
  progress through that fold, so it stays a pure function of the track and the
  frame time while a held pose is exactly lit and sharp. The `FOLD_*` constants in
  `foldTransition.ts` are all contract; the table is in `docs/foldables.md`.

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
- **Kicks are a pure function of time, and absent kicks change nothing.**
  `cameraKicks` (`engine/cameraKicks.ts`) add an attack, hold, release push on
  the pose that won, per scene-local ms; musical `at` positions resolve at track
  build from the project's music and the slot start, never written back. With
  no kick live, or a channel absent, `applyCameraKicks` returns the base pose
  OBJECT itself rather than multiplying by one (the tan/atan round trip is not
  bit-exact), and a doc with no `cameraKicks` builds exactly the tracks it did
  before. A kicks-only scene counts as a scene track, so its project takes the
  explicit-plan path. Zero attacks, zero releases and `jump` snaps are camera
  breaks for motion blur, and rig overscan adds one sample per kick peak to the
  fixed 64. Changing the envelope, the zoom formula, the 15..90 clamp or the
  application order re-renders every project that uses kicks.

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

## Motion blur

Shutter accumulation (`engine/shutter.ts`, `shutterPlan.ts`, `shutterLane.ts`;
docs/camera.md has the model). Frame N averages renders at instants INSIDE its
own shutter window, never earlier frames, so it stays a pure function of t.

- **Null for legacy.** No `render.motionBlur` and no sidecar `motionBlur` means
  `buildShutterPlan` returns null and every frame takes the plain path. A frame
  whose camera holds and whose scenes have no object blur also renders plain.
  `useTimeline()` adds exactly 0 outside a sample, and the shutter store is only
  written by the lane, so blur-free runs never touch it.
- **Exact sums.** Each sample is the ORIGINAL path's finished canvas (fast,
  transition, compare, effects composer, dof-only lane), copied into a
  linear-tagged `FramebufferTexture` and summed as integer bytes
  (`floor(x * 255 + 0.5)`) in an RGBA32F ping-pong pair; the write-back is
  `floor(sum / N + 0.5) / 255`. A pixel that holds still averages to its own byte
  at any N. Proven: the lane forced on every frame with a zero window hashed
  `showcase-tour` `13b5994d…` unchanged.
- **Adaptive count.** The project's count is a floor. A frame whose camera sweeps
  far across the shutter takes more samples: a probe grid (3 by 3 at plus or
  minus 0.8 of the centre pose's view, at the aim distance and half of it) is
  projected through the window-edge poses, and N rises until neighbouring copies
  sit at most `SHUTTER_MAX_GAP` (0.002 frame heights) apart, capped at
  `SHUTTER_SAMPLES_MAX` (32). Object samples use the frame's same N.
- **Contract constants.** Sample counts 4 / 8 / 16 (floors); offsets `(k + 0.5) / N - 0.5`
  of the window; box weights; window `shutterDeg / 360 * 1000 / fps` at the RUN's
  fps (30 on preset lanes); clamps to the scene and to camera breaks (jump
  segment ends, held keys) at 1e-6 ms; `DIFF_BLOCK` 32 for the edge test; the
  adaptive probe grid, gap and cap above.
  Changing any of them re-records the blurred fixtures.
- **Object samples are commits.** Each object sample writes the clock store's
  `shutter` and waits for the canvas tree to stamp `shutterSeq`
  (`ExportBridge`), then text sync, the clock barrier's pattern. The edge samples
  render first; when their bytes match across every 32 px block (and the camera
  holds) the frame resolves from those two. The clock ends every frame on
  `NO_SHUTTER`, and runs and captures clear a sample a paused preview left behind.
- **What never moves inside a shutter.** Transition progress, grain's seed
  (read from `currentMs`, which stays on the frame instant), lighting and
  compare plans, dof (the centre pose's), clip frames, counters, backgrounds and
  overlay chrome.
- **Cost.** Only moving frames pay. `ws:motion-blur-spike` (8 scenes, nearly
  all moving, 8 samples, 4K) Verify ×2 took 210 s against 123 s with blur off.
- **Memory.** The lane holds about 370 MB at 4K (two RGBA32F targets plus two
  copies); export frees it on any frame that does not blur and with the
  compositor pools between legs.

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

A scene's sidecar may declare a video `media` entry hosted on `window`: a macOS
screen recording as a floating rounded window with an analytic drop shadow,
floating over whatever the scene stages behind it (theme backdrop, fixed
background, or nothing). Sidecars written before the two media families merged
carry the older `videoWindow` block and read forward into the same entry at parse
(2026-08-22 below), on the `window` host (2026-08-23 below). The invariants:

- **The null path is the old path, exactly.** The host-side `SceneMediaFallback`
  renders nothing when the sidecar declares no media (and stands its window family
  down when the scene's TSX mounts `<VideoWindow/>`), so every existing project
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
  colour; the environment is the lit primitives' shared studio environment
  while one is mounted, else none). The legacy themes are
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
  project is therefore untouched. The devices' presentation shadows remain
  independent: `Device` still defaults to `"soft"` while its meshes also
  cast and receive real shadows when the map rig is active.
- **Device presentation shadows are one analytic projector, and export
  contract.** `toolkit/device/shadowProjector.ts` back-projects the device's
  rounded-rect silhouette from a receiver plane toward a virtual key light,
  widening the penumbra with the occluder's distance from that plane. All three
  modes are parameter sets over it (`DEVICE_SHADOW_MODES`), and the silhouette
  comes from STATIC catalog constants (`DeviceShadowSpec`, measured per model
  beside `fittedHeight`), never the runtime bbox, so a clean clone without the
  licensed glbs casts the same shadow as a build with them. Every value is a
  pure function of the frame's pose, including the motion presets, so a float
  lift softens and slides its own shadow without any accumulation. Changing a
  mode parameter or a model's silhouette re-renders every staged device.
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
  `prepareExportClips` covers the source (registered at mount like any clip) and the
  per-frame `awaitVideoFramesReady` barrier reaches the fill's group. Frame
  choice is a pure clock function pinned beside `clipFrame.ts`: absent `loop` ⇒
  the modulo wrap; `loop:false` ⇒ the frozen clamp (hold semantics). Cover-crop
  rides PER-INSTANCE quad UVs (frame textures are SHARED, never mutated). While
  a first extraction runs in PREVIEW the quad stays invisible (the scene's
  resolved underlay shows); at export/capture that state is unreachable by the
  preamble barriers.

### Rooms

- **Null for legacy.** `buildRoomTracks` returns `null` unless a scene doc carries a
  `room` block with a key that survives validation. Null rooms means
  `resolveFrameSceneStates` returns the prebuilt states untouched, the lighting plan
  is built exactly as before, and the host `<SceneRoom>` renders nothing (no mesh, no
  clock subscription, no program). A doc with a `room` block also opts the project
  into themed scene state (`usesThemedSceneState`), so each target's root background
  is explicit.
- **One seam for three windows.** `resolveFramePlans` (engine/sceneState.ts) is the
  single per-frame state and lighting resolve; preview (`CompositorDriver`), export
  (`drawPlannedFrame`) and Present (`PresentCompositorDriver`) all call it with the
  same prebuilt inputs, so they cannot drift. Rooms feed both halves: the target's
  root background becomes the room colour, and the room's lighting pose merges into
  that target's lighting sample (room fields win over lighting keys on the same
  light). Each transition target samples its own scene's room at its own scene-local
  time, exactly like the camera and lighting tracks.
- **Every sample is a pure function of scene-local time.** `sampleRoom` holds the
  latest key at or before `t`; inside a flood the previous room shows with the
  incoming colour growing and the lights lerping by the same eased amount (colours
  in linear light, rounded to `#rrggbb`). Keys are validated into complete poses at
  build (every key filled to the union of touched fields from the scene's own
  values), so a flood always lerps from real values and nothing accumulates. A
  roomed sample writes every light colour explicitly, ambient included, so a room
  never leaks into the next frame; un-roomed lights keep their colours untouched.
  The environment (IBL) is never a room field.
- **The flood is geometry, not a shader.** A camera-locked quad (`FixedQuad`, the
  fixed background's per-draw matrix lock) in the room colour at
  `ROOM_RENDER_ORDER = −40`, and a `CircleGeometry(1, 256)` one order above it, both
  `MeshBasicMaterial`, `toneMapped: false`, `depthTest/depthWrite: false`: the fixed
  colour fill's existing program, so room colours land exactly on the direct path and
  nothing compiles. The circle's centre and radius come from `roomFloodCircle`
  (camera fov and aspect, frame-fraction origin with `[0, 0]` top-left); at radius 1
  the 256-gon's inscribed circle covers the far frame corner with the fixed
  background's 1.001 overscan. Both meshes stay mounted for a roomed scene and
  toggle `visible`, so a key landing mid-run never mounts anything. The room covers
  the fixed background (−100) and opaque 3D look geometry (−50); transparent look
  layers draw in three's transparent pass and stay in front.
- **Export contract.** `ROOM_RENDER_ORDER`, `ROOM_FLOOD_SEGMENTS`, the cover
  overscan, `ROOM_FLOOD_MS` and the default origin and ease re-render every roomed
  project when changed. `ws:rooms-spike` (cuts, a flood with a tokened light, a wipe
  while both sides flood) is the machine-local fixture: look at it after any room
  change; it is not in any gate.

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
- **Unsafe faces never reach troika.** One throw inside troika's font XHR
  callback leaves every pending `preloadFont` unsettled, so a single bad face
  hung the whole load. `loadProject` and `preloadAppFonts` first run every
  non-bundled face through troika's own parser (theme/fontVet.ts: parse,
  basic-Latin lookups, a glyph walk; verdicts cached per URL). A face that throws
  is swapped by URL for the theme's nearest-weight safe face (else Inter) and
  named in `LoadedProject.fontIssues`; healthy faces are untouched. The troika
  patch also lets `Typr.U.codeToGlyph` fall through an unreadable cmap subtable
  to the next readable one (format 6 read last): every face that rendered before
  keeps its exact subtable (901 installed faces compared glyph for glyph, zero
  differences), so no baseline moves.
- **3D text stays bundled.** `ExtrudedText` typefaces (converted outlines, one
  per family at the default weight, `pnpm assets:text3d-font`) cover the bundled
  set only; system-font refs fall back to Inter there. The converter is
  byte-stable: regenerating Inter's typeface reproduced the committed file
  exactly.
- **Text metrics parse the same files on their own.** `preloadAppFonts` ends by parsing
  each face it preloaded (plus the fallback face) with troika's parser into
  `theme/fontMetrics.ts`, after the atlas preloads; nothing reaches troika's atlas, so
  no glyph cell moves. `measureText` mirrors troika's line maths, held to its typesetter
  by `fontMetrics.test.ts`.
- **One glyph size, so one atlas.** `SDF_GLYPH_SIZE = 64` (theme/fonts.ts,
  re-exported from format.ts) is passed to `configureTextBuilder`, every
  `preloadFont` and every `Text` site, and a static test fails on any site
  that omits it. A second size would open a second atlas with its own cell
  order; changing the constant re-rasterises every glyph (a full rebase).
- **Adding a bundled font is a REBASE EVENT.** troika-three-text keeps ONE SDF
  atlas per `sdfGlyphSize`, SHARED ACROSS EVERY FONT (`atlases[sdfGlyphSize]`):
  glyph cells are allocated in first-typeset order, so expanding `BUNDLED_FONTS`
  changes the boot preload sequence and shifts the atlas slot (cell position AND
  rgba channel) of every glyph typeset after the insertion point. Same SDF
  content in a different cell sample-rounds differently → deterministic ±LSB
  drift in text pixels. Projects whose glyphs all sit inside the FIRST font's
  preloaded block (`PRELOAD_CHARACTERS` of Inter 400) are unaffected; projects
  using later fonts, pinned system fonts, or characters outside the preload set
  rebase. So new faces join `LAZY_BUNDLED_FAMILIES` (theme/fonts.ts): the boot
  preload skips them and only a project that references one typesets it, after
  the boot block, so older projects keep their exact atlas (the 2026-10 theme
  lineup added Instrument Serif, Jost, IBM Plex Sans and Fraunces this way, with
  both gate projects EQUAL). A face added to the boot set instead rebases as
  above: PROVE attribution by stashing the font change alone and reproducing
  the old hash.
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

- **The wedge is patched away.** troika's fallback resolver (still in 0.52.5)
  has no `.catch()`: any codepoint outside the loaded fonts CSP-blocked a CDN
  fetch and left `_isSyncing` true forever, freezing the `<Text>` on its
  last-good string. The pnpm patch (`patches/troika-three-text@0.52.5.patch`,
  exact pin, guarded by `src/theme/troika.test.ts`) degrades
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

## Text emphasis and the typewriter mask

- **Markup never reaches troika.** `prepareDisplayText` (`toolkit/text/displayText.ts`)
  strips `*word*` emphasis (markdown flanking rules) before emoji substitution, in every
  path that typesets or measures (headlines, title and panel measures, `measureText`, the
  decoration gizmo). Copy without a flanking pair returns `prepareEmojiText`'s exact
  output, so no standing layout can move.
- **Gated programs.** Emphasis and the typewriter mask are stagger-material features
  (`emphasis`, `typeMask`) that only mount on text that uses them;
  `staggerPrograms.test.ts` pins every pre-existing feature combination's GLSL by hash.
  Emphasis weight rewrites troika 0.52.5's own edge-offset sites per glyph (the quad
  grow and the edge alpha, the outline mechanism); the rewrite is pinned to troika's
  exact bytes and warns if they move, so re-check it on any troika upgrade.
- **Barriers.** Emphasis rects and the type head come from the first typeset's carets,
  so both report text-derived pending (`textDerivedState.ts`) until the carets land: no
  capture draws the pre-measure frame.

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
  synchronous. The device, catalog and hero barriers parse each glb once per
  realm (`modelBarrierOnce`), so later preambles (every bridge frame, a verify's
  second pass) resolve at once. Staged library objects (`SceneDoc.objects`)
  extend that to a DYNAMIC id set: `preloadSceneObjects()` resolves every
  referenced object id (bundled or `ws:`) into a warm asset cache, then fetches +
  parses each glb before frame 0; unknown ids resolve to nothing,
  deterministically. The preview's TransformControls gizmo is UI-only: it
  ATTACHES to the object's group (never wraps it), mounts only for the
  inspector-selected object AND is cleared by `exportPreamble`
  (`useObjectEditStore`), so it can never reach an exported frame.

**Framing is invisible to the gate.** `useFormat().frame`/`safe` are measured at
the content plane `z=0`; content offset toward the camera projects larger and can
clip at frame edges while remaining perfectly byte-stable (a caption at `z=1` did
exactly this). Eyeball exported frames in **both** orientations at every gate.

## Packaged-app parity

The packaged `.app` must reproduce dev-mode hashes on the standing projects:
"internally deterministic" is not "correct", so dev-equal output is its own gate
class, run for any packaging-adjacent change. What packaging changes (and why it
stays deterministic):

- **Static sidecar** (`scripts/build-ffmpeg-sidecar.sh`): ffmpeg, x264 and x265
  built from source pinned by SHA-256 and commit (GPL: libx264 + libx265 +
  VideoToolbox + ProRes + FFV1), self-containment gated by `otool -L` (system
  libs only). The release workflow builds it the same way on a clean runner and
  the verify job compares the signature-stripped digests with the build job's.
  Same sources ⇒ same bytes: proven by dev/packaged hash parity. Note: the dev
  `pnpm setup:ffmpeg` copy OVERWRITES the release sidecar; rerun
  `pnpm setup:ffmpeg:release` after.
- **x264's version string is export bytes.** libx264 stamps
  `x264 - core 165 r3222 b35605a` into every H.264 stream's SEI, and x264's
  `version.sh` derives it from the git history at configure time. A shallow
  fetch built a sidecar that stamped `x264 - core 165`, and the 0.21.0 candidate
  MOVED both anchors (2026-10-29): a test encode from each sidecar differed by
  exactly those 14 bytes with identical decoded frames, and the dev renderer
  with the CI sidecar reproduced the packaged hash.
  The build script fetches the full history, pins the string (`X264_SEI`) and
  refuses a sidecar that stamps anything else.
- **Editor zoom guards are per ffmpeg build.** `cargo test --manifest-path
  src-tauri/Cargo.toml --lib zoom_frames_match -- --ignored` pins the zoom
  stage's frame counter (`in-1`) and its bytes on both decode lanes for whichever
  sidecar `src-tauri/bin` holds. Perspective's counter base and every hash belong
  to one build, so before a release run it, and `edit_barcode_conformance`, once
  after `pnpm setup:ffmpeg:release`.
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
them; an edit to the legacy builder is a deliberate full rebase. The modal's
High quality row takes this path when Opening poster frame is off. When it is on,
the row resolves the legacy-equivalent spec plus the runtime poster flag.

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

**The optional poster frame is runtime-only.** The export modal never stores it
in a preset. Its default-on choice is remembered app-wide in `settings.json`,
across projects and launches. `posterFrame: true` inserts exactly one encoded
frame before timeline frame 0, using the lower-centre sample from the first scene
on the selected output-fps grid. That poster renders scene one alone, even when
its timestamp lies inside an outgoing transition. The video and audio durations
grow by exactly `1 / fps`; Rust prepends one frame of sample-exact silence (800
samples at 60 fps, 1600 at 30 fps) and shifts the soundtrack fades and padding
with it. An absent or false field takes the existing frame and audio paths
unchanged. Hosts still choose their own link-preview thumbnail, so this improves
the candidate frame without guaranteeing selection.

**Two-pass = the FFV1 mezzanine.** Pass 1 consumes its input, so two-pass presets
render ONCE to a lossless FFV1 `.mkv` at OUTPUT res/fps/pix_fmt in
`$APPDATA/cache/export-mezz/` (statvfs disk guard blocks pre-flight: raw-frame
ceiling + 2 GB; removed when the run ends, swept by the next export after a
crash), then transcode file-to-file (x264 `-pass N -passlogfile`; x265
`-x265-params pass=N:stats=`). Audio joins at pass 2. FFV1 is bit-exact and both
passes are deterministic given the same mezzanine.

**Partial file, then rename.** ffmpeg writes a hidden `.<name>.part.<ext>` beside
the output and `finish_export` renames it into place, so a cancelled or failed
run (deleted with its mezzanine) never leaves a broken file or clobbers the
previous export. The filename never reaches the bytes (`bitexact`,
`-map_metadata -1`).

**Loudness is gain-only.** `measure_loudness` runs sidecar ebur128 through the
EXACT export audio graph (`audio_filter_graph`, trim/pad/fades/author gain
included), cached at `$APPDATA/cache/loudness/` keyed
`sha256(file bytes ‖ graph string)`. The delta (`target − integrated`, 2 dp) sums
with the author gain into the ONE `volume=` slot (`audio_filter_graph_gained`;
extra 0.0 = the byte-frozen legacy string). Projected true peak > −1.5 dBTP warns
and proceeds, never a limiter (a limiter is content-dependent DSP; a gain is a
constant).

**4:5, 5:4, 3:2, 2:3 and the phone pair are first-class but feature-scoped**:
`FORMATS["4:5"]` = 2160×2700, `FORMATS["5:4"]` = 2700×2160, `FORMATS["3:2"]` =
3240×2160, `FORMATS["2:3"]` = 2160×3240 (2160 short edge, the house convention),
`FORMATS.phone` = 1206×2622 and `FORMATS["phone-landscape"]` = 2622×1206 (the
iPhone 17 Pro panel at native size, exactly 437:201, deliberately under the 2160
convention). The phone pair's ids are slugs, not ratios, because the export path
runs `name.replace(":", "x")` through the Rust slug check; `aspectLabel()` owns
the display names ("Phone", "Phone Landscape"). `STANDING_ASPECTS` pins Verify's
"all" and the full matrices to the standing three (16:9 / 9:16 / 1:1).

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

## Stills export

The PDF handout and PNG images export ([stills.md](./stills.md)) capture through
the same preamble, barriers and `renderComposited` as video: the per-frame body
is `renderFrameInto` in `engine/exportFrame.ts`, moved verbatim out of
`exporter.ts`, so the video loop's GL call sequence is unchanged. What a stills
run promises:

- **Page RGBA is the contract.** Each page's hash is SHA-256 over its 64 tile
  hashes (`tileHashFrame` on the page-stage RGBA, after the downscale), its
  metadata JSON and its text-layer JSON; `pagesHash` is SHA-256 over the page
  hashes joined by newlines. It is per format and size: PNG pages carry an empty
  text layer (`[]`), so a PDF and a PNG run of one project hash differently even
  when every pixel matches.
- **The PNG zip file is byte-reproducible** in reproducible mode (autoruns: fixed
  zip timestamps): the PNGs come from the pinned Rust encoder, stored. App
  exports stamp local time, so only their page bytes repeat.
- **The PDF file hash is advisory.** The writer is deterministic (reproducible
  mode drops the dates, author and app version, and `/ID` derives from the page
  payloads), but the JPEG pages come from WebKit's `toBlob` encoder, which is not
  pinned and may change with macOS. PDFs are not byte-reproducible by design
  outside reproducible mode.
- **Holds are scoped to the run.** Automatic stills hold their scenes where
  Present would; the hold map is written once per run and cleared before the
  preview resumes, and nothing else on the export path may see it.

The gate is `stillsverify`: two passes in one boot under one export hold. `ok`
means every page's tiles, text layer and metadata match (and, for a PNG zip, the
file SHA-256); a PDF's file and JPEG hashes are reported, never failed on. A
mismatch reports the first divergent page at the RGBA (tile), text, metadata and
payload level. Failure modes are the "Stills:" rows in "What breaks it"; the
tier is under "Gate tiers" and the baselines under "Current baselines".

## How to test it

- **In-app (the gate):** the **Verify ×2** button runs `verifyAllFormats()`: for
  **each** standing aspect (16:9 / 9:16 / 1:1) it exports the project twice
  (overwriting the per-aspect output path) and compares the SHA-256 of each file
  via the Rust `hash_file` command. All aspects identical ⇒ deterministic.
- **Terminal-driven:** `pnpm kookaburra:run --action verify --project <id>
  --aspect all` runs the same gate headlessly and writes
  `~/Kookaburra Cut/_autorun/runs/<run-id>/last-run.json`, the primary result;
  the legacy `~/Kookaburra Cut/_autorun/last-run.json` is still written as a
  copy. Runs queue behind each other (FIFO) instead of demanding the machine to
  themselves, dev runs pick their own port, and the launch is backgrounded: no
  Dock icon, no focus steal.
- **Cold runs (`--cold`):** a run is cold when no preview frame draws before
  it (`programs 0` or `1` in dev.log's `[autorun] gl memory before`
  breadcrumb). Without the flag that rides on the window and the boot: an
  occluded or locked window never draws, and a visible one draws only until
  the run takes the clock (showcase-tour logs 6 programs on a warm boot,
  `ws:device-env-spike` still 0), so a warm run can hide cold-only flakes (the
  lit-environment frame-0 failure hid that way). `--cold` holds the preview
  stand-down from boot instead: the
  native `KOOKABURRA_COLD` config is read in `initAutoRunConfig`, which
  `main.tsx` awaits before React renders, so it is runtime and `--app` runs go
  cold too. The result carries `"cold": true` when the hold was taken, and the
  wrapper exits 2 when a `--cold` run's result lacks it (a build that predates
  the flag). Export-path actions only (verify, export, screenshot,
  packroundtrip, stills, stillsverify).
- **Cold clip caches:** a clip extracts once per lane per `$APPDATA` (dev
  shares one; each acceptance bundle owns its own), so a warm machine never
  exercises a first extraction (`--cold` holds preview frames only, never
  the clip cache). To rehearse one, move
  `cache/clips/<sha>-60fps` and `<sha>-60fps-hw` aside (`<sha>` is
  `shasum -a 256` of the source), run, then put them back. A `--action perf`
  run ends with a `cold-extraction` row: each clip's time from first reference
  to first bound frame and the bytes this session wrote to the clip cache.
- **On failure, the report localizes the divergence:** per-frame 8×8 tile hashes
  give the exact divergent frame ranges and where in the frame they differ; the
  bound clip-frame index per exported frame separates a stale texture bind from a
  pixel-content difference (each readiness node publishes its `clipMaterial`, so
  Device screens report too).
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

### The capture bridge surface (the hidden render window)

Live captures (`kb capture` and `kb check --render` over bridge v2, the legacy
`capture.py`, scene thumbs; docs/agent-kit.md) are served by the hidden `render`
window: its own realm and WebContent process, the same `renderComposited` seam
and export barriers, driven rAF-free so it renders while hidden. Three measured
facts (2026-08-07) define its contract:

- **Per-surface deterministic.** Repeated bridge captures of the same frame hash
  identically across window boots and capture order.
- **NOT hash-exact against the cold-boot surface.** The same frame differs from
  `--action screenshot` by a fixed glyph-edge AA delta (measured 81 px of 8.3 M,
  max channel delta 4): the realms carry different troika atlas state (the
  editor preview-renders before capturing; the render realm never does).
  Responses carry `surface: "render-window"`; any hash dispute defers to the
  cold-boot surface, which stays the determinism reference. Baselines are never
  recorded from bridge captures.
- **Hidden-page timer clamp.** WebKit aligns a hidden page's nested timers to
  1 s, so the render realm opts into MessageChannel yields for the settle
  barriers (`engine/macrotask.ts`); visible windows keep the proven setTimeout
  path. Neither yield primitive affects pixels, only wall time.

A capture's contact sheet (`sheet`) scales its frames into a labelled 2D canvas
grid: diagnostic output, never hashed or compared.

- **Scaled captures.** Single frames render at native size; sheets and multi-frame
  captures at a 1280 px long edge; `width` or `scale` override. Scaling only passes a
  smaller format through the existing `opts.format` (the store keeps the native one), so
  effects defined in pixels rasterise at the capture size. Probes sample the readback
  after `readFrameOrThrow`. Never baselines.
- **Recycle.** A stall destroys the render window; the next request gets a fresh realm.
- **Census pass-through.** `engine/glContexts.ts` wraps `getContext`, `getExtension` and
  `loseContext` in every realm, export included, returning the same objects with the
  same arguments and listening passively for losses. It must stay byte-neutral (gate it
  with `pnpm gate` when it changes).

### Read-only taps on the export loop

`push_frame` feeds each frame's bytes, after `child.write`, to a per-export
`FlashDetector` (`flashes.rs`). The tap only reads: it never alters, reorders or delays
what ffmpeg receives, a panic drops the tap (report "unavailable") and never the export,
and it costs about 4.3 ms per 4K frame. Any change to it gates with `pnpm gate`; bytes
must stay EQUAL.

`push_frame` also feeds the export trace (`export_health::frame`: the written count
and one timestamp a second, under its own lock) after the write, so a failed run can
name its frame, scene and render-rate trend (docs/agent-kit.md, "Export health"). It
reads nothing from the frame.

The autorun surface (env-gated, cold-boot, one run at a time via the FIFO run
queue) is unchanged; neither surface may regress the other.

### Memory probe

`pnpm kookaburra:run --action memory --project P[,P...] [--aspect A] [--at N] [--lever L]`
exports each film through the real path (30 fps unless a preset says otherwise; `--at N`
renders the first N seconds) and every 2 s records the render rate, each process's
footprint (`export_memory_sample`: the editor's and render window's WebContent, WebKit's
GPU process, the app, ffmpeg), three's texture and geometry counts and the clip frame
cache (`clipCacheCensus`). Each row's `memory` carries the rate over the first, middle and
last 10 s, first, peak and last footprints, `editorGrowthMb` (the editor's median over
the last third minus the first third: growth that stays, not a transition's MSAA pair
coming and going) and `holds`. A film that slows below 80% of its start or keeps more than
512 MB fails the run. `--lever clip-cache=N` changes one thing for an experiment.
`fixtures/long-device-spike` (60 s of handsets, the foldable, a tablet, a laptop and a
comparison over fourteen screen recordings) is the leak acceptance film. The probe reads;
it never changes a byte.

**The 2026-10-28 leak.** A 50 s foldable film failed eight exports at 43 to 53% with the
editor reloaded. Measured on device-heavy spikes in one boot, 30 fps, 16:9 / 9:16 / 1:1:

| Run | Editor at each leg's start (MB) | Editor peak | Clip cache peak | GPU process peak |
| --- | --- | --- | --- | --- |
| Before | 1951, 2945, 3175, 3847, 4512, 4897 (7113 by the fourth project) | 5544 | 1734 | 2372 |
| `--lever clip-cache=2` | 1916, 1631, 1787, 1649, 3001, 3503 | 4143 | 457 | 1172 |
| Fixed | 1856, 1814, 1317, 1782, 2348, 2222 | 3092 | 303 | 1045 |

- **The cause: the clip frame cache never shrank.** Each clip kept 12 decoded frames
  (`LRU_CAPACITY`, per clip, so the total grew with every clip the film reached), they
  stayed through every aspect and project in the session, and the export's software lane
  kept its own set beside the preview's hardware lane. Each cached megabyte cost the
  editor's WebContent about two (the bitmap plus decode garbage) and WebKit's GPU process
  one more (the uploaded texture). On a 64 GB Mac nothing died; on a smaller one WebKit
  kills the WebContent process near its footprint limit, and the memory pressure before
  that is the 8.4 → 2.6 → 1.2 fps slowdown the field saw.
- **The fix** (`engine/clips.ts`): an export keeps two frames a clip
  (`EXPORT_LRU_CAPACITY`; it steps forward and never back), and starts and ends by closing
  every frame no consumer binds, in both lanes (`releaseIdleClipFrames`). A re-decoded PNG
  is the same pixels, so bytes cannot move; the gate proves it.
- **Not leaks:** a crossfade or comparison allocates its MSAA pair for its window and
  `releaseIdlePools` frees it after (a +500 to 900 MB spike at 4K, measured coming back);
  compositor targets are replaced, never stacked, on a size change; Verify's three raw
  frame copies are freed as pass B matches them.
- **The truth when it still happens:** `docs/agent-kit.md`, "Export health".

### Gate tiers: how much to run

Verify runs are expensive (minutes per project-aspect, and the run queue
serialises them across every worktree). **Default to the smallest gate that
covers the changed CODE PATHS: theme/scene DATA variations (colours, light
params, text) do not add code paths and do not need their own verifies.**

**`pnpm ready` applies these tiers to the branch's diff (2026-10-19).** It
classes each changed path (`scripts/gate-plan.mjs`), runs only the Tier 0
checks the diff needs, then every verify leg it needs, and prints READY or NOT
READY. A `src/` file gates only when the export path loads it: the render
closure (`scripts/render-closure.mjs`) is a write-free vite build of what the
app mounts inside its canvas, plus the autorun harness and the toolkit, so
`import.meta.glob` and `?raw` resolve as in the app. Outside `src/`, a short
list of paths never reaches pixels (docs, the kit, CI, tests, non-export Rust
modules) and everything unlisted is gated. A test fails if a closure file is
ever classed as no-verify. `pnpm ready --plan` prints the plan without running
it.

- **One export against the baseline (2026-10-19, Michael).** A leg with a
  recorded baseline exports ONCE (`--action export`) and must match it: the
  baseline came from a passed ×2, so a match proves no regression and
  run-to-run stability together. A mismatch re-runs the leg as Verify ×2 and
  names the outcome: MOVED (×2 identical on a new hash: attribute or rebase)
  or NONDETERMINISTIC. A leg with no baseline verifies ×2, as does every leg of
  a Tier 2+ change (the planner sees the seam). A rebase runs `pnpm ready --x2`
  on the fixture that proves the changed path, then records the rest from
  single exports ("Recording rebases" below).
- **Boots and order.** Hashes depend on what ran earlier in the same boot, so
  the anchors run first in one boot (`showcase-tour`, then `ws:launch-2026`)
  and every other leg gets its own boot.
- **The result cache.** An EQUAL leg is recorded in
  `~/Kookaburra Cut/_autorun/gate-cache.json` against a hash of its inputs:
  every gated repo file, the licensed models, the ffmpeg sidecar and, for a
  `ws:` leg, the fixture folder (sizes and mtimes, exports excluded). An
  unchanged leg is skipped, in any worktree; `--force` re-runs it.
- **Tier 0: statics (free):** lint, build, `vitest related` on the changed
  `src/` files, the script tests, the kb suite and `cargo clippy` + `cargo
  test`, each only when the diff touches its area, plus the workspace-name
  check on every branch (`scripts/workspace-names.mjs`: no name from the
  user's own `~/Kookaburra Cut` and no past leak shape in an added line). CI
  runs all of them on every PR (`scripts/ci-scope.sh` scopes the rust job and
  the kb suite; the name check runs on every pull request with no workspace
  there, so the denylist alone). Pure math
  (eases, presets, schemas, edit math) belongs in unit tests, not in verify
  runs.
- **The PR gate: `pnpm gate:merge`, once, when the render path changed.**
  `showcase-tour` + `ws:launch-2026`, 16:9, one boot. `ws:launch-2026` must be
  EQUAL: the null-for-legacy proof. A PR that touches nothing on the export
  path skips it. Run it after the last code change, not after each fix; the
  cache makes a repeat free when nothing it reads moved. `pnpm gate` runs the
  `showcase-tour` leg alone.
- **Feature fixtures, only when touched (Tier 1):** the fixture whose content
  exercises the changed path joins the run, never as a routine PR check:
  `ws:device-video-spike` for device/media/camera, `ws:duo-spike` for
  foldables, `ws:fx-spike` for effects, `ws:dof-spike` for depth of field,
  `ws:motion-blur-spike` for motion blur, `ws:motion-toolkit-spike` for the
  motion and shape primitives, `ws:camera-kick-spike` for kicks and the beat
  grid, and the rest in `FEATURE_LEGS` (`scripts/gate-plan.mjs`). A
  hand-rolled workspace mini-project covers anything narrower.
- **Fixture budget:** a new gate fixture runs 8 s or less (480 frames) unless
  its path genuinely spans longer: an export costs about 0.1 to 0.3 s per 4K
  frame.
- **Tier 2: escalate selectively:** changes at a SHARED render seam (compositor,
  exporter, SceneStage, effects chain, camera application) add the other class
  project and ONE 9:16 spot-check (aspect-dependent code is rare: it's layout,
  not pipeline); `pnpm ready` adds both and verifies every leg ×2. A hash that
  moves when it shouldn't is a STOP: attribute it
  first (`git stash` the suspect file and re-verify; check the render-state
  fingerprint) before running anything else.
- **Tier 3: the full matrix (all standing projects × all aspects):** ONLY for
  engine-wide constants (FPS, MSAA, shadow type, tone mapping, blending domain,
  font-atlas order), deliberate baseline rebases, phase-closing gates, and
  packaged-app parity checks. `pnpm ready` notes when a diff touches a file
  that holds one, but can't tell a constant edit from any other.
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
- **Stills (any change under `src-tauri/src/stills/**`, `src/engine/still*.ts`,
  `src/engine/exportFrame.ts`, `pageFromReadback` in `downscale.ts`, or the hold
  and timing registries: `presentHold.ts`, `presentHoldPoint.ts`,
  `presentTimingRegistry.ts`):** `pnpm kookaburra:run --action stillsverify
  --project showcase-tour --stills pdf`, then `--stills png` (16:9, 1080p), plus
  the `ws:stills-spike` legs (machine-local: key and time marks, a dormant mark,
  holds, transition overlaps, an excluded scene) for planning changes. Compare
  `pagesHash` (and the PNG zip's file SHA-256) against "Current baselines", not
  just A = B (`pnpm ready` runs both formats and compares). `exportFrame.ts`
  is also the video loop's per-frame body, so a change there takes the video
  gates too. A new Present timing registration moves Present and automatic
  stills, never video bytes: re-record the stills baselines deliberately.
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
16:9 unless noted) export, recorded after a passed Verify ×2. `pnpm ready`
reads both tables below, so keep their shape: one backticked id per row and
each recorded hash backticked in its own cell. Two projects anchor
the set: the null-for-legacy sentinel (`ws:launch-2026`, a hash-identical
workspace copy of the reel dropped from the bundled set on 2026-07-13, scene
durations re-frozen 2026-07-25, see the splice note below) and the bundled
rolling-gate project (`showcase-tour`). A hash from another machine never
compares: after a machine change every cell goes stale and re-records from a
Verify ×2 here (the 2026-10-23 note):

| Project | 16:9 | 9:16 | 1:1 | 4:5 | 5:4 | 3:2 | 2:3 | phone | phone-landscape |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ws:launch-2026` (legacy sentinel: must stay EQUAL) | `cc23761e…` | `67c09dad…` | `57474e02…` | `4bf7a6fe…` | — | — | — | — | — |
| `showcase-tour` (rolling gate) | `fe6b6c20…` | `0194aa22…` | `6512159c…` | `01386b20…` | `c140fe09…` | `2a061bd0…` | — | — | — |
| `transition-spike` (transition gate, image mask included) | `35c2cb0c…` | `0017f87f…` | — | — | — | — | — | — | — |
| `transition-bg-spike` (animated-background transition gate) | `f7714f6b…` | — | — | — | — | — | — | — | — |
| `compare-spike` (before/after comparison gate) | `03f4704d…` | `0c6b7166…` | `d4cac096…` | `ac586a05…` | — | — | — | — | — |
| `compare-transition-spike` (comparisons through transitions; `transitioncheck` proves its crossfades blend) | `48ee3fd8…` | — | — | — | — | — | — | — | — |
| `image-flip-spike` (image-orientation gate, eyeball it) | `5753a093…` | — | — | — | — | — | — | — | — |
| `long-device-spike` (long-film memory gate: devices, a fold, compare media, 61 s) | `9f4a603d…` | — | — | — | — | — | — | — | — |
| `ws:layered-screenshot-spike` (LS gate, machine-local) | `33c75ab8…` | — | — | — | — | — | — | — | — |
| `ws:video-window-spike` (VideoWindow gate, machine-local) | `273e778c…` | — | — | — | — | — | — | — | — |
| `ws:lighting-spike-fable` (v9 lighting gate, machine-local) | `c3d51b40…` | — | — | — | — | — | — | — | — |
| `ws:camera-rig-spike-opus` (camera rig gate, machine-local) | `d4cca56e…` | — | — | — | — | — | — | — | — |
| `ws:multi-device-spike` (deviceLayout gate, machine-local) | `8800fa97…` | `3ea055dc…` | `d8bd6272…` | — | — | — | — | — | — |
| `ws:dof-spike` (depth-of-field gate, machine-local) | `8d99c5ae…` | `903a0f32…` | — | — | — | — | — | — | — |
| `ws:motion-blur-spike` (motion blur gate, machine-local) | `8f2bf463…` | `f66de282…` | — | — | — | — | — | — | — |
| `ws:camera-kick-spike` (camera kicks, musical positions and `useBeatGrid`, machine-local; never in a gate) | `4e965b6c…` | — | — | — | — | — | — | — | — |
| `ws:chart-spike` (chart gate, machine-local) | `01c32706…` | `7b706307…` | `f1820470…` | `d5611672…` | — | — | — | — | — |
| `ws:duplicate-spike` (scene-id heal gate, machine-local) | `74cfca6c…` | — | — | — | — | — | — | — | — |
| `ws:overlay-spike` (overlay gate, machine-local) | `f3d115a5…` | — | — | — | — | — | — | — | — |
| `ws:duo-spike` (foldable gate, machine-local) | `c16be077…` | `372327a9…` | — | — | — | — | — | — | — |
| `ws:device-video-spike` (device/media/camera gate, built-in-lit devices, machine-local) | `c1a9ff92…` | — | — | — | — | — | — | — | — |
| `ws:device-env-spike` (cold frame-0 repro: a built-in-lit handset's top edge, machine-local) | `47d94e84…` | — | — | — | — | — | — | — | — |
| `ws:text-outline-spike` (outlined text in the text barrier: neon, whole-block blur-in, machine-local) | `a644c039…` | — | — | — | — | — | — | — | — |
| `ws:rooms-spike` (room cuts, a flood with a tokened light, a wipe while both sides flood; machine-local, never gated) | `fee706ac…` | `219c3507…` | — | — | — | — | — | — | — |
| `ws:mask-fx-spike` (an image-mask seam between two bloom scenes on the effects lane; machine-local, never gated) | `6555ff7f…` | — | — | — | — | — | — | — | — |
| `ws:motion-toolkit-spike` (the toolkit primitives: shapes, device anchors, text metrics and presets, stamps, dashes, mosaic, taps; machine-local, gated when motion or shape primitives change) | `06b79ae2…` | `fa64bced…` | — | — | — | — | — | — | — |

> **2026-10-28 (the floor follows the posed device: a deliberate rebase of three
> fixtures):** floor shadows and `ground` now stand a device's lowest posed corner on
> the floor (`devicePoseFloorShift`, `docs/foldables.md`), so a device tilted or rolled
> by its placement or keys moves its floor; upright and yaw-only devices are exactly
> 0. First, with the shift forced to 0, the branch exported `ws:duo-spike`,
> `ws:device-video-spike`, `ws:multi-device-spike` and `ws:motion-toolkit-spike`
> EQUAL at 16:9 (media `rotateDeg`, the fold shader's turn, power keys and the rolled
> layout fit are null for legacy). With the shift on, the three fixtures that stage
> tilted devices moved and re-record from a Verify ×2: `ws:duo-spike` `8d28f65a…` →
> `c16be077…` and 9:16 `b6a80fec…` → `372327a9…`, `ws:device-video-spike` `3068ea61…`
> → `c1a9ff92…`, `ws:motion-toolkit-spike` `8af90748…` → `06b79ae2…` and 9:16
> `3955d599…` → `fa64bced…`. The contact shadow under a 3 to 6 degree lean moves by
> under 1% of the device height; frames were eyeballed. The anchors and
> `ws:multi-device-spike` (yaw only) stay EQUAL.

> **2026-10-28 (a transition into a comparison renders: a deliberate rebase of
> one fixture):** the incoming comparison composited its sides through the
> same A/B pair the plain outgoing scene had just filled, so the crossfade
> from `01-null` into `02-split` played as a hard cut, and the old
> `compare-transition-spike` baseline `98132cf6…` recorded that bug. With the
> incoming comparison rendered first, 16:9 re-recorded at `48ee3fd8…` (Verify
> ×2 EQUAL). `transitioncheck` reads that crossfade's midpoint at an outgoing
> weight of 0.505 against an expected 0.5 (0.026 with the fix switched off)
> and `05-blend` into `06-chrome` (comparison into comparison, unchanged) at
> 0.635; the midpoint frame was eyeballed: the title over the half-faded
> comparison. No other gate project stages a comparison, so `ws:launch-2026`
> and `showcase-tour` are untouched by construction.

> **2026-10-24 (three r186: a deliberate rebase, the full matrix):** `three`
> 0.185.1 → 0.186.1 (with `postprocessing` 6.39.5, the first release whose
> peer range admits r186, and `@types/three` 0.186.0) changes physical
> shading: direct and indirect diffuse now give up the energy the specular
> lobe reflects (glTF fresnel mix), the DFG lookup and multiscatter
> compensation are computed once per fragment, and PMREM's blur is rewritten.
> The six `isXRRenderTarget` reads behind the display targets are unchanged.
> Every cell ran once on `317d6660` (r185) and once on the branch (r186) on
> the same day against the same `ws:` fixtures, each leg in its own boot and
> the anchors as a pair, first; every cell that differed then passed a Verify
> ×2 on r186 at its first-pass hash. EQUAL, so untouched by the bump: the
> sentinel `ws:launch-2026` in all four aspects (16:9 also through `pnpm
> gate:merge` ×2), `transition-spike` (both aspects), `transition-bg-spike`,
> `ws:layered-screenshot-spike`, `ws:video-window-spike`,
> `ws:text-outline-spike` and `ws:mask-fx-spike`, none of which lights a
> Standard or Physical material. MOVED, re-recorded: every other cell (each
> stages a lit device, object, chart or set) and all four stills legs. The
> moves are small and one-sided. `showcase-tour`'s text scenes stay
> byte-identical; its scene 7 backdrop reads about one level darker on 74% of
> its pixels (max 12); its handset scenes and `image-flip-spike` move only
> along the handset rim (under 0.5% of pixels, the flat image untouched); a
> 3D pie's lit faces darken by up to 8 and an area-lit extrusion by exactly 1.
> Frame pairs (r185 against r186: 4K `--action screenshot` frames and the PNG
> stills) were eyeballed for every class: transition seams, a comparison, the
> foldable, area and environment lighting, the 3D chart and the handsets all
> draw as before. Stale cells that r186 leaves EQUAL were recorded from that
> pair of single exports, which agree across two boots and two checkouts.

> **2026-10-23 (a new dev machine: every baseline moved):** the dev machine
> changed on 2026-10-20 (now an Apple M5 Max), and every gate leg moved with it
> while staying Verify ×2 identical. `b6fdef67`, the code behind the last EQUAL
> record (2026-10-19, previous machine), exports the new hashes here on all
> four standing legs, so no commit up to `17c85b13` moved them. Nothing else
> they read changed: the `ws:` fixtures and the licensed models predate that
> record, the clip cache (re-extracted on 2026-10-22) writes byte-identical
> PNGs under the pinned ffmpeg 8.1 sidecar and Homebrew's 9.0.2, and both
> builds encode identical frames to identical bytes (x264 core 165 r3222).
> Re-recorded here from a Verify ×2 at `17c85b13`: `showcase-tour`
> `13b5994d…` → `bf85b127…` and the sentinel `ws:launch-2026` `1ad4b2e6…` →
> `cc23761e…` (anchors first, one boot), `ws:device-video-spike` `2d9882c6…`
> → `248022d1…` and `ws:lighting-spike-fable` `bf5021f2…` → `776ada6f…` (each
> alone), and the `showcase-tour` stills (`stillsverify` EQUAL in both
> formats, each matching a pristine `d5ec69b9` run on this machine from
> 2026-10-20). Frames from all four exports were eyeballed: text, the licensed
> handsets with their screen media and the light fixtures all draw. Every
> other recorded cell came from the previous machine and now reads stale:
> record it from its leg's next Verify ×2 here instead of attributing the
> move. A trap that looks like a code move: a worktree without
> `src/assets/models/licensed/` renders the Android fallback, and
> `showcase-tour` then reads `f38ba89d…`, so copy the models in before any
> gate.

> **2026-10-19 (`ws:motion-toolkit-spike` trimmed to the fixture budget,
> Michael):** its 13 scenes went from 3000 to 600 ms in the manifest (39 s to
> 7.8 s, 468 frames), the original kept beside it as
> `project.json.pre-trim-2026-10-19`. Verify ×2 identical at `fba8fa0e…` (16:9)
> and `91bea026…` (9:16) on render code unchanged from main `c6ce484f`, so the
> move is the trim alone. Accepted cost: moments past 600 ms into a scene (the
> shape path's later keys, a tap press at 1.3 s, a tap ring at 2 s) no longer
> render. The same session's `pnpm ready` proved a single export matches a
> ×2-recorded baseline: `showcase-tour` `13b5994d…` and `ws:launch-2026`
> `eb89826c…` (second leg) both matched.

> **2026-10-19 (display targets: a deliberate rebase):** every no-effects SDR
> target is now a display target (see "Rendering into a plain render target"),
> so transition sides, comparison sides and framed cutouts tone-map like the
> canvas. Eyeballed at 4K against main `c6ce484f` through `--action
> screenshot`: a mid-push headline goes from its raw (242,245,250) to ACES's
> (223,223,225), the solo value, with every glyph-interior pixel exact and the
> bright histogram identical to the solo frame; a comparison's "after" label
> reads (120,210,202) in both its solo and push frames where main showed
> (58,209,196) solo and the double-encoded (131,234,227) mid push; plain solo
> frames are byte-identical to main. Dim text on a comparison side darkens
> under the ACES toe, as it does on any canvas frame. A framed scene in an
> effects project moves too: its solo frames take the framed branch ahead of
> the effects lane, so three's tone map now applies inside the cutout where it
> was raw (its transition frames still fall back to the unframed HDR render).
> No gate fixture combines a frame with effects. `showcase-tour` stayed
> EQUAL (`13b5994d…`), as did `ws:lighting-spike-fable` (`bf5021f2…`),
> `ws:mask-fx-spike` (`c93487c0…`) and the `showcase-tour` stills: the
> composer lane never touches these targets. Moved, re-recorded: the
> sentinel `ws:launch-2026` `eb89826c…` → `1ad4b2e6…` (Verify ×2, then a
> single anchors-first export, both as `gate:merge`'s second leg),
> `transition-spike` (Verify ×2 in both aspects; a 16:9 `--cold` export matches),
> `compare-transition-spike` (first record, Verify ×2), and from single
> exports, each fixture alone in its own boot: `transition-bg-spike`,
> `compare-spike`, `ws:dof-spike`, `ws:device-video-spike`,
> `ws:motion-blur-spike` (both aspects), `ws:layered-screenshot-spike`,
> `ws:chart-spike` (its framed scene), `ws:rooms-spike` (both aspects) and the
> `ws:stills-spike` stills. `ws:emoji-spike` and `ws:shader-spike` (one
> crossfade each) are marked stale, as `ws:overlay-spike` and
> `ws:duplicate-spike` already were. Every leg was recorded anchors first or
> alone in its own boot ("Boots and order" above).

> **2026-10-18 (image-mask transition, a fifth material generation):** with the
> code in and the fixtures untouched, `transition-spike` stayed EQUAL at
> `fb727cac…` (16:9) and `a6383707…` (9:16), the proof that every earlier
> program is untouched, and `pnpm gate:merge` stayed EQUAL (`showcase-tour`
> `13b5994d…`, `ws:launch-2026` `eb89826c…`). `transition-bg-spike` reads
> `f16fe7c1…` on this change AND on its pristine base `33646df1`, so the
> `2df76336…` record from #50 was earlier drift. `transition-spike` then gained
> one seam (spin blur into a star `shape: "image"` luma, 700 ms smooth, mask
> `assets/star-mask.png`, a procedurally drawn 1024 px alpha star), recording
> `53b6c496…` (16:9) and `892e8e10…` (9:16), eyeballed at 4K: a crisp
> one-pixel edge, sharp notches, tips rounding as the dilation grows, cover
> complete before the seam. `ws:mask-fx-spike` (two bloom scenes, the same
> mask) records `c93487c0…`. Leg order matters: `showcase-tour` read
> `e36392de…` as the third leg of a boot after `transition-spike` and
> `ws:mask-fx-spike`, and `13b5994d…` again first in its own boot, so gate
> anchors run first or in their own boot.

> **2026-10-18 (troika 0.52.5, one SDF size, opt-in exact text: hash-neutral):**
> troika-three-text and troika-three-utils move to an exact `0.52.5` pin, one
> copy in the tree (drei dedupes onto it). Upstream 0.52.5 ships our ANGLE Metal
> `inout` fix verbatim, so the utils patch is gone, and
> `patches/troika-three-text@0.52.5.patch` keeps only the wedge fix and the Typr
> cmap fall-through. The patched 0.52.5 esm and umd text builds are
> byte-identical to the patched 0.52.4 ones, and the utils builds differ by one
> JS comment. `SDF_GLYPH_SIZE` pins the 64 every site already used, and no gate
> project sets `render.exactText`. `pnpm gate:merge` stayed EQUAL
> (`showcase-tour` `13b5994d…`, `ws:launch-2026` `eb89826c…`), as did
> `ws:text-outline-spike` (`87bb6b3a…`). `ws:emoji-spike` reads `da3b7d53…` on
> this change AND on pristine main `18538e02`, so its 2026-07-13 `fc772d5b…`
> record is earlier drift, not this change (`da3b7d53…` is its current 16:9
> value). With `exactText` on, an effect-free headline's `#F5F7FA` lands at
> (245,247,250) instead of ACES's (223,224,225), with the layout unchanged.

> **2026-10-18 (camera kicks and musical positions):** `ws:camera-kick-spike`
> (a generated 128.4 BPM click soundtrack, an authored `audio.grid`, orbit and
> rig keys and kicks on `bar:`, `cue:` and `section:` positions, a `useBeatGrid()`
> pulse, and a snap kick under a 180° shutter) verifies ×2 at `1ab8d22d…`. Frames
> eyeballed: the zoom kick peaks on bar 2 and the snap renders without a ghost.
> Kick-free projects held EQUAL: `ws:camera-rig-spike-opus` `81429136…`,
> `ws:motion-blur-spike` `bb5b4682…`. Run the fixture only when kicks, the grid
> or positions change; it never joins `gate`, `gate:merge`, CI or release parity.

> **2026-10-18 (`ws:camera-rig-spike-opus` re-baselined on main `18538e02`):**
> the fixture's 16:9 baseline had gone stale, so it re-recorded on pristine
> main before the camera-kick work: Verify ×2 identical at `81429136…`, frame
> eyeballed (rig angle, handset screen video, decorations all present).

> **2026-10-08 (outlined text joins the text barrier, hash-neutral):** troika
> returns `[outline, main]` from `Text.material` whenever an outline is set
> (neon's halo, whole-block blur-in's `outlineBlur`), so `awaitTextSync` never
> kicked or awaited those meshes. It now matches troika's `Text` by class, and
> its wait is spin-bounded like the other barriers. `pnpm gate:merge`
> stayed EQUAL (`showcase-tour` `13b5994d…`, `ws:launch-2026` `eb89826c…`):
> neither anchor stages outlined text. `ws:text-outline-spike` (a neon block, a
> blur-in/out block and a neon ticker re-typesetting every 50 ms) records
> `87bb6b3a…`, eyeballed. The unfixed exporter renders the same hash: with
> `useWorker: false`, drei's layout-effect `sync()` typesets preloaded glyphs
> before the render, so the hole was latent, not live.

Stills baselines are full SHA-256 values from a passed `stillsverify` in
reproducible mode, 16:9 at 1080p (see "Stills export"). `pagesHash` is the gate;
the PNG zip's file hash must match too; a PDF's file hash is advisory only.

| Project | Format | Pages | `pagesHash` | File SHA-256 |
| --- | --- | --- | --- | --- |
| `showcase-tour` | PDF | 7 | `5dac54de3acb1fddae43259ab0f0a552a949fafb804cce157c28483022b0ad01` | `6c76cdf79eba92d95556bf93939eda529a6083708dfc3e0df5258135747c9cf1` (advisory) |
| `showcase-tour` | PNG zip | 7 | `48226fffa7faa9aae1791fb0fd96a2d87d21f436b506c125bef5cbb8eaeab793` | `1e75cd5a6c299db23ca9bd1ab63724226b61fd3be29b182ea7f1c94cfd8868c9` |
| `ws:stills-spike` (stills gate, machine-local) | PDF | 9 | `ca933fc68a37d1f399adb0ff450fd3717135977a3e2684be261396b0a197b0ef` | `4dabcf21b07f28c03e71a936033b580696010e104cede004a7b00e8f0a599509` (advisory) |
| `ws:stills-spike` (stills gate, machine-local) | PNG zip | 9 | `ab801558e4ec12c5fc2d3312683c22d3be67021ca8c6fcfe230a57fab6c1b7cd` | `a098c93a7bf9ea6e56bca8ef683a3ccff9cc9ba53581c49a24244f7a43af2196` |

> **2026-10-08 (stills export, a fresh record):** `showcase-tour` records its
> first stills baselines (above), `stillsverify` EQUAL for both formats, every
> file identical between passes. Its seven scenes give seven automatic pages at
> global 1500, 2500, 3500, 4133.333, 7000, 8100 and 10200 ms (no marks). Stills
> add no video baseline: the `exportFrame.ts` extraction keeps the video loop's
> GL call sequence and Present timing registrations have no render effect, so
> the video legs must stay EQUAL (`pnpm gate:merge`).

> **2026-10-03 (the lit set's shared environment: a DELIBERATE rebase, confirmed
> by Michael):** `Device`, `DeviceMockup` and `HeroObject` stopped mounting
> drei's `<Environment>` and share one studio environment built once per
> renderer (see the failure table). Built-in-lit devices therefore render every
> frame exactly as a cold run's frame 0 always did: a cold single-frame capture
> of `ws:device-env-spike` is byte-identical before and after the change, while
> the old per-frame rebuild had shifted a few highlight pixels from frame 1 on.
> `ws:device-video-spike` 16:9 re-records at `386c8419…` (was `fe0e886b…`),
> Verify ×2 with an eyeballed frame. `ws:duo-spike` held EQUAL at `2e023390…`
> (16:9) and `b28e7c7f…` (9:16): its lit poses never reach the shifted pixels.
> The anchors never stage a built-in-lit device, so `pnpm gate:merge` stayed
> EQUAL (`showcase-tour` `13b5994d…`, `ws:launch-2026` `eb89826c…`).
> `ws:device-env-spike` (the frame-0 repro: the atlas-2 opening shot, three
> scenes) records `9f3418a2…` and now passes cold, where it failed at frame 0
> before (2 px, 131 vs 187). `ws:device-env-40` (40 device scenes, 4,800
> frames per Verify) records `8ae231ca…` with the WebContent footprint flat at
> 2.2 to 2.3 GB throughout, where a dev-build Verify of a 40-scene device project
> had reached the 4 GB ceiling near frame 1250. Baselines over other
> built-in-lit device projects are stale until their own legs rerun.

> **2026-09-19 (foldables, a fresh record):** `ws:duo-spike` records 16:9
> `2e023390…` and 9:16 `b28e7c7f…`, Verify ×2 each: the iPhone Duo open with both
> displays playing, four static fold poses, a keyframed unfold with "Start when
> opened", the three foldable poses, and a dead-on linear unfold. Frames were
> eyeballed first, the dead-on scene against Apple's own footage at matching
> angles (content flat and level across the hinge, black wedges where the
> projection runs out, the static half untouched, brightness at 45 degrees within
> the measured profile). It is the first skinned, clip-sampled device and the
> first per-material projection, so the proof that matters is A = B across a fold.
> Before the blur handover landed the four-scene fixture recorded `e622d9ed…`;
> dropping the two handover commits returns to that path, not that hash, since the
> fixture has since gained a scene. Through the structural `Device.tsx` and
> `shadowProjector.ts` changes `pnpm gate:merge` stayed EQUAL (`showcase-tour`
> `13b5994d…`, `ws:launch-2026` `eb89826c…`), as did `ws:device-video-spike`
> `fe0e886b…` and `compare-spike` `f425a9a8…`. Licensed glb, so the row is
> machine-local: a build without it renders the Android stand-in and will not match.

> **2026-09-07 (comparison preload plan, a fresh record):** `compare-spike`
> 16:9 records `f425a9a8…`, Verify ×2, its first leg since the analytic-shadow
> rebase left it stale; eyeballed frames of the sweep and split scenes show
> side B in its own theme with its own typography, splitting cleanly at the
> divider. The change folds comparison side-B themes into the font preload and
> side-B mirror bakes into the environment plan at all four preload sites
> (`collectMirrorRequestsWithCompare`), commits each in-app Verify leg's aspect
> to the store before it hashes (`commitFormat`), and opens the export cleanup
> scope before the preamble. `showcase-tour` stayed EQUAL at `13b5994d…` and
> `ws:launch-2026` EQUAL at `eb89826c…` through it (neither stages a
> comparison), and the pack round trip on `ws:launch-2026` matched in 16:9,
> 9:16 and 1:1. The other compare-spike aspects stay stale.

> **2026-08-25 (analytic device shadows: a DELIBERATE rebase):** the three
> presentation shadow modes moved off their fixed-size textures and the flat
> sun sweep onto ONE analytic projector that casts the device's real silhouette
> (`toolkit/device/shadowProjector.ts`). Every staged DEVICE therefore renders
> differently: `showcase-tour` 16:9 re-recorded at `13b5994d…` after a passed
> Verify ×2 and an eyeballed frame, and every other baseline over a
> device-staging project is stale until its own leg reruns (`compare-spike`,
> `image-flip-spike`, `ws:multi-device-spike`, `ws:camera-rig-spike-opus`,
> `ws:lighting-spike-fable`, `ws:dof-spike`, `ws:duplicate-spike`,
> `ws:overlay-spike`). `ws:launch-2026` stages NO device, so the
> null-for-legacy sentinel stayed EQUAL at `eb89826c…` through the change, and
> `ws:device-video-spike` verified identical twice (`fe0e886b…`) as the
> feature-matched gate. The sun sweep itself settled as ONE convex polygon on
> the receiver (the outline hulled with its swept copy, `sunSweepHull`), offset
> to match its root blur and eased over one full-span smoothstep ramp: a single
> soft shape with a gentle fade, where probing root, band and far copies
> separately read as overlapping shadows. Record both AFTER the reserved-word fix: a shader whose
> fragment stage ANGLE rejects fails SILENTLY (the quad simply never draws), so
> the first pass of these legs recorded a device with no shadow at all. A
> vitest now guards the shader source against every GLSL reserved word. The opt-in `deviceTrack` keyframes that ship beside it
> move nothing on their own: no bundled project, template or repo fixture
> carries the block, and a scene without one samples the resting pose.

> **2026-08-23 (media hosting is authored: the `window` host):** where a media
> entry renders now follows its HOST alone, never its kind or its chrome.
> `SceneMediaHost` gained `window` (video-only; a still asking for it degrades to
> `overlay` at parse), which is the floating world-space clip the video window
> always was, reading the OVERLAY placement numbers exactly as
> `resolveWindowMediaTransform` already did, so no placement block was added. The
> legacy `videoWindow` promotion now lands on `host: "window"`: the same entry,
> the same family, the same maths, so `ws:video-window-spike` and
> `ws:overlay-spike` must stay byte-identical (`sceneMediaFromVideoWindow` is the
> only line that changed, and `sceneMediaFamily`/`sceneMediaUsesWindowPath` both
> answer as before for it). A hand-authored clip with no `host` still parses to
> `window`, which is what an unhosted clip has always rendered as. The ONE
> combination whose pixels move is media-native `kind: "video"` + `host:
> "overlay"`, which used to take the world-space window path and now draws on the
> overlay's frame layer beside the overlay stills (the still's sizing rule, `size`
> IS the width, with the window chrome as optional plane decoration). That was the
> owner's bug: an Edit render re-points a still to a clip, and the kind flip
> silently moved a placed frame-layer image into the scene's world. NO bundled
> project, template or repo fixture carries that combination (`grep -rn '"kind":
> "video"' projects fixtures src-tauri/templates` finds device screens only, and
> the one repo fixture with a clip window carries the legacy `videoWindow`
> block), so the standing baselines cannot move on data grounds; gate legs are
> pending the batch's gate run.

> **2026-08-23 (transparent panel + shaped cutout: a DELIBERATE render
> change):** an overlay whose panel is transparent and whose cutout carries a
> shape now composes exactly as an opaque panel does: the world renders into
> the cutout-sized target and the slide pass keys it through the cutout, with
> the region outside taking the scene's own backdrop instead of the panel
> surface. It used to skip the slide pass and render the scene full-bleed,
> while `SceneHost` had always narrowed `useFormat()` on the SHAPE, so those
> scenes were laid out for a window they never got (the owner ruling of
> 2026-08-23; `docs/decisions.md`, "Overlay cutout vs panel fill"). One rule
> now serves all three seams, `framesThroughCutout` in `frameFormat.ts`.
> Everything else is byte-null by construction: opaque, gradient and image
> panels take the same branch they always did, `shape: "none"` still fills
> flat (and still stands the whole slide pass down when the panel is
> transparent, the full-bleed-chrome idiom), and an unframed scene never
> reaches this code. NO bundled project, template or repo fixture pairs a
> transparent panel with a shape (`grep -rn '"transparent"' projects
> src-tauri/templates` is empty), so the standing baselines cannot move on
> data grounds; gate legs and any re-records are pending the batch's gate run.

> **2026-08-22 (scene media: images and the video window merged):** a scene's
> stills and its floating screen recording became ONE sidecar family, `media[]`,
> each entry carrying a `kind` ("image" or "video"), a source, both host
> placements and the optional `window` chrome block the video window
> contributed. Nothing renders differently by construction: a sidecar written
> before the merge keeps its own `images`/`videoWindow` blocks and reads FORWARD
> into the same array at parse (attached non-enumerably, so an untouched
> document writes back byte-identically), and the first media edit promotes it
> to `media` in the same entry. A plain-image scene and a scene with no media at
> all are null paths: the fallback mounts nothing, and the entries a legacy doc
> promotes to sample through the same placement and motion maths as before
> (`windowOverlayPlaneWidth` reproduces the old contain fit at every aspect,
> `sampleSceneMediaMotion` dispatches to each kind's original sampler). The rig
> aim and the follow-media duration now bind by media id; the legacy
> `"videoWindow"` spelling stays valid on both and keeps resolving to the entry
> serving as the window, whose aim point stays exactly `[0, 0, 0]` so recorded
> fixtures do not move. Verified post-merge: the migration is byte-null on
> every gated fixture. `ws:video-window-spike` Verify ×2 returned its ORIGINAL
> baseline (`6dfe68a6…` twice), so it was not re-recorded. `ws:overlay-spike`
> came back EQUAL at `e5bc2b79…`, off its 2026-08-07 recording; the same verify
> on pristine main (99566e9e) produced the identical `e5bc2b79…`, so the drift
> predates this batch (main-side, unbisected, the 2026-08 drift pattern) and
> the table records the new hash with the batch branch proven byte-identical
> to main. `pnpm gate` stayed EQUAL on baseline (`28beda34…`).

> **2026-08-22 (Phone and Phone Landscape aspects):** `phone` (1206×2622) and
> `phone-landscape` (2622×1206) joined the first-class, feature-scoped set: the
> iPhone 17 Pro panel at its native size, exactly 437:201. They are the first
> aspects under the 2160 short edge, the owner's explicit call, so a phone cut
> matches the panel it plays on instead of being scaled to the house
> convention. Their ids are slugs, not ratios, because the export path runs
> `name.replace(":", "x")` through `validate_slug` (alphanumerics, dashes and
> underscores only); `aspectLabel()` maps them to "Phone" and "Phone Landscape"
> in every surface that shows an aspect, and `AspectIcon` now proportions its
> rect from `FORMATS` rather than parsing "W:H" out of the name. No existing
> format's dimensions move, so the batch's standard gate carries the
> null-for-legacy proof; `STANDING_ASPECTS` is unchanged (Verify's "all" is
> still the standing three) and neither aspect has a baseline until a project
> ships in one, the 2:3 precedent. Eyeballed at record time: both orientations
> render at the exact panel dimensions; landscape frames cleanly, but portrait
> clips `showcase-tour` headlines on both edges (scenes were authored down to
> 9:16's 0.5625 width, phone is 0.46), the 5:4 pattern of scene-authoring
> overflow rather than aspect plumbing. That overflow is WHY no phone baseline
> was recorded; check scene text widths per project before shipping a phone
> export.

> **2026-08-19 (theme library, inspector redesign):** two moves that landed on
> main without a re-record, bisected leg by leg. #134 (theme library) appends
> four faces to `BUNDLED_FONTS`, the REBASE EVENT this document warns about:
> 46 frames of scene 2 shift, at most 67 px each, max channel delta 6, all on
> the glyph edges of the Playfair headline, and nothing else in the 612-frame
> reel changes a byte (ProRes framemd5 against a pre-#134 export). Attribution
> is proved the prescribed way: dropping ONLY those four faces at `75be37a`
> reproduces `f304f1bd…` exactly. #137 (inspector redesign) then reworks device
> shadowing, the `Device` paragraph it rewrote above: 263 frames move across
> exactly the three device scenes (04, 05, 07), 99% of the changed subpixels
> DARKER, and a soft contact shadow is eyeballed back under the handset in
> scene 7. A shadow gained, not lost, so the move is the intended direction;
> which sub-change lands it is not pinned down (that batch touches the
> presentation-blob default, world-anchored shadow grounding, and the floor Y
> handed to lighting). `showcase-tour` re-recorded 16:9 `f304f1bd…` →
> `28beda34…` and 9:16 `8cdb7481…` → `b3e3dd72…`, both Verify ×2, and
> `ws:launch-2026` stays EQUAL at `eb89826c…` over both moves (`pnpm
> gate:merge` on `dc952e1`), so no engine-wide constant moved. The #133
> dependabot bumps (`postprocessing` 6.39.4, `@react-three/fiber` 9.7.0) are
> pixel-NULL on this reel: `8cc778c` carries them and still verifies
> `f304f1bd…`.

> **2026-08-19 (comparison fixture, same upstream moves):** `compare-spike`
> 16:9 re-records `8d293536…` → `b6883733…`, Verify ×2. The fixture was run
> twice on the batch-23 branch and twice on a pristine `origin/main` at
> `dc952e1` on the same machine, and both produce `b6883733…`, so the move is
> the pair of upstream moves recorded above, not the branch. This leg was not
> bisected itself, and its other aspects go stale rather than re-recorded,
> since they were not re-run.

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
> (Corrected 2026-10-19: not the translator. three never tone-maps inside a
> plain render target; see "Rendering into a plain render target" above.)
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

> **2026-08-09 (device availability):** licensed device GLBs remain optional,
> gitignored build inputs. A build now exposes only models whose complete GLB is
> present, with committed Android always available and selected by default in a
> clean clone. Existing documents keep their saved model id, but rendering,
> screen binding, colours, fit, lid controls and layout resolve together to the
> Android specification when that id is unavailable. The preload barrier now
> rejects any available model whose declared screen material is missing, closing
> the placeholder/material mismatch that left iPhone 17 and MacBook screens
> black in worktrees. An asset-free screenshot of `ws:test-duplicate` scene 4
> showed the Android fallback with its video bound; after the three licensed
> GLBs were copied into the worktree, the same screenshot showed the iPhone 17
> with the same video. The 2026-07-30 equal-layout note below remains historical:
> current clean builds use Android's catalogue width for unavailable devices.
> With licensed assets restored, `showcase-tour` Verify ×2 stayed EQUAL and
> unchanged at `f304f1bd…`.

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
> is a pass-through, so solo frames are byte-identical. (Since 2026-10-19 the
> compositor's targets are display targets holding raw bytes, so `u_linearOut`
> stays 0 there; it still serves any hardware-sRGB target.) New fixture
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

> **2026-08-25 (v15 transition pack):** thirteen new shader types (inkbleed,
> flowmorph, shockwave, glasssweep, rackfocus, halftone, lightsweep, shatter,
> pixelstretch, chromasplit, datamosh, prism, spinblur) landed as a fourth
> material generation with an explicit endpoint guard; every earlier program
> stays source-identical and both merge anchors held EQUAL in the same session
> (`showcase-tour` `28beda34…`, `ws:launch-2026` `eb89826c…`).
> `transition-spike` gained thirteen scenes covering every new seam, a
> deliberate content change: re-recorded `6b058e1b…` → `fb727cac…` (16:9) and
> `74e02850…` → `a6383707…` (9:16), Verify ×2 EQUAL in both aspects, after
> eyeballing all thirteen seams mid-transition via `--action screenshot`.

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
| `ws:emoji-spike` (emoji/symbol pipeline) | stale (2026-10-19 rebase) | stale | n/a | n/a |
| `ws:shader-spike` (animated background pack) | stale (2026-10-19 rebase) | n/a | n/a | n/a |

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
