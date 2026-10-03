import {
  BackSide,
  type Blending,
  Color,
  FrontSide,
  type IUniform,
  NormalBlending,
  ShaderMaterial,
  type Side,
  Vector2,
} from "three";
import { LOOK_GLSL_FRAGMENT, LOOK_GLSL_VERTEX, LOOK_VERTEX_SHADER } from "./glsl";
import { LOOK_REFERENCE_HEIGHT } from "./stage";

/** What a look material needs. Shaders are GLSL ES 3.00 bodies in three's default dialect (`varying`, `gl_FragColor`); the kit chunks are prepended. The fragment mixes LINEAR colours and ends `main()` with `#include <colorspace_fragment>`. */
export interface LookMaterialSpec {
  /** Stable `<look-id>/<part>` id: the program cache key and material name. */
  key: string;
  fragmentShader: string;
  /** Defaults to LOOK_VERTEX_SHADER (vWorld, vUv, vNormalW, vInstanceColor). */
  vertexShader?: string;
  /** Look-owned uniforms; `uResolution` and `uPx` are engine-owned and added here. */
  uniforms?: Record<string, IUniform>;
  defines?: Record<string, string | number | boolean>;
  transparent?: boolean;
  /** Defaults to `!transparent`. */
  depthWrite?: boolean;
  depthTest?: boolean;
  side?: Side;
  blending?: Blending;
  vertexColors?: boolean;
  /** F11 cutaway shell: inward faces only, so the near half culls away once the camera is outside. */
  cutaway?: boolean;
  /** Opaque cut-outs: alpha becomes MSAA coverage, so procedural silhouettes antialias with depth writes on and no sort. Keep alpha fractional only on the edge ramp (a broad alpha fade dithers). */
  alphaToCoverage?: boolean;
}

const FRAGMENT_ONLY = /\b(fwidth|dFdx|dFdy)\s*\(/;
const FLOAT_HASH = /fract\s*\(\s*sin\s*\(/;
const COLORSPACE_INCLUDE = "#include <colorspace_fragment>";
const OWNED_UNIFORM = /uniform\s+\w+\s[^;]*\b(uResolution|uPx)\b[^;]*;/;

/** Why a spec breaks the look material rules, or null when it is sound. */
export function lookMaterialProblem(spec: LookMaterialSpec): string | null {
  const vertex = spec.vertexShader ?? LOOK_VERTEX_SHADER;
  const fragment = spec.fragmentShader;
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(spec.key)) return "key must be `<look-id>/<part>`";
  if (!fragment.includes(COLORSPACE_INCLUDE))
    return `fragment must end main() with ${COLORSPACE_INCLUDE} (write linear colour, three encodes)`;
  if (FLOAT_HASH.test(vertex) || FLOAT_HASH.test(fragment))
    return "fract(sin()) hashes are driver-defined, use hash11/hash21/hash31/hash22";
  if (FRAGMENT_ONLY.test(vertex)) return "fwidth/dFdx/dFdy are fragment-only";
  if (vertex.includes("gl_FragCoord") || fragment.includes("gl_FragCoord"))
    return "gl_FragCoord scales with the preview DPR, use world or uv space and uPx";
  if (/#version|precision\s+(highp|mediump|lowp)/.test(vertex + fragment))
    return "no #version or precision lines, three prepends them";
  if (OWNED_UNIFORM.test(vertex) || OWNED_UNIFORM.test(fragment))
    return "uResolution and uPx are declared by the kit";
  if (spec.uniforms && ("uResolution" in spec.uniforms || "uPx" in spec.uniforms))
    return "uResolution and uPx are engine-owned, the kit adds and syncs them";
  if (spec.transparent && spec.depthTest === false)
    return "transparent parts draw after opaque content, so depthTest false paints over devices";
  return null;
}

/** The unlit look material: a ShaderMaterial that writes linear light and lets three encode for whatever it draws into (canvas: sRGB in shader; compositor and effects targets: linear, stored once), `toneMapped: false`, and a fixed program cache key. Throws on a rule break so a bad look fails its first capture. */
export function createLookMaterial(spec: LookMaterialSpec): ShaderMaterial {
  const problem = lookMaterialProblem(spec);
  if (problem) throw new Error(`[scene3d kit] look material "${spec.key}": ${problem}`);
  const transparent = spec.transparent ?? false;
  const material = new ShaderMaterial({
    name: `kk-look:${spec.key}`,
    vertexShader: `${LOOK_GLSL_VERTEX}\n${spec.vertexShader ?? LOOK_VERTEX_SHADER}`,
    fragmentShader: `${LOOK_GLSL_FRAGMENT}\n${spec.fragmentShader}`,
    uniforms: {
      ...spec.uniforms,
      uResolution: { value: new Vector2(LOOK_REFERENCE_HEIGHT * (16 / 9), LOOK_REFERENCE_HEIGHT) },
      uPx: { value: 1 },
    },
    defines: spec.defines ?? {},
    transparent,
    depthWrite: spec.depthWrite ?? !transparent,
    depthTest: spec.depthTest ?? true,
    side: spec.cutaway ? BackSide : (spec.side ?? FrontSide),
    blending: spec.blending ?? NormalBlending,
    vertexColors: spec.vertexColors ?? false,
    alphaToCoverage: spec.alphaToCoverage ?? false,
    toneMapped: false,
    fog: false,
    lights: false,
  });
  const cacheKey = `kk-look:${spec.key}`;
  material.customProgramCacheKey = () => cacheKey;
  return material;
}

/** Pins `uResolution`/`uPx` to the export format's pixel size (useFormat), never the preview canvas. */
export function syncLookFrame(material: ShaderMaterial, width: number, height: number): void {
  const res = material.uniforms.uResolution?.value as Vector2 | undefined;
  res?.set(width, height);
  if (material.uniforms.uPx) material.uniforms.uPx.value = height / LOOK_REFERENCE_HEIGHT;
}

/** A preset hex as a linear working-space colour (three converts on parse), ready for a uniform. */
export function lookColor(hex: string): Color {
  return new Color(hex);
}

/** A `{ value: Color }` uniform from a preset hex; update it in place with `uniform.value.set(hex)`. */
export function lookColorUniform(hex: string): IUniform<Color> {
  return { value: new Color(hex) };
}

const luminanceScratch = new Color();

/** A preset hex's relative luminance (WCAG, 0 to 1): compare the backing with the palette to tell light presets from dark. */
export function lookLuminance(hex: string): number {
  const c = luminanceScratch.set(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}
