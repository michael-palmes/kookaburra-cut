/** The vendored fragments write display-domain (sRGB) colour raw, which is exact on the canvas but gets a second hardware encode inside the compositor's SRGB8_ALPHA8 A/B targets (the transition flash-to-white). Rerouting main() lets the engine flip the output to linear light for those draws only, so the hardware encode reproduces the canvas bytes; `u_linearOut` is engine-owned (kookaburra-background-authoring skill) and the canvas path (u_linearOut = 0) passes the original value through untouched, keeping solo frames byte-identical. wrap.test.ts pins the two rewrite markers on every def. */

export const FRAGMENT_OUT_MARKER = "out vec4 fragColor;";
export const FRAGMENT_MAIN_MARKER = "void main() {";

export function wrapDisplayDomainFragment(source: string): string {
  return `${source
    .replace(FRAGMENT_OUT_MARKER, "vec4 fragColor;")
    .replace(FRAGMENT_MAIN_MARKER, "void kkSceneMain() {")}
out vec4 kkFragColor;
uniform float u_linearOut;
vec3 kkSrgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
void main() {
  kkSceneMain();
  kkFragColor = u_linearOut > 0.5 ? vec4(kkSrgbToLinear(fragColor.rgb), fragColor.a) : fragColor;
}
`;
}
