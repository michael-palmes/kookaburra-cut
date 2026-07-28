import type { IUniform } from "three";
import type { ShaderBackgroundDef } from "./types";
import { declarePI, pcgHash01 } from "./utils";

// Original GLSL (no NOTICE entry): a honeycomb lattice whose cells brighten in travelling clusters.
// language=GLSL
const fragment = /* glsl */ `
uniform float u_time;

uniform vec4 u_colorBack;
uniform vec4 u_colorLines;
uniform vec4 u_colorAccent;
uniform float u_density;
uniform float u_lineWeight;
uniform float u_glow;
uniform float u_softness;
uniform float u_cadence;

in vec2 v_objectUV;

out vec4 fragColor;

${declarePI}
${pcgHash01}

const vec2 HEX_S = vec2(1.0, 1.7320508);

float hexDist(vec2 p) {
  p = abs(p);
  return max(dot(p, 0.5 * HEX_S), p.x);
}

vec4 hexCell(vec2 p) {
  vec4 hC = floor(vec4(p, p - vec2(0.5, 1.0)) / HEX_S.xyxy) + 0.5;
  vec4 h = vec4(p - hC.xy * HEX_S, p - (hC.zw + 0.5) * HEX_S);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hC.xy) : vec4(h.zw, hC.zw + 0.5);
}

void main() {
  vec2 uv = v_objectUV * u_density;
  vec4 hc = hexCell(uv);
  float ed = 0.5 - hexDist(hc.xy);

  float px = max(fwidth(uv.x), fwidth(uv.y));
  float w = mix(0.3, 2.2, u_lineWeight);
  float line = 1.0 - smoothstep(w * px, (w + 1.5) * px, ed);

  uvec2 cid = uvec2(ivec2(floor(hc.zw * 2.0 + 0.5)) + 512);
  vec2 centre = hc.zw * HEX_S / u_density;
  vec2 dir = normalize(vec2(0.9, 0.35));
  float jitter = hash01(uvec3(cid, 5u));
  float pulse =
    0.5 + 0.5 * sin(TWO_PI * (1.2 * dot(centre, dir) + 0.6 * jitter) - u_cadence * u_time);
  pulse = pow(pulse, mix(4.0, 1.2, u_softness));

  float interior = smoothstep(0.0, 0.2, ed);
  vec3 color = mix(u_colorBack.rgb, u_colorAccent.rgb, pulse * u_glow * interior);
  color = mix(color, u_colorLines.rgb, line);
  fragColor = vec4(color, 1.0);
}
`;

export const hexGrid: ShaderBackgroundDef = {
  id: "hex-grid",
  name: "Hex grid",
  fragment,
  colorSlots: [
    { label: "Back", fallback: "#0c1612" },
    { label: "Lines", fallback: "#224635" },
    { label: "Accent", fallback: "#2c6b49" },
  ],
  params: {
    density: { label: "Density", default: 9, min: 4, max: 24, step: 1 },
    lineWeight: { label: "Line weight", default: 0.35, min: 0, max: 1, step: 0.01 },
    glow: { label: "Glow", default: 0.6, min: 0, max: 1, step: 0.01 },
    softness: { label: "Softness", default: 0.5, min: 0, max: 1, step: 0.01 },
    cadence: { label: "Cadence", default: 1, min: 0.1, max: 2, step: 0.01 },
  },
  uniforms(colors, params): Record<string, IUniform> {
    return {
      u_colorBack: { value: colors[0] ?? [0, 0, 0, 1] },
      u_colorLines: { value: colors[1] ?? [0, 0, 0, 1] },
      u_colorAccent: { value: colors[2] ?? [0, 0, 0, 1] },
      u_density: { value: params.density },
      u_lineWeight: { value: params.lineWeight },
      u_glow: { value: params.glow },
      u_softness: { value: params.softness },
      u_cadence: { value: params.cadence },
    };
  },
};
