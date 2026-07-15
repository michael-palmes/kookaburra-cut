/** Shared vertex shader for shader backgrounds: reproduces paper-design's `v_objectUV`/`v_patternUV` maths for the ONE case this engine renders — a camera-locked quad that always covers the frame — with `u_resolution` pinned to the EXPORT format pixels (never the live canvas size) so preview and export typeset the pattern identically. Derivation notes: their `uv = ndc/2` equals three's plane `uv - 0.5`; origin is centre (box-origin terms vanish), pixelRatio 1, fit multiplier 1. */
// language=GLSL
export const shaderBackgroundVertex: string = /* glsl */ `
uniform vec2 u_resolution;
uniform float u_scale;
uniform float u_rotation;
uniform float u_offsetX;
uniform float u_offsetY;

out vec2 v_objectUV;
out vec2 v_patternUV;

void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

  vec2 st = uv - 0.5;
  float r = u_rotation * 3.14159265358979323846 / 180.0;
  mat2 rot = mat2(cos(r), sin(r), -sin(r), cos(r));
  vec2 off = vec2(-u_offsetX, u_offsetY);

  // objectUV: square-normalised so the LONGER frame side spans 1 (their cover fit).
  vec2 ws = u_resolution / max(u_resolution.x, u_resolution.y);
  v_objectUV = rot * ((st * ws + off) / u_scale);

  // patternUV: CSS-pixel-scaled UV, x0.01 (their precision convention).
  v_patternUV = rot * (((st + off) * u_resolution) / u_scale) * 0.01;
}
`;
