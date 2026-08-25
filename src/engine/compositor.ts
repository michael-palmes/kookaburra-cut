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
  Quaternion,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import type { EffectsConfig } from "../theme/tokens";
import { cutoutPixelRect, type FrameLayout, frameLayout } from "../toolkit/frame/frameLayout";
import { fixedCoverCrop } from "../toolkit/stage/fixedMath";
import { applyCameraPose, baseCameraPose } from "./cameraTrack";
import { useClockStore } from "./clock";
import { compareFragmentShader, compareFragmentShaderHdr } from "./compareShader";
import type { DofUnion, ResolvedDof } from "./dof";
import { grainSeed } from "./effectParams";
import {
  dofSideScratch,
  drawingBufferSize,
  ensureComposer,
  releaseComposer,
  renderDofOverCanvas,
  renderDofOverTarget,
  renderSideWithDof,
  renderThroughComposer,
  resolveFrameEffects,
} from "./effects";
import { getLoadedEnvironment } from "./environments";
import { isExporting } from "./exportState";
import { FPS, MSAA_SAMPLES } from "./format";
import { framesThroughCutout } from "./frameFormat";
import { comparisonFramePanel, getFramePanels } from "./framePanelRegistry";
import { applyFrameLighting } from "./lightingAnimation";
import { applyRelativeLights } from "./lightingState";
import { panelGradientTexture, panelImageTexture } from "./overlayPanelTexture";
import type { ResolvedOverlay } from "./overlayPlan";
import {
  CUTOUT_MODE_BOX,
  CUTOUT_MODE_NONE,
  CUTOUT_MODE_SUPERELLIPSE,
  overlayFragmentShader,
  overlayVertexShader,
} from "./overlayShader";
import { getPersistentLayers } from "./persistentLayerRegistry";
import { previewDofOff, previewEnvironmentOff } from "./previewMedia";
import type { FrameCameraPlan } from "./sceneCamera";
import { COMPARE_GRIP_ID, COMPARE_MASK_ID, type CompareFrame, hexToSrgb } from "./sceneCompare";
import type { SceneHostHandle } from "./sceneHostRegistry";
import { type FrameLightingPlan, lightingSampleForCompareSide } from "./sceneLighting";
import {
  applySceneRenderState,
  type FrameSceneStatePlan,
  type SceneRenderState,
  type SharedEnvironmentSnapshot,
} from "./sceneState";
import type { Resolved, ResolvedTransition } from "./sceneTimeline";
import {
  EXT2_MIN_TYPE,
  EXT3_MIN_TYPE,
  EXTENDED_MIN_TYPE,
  fragmentShader,
  fragmentShaderExt,
  fragmentShaderExt2,
  fragmentShaderExt2Hdr,
  fragmentShaderExt3,
  fragmentShaderExt3Hdr,
  fragmentShaderExtHdr,
  fragmentShaderHdr,
  SHAPE_ID,
  TYPE_ID,
  vertexShader,
  vertexShader300,
} from "./transitionShader";

/** Renders the active scene(s) for one frame, applying any cross-scene transition; one function called by both preview and export so they cannot drift. Fast path (one scene, no transition): direct `gl.render` to the default framebuffer, byte-identical to v0 (never routed through render targets, which would change the bytes). Transition path (two scenes): each renders to its own `WebGLRenderTarget` (no-fx: sRGB 8-bit, tone-mapped once; fx: HalfFloat linear, un-tone-mapped for the composer), then a fullscreen pass composites them in the display domain. All touched renderer state is snapshotted and restored. See docs/determinism.md. */

interface CompositorState {
  /** SDR A/B pair for no-fx transition frames, allocated lazily on first use (fx projects' transitions never touch it) and released between windows during export: the WebContent process rides WebKit's 4 GB footprint ceiling at 4K, and each MSAA pair is ~570 MB. */
  targetA: WebGLRenderTarget | null;
  targetB: WebGLRenderTarget | null;
  /** HDR (HalfFloat/linear) A/B pair for the fx path, allocated lazily on the first fx transition frame, disposed and nulled on resize alongside the SDR pair. */
  targetAHdr: WebGLRenderTarget | null;
  targetBHdr: WebGLRenderTarget | null;
  /** Pre-composited comparison sides for transition frames (one per comparing scene, so a wipe rides through a transition instead of standing down); flat (no MSAA), they only ever receive the fullscreen compare quad. */
  targetComp: WebGLRenderTarget | null;
  targetComp2: WebGLRenderTarget | null;
  targetCompHdr: WebGLRenderTarget | null;
  targetComp2Hdr: WebGLRenderTarget | null;
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
  /** v15 pack (types 13-25, GLSL3), its own generation for the same reason. */
  materialExt3: ShaderMaterial;
  materialExt3Hdr: ShaderMaterial;
  /** The comparison mask pair (before/after split), its own generation so it never recompiles the transition programs. */
  compareMaterial: ShaderMaterial;
  compareMaterialHdr: ShaderMaterial;
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
const _camPos = new Vector3();
const _camQuat = new Quaternion();

function makeTarget(w: number, h: number, hdr: boolean, samples = MSAA_SAMPLES): WebGLRenderTarget {
  const t = new WebGLRenderTarget(w, h, {
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    format: RGBAFormat,
    // SDR (no-fx): UnsignedByteType + SRGBColorSpace allocates hardware SRGB8_ALPHA8 (tone-mapped bytes, hardware-decoded to linear on sample); HDR (fx): RGBA16F linear so the un-tone-mapped scene survives to the composer, since 8-bit fx targets used to clamp >1.0 linear before the composer's ACES (the highlight dim). Half-float MSAA matches the effect composer's proven configuration (effects.ts).
    type: hdr ? HalfFloatType : UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    // MSAA: the A/B scene renders sample at MSAA_SAMPLES and three resolves via blitFramebuffer when the composite samples the texture; the resolve is fixed-function, so it's same-machine deterministic, gated by Verify ×2 like everything else, and matches the context's own antialiasing so transition frames keep the solo frames' edge quality. Fullscreen-quad receivers pass 0: a quad has no edges to sample.
    samples,
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

/** The comparison mask material: blends the side-A/side-B targets under the mask family with its SDF chrome (see compareShader.ts). Display-domain GLSL1 like the legacy composite pair. */
function makeCompareMaterial(fragment: string): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      texA: { value: null },
      texB: { value: null },
      value: { value: 0.5 },
      sweepRad: { value: 0 },
      softness: { value: 0 },
      aspect: { value: 1 },
      maskType: { value: 0 },
      center: { value: new Vector2(0.5, 0.5) },
      lineWidth: { value: 0 },
      lineColor: { value: new Vector3(1, 1, 1) },
      lineSoftness: { value: 0 },
      gripSize: { value: 0 },
      gripStyle: { value: 0 },
      tintA: { value: new Vector3(0, 0, 0) },
      tintB: { value: new Vector3(0, 0, 0) },
      tintAmountA: { value: 0 },
      tintAmountB: { value: 0 },
    },
    vertexShader,
    fragmentShader: fragment,
    depthTest: false,
    depthWrite: false,
  });
}

/** The overlay slide material: keys the scene target through the cutout SDF, fills the rest with the panel fill. Display-domain GLSL1, same semantics as the legacy transition composite. */
function makeSlideMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      sceneTex: { value: null },
      panelColor: { value: new Vector3(0, 0, 0) },
      panelTex: { value: null },
      panelMode: { value: 0 },
      panelUv: { value: new Vector4(1, 1, 0, 0) },
      cutoutRect: { value: new Vector4(0, 0, 1, 1) },
      cutoutCenter: { value: new Vector2(0.5, 0.5) },
      cutoutHalf: { value: new Vector2(0.5, 0.5) },
      cutoutRadius: { value: 0 },
      cutoutExponent: { value: 4 },
      cutoutMode: { value: CUTOUT_MODE_BOX },
      aspect: { value: 1 },
      softness: { value: 0.001 },
      encodeToLinear: { value: 0 },
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
    state.targetA?.dispose();
    state.targetB?.dispose();
    state.targetA = null; // every pool re-allocates lazily at the new size on next use
    state.targetB = null;
    state.targetAHdr?.dispose();
    state.targetBHdr?.dispose();
    state.targetAHdr = null;
    state.targetBHdr = null;
    state.targetComp?.dispose();
    state.targetComp2?.dispose();
    state.targetComp = null;
    state.targetComp2 = null;
    state.targetCompHdr?.dispose();
    state.targetComp2Hdr?.dispose();
    state.targetCompHdr = null;
    state.targetComp2Hdr = null;
    state.sceneTarget?.dispose();
    state.sceneTarget = null;
    state.size.set(w, h);
    return state;
  }

  const material = makeCompositeMaterial(fragmentShader);
  const materialHdr = makeCompositeMaterial(fragmentShaderHdr);
  const materialExt = makeCompositeMaterial(fragmentShaderExt, true);
  const materialExtHdr = makeCompositeMaterial(fragmentShaderExtHdr, true);
  const materialExt2 = makeCompositeMaterial(fragmentShaderExt2, true);
  const materialExt2Hdr = makeCompositeMaterial(fragmentShaderExt2Hdr, true);
  const materialExt3 = makeCompositeMaterial(fragmentShaderExt3, true);
  const materialExt3Hdr = makeCompositeMaterial(fragmentShaderExt3Hdr, true);
  const compareMaterial = makeCompareMaterial(compareFragmentShader);
  const compareMaterialHdr = makeCompareMaterial(compareFragmentShaderHdr);
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
    targetA: null,
    targetB: null,
    targetAHdr: null,
    targetBHdr: null,
    targetComp: null,
    targetComp2: null,
    targetCompHdr: null,
    targetComp2Hdr: null,
    size: new Vector2(w, h),
    quadScene,
    quadCamera: new Camera(),
    material,
    materialHdr,
    materialExt,
    materialExtHdr,
    materialExt2,
    materialExt2Hdr,
    materialExt3,
    materialExt3Hdr,
    compareMaterial,
    compareMaterialHdr,
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

/** Allocate the SDR pair on first use (lazy, mirroring the HDR pair). */
function ensureSdrTargets(st: CompositorState): void {
  if (!st.targetA) st.targetA = makeTarget(st.size.x, st.size.y, false);
  if (!st.targetB) st.targetB = makeTarget(st.size.x, st.size.y, false);
}

/** Allocate the flat comparison-composite target(s) on first use; the second only exists once both scenes of a transition frame compare. */
function ensureCompTargets(st: CompositorState, hdr: boolean, count: number): void {
  if (count < 1) return;
  if (hdr) {
    if (!st.targetCompHdr) st.targetCompHdr = makeTarget(st.size.x, st.size.y, true, 0);
    if (count > 1 && !st.targetComp2Hdr)
      st.targetComp2Hdr = makeTarget(st.size.x, st.size.y, true, 0);
  } else {
    if (!st.targetComp) st.targetComp = makeTarget(st.size.x, st.size.y, false, 0);
    if (count > 1 && !st.targetComp2) st.targetComp2 = makeTarget(st.size.x, st.size.y, false, 0);
  }
}

/** During export, frames release the pools they did not touch, so idle MSAA pairs, the cutout target and the composer never sit resident between windows (each pair is 570-886 MB at 4K and the WebContent process is killed by WebKit near a 4 GB footprint). Preview never releases: a mid-playback realloc would hitch at 60fps. The next window that needs a pool simply re-allocates it through the existing ensure* path, which is a pure function of size, so pixels cannot change; the gate proves it. */
function releaseIdlePools(used: {
  sdr?: boolean;
  hdr?: boolean;
  comp?: boolean;
  sceneTarget?: boolean;
  composer?: boolean;
}): void {
  if (!isExporting()) return;
  if (!used.composer) releaseComposer();
  if (!state) return;
  if (!used.sdr && state.targetA) {
    state.targetA.dispose();
    state.targetB?.dispose();
    state.targetA = null;
    state.targetB = null;
  }
  if (!used.hdr && state.targetAHdr) {
    state.targetAHdr.dispose();
    state.targetBHdr?.dispose();
    state.targetAHdr = null;
    state.targetBHdr = null;
  }
  if (!used.comp && (state.targetComp || state.targetCompHdr)) {
    state.targetComp?.dispose();
    state.targetComp2?.dispose();
    state.targetComp = null;
    state.targetComp2 = null;
    state.targetCompHdr?.dispose();
    state.targetComp2Hdr?.dispose();
    state.targetCompHdr = null;
    state.targetComp2Hdr = null;
  }
  if (!used.sceneTarget && state.sceneTarget) {
    state.sceneTarget.dispose();
    state.sceneTarget = null;
  }
}

/** Release every pooled render target (the multi-project autorun calls this between legs so one project's pools never inflate the next leg's footprint); pools re-allocate lazily on next use. */
export function releaseCompositorPools(): void {
  if (!state) return;
  state.targetA?.dispose();
  state.targetB?.dispose();
  state.targetA = null;
  state.targetB = null;
  state.targetAHdr?.dispose();
  state.targetBHdr?.dispose();
  state.targetAHdr = null;
  state.targetBHdr = null;
  state.targetComp?.dispose();
  state.targetComp2?.dispose();
  state.targetComp = null;
  state.targetComp2 = null;
  state.targetCompHdr?.dispose();
  state.targetComp2Hdr?.dispose();
  state.targetCompHdr = null;
  state.targetComp2Hdr = null;
  state.sceneTarget?.dispose();
  state.sceneTarget = null;
}

/** Diagnostic snapshot of the compositor's A/B target formats for the verify render-state fingerprint; target type/colorSpace is part of the transition contract, so a cross-build divergence should name itself in one JSON diff. */
export function compositorTargetFingerprint(): {
  sdr: string | null;
  hdr: string | null;
  samples: number;
} | null {
  if (!state) return null;
  const describe = (t: WebGLRenderTarget) => `${t.texture.type}/${t.texture.colorSpace}`;
  return {
    sdr: state.targetA ? describe(state.targetA) : null,
    hdr: state.targetAHdr ? describe(state.targetAHdr) : null,
    samples: MSAA_SAMPLES,
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

/** The panel's sampled fill for this frame: the baked gradient (stretched over the frame, the `FixedGradient` precedent) or the project image (cover-cropped like `FixedImage`, so one asset serves every aspect). Null means the flat colour path, which also covers a preview frame whose image is still loading and a transparent panel behind a shaped cutout (its `panelColor` is the scene's backdrop, see overlayPlan.ts). */
function panelFill(
  overlay: ResolvedOverlay,
  aspect: number,
): { texture: Texture; uv: [number, number, number, number] } | null {
  const panel = overlay.panel;
  if (panel.kind === "gradient") {
    return { texture: panelGradientTexture(panel.key, panel.spec), uv: [1, 1, 0, 0] };
  }
  if (panel.kind !== "image") return null;
  const texture = panelImageTexture(panel.projectId, panel.src);
  if (!texture) return null;
  const image = texture.image as { width: number; height: number } | undefined;
  if (!image?.width || !image.height) return { texture, uv: [1, 1, 0, 0] };
  const crop = fixedCoverCrop(image.width / image.height, aspect);
  return { texture, uv: [crop.u1 - crop.u0, crop.v1 - crop.v0, crop.u0, crop.v0] };
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
  const fill = panelFill(overlay, aspect);
  u.panelTex.value = fill?.texture ?? null;
  u.panelMode.value = fill ? 1 : 0;
  (u.panelUv.value as Vector4).set(...(fill?.uv ?? [1, 1, 0, 0]));
  (u.cutoutRect.value as Vector4).set(uvX, uvY, uvW, uvH);
  (u.cutoutCenter.value as Vector2).set((uvX + uvW / 2) * aspect, uvY + uvH / 2);
  (u.cutoutHalf.value as Vector2).set((uvW / 2) * aspect, uvH / 2);
  u.cutoutRadius.value = layout.radius;
  u.cutoutExponent.value = layout.exponent;
  u.cutoutMode.value =
    overlay.frame.cutout.shape === "none"
      ? CUTOUT_MODE_NONE
      : overlay.frame.cutout.shape === "squircle"
        ? CUTOUT_MODE_SUPERELLIPSE
        : CUTOUT_MODE_BOX;
  u.aspect.value = aspect;
  u.softness.value = 1 / bufferH;
}

/** True when the frame needs the cutout-sized scene target: any shaped cutout, whatever fills the panel. One rule with `SceneHost`'s format narrowing, so layout and render agree (docs/decisions.md, 2026-08-23); only `shape: "none"` has no window, and it fills flat or stands the whole slide pass down. */
function usesSceneTarget(overlay: ResolvedOverlay): boolean {
  return framesThroughCutout(overlay.frame);
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
  // Transparent panel with no cutout: no window and no fill, so the scene takes the whole frame exactly as an unframed one does (the legacy render, both destinations) and only the panel's content draws over it. A SHAPED cutout takes the framed path below whatever the panel carries; transparency stops the surface being painted, it never moves the world.
  const framed = framesThroughCutout(overlay.frame);
  if (overlay.panel.kind === "transparent" && !framed) {
    gl.setRenderTarget(dest);
    gl.render(scene, camera);
    return;
  }

  const aspect = bufferW / bufferH;
  const layout = frameLayout(aspect, overlay.frame.cutout);

  // Shape "none": panel only. No scene pass, no cutout target; the slide shader fills flat.
  if (!framed) {
    setSlideUniforms(
      st,
      overlay,
      layout,
      { x: 0, y: 0, width: bufferW, height: bufferH },
      bufferW,
      bufferH,
    );
    st.slideMaterial.uniforms.encodeToLinear.value = dest ? 1 : 0;
    gl.setRenderTarget(dest);
    gl.render(st.slideScene, st.quadCamera);
    return;
  }

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
  // A non-null dest is a hardware-sRGB A/B target that encodes on write; emit the linear precursor so it lands the same display bytes as the solo path (default FB, no encode).
  st.slideMaterial.uniforms.encodeToLinear.value = dest ? 1 : 0;
  gl.setRenderTarget(dest);
  gl.render(st.slideScene, st.quadCamera);
}

/** Draw one scene's overlay panel (title/subtitle/chip, full-frame world content) over the slide already in `dest`. Everything except the panel group is hidden, depth is cleared so the text z-tests cleanly, and the composite's colour is preserved (background nulled, colour never cleared), mirroring the persistent-layer overlay draw. The panel is screen-locked: it renders from the BASE pose (the one `format.frame` is laid out for), not the scene's animated camera, so the editorial content stays put while the cutout scene orbits; the animated pose is saved and restored around the draw. */
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
  const cam = camera as PerspectiveCamera;
  _camPos.copy(cam.position);
  _camQuat.copy(cam.quaternion);
  const prevFov = cam.isPerspectiveCamera ? cam.fov : 0;
  applyCameraPose(cam, baseCameraPose());
  gl.setRenderTarget(dest);
  gl.clear(false, true, false);
  gl.render(scene, camera);
  cam.position.copy(_camPos);
  cam.quaternion.copy(_camQuat);
  if (cam.isPerspectiveCamera && cam.fov !== prevFov) {
    cam.fov = prevFov;
    cam.updateProjectionMatrix();
  }
  scene.background = prevBackground;
  gl.autoClear = prevAutoClear;
  panel.visible = false;
}

/** `cameras` is the frame's per-scene camera plan, present only when the project has scene-doc camera tracks (solo/a/b/overlay applied per target, absent means the camera is never touched here); `states` is the analogous per-scene render-state plan (background, environment), whose values are always restored to the shared scene on return so root-scene state never leaks into the next-loaded project. `overlays` is the per-scene resolved overlay plan (panel colour), present only when some scene declares a frame; a scene with a null entry renders full-bleed on the legacy path. */
/** The comparison quad's uniforms for one plan; shared by the solo path and the transition pre-composite so the two cannot drift. */
function setCompareUniforms(
  material: ShaderMaterial,
  plan: CompareFrame,
  texA: Texture,
  texB: Texture,
  aspect: number,
): void {
  const spec = plan.spec;
  const u = material.uniforms;
  u.texA.value = texA;
  u.texB.value = texB;
  u.value.value = plan.value;
  u.sweepRad.value = ((plan.angleDeg - 90) * Math.PI) / 180;
  u.softness.value = spec.softness;
  u.aspect.value = aspect;
  u.maskType.value = COMPARE_MASK_ID[spec.maskType];
  (u.center.value as Vector2).set(spec.center[0], spec.center[1]);
  u.lineWidth.value = spec.chrome.lineWidth / 1080;
  (u.lineColor.value as Vector3).set(...hexToSrgb(spec.chrome.lineColor));
  u.lineSoftness.value = spec.chrome.lineSoftness / 1080;
  u.gripSize.value = spec.chrome.gripSize;
  u.gripStyle.value = COMPARE_GRIP_ID[spec.chrome.gripStyle];
  (u.tintA.value as Vector3).set(...hexToSrgb(spec.chrome.tintA ?? "#000000"));
  (u.tintB.value as Vector3).set(...hexToSrgb(spec.chrome.tintB ?? "#000000"));
  u.tintAmountA.value = spec.chrome.tintA ? spec.chrome.tintAmount : 0;
  u.tintAmountB.value = spec.chrome.tintB ? spec.chrome.tintAmount : 0;
}

/** One comparison side render on the frame's active lane: hdr side-dof through the side composer, dof-only through the scratch chain, else a plain render into the target. */
function renderCompareSide(
  gl: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  sideDof: ResolvedDof | null,
  tgt: WebGLRenderTarget,
  w: number,
  h: number,
  dofUnion: DofUnion | null,
  dofOnly: boolean,
  hdrLane: boolean,
): void {
  if (hdrLane && sideDof && dofUnion) {
    renderSideWithDof(gl, scene, camera, sideDof, tgt, w, h, dofUnion);
  } else if (dofOnly && dofUnion && sideDof && sideDof.blur > 0) {
    gl.setRenderTarget(dofSideScratch(gl, w, h, dofUnion));
    gl.render(scene, camera);
    renderDofOverTarget(gl, scene, camera, sideDof, dofUnion, tgt, w, h);
  } else {
    gl.setRenderTarget(tgt);
    gl.render(scene, camera);
  }
}

export function renderComposited(
  gl: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  hosts: SceneHostHandle[],
  resolved: Resolved,
  cameras?: FrameCameraPlan,
  states?: FrameSceneStatePlan,
  overlays?: readonly (ResolvedOverlay | null)[],
  lighting?: FrameLightingPlan,
  compare?: readonly CompareFrame[] | null,
): void {
  const plans = compare ?? [];
  // Snapshots the root-scene values the state plan owns, restored at every exit so root-scene state never leaks into the next-loaded project; the environment snapshot doubles as the explicit fallback for scenes whose theme declares none (legacy drei mounts keep working through it). A compare frame carrying per-side states opts in too, since its project may otherwise be legacy.
  const wantsStatePlan = !!states || plans.some((p) => p.stateA || p.stateB);
  const prevStateBackground = wantsStatePlan ? scene.background : undefined;
  const sharedEnv: SharedEnvironmentSnapshot | null = wantsStatePlan
    ? {
        environment: scene.environment,
        intensity: scene.environmentIntensity,
        rotationYRad: scene.environmentRotation.y,
      }
    : null;
  const applyState = (s: SceneRenderState) => {
    if (sharedEnv) applySceneRenderState(scene, s, sharedEnv, getLoadedEnvironment);
    // Perf-probe env-off pass only (preview diagnostics); exports never see it.
    if (previewEnvironmentOff() && !isExporting()) scene.environment = null;
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
  const comparisonPanelFor = (index: number): Group | null =>
    comparisonFramePanel(framePanels, index);
  // Visibility gating is side-aware: without `side`, the plain host shows (a comparison's side-B host stays hidden, so every legacy path renders side A only); `side: "b"` shows exactly the side-B host.
  const showOnly = (idx: number, side?: "b") => {
    for (const h of hosts) {
      h.group.visible = h.index === idx && (side === "b" ? h.side === "b" : h.side !== "b");
    }
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

  // Resolves the frame's effect stack: `null` means the project declares no effects, so the original byte-identical paths below run unchanged; non-null routes through the gated composer. A dof-active project with no other effects still routes fx (empty config) but on the DOF-ONLY lane: scenes render through the direct path's display transform (tone mapping on, SDR targets) and the composer applies dof alone, so toggling dof never regrades the frame; declared-effects projects keep the linear-HDR lane (`hdrLane`) and its composer-owned tone map. The probe's no-dof pass drops the union preview-only (never during export).
  const dofUnion = previewDofOff() && !isExporting() ? null : (cameras?.dofUnion ?? null);
  const declaredFx = resolveFrameEffects(resolved);
  const dofOnly = !declaredFx && !!dofUnion;
  const fx = declaredFx ?? (dofUnion ? {} : null);
  const hdrLane = !!fx && !dofOnly;
  const seed = fx ? grainSeed(useClockStore.getState().currentMs, FPS) : 0;

  // Comparison path (solo frames): the active scene's side hosts render to the A/B pair and blend under the divider mask. Structure mirrors the transition path (per-side state, persistent layers drawn once, snapshot/restore); one camera pose serves both sides (lockstep). The frame panel draws once over the completed comparison, never once per side. Transition frames take the transition path below, which pre-composites each comparing scene into a flat pooled target so the divider rides through the blend.
  const soloCompare =
    resolved.active.length === 1
      ? (plans.find((p) => p.index === resolved.active[0].index) ?? null)
      : null;
  if (soloCompare) {
    const idx = soloCompare.index;
    const size = gl.getDrawingBufferSize(_size);
    const st = ensureState(size.x, size.y);
    const prevAutoClear = gl.autoClear;
    gl.autoClear = true;
    const prevToneMapping = gl.toneMapping;
    if (hdrLane) {
      gl.toneMapping = NoToneMapping;
      ensureHdrTargets(st);
    } else {
      ensureSdrTargets(st);
    }
    const tgtA = hdrLane ? (st.targetAHdr as WebGLRenderTarget) : (st.targetA as WebGLRenderTarget);
    const tgtB = hdrLane ? (st.targetBHdr as WebGLRenderTarget) : (st.targetB as WebGLRenderTarget);

    // Persistent layers draw exactly once over the composite, never into the side targets (the transition ghosting rule).
    for (const g of persistent) g.visible = false;

    // One camera pose (and so one dof) serves both comparison sides; each side renders through the dof side composer when the pose carries dof, so the divider blends two focus-graded halves.
    const sideDof = dofUnion && cameras?.solo?.dof ? cameras.solo.dof : null;
    const soloLightingA = lightingSampleForCompareSide(lighting, "solo", "a");
    const soloLightingB = lightingSampleForCompareSide(lighting, "solo", "b");
    if (cameras?.solo) applyCameraPose(camera as PerspectiveCamera, cameras.solo);
    showOnly(idx);
    if (soloCompare.stateA) applyState(soloCompare.stateA);
    applyRelativeLights(camera as PerspectiveCamera, cameras?.solo ?? null, soloLightingA);
    applyFrameLighting(scene, soloLightingA);
    renderCompareSide(gl, scene, camera, sideDof, tgtA, size.x, size.y, dofUnion, dofOnly, hdrLane);

    showOnly(idx, "b");
    if (soloCompare.stateB) applyState(soloCompare.stateB);
    applyRelativeLights(camera as PerspectiveCamera, cameras?.solo ?? null, soloLightingB);
    applyFrameLighting(scene, soloLightingB);
    renderCompareSide(gl, scene, camera, sideDof, tgtB, size.x, size.y, dofUnion, dofOnly, hdrLane);

    // The dominant side's state backs the persistent-overlay draw (the transition dominance rule).
    const domState = soloCompare.value >= 0.5 ? soloCompare.stateA : soloCompare.stateB;
    if (domState) applyState(domState);

    gl.toneMapping = prevToneMapping;

    const activeMaterial = hdrLane ? st.compareMaterialHdr : st.compareMaterial;
    st.mesh.material = activeMaterial;
    setCompareUniforms(
      activeMaterial,
      soloCompare,
      tgtA.texture,
      tgtB.texture,
      st.size.x / st.size.y,
    );

    const hasOverlay = persistent.length > 0;
    if (hasOverlay) {
      for (const h of hosts) h.group.visible = false;
      for (const g of persistent) g.visible = true;
    }
    if (hdrLane) {
      // The sides already carry their dof; the main chain's dof stays zeroed (null) so the composite is never double-focused.
      renderThroughComposer(
        gl,
        ensureComposer(gl, size.x, size.y, dofUnion),
        st.quadScene,
        st.quadCamera,
        fx as EffectsConfig,
        seed,
        hasOverlay ? { scene, camera } : undefined,
        null,
      );
    } else {
      gl.setRenderTarget(null);
      gl.render(st.quadScene, st.quadCamera);
      if (hasOverlay) {
        const prevBackground = scene.background;
        scene.background = null;
        gl.autoClear = false;
        gl.clear(false, true, false);
        gl.render(scene, camera);
        scene.background = prevBackground;
      }
    }
    const panel = comparisonPanelFor(idx);
    if (panel) drawFramePanelOver(gl, scene, camera, hosts, persistent, panel, null);
    gl.autoClear = prevAutoClear;
    gl.setRenderTarget(prevTarget);
    releaseIdlePools({ sdr: !hdrLane, hdr: hdrLane, composer: !!fx });
    restoreSceneState();
    restoreVisible();
    return;
  }

  // Fast path: single active scene (or nothing) → direct render, v0-identical (or composer-graded).
  if (resolved.active.length < 2 || !tr) {
    const idx = resolved.active.length
      ? resolved.active[resolved.active.length - 1].index
      : (hosts[0]?.index ?? 0);
    showOnly(idx);
    if (cameras?.solo) applyCameraPose(camera as PerspectiveCamera, cameras.solo);
    if (states?.solo) applyState(states.solo);
    // Camera/subject-space lights resolve AFTER the camera pose lands, per render target (a no-op when none are mounted); keyframed lighting applies last so its env overrides win.
    applyRelativeLights(camera as PerspectiveCamera, cameras?.solo ?? null, lighting?.solo);
    applyFrameLighting(scene, lighting?.solo);
    const overlay = overlays?.[idx] ?? null;
    if (overlay) {
      // Overlay path: the scene renders into its cutout, then the slide keys it in over the panel. Effects don't yet compose onto a framed scene (docs/overlays.md open question), so this branch is taken ahead of fx.
      const size = gl.getDrawingBufferSize(_size);
      const st = ensureState(size.x, size.y);
      renderFramedScene(gl, scene, camera, st, overlay, size.x, size.y, null);
      const panel = panelFor(idx);
      if (panel) drawFramePanelOver(gl, scene, camera, hosts, persistent, panel, null);
    } else if (hdrLane) {
      const size = drawingBufferSize(gl);
      renderThroughComposer(
        gl,
        ensureComposer(gl, size.x, size.y, dofUnion),
        scene,
        camera,
        fx as EffectsConfig,
        seed,
        undefined,
        cameras?.solo?.dof ?? null,
      );
    } else {
      // Direct render, v0-identical; the dof-only lane then blurs the FINISHED frame in place, so an inactive pose leaves the canvas untouched by construction.
      gl.setRenderTarget(null);
      gl.render(scene, camera);
      const soloDof = cameras?.solo?.dof;
      if (dofOnly && dofUnion && soloDof && soloDof.blur > 0) {
        const size = drawingBufferSize(gl);
        renderDofOverCanvas(gl, scene, camera, soloDof, dofUnion, size.x, size.y);
      }
    }
    // Unframed scenes can still register panel content (the terminal block), drawn over the finished frame exactly as the overlay branch draws its own; a framed scene never reaches this (its draw sits inside the branch above).
    if (!overlay) {
      const panel = panelFor(idx);
      if (panel) drawFramePanelOver(gl, scene, camera, hosts, persistent, panel, null);
    }
    gl.setRenderTarget(prevTarget);
    releaseIdlePools({
      sceneTarget: !!overlay && usesSceneTarget(overlay),
      composer: !!fx,
    });
    restoreSceneState();
    restoreVisible();
    return;
  }

  // Transition path: render A and B to their targets, then composite to the default FB.
  const size = gl.getDrawingBufferSize(_size);
  const st = ensureState(size.x, size.y);
  const prevAutoClear = gl.autoClear;
  gl.autoClear = true;

  // Effects (hdr lane): the composer owns the project's single ACES tone-map, so scenes must reach the targets un-tone-mapped, otherwise transition frames get three's ACES here plus the composer's ACES (a double tone-map that pops at the seam); those un-tone-mapped HDR values need the HalfFloat/linear pair, since old 8-bit fx targets clamped >1.0 before the composer's ACES (the highlight dim). No effects AND the dof-only lane: the r3f pipeline tone-maps here exactly once into the hardware-sRGB SDR pair (dof-only sides route through the side composer on the way in).
  const prevToneMapping = gl.toneMapping;
  if (hdrLane) {
    gl.toneMapping = NoToneMapping;
    ensureHdrTargets(st);
  } else {
    ensureSdrTargets(st);
  }
  const tgtA = hdrLane ? (st.targetAHdr as WebGLRenderTarget) : (st.targetA as WebGLRenderTarget);
  const tgtB = hdrLane ? (st.targetBHdr as WebGLRenderTarget) : (st.targetB as WebGLRenderTarget);

  // Persistent layers must not bake into the A/B targets, they'd render into both and cross-fade against themselves (ghosting); hidden here, drawn exactly once over the composite below.
  for (const g of persistent) g.visible = false;

  // A comparing scene pre-composites its two sides under the divider into a flat pooled target, so the transition blends the finished comparison rather than side A only (the retired v1 rule). Both sub-sides share that scene's transition pose (per-scene lockstep).
  const planA = plans.find((p) => p.index === tr.fromIndex) ?? null;
  const planB = plans.find((p) => p.index === tr.toIndex) ?? null;
  ensureCompTargets(st, hdrLane, (planA ? 1 : 0) + (planB ? 1 : 0));
  const compFirst = hdrLane ? st.targetCompHdr : st.targetComp;
  const compSecond = hdrLane ? st.targetComp2Hdr : st.targetComp2;
  const compA = planA ? compFirst : null;
  const compB = planB ? (planA ? compSecond : compFirst) : null;
  const compareMat = hdrLane ? st.compareMaterialHdr : st.compareMaterial;

  // The whole slide (panel + cutout) goes into each target, so a transition crossfades framed slides exactly as it does full-bleed scenes. Overlays don't compose through the fx (HDR) targets yet, so a framed scene under effects falls back to the plain scene render here; the dof-only lane keeps SDR targets, so framed scenes compose exactly as they do with no effects.
  const overlayA = !hdrLane ? (overlays?.[tr.fromIndex] ?? null) : null;
  const overlayB = !hdrLane ? (overlays?.[tr.toIndex] ?? null) : null;

  const sideDofA = dofUnion && cameras?.a?.dof ? cameras.a.dof : null;
  if (planA && compA) {
    const lightingA = lightingSampleForCompareSide(lighting, "a", "a");
    const lightingB = lightingSampleForCompareSide(lighting, "a", "b");
    if (cameras?.a) applyCameraPose(camera as PerspectiveCamera, cameras.a);
    showOnly(tr.fromIndex);
    if (planA.stateA) applyState(planA.stateA);
    applyRelativeLights(camera as PerspectiveCamera, cameras?.a ?? null, lightingA);
    applyFrameLighting(scene, lightingA);
    renderCompareSide(
      gl,
      scene,
      camera,
      sideDofA,
      tgtA,
      size.x,
      size.y,
      dofUnion,
      dofOnly,
      hdrLane,
    );
    showOnly(tr.fromIndex, "b");
    if (planA.stateB) applyState(planA.stateB);
    applyRelativeLights(camera as PerspectiveCamera, cameras?.a ?? null, lightingB);
    applyFrameLighting(scene, lightingB);
    renderCompareSide(
      gl,
      scene,
      camera,
      sideDofA,
      tgtB,
      size.x,
      size.y,
      dofUnion,
      dofOnly,
      hdrLane,
    );
    st.mesh.material = compareMat;
    setCompareUniforms(compareMat, planA, tgtA.texture, tgtB.texture, st.size.x / st.size.y);
    gl.setRenderTarget(compA);
    gl.render(st.quadScene, st.quadCamera);
    const panelA = comparisonPanelFor(tr.fromIndex);
    if (panelA) drawFramePanelOver(gl, scene, camera, hosts, persistent, panelA, compA);
  } else {
    showOnly(tr.fromIndex);
    if (cameras?.a) applyCameraPose(camera as PerspectiveCamera, cameras.a);
    if (states?.a) applyState(states.a);
    // Target A resolves its own relative lights and its own sampled lighting: A and B use different cameras AND different scene-local times on a transition frame.
    applyRelativeLights(camera as PerspectiveCamera, cameras?.a ?? null, lighting?.a);
    applyFrameLighting(scene, lighting?.a);
    if (overlayA) {
      renderFramedScene(gl, scene, camera, st, overlayA, size.x, size.y, tgtA);
      const panelA = panelFor(tr.fromIndex);
      if (panelA) drawFramePanelOver(gl, scene, camera, hosts, persistent, panelA, tgtA);
    } else if (hdrLane && dofUnion && cameras?.a?.dof) {
      // Per-side dof: the side renders through the dof composer into its target, so a rack focus rides INTO the transition instead of releasing at the cut.
      renderSideWithDof(gl, scene, camera, cameras.a.dof, tgtA, size.x, size.y, dofUnion);
    } else if (dofOnly && dofUnion && cameras?.a?.dof && cameras.a.dof.blur > 0) {
      // Dof-only lane: the side renders on the plain SDR contract into the scratch, then the dof chain writes the blurred side into the real target.
      gl.setRenderTarget(dofSideScratch(gl, size.x, size.y, dofUnion));
      gl.render(scene, camera);
      renderDofOverTarget(gl, scene, camera, cameras.a.dof, dofUnion, tgtA, size.x, size.y);
    } else {
      gl.setRenderTarget(tgtA);
      gl.render(scene, camera);
    }
    // Panel content on a scene with no overlay PLAN (the terminal block). Guarded on the raw plan, not `overlayA`, so a framed scene under the hdr lane keeps its no-panel fallback unchanged.
    if (!(overlays?.[tr.fromIndex] ?? null)) {
      const panelA = panelFor(tr.fromIndex);
      if (panelA) drawFramePanelOver(gl, scene, camera, hosts, persistent, panelA, tgtA);
    }
  }

  const sideDofB = dofUnion && cameras?.b?.dof ? cameras.b.dof : null;
  if (planB && compB) {
    const lightingA = lightingSampleForCompareSide(lighting, "b", "a");
    const lightingB = lightingSampleForCompareSide(lighting, "b", "b");
    if (cameras?.b) applyCameraPose(camera as PerspectiveCamera, cameras.b);
    showOnly(tr.toIndex);
    if (planB.stateA) applyState(planB.stateA);
    applyRelativeLights(camera as PerspectiveCamera, cameras?.b ?? null, lightingA);
    applyFrameLighting(scene, lightingA);
    renderCompareSide(
      gl,
      scene,
      camera,
      sideDofB,
      tgtA,
      size.x,
      size.y,
      dofUnion,
      dofOnly,
      hdrLane,
    );
    showOnly(tr.toIndex, "b");
    if (planB.stateB) applyState(planB.stateB);
    applyRelativeLights(camera as PerspectiveCamera, cameras?.b ?? null, lightingB);
    applyFrameLighting(scene, lightingB);
    renderCompareSide(
      gl,
      scene,
      camera,
      sideDofB,
      tgtB,
      size.x,
      size.y,
      dofUnion,
      dofOnly,
      hdrLane,
    );
    st.mesh.material = compareMat;
    setCompareUniforms(compareMat, planB, tgtA.texture, tgtB.texture, st.size.x / st.size.y);
    gl.setRenderTarget(compB);
    gl.render(st.quadScene, st.quadCamera);
    const panelB = comparisonPanelFor(tr.toIndex);
    if (panelB) drawFramePanelOver(gl, scene, camera, hosts, persistent, panelB, compB);
  } else {
    showOnly(tr.toIndex);
    if (cameras?.b) applyCameraPose(camera as PerspectiveCamera, cameras.b);
    if (states?.b) applyState(states.b);
    applyRelativeLights(camera as PerspectiveCamera, cameras?.b ?? null, lighting?.b);
    applyFrameLighting(scene, lighting?.b);
    if (overlayB) {
      renderFramedScene(gl, scene, camera, st, overlayB, size.x, size.y, tgtB);
      const panelB = panelFor(tr.toIndex);
      if (panelB) drawFramePanelOver(gl, scene, camera, hosts, persistent, panelB, tgtB);
    } else if (hdrLane && dofUnion && cameras?.b?.dof) {
      renderSideWithDof(gl, scene, camera, cameras.b.dof, tgtB, size.x, size.y, dofUnion);
    } else if (dofOnly && dofUnion && cameras?.b?.dof && cameras.b.dof.blur > 0) {
      gl.setRenderTarget(dofSideScratch(gl, size.x, size.y, dofUnion));
      gl.render(scene, camera);
      renderDofOverTarget(gl, scene, camera, cameras.b.dof, dofUnion, tgtB, size.x, size.y);
    } else {
      gl.setRenderTarget(tgtB);
      gl.render(scene, camera);
    }
    // The B-side twin of the A-side no-plan panel draw above.
    if (!(overlays?.[tr.toIndex] ?? null)) {
      const panelB = panelFor(tr.toIndex);
      if (panelB) drawFramePanelOver(gl, scene, camera, hosts, persistent, panelB, tgtB);
    }
  }

  // The composite quad ignores `camera`; sets the dominant scene's pose here so both overlay branches below render the persistent layer with it, and the same for render state (which also feeds the dip-colour fallback in setCompositeUniforms below).
  if (cameras?.overlay) applyCameraPose(camera as PerspectiveCamera, cameras.overlay);
  if (states?.overlay) applyState(states.overlay);
  applyRelativeLights(camera as PerspectiveCamera, cameras?.overlay ?? null, lighting?.overlay);
  applyFrameLighting(scene, lighting?.overlay);

  gl.toneMapping = prevToneMapping;

  // Effects: composites in linear into the composer (which owns tone-map + sRGB encode); no effects: composites straight to the default FB with sRGB encode, the original path, unchanged.
  const id = TYPE_ID[tr.type];
  const activeMaterial =
    id >= EXT3_MIN_TYPE
      ? hdrLane
        ? st.materialExt3Hdr
        : st.materialExt3
      : id >= EXT2_MIN_TYPE
        ? hdrLane
          ? st.materialExt2Hdr
          : st.materialExt2
        : id >= EXTENDED_MIN_TYPE
          ? hdrLane
            ? st.materialExtHdr
            : st.materialExt
          : hdrLane
            ? st.materialHdr
            : st.material;
  st.mesh.material = activeMaterial;
  setCompositeUniforms(
    activeMaterial.uniforms,
    tr,
    scene,
    (compA ?? tgtA).texture,
    (compB ?? tgtB).texture,
    st.size.x / st.size.y,
  );

  // The overlay draw renders `scene` again, with only the persistent layers visible, so the morph appears exactly once, over the blended composite, with the real camera.
  const hasOverlay = persistent.length > 0;
  if (hasOverlay) {
    for (const h of hosts) h.group.visible = false;
    for (const g of persistent) g.visible = true;
  }

  if (hdrLane) {
    // Effects: the overlay is layered into the composer's pre-effect input buffer, so bloom/grade/grain apply to the morph exactly as they do to the scenes. The sides already carry their dof, so the main chain's stays zeroed (null).
    renderThroughComposer(
      gl,
      ensureComposer(gl, size.x, size.y, dofUnion),
      st.quadScene,
      st.quadCamera,
      fx as EffectsConfig,
      seed,
      hasOverlay ? { scene, camera } : undefined,
      null,
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
  releaseIdlePools({
    sdr: !hdrLane,
    hdr: hdrLane,
    comp: !!(planA || planB),
    sceneTarget:
      (!!overlayA && usesSceneTarget(overlayA)) || (!!overlayB && usesSceneTarget(overlayB)),
    composer: !!fx,
  });
  restoreSceneState();
  restoreVisible();
}
