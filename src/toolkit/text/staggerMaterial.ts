import { Color, MeshBasicMaterial, Vector2, Vector3, Vector4 } from "three";
import { createTextDerivedMaterial } from "troika-three-text";
import { createDerivedMaterial } from "troika-three-utils";
import {
  EDGE_SENTINEL,
  GLINT_HALF_W,
  GLINT_INTENSITY,
  MAX_STAGGER_UNITS,
  SHINE_AXIS,
  SHINE_INTENSITY,
  type StaggerAxis,
  type StaggerUnits,
  shineBand,
  type TextUnitSample,
} from "./presets";

/** Per-glyph staggered text animation, a derived troika material: one mesh with per-unit UNIFORMS avoids the measure/setState/mount cascade of N `<Text>` meshes (which would land a frame after the master text's sync and race the exporter's per-frame troika barrier), placing each glyph via an `aTroikaGlyphBounds` lookup (the same fixed-function GPU determinism argument as the LUT/grain effects); unit extents arrive once per typeset and default to one whole-block unit until measured. The material chain is `MeshBasicMaterial → troika text material → this derivation`, presented via `isTroikaTextMaterial` so troika's `Text.material` setter accepts the pre-derived result. */

const N = MAX_STAGGER_UNITS;

const VERTEX_DEFS = /* glsl */ `
uniform float uGanCount;
uniform float uGanEm;
uniform float uGanEdgeX[${N}];
// Per unit: (alpha, dxEm, dyEm, scale)
uniform vec4 uGanUnitA[${N}];
// Per unit: (sweepLeftX, sweepRightX) in layout space; (-1e30, 1e30) = no sweep
uniform vec4 uGanUnitB[${N}];
varying float vGanAlpha;
varying vec2 vGanSweep;
varying float vGanX;
`;

// Derivation intros nest OUTER-FIRST (troika-three-utils injects each vertexTransform at the top of its own wrapping main), so this runs BEFORE troika's glyph placement: `position.xy` is the glyph-local quad interpolant (0..1), which placement then mix()es with aTroikaGlyphBounds; because troika derives its SDF sampling from the SAME interpolant, the offsets applied here mostly SELF-CANCEL into clip-reveal illusions rather than true motion (the shipped v8 stagger look, pixel-frozen on standing projects; variants needing REAL geometry ride the sandwich below). The walk axis is a mount-constant variant: char/word compare layout X (byte-identical to the v8 program) while the paragraph granularities compare k = −centerY (vertically disjoint contiguous line ranges by construction).
const vertexTransformFor = (axisY: boolean) => /* glsl */ `
vec2 ganCenter = vec2(
  (aTroikaGlyphBounds.x + aTroikaGlyphBounds.z) * 0.5,
  (aTroikaGlyphBounds.y + aTroikaGlyphBounds.w) * 0.5
);
int ganUnit = 0;
for (int i = 0; i < ${N}; i++) {
  if (float(i) >= uGanCount - 0.5) break;
  ganUnit = i;
  if (${axisY ? "-ganCenter.y" : "ganCenter.x"} <= uGanEdgeX[i]) break;
}
vec4 ganA = uGanUnitA[ganUnit];
vGanX = position.x;
position.xy = ganCenter + (position.xy - ganCenter) * ganA.w + vec2(ganA.y, ganA.z) * uGanEm;
vGanAlpha = ganA.x;
vGanSweep = uGanUnitB[ganUnit].xy;
`;
const VERTEX_TRANSFORM = vertexTransformFor(false);
const VERTEX_TRANSFORM_AXIS_Y = vertexTransformFor(true);

// The GEOMETRY SANDWICH, real glyph transforms: troika couples SDF sampling to the quad interpolant (`vTroikaGlyphUV = clippedXY`, both derived from the SAME post-transform `position.xy`), so any interpolant remap in an over-derivation self-cancels visually (the glyph image never moves, the quad just covers a shifted sampling window, and the only visible artefact is a hard clip at the cell edge), making rotations IMPOSSIBLE over the text material alone. Variants that move real geometry (twist, scatter) use a THREE-LAYER sandwich instead (base → OUR UNDER-layer → troika text → OUR OVER-layer): derivation intros nest outer-first, so at runtime the OVER-layer runs FIRST (it has attribute access and walks the unit selection into shared vertex-stage globals, leaving `position` untouched), then troika places the glyph, then the UNDER-layer applies the actual transforms on true glyph-placed LAYOUT coordinates, decoupled from sampling; the globals are DECLARED in the under-layer's defs (source-earliest) and WRITTEN by the over-layer (defined later in source, executed first, legal file-scope GLSL). The v8 over-chain stays byte-frozen for feature-off and shine-only variants, so standing stagger projects compile the exact same program.
const SCATTER_VERTEX_DEFS = /* glsl */ `
uniform vec4 uGanUnitC[${N}];
`;

// Under-layer defs: the shared globals the over-layer walk fills in.
const SANDWICH_SHARED_DEFS = /* glsl */ `
float ganUnitG;
vec2 ganCenterG;
`;

// The over-layer walk: same unit selection as the v8 transform, writing globals only.
const overWalkFor = (axisY: boolean) => /* glsl */ `
ganCenterG = vec2(
  (aTroikaGlyphBounds.x + aTroikaGlyphBounds.z) * 0.5,
  (aTroikaGlyphBounds.y + aTroikaGlyphBounds.w) * 0.5
);
int ganUnitI = 0;
for (int i = 0; i < ${N}; i++) {
  if (float(i) >= uGanCount - 0.5) break;
  ganUnitI = i;
  if (${axisY ? "-ganCenterG.y" : "ganCenterG.x"} <= uGanEdgeX[i]) break;
}
ganUnitG = float(ganUnitI);
`;
const OVER_WALK = overWalkFor(false);
const OVER_WALK_AXIS_Y = overWalkFor(true);

// The under-layer unit transform: the v8 semantics on REAL layout positions, scale about the glyph centre, offsets in true em, vGanX in true layout X.
const UNDER_TRANSFORM = /* glsl */ `
int ganUnit = int(ganUnitG + 0.5);
vec4 ganA = uGanUnitA[ganUnit];
vGanX = position.x;
position.xy = ganCenterG + (position.xy - ganCenterG) * ganA.w + vec2(ganA.y, ganA.z) * uGanEm;
vGanAlpha = ganA.x;
vGanSweep = uGanUnitB[ganUnit].xy;
`;

// Per-unit Y-rotation about the unit centre (uGanUnitB.zw = rotYRad, centreX), applied to true layout positions: a real per-vertex perspective card turn.
const TWIST_VERTEX_TRANSFORM_LAYOUT = /* glsl */ `
float ganRot = uGanUnitB[ganUnit].z;
if (ganRot != 0.0) {
  float ganDX = position.x - uGanUnitB[ganUnit].w;
  position.x = uGanUnitB[ganUnit].w + ganDX * cos(ganRot);
  position.z -= ganDX * sin(ganRot);
}
`;

// scatter-scale (uGanUnitC = rotZRad, dzEm, dxEm, dyEm): roll the glyph about its own centre in the layout plane (negative = clockwise on screen), ride toward the camera in em, and apply the tilt-drift offsets in em, all on real geometry.
const SCATTER_VERTEX_TRANSFORM_LAYOUT = /* glsl */ `
vec4 ganC = uGanUnitC[ganUnit];
if (ganC.x != 0.0 || ganC.y != 0.0 || ganC.z != 0.0 || ganC.w != 0.0) {
  vec2 ganRel = position.xy - ganCenterG;
  float ganCosZ = cos(ganC.x);
  float ganSinZ = sin(ganC.x);
  position.xy = ganCenterG
    + vec2(ganRel.x * ganCosZ - ganRel.y * ganSinZ, ganRel.x * ganSinZ + ganRel.y * ganCosZ)
    + ganC.zw * uGanEm;
  position.z += ganC.y * uGanEm;
}
`;

// ── The motion-pack v2 feature ("pack"): three more per-unit vec4 arrays over the sandwich. D = (rotXRad, scale·scaleX, scale·scaleY, colorMix); E = (weight, soft, chroma, unit centreY) with the em fields pre-multiplied to LAYOUT units CPU-side; F = the clipFinal rect, sentinel-open when off. Every term guards on its exact neutral value, so a neutral unit renders the same pixels as the pack-off program; legacy mounts never include these bytes at all. ─────
export const CHROMA_ECHO_ALPHA = 0.6;
export const CHROMA_TINT_R: readonly [number, number, number] = [1, 0.16, 0.16];
export const CHROMA_TINT_B: readonly [number, number, number] = [0.25, 0.45, 1];
/** Object-space z push behind the main text for the echo meshes, em. */
export const CHROMA_ECHO_Z_EM = 0.02;
/** clipFinal horizontal padding, em (the mask axis is vertical; sideways ink must never shave). */
export const CLIP_PAD_X_EM = 0.2;

const glslFloat = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const glslVec3 = (v: readonly [number, number, number]) => `vec3(${v.map(glslFloat).join(", ")})`;

const PACK_VERTEX_DEFS = /* glsl */ `
uniform vec4 uGanUnitD[${N}];
uniform vec4 uGanUnitE[${N}];
uniform vec4 uGanUnitF[${N}];
varying vec4 vGanClip;
varying vec2 vGanPosL;
varying vec3 vGanMixWS;
`;

// Pack globals: the over walk stashes the glyph half-size; the under layer reports its halo grow for the over outro's UV re-centre.
const PACK_SHARED_DEFS = /* glsl */ `
vec2 ganHalfG;
vec2 ganGrowG;
`;

const PACK_OVER_WALK = /* glsl */ `
ganHalfG = (aTroikaGlyphBounds.zw - aTroikaGlyphBounds.xy) * 0.5;
`;

// Halo grow first (outward weight/soft need SDF samples past the glyph cell: the quad grows about the glyph centre, distances extrapolate off the cell edge, the outline-blur precedent), then the unit-centre anisotropic scale, then the rotX card tip (the twist convention on the Y axis: positive tips the top away).
const PACK_VERTEX_TRANSFORM = /* glsl */ `
vec4 ganD = uGanUnitD[ganUnit];
vec4 ganE = uGanUnitE[ganUnit];
ganGrowG = vec2(1.0);
float ganHalo = max(ganE.y, max(ganE.x, 0.0));
if (ganHalo > 0.0) {
  ganGrowG = (ganHalfG + vec2(ganHalo)) / max(ganHalfG, vec2(1e-6));
  position.xy = ganCenterG + (position.xy - ganCenterG) * ganGrowG;
}
if (ganD.y != 1.0 || ganD.z != 1.0) {
  vec2 ganUnitCtr = vec2(uGanUnitB[ganUnit].w, ganE.w);
  position.xy = ganUnitCtr + (position.xy - ganUnitCtr) * vec2(ganD.y, ganD.z);
}
if (ganD.x != 0.0) {
  float ganRelY = position.y - ganE.w;
  position.y = ganE.w + ganRelY * cos(ganD.x);
  position.z -= ganRelY * sin(ganD.x);
}
`;

// Captured after every geometry term so the clip tests the MOVED unit against its fixed final rect.
const PACK_VERTEX_TAIL = /* glsl */ `
vGanClip = uGanUnitF[ganUnit];
vGanPosL = position.xy;
vGanMixWS = vec3(ganD.w, ganE.x, ganE.y);
`;

// One chromatic echo draw: shifted along X by the unit's chroma split, invisible while the split is zero.
const echoVertexFor = (sign: 1 | -1) => /* glsl */ `
position.x += ${sign === 1 ? "" : "-"}ganE.z;
vGanAlpha *= ganE.z > 0.0 ? ${glslFloat(CHROMA_ECHO_ALPHA)} : 0.0;
`;

// The under layer grew the quad about the glyph centre AFTER troika mapped its sampling UV, so re-centre the UV by the same factor here (the outermost main, after the whole chain).
const PACK_OVER_OUTRO = /* glsl */ `
if (ganGrowG.x != 1.0 || ganGrowG.y != 1.0) {
  vTroikaGlyphUV = (vTroikaGlyphUV - vec2(0.5)) * ganGrowG + vec2(0.5);
}
`;

const PACK_FRAGMENT_DEFS = /* glsl */ `
uniform vec3 uGanAccent;
varying vec4 vGanClip;
varying vec2 vGanPosL;
varying vec3 vGanMixWS;
float ganFillA;
`;

// clipFinal is a hard layout-space rect over the moved unit; colorMix pulls the fill toward the accent (mix by exactly 0.0 is fp-exact, the guard keeps it structural).
const PACK_FRAGMENT = /* glsl */ `
gl_FragColor.a *= step(vGanClip.x, vGanPosL.x) * step(vGanPosL.x, vGanClip.z) * step(vGanClip.y, vGanPosL.y) * step(vGanPosL.y, vGanClip.w);
if (vGanMixWS.x > 0.0) {
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uGanAccent, vGanMixWS.x);
}
`;

const echoFragmentFor = (sign: 1 | -1) => /* glsl */ `
gl_FragColor.rgb *= ${glslVec3(sign === 1 ? CHROMA_TINT_R : CHROMA_TINT_B)};
`;

// The under layer runs before troika's SDF coverage, so the fill alpha is stashed for the over layer's re-threshold.
const PACK_FRAGMENT_STASH = /* glsl */ `
ganFillA = gl_FragColor.a;
`;

// The over re-threshold: weight shifts troika's SDF edge (+ bolder), soft widens the AA band; it runs AFTER troika's coverage, rebuilding alpha from the stashed fill via troika's own distance functions, and restores the edge discard the pack rewriter removed.
const PACK_OVER_FRAGMENT = /* glsl */ `
if (vGanMixWS.y != 0.0 || vGanMixWS.z > 0.0) {
  float ganAA = max(troikaGetAADist(), uTroikaBlurRadius);
  gl_FragColor.a = ganFillA * uTroikaFillOpacity * troikaGetEdgeAlpha(troikaGetFragDistValue(), uTroikaEdgeOffset + vGanMixWS.y, max(ganAA, vGanMixWS.z));
}
if (gl_FragColor.a == 0.0) discard;
`;

// Troika discards at zero base coverage BEFORE the over layer runs, which would kill every fragment a bolder weight or outward soft halo needs; pack mounts strip it and re-discard after the re-threshold. Pinned to troika 0.52.4's exact bytes (re-check on any troika upgrade).
const TROIKA_EDGE_DISCARD_RE = /if \(edgeAlpha == 0\.0\) \{\s*discard;\s*\}/;
function stripTroikaEdgeDiscard(shaders: { vertexShader: string; fragmentShader: string }): {
  vertexShader: string;
  fragmentShader: string;
} {
  const { vertexShader, fragmentShader } = shaders;
  if (!TROIKA_EDGE_DISCARD_RE.test(fragmentShader)) {
    console.warn(
      "[text] troika edge discard not found; pack soft halos will clip at the cell edge",
    );
    return { vertexShader, fragmentShader };
  }
  return { vertexShader, fragmentShader: fragmentShader.replace(TROIKA_EDGE_DISCARD_RE, "") };
}

const FRAGMENT_DEFS = /* glsl */ `
varying float vGanAlpha;
varying vec2 vGanSweep;
varying float vGanX;
`;

// Sweep is a hard-edged reveal window in layout x (mask-reveal); other presets pass (-1e30, 1e30) so the steps resolve to 1.
const FRAGMENT_COLOR_TRANSFORM = /* glsl */ `
gl_FragColor.a *= vGanAlpha * step(vGanSweep.x, vGanX) * step(vGanX, vGanSweep.y);
`;

// ── The shine feature, appended ONLY when the variant enables it, so the feature-off GLSL stays byte-identical to the v8 program (standing stagger projects compile the exact same shader; their EQUAL is structural, not hoped-for). ────────────
const SHINE_VERTEX_DEFS = /* glsl */ `
varying vec2 vGanPos;
`;

// The band must live in whole-ELEMENT layout space, but `position` here is still the glyph-local quad interpolant (see the VERTEX_TRANSFORM note); capturing it raw gave every glyph its own private band (per-character shimmer). Reconstruct the glyph-placed layout position with troika's own mapping instead: one band then sweeps the element, in the same space as the CPU-side blockBounds band.
const SHINE_VERTEX_PRELUDE = /* glsl */ `
vGanPos = mix(aTroikaGlyphBounds.xy, aTroikaGlyphBounds.zw, position.xy);
`;

const SHINE_FRAGMENT_DEFS = /* glsl */ `
// (centerS, invHalfWidthS, intensity, enabled) along uGanShineAxis in layout space.
uniform vec4 uGanShine;
uniform vec2 uGanShineAxis;
varying vec2 vGanPos;
`;

// A soft smoothstep band, self-masked to glyph coverage by the straight-alpha blend (src RGB is multiplied by src alpha at blend time). TWO lifts so the shimmer reads on ANY text colour: the rgb add brightens dark glyphs, and the ALPHA lift renders the band fully opaque against the mid-fade rest, so near-white glyphs (where an additive white clamps into nothing on the 8-bit path) still show a clean sweeping band.
const SHINE_FRAGMENT = /* glsl */ `
if (uGanShine.w > 0.5) {
  float ganShineD = abs(dot(vGanPos, uGanShineAxis) - uGanShine.x) * uGanShine.y;
  float ganShineT = clamp(1.0 - ganShineD, 0.0, 1.0);
  float ganShine = (ganShineT * ganShineT * (3.0 - 2.0 * ganShineT)) * uGanShine.z;
  gl_FragColor.rgb += ganShine;
  gl_FragColor.a = clamp(gl_FragColor.a + ganShine, 0.0, 1.0);
}
`;

// The tinted band variant (glint-wipe's accent leading edge): its own gated bytes, so the plain shine program stays byte-frozen.
const SHINE_FRAGMENT_TINT_DEFS = /* glsl */ `
uniform vec3 uGanShineTint;
`;

const SHINE_FRAGMENT_TINT = /* glsl */ `
if (uGanShine.w > 0.5) {
  float ganShineD = abs(dot(vGanPos, uGanShineAxis) - uGanShine.x) * uGanShine.y;
  float ganShineT = clamp(1.0 - ganShineD, 0.0, 1.0);
  float ganShine = (ganShineT * ganShineT * (3.0 - 2.0 * ganShineT)) * uGanShine.z;
  gl_FragColor.rgb += ganShine * uGanShineTint;
  gl_FragColor.a = clamp(gl_FragColor.a + ganShine, 0.0, 1.0);
}
`;

// ── The text-look extension (the style catalogue's shader terms): gradient's block-bounds mix and arc's baseline bend, each on its own mount-gated bytes so look-off variants compile their exact existing programs. Both key off the glyph's REST layout, so they stay block-stable under every per-unit motion term. ──
const LOOK_REST_VERTEX_DEFS = /* glsl */ `
varying vec2 vGanRest;
`;

// Rest layout position via troika's own interpolant mapping (the shine prelude's formula), captured in the over layer before placement, so it never sees the motion transforms.
const LOOK_REST_CAPTURE = /* glsl */ `
vGanRest = mix(aTroikaGlyphBounds.xy, aTroikaGlyphBounds.zw, position.xy);
`;

const GRADIENT_FRAGMENT_DEFS = /* glsl */ `
// (axisX, axisY, sHi, invRange); invRange 0 until the block measures keeps the plain fill.
uniform vec4 uGanGrad;
uniform vec3 uGanGradA;
uniform vec3 uGanGradB;
varying vec2 vGanRest;
`;

const GRADIENT_FRAGMENT = /* glsl */ `
if (uGanGrad.w != 0.0) {
  float ganGradT = clamp((uGanGrad.z - dot(vGanRest, uGanGrad.xy)) * uGanGrad.w, 0.0, 1.0);
  gl_FragColor.rgb = mix(uGanGradA, uGanGradB, ganGradT);
}
`;

const ARC_VERTEX_DEFS = /* glsl */ `
// (invRadius, blockCenterX, 0); invRadius 0 (unmeasured or zero curve) is the exact identity.
uniform vec3 uGanArc;
`;

// The baseline bend, applied LAST on true layout geometry (arc forces the sandwich): a rigid turn about the glyph's REST centre by theta = (restCx − blockCx) / R plus the arc displacement. Unit walks, sweeps and clip rects all ran on flat layout first, so decision edges stay unbent.
const ARC_VERTEX_TRANSFORM = /* glsl */ `
if (uGanArc.x != 0.0) {
  float ganArcT = (ganCenterG.x - uGanArc.y) * uGanArc.x;
  float ganArcC = cos(ganArcT);
  float ganArcS = sin(ganArcT);
  vec2 ganArcRel = position.xy - ganCenterG;
  position.xy = ganCenterG
    + vec2(ganArcRel.x * ganArcC - ganArcRel.y * ganArcS, ganArcRel.x * ganArcS + ganArcRel.y * ganArcC)
    + vec2(ganArcS / uGanArc.x - (ganCenterG.x - uGanArc.y), (1.0 - ganArcC) / uGanArc.x);
}
`;

type DerivedTextMaterial = ReturnType<typeof createDerivedMaterial>;

export interface StaggerTextMaterial {
  material: DerivedTextMaterial;
  /** The resolved mount-constant variant flags (uniform writers gate on these). */
  features: {
    shine: boolean;
    shineTint: boolean;
    axis: StaggerAxis;
    twist: boolean;
    scatter: boolean;
    pack: boolean;
    gradient: boolean;
    arc: boolean;
    echo?: 1 | -1;
  };
  dispose(): void;
}

/** Mount-constant feature flags: each enabled feature appends or swaps its GLSL block; all-off produces the byte-identical v8 program. */
export interface StaggerMaterialFeatures {
  shine?: boolean;
  /** Unit-walk axis: "-y" for the paragraph granularities. Default "x". */
  axis?: StaggerAxis;
  /** Per-unit Y-rotation about the unit centre (twist-scale under stagger). */
  twist?: boolean;
  /** Per-unit roll + z-approach + em-space drift (scatter-scale). */
  scatter?: boolean;
  /** Motion-pack v2 per-unit terms (rotX, aniso scale, clipFinal, colorMix, weight/soft, chroma); mounts the full sandwich with twist + scatter. */
  pack?: boolean;
  /** One chromatic echo draw, offset toward +X (1) or -X (-1) by the unit's chroma split and channel-tinted; implies pack. */
  echo?: 1 | -1;
  /** Tinted shine band (glint-wipe's accent leading edge); implies shine. */
  shineTint?: boolean;
  /** gradient look: block-bounds colour mix keyed on rest layout positions. */
  gradient?: boolean;
  /** arc look: bend glyphs along a circular arc (forces the geometry sandwich). */
  arc?: boolean;
}

export function createStaggerTextMaterial(
  features: StaggerMaterialFeatures = {},
): StaggerTextMaterial {
  const echo = features.echo;
  const pack = features.pack === true || echo !== undefined;
  const shineTint = features.shineTint === true;
  const shine = features.shine === true || shineTint;
  const axisY = features.axis === "-y";
  const twist = features.twist === true || pack;
  const scatter = features.scatter === true || pack;
  const gradient = features.gradient === true;
  const arc = features.arc === true;
  const geometry = twist || scatter || arc;
  const walk = axisY ? VERTEX_TRANSFORM_AXIS_Y : VERTEX_TRANSFORM;
  const resolved = {
    shine,
    shineTint,
    axis: (axisY ? "-y" : "x") as StaggerAxis,
    twist,
    scatter,
    pack,
    gradient,
    arc,
    ...(echo !== undefined ? { echo } : {}),
  };
  const base = new MeshBasicMaterial({ transparent: true });
  const uniforms = {
    uGanCount: { value: 1 },
    uGanEm: { value: 1 },
    uGanEdgeX: { value: new Float32Array(N).fill(EDGE_SENTINEL) },
    uGanUnitA: { value: buildUnitAArray() },
    uGanUnitB: { value: buildUnitBArray() },
    ...(shine
      ? {
          uGanShine: { value: new Vector4(0, 1, 0, 0) },
          uGanShineAxis: { value: new Vector2(SHINE_AXIS[0], SHINE_AXIS[1]) },
        }
      : {}),
    ...(shineTint ? { uGanShineTint: { value: new Color(1, 1, 1) } } : {}),
    ...(scatter ? { uGanUnitC: { value: new Float32Array(N * 4) } } : {}),
    ...(pack
      ? {
          uGanUnitD: { value: buildUnitDArray() },
          uGanUnitE: { value: new Float32Array(N * 4) },
          uGanUnitF: { value: buildUnitFArray() },
          uGanAccent: { value: new Color(1, 1, 1) },
        }
      : {}),
    ...(gradient
      ? {
          uGanGrad: { value: new Vector4(0, 0, 0, 0) },
          uGanGradA: { value: new Color(1, 1, 1) },
          uGanGradB: { value: new Color(1, 1, 1) },
        }
      : {}),
    ...(arc ? { uGanArc: { value: new Vector3(0, 0, 0) } } : {}),
  };
  const shineDefs = shineTint
    ? SHINE_FRAGMENT_DEFS + SHINE_FRAGMENT_TINT_DEFS
    : SHINE_FRAGMENT_DEFS;
  const shineFragment = shineTint ? SHINE_FRAGMENT_TINT : SHINE_FRAGMENT;
  const fragmentDefs =
    FRAGMENT_DEFS +
    (gradient ? GRADIENT_FRAGMENT_DEFS : "") +
    (pack ? PACK_FRAGMENT_DEFS : "") +
    (shine ? shineDefs : "");
  const fragmentColorTransform =
    (gradient ? GRADIENT_FRAGMENT : "") +
    FRAGMENT_COLOR_TRANSFORM +
    (pack ? PACK_FRAGMENT : "") +
    (echo !== undefined ? echoFragmentFor(echo) : "") +
    (shine ? shineFragment : "") +
    (pack ? PACK_FRAGMENT_STASH : "");

  if (!geometry) {
    // The OVER-chain (ours wraps the text material) is byte-frozen: feature-off emits the exact v8 program (walk === VERTEX_TRANSFORM for axis "x"); the shine and gradient variants stay on their gated bytes; axis "-y" swaps only the walk comparison.
    const textMaterial = createTextDerivedMaterial(base);
    const material = createDerivedMaterial(textMaterial, {
      chained: true,
      uniforms,
      vertexDefs:
        VERTEX_DEFS + (shine ? SHINE_VERTEX_DEFS : "") + (gradient ? LOOK_REST_VERTEX_DEFS : ""),
      vertexTransform:
        (shine ? SHINE_VERTEX_PRELUDE : "") + (gradient ? LOOK_REST_CAPTURE : "") + walk,
      fragmentDefs,
      fragmentColorTransform,
    });
    // Present as an already-derived text material so Text's setter adopts it as-is.
    if (!material.isTroikaTextMaterial) {
      Object.defineProperty(material, "isTroikaTextMaterial", { value: true });
    }
    return {
      material,
      features: resolved,
      dispose() {
        material.dispose();
        textMaterial.dispose();
        base.dispose();
      },
    };
  }

  // The geometry sandwich (see the note above): the under-layer declares everything and applies the transforms post-placement; the over-layer walks the unit selection. Pack mounts add the over outro (UV re-centre), the over fragment re-threshold and the discard rewriter, all gated so non-pack sandwiches keep their exact bytes.
  const inner = createDerivedMaterial(base, {
    chained: true,
    uniforms,
    vertexDefs:
      VERTEX_DEFS +
      SANDWICH_SHARED_DEFS +
      (pack ? PACK_SHARED_DEFS : "") +
      (shine ? SHINE_VERTEX_DEFS : "") +
      (scatter ? SCATTER_VERTEX_DEFS : "") +
      (pack ? PACK_VERTEX_DEFS : "") +
      (gradient ? LOOK_REST_VERTEX_DEFS : "") +
      (arc ? ARC_VERTEX_DEFS : ""),
    vertexTransform:
      UNDER_TRANSFORM +
      (pack ? PACK_VERTEX_TRANSFORM : "") +
      (twist ? TWIST_VERTEX_TRANSFORM_LAYOUT : "") +
      (scatter ? SCATTER_VERTEX_TRANSFORM_LAYOUT : "") +
      (echo !== undefined ? echoVertexFor(echo) : "") +
      (pack ? PACK_VERTEX_TAIL : "") +
      (arc ? ARC_VERTEX_TRANSFORM : ""),
    fragmentDefs,
    fragmentColorTransform,
  });
  const textMaterial = createTextDerivedMaterial(inner);
  const material = createDerivedMaterial(textMaterial, {
    chained: true,
    vertexTransform:
      (axisY ? OVER_WALK_AXIS_Y : OVER_WALK) +
      (pack ? PACK_OVER_WALK : "") +
      (shine ? SHINE_VERTEX_PRELUDE : "") +
      (gradient ? LOOK_REST_CAPTURE : ""),
    ...(pack
      ? {
          vertexMainOutro: PACK_OVER_OUTRO,
          fragmentColorTransform: PACK_OVER_FRAGMENT,
          customRewriter: stripTroikaEdgeDiscard,
        }
      : {}),
  });
  // Present as an already-derived text material so Text's setter adopts it as-is.
  if (!material.isTroikaTextMaterial) {
    Object.defineProperty(material, "isTroikaTextMaterial", { value: true });
  }
  return {
    material,
    features: resolved,
    dispose() {
      material.dispose();
      textMaterial.dispose();
      inner.dispose();
      base.dispose();
    },
  };
}

/** Write this frame's shine band. No-op on variants without the feature. */
export function writeShineUniforms(
  mat: StaggerTextMaterial,
  bounds: readonly [number, number, number, number] | null,
  shineU: number,
): void {
  writeShineBand(mat, shineBand(bounds, shineU));
}

/** Write a PRECOMPUTED band (`AnimatedGroup`'s group-space band, already folded into this child's local space). No-op on variants without the feature. */
export function writeShineBand(
  mat: StaggerTextMaterial,
  band: { centerS: number; invHalfWidthS: number } | null,
): void {
  const uniform = mat.material.uniforms.uGanShine?.value as Vector4 | undefined;
  if (!uniform) return;
  if (!band) {
    uniform.set(0, 1, 0, 0);
    return;
  }
  uniform.set(band.centerS, band.invHalfWidthS, SHINE_INTENSITY, 1);
}

/** shineBand's projection maths with a caller-chosen half-width fraction (the glint's tighter band). */
function styledShineBand(
  bounds: readonly [number, number, number, number] | null,
  shineU: number,
  halfWFrac: number,
): { centerS: number; invHalfWidthS: number } | null {
  if (shineU < 0 || !bounds) return null;
  const [minX, minY, maxX, maxY] = bounds;
  const [ax, ay] = SHINE_AXIS;
  const s1 = minX * ax + minY * ay;
  const s2 = maxX * ax + minY * ay;
  const s3 = minX * ax + maxY * ay;
  const s4 = maxX * ax + maxY * ay;
  const sMin = Math.min(s1, s2, s3, s4);
  const sMax = Math.max(s1, s2, s3, s4);
  const halfW = halfWFrac * (sMax - sMin);
  if (halfW <= 0) return null;
  return { centerS: sMin - halfW + (sMax - sMin + 2 * halfW) * shineU, invHalfWidthS: 1 / halfW };
}

/** Glint-wipe's band write: accent tint, GLINT half-width and intensity. No-op on variants without the tinted band. */
export function writeGlintUniforms(
  mat: StaggerTextMaterial,
  bounds: readonly [number, number, number, number] | null,
  shineU: number,
  tint: Color,
): void {
  const uniform = mat.material.uniforms.uGanShine?.value as Vector4 | undefined;
  const tintU = mat.material.uniforms.uGanShineTint?.value as Color | undefined;
  if (!uniform || !tintU) return;
  tintU.copy(tint);
  const band = styledShineBand(bounds, shineU, GLINT_HALF_W);
  if (!band) {
    uniform.set(0, 1, 0, 0);
    return;
  }
  uniform.set(band.centerS, band.invHalfWidthS, GLINT_INTENSITY, 1);
}

/** Write the gradient look's frame values (span from lookStyle's `gradientSpan`); null (unmeasured) parks invRange at 0 so the plain fill shows. No-op on variants without the look. */
export function writeGradientUniforms(
  mat: StaggerTextMaterial,
  span: { ax: number; ay: number; sHi: number; invRange: number } | null,
  a: Color,
  b: Color,
): void {
  const grad = mat.material.uniforms.uGanGrad?.value as Vector4 | undefined;
  if (!grad) return;
  if (span) grad.set(span.ax, span.ay, span.sHi, span.invRange);
  else grad.set(0, 0, 0, 0);
  (mat.material.uniforms.uGanGradA.value as Color).copy(a);
  (mat.material.uniforms.uGanGradB.value as Color).copy(b);
}

/** Write the arc look's frame values (spec from lookStyle's `arcSpec`); null is the exact identity. No-op on variants without the look. */
export function writeArcUniforms(
  mat: StaggerTextMaterial,
  spec: { invRadius: number; centerX: number } | null,
): void {
  const u = mat.material.uniforms.uGanArc?.value as Vector3 | undefined;
  if (!u) return;
  if (spec) u.set(spec.invRadius, spec.centerX, 0);
  else u.set(0, 0, 0);
}

/** A HELD band (frosted's faint cool shine): fixed centre at band-sweep `u`, caller-chosen intensity and tint. Parks the band when unmeasured or at zero intensity; no-op on variants without the feature. */
export function writeHeldShineUniforms(
  mat: StaggerTextMaterial,
  bounds: readonly [number, number, number, number] | null,
  u: number,
  intensity: number,
  tint?: Color,
): void {
  const uniform = mat.material.uniforms.uGanShine?.value as Vector4 | undefined;
  if (!uniform) return;
  const tintU = mat.material.uniforms.uGanShineTint?.value as Color | undefined;
  if (tint && tintU) tintU.copy(tint);
  const band = shineBand(bounds, u);
  if (!band || intensity <= 0) {
    uniform.set(0, 1, 0, 0);
    return;
  }
  uniform.set(band.centerS, band.invHalfWidthS, intensity, 1);
}

function buildUnitAArray(): Float32Array {
  const arr = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    arr[i * 4] = 1; // alpha
    arr[i * 4 + 3] = 1; // scale
  }
  return arr;
}

function buildUnitBArray(): Float32Array {
  const arr = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    arr[i * 4] = -1e30;
    arr[i * 4 + 1] = 1e30;
  }
  return arr;
}

function buildUnitDArray(): Float32Array {
  const arr = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    arr[i * 4 + 1] = 1; // scaleX
    arr[i * 4 + 2] = 1; // scaleY
  }
  return arr;
}

function buildUnitFArray(): Float32Array {
  const arr = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    arr[i * 4] = -1e30;
    arr[i * 4 + 1] = -1e30;
    arr[i * 4 + 2] = 1e30;
    arr[i * 4 + 3] = 1e30;
  }
  return arr;
}

/** Per-frame pack context: the theme accent and the FINAL layout rects (count x [left, bottom, right, top]) for clipFinal units. */
export interface StaggerPackFrame {
  accent: Color;
  clipRects?: Float32Array | null;
}

/** Write this frame's per-unit samples into the material. `units` may be null before the first typeset completes, so the whole block then animates as unit 0 (deterministic: the measured units land on the next committed frame in both preview and export). Twist variants additionally pack (rotYRad, unit centre X) into uGanUnitB.zw, gated on the holder's features so non-twist variants upload exactly the legacy uniform data. Pack mounts route the uniform scale into uGanUnitD (composed with scaleX/scaleY about the UNIT centre) and pre-multiply the em fields to layout units. */
export function writeStaggerUniforms(
  mat: StaggerTextMaterial,
  units: StaggerUnits | null,
  samples: readonly TextUnitSample[],
  fontSize: number,
  packFrame?: StaggerPackFrame,
): void {
  const u = mat.material.uniforms;
  const count = units ? Math.max(1, units.count) : 1;
  u.uGanCount.value = Math.min(count, samples.length);
  u.uGanEm.value = fontSize;
  const edges: Float32Array = u.uGanEdgeX.value;
  const unitA: Float32Array = u.uGanUnitA.value;
  const unitB: Float32Array = u.uGanUnitB.value;
  const scatter = mat.features.scatter;
  const pack = mat.features.pack;
  const unitC: Float32Array | undefined = scatter ? u.uGanUnitC.value : undefined;
  const unitD: Float32Array | undefined = pack ? u.uGanUnitD.value : undefined;
  const unitE: Float32Array | undefined = pack ? u.uGanUnitE.value : undefined;
  const unitF: Float32Array | undefined = pack ? u.uGanUnitF.value : undefined;
  const clipRects = packFrame?.clipRects;
  for (let i = 0; i < u.uGanCount.value; i++) {
    const sample = samples[i];
    edges[i] = units && i < units.count ? units.edgeKey[i] : EDGE_SENTINEL;
    unitA[i * 4] = sample.alpha;
    // Scatter variants route dx/dy through uGanUnitC (applied in em in LAYOUT space); the frozen v8 offset line would rescale them per glyph rect.
    unitA[i * 4 + 1] = scatter ? 0 : sample.dxEm;
    unitA[i * 4 + 2] = scatter ? 0 : sample.dyEm;
    unitA[i * 4 + 3] = pack ? 1 : sample.scale;
    if (units && i < units.count && (sample.sweep[0] > 0 || sample.sweep[1] < 1)) {
      const w = units.endX[i] - units.startX[i];
      unitB[i * 4] = units.startX[i] + sample.sweep[0] * w;
      unitB[i * 4 + 1] = units.startX[i] + sample.sweep[1] * w;
    } else {
      unitB[i * 4] = -1e30;
      unitB[i * 4 + 1] = sample.sweep[1] <= 0 ? -1e30 : 1e30;
    }
    if (mat.features.twist) {
      unitB[i * 4 + 2] = sample.rotYRad;
      unitB[i * 4 + 3] = units && i < units.count ? (units.startX[i] + units.endX[i]) / 2 : 0;
    }
    if (unitC) {
      unitC[i * 4] = sample.rotZRad;
      unitC[i * 4 + 1] = sample.dzEm;
      unitC[i * 4 + 2] = sample.dxEm;
      unitC[i * 4 + 3] = sample.dyEm;
    }
    if (unitD && unitE && unitF) {
      unitD[i * 4] = sample.rotXRad;
      unitD[i * 4 + 1] = sample.scale * sample.scaleX;
      unitD[i * 4 + 2] = sample.scale * sample.scaleY;
      unitD[i * 4 + 3] = sample.colorMix;
      unitE[i * 4] = sample.weightEm * fontSize;
      unitE[i * 4 + 1] = sample.softEm * fontSize;
      unitE[i * 4 + 2] = sample.chromaEm * fontSize;
      unitE[i * 4 + 3] = units && i < units.count ? units.centerY[i] : 0;
      const o = i * 4;
      if (sample.clipFinal && clipRects && o + 3 < clipRects.length) {
        unitF[o] = clipRects[o];
        unitF[o + 1] = clipRects[o + 1];
        unitF[o + 2] = clipRects[o + 2];
        unitF[o + 3] = clipRects[o + 3];
      } else {
        unitF[o] = -1e30;
        unitF[o + 1] = -1e30;
        unitF[o + 2] = 1e30;
        unitF[o + 3] = 1e30;
      }
    }
  }
  if (pack && packFrame) (u.uGanAccent.value as Color).copy(packFrame.accent);
}
