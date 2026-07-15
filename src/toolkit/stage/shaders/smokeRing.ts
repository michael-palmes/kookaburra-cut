import type { IUniform } from "three";
import type { ShaderBackgroundDef } from "./types";
import { colorBandingFix, declarePI, textureRandomizerR } from "./utils";

// Adapted from paper-design/shaders shaders/smoke-ring.ts (Apache-2.0). See NOTICE.md.
const MAX_COLORS = 10;
const MAX_NOISE_ITERATIONS = 8;

// language=GLSL
const fragment = /* glsl */ `
uniform float u_time;

uniform sampler2D u_noiseTexture;

uniform vec4 u_colorBack;
uniform vec4 u_colors[${MAX_COLORS}];
uniform float u_colorsCount;

uniform float u_thickness;
uniform float u_radius;
uniform float u_innerShape;
uniform float u_noiseScale;
uniform float u_noiseIterations;

in vec2 v_objectUV;

out vec4 fragColor;

${declarePI}
${textureRandomizerR}
float valueNoise(vec2 st) {
  vec2 i = floor(st);
  vec2 f = fract(st);
  float a = randomR(i);
  float b = randomR(i + vec2(1.0, 0.0));
  float c = randomR(i + vec2(0.0, 1.0));
  float d = randomR(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  float x1 = mix(a, b, u.x);
  float x2 = mix(c, d, u.x);
  return mix(x1, x2, u.y);
}
vec2 fbm(vec2 n0, vec2 n1) {
  vec2 total = vec2(0.0);
  float amplitude = .4;
  for (int i = 0; i < ${MAX_NOISE_ITERATIONS}; i++) {
    if (i >= int(u_noiseIterations)) break;
    total.x += valueNoise(n0) * amplitude;
    total.y += valueNoise(n1) * amplitude;
    n0 *= 1.99;
    n1 *= 1.99;
    amplitude *= 0.65;
  }
  return total;
}

float getNoise(vec2 uv, vec2 pUv, float t) {
  vec2 pUvLeft = pUv + .03 * t;
  float period = max(abs(u_noiseScale * TWO_PI), 1e-6);
  vec2 pUvRight = vec2(fract(pUv.x / period) * period, pUv.y) + .03 * t;
  vec2 noise = fbm(pUvLeft, pUvRight);
  return mix(noise.y, noise.x, smoothstep(-.25, .25, uv.x));
}

float getRingShape(vec2 uv) {
  float radius = u_radius;
  float thickness = u_thickness;

  float distance = length(uv);
  float ringValue = 1. - smoothstep(radius, radius + thickness, distance);
  ringValue *= smoothstep(radius - pow(u_innerShape, 3.) * thickness, radius, distance);

  return ringValue;
}

void main() {
  vec2 shape_uv = v_objectUV;

  float t = u_time;

  float cycleDuration = 3.;
  float period2 = 2.0 * cycleDuration;
  float localTime1 = fract((0.1 * t + cycleDuration) / period2) * period2;
  float localTime2 = fract((0.1 * t) / period2) * period2;
  float timeBlend = .5 + .5 * sin(.1 * t * PI / cycleDuration - .5 * PI);

  float atg = atan(shape_uv.y, shape_uv.x) + .001;
  float l = length(shape_uv);
  float radialOffset = .5 * l - inversesqrt(max(1e-4, l));
  vec2 polar_uv1 = vec2(atg, localTime1 - radialOffset) * u_noiseScale;
  vec2 polar_uv2 = vec2(atg, localTime2 - radialOffset) * u_noiseScale;

  float noise1 = getNoise(shape_uv, polar_uv1, t);
  float noise2 = getNoise(shape_uv, polar_uv2, t);

  float noise = mix(noise1, noise2, timeBlend);

  shape_uv *= (.8 + 1.2 * noise);

  float ringShape = getRingShape(shape_uv);

  float mixer = ringShape * ringShape * (u_colorsCount - 1.);
  int idxLast = int(u_colorsCount) - 1;
  vec4 gradient = u_colors[idxLast];
  gradient.rgb *= gradient.a;
  for (int i = ${MAX_COLORS} - 2; i >= 0; i--) {
    float localT = clamp(mixer - float(idxLast - i - 1), 0., 1.);
    vec4 c = u_colors[i];
    c.rgb *= c.a;
    gradient = mix(gradient, c, localT);
  }

  vec3 color = gradient.rgb * ringShape;
  float opacity = gradient.a * ringShape;

  vec3 bgColor = u_colorBack.rgb * u_colorBack.a;
  color = color + bgColor * (1. - opacity);
  opacity = opacity + u_colorBack.a * (1. - opacity);

  ${colorBandingFix}

  fragColor = vec4(color, opacity);
}
`;

export const smokeRing: ShaderBackgroundDef = {
  id: "smoke-ring",
  name: "Smoke ring",
  fragment,
  colorSlots: [
    { label: "Back", fallback: "#05100f" },
    { label: "Colour 1", fallback: "#326861" },
  ],
  maxColors: MAX_COLORS,
  noise: true,
  params: {
    thickness: { label: "Thickness", default: 0.65, min: 0.01, max: 1, step: 0.01 },
    radius: { label: "Radius", default: 0.25, min: 0, max: 1, step: 0.01 },
    innerShape: { label: "Inner shape", default: 0.7, min: 0, max: 4, step: 0.01 },
    noiseScale: { label: "Noise scale", default: 3, min: 0.01, max: 5, step: 0.01 },
    noiseIterations: { label: "Noise iterations", default: 8, min: 1, max: 8, step: 1 },
  },
  uniforms(colors, params): Record<string, IUniform> {
    const [back, ...rest] = colors;
    const flat: number[] = [];
    for (let i = 0; i < MAX_COLORS; i++) {
      const c = rest[i] ?? [0, 0, 0, 0];
      flat.push(c[0], c[1], c[2], c[3]);
    }
    return {
      u_colorBack: { value: back ?? [0, 0, 0, 1] },
      u_colors: { value: flat },
      u_colorsCount: { value: Math.min(rest.length, MAX_COLORS) },
      u_thickness: { value: params.thickness },
      u_radius: { value: params.radius },
      u_innerShape: { value: params.innerShape },
      u_noiseScale: { value: params.noiseScale },
      u_noiseIterations: { value: params.noiseIterations },
    };
  },
};
