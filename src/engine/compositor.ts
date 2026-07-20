import type { Group, PerspectiveCamera } from "three";
import {
  Camera,
  ClampToEdgeWrapping,
  Color,
  GLSL3,
  HalfFloatType,
  LinearSRGBColorSpace,
  Mesh,
  NearestFilter,
  NoToneMapping,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { cutoutPixelRect, type FrameLayout, frameLayout } from "../toolkit/frame/frameLayout";
import { applyCameraPose } from "./cameraTrack";
import { useClockStore } from "./clock";
import { grainSeed } from "./effectParams";
import {
  drawingBufferSize,
  ensureComposer,
  renderThroughComposer,
  resolveFrameEffects,
} from "./effects";
import { getLoadedEnvironment } from "./environments";
import { FPS, MSAA_SAMPLES } from "./format";
import { getFramePanels } from "./framePanelRegistry";
import type { ResolvedOverlay } from "./overlayPlan";
import {
  CUTOUT_MODE_BOX,
  CUTOUT_MODE_SUPERELLIPSE,
  overlayFragmentShader,
  overlayVertexShader,
} from "./overlayShader";
import { getPersistentLayers } from "./persistentLayerRegistry";
import type { FrameCameraPlan } from "./sceneCamera";
import type { SceneHostHandle } from "./sceneHostRegistry";
import {
  applySceneRenderState,
  type FrameSceneStatePlan,
  type SceneRenderState,
  type SharedEnvironmentSnapshot,
} from "./sceneState";
import type { Resolved, ResolvedTransition } from "./sceneTimeline";
import {
  EXT2_MIN_TYPE,
  EXTENDED_MIN_TYPE,
  fragmentShader,
  fragmentShaderExt,
  fragmentShaderExt2,
  fragmentShaderExt2Hdr,
  fragmentShaderExtHdr,
  fragmentShaderHdr,
  SHAPE_ID,
  TYPE_ID,
  vertexShader,
  vertexShader300,
} from "./transitionShader";

/** Renders the active scene(s) for one frame, applying any cross-scene transition; one function called by both preview and export so they cannot drift. Fast path (one scene, no transition): direct `gl.render` to the default framebuffer, byte-identical to v0 (never routed through render targets, which would change the bytes). Transition path (two scenes): each renders to its own `WebGLRenderTarget` (no-fx: sRGB 8-bit, tone-mapped once; fx: HalfFloat linear, un-tone-mapped for the composer), then a fullscreen pass composites them in the display domain. All touched renderer state is snapshotted and restored. See docs/determinism.md. */

interface CompositorState {
  targetA: WebGLRenderTarget;
  targetB: WebGLRenderTarget;
  /** HDR (HalfFloat/linear) A/B pair for the fx path, allocated lazily on the first fx transition frame, disposed and nulled on resize alongside the SDR pair. */
  targetAHdr: WebGLRenderTarget | null;
  targetBHdr: WebGLRenderTarget | null;
  size: Vector2;
  quadScene: Scene;
  quadCamera: Camera;
  /** Display-domain composite over the SDR targets (renders straight to screen). */
  material: ShaderMaterial;
  /** HDR composite over the HalfFloat targets, used only when feeding the effect composer. */
  materialHdr: ShaderMaterial;
  /** Extended-pack (types 4-9, GLSL3) variants of the two above; separate materials so adding a type never recompiles the legacy GLSL1 programs. */
  materialExt: ShaderMaterial;
  materialExtHdr: ShaderMaterial;
  /** v14 pack (types 10-12, GLSL3), its own generation for the same reason. */
  materialExt2: ShaderMaterial;
  materialExt2Hdr: ShaderMaterial;
  /** The fullscreen quad, so the compositor can swap its material per frame. */
  mesh: Mesh;
  /** Overlay ("frame") compositing: the scene renders here at the cutout aspect, sized lazily to the cutout's pixel rect (null until the first framed scene). */
  sceneTarget: WebGLRenderTarget | null;
  /** The overlay slide pass (panel + scene keyed through the cutout SDF); its own quad so it never touches the transition mesh's material. */
  slideScene: Scene;
  slideMaterial: ShaderMaterial;
}

let state: CompositorState | null = null;
const _size = new Vector2();
const _dip = new Color();

function makeTarget(w: number, h: number, hdr: boolean): WebGLRenderTarget {
  const t = new WebGLRenderTarget(w, h, {
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    format: RGBAFormat,
    // SDR (no-fx): UnsignedByteType + SRGBColorSpace allocates hardware SRGB8_ALPHA8 (tone-mapped bytes, hardware-decoded to linear on sample); HDR (fx): RGBA16F linear so the un-tone-mapped scene survives to the composer, since 8-bit fx targets used to clamp >1.0 linear before the composer's ACES (the highlight dim). Half-float MSAA matches the effect composer's proven configuration (effects.ts).
    type: hdr ? HalfFloatType : UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    // MSAA: the A/B scene renders sample at MSAA_SAMPLES and three resolves via blitFramebuffer when the composite samples the texture; the resolve is fixed-function, so it's same-machine deterministic, gated by Verify ×2 like everything else, and matches the context's own antialiasing so transition frames keep the solo frames' edge quality.
    samples: MSAA_SAMPLES,
  });
  t.texture.colorSpace = hdr ? LinearSRGBColorSpace : SRGBColorSpace;
  t.texture.wrapS = ClampToEdgeWrapping;
  t.texture.wrapT = ClampToEdgeWrapping;
  return t;
}

/** Builds a composite ShaderMaterial with the given fragment; one shared uniform set for all four variants (legacy shaders simply don't declare the extended-pack names, three only uploads declared uniforms), and `glsl3` switches to the 300-es vertex pass for the extended pack (integer hashing needs uints). */
function makeCompositeMaterial(fragment: string, glsl3 = false): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      texA: { value: null },
      texB: { value: null },
      progress: { value: 0 },
      type: { value: 0 },
      direction: { value: new Vector2(1, 0) },
      dipColor: { value: new Vector3(0, 0, 0) },
      aspect: { value: 1 },
      intensity: { value: 0 },
      softness: { value: 0.08 },
      center: { value: new Vector2(0.5, 0.5) },
      blocks: { value: new Vector2(24, 14) },
      shape: { value: 0 },
      steps: { value: 12 },
      parallax: { value: 0.5 },
    },
    vertexShader: glsl3 ? vertexShader300 : vertexShader,
    fragmentShader: fragment,
    glslVersion: glsl3 ? GLSL3 : null,
    depthTest: false,
    depthWrite: false,
  });
}

/** The overlay slide material: keys the scene target through the cutout SDF, fills the rest with the panel colour. Display-domain GLSL1, same semantics as the legacy transition composite. */
function makeSlideMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      sceneTex: { value: null },
      panelColor: { value: new Vector3(0, 0, 0) },
      cutoutRect: { value: new Vector4(0, 0, 1, 1) },
      cutoutCenter: { value: new Vector2(0.5, 0.5) },
      cutoutHalf: { value: new Vector2(0.5, 0.5) },
      cutoutRadius: { value: 0 },
      cutoutExponent: { value: 4 },
      cutoutMode: { value: CUTOUT_MODE_BOX },
      aspect: { value: 1 },
      softness: { value: 0.001 },
    },
    vertexShader: overlayVertexShader,
    fragmentShader: overlayFragmentShader,
    depthTest: false,
    depthWrite: false,
  });
}

/** Set the composite uniforms on a material for a transition frame (any variant). */
function setCompositeUniforms(
  u: ShaderMaterial["uniforms"],
  tr: ResolvedTransition,
  scene: Scene,
  texA: WebGLRenderTarget["texture"],
  texB: WebGLRenderTarget["texture"],
  aspect: number,
): void {
  u.texA.value = texA;
  u.texB.value = texB;
  u.progress.value = tr.progress;
  u.type.value = TYPE_ID[tr.type];
  (u.direction.value as Vector2).set(tr.direction[0], tr.direction[1]);
  (u.dipColor.value as Vector3).copy(dipLinear(tr.color, scene));
  // Extended-pack params, resolved with defaults baked (sceneTimeline).
  const p = tr.params;
  u.aspect.value = aspect;
  u.intensity.value = p.intensity;
  u.softness.value = p.softness;
  (u.center.value as Vector2).set(p.center[0], p.center[1]);
  (u.blocks.value as Vector2).set(p.blocks[0], p.blocks[1]);
  u.shape.value = SHAPE_ID[p.shape];
  u.steps.value = p.steps;
  u.parallax.value = p.parallax;
}

/** Lazily allocate (and resize, disposing the old) targets to the live drawing-buffer size. */
function ensureState(w: number, h: number): CompositorState {
  if (state && state.size.x === w && state.size.y === h) return state;

  if (state) {
    state.targetA.dispose();
    state.targetB.dispose();
    state.targetA = makeTarget(w, h, false);
    state.targetB = makeTarget(w, h, false);
    state.targetAHdr?.dispose();
    state.targetBHdr?.dispose();
    state.targetAHdr = null; // re-allocated on the next fx transition frame
    state.targetBHdr = null;
    state.sceneTarget?.dispose();
    state.sceneTarget = null; // cutout-sized; re-allocated on the next framed scene
    state.size.set(w, h);
    return state;
  }

  const material = makeCompositeMaterial(fragmentShader);
  const materialHdr = makeCompositeMaterial(fragmentShaderHdr);
  const materialExt = makeCompositeMaterial(fragmentShaderExt, true);
  const materialExtHdr = makeCompositeMaterial(fragmentShaderExtHdr, true);
  const materialExt2 = makeCompositeMaterial(fragmentShaderExt2, true);
  const materialExt2Hdr = makeCompositeMaterial(fragmentShaderExt2Hdr, true);
  const quadScene = new Scene();
  const mesh = new Mesh(new PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  quadScene.add(mesh);

  const slideMaterial = makeSlideMaterial();
  const slideScene = new Scene();
  const slideMesh = new Mesh(new PlaneGeometry(2, 2), slideMaterial);
  slideMesh.frustumCulled = false;
  slideScene.add(slideMesh);

  state = {
    targetA: makeTarget(w, h, false),
    targetB: makeTarget(w, h, false),
    targetAHdr: null,
    targetBHdr: null,
    size: new Vector2(w, h),
    quadScene,
    quadCamera: new Camera(),
    material,
    materialHdr,
    materialExt,
    materialExtHdr,
    materialExt2,
    materialExt2Hdr,
    mesh,
    sceneTarget: null,
    slideScene,
    slideMaterial,
  };
  return state;
}

/** Allocate the fx-path HDR pair on first use (lazy, no-fx projects never pay for it). */
function ensureHdrTargets(st: CompositorState): void {
  if (!st.targetAHdr) st.targetAHdr = makeTarget(st.size.x, st.size.y, true);
  if (!st.targetBHdr) st.targetBHdr = makeTarget(st.size.x, st.size.y, true);
}

/** Diagnostic snapshot of the compositor's A/B target formats for the verify render-state fingerprint; target type/colorSpace is part of the transition contract, so a cross-build divergence should name itself in one JSON diff. */
export function compositorTargetFingerprint(): {
  sdr: string;
  hdr: string | null;
  samples: number;
} | null {
  if (!state) return null;
  const describe = (t: WebGLRenderTarget) => `${t.texture.type}/${t.texture.colorSpace}`;
  return {
    sdr: describe(state.targetA),
    hdr: state.targetAHdr ? describe(state.targetAHdr) : null,
    samples: state.targetA.samples,
  };
}

/** Resolve the dip colour to LINEAR: explicit sRGB hex, else the scene background. */
function dipLinear(hex: string | undefined, scene: Scene): Vector3 {
  if (hex) _dip.set(hex);
  else if (scene.background instanceof Color) _dip.copy(scene.background);
  else _dip.setRGB(0, 0, 0);
  return new Vector3(_dip.r, _dip.g, _dip.b);
}

/** Lazily (re)allocate the cutout-sized scene target. */
function ensureSceneTarget(st: CompositorState, w: number, h: number): WebGLRenderTarget {
  if (st.sceneTarget && st.sceneTarget.width === w && st.sceneTarget.height === h) {
    return st.sceneTarget;
  }
  st.sceneTarget?.dispose();
  st.sceneTarget = makeTarget(w, h, false);
  return st.sceneTarget;
}

/** Set the slide material's cutout uniforms from the layout + its pixel rect in the destination buffer. The uv rect is derived from the pixel rect (not the normalised layout) so the mask and the scene sampling stay pixel-aligned; `bufferH` sets a ~1px edge softness. */
function setSlideUniforms(
  st: CompositorState,
  overlay: ResolvedOverlay,
  layout: FrameLayout,
  px: { x: number; y: number; width: number; height: number },
  bufferW: number,
  bufferH: number,
): void {
  const u = st.slideMaterial.uniforms;
  const aspect = bufferW / bufferH;
  const uvX = px.x / bufferW;
  const uvW = px.width / bufferW;
  const uvH = px.height / bufferH;
  const uvY = 1 - (px.y + px.height) / bufferH; // pixel rect is y-down, uv is y-up
  u.sceneTex.value = st.sceneTarget?.texture ?? null;
  (u.panelColor.value as Vector3).set(...overlay.panelColor);
  (u.cutoutRect.value as Vector4).set(uvX, uvY, uvW, uvH);
  (u.cutoutCenter.value as Vector2).set((uvX + uvW / 2) * aspect, uvY + uvH / 2);
  (u.cutoutHalf.value as Vector2).set((uvW / 2) * aspect, uvH / 2);
  u.cutoutRadius.value = layout.radius;
  u.cutoutExponent.value = layout.exponent;
  u.cutoutMode.value =
    overlay.frame.cutout.shape === "squircle" ? CUTOUT_MODE_SUPERELLIPSE : CUTOUT_MODE_BOX;
  u.aspect.value = aspect;
  u.softness.value = 1 / bufferH;
}

/** Render one framed scene: the scene into the cutout target at the cutout aspect (FixedBackdrop tracks cam.aspect live, so it's set and restored around this render, symmetric within the call like every other state the compositor touches), then the slide pass keying it through the cutout into `dest`. */
function renderFramedScene(
  gl: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  st: CompositorState,
  overlay: ResolvedOverlay,
  bufferW: number,
  bufferH: number,
  dest: WebGLRenderTarget | null,
): void {
  const aspect = bufferW / bufferH;
  const layout = frameLayout(aspect, overlay.frame.cutout);
  const px = cutoutPixelRect(layout.cutout, bufferW, bufferH);

  const target = ensureSceneTarget(st, px.width, px.height);
  const cam = camera as PerspectiveCamera;
  const prevAspect = cam.isPerspectiveCamera ? cam.aspect : 0;
  if (cam.isPerspectiveCamera) {
    cam.aspect = px.width / px.height;
    cam.updateProjectionMatrix();
  }
  gl.setRenderTarget(target);
  gl.render(scene, camera);
  if (cam.isPerspectiveCamera) {
    cam.aspect = prevAspect;
    cam.updateProjectionMatrix();
  }

  setSlideUniforms(st, overlay, layout, px, bufferW, bufferH);
  gl.setRenderTarget(dest);
  gl.render(st.slideScene, st.quadCamera);
}

/** Draw one scene's overlay panel (title/subtitle/chip, full-frame world content) over the slide already in `dest`. Everything except the panel group is hidden, depth is cleared so the text z-tests cleanly, and the composite's colour is preserved (background nulled, colour never cleared), mirroring the persistent-layer overlay draw. The real (full-aspect) camera is used, restored by `renderFramedScene` before this runs. */
function drawFramePanelOver(
  gl: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  hosts: SceneHostHandle[],
  persistent: Group[],
  panel: Group,
  dest: WebGLRenderTarget | null,
): void {
  for (const h of hosts) h.group.visible = false;
  for (const g of persistent) g.visible = false;
  panel.visible = true;
  const prevAutoClear = gl.autoClear;
  const prevBackground = scene.background;
  scene.background = null;
  gl.autoClear = false;
  gl.setRenderTarget(dest);
  gl.clear(false, true, false);
  gl.render(scene, camera);
  scene.background = prevBackground;
  gl.autoClear = prevAutoClear;
  panel.visible = false;
}

/** `cameras` is the frame's per-scene camera plan, present only when the project has scene-doc camera tracks (solo/a/b/overlay applied per target, absent means the camera is never touched here); `states` is the analogous per-scene render-state plan (background, environment), whose values are always restored to the shared scene on return so root-scene state never leaks into the next-loaded project. `overlays` is the per-scene resolved overlay plan (panel colour), present only when some scene declares a frame; a scene with a null entry renders full-bleed on the legacy path. */
export function renderComposited(
  gl: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  hosts: SceneHostHandle[],
  resolved: Resolved,
  cameras?: FrameCameraPlan,
  states?: FrameSceneStatePlan,
  overlays?: readonly (ResolvedOverlay | null)[],
): void {
  // Snapshots the root-scene values the state plan owns, restored at every exit so root-scene state never leaks into the next-loaded project; the environment snapshot doubles as the explicit fallback for scenes whose theme declares none (legacy drei mounts keep working through it).
  const prevStateBackground = states ? scene.background : undefined;
  const sharedEnv: SharedEnvironmentSnapshot | null = states
    ? {
        environment: scene.environment,
        intensity: scene.environmentIntensity,
        rotationYRad: scene.environmentRotation.y,
      }
    : null;
  const applyState = (s: SceneRenderState) => {
    if (sharedEnv) applySceneRenderState(scene, s, sharedEnv, getLoadedEnvironment);
  };
  const restoreSceneState = () => {
    if (!sharedEnv) return;
    scene.background = prevStateBackground ?? null;
    scene.environment = sharedEnv.environment;
    scene.environmentIntensity = sharedEnv.intensity;
    scene.environmentRotation.set(0, sharedEnv.rotationYRad, 0);
  };

  const prevVisible = hosts.map((h) => h.group.visible);
  // Persistent (hoisted morph) layers; empty for every project without one.
  const persistent = getPersistentLayers();
  const prevPersistentVisible = persistent.map((g) => g.visible);
  // Overlay panels; empty for every project with no framed scene, so the panel pass is a hard no-op.
  const framePanels = getFramePanels();
  const prevFramePanelVisible = framePanels.map((p) => p.group.visible);
  const panelFor = (index: number): Group | null =>
    framePanels.find((p) => p.index === index)?.group ?? null;
  const showOnly = (idx: number) => {
    for (const h of hosts) h.group.visible = h.index === idx;
  };
  const restoreVisible = () => {
    hosts.forEach((h, i) => {
      h.group.visible = prevVisible[i];
    });
    persistent.forEach((g, i) => {
      g.visible = prevPersistentVisible[i];
    });
    framePanels.forEach((p, i) => {
      p.group.visible = prevFramePanelVisible[i];
    });
  };

  const tr = resolved.transition;
  const prevTarget = gl.getRenderTarget();

  // Resolves the frame's effect stack: `null` means the project declares no effects, so the original byte-identical paths below run unchanged; non-null routes through the gated composer.
  const fx = resolveFrameEffects(resolved);
  const seed = fx ? grainSeed(useClockStore.getState().currentMs, FPS) : 0;

  // Fast path: single active scene (or nothing) → direct render, v0-identical (or composer-graded).
  if (resolved.active.length < 2 || !tr) {
    const idx = resolved.active.length
      ? resolved.active[resolved.active.length - 1].index
      : (hosts[0]?.index ?? 0);
    showOnly(idx);
    if (cameras?.solo) applyCameraPose(camera as PerspectiveCamera, cameras.solo);
    if (states?.solo) applyState(states.solo);
    const overlay = overlays?.[idx] ?? null;
    if (overlay) {
      // Overlay path: the scene renders into its cutout, then the slide keys it in over the panel. Effects don't yet compose onto a framed scene (docs/overlays.md open question), so this branch is taken ahead of fx.
      const size = gl.getDrawingBufferSize(_size);
      const st = ensureState(size.x, size.y);
      renderFramedScene(gl, scene, camera, st, overlay, size.x, size.y, null);
      const panel = panelFor(idx);
      if (panel) drawFramePanelOver(gl, scene, camera, hosts, persistent, panel, null);
    } else if (fx) {
      const size = drawingBufferSize(gl);
      renderThroughComposer(gl, ensureComposer(gl, size.x, size.y), scene, camera, fx, seed);
    } else {
      gl.setRenderTarget(null);
      gl.render(scene, camera);
    }
    gl.setRenderTarget(prevTarget);
    restoreSceneState();
    restoreVisible();
    return;
  }

  // Transition path: render A and B to their targets, then composite to the default FB.
  const size = gl.getDrawingBufferSize(_size);
  const st = ensureState(size.x, size.y);
  const prevAutoClear = gl.autoClear;
  gl.autoClear = true;

  // Effects: the composer owns the project's single ACES tone-map, so scenes must reach the targets un-tone-mapped, otherwise transition frames get three's ACES here plus the composer's ACES (a double tone-map that pops at the seam); those un-tone-mapped HDR values need the HalfFloat/linear pair, since old 8-bit fx targets clamped >1.0 before the composer's ACES (the highlight dim). No effects: the r3f pipeline tone-maps here exactly once into the hardware-sRGB SDR pair.
  const prevToneMapping = gl.toneMapping;
  if (fx) {
    gl.toneMapping = NoToneMapping;
    ensureHdrTargets(st);
  }
  const tgtA = fx ? (st.targetAHdr as WebGLRenderTarget) : st.targetA;
  const tgtB = fx ? (st.targetBHdr as WebGLRenderTarget) : st.targetB;

  // Persistent layers must not bake into the A/B targets, they'd render into both and cross-fade against themselves (ghosting); hidden here, drawn exactly once over the composite below.
  for (const g of persistent) g.visible = false;

  // The whole slide (panel + cutout) goes into each target, so a transition crossfades framed slides exactly as it does full-bleed scenes. Overlays don't compose through the fx (HDR) targets yet, so a framed scene under effects falls back to the plain scene render here.
  const overlayA = !fx ? (overlays?.[tr.fromIndex] ?? null) : null;
  const overlayB = !fx ? (overlays?.[tr.toIndex] ?? null) : null;

  showOnly(tr.fromIndex);
  if (cameras?.a) applyCameraPose(camera as PerspectiveCamera, cameras.a);
  if (states?.a) applyState(states.a);
  if (overlayA) {
    renderFramedScene(gl, scene, camera, st, overlayA, size.x, size.y, tgtA);
    const panelA = panelFor(tr.fromIndex);
    if (panelA) drawFramePanelOver(gl, scene, camera, hosts, persistent, panelA, tgtA);
  } else {
    gl.setRenderTarget(tgtA);
    gl.render(scene, camera);
  }

  showOnly(tr.toIndex);
  if (cameras?.b) applyCameraPose(camera as PerspectiveCamera, cameras.b);
  if (states?.b) applyState(states.b);
  if (overlayB) {
    renderFramedScene(gl, scene, camera, st, overlayB, size.x, size.y, tgtB);
    const panelB = panelFor(tr.toIndex);
    if (panelB) drawFramePanelOver(gl, scene, camera, hosts, persistent, panelB, tgtB);
  } else {
    gl.setRenderTarget(tgtB);
    gl.render(scene, camera);
  }

  // The composite quad ignores `camera`; sets the dominant scene's pose here so both overlay branches below render the persistent layer with it, and the same for render state (which also feeds the dip-colour fallback in setCompositeUniforms below).
  if (cameras?.overlay) applyCameraPose(camera as PerspectiveCamera, cameras.overlay);
  if (states?.overlay) applyState(states.overlay);

  gl.toneMapping = prevToneMapping;

  // Effects: composites in linear into the composer (which owns tone-map + sRGB encode); no effects: composites straight to the default FB with sRGB encode, the original path, unchanged.
  const id = TYPE_ID[tr.type];
  const activeMaterial =
    id >= EXT2_MIN_TYPE
      ? fx
        ? st.materialExt2Hdr
        : st.materialExt2
      : id >= EXTENDED_MIN_TYPE
        ? fx
          ? st.materialExtHdr
          : st.materialExt
        : fx
          ? st.materialHdr
          : st.material;
  st.mesh.material = activeMaterial;
  setCompositeUniforms(
    activeMaterial.uniforms,
    tr,
    scene,
    tgtA.texture,
    tgtB.texture,
    st.size.x / st.size.y,
  );

  // The overlay draw renders `scene` again, with only the persistent layers visible, so the morph appears exactly once, over the blended composite, with the real camera.
  const hasOverlay = persistent.length > 0;
  if (hasOverlay) {
    for (const h of hosts) h.group.visible = false;
    for (const g of persistent) g.visible = true;
  }

  if (fx) {
    // Effects: the overlay is layered into the composer's pre-effect input buffer, so bloom/grade/grain apply to the morph exactly as they do to the scenes.
    renderThroughComposer(
      gl,
      ensureComposer(gl, size.x, size.y),
      st.quadScene,
      st.quadCamera,
      fx,
      seed,
      hasOverlay ? { scene, camera } : undefined,
    );
  } else {
    gl.setRenderTarget(null);
    gl.render(st.quadScene, st.quadCamera);
    if (hasOverlay) {
      // Keeps the composite's colour, clears depth so the overlay z-tests deterministically, and never repaints the scene background (it would wipe the composite).
      const prevBackground = scene.background;
      scene.background = null;
      gl.autoClear = false;
      gl.clear(false, true, false);
      gl.render(scene, camera);
      scene.background = prevBackground;
    }
  }

  gl.autoClear = prevAutoClear;
  gl.setRenderTarget(prevTarget);
  restoreSceneState();
  restoreVisible();
}
