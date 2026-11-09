import { Color, MeshPhysicalMaterial } from "three";

/** A lifted card as a slab of glass (research prototype): the display's texture as emission, and a virtual bevel whose normals tip outward over the last `uBevel` of the rounded rect, so the scene's environment draws real edge lines on it (a warm strip above gives the top edge, a cool one below the rim). Exact colour wherever nothing reflects. */

const PARS = /* glsl */ `
uniform sampler2D uMap;
uniform float uHasMap;
uniform vec2 uOrigin;
uniform vec2 uAxisS;
uniform vec2 uAxisT;
uniform vec2 uSize;
uniform float uRadius;
uniform vec3 uTint;
uniform float uBevel;
varying vec2 vKbUv;
varying vec3 vKbT;
varying vec3 vKbB;
float kbBox(vec2 p, vec2 halfSize, float r) {
  vec2 q = abs(p) - halfSize + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

const COVERAGE = /* glsl */ `
vec2 kbP = (vKbUv - 0.5) * uSize;
float kbD = kbBox(kbP, 0.5 * uSize, uRadius);
float kbAa = max(fwidth(kbD), 1e-6);
float kbCoverage = 1.0 - smoothstep(-kbAa, kbAa, kbD);
if (kbCoverage <= 0.0) discard;
diffuseColor.a *= kbCoverage;
`;

const BEVEL = /* glsl */ `
{
  vec2 e = vec2(0.002, 0.0);
  vec2 g = vec2(
    kbBox(kbP + e.xy, 0.5 * uSize, uRadius) - kbBox(kbP - e.xy, 0.5 * uSize, uRadius),
    kbBox(kbP + e.yx, 0.5 * uSize, uRadius) - kbBox(kbP - e.yx, 0.5 * uSize, uRadius)
  );
  float gl = length(g);
  g = gl > 1e-6 ? g / gl : vec2(0.0);
  float edge = smoothstep(-uBevel, 0.0, kbD);
  vec3 nT = normalize(vec3(g * edge * edge * 2.5, 1.0));
  normal = normalize(nT.x * vKbT + nT.y * vKbB + nT.z * normal);
}
`;

const EMISSIVE = /* glsl */ `
vec2 kbTuv = uOrigin + vKbUv.x * uAxisS + vKbUv.y * uAxisT;
totalEmissiveRadiance = uHasMap > 0.5 ? texture2D(uMap, kbTuv).rgb * uTint : vec3(0.0);
`;

function mustReplace(source: string, anchor: string, replacement: string): string {
  if (!source.includes(anchor)) throw new Error(`screen region glass: anchor missing: ${anchor}`);
  return source.replace(anchor, replacement);
}

/** Shares the card's uniform objects, so ScreenRegion's per-draw updates drive either material. */
export function glassCardMaterial(
  card: Record<string, { value: unknown }>,
  bevel: { value: number },
): MeshPhysicalMaterial {
  const material = new MeshPhysicalMaterial({
    color: new Color(0, 0, 0),
    metalness: 0,
    roughness: 0.05,
    ior: 1.5,
    transparent: true,
    depthWrite: false,
  });
  material.toneMapped = false;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, card, { uBevel: bevel });
    let vs = mustReplace(
      shader.vertexShader,
      "#include <common>",
      "#include <common>\nvarying vec2 vKbUv;\nvarying vec3 vKbT;\nvarying vec3 vKbB;",
    );
    vs = mustReplace(
      vs,
      "#include <begin_vertex>",
      "#include <begin_vertex>\nvKbUv = uv;\nvKbT = normalize(normalMatrix * vec3(1.0, 0.0, 0.0));\nvKbB = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));",
    );
    shader.vertexShader = vs;
    let fs = mustReplace(shader.fragmentShader, "#include <common>", `#include <common>${PARS}`);
    fs = mustReplace(fs, "#include <color_fragment>", `#include <color_fragment>${COVERAGE}`);
    fs = mustReplace(
      fs,
      "#include <normal_fragment_maps>",
      `#include <normal_fragment_maps>${BEVEL}`,
    );
    fs = mustReplace(
      fs,
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>${EMISSIVE}`,
    );
    shader.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => "kookaburra-screen-region-glass-v1";
  return material;
}
