import type { IUniform } from "three";
import type { ShaderBackgroundDef } from "./types";

// Original GLSL (no NOTICE entry): a perspective floor grid scrolling toward a glowing horizon.
// language=GLSL
const fragment = /* glsl */ `
uniform float u_time;

uniform vec4 u_colorBack;
uniform vec4 u_colorLines;
uniform vec4 u_colorGlow;
uniform float u_horizon;
uniform float u_density;
uniform float u_lineWeight;
uniform float u_glow;
uniform float u_fade;

in vec2 v_objectUV;

out vec4 fragColor;

void main() {
  vec2 uv = v_objectUV;
  float below = u_horizon - uv.y;

  vec3 color = u_colorBack.rgb;
  if (below > 0.0) {
    float depth = 1.0 / max(below, 1e-3);
    vec2 world = vec2(uv.x * depth, depth) * (u_density * 0.08);
    world.y += 0.5 * u_time;

    vec2 f = abs(fract(world) - 0.5);
    vec2 pxw = vec2(fwidth(world.x), fwidth(world.y));
    float w = mix(0.3, 2.5, u_lineWeight);
    float lx = 1.0 - smoothstep(w * pxw.x, (w + 1.5) * pxw.x, 0.5 - f.x);
    float lz = 1.0 - smoothstep(w * pxw.y, (w + 1.5) * pxw.y, 0.5 - f.y);
    float line = max(lx, lz);

    // Full strength up close, dissolving into the back colour toward the horizon.
    float fog = exp(-max(depth - 3.0, 0.0) * mix(0.30, 0.02, u_fade));
    color = mix(color, u_colorLines.rgb, line * fog);
  }

  float glowBand = exp(-abs(uv.y - u_horizon) * mix(60.0, 8.0, u_glow));
  color = mix(color, u_colorGlow.rgb, glowBand * 0.8);
  fragColor = vec4(color, 1.0);
}
`;

export const horizonGrid: ShaderBackgroundDef = {
  id: "horizon-grid",
  name: "Horizon grid",
  fragment,
  colorSlots: [
    { label: "Back", fallback: "#150e0b" },
    { label: "Lines", fallback: "#6b4c37" },
    { label: "Glow", fallback: "#805936" },
  ],
  params: {
    horizon: { label: "Horizon", default: 0.05, min: -0.3, max: 0.3, step: 0.01 },
    density: { label: "Density", default: 14, min: 4, max: 40, step: 1 },
    lineWeight: { label: "Line weight", default: 0.4, min: 0, max: 1, step: 0.01 },
    glow: { label: "Glow", default: 0.5, min: 0, max: 1, step: 0.01 },
    fade: { label: "Fade", default: 0.6, min: 0, max: 1, step: 0.01 },
  },
  uniforms(colors, params): Record<string, IUniform> {
    return {
      u_colorBack: { value: colors[0] ?? [0, 0, 0, 1] },
      u_colorLines: { value: colors[1] ?? [0, 0, 0, 1] },
      u_colorGlow: { value: colors[2] ?? [0, 0, 0, 1] },
      u_horizon: { value: params.horizon },
      u_density: { value: params.density },
      u_lineWeight: { value: params.lineWeight },
      u_glow: { value: params.glow },
      u_fade: { value: params.fade },
    };
  },
};
