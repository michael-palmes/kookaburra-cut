import type { EaseName } from "../../engine/ease";
import { addSegmentAt, setSegmentEase } from "../../engine/keyedTrack";
import {
  deviceTrackPoseAt,
  deviceTrackSnapshotAt,
  nearestDeviceKey,
  resolveDeviceTrack,
} from "../../engine/sceneDeviceTrack";
import type { SceneDoc } from "../../engine/sceneDocSchema";

/** Pure edits behind the foldable inspector. A scene that animates its devices reads the fold from its keys, so a plain write to the device would show nothing: every edit here lands where the scene is actually reading. */

export const FOLD_PRESETS = [
  { id: "closed", label: "Closed", deg: 0 },
  { id: "flex", label: "Flex", deg: 90 },
  { id: "book", label: "Book", deg: 120 },
  { id: "open", label: "Open", deg: 180 },
] as const;
export type FoldPresetId = (typeof FOLD_PRESETS)[number]["id"];

/** One-click Unfold and Fold: about the pace of Apple's own demo, easing in and out so the last degrees linger. */
export const FOLD_ANIMATION_MS = 1300;
export const FOLD_ANIMATION_EASE: EaseName = "inOutCubic";

/** The angle the fold slider edits at `localMs`: the nearest key's when the scene has a device track (the key a write lands on, so the slider never shows an in-between value it cannot set), else the device's own, else the model's default. */
export function foldDegEditing(
  doc: SceneDoc,
  deviceId: string,
  localMs: number,
  defaultDeg: number,
): number {
  const own = doc.devices?.find((device) => device.id === deviceId)?.foldDeg ?? defaultDeg;
  const track = resolveDeviceTrack(doc);
  const nearest = nearestDeviceKey(track, localMs);
  if (!nearest) return own;
  // A key that does not carry the angle holds whatever the track resolves there.
  return (
    nearest.pose[deviceId]?.foldDeg ??
    deviceTrackPoseAt(track, deviceId, nearest.tMs, undefined, own).foldDeg ??
    own
  );
}

/** Sets the fold angle (mutating `doc`): on the key nearest the playhead when the scene has a device track, mirroring how a gizmo drag shapes an animation, else on the device itself. */
export function writeFoldDeg(doc: SceneDoc, deviceId: string, foldDeg: number, localMs: number) {
  const nearest = nearestDeviceKey(resolveDeviceTrack(doc), localMs);
  const key = nearest && doc.deviceTrack?.keys.find((candidate) => candidate.id === nearest.id);
  if (key) {
    key.pose[deviceId] = { ...key.pose[deviceId], foldDeg };
    return;
  }
  const device = doc.devices?.find((candidate) => candidate.id === deviceId);
  if (device) device.foldDeg = foldDeg;
}

/** Adds an unfold (closed to open) or fold (open to closed) at the playhead (mutating `doc`). Both keys are seeded with what every device is showing, so nothing else moves. False when there is no room: the playhead sits inside an existing animation, or too near the scene's end. */
export function addFoldAnimation(
  doc: SceneDoc,
  deviceId: string,
  direction: "unfold" | "fold",
  localMs: number,
  sceneDurationMs: number,
  openDeg: number,
): boolean {
  const [fromDeg, toDeg] = direction === "unfold" ? [0, openDeg] : [openDeg, 0];
  const showing = deviceTrackSnapshotAt(resolveDeviceTrack(doc), doc.devices ?? [], localMs);
  const withFold = (foldDeg: number) => ({
    ...showing,
    [deviceId]: { ...showing[deviceId], foldDeg },
  });
  const before = doc.deviceTrack ?? { keys: [], segments: [] };
  const added = addSegmentAt(
    before,
    localMs,
    withFold(fromDeg),
    withFold(toDeg),
    sceneDurationMs,
    FOLD_ANIMATION_MS,
  );
  if (!added) return false;
  const eased = setSegmentEase(added, added.segments.length - 1, FOLD_ANIMATION_EASE) ?? added;
  // A key already sitting at the playhead is reused as the start, so it takes the starting angle too.
  const segment = eased.segments[eased.segments.length - 1];
  const start = eased.keys.find((key) => key.id === segment.from);
  if (start)
    start.pose = { ...start.pose, [deviceId]: { ...start.pose[deviceId], foldDeg: fromDeg } };
  doc.deviceTrack = eased;
  return true;
}
