/** The overlay ("frame") compositing shader: a fullscreen pass that keys the rendered scene texture into a shaped cutout and fills the rest with the panel fill (a flat colour, or a sampled gradient/image texture through `panelMode`; a transparent panel takes the flat route with the backdrop's own colour, and only reaches this pass when the cutout has a shape). Same display-domain semantics as the transition composite (engine/transitionShader.ts): the scene target is a display target holding the canvas's own bytes raw, so a cutout pixel matches a direct scene render; the panel colour arrives linear and encodes in-shader. The cutout SDF and its constants are EXPORT CONTRACT: pure functions of (uv, uniforms), no time, no derivatives (the superellipse edge uses an analytic gradient-normalised distance, not fwidth, so AA is compile-stable). See docs/overlays.md. */

/** Rounded-box family (rect/rounded-rect/circle/capsule via `cutoutRadius`). */
export const CUTOUT_MODE_BOX = 0;
/** Superellipse (squircle) via `cutoutExponent`. */
export const CUTOUT_MODE_SUPERELLIPSE = 1;
/** No cutout: the panel colour fills the whole frame, `sceneTex` is never sampled. */
export const CUTOUT_MODE_NONE = 2;

export const overlayVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const overlayFragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D sceneTex;
  uniform vec3 panelColor;      // linear
  uniform vec4 cutoutRect;      // uv-space x,y,w,h (y-up)
  uniform vec2 cutoutCenter;    // physical (x scaled by aspect, height = 1)
  uniform vec2 cutoutHalf;      // physical half-extents
  uniform float cutoutRadius;   // physical corner radius
  uniform float cutoutExponent; // superellipse exponent
  uniform int cutoutMode;
  uniform float aspect;
  uniform float softness;       // physical edge half-width
  uniform float encodeToLinear; // 1 when the dest hardware-encodes sRGB on store, else 0
  uniform sampler2D panelTex;   // the sampled fill (gradient raster / project image), panelMode 1 only
  uniform int panelMode;        // 0 = flat panelColor (every legacy frame), 1 = sample panelTex
  uniform vec4 panelUv;         // xy scale, zw offset over vUv (the image's cover crop; a gradient stretches with 1,1,0,0)

  vec3 linearToSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  vec3 srgbToLinear(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  }
  vec3 sampleDisplay(sampler2D t, vec2 uv) {
    return linearToSrgb(texture2D(t, clamp(uv, 0.0, 1.0)).rgb);
  }
  // The panel fill in display sRGB. Mode 0 is the flat colour, arithmetically untouched from v1; mode 1 samples the fill texture, a hardware-sRGB upload, so sampleDisplay recovers its stored bytes exactly (the exact-colour discipline the stage fills keep).
  vec3 panelDisplay(vec2 uv) {
    if (panelMode == 1) return sampleDisplay(panelTex, uv * panelUv.xy + panelUv.zw);
    return linearToSrgb(panelColor);
  }

  void main() {
    if (cutoutMode == 2) {
      vec3 panelOnly = panelDisplay(vUv);
      gl_FragColor = vec4(encodeToLinear > 0.5 ? srgbToLinear(panelOnly) : panelOnly, 1.0);
      return;
    }
    vec2 p = vec2(vUv.x * aspect, vUv.y);
    vec2 d = p - cutoutCenter;
    float dist;
    if (cutoutMode == 1) {
      vec2 an = abs(d) / max(cutoutHalf, vec2(1e-6));
      float f = pow(an.x, cutoutExponent) + pow(an.y, cutoutExponent) - 1.0;
      vec2 g = cutoutExponent * pow(an, vec2(cutoutExponent - 1.0)) * sign(d) / max(cutoutHalf, vec2(1e-6));
      dist = f / max(length(g), 1e-6);
    } else {
      vec2 b = cutoutHalf - vec2(cutoutRadius);
      vec2 q = abs(d) - b;
      dist = min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - cutoutRadius;
    }
    float inside = 1.0 - smoothstep(-softness, softness, dist);
    vec2 sceneUv = (vUv - cutoutRect.xy) / cutoutRect.zw;
    vec3 sceneSrgb = texture2D(sceneTex, clamp(sceneUv, 0.0, 1.0)).rgb;
    vec3 panelSrgb = panelDisplay(vUv);
    // A hardware-sRGB dest gets the linear precursor so its encode-on-write lands the same bytes, not a double encode (the brighter-mid-transition bug).
    vec3 outSrgb = mix(panelSrgb, sceneSrgb, inside);
    gl_FragColor = vec4(encodeToLinear > 0.5 ? srgbToLinear(outSrgb) : outSrgb, 1.0);
  }
`;
