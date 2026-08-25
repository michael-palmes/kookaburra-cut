import { ease } from "./ease";
import { trackLayout } from "./keyedTrack";
import type { SceneDoc, SceneDocDevicePose } from "./sceneDocSchema";

/** The per-scene device animation track: resolves the sidecar `deviceTrack` block and samples one device's pose at a scene-local time. Pure (no clock reads, no three.js) so preview and export agree by construction; `Device` applies the sampled delta on top of whatever the layout block and its own placement already resolved, and the motion presets still layer over that. */

const REST: ResolvedDevicePose = {
  offset: [0, 0, 0],
  rotationDeg: [0, 0, 0],
  scale: 1,
  lidDeg: undefined,
};

/** A sampled pose with every field present: offsets and rotations ADD to the device's resting pose, scale MULTIPLIES it, and `lidDeg` replaces the device's own when the track carries one. */
export interface ResolvedDevicePose {
  offset: [number, number, number];
  rotationDeg: [number, number, number];
  scale: number;
  lidDeg: number | undefined;
}

export interface ResolvedDeviceTrack {
  keys: Array<{ id: string; tMs: number; pose: Record<string, SceneDocDevicePose> }>;
  segments: Array<{
    fromTMs: number;
    fromPose: Record<string, SceneDocDevicePose>;
    toTMs: number;
    toPose: Record<string, SceneDocDevicePose>;
    ease: string;
  }>;
}

/** The scene's device track with its keys sorted and its segments resolved to times, or null when the scene has none: the null-for-legacy path every untracked scene takes. */
export function resolveDeviceTrack(doc: SceneDoc | undefined): ResolvedDeviceTrack | null {
  const raw = doc?.deviceTrack;
  if (!raw || raw.keys.length === 0) return null;
  const layout = trackLayout<Record<string, SceneDocDevicePose>>({
    keys: raw.keys,
    segments: raw.segments,
  });
  const byId = new Map(layout.keys.map((k) => [k.id, k.pose]));
  return {
    keys: layout.keys.map((k) => ({ id: k.id, tMs: k.tMs, pose: k.pose })),
    segments: layout.segments.map((seg) => ({
      fromTMs: seg.fromTMs,
      fromPose: byId.get(seg.fromId) ?? {},
      toTMs: seg.toTMs,
      toPose: byId.get(seg.toId) ?? {},
      ease: seg.ease,
    })),
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function fill(pose: SceneDocDevicePose | undefined, base: ResolvedDevicePose): ResolvedDevicePose {
  return {
    offset: pose?.offset ? [...pose.offset] : [...base.offset],
    rotationDeg: pose?.rotationDeg ? [...pose.rotationDeg] : [...base.rotationDeg],
    scale: pose?.scale ?? base.scale,
    lidDeg: pose?.lidDeg ?? base.lidDeg,
  };
}

function blend(a: ResolvedDevicePose, b: ResolvedDevicePose, t: number): ResolvedDevicePose {
  return {
    offset: [
      lerp(a.offset[0], b.offset[0], t),
      lerp(a.offset[1], b.offset[1], t),
      lerp(a.offset[2], b.offset[2], t),
    ],
    rotationDeg: [
      lerp(a.rotationDeg[0], b.rotationDeg[0], t),
      lerp(a.rotationDeg[1], b.rotationDeg[1], t),
      lerp(a.rotationDeg[2], b.rotationDeg[2], t),
    ],
    scale: lerp(a.scale, b.scale, t),
    // An absent lid on either end holds the other's, so one keyed lid still animates from the resting angle.
    lidDeg:
      a.lidDeg === undefined && b.lidDeg === undefined
        ? undefined
        : lerp(a.lidDeg ?? (b.lidDeg as number), b.lidDeg ?? (a.lidDeg as number), t),
  };
}

/** One device's pose at scene-local `localMs`: eased interpolation inside a segment, the latest key holding outside one, the first key before the track starts, and the resting pose when the track never mentions this device. `baseLidDeg` is the device's own authored lid, so a track that keys the lid on only some keys still eases from and to it. */
export function deviceTrackPoseAt(
  track: ResolvedDeviceTrack | null,
  deviceId: string,
  localMs: number,
  baseLidDeg?: number,
): ResolvedDevicePose {
  const rest: ResolvedDevicePose = { ...REST, lidDeg: baseLidDeg };
  if (!track) return rest;
  for (const seg of track.segments) {
    if (localMs >= seg.fromTMs && localMs < seg.toTMs) {
      const p = ease(seg.ease, (localMs - seg.fromTMs) / (seg.toTMs - seg.fromTMs));
      return blend(fill(seg.fromPose[deviceId], rest), fill(seg.toPose[deviceId], rest), p);
    }
  }
  if (track.keys.length === 0) return rest;
  let held = track.keys[0];
  for (const key of track.keys) {
    if (key.tMs <= localMs) held = key;
    else break;
  }
  return fill(held.pose[deviceId], rest);
}

/** True when the sampled pose leaves the device exactly where it rests, so callers can skip the delta entirely. */
export function deviceTrackPoseIsRest(pose: ResolvedDevicePose, baseLidDeg?: number): boolean {
  return (
    pose.offset.every((v) => v === 0) &&
    pose.rotationDeg.every((v) => v === 0) &&
    pose.scale === 1 &&
    pose.lidDeg === baseLidDeg
  );
}

/** The pose every device in the scene actually shows at scene-local `t`, in key-pose shape: what "＋ Animation" seeds a new key with, so adding one never visibly moves a device. `lidDeg` is only written for a device that has a hinge. */
export function deviceTrackSnapshotAt(
  track: ResolvedDeviceTrack | null,
  devices: ReadonlyArray<{ id: string; lidDeg?: number }>,
  localMs: number,
): Record<string, SceneDocDevicePose> {
  const snapshot: Record<string, SceneDocDevicePose> = {};
  for (const device of devices) {
    const pose = deviceTrackPoseAt(track, device.id, localMs, device.lidDeg);
    const entry: SceneDocDevicePose = {
      offset: pose.offset,
      rotationDeg: pose.rotationDeg,
      scale: pose.scale,
    };
    if (pose.lidDeg !== undefined) entry.lidDeg = pose.lidDeg;
    snapshot[device.id] = entry;
  }
  return snapshot;
}

/** The key nearest `localMs`, or null when there is no track: what a gizmo drag edits, so shaping an animation by hand always lands on the key the playhead is closest to. Ties take the earlier key, since the keys are already time-sorted. */
export function nearestDeviceKey(
  track: ResolvedDeviceTrack | null,
  localMs: number,
): { id: string; tMs: number; pose: Record<string, SceneDocDevicePose> } | null {
  if (!track || track.keys.length === 0) return null;
  let best = track.keys[0];
  let bestGap = Math.abs(best.tMs - localMs);
  for (const key of track.keys) {
    const gap = Math.abs(key.tMs - localMs);
    if (gap < bestGap) {
      best = key;
      bestGap = gap;
    }
  }
  return best;
}
