import { BlendFunction, Effect } from "postprocessing";

/** Output-space triangular dither at the final 8-bit write (`render.dither`). EXPORT CONTRACT: the noise (interleaved gradient noise, triangular remap), its ±1 level span, the taper at 0 and 255, and the fixed pattern (x264 predicts it across frames, so it survives encoding where per-frame noise is quantised away). */
export const ditherFragment = /* glsl */ `
  float kbDitherIgn(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  float kbDitherTri(float u) {
    float v = u * 2.0 - 1.0;
    return sign(v) * (1.0 - sqrt(max(0.0, 1.0 - abs(v))));
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    outputColor = inputColor;
  #ifdef ENCODE_OUTPUT
    float n = kbDitherTri(kbDitherIgn(floor(gl_FragCoord.xy))) / 255.0;
    vec3 s = sRGBTransferOETF(vec4(clamp(inputColor.rgb, 0.0, 1.0), 1.0)).rgb;
    vec3 taper = clamp(min(s, 1.0 - s) * 255.0, 0.0, 1.0);
    outputColor.rgb = sRGBTransferEOTF(vec4(s + n * taper, 1.0)).rgb;
  #endif
  }
`;

export class DitherEffect extends Effect {
  constructor() {
    super("DitherEffect", ditherFragment, { blendFunction: BlendFunction.NORMAL });
  }
}
