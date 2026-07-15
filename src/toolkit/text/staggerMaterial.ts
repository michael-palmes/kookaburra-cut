import { MeshBasicMaterial, Vector2, Vector4 } from "three";
import { createTextDerivedMaterial } from "troika-three-text";
import { createDerivedMaterial } from "troika-three-utils";
import {
  EDGE_SENTINEL,
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

type DerivedTextMaterial = ReturnType<typeof createDerivedMaterial>;

export interface StaggerTextMaterial {
  material: DerivedTextMaterial;
  /** The resolved mount-constant variant flags (uniform writers gate on these). */
  features: { shine: boolean; axis: StaggerAxis; twist: boolean; scatter: boolean };
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
}

export function createStaggerTextMaterial(
  features: StaggerMaterialFeatures = {},
): StaggerTextMaterial {
  const shine = features.shine === true;
  const axisY = features.axis === "-y";
  const twist = features.twist === true;
  const scatter = features.scatter === true;
  const geometry = twist || scatter;
  const walk = axisY ? VERTEX_TRANSFORM_AXIS_Y : VERTEX_TRANSFORM;
  const resolved = { shine, axis: (axisY ? "-y" : "x") as StaggerAxis, twist, scatter };
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
    ...(scatter ? { uGanUnitC: { value: new Float32Array(N * 4) } } : {}),
  };
  const fragmentDefs = shine ? FRAGMENT_DEFS + SHINE_FRAGMENT_DEFS : FRAGMENT_DEFS;
  const fragmentColorTransform = shine
    ? FRAGMENT_COLOR_TRANSFORM + SHINE_FRAGMENT
    : FRAGMENT_COLOR_TRANSFORM;

  if (!geometry) {
    // The OVER-chain (ours wraps the text material) is byte-frozen: feature-off emits the exact v8 program (walk === VERTEX_TRANSFORM for axis "x"); the shine variant stays on its gated bytes; axis "-y" swaps only the walk comparison.
    const textMaterial = createTextDerivedMaterial(base);
    const material = createDerivedMaterial(textMaterial, {
      chained: true,
      uniforms,
      vertexDefs: shine ? VERTEX_DEFS + SHINE_VERTEX_DEFS : VERTEX_DEFS,
      vertexTransform: shine ? SHINE_VERTEX_PRELUDE + walk : walk,
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

  // The geometry sandwich (see the note above): the under-layer declares everything and applies the transforms post-placement; the over-layer walks the unit selection.
  const inner = createDerivedMaterial(base, {
    chained: true,
    uniforms,
    vertexDefs:
      VERTEX_DEFS +
      SANDWICH_SHARED_DEFS +
      (shine ? SHINE_VERTEX_DEFS : "") +
      (scatter ? SCATTER_VERTEX_DEFS : ""),
    vertexTransform:
      UNDER_TRANSFORM +
      (twist ? TWIST_VERTEX_TRANSFORM_LAYOUT : "") +
      (scatter ? SCATTER_VERTEX_TRANSFORM_LAYOUT : ""),
    fragmentDefs,
    fragmentColorTransform,
  });
  const textMaterial = createTextDerivedMaterial(inner);
  const material = createDerivedMaterial(textMaterial, {
    chained: true,
    vertexTransform: (axisY ? OVER_WALK_AXIS_Y : OVER_WALK) + (shine ? SHINE_VERTEX_PRELUDE : ""),
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

/** Write this frame's per-unit samples into the material. `units` may be null before the first typeset completes, so the whole block then animates as unit 0 (deterministic: the measured units land on the next committed frame in both preview and export). Twist variants additionally pack (rotYRad, unit centre X) into uGanUnitB.zw, gated on the holder's features so non-twist variants upload exactly the legacy uniform data. */
export function writeStaggerUniforms(
  mat: StaggerTextMaterial,
  units: StaggerUnits | null,
  samples: readonly TextUnitSample[],
  fontSize: number,
): void {
  const u = mat.material.uniforms;
  const count = units ? Math.max(1, units.count) : 1;
  u.uGanCount.value = Math.min(count, samples.length);
  u.uGanEm.value = fontSize;
  const edges: Float32Array = u.uGanEdgeX.value;
  const unitA: Float32Array = u.uGanUnitA.value;
  const unitB: Float32Array = u.uGanUnitB.value;
  const scatter = mat.features.scatter;
  const unitC: Float32Array | undefined = scatter ? u.uGanUnitC.value : undefined;
  for (let i = 0; i < u.uGanCount.value; i++) {
    const sample = samples[i];
    edges[i] = units && i < units.count ? units.edgeKey[i] : EDGE_SENTINEL;
    unitA[i * 4] = sample.alpha;
    // Scatter variants route dx/dy through uGanUnitC (applied in em in LAYOUT space); the frozen v8 offset line would rescale them per glyph rect.
    unitA[i * 4 + 1] = scatter ? 0 : sample.dxEm;
    unitA[i * 4 + 2] = scatter ? 0 : sample.dyEm;
    unitA[i * 4 + 3] = sample.scale;
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
  }
}
