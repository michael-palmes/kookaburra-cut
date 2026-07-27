import type { IUniform } from "three";
import type { ShaderBackgroundDef } from "./types";
import { declarePI, pcgHash01 } from "./utils";

// Original GLSL (no NOTICE entry): a dot lattice with a travelling brightness wave.
// language=GLSL
const fragment = /* glsl */ `
uniform float u_time;

uniform vec4 u_colorBack;
uniform vec4 u_colorDots;
uniform vec4 u_colorAccent;
uniform float u_density;
uniform float u_dotSize;
uniform float u_pulse;
uniform float u_waveWidth;
uniform float u_driftAngle;

in vec2 v_objectUV;

out vec4 fragColor;

${declarePI}
${pcgHash01}

void main() {
  vec2 uv = v_objectUV * u_density;
  vec2 cell = floor(uv);
  vec2 f = fract(uv) - 0.5;
  uvec2 cid = uvec2(ivec2(cell) + 512);

  float r = u_driftAngle * PI / 180.0;
  vec2 dir = vec2(cos(r), sin(r));
  vec2 centre = (cell + 0.5) / u_density;

  // The wave travels along dir; a hashed per-cell jitter keeps the front organic.
  float jitter = 0.35 * hash01(uvec3(cid, 7u));
  float wave =
    0.5 + 0.5 * sin(TWO_PI * (dot(centre, dir) / max(u_waveWidth, 1e-3) + jitter) - u_time);

  float radius = 0.5 * u_dotSize * mix(1.0 - 0.45 * u_pulse, 1.0 + 0.25 * u_pulse, wave);
  float d = length(f);
  float aa = fwidth(d);
  float dotMask = 1.0 - smoothstep(radius - aa, radius + aa, d);

  vec3 dotCol = mix(u_colorDots.rgb, u_colorAccent.rgb, wave * wave);
  vec3 color = mix(u_colorBack.rgb, dotCol, dotMask);
  fragColor = vec4(color, 1.0);
}
`;

export const dotGrid: ShaderBackgroundDef = {
  id: "dot-grid",
  name: "Dot grid",
  fragment,
  colorSlots: [
    { label: "Back", fallback: "#0f141b" },
    { label: "Dots", fallback: "#2e405b" },
    { label: "Accent", fallback: "#416198" },
  ],
  params: {
    density: { label: "Density", default: 14, min: 4, max: 40, step: 1 },
    dotSize: { label: "Dot size", default: 0.35, min: 0.05, max: 0.9, step: 0.01 },
    pulse: { label: "Pulse", default: 0.5, min: 0, max: 1, step: 0.01 },
    waveWidth: { label: "Wave width", default: 0.6, min: 0.1, max: 1.5, step: 0.01 },
    driftAngle: { label: "Drift angle", default: 30, min: 0, max: 360, step: 1 },
  },
  uniforms(colors, params): Record<string, IUniform> {
    return {
      u_colorBack: { value: colors[0] ?? [0, 0, 0, 1] },
      u_colorDots: { value: colors[1] ?? [0, 0, 0, 1] },
      u_colorAccent: { value: colors[2] ?? [0, 0, 0, 1] },
      u_density: { value: params.density },
      u_dotSize: { value: params.dotSize },
      u_pulse: { value: params.pulse },
      u_waveWidth: { value: params.waveWidth },
      u_driftAngle: { value: params.driftAngle },
    };
  },
};
