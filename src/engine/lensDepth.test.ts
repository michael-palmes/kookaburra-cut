import { PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";
import type { ResolvedDof } from "./dof";
import { LENS_DEPTH_LAYER, withLensDepth } from "./lensDepth";

const pose = (mode: ResolvedDof["mode"], blur: number) => ({ mode, blur }) as ResolvedDof;

function seen(dof: ResolvedDof | null): { during: boolean; after: boolean } {
  const camera = new PerspectiveCamera();
  let during = false;
  withLensDepth(camera, dof, () => {
    during = camera.layers.isEnabled(LENS_DEPTH_LAYER);
  });
  return { during, after: camera.layers.isEnabled(LENS_DEPTH_LAYER) };
}

describe("withLensDepth", () => {
  it("shows the layer only for an active lens pose, then hides it", () => {
    expect(seen(pose("lens", 1))).toEqual({ during: true, after: false });
    expect(seen(pose("lens", 0))).toEqual({ during: false, after: false });
    expect(seen(pose("depth", 1))).toEqual({ during: false, after: false });
    expect(seen(null)).toEqual({ during: false, after: false });
  });

  it("hides the layer again when the draw throws", () => {
    const camera = new PerspectiveCamera();
    expect(() =>
      withLensDepth(camera, pose("lens", 1), () => {
        throw new Error("draw");
      }),
    ).toThrow("draw");
    expect(camera.layers.isEnabled(LENS_DEPTH_LAYER)).toBe(false);
  });

  it("leaves a layer the camera already had", () => {
    const camera = new PerspectiveCamera();
    camera.layers.enable(LENS_DEPTH_LAYER);
    withLensDepth(camera, pose("lens", 1), () => {});
    expect(camera.layers.isEnabled(LENS_DEPTH_LAYER)).toBe(true);
  });
});
