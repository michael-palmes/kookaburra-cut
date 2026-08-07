/** The billboarded chart label's render hook, split out from `chartText.tsx` so it stays pure and testable. Troika's `Text` implements its OWN `onBeforeRender` (glyph sync plus binding the SDF atlas into the derived material), and setting the prop shadows that method on the instance, so a label handed a bare handler typesets nothing and draws nothing. The handler here calls the inherited one first, then rewrites the label's `matrixWorld` from the render camera. */

import type {
  BufferGeometry,
  Camera,
  Group,
  Material,
  Object3D,
  Scene,
  WebGLRenderer,
} from "three";
import { chartBillboardMatrix } from "./chart2dMath";

export type ChartLabelBeforeRender = (
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  geometry: BufferGeometry,
  material: Material,
  group: Group,
) => void;

/** One label's `onBeforeRender`: the class's own handler (never the shadowed instance property), then the billboard transform composed from the frame's camera, so orientation stays a pure function of that camera and Verify passes agree. */
export function chartLabelBeforeRender(
  anchorAt: () => Object3D | null,
  labelAt: () => Object3D | null,
  rotationZ: number,
): ChartLabelBeforeRender {
  return (renderer, scene, camera, geometry, material, group) => {
    const label = labelAt();
    if (!label) return;
    const inherited = (Object.getPrototypeOf(label) as Partial<Object3D>).onBeforeRender;
    inherited?.call(label, renderer, scene, camera, geometry, material, group);
    const anchor = anchorAt();
    if (!anchor) return;
    chartBillboardMatrix(anchor.matrixWorld, camera.quaternion, rotationZ, label.matrixWorld);
  };
}
