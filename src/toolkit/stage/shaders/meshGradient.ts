import type { IUniform } from "three";
import type { ShaderBackgroundDef } from "./types";
import { declarePI, hash21, rotation2 } from "./utils";

// Adapted from paper-design/shaders shaders/mesh-gradient.ts (Apache-2.0). See NOTICE.md.
const MAX_COLORS = 10;

// language=GLSL
const fragment = /* glsl */ `
uniform float u_time;

uniform vec4 u_colors[${MAX_COLORS}];
uniform float u_colorsCount;

uniform float u_distortion;
uniform float u_swirl;
uniform float u_grainMixer;
uniform float u_grainOverlay;

in vec2 v_objectUV;

out vec4 fragColor;

${declarePI}
${rotation2}
${hash21}

float valueNoise(vec2 st) {
  vec2 i = floor(st);
  vec2 f = fract(st);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  float x1 = mix(a, b, u.x);
  float x2 = mix(c, d, u.x);
  return mix(x1, x2, u.y);
}

float noise(vec2 n, vec2 seedOffset) {
  return valueNoise(n + seedOffset);
}

vec2 getPosition(int i, float t) {
  float a = float(i) * .37;
  float b = .6 + fract(float(i) / 3.) * .9;
  float c = .8 + fract(float(i + 1) / 4.);

  float x = sin(t * b + a);
  float y = cos(t * c + a * 1.5);

  return .5 + .5 * vec2(x, y);
}

void main() {
  vec2 uv = v_objectUV;
  uv += .5;
  vec2 grainUV = uv * 1000.;

  float grain = noise(grainUV, vec2(0.));
  float mixerGrain = .4 * u_grainMixer * (grain - .5);

  const float firstFrameOffset = 41.5;
  float t = .5 * (u_time + firstFrameOffset);

  float radius = smoothstep(0., 1., length(uv - .5));
  float center = 1. - radius;
  for (float i = 1.; i <= 2.; i++) {
    uv.x += u_distortion * center / i * sin(t + i * .4 * smoothstep(.0, 1., uv.y)) * cos(.2 * t + i * 2.4 * smoothstep(.0, 1., uv.y));
    uv.y += u_distortion * center / i * cos(t + i * 2. * smoothstep(.0, 1., uv.x));
  }

  vec2 uvRotated = uv;
  uvRotated -= vec2(.5);
  float angle = 3. * u_swirl * radius;
  uvRotated = rotate(uvRotated, -angle);
  uvRotated += vec2(.5);

  vec3 color = vec3(0.);
  float opacity = 0.;
  float totalWeight = 0.;

  for (int i = 0; i < ${MAX_COLORS}; i++) {
    if (i >= int(u_colorsCount)) break;

    vec2 pos = getPosition(i, t) + mixerGrain;
    vec3 colorFraction = u_colors[i].rgb * u_colors[i].a;
    float opacityFraction = u_colors[i].a;

    float dist = length(uvRotated - pos);

    dist = pow(dist, 3.5);
    float weight = 1. / (dist + 1e-3);
    color += colorFraction * weight;
    opacity += opacityFraction * weight;
    totalWeight += weight;
  }

  color /= max(1e-4, totalWeight);
  opacity /= max(1e-4, totalWeight);

  float grainOverlay = valueNoise(rotate(grainUV, 1.) + vec2(3.));
  grainOverlay = mix(grainOverlay, valueNoise(rotate(grainUV, 2.) + vec2(-1.)), .5);
  grainOverlay = pow(grainOverlay, 1.3);

  float grainOverlayV = grainOverlay * 2. - 1.;
  vec3 grainOverlayColor = vec3(step(0., grainOverlayV));
  float grainOverlayStrength = u_grainOverlay * abs(grainOverlayV);
  grainOverlayStrength = pow(grainOverlayStrength, .8);
  color = mix(color, grainOverlayColor, .35 * grainOverlayStrength);

  opacity += .5 * grainOverlayStrength;
  opacity = clamp(opacity, 0., 1.);

  fragColor = vec4(color, opacity);
}
`;

export const meshGradient: ShaderBackgroundDef = {
  id: "mesh-gradient",
  name: "Mesh gradient",
  fragment,
  colorSlots: [
    { label: "Colour 1", fallback: "#0d1826" },
    { label: "Colour 2", fallback: "#26425c" },
    { label: "Colour 3", fallback: "#406285" },
    { label: "Colour 4", fallback: "#16293c" },
  ],
  maxColors: MAX_COLORS,
  params: {
    distortion: { label: "Distortion", default: 0.8, min: 0, max: 1, step: 0.01 },
    swirl: { label: "Swirl", default: 0.1, min: 0, max: 1, step: 0.01 },
    grainMixer: { label: "Grain mixer", default: 0, min: 0, max: 1, step: 0.01 },
    grainOverlay: { label: "Grain overlay", default: 0, min: 0, max: 1, step: 0.01 },
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
      u_distortion: { value: params.distortion },
      u_swirl: { value: params.swirl },
      u_grainMixer: { value: params.grainMixer },
      u_grainOverlay: { value: params.grainOverlay },
    };
  },
};
