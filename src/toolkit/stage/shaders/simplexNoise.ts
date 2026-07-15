import type { IUniform } from "three";
import type { ShaderBackgroundDef } from "./types";
import { colorBandingFix, simplexNoise as simplexNoiseGlsl } from "./utils";

// Adapted from paper-design/shaders shaders/simplex-noise.ts (Apache-2.0). See NOTICE.md.
const MAX_COLORS = 10;

// language=GLSL
const fragment = /* glsl */ `
uniform float u_time;
uniform float u_scale;

uniform vec4 u_colors[${MAX_COLORS}];
uniform float u_colorsCount;
uniform float u_stepsPerColor;
uniform float u_softness;

in vec2 v_patternUV;

out vec4 fragColor;

${simplexNoiseGlsl}

float getNoise(vec2 uv, float t) {
  float noise = .5 * snoise(uv - vec2(0., .3 * t));
  noise += .5 * snoise(2. * uv + vec2(0., .32 * t));

  return noise;
}

float steppedSmooth(float m, float steps, float softness) {
  float stepT = floor(m * steps) / steps;
  float f = m * steps - floor(m * steps);
  float fw = steps * fwidth(m);
  float smoothed = smoothstep(.5 - softness, min(1., .5 + softness + fw), f);
  return stepT + smoothed / steps;
}

void main() {
  vec2 shape_uv = v_patternUV;
  shape_uv *= .1;

  float t = .2 * u_time;

  float shape = .5 + .5 * getNoise(shape_uv, t);

  bool u_extraSides = true;

  float mixer = shape * (u_colorsCount - 1.);
  if (u_extraSides == true) {
    mixer = (shape - .5 / u_colorsCount) * u_colorsCount;
  }

  float steps = max(1., u_stepsPerColor);

  vec4 gradient = u_colors[0];
  gradient.rgb *= gradient.a;
  for (int i = 1; i < ${MAX_COLORS}; i++) {
    if (i >= int(u_colorsCount)) break;

    float localM = clamp(mixer - float(i - 1), 0., 1.);
    localM = steppedSmooth(localM, steps, .5 * u_softness);

    vec4 c = u_colors[i];
    c.rgb *= c.a;
    gradient = mix(gradient, c, localM);
  }

  if (u_extraSides == true) {
    if ((mixer < 0.) || (mixer > (u_colorsCount - 1.))) {
      float localM = mixer + 1.;
      if (mixer > (u_colorsCount - 1.)) {
        localM = mixer - (u_colorsCount - 1.);
      }
      localM = steppedSmooth(localM, steps, .5 * u_softness);
      vec4 cFst = u_colors[0];
      cFst.rgb *= cFst.a;
      vec4 cLast = u_colors[int(u_colorsCount - 1.)];
      cLast.rgb *= cLast.a;
      gradient = mix(cLast, cFst, localM);
    }
  }

  vec3 color = gradient.rgb;
  float opacity = gradient.a;

  ${colorBandingFix}

  fragColor = vec4(color, opacity);
}
`;

export const simplexNoise: ShaderBackgroundDef = {
  id: "simplex-noise",
  name: "Simplex noise",
  fragment,
  colorSlots: [
    { label: "Colour 1", fallback: "#0b101d" },
    { label: "Colour 2", fallback: "#151e31" },
    { label: "Colour 3", fallback: "#223048" },
    { label: "Colour 4", fallback: "#334666" },
    { label: "Colour 5", fallback: "#47608c" },
  ],
  maxColors: MAX_COLORS,
  params: {
    stepsPerColor: { label: "Steps per colour", default: 2, min: 1, max: 10, step: 1 },
    softness: { label: "Softness", default: 0, min: 0, max: 1, step: 0.01 },
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
      u_stepsPerColor: { value: params.stepsPerColor },
      u_softness: { value: params.softness },
    };
  },
};
