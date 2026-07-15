/** The gated postprocessing wrapper: a single module-level EffectComposer is the final output stage of the compositor whenever the loaded project declares any effect; a project with no effects never touches this file and keeps the original byte-identical render paths. Determinism rules (see docs/determinism.md): `composer.render(0)` uses a fixed delta every frame so the injected `time` uniform never advances (every effect uniform is CPU-written from resolved params + frame seed); MSAA applies only to the composer's input buffer, resolved by fixed-function blit before the effect passes, with one ACES tone-map and one sRGB encode via the final ToneMappingEffect; the effect set is the project-wide union built once so no mid-project shader recompiles, only uniforms change; and only allow-listed, time-free effects are built, never the stock time-seeded NoiseEffect/GlitchEffect. All four starter effects are wired (Bloom, Vignette, film Grain, colour-grade LUT); the LUT applies after tone-mapping in the same EffectPass, and mid-project LUT swaps write the `lut` uniform directly rather than through the public setter (which would recompile the pass), valid only because every LUT in a project shares one LUT_3D_SIZE (enforced in preloadEffectLuts). */
import {
  BlendFunction,
  BloomEffect,
  EffectComposer,
  EffectPass,
  LUT3DEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from "postprocessing";
import {
  Camera,
  ClampToEdgeWrapping,
  Data3DTexture,
  HalfFloatType,
  LinearFilter,
  NoToneMapping,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Vector2,
  type WebGLRenderer,
} from "three";
import type { EffectsConfig, EffectsOverride } from "../theme/tokens";
import { DeterministicGrainEffect } from "./DeterministicGrainEffect";
import { blendEffectParams, resolveEffectParams, sceneBaseEffects } from "./effectParams";
import { useEffectsStore } from "./effectsStore";
import { MSAA_SAMPLES } from "./format";
import { type CubeLut, parseCubeLut } from "./lutCube";
import type { Resolved } from "./sceneTimeline";

/** Effect keys that are actually wired into the chain (all four starter effects as of cut 2). */
const WIRED_EFFECTS = new Set(["bloom", "vignette", "grain", "lut"]);

interface ComposerState {
  composer: EffectComposer;
  renderPass: RenderPass;
  /** Persistent-layer overlay pass, disabled except on transition frames. */
  overlayPass: RenderPass;
  bloom: BloomEffect | null;
  vignette: VignetteEffect | null;
  grain: DeterministicGrainEffect | null;
  lut: LUT3DEffect | null;
  size: Vector2;
  key: string;
}

let composerState: ComposerState | null = null;
const _size = new Vector2();

// 3D LUT assets: project-relative `.cube` files under projects/<project>/assets/, imported as raw text; project manifests reference them relatively, loadProject resolves each `lut.url` to its glob key here so this module never needs a project id, and parsing is pure with textures cached by url so two Verify runs sample the identical texture object. See docs/determinism.md.
const cubeGlob = import.meta.glob<string>("/projects/*/assets/**/*.cube", {
  query: "?raw",
  import: "default",
});

/** In-flight/settled loads by resolved url, dedupes concurrent preloads (StrictMode double-fire). */
const lutLoads = new Map<string, Promise<Data3DTexture>>();
/** Ready textures by resolved url, for synchronous per-frame lookup in applyEffectUniforms. */
const lutTextures = new Map<string, Data3DTexture>();

/** Every LUT url the project could bind, in stable resolution order (project default first, then per-scene overrides by ascending scene index); the first entry seeds the composer's LUT3DEffect. */
function collectLutUrls(
  projectDefault: EffectsConfig,
  overrides: Record<number, EffectsOverride>,
  sceneDefaults: Record<number, EffectsConfig> = {},
): string[] {
  const urls: string[] = [];
  const push = (u: string | undefined) => {
    if (u && !urls.includes(u)) urls.push(u);
  };
  push(projectDefault.lut?.url);
  for (const idx of Object.keys(sceneDefaults)
    .map(Number)
    .sort((a, b) => a - b)) {
    push(sceneDefaults[idx].lut?.url);
  }
  for (const idx of Object.keys(overrides)
    .map(Number)
    .sort((a, b) => a - b)) {
    push(overrides[idx].lut?.url);
  }
  return urls;
}

/** Builds the GPU-ready 3D texture for a parsed LUT: 8-bit RGBA (linear filtering is guaranteed for UNSIGNED_BYTE everywhere, unlike float, and <=1 LSB from a float LUT in 8-bit output), LinearFilter, no mipmaps, clamped, for deterministic hardware trilinear sampling. */
function buildLutTexture(lut: CubeLut): Data3DTexture {
  const bytes = new Uint8Array(lut.data.length);
  for (let i = 0; i < lut.data.length; i++) {
    bytes[i] = Math.round(Math.min(1, Math.max(0, lut.data[i])) * 255);
  }
  const tex = new Data3DTexture(bytes, lut.size, lut.size, lut.size);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.wrapR = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function loadLut(url: string): Promise<Data3DTexture> {
  const inFlight = lutLoads.get(url);
  if (inFlight) return inFlight;
  const load = (async () => {
    const tex = buildLutTexture(parseCubeLut(await loadCubeText(url)));
    lutTextures.set(url, tex);
    return tex;
  })();
  lutLoads.set(url, load);
  return load;
}

/** Fetches a `.cube` file's text: bundled projects come through the eager raw-text glob; workspace projects (urls resolved by loadProject to asset-protocol URLs) are fetched, which the caching-by-url above makes just as deterministic (both Verify runs sample one texture). */
async function loadCubeText(url: string): Promise<string> {
  const importCube = cubeGlob[url];
  if (importCube) return importCube();
  // A scheme-qualified URL is a workspace asset (asset protocol); bare non-glob paths are authoring mistakes.
  if (url.includes("://")) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`LUT asset failed to load (${res.status}) from ${url}`);
    return res.text();
  }
  throw new Error(
    `LUT asset not found (looked for ${url}). Put a .cube file under ` +
      "projects/<project>/assets/ and reference it project-relative in project.json.",
  );
}

/** The union of effect keys the loaded project could use (project default + every per-scene override), intersected with what's wired; stable for the whole project, so the composer builds its chain once. */
function projectEffectKeys(): Set<string> {
  const { projectDefault, overrides, sceneDefaults } = useEffectsStore.getState();
  const keys = new Set<string>(Object.keys(projectDefault));
  for (const ov of Object.values(overrides)) {
    for (const k of Object.keys(ov)) keys.add(k);
  }
  for (const base of Object.values(sceneDefaults)) {
    for (const k of Object.keys(base)) keys.add(k);
  }
  return new Set([...keys].filter((k) => WIRED_EFFECTS.has(k)));
}

/** Resolves the effect stack for the frame, or `null` if the project declares no effects at all (the compositor keeps its byte-identical composer-free paths); a project that declares any effect returns non-null for every frame, even a scene with no params returns `{}`, so tone-mapping is uniform project-wide (three's ACES and postprocessing's ACES aren't bit-identical, so they're never mixed). */
export function resolveFrameEffects(resolved: Resolved): EffectsConfig | null {
  const { projectDefault, overrides, sceneDefaults } = useEffectsStore.getState();
  const anySceneEffects = Object.values(sceneDefaults).some((b) => Object.keys(b).length > 0);
  if (
    Object.keys(projectDefault).length === 0 &&
    Object.keys(overrides).length === 0 &&
    !anySceneEffects
  ) {
    return null;
  }
  if (resolved.active.length === 0) return null;

  const tr = resolved.transition;
  if (tr) {
    const a = resolveEffectParams(
      sceneBaseEffects(projectDefault, sceneDefaults, tr.fromIndex),
      overrides[tr.fromIndex],
    );
    const b = resolveEffectParams(
      sceneBaseEffects(projectDefault, sceneDefaults, tr.toIndex),
      overrides[tr.toIndex],
    );
    return blendEffectParams(a, b, tr.progress);
  }
  const idx = resolved.active[resolved.active.length - 1].index;
  return resolveEffectParams(sceneBaseEffects(projectDefault, sceneDefaults, idx), overrides[idx]);
}

/** Lazily builds (and resizes/rebuilds, disposing the old) the composer for the project's effect set at the live drawing-buffer size; the RenderPass's scene/camera are set per-frame by the caller. */
export function ensureComposer(gl: WebGLRenderer, w: number, h: number): ComposerState {
  const keys = projectEffectKeys();
  const { projectDefault, overrides, sceneDefaults } = useEffectsStore.getState();
  // The LUT urls are part of the cache key: the compiled shader bakes the LUT's size into defines, so a project swap to a different LUT set must rebuild the chain (mid-project swaps within one project are uniform-only, the url set is project-stable).
  const lutUrls = keys.has("lut") ? collectLutUrls(projectDefault, overrides, sceneDefaults) : [];
  const key = [...keys].sort().join(",") + (lutUrls.length ? `|${lutUrls.join("|")}` : "");
  if (
    composerState &&
    composerState.size.x === w &&
    composerState.size.y === h &&
    composerState.key === key
  ) {
    return composerState;
  }
  if (composerState) composerState.composer.dispose();

  // multisampling: MSAA on the composer's input buffer, the scene RenderPass and the persistent-layer overlay pass render into it; postprocessing resolves before the effect passes run (fullscreen quads, MSAA irrelevant to them). Half-float MSAA renderbuffers are Metal-native, clamped to capabilities.maxSamples.
  const composer = new EffectComposer(gl, {
    frameBufferType: HalfFloatType,
    multisampling: MSAA_SAMPLES,
  });
  // Re-asserts pass/buffer sizes at the renderer's current logical size (a no-op resize, since the composer only calls renderer.setSize when given a differing size); passing the drawing-buffer size here is a trap, since EffectComposer.setSize would forward a differing size to renderer.setSize, and on a retina display (pixelRatio 2) that doubles the canvas every preview frame until the screen goes blank (the export loop is immune only because it pins pixelRatio to 1; `w`/`h` remain the rebuild-on-resize cache key).
  const logical = gl.getSize(new Vector2());
  composer.setSize(logical.x, logical.y, false);

  // Placeholder scene/camera, overwritten every frame via composer.setMainScene/Camera.
  const renderPass = new RenderPass(new Scene(), new Camera());
  composer.addPass(renderPass);

  // Persistent-layer overlay: on transition frames the main pass renders the composite quad, so a project's persistent (morph) objects would miss the effect chain if drawn after it; this pass layers them into the same input buffer before the effects (colour kept via depth-only clear, background ignored) so the morph is graded like everything else. Disabled here; renderThroughComposer enables it per frame as a pure function of the resolved transition, and it's always constructed (a disabled pass renders nothing) so the chain stays project-stable.
  const overlayPass = new RenderPass(new Scene(), new Camera());
  overlayPass.clearPass.setClearFlags(false, true, false);
  overlayPass.ignoreBackground = true;
  overlayPass.enabled = false;
  composer.addPass(overlayPass);

  const bloom = keys.has("bloom") ? new BloomEffect({ mipmapBlur: true }) : null;
  const vignette = keys.has("vignette") ? new VignetteEffect() : null;
  const grain = keys.has("grain") ? new DeterministicGrainEffect() : null;
  // ToneMapping owns the single ACES tone-map; the pass's one sRGB encode still happens at output.
  const tonemap = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
  // The colour-grade LUT comes after tone-mapping (LDR `.cube` grades are authored for tone-mapped input; postprocessing feeds it sRGB via its inputColorSpace and converts back); BlendFunction.NORMAL so `intensity` drives blendMode.opacity, a uniform not a recompile; seeded with the first LUT url's texture, applyEffectUniforms binds the frame's actual LUT.
  let lut: LUT3DEffect | null = null;
  if (lutUrls.length > 0) {
    const seedTex = lutTextures.get(lutUrls[0]);
    if (!seedTex) {
      throw new Error(
        `LUT texture for ${lutUrls[0]} is not loaded — await preloadEffectLuts() before ` +
          "rendering an effects project (the export preamble and the project loader both do).",
      );
    }
    lut = new LUT3DEffect(seedTex, { blendFunction: BlendFunction.NORMAL });
  }
  const chain = [bloom, vignette, grain, tonemap, lut].filter(
    (e): e is NonNullable<typeof e> => e !== null,
  );
  composer.addPass(new EffectPass(undefined, ...chain));

  composerState = {
    composer,
    renderPass,
    overlayPass,
    bloom,
    vignette,
    grain,
    lut,
    size: new Vector2(w, h),
    key,
  };
  return composerState;
}

/** CPU-write every effect uniform from the resolved params + frame seed. Effects off → amount 0. */
function applyEffectUniforms(cs: ComposerState, cfg: EffectsConfig, seed: number): void {
  if (cs.bloom) {
    cs.bloom.intensity = cfg.bloom?.intensity ?? 0;
    if (cfg.bloom) {
      cs.bloom.luminanceMaterial.threshold = cfg.bloom.luminanceThreshold;
      cs.bloom.luminanceMaterial.smoothing = cfg.bloom.luminanceSmoothing;
    }
  }
  if (cs.vignette) {
    cs.vignette.offset = cfg.vignette?.offset ?? 0.5;
    cs.vignette.darkness = cfg.vignette?.darkness ?? 0; // 0 = no vignette
  }
  if (cs.grain) {
    cs.grain.seed = seed;
    cs.grain.intensity = cfg.grain?.intensity ?? 0; // 0 = no grain
  }
  if (cs.lut) {
    const url = cfg.lut?.url;
    const tex = url ? lutTextures.get(url) : undefined;
    // No LUT bound this frame (or its texture missing) → opacity 0 = pass-through.
    cs.lut.blendMode.opacity.value = tex ? (cfg.lut?.intensity ?? 0) : 0;
    const lutUniform = cs.lut.uniforms.get("lut");
    if (tex && lutUniform && lutUniform.value !== tex) {
      // Direct uniform write, the public `lut` setter would recompile the pass mid-project; safe because preloadEffectLuts enforces one LUT_3D_SIZE per project (the defines hold).
      lutUniform.value = tex;
    }
  }
}

/** Renders `mainScene`/`mainCamera` through the effect chain to the default framebuffer (the final pass renders to screen, so `readPixels` reads the graded frame); tone-mapping is disabled on the renderer during the pass so the scene reaches the composer in linear and ACES is applied exactly once by the chain, and renderer flags touched are snapshotted and restored. `overlay` (transition frames only) is the persistent-layer scene+camera to layer into the input buffer after the main render, pre-effects; the caller owns visibility before invoking, and autoClear is forced off for the overlaid render since three would otherwise clear the input buffer's colour before drawing the overlay, wiping the composite. */
export function renderThroughComposer(
  gl: WebGLRenderer,
  cs: ComposerState,
  mainScene: Scene,
  mainCamera: Camera,
  cfg: EffectsConfig,
  seed: number,
  overlay?: { scene: Scene; camera: Camera },
): void {
  const prevTone = gl.toneMapping;
  const prevTarget = gl.getRenderTarget();
  const prevAutoClear = gl.autoClear;
  gl.toneMapping = NoToneMapping;
  // setMainScene/Camera write every pass (including the overlay pass); order matters, the overlay pass is re-pointed at the real scene/camera after.
  cs.composer.setMainScene(mainScene);
  cs.composer.setMainCamera(mainCamera);
  cs.overlayPass.enabled = overlay !== undefined;
  if (overlay) {
    cs.overlayPass.mainScene = overlay.scene;
    cs.overlayPass.mainCamera = overlay.camera;
    gl.autoClear = false;
  }
  applyEffectUniforms(cs, cfg, seed);
  cs.composer.render(0); // fixed delta, the injected `time` uniform never advances
  gl.toneMapping = prevTone;
  gl.autoClear = prevAutoClear;
  gl.setRenderTarget(prevTarget);
}

/** Drawing-buffer size helper for callers that need the composer size before `ensureComposer`. */
export function drawingBufferSize(gl: WebGLRenderer): Vector2 {
  return gl.getDrawingBufferSize(_size);
}

/** Loads + parses every LUT the project could bind (project default + per-scene overrides) before frame 0, mirroring preloadDeviceModels/preloadProjectImages, since the capture loop must never race an async effect-asset decode and a mid-run swap must find its texture already cached. The project loader awaits this before publishing effects to the store so the composer chain never builds against a missing texture; the export preamble awaits it again (a cached no-op) with `gl` so every texture is uploaded before frame 0, never a lazy first-use upload mid-run. See docs/determinism.md. Enforces that all of a project's LUTs share one LUT_3D_SIZE, since mid-project swaps write the `lut` uniform directly, so the pass's compiled size defines must fit every texture. */
export async function preloadEffectLuts(opts?: {
  /** When given, force-uploads each LUT texture to the GPU (export preamble). */
  gl?: WebGLRenderer;
  /** Effect config to scan; defaults to the effects store (export path). */
  effects?: EffectsConfig;
  overrides?: Record<number, EffectsOverride>;
  /** Per-scene theme-swap base stacks, see effectsStore. */
  sceneDefaults?: Record<number, EffectsConfig>;
}): Promise<void> {
  const store = useEffectsStore.getState();
  const urls = collectLutUrls(
    opts?.effects ?? store.projectDefault,
    opts?.overrides ?? store.overrides,
    opts?.sceneDefaults ?? store.sceneDefaults,
  );
  if (urls.length === 0) return;
  const textures = await Promise.all(urls.map(loadLut));
  const sizes = new Set(textures.map((t) => t.image.width));
  if (sizes.size > 1) {
    throw new Error(
      `A project's LUTs must all share one LUT_3D_SIZE (got ${[...sizes].join(", ")} across ` +
        `${urls.join(", ")}) — mid-project swaps reuse one compiled shader. Re-export at one size.`,
    );
  }
  if (opts?.gl) {
    for (const tex of textures) opts.gl.initTexture(tex);
  }
}
