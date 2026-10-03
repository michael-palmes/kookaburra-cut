import type { Scene3dBackgroundDef, Scene3dPreviewCamera } from "./types";

/** An orbit pose as a camera sidecar stores it (degrees and world units). */
export interface Scene3dPreviewPose {
  target: [number, number, number];
  azimuthDeg: number;
  elevationDeg: number;
  distance: number;
}

/** Preview-lab poses: `static` is held for every tile, the orbiting kinds hold theirs for stills and sweep the type-card clip across `SCENE3D_PREVIEW_SWEEP`. Pure data: the Node generator imports this file directly. */
export const SCENE3D_PREVIEW_POSES: Record<Scene3dPreviewCamera, Scene3dPreviewPose> = {
  static: { target: [0, 0, 0], azimuthDeg: 14, elevationDeg: 16, distance: 6.5 },
  sweep: { target: [0, 0.6, 0], azimuthDeg: 20, elevationDeg: 6, distance: 7 },
  ceiling: { target: [0, 2, 0], azimuthDeg: 20, elevationDeg: -8, distance: 7 },
};

/** Azimuths the orbiting kinds' type-card clip eases between. */
export const SCENE3D_PREVIEW_SWEEP: readonly [number, number] = [-35, 35];

/** The look's preview-lab camera kind: its own, else static for grids and sweep for every other family. */
export function scene3dPreviewCamera(
  def: Pick<Scene3dBackgroundDef, "family" | "previewCamera">,
): Scene3dPreviewCamera {
  return def.previewCamera ?? (def.family === "grids" ? "static" : "sweep");
}

/** The `camera` block a preview-lab sidecar carries: one held key for stills and static looks, else an eased sweep (`segments` is required beside `keys`). */
export function scene3dPreviewCameraTrack(kind: Scene3dPreviewCamera, clip: boolean) {
  const pose = SCENE3D_PREVIEW_POSES[kind];
  if (kind === "static" || !clip) return { keys: [{ id: "k1", tMs: 0, pose }], segments: [] };
  const [from, to] = SCENE3D_PREVIEW_SWEEP;
  return {
    keys: [
      { id: "k1", tMs: 0, pose: { ...pose, azimuthDeg: from } },
      { id: "k2", tMs: 1900, pose: { ...pose, azimuthDeg: to } },
    ],
    segments: [{ from: "k1", to: "k2", ease: "inOutCubic" }],
  };
}
