import type { IUniform } from "three";
import type { ShaderBackgroundDef } from "./types";
import { colorBandingFix, declarePI, rotation2 } from "./utils";

// Adapted from paper-design/shaders shaders/warp.ts (Apache-2.0). See NOTICE.md.
const MAX_COLORS = 10;

// language=GLSL
const fragment = /* glsl */ `
uniform float u_time;
uniform float u_scale;

uniform sampler2D u_noiseTexture;

uniform vec4 u_colors[${MAX_COLORS}];
uniform float u_colorsCount;
uniform float u_proportion;
uniform float u_softness;
uniform float u_shape;
uniform float u_shapeScale;
uniform float u_distortion;
uniform float u_swirl;
uniform float u_swirlIterations;

in vec2 v_patternUV;

out vec4 fragColor;

${declarePI}
${rotation2}
float randomG(vec2 p) {
  vec2 uv = floor(p) / 100. + .5;
  return texture(u_noiseTexture, fract(uv)).g;
}
float valueNoise(vec2 st) {
  vec2 i = floor(st);
  vec2 f = fract(st);
  float a = randomG(i);
  float b = randomG(i + vec2(1.0, 0.0));
  float c = randomG(i + vec2(0.0, 1.0));
  float d = randomG(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  float x1 = mix(a, b, u.x);
  float x2 = mix(c, d, u.x);
  return mix(x1, x2, u.y);
}


void main() {
  vec2 uv = v_patternUV;
  uv *= .5;

  const float firstFrameOffset = 118.;
  float t = 0.0625 * (u_time + firstFrameOffset);

  float n1 = valueNoise(uv * 1. + t);
  float n2 = valueNoise(uv * 2. - t);
  float angle = n1 * TWO_PI;
  uv.x += 4. * u_distortion * n2 * cos(angle);
  uv.y += 4. * u_distortion * n2 * sin(angle);

  float swirl = u_swirl;
  for (int i = 1; i <= 20; i++) {
    if (i >= int(u_swirlIterations)) break;
    float iFloat = float(i);
    //    swirl *= (1. - smoothstep(.0, .25, length(fwidth(uv))));
    uv.x += swirl / iFloat * cos(t + iFloat * 1.5 * uv.y);
    uv.y += swirl / iFloat * cos(t + iFloat * 1. * uv.x);
  }

  float proportion = clamp(u_proportion, 0., 1.);

  float shape = 0.;
  if (u_shape < .5) {
    vec2 checksShape_uv = uv * (.5 + 3.5 * u_shapeScale);
    shape = .5 + .5 * sin(checksShape_uv.x) * cos(checksShape_uv.y);
    shape += .48 * sign(proportion - .5) * pow(abs(proportion - .5), .5);
  } else if (u_shape < 1.5) {
    vec2 stripesShape_uv = uv * (2. * u_shapeScale);
    float f = fract(stripesShape_uv.y);
    shape = smoothstep(.0, .55, f) * (1.0 - smoothstep(.45, 1., f));
    shape += .48 * sign(proportion - .5) * pow(abs(proportion - .5), .5);
  } else {
    float shapeScaling = 5. * (1. - u_shapeScale);
    float e0 = 0.45 - shapeScaling;
    float e1 = 0.55 + shapeScaling;
    shape = smoothstep(min(e0, e1), max(e0, e1), 1.0 - uv.y + 0.3 * (proportion - 0.5));
  }

  float mixer = shape * (u_colorsCount - 1.);
  vec4 gradient = u_colors[0];
  gradient.rgb *= gradient.a;
  float aa = fwidth(shape);
  for (int i = 1; i < ${MAX_COLORS}; i++) {
    if (i >= int(u_colorsCount)) break;
    float m = clamp(mixer - float(i - 1), 0.0, 1.0);

    float localMixerStart = floor(m);
    float softness = .5 * u_softness + fwidth(m);
    float smoothed = smoothstep(max(0., .5 - softness - aa), min(1., .5 + softness + aa), m - localMixerStart);
    float stepped = localMixerStart + smoothed;

    m = mix(stepped, m, u_softness);

    vec4 c = u_colors[i];
    c.rgb *= c.a;
    gradient = mix(gradient, c, m);
  }

  vec3 color = gradient.rgb;
  float opacity = gradient.a;

  ${colorBandingFix}

  fragColor = vec4(color, opacity);
}
`;

export const warp: ShaderBackgroundDef = {
  id: "warp",
  name: "Warp",
  fragment,
  colorSlots: [
    { label: "Colour 1", fallback: "#140d08" },
    { label: "Colour 2", fallback: "#6b4a2a" },
    { label: "Colour 3", fallback: "#2a1c11" },
    { label: "Colour 4", fallback: "#85582f" },
  ],
  maxColors: MAX_COLORS,
  noise: true,
  params: {
    proportion: { label: "Proportion", default: 0.45, min: 0, max: 1, step: 0.01 },
    softness: { label: "Softness", default: 1, min: 0, max: 1, step: 0.01 },
    shape: { label: "Shape", default: 0, min: 0, max: 2, step: 1 },
    shapeScale: { label: "Shape scale", default: 0.1, min: 0, max: 1, step: 0.01 },
    distortion: { label: "Distortion", default: 0.25, min: 0, max: 1, step: 0.01 },
    swirl: { label: "Swirl", default: 0.8, min: 0, max: 1, step: 0.01 },
    swirlIterations: { label: "Swirl iterations", default: 10, min: 0, max: 20, step: 1 },
  },
  uniforms(colors, params): Record<string, IUniform> {
    const flat: number[] = [];
    for (let i = 0; i < MAX_COLORS; i++) {
      const c = colors[i] ?? [0, 0, 0, 0];
      flat.push(c[0], c[1], c[2], c[3]);
    }
    return {
      u_colors: { value: flat },
      u_colorsCount: { value: Math.min(colors.length, MAX_COLORS) },
      u_proportion: { value: params.proportion },
      u_softness: { value: params.softness },
      u_shape: { value: params.shape },
      u_shapeScale: { value: params.shapeScale },
      u_distortion: { value: params.distortion },
      u_swirl: { value: params.swirl },
      u_swirlIterations: { value: params.swirlIterations },
    };
  },
};
