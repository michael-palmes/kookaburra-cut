# Architecture

> The rendering & export architecture, plus the rationale behind it. The
> byte-identical-export contract is in [determinism.md](./determinism.md); the
> locked-decisions log is in [decisions.md](./decisions.md).

## The core idea

One WebGL surface for everything. Text (troika SDF), graphics, and 3D are all
Three.js objects inside a single react-three-fiber `<Canvas>`. WebKit cannot
deterministically capture the DOM, so nothing visual is ever DOM/CSS. That is
the whole architecture in one sentence.

Export steps a manual clock frame-by-frame, reads pixels with `gl.readPixels`,
and pipes raw RGBA to a bundled ffmpeg sidecar that encodes H.264, H.265 and
ProRes. It runs in pure WKWebView (Tauri 2), no Chromium fallback.

## Data flow (export)

```
global timeline (anime.js, autoplay off)
        │  seek(tMs)              ← preview and export drive the SAME clock
        ▼
React commit  → Three.js objects (position, opacity, text, …)
        │
        ▼
r3f advance(tMs)  (frameloop="never")  → renders exactly one frame
        │
        ▼
gl.readPixels → one reused RGBA Uint8Array (3840×2160 ≈ 33 MB)
        │  invoke("push_frame", rgba)   ← zero-copy, InvokeBody::Raw
        ▼
Rust handler → ffmpeg sidecar stdin  (-f rawvideo -pix_fmt rgba -vf vflip …)
        ▼
out.mp4 (libx264 default; h264_videotoolbox optional) / out.mov (prores_ks 422 HQ)
```

Determinism holds because time is an explicit input (no `requestAnimationFrame`,
no `Date.now`) and all fonts/assets are preloaded before frame 0. The full
loop and its failure modes are in [determinism.md](./determinism.md).

## Modules

| Path | Role |
| --- | --- |
| `src/engine/timeline.ts` | anime.js global timeline wrapper; `useTimeline()`; `configureDeterministicEngine()` |
| `src/engine/format.ts` | `FormatInfo`, `FORMATS`, `useFormat()`, safe-area maths |
| `src/engine/exporter.ts` | deterministic frame loop |
| `src/engine/compositor.ts` | `renderComposited`: single-scene direct render / two-scene transition composite |
| `src/engine/sceneTimeline.ts` | global→local time mapping (`buildSceneTimeline` / `resolveAt`) |
| `src/engine/project.ts` | project loading: manifest, sidecars, theme/audio resolution |
| `src/toolkit/` | shipped primitives + `defineScene`; the `@kookaburra/toolkit` surface |
| `src/theme/` | theme schema, bundled themes, tokens, fonts |
| `src/store/editorStore.ts` | zustand UI state (export path ignores it) |
| `src-tauri/src/lib.rs` | plugin registration + `push_frame` raw-IPC command |
| `projects/<project>/` | file-based project format (`project.json` + `scenes/` + `assets/`) |

## Why store-backed hooks (not React context)

react-three-fiber renders through a separate reconciler; React context from
outside `<Canvas>` does not bridge in. `useTimeline` / `useFormat` / `useTheme`
therefore read a zustand store, which works on both sides of the Canvas boundary.

## Multi-format

One project renders to 16:9 / 9:16 / 1:1 (and 4:5 for social-feed exports) via
`useFormat()`. Scenes lay out against a normalised space + `safe` insets and
branch on `aspect`, rather than per-format files. Each aspect is a separate
export pass. For the rare scene that genuinely needs a different composition per
aspect, an optional `variants` map keyed by aspect is the escape hatch.

## Stack

The canonical version list. (CLAUDE.md and the root README point here rather
than restating versions.) Pins live in `package.json` and `src-tauri/Cargo.toml`.

| Dependency | Version | Role | Licence |
| --- | --- | --- | --- |
| Tauri (core + CLI) | 2.11.x | App shell, Rust core, WKWebView via WRY | MIT / Apache-2.0 |
| tauri-plugin-shell | 2.3.x | Spawn and pipe to the ffmpeg sidecar | MIT / Apache-2.0 |
| tauri-plugin-fs | 2.5.x | Read/write project folders and assets | MIT / Apache-2.0 |
| React | 19.2.x | UI and scene component model | MIT |
| TypeScript | 5.9.x | Typed toolkit and scene files | Apache-2.0 |
| Vite | 8.0.x | Dev server, HMR preview, prod bundle (Oxc transform/minify) | MIT |
| @vitejs/plugin-react | 6.0.x | React fast-refresh / JSX for Vite | MIT |
| three | 0.184.x | WebGL renderer and scene graph | MIT |
| @react-three/fiber | 9.6.x | React renderer for Three.js | MIT |
| @react-three/drei | 10.7.x | Loaders, controls, `<Text>` helper | MIT |
| @react-three/postprocessing | 3.0.x | Bloom, vignette, colour grading | MIT |
| troika-three-text | 0.52.x | SDF text in WebGL (the text engine) | MIT |
| anime.js | 4.4.x | Global seekable timeline / sequencing | MIT |
| d3-ease | 3.x | Permissive easing primitives | ISC |
| d3-interpolate | 3.x | Permissive value interpolation primitives | ISC |
| zustand | 5.0.x | Editor / preview / timeline UI state | MIT |
| esbuild-wasm | exact-pinned | In-webview compile of workspace scene TSX | MIT |
| ffmpeg + ffprobe (sidecars) | 8.x (pinned source build) | Frame encoding (H.264 / H.265 / ProRes / FFV1) + media probing | LGPL / GPL (see note) |
| Vitest | 4.x | Tests, incl. the determinism harness | MIT |
| Biome | 2.5.x | Lint + format | MIT / Apache-2.0 |

Rust crates (`src-tauri/Cargo.toml`): `tauri 2.11.x` (+ shell/fs/log plugins),
`serde`/`serde_json`, `tokio`, `sha2` (the `hash_file` Verify command),
`portable-pty` (embedded terminal), `allsorts` (exact-pinned; variable-font
instancing), `trash` (recoverable deletes), `objc2` (native menu/window
touches).

Licence note: every JS/Rust dependency is permissive (MIT/Apache/BSD/ISC-class)
except **ffmpeg**. ffmpeg licensing depends on the enabled
encoders: a build using only native (`prores_ks`) and Apple VideoToolbox
encoders is **LGPL**; adding **libx264/libx265** for high-quality software H.264/
H.265 makes the binary **GPL**. Since ffmpeg is a separately distributed
executable invoked over a CLI boundary, this does not infect the app source, but
it does impose GPL terms on redistribution of the binary. The release sidecar is
a pinned self-contained GPL build; an LGPL build flag exists as the recorded
path to any public binary distribution.

## Why this stack (key findings)

1. **WKWebView is good enough.** Current macOS WebKit supports WebGL2,
   OffscreenCanvas and WebCodecs. Because Kookaburra Cut encodes with ffmpeg and
   only optionally decodes clips with WebCodecs, the WKWebView feature set covers
   every locked requirement. Guard: on older Safari lines,
   `AudioDecoder`/`ImageDecoder` are undefined while `VideoDecoder` works;
   feature-detect each interface separately.

2. **Deterministic DOM capture is impossible in WebKit.** WebKit taints a canvas
   when an SVG with a `foreignObject` is drawn into it unless the SVG is a
   self-contained `data:` URI (a WebKit bug open since 2016). `html2canvas` /
   `html-to-image` / `dom-to-image` are async, depend on font/image inlining, and
   exhibit a documented Safari "first render blank, second correct" race. None
   can guarantee frame N is byte-for-byte reproducible, so no DOM/WebGL hybrid.

3. **Therefore one WebGL surface.** Text renders with troika-three-text (SDF
   glyphs) inside the same r3f canvas as the 3D. Per-frame determinism requires
   preloading all fonts and SDF glyphs before frame 0 and driving animation from
   an explicit time value, because troika's SDF generation runs async.

4. **ffmpeg is the encoder, not WebCodecs.** WebCodecs has no ProRes encoder, and
   ProRes (editing handoff) is a locked requirement. The sidecar produces clean
   4K H.264 and ProRes with full control over pixel format and colour. Frames
   travel as raw RGBA over the Tauri IPC boundary into ffmpeg stdin, avoiding
   per-frame base64/PNG overhead.

## Render & export, in depth

**The problem.** Three locked constraints pull against each other: scenes are
React/TSX with rich animated text; scenes also carry heavy r3f 3D; export must be
deterministic, frame-accurate, 4K, inside WKWebView (not Chromium).

**The resolution: one WebGL surface.** Because WebKit cannot deterministically
capture the DOM (finding 2), all visual content is authored as Three.js objects
in a single `<Canvas>`:

- Text (headlines, body, counters) → troika SDF meshes.
- Static graphics (PNG/SVG) → textured planes/sprites, or SVG tessellated via `SVGLoader`.
- 3D content and device mockups → ordinary r3f meshes and glTF models.
- drei `<Html>` overlays are used **only** for editor chrome, never for exported pixels.

What is lost vs DOM/CSS: arbitrary flow layout, native sub-pixel hinting,
trivially rich inline markup. What is gained: a single, synchronous, frame-locked
surface whose pixels are reproducible. For product-update videos (headlines,
counters, device demos, transitions) troika gives kerned, ligature-aware text.

**The deterministic frame loop** runs with `frameloop="never"`; an export
controller owns the clock, seeks the global timeline to `t`, advances exactly one
frame, and reads it back. The authoritative loop, its barriers, and the
`preserveDrawingBuffer` requirement live in [determinism.md](./determinism.md).

**Data path from frame to file.** r3f WebGL framebuffer → `gl.readPixels` into one
preallocated `Uint8Array` (RGBA8, 3840×2160 ≈ 33 MB, reused every frame) → Tauri
IPC (`invoke("push_frame", rgba)`, `InvokeBody::Raw`, zero-copy) → Rust handler →
child-process stdin → ffmpeg `-f rawvideo -pixel_format rgba -video_size
3840x2160 -framerate <fps> -i - -vf vflip <encoder opts> output`. `-vf vflip`
corrects `gl.readPixels`'s bottom-up origin. Frames are streamed, never
accumulated in JS, so peak memory is one frame buffer plus GPU resources.

**Throughput bottlenecks.** (a) `gl.readPixels` forces a GPU/CPU sync stall:
acceptable for offline export, unavoidable in WebGL2 on Safari. (b) ~33 MB/frame
IPC: mitigated by raw bytes over `InvokeBody::Raw` and one reused buffer.
(c) ffmpeg encode: hardware VideoToolbox keeps it off the CPU when selected.
(d) WebKit's 2D-canvas pixel ceiling (16,777,216 px) does not bind a 4K WebGL
drawing buffer (~8.3M px); keep any auxiliary 2D helper canvases small.

**Encoder commands.**

- H.264, deterministic default:
  `ffmpeg -f rawvideo -pixel_format rgba -video_size 3840x2160 -framerate 60 -i -
  -vf vflip -c:v libx264 -crf 16 -preset slower -pix_fmt yuv420p -color_range tv
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -flags:v +bitexact
  -fflags +bitexact -map_metadata -1 -movflags +faststart out.mp4`.
  Hardware alternative (selectable): `-c:v h264_videotoolbox -b:v 60M`.
- ProRes (editing handoff):
  `ffmpeg … -c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le -vendor apl0
  -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709
  out.mov`. Profile 3 = 422 HQ 10-bit (the default; no alpha requirement);
  `prores_videotoolbox` is the hardware alternative.
- Platform export presets (H.264/H.265, scaling, two-pass, loudness) build a
  separate argv family on top; see
  [determinism.md](./determinism.md#export-presets--the-encode-spec-family).

## Scene & timeline architecture

**One global continuous timeline.** A single anime.js timeline
(`createTimeline({ autoplay: false })`) is the project clock. Scenes are
registered as time ranges on it; the export loop and the live preview both drive
the same timeline via `seek(t)`, so preview and export are pixel-identical by
construction.

**2D and 3D in lockstep.** Because text, graphics and 3D are all Three.js objects
in one scene graph, a single `seek(t)` + one `advance(t)` updates and renders
them together: no cross-context sync problem. For values awkward to express as
tweens (bespoke camera paths), pure keyframe helpers sample as functions of `t`.

**Shared-element morphs across scene boundaries.** Because the timeline is global
and elements live in one persistent scene graph, a "shared element" is one object
whose tweens span the boundary between two scenes; at the seam its
position/scale/colour interpolate continuously. Crossfades animate group opacity;
continuous-camera moves keyframe the shared camera across ranges.

**Multi-scene sequencing & transitions** are implemented through one
`renderComposited` function shared by preview and export; see
[determinism.md](./determinism.md#multi-scene-sequencing--transitions) for the
overlap model and the composite-path determinism rules.

## Authoring model

The toolkit ships pre-built with the app (`@kookaburra/toolkit`). Every scene is a
`defineScene` default export; scenes animate only via toolkit primitives or the
`useTimeline` value, read tokens via `useTheme`, lay out against `useFormat`, and
reference assets by relative path. The full rules and the primitive reference live
in the `kookaburra-scene-authoring` skill (`.claude/skills/`); `/new-scene`
scaffolds one. Representative primitives: `AnimatedHeadline`, `AnimatedCounter`,
`ImageCard`, `AnimatedGroup`, `VideoClip`, `Device`, `SceneStage` (staging:
floors, backdrops, fixed backgrounds), plus the generative 3D set
(`ExtrudedText`, `ParticleField`, `WireGrid`, `Ribbon`, `HeroObject`).

Themes are JSON documents (bundled with the app, or workspace-shared user
themes) declaring colours, typography, lighting, staging and text-animation
defaults; a scene's sidecar can swap the theme per scene. Design tokens for
scenes live behind `useTheme()`. (The *application chrome* has its own separate
design language; see [design.md](./design.md).)

## Scorecards

**Render strategy** (weighted toward determinism, WKWebView support, ergonomics):

| Strategy | Determinism in WKWebView | Text fidelity | 3D fit | Verdict |
| --- | --- | --- | --- | --- |
| Canvas-unified WebGL | Excellent (one synchronous surface) | Good (troika SDF) | Native | **WINNER** |
| Headless render-per-frame | n/a (the Remotion pattern; excluded) | High | Good | Excluded |
| Hybrid DOM + WebGL layers | Fails (WebKit taints canvas; async DOM races) | Excellent | Native | Rejected |

**Encoder:**

| Option | ProRes | 4K H.264 control | Speed on Apple Silicon | Verdict |
| --- | --- | --- | --- | --- |
| ffmpeg sidecar | Yes (`prores_ks`) | Full (CRF, colour flags) | Hardware via VideoToolbox | **WINNER** |
| WebCodecs VideoEncoder | No | Limited | Hardware | Rejected (no ProRes) |
| ffmpeg.wasm | Yes but slow | Yes | No HW accel | Rejected (speed) |

**Animation / timeline engine** (permissive only; GSAP and Theatre.js excluded by policy):

| Option | Licence | Deterministic seek | Timeline + stagger | Verdict |
| --- | --- | --- | --- | --- |
| anime.js v4 | MIT | Yes (`seek(t)`, manual tick) | Yes | **WINNER** |
| Motion (ex-Framer Motion) | MIT | Weak (rAF/spring oriented) | Partial | Runner-up |
| Web Animations API | n/a | Yes (`currentTime`) | Manual | Fallback primitive |
| d3-ease / d3-interpolate | ISC | Yes (pure functions) | None | Low-level helpers |

anime.js v4 explicitly supports disabling its main loop
(`engine.useDefaultMainLoop = false`) and absolute seeking: exactly what a
frame-accurate exporter needs. In practice the shipped primitives are pure
functions of the timeline value (they compute their state in render), so seeking
the clock plus one React commit *is* the scene state; deterministic in-house
keyframe/ease helpers cover everything tween-shaped.

## Embedded video clips

Frame-accurate `HTMLVideoElement` seeking is unreliable, so the default is
**pre-extraction**: before rendering, the ffmpeg sidecar extracts each clip to a
deterministic constant-frame-rate image sequence; the `VideoClip` primitive
samples a frame index as a pure function of the clock and binds that frame as a
texture. Fully deterministic, accepts anything ffmpeg can read. (An in-memory
WebCodecs decode path remains a possible later optimisation.)

## 3D & devices

r3f with `frameloop="never"` and `advance(t)` for deterministic stepping;
`@react-three/postprocessing` applies inside the same render so effects are
captured; `gl={{ preserveDrawingBuffer: true }}` so readback after render is
valid.

The device pillar uses a real glTF handset with the screen as a material whose
map is the pre-extracted clip texture. The catalogue uses real product names
with an accurately modelled, **licensed** vendor asset (a deliberate product
decision); the model file itself is not committed; it lives in a gitignored
folder (`src/assets/models/licensed/`) and is bundled into app builds only.
Colour variants are material-value overrides on the one glb.

The 3D authoring surface is four primitive families: `ExtrudedText`
(FontLoader/TextGeometry over a bundled typeface JSON), generative shapes
(`ParticleField` · `WireGrid` · `Ribbon`, seeded via `engine/rng.ts`),
`HeroObject` (name-keyed bundled glTF on a lit set), and `Device` /
`DeviceMockup`. Lit primitives bundle a shared `LightRig` (opt-out
`lit={false}`); every family exposes a `preloadX()` barrier awaited in the
export preamble. Determinism mechanics:
[determinism.md](./determinism.md#generative-3d-primitives).

## Packaging & performance

The app ships as a packaged Tauri `.app` (Developer ID signed, hardened
runtime, notarised) for personal distribution. For development, `tauri dev`
with Vite HMR is the working mode. The app and the bundled ffmpeg/ffprobe
sidecars are signed and stapled together or Gatekeeper blocks them.

Three scripts own the release, and the split between them is deliberate.
`tauri build` does the **signing** only: it walks the bundle and signs the
sidecars and nested code in the right inside-out order, which is the fiddly part.
`scripts/sign-and-notarize.sh` does **all** the notarising, because Tauri's
built-in notarisation cannot use a notarytool keychain profile and never
notarises the DMG, only the `.app`. `scripts/make-dmg.sh` builds the installer
itself (`bundle.targets` is `["app"]`) because Tauri's DMG bundler accepts only a
png/jpg/gif background (no multi-resolution TIFF, so the artwork is blurry on
Retina) and cannot set a volume icon. `scripts/release.sh` chains the lot behind
the usual guards and cuts a draft GitHub release. Both artefacts land in
`release/` (not `dist/`: that is Vite's output, and `vite build` empties it).

Two traps are worth naming, since both produce a build that signs and notarises
happily and then misbehaves on someone else's Mac. `pnpm setup:ffmpeg` provisions
a **dev** sidecar by copying the system ffmpeg, which links Homebrew dylibs that
do not exist elsewhere; releases need `pnpm setup:ffmpeg:release` (the pinned
static build), and `sign-and-notarize.sh` refuses to proceed unless `otool -L`
shows system libraries only. And deletes must route through
`workspace::trash_path`: the `trash` crate's default macOS backend drives Finder
over `osascript`, TCC attributes that Apple Event to us, and under the hardened
runtime it is silently denied, so every delete fails in a packaged build while
working fine in dev.

**Encoder default vs licensing.** `libx264` is the default because it is
deterministic; it makes the ffmpeg binary GPL. `h264_videotoolbox` is LGPL and
hardware-accelerated but its bit-exactness is machine/OS-version dependent. Any
future public binary release would ship an LGPL VideoToolbox build (a recorded
build flag); see [decisions.md](./decisions.md#licensing-posture).

**4K performance.** Offline export, not real-time: per-frame cost is dominated by
`gl.readPixels` sync plus encode. Stream the ~33 MB frames, never store the
sequence; keep one reusable readback buffer; render each aspect as a separate
pass. 30fps export presets step the render clock at 30fps directly, halving
their render time.

## Implementation notes (current)

Where the live Tauri-2 setup matters for working in the code:

1. **Sidecar permission.** In Tauri 2, `bundle.externalBin` stays in
   `tauri.conf.json`; a sidecar permission would normally be a `shell:allow-execute`
   entry with `"sidecar": true` in `capabilities/default.json`. **Kookaburra Cut needs
   none**: it spawns the sidecars from Rust (`app.shell().sidecar("ffmpeg")`),
   which bypasses the webview shell ACL, so `capabilities/default.json` carries
   only fs scopes. (Custom `#[tauri::command]`s like `start_export`/`push_frame`
   are likewise un-gated by the ACL; only plugin/core commands need permissions.)
2. **Sidecar runtime name is the basename.** Spawn with
   `app.shell().sidecar("ffmpeg")`, *not* `"bin/ffmpeg"`. Tauri copies the dev
   binary to `target/debug/ffmpeg`, stripping both the `bin/` prefix (from
   `externalBin`) and the `-<triple>` suffix; the shell plugin resolves a sidecar
   as `exe_dir.join(name)`. Passing `"bin/ffmpeg"` fails with ENOENT. Run
   `pnpm setup:ffmpeg` first.
3. **Raw frames use `InvokeBody::Raw`,** not a `Channel`. `push_frame(request:
   tauri::ipc::Request)` reads `request.body()` as `InvokeBody::Raw(bytes)`
   (zero-copy). A `tauri::ipc::Channel<&[u8]>` is for Rust→JS streaming (the
   embedded terminal uses one for PTY bytes).
4. **argv is built in Rust** from a typed `ExportOptions`; the frontend never
   controls it. `shell().sidecar(...).spawn()` does not consult the capability
   scope, which also resolves the permissive-allowlist concern.
5. **Tauri-2 entry split:** `lib.rs` holds `run()` (with
   `#[cfg_attr(mobile, tauri::mobile_entry_point)]`); `main.rs` is a thin shim
   calling `kookaburra_cut_lib::run()`. Plugins register in `lib.rs`.
6. **Build config:** Vite 8 transforms/minifies with **Oxc** (`build.minify:
   "oxc"`, never `"esbuild"`); `@vitejs/plugin-react@6`; `build.target:
   "safari26"` (the macOS-26 WKWebView floor).
7. **Rust target:** `aarch64-apple-darwin` is the host default: `rustup default
   stable` suffices, no `rustup target add`.
8. **Icon / identity refresh in dev.** Tauri's build script embeds the icon set
   and the `Info.plist` (app name) into the dev binary at **compile time** and
   does not re-run when `src-tauri/icons/` changes, so `pnpm tauri dev` keeps
   showing the old icon/name until the shell recompiles. `pnpm setup:icon`
   regenerates icons from the Icon Composer master and cleans the shell;
   `pnpm clean:shell` cleans manually (e.g. after identity edits in
   `tauri.conf.json`); the next `pnpm tauri dev` recompiles and re-embeds. If
   the Dock still shows the old icon after that, it's macOS's own icon cache:
   `killall Dock`. The icon master is the Icon Composer 1024px export, used
   verbatim: never re-mask it (see `scripts/make-icons.sh`).

`src-tauri/tauri.conf.json` sidecar wiring (Tauri 2, no `plugins.shell.sidecar`
block; the permission is handled Rust-side per note 1):

```json
{ "bundle": { "externalBin": ["bin/ffmpeg", "bin/ffprobe"] } }
```

## How it grew

Development was staged to de-risk the hardest path (deterministic 4K export)
first: text-only export, then multi-scene sequencing and transitions, embedded
video, 3D and postprocessing, packaging, the studio workspace (embedded
terminal, media library, video editor), devices and per-scene cameras, themes
and staging, runtime scene compilation for the packaged app, the transition and
audio pack, backgrounds and text motion, export presets, and the main-window
redesign and identity. Every stage landed behind the same gate: byte-identical
Verify ×2, with legacy projects proven EQUAL. The decision record from all of
that lives in [decisions.md](./decisions.md).

If byte-identical re-export ever fails, stop and fix determinism (usually a
preload/barrier issue) before adding features. If 4K export time is
unacceptable, profile readback vs IPC vs encode before any architectural change.
A Chromium-headless sidecar (not Electron) is the documented contingency if a
future WKWebView regression broke WebGL readback or clip decode, not the plan.
