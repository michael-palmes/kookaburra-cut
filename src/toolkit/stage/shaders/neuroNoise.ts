import type { IUniform } from "three";
import type { ShaderBackgroundDef } from "./types";
import { colorBandingFix, rotation2 } from "./utils";

// Adapted from paper-design/shaders shaders/neuro-noise.ts (Apache-2.0). See NOTICE.md.
// Original algorithm: https://x.com/zozuar/status/1625182758745128981/

// language=GLSL
const fragment = /* glsl */ `
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_pixelRatio;

uniform vec4 u_colorFront;
uniform vec4 u_colorMid;
uniform vec4 u_colorBack;
uniform float u_brightness;
uniform float u_contrast;

in vec2 v_patternUV;

out vec4 fragColor;

${rotation2}

float neuroShape(vec2 uv, float t) {
  vec2 sine_acc = vec2(0.);
  vec2 res = vec2(0.);
  float scale = 8.;

  for (int j = 0; j < 15; j++) {
    uv = rotate(uv, 1.);
    sine_acc = rotate(sine_acc, 1.);
    vec2 layer = uv * scale + float(j) + sine_acc - t;
    sine_acc += sin(layer);
    res += (.5 + .5 * cos(layer)) / scale;
    scale *= (1.2);
  }
  return res.x + res.y;
}

void main() {
  vec2 shape_uv = v_patternUV;
  shape_uv *= .13;

  float t = .5 * u_time;

  float noise = neuroShape(shape_uv, t);

  noise = (1. + u_brightness) * noise * noise;
  noise = pow(noise, .7 + 6. * u_contrast);
  noise = min(1.4, noise);

  float blend = smoothstep(0.7, 1.4, noise);

  vec4 frontC = u_colorFront;
  frontC.rgb *= frontC.a;
  vec4 midC = u_colorMid;
  midC.rgb *= midC.a;
  vec4 blendFront = mix(midC, frontC, blend);

  float safeNoise = max(noise, 0.0);
  vec3 color = blendFront.rgb * safeNoise;
  float opacity = clamp(blendFront.a * safeNoise, 0., 1.);

  vec3 bgColor = u_colorBack.rgb * u_colorBack.a;
  color = color + bgColor * (1. - opacity);
  opacity = opacity + u_colorBack.a * (1. - opacity);

  ${colorBandingFix}

  fragColor = vec4(color, opacity);
}
`;

export const neuroNoise: ShaderBackgroundDef = {
  id: "neuro-noise",
  name: "Neuro noise",
  fragment,
  colorSlots: [
    { label: "Front", fallback: "#52616f" },
    { label: "Mid", fallback: "#232a32" },
    { label: "Back", fallback: "#0b0e12" },
  ],
  params: {
    brightness: { label: "Brightness", default: 0.05, min: 0, max: 1, step: 0.01 },
    contrast: { label: "Contrast", default: 0.3, min: 0, max: 1, step: 0.01 },
  },
  uniforms(colors, params): Record<string, IUniform> {
    const [front, mid, back] = colors;
    return {
      u_colorFront: { value: front ?? [1, 1, 1, 1] },
      u_colorMid: { value: mid ?? [0, 0, 0, 1] },
      u_colorBack: { value: back ?? [0, 0, 0, 1] },
      u_brightness: { value: params.brightness },
      u_contrast: { value: params.contrast },
    };
  },
};
