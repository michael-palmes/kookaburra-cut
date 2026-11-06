/** Fitting a camera to content: the maths behind the Frame-content button and the presets' scaling. Pure, so "what distance frames this box at this lens" is a pinned number rather than a feel. */
import { Euler, Matrix4, Vector3 } from "three";
import {
  type DeviceScreenPose,
  deviceScreenFrame,
  deviceScreenRect,
} from "../toolkit/device/screenAnchor";
import { CAMERA } from "./format";
import type { LayeredScreenshotPlacement, SceneDoc, SceneDocRigPose } from "./sceneDocSchema";
import { resolveLayeredScreenshotPlacement } from "./sceneLayeredScreenshot";
import { resolveSceneDocMedia } from "./sceneMedia";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** An axis-aligned world box, the shape three's `Box3` reports. */
export interface ContentBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** Fraction of the frame left as breathing room around fitted content, matching the safe-area feel. */
export const FRAME_PADDING = 0.12;

/** How far back a camera at `fovDeg` must sit to fit `bounds` in a frame of `aspect`, plus a little air. Returns null for an empty or degenerate box, where "fit" has no meaning. */
export function frameContentDistance(
  bounds: ContentBounds,
  fovDeg: number,
  aspect: number,
  padding = FRAME_PADDING,
): number | null {
  const width = bounds.max[0] - bounds.min[0];
  const height = bounds.max[1] - bounds.min[1];
  const depth = bounds.max[2] - bounds.min[2];
  if (!(width > 0) && !(height > 0)) return null;
  const halfV = Math.tan(fovDeg * DEG2RAD * 0.5);
  const forHeight = height / 2 / halfV;
  const forWidth = width / 2 / (halfV * aspect);
  // Half the box's depth, so the fit measures from its FRONT face rather than its centre.
  return (Math.max(forHeight, forWidth) + depth / 2) * (1 + padding);
}

/** What a scene stages, as a box, derived from the SCENE DOC rather than the live scene graph: device placements, video media and the screenshot stack, else the content plane itself. Doc-derived is the deliberate limit, and the honest one here: it needs no r3f bridge, resolves identically wherever it is called, and covers what an author actually reframes around. Content a scene's TSX places by hand is not counted. */
export function stagedContentBounds(
  doc:
    | (Pick<SceneDoc, "media" | "images" | "videoWindow"> & {
        devices?: { placement?: { position?: [number, number, number] } }[];
        layeredScreenshot?: {
          pose: { pan: [number, number] };
          placement?: Partial<LayeredScreenshotPlacement>;
        };
      })
    | undefined,
  frame: { width: number; height: number },
): ContentBounds {
  const points: [number, number, number][] = [];
  for (const device of doc?.devices ?? []) {
    if (device.placement?.position) points.push(device.placement.position);
  }
  for (const entry of resolveSceneDocMedia(doc)) {
    // Stills sit wherever the scene lays them out and are not what a reframe chases; a video is, and an Overlay-hosted one's placement is a frame fraction, resolved here so the fit follows a moved window.
    if (entry.kind !== "video") continue;
    points.push(
      entry.host === "stage"
        ? entry.stage.position
        : [
            (entry.overlay.position[0] * frame.width) / 2,
            (entry.overlay.position[1] * frame.height) / 2,
            0,
          ],
    );
  }
  if (doc?.layeredScreenshot) {
    const pan = doc.layeredScreenshot.pose.pan;
    const { position } = resolveLayeredScreenshotPlacement(doc.layeredScreenshot.placement);
    points.push([
      pan[0] + (position[0] * frame.width) / 2,
      pan[1] + (position[1] * frame.height) / 2,
      0,
    ]);
  }
  if (points.length === 0) {
    // Nothing staged: frame the content plane, which is what a scene lays out against.
    return {
      min: [-frame.width / 2, -frame.height / 2, 0],
      max: [frame.width / 2, frame.height / 2, 0],
    };
  }
  // Staged objects are points; give each one roughly a device's worth of body so the fit has something to fit.
  const pad = 1.4;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i] - pad);
      max[i] = Math.max(max[i], p[i] + pad);
    }
  }
  return { min, max };
}

/** A free pose that frames `bounds` from the CURRENT view direction: the button reframes without re-angling the shot, which is what makes it feel like a fit rather than a reset. */
export function frameContentPose(
  bounds: ContentBounds,
  pose: SceneDocRigPose,
  fovDeg: number,
  aspect: number,
  padding = FRAME_PADDING,
): SceneDocRigPose | null {
  const distance = frameContentDistance(bounds, fovDeg, aspect, padding);
  if (distance === null) return null;
  const centre: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const dx = pose.position[0] - pose.aim.at[0];
  const dy = pose.position[1] - pose.aim.at[1];
  const dz = pose.position[2] - pose.aim.at[2];
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // A degenerate current pose has no direction to keep, so fall back to looking down -z.
  const back: [number, number, number] =
    length < 1e-9 ? [0, 0, 1] : [dx / length, dy / length, dz / length];
  return {
    ...pose,
    position: [
      centre[0] + back[0] * distance,
      centre[1] + back[1] * distance,
      centre[2] + back[2] * distance,
    ],
    aim: { mode: "point", at: centre },
  };
}

/** How far a camera at `fovDeg` sits from a flat `width` x `height` rect, square on, for the rect to COVER a frame of `aspect` (the near twin of `frameContentDistance`, which contains). `overscan` above 1 pushes in past the edges. Null for a degenerate rect. */
export function frameCoverDistance(
  width: number,
  height: number,
  fovDeg: number,
  aspect: number,
  overscan = 1,
): number | null {
  if (!(width > 0) || !(height > 0) || !(aspect > 0)) return null;
  const halfV = Math.tan(fovDeg * DEG2RAD * 0.5);
  const forHeight = height / 2 / halfV;
  const forWidth = width / 2 / (halfV * aspect);
  return Math.min(forHeight, forWidth) / Math.max(1, overscan);
}

export interface ScreenFillOptions {
  /** The key's lens, written into the pose so the distance and lens agree (default the camera's 45). */
  fovDeg?: number;
  /** Frame width / height (default 16:9). */
  aspect?: number;
  /** 1 fills edge to edge (default); above 1 pushes past the display's edges. */
  overscan?: number;
}

/** A rig pose square on to a device's display, close enough that the display covers the frame and rolled to the display's own up: the first key of a pull-out from inside a screen, or the last of a push into one. `pose` is the device as it renders (placement, layout and grounding, its scale times any multiplier the scene's TSX applies) and the maths reads the model this build renders, so the Android stand-in gets its own display. A point aim at the display's centre, since an object aim follows the device's origin, not its glass. */
export function screenFillPose(
  model: string,
  pose: DeviceScreenPose,
  options: ScreenFillOptions = {},
): SceneDocRigPose | null {
  const fov = options.fovDeg ?? CAMERA.fov;
  const scale = pose.scale ?? 1;
  const rect = deviceScreenRect(model, pose.display);
  const distance = frameCoverDistance(
    rect.width * scale,
    rect.height * scale,
    fov,
    options.aspect ?? 16 / 9,
    options.overscan,
  );
  if (distance === null) return null;
  const { position: local, tiltX } = deviceScreenFrame(model, 0.5, 0.5, 0, pose);
  const [rx, ry, rz] = pose.rotationDeg ?? [0, 0, 0];
  const turn = new Euler(rx * DEG2RAD, ry * DEG2RAD, rz * DEG2RAD);
  const glass = new Euler(tiltX, 0, 0);
  const centre = new Vector3(...local)
    .multiplyScalar(scale)
    .applyEuler(turn)
    .add(new Vector3(...pose.position));
  const normal = new Vector3(0, 0, 1).applyEuler(glass).applyEuler(turn);
  const right = new Vector3(1, 0, 0).applyEuler(turn);
  const eye = centre.clone().addScaledVector(normal, distance);
  // The basis `applyCameraPose` gets from `camera.lookAt`, so the roll lands the display's right edge on the frame's.
  const basis = new Matrix4().lookAt(eye, centre, new Vector3(0, 1, 0));
  const x = new Vector3().setFromMatrixColumn(basis, 0);
  const y = new Vector3().setFromMatrixColumn(basis, 1);
  const rollDeg = Math.atan2(right.dot(y), right.dot(x)) * RAD2DEG;
  const fill: SceneDocRigPose = {
    position: [eye.x, eye.y, eye.z],
    aim: { mode: "point", at: [centre.x, centre.y, centre.z] },
    fov,
  };
  if (Math.abs(rollDeg) > 1e-9) fill.rollDeg = rollDeg;
  return fill;
}
