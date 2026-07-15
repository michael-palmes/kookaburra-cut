import type { IUniform } from "three";
import type { ShaderBackgroundDef } from "./types";
import { colorBandingFix, declarePI, rotation2, simplexNoise } from "./utils";

// Adapted from paper-design/shaders shaders/swirl.ts (Apache-2.0). See NOTICE.md.
const MAX_COLORS = 10;

// language=GLSL
const fragment = /* glsl */ `
uniform float u_time;

uniform vec4 u_colorBack;
uniform vec4 u_colors[${MAX_COLORS}];
uniform float u_colorsCount;
uniform float u_bandCount;
uniform float u_twist;
uniform float u_center;
uniform float u_proportion;
uniform float u_softness;
uniform float u_noise;
uniform float u_noiseFrequency;

in vec2 v_objectUV;

out vec4 fragColor;

${declarePI}
${simplexNoise}
${rotation2}

void main() {
  vec2 shape_uv = v_objectUV;

  float l = length(shape_uv);
  l = max(1e-4, l);

  float t = u_time;

  float angle = ceil(u_bandCount) * atan(shape_uv.y, shape_uv.x) + t;
  float angle_norm = angle / TWO_PI;

  float twist = 3. * clamp(u_twist, 0., 1.);
  float offset = pow(l, -twist) + angle_norm;

  float shape = fract(offset);
  shape = 1. - abs(2. * shape - 1.);
  shape += u_noise * snoise(15. * pow(u_noiseFrequency, 2.) * shape_uv);

  float mid = smoothstep(.2, .2 + .8 * u_center, pow(l, twist));
  shape = mix(0., shape, mid);

  float proportion = clamp(u_proportion, 0., 1.);
  float exponent = mix(.25, 1., proportion * 2.);
  exponent = mix(exponent, 10., max(0., proportion * 2. - 1.));
  shape = pow(shape, exponent);

  float mixer = shape * u_colorsCount;
  vec4 gradient = u_colors[0];
  gradient.rgb *= gradient.a;

  float outerShape = 0.;
  for (int i = 1; i < ${MAX_COLORS + 1}; i++) {
    if (i > int(u_colorsCount)) break;

    float m = clamp(mixer - float(i - 1), 0., 1.);
    float aa = fwidth(m);
    m = smoothstep(.5 - .5 * u_softness - aa, .5 + .5 * u_softness + aa, m);

    if (i == 1) {
      outerShape = m;
    }

    vec4 c = u_colors[i - 1];
    c.rgb *= c.a;
    gradient = mix(gradient, c, m);
  }

  float midAA = .1 * fwidth(pow(l, -twist));
  float outerMid = smoothstep(.2, .2 + midAA, pow(l, twist));
  outerShape = mix(0., outerShape, outerMid);

  vec3 color = gradient.rgb * outerShape;
  float opacity = gradient.a * outerShape;

  vec3 bgColor = u_colorBack.rgb * u_colorBack.a;
  color = color + bgColor * (1.0 - opacity);
  opacity = opacity + u_colorBack.a * (1.0 - opacity);

  ${colorBandingFix}

  fragColor = vec4(color, opacity);
}
`;

export const swirl: ShaderBackgroundDef = {
  id: "swirl",
  name: "Swirl",
  fragment,
  colorSlots: [
    { label: "Back", fallback: "#0a141c" },
    { label: "Colour 1", fallback: "#1e3a50" },
    { label: "Colour 2", fallback: "#38617f" },
    { label: "Colour 3", fallback: "#12242f" },
  ],
  maxColors: MAX_COLORS,
  params: {
    bandCount: { label: "Band count", default: 4, min: 0, max: 15, step: 1 },
    twist: { label: "Twist", default: 0.1, min: 0, max: 1, step: 0.01 },
    center: { label: "Center", default: 0.2, min: 0, max: 1, step: 0.01 },
    proportion: { label: "Proportion", default: 0.5, min: 0, max: 1, step: 0.01 },
    softness: { label: "Softness", default: 0, min: 0, max: 1, step: 0.01 },
    noiseFrequency: { label: "Noise frequency", default: 0.4, min: 0, max: 1, step: 0.01 },
    noise: { label: "Noise", default: 0.2, min: 0, max: 1, step: 0.01 },
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
      u_bandCount: { value: params.bandCount },
      u_twist: { value: params.twist },
      u_center: { value: params.center },
      u_proportion: { value: params.proportion },
      u_softness: { value: params.softness },
      u_noiseFrequency: { value: params.noiseFrequency },
      u_noise: { value: params.noise },
    };
  },
};
