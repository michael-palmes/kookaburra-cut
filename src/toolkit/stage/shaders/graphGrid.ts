import type { IUniform } from "three";
import type { ShaderBackgroundDef } from "./types";
import { pcgHash01 } from "./utils";

// Original GLSL (no NOTICE entry): ruled graph paper with a roaming highlight band and hashed cell fills.
// language=GLSL
const fragment = /* glsl */ `
uniform float u_time;

uniform vec4 u_colorBack;
uniform vec4 u_colorLines;
uniform vec4 u_colorHighlight;
uniform vec4 u_colorFill;
uniform float u_density;
uniform float u_lineWeight;
uniform float u_highlightWidth;
uniform float u_fillDensity;
uniform float u_cadence;

in vec2 v_objectUV;

out vec4 fragColor;

${pcgHash01}

void main() {
  vec2 uvo = v_objectUV;
  vec2 uv = uvo * u_density;
  vec2 cell = floor(uv);
  uvec2 cid = uvec2(ivec2(cell) + 512);

  vec2 f = abs(fract(uv) - 0.5);
  float lineDist = 0.5 - max(f.x, f.y);
  float px = max(fwidth(uv.x), fwidth(uv.y));
  float w = mix(0.3, 2.5, u_lineWeight);
  float line = 1.0 - smoothstep(w * px, (w + 1.5) * px, lineDist);

  // A soft highlight band roams the sheet and lights the ruling up as it passes.
  vec2 dir = normalize(vec2(0.8, 0.6));
  float s = dot(uvo, dir);
  float c = 0.55 * sin(0.5 * u_time);
  float band = exp(-((s - c) * (s - c)) / max(2.0 * u_highlightWidth * u_highlightWidth, 1e-4));

  // Cell fills breathe on independent hashed clocks so the sheet never blinks in unison.
  float clock = u_cadence * u_time + hash01(uvec3(cid, 11u));
  float ph = fract(clock);
  uint epoch = uint(int(floor(clock)) & 1023);
  float on = step(hash01(uvec3(cid, epoch)), u_fillDensity);
  float fade = smoothstep(0.0, 0.25, ph) * (1.0 - smoothstep(0.75, 1.0, ph));

  vec3 color = mix(u_colorBack.rgb, u_colorFill.rgb, on * fade * 0.85);
  vec3 lineCol = mix(u_colorLines.rgb, u_colorHighlight.rgb, band);
  color = mix(color, lineCol, line);
  fragColor = vec4(color, 1.0);
}
`;

export const graphGrid: ShaderBackgroundDef = {
  id: "graph-grid",
  name: "Graph grid",
  fragment,
  colorSlots: [
    { label: "Back", fallback: "#18100d" },
    { label: "Lines", fallback: "#5e3e30" },
    { label: "Highlight", fallback: "#8a543b" },
    { label: "Fill", fallback: "#3e2f25" },
  ],
  params: {
    density: { label: "Density", default: 12, min: 4, max: 32, step: 1 },
    lineWeight: { label: "Line weight", default: 0.4, min: 0, max: 1, step: 0.01 },
    highlightWidth: { label: "Highlight width", default: 0.35, min: 0.05, max: 1, step: 0.01 },
    fillDensity: { label: "Fill density", default: 0.18, min: 0, max: 1, step: 0.01 },
    cadence: { label: "Cadence", default: 0.25, min: 0.05, max: 1, step: 0.01 },
  },
  uniforms(colors, params): Record<string, IUniform> {
    return {
      u_colorBack: { value: colors[0] ?? [0, 0, 0, 1] },
      u_colorLines: { value: colors[1] ?? [0, 0, 0, 1] },
      u_colorHighlight: { value: colors[2] ?? [0, 0, 0, 1] },
      u_colorFill: { value: colors[3] ?? [0, 0, 0, 1] },
      u_density: { value: params.density },
      u_lineWeight: { value: params.lineWeight },
      u_highlightWidth: { value: params.highlightWidth },
      u_fillDensity: { value: params.fillDensity },
      u_cadence: { value: params.cadence },
    };
  },
};
