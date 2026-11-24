import { type Mesh, ShaderMaterial } from "three";
import { LENS_DEPTH_LAYER } from "../../engine/lensDepth";

export const REGION_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const ROUNDED_BOX = /* glsl */ `
float roundedBox(vec2 p, vec2 halfSize, float r) {
  vec2 q = abs(p) - halfSize + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

// The card's rounded rect at half coverage, depth only.
const FRAGMENT = /* glsl */ `
uniform vec2 uSize;
uniform float uRadius;
varying vec2 vUv;
${ROUNDED_BOX}
void main() {
  if (roundedBox((vUv - 0.5) * uSize, 0.5 * uSize, uRadius) > 0.0) discard;
  gl_FragColor = vec4(0.0);
}
`;

/** The depth mesh's group order: drawn after everything else in the transparent list, so its depth can never hide a later draw. */
export const REGION_DEPTH_ORDER = Number.MAX_SAFE_INTEGER;

/** Writes a lifted card's depth for lens depth of field, sharing the card's size and corner uniforms so the shapes match. */
export function regionDepthMaterial(card: {
  uSize: { value: unknown };
  uRadius: { value: unknown };
}): ShaderMaterial {
  const material = new ShaderMaterial({
    uniforms: { uSize: card.uSize, uRadius: card.uRadius },
    vertexShader: REGION_VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    colorWrite: false,
    depthWrite: true,
  });
  material.toneMapped = false;
  return material;
}

/** Whether a shape that holds focus mounts its depth copy: only while it has a size and shows at all, so an invisible shape never pins the blur behind it. */
export function holdsFocusNow(width: number, height: number, opacity: number): boolean {
  return width > 0 && height > 0 && opacity > 0;
}

/** Puts the depth mesh on the lens depth layer alone, out of every other camera, shadow and pick. */
export function asRegionDepthMesh(mesh: Mesh | null): void {
  mesh?.layers.set(LENS_DEPTH_LAYER);
}
