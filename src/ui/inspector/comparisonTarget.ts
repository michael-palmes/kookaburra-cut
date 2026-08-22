import type {
  SceneDoc,
  SceneDocCompare,
  SceneDocCompareDeviceAppearance,
  SceneDocCompareKey,
} from "../../engine/sceneDocSchema";

const clone = <T>(value: T | undefined): T | undefined =>
  value === undefined ? undefined : structuredClone(value);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const sideB = (doc: SceneDoc) => {
  doc.compare ??= {};
  doc.compare.b ??= {};
  return doc.compare.b;
};

/** Run the existing background editor against After without changing Before or freezing untouched inherited fields into overrides. */
export function mutateCompareBackgroundTarget(
  doc: SceneDoc,
  mutate: (target: SceneDoc) => void,
): void {
  const ownBackground = doc.background;
  const ownBackdrop = doc.backdrop;
  const inheritedBackground = clone(doc.compare?.b?.background ?? ownBackground);
  const inheritedBackdrop = clone(doc.compare?.b?.backdrop ?? ownBackdrop);
  const startingBackground = clone(inheritedBackground);
  const startingBackdrop = clone(inheritedBackdrop);
  const priorBackground = doc.compare?.b?.background;
  const priorBackdrop = doc.compare?.b?.backdrop;

  doc.background = inheritedBackground;
  doc.backdrop = inheritedBackdrop;
  mutate(doc);
  const writtenBackground = doc.background;
  const writtenBackdrop = doc.backdrop;
  doc.background = ownBackground;
  doc.backdrop = ownBackdrop;

  const side = sideB(doc);
  side.background = same(writtenBackground, startingBackground)
    ? priorBackground
    : writtenBackground;
  side.backdrop = same(writtenBackdrop, startingBackdrop) ? priorBackdrop : writtenBackdrop;
}

/** Run the existing lighting editor against After, starting from Before when no override exists. */
export function mutateCompareLightingTarget(
  doc: SceneDoc,
  mutate: (target: SceneDoc) => void,
): void {
  const own = doc.lighting;
  const prior = doc.compare?.b?.lighting;
  const inherited = clone(prior ?? own);
  const starting = clone(inherited);
  doc.lighting = inherited;
  mutate(doc);
  const written = doc.lighting;
  doc.lighting = own;
  sideB(doc).lighting = same(written, starting) ? prior : written;
}

/** Set one After-only device appearance field. Matching or clearing the Before value restores inheritance and prunes empty records. */
export function setCompareDeviceAppearance<K extends keyof SceneDocCompareDeviceAppearance>(
  doc: SceneDoc,
  deviceId: string,
  field: K,
  value: SceneDocCompareDeviceAppearance[K] | undefined,
): void {
  const inherited = doc.devices?.find((device) => device.id === deviceId)?.[field];
  const shouldInherit = value === undefined || value === inherited;
  const currentMap = doc.compare?.b?.deviceAppearance;
  if (shouldInherit) {
    const current = currentMap?.[deviceId];
    if (!current) return;
    delete current[field];
    if (Object.keys(current).length === 0) delete currentMap[deviceId];
    if (Object.keys(currentMap).length === 0 && doc.compare?.b) {
      delete doc.compare.b.deviceAppearance;
    }
    return;
  }
  const side = sideB(doc);
  side.deviceAppearance ??= {};
  side.deviceAppearance[deviceId] = {
    ...side.deviceAppearance[deviceId],
    [field]: value,
  };
}

/** The divider key the drill's Divider and Angle fields edit: the one nearest `localMs` by absolute time distance, the EARLIER key taking a tie (a playhead sitting exactly between two keys edits the one already passed). Null when the track carries no keys, which is what sends both fields back to the static value and mask angle. */
export function nearestCompareKey(
  keys: readonly SceneDocCompareKey[] | undefined,
  localMs: number,
): SceneDocCompareKey | null {
  let nearest: SceneDocCompareKey | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const key of keys ?? []) {
    const distance = Math.abs(key.tMs - localMs);
    if (distance < best || (nearest !== null && distance === best && key.tMs < nearest.tMs)) {
      nearest = key;
      best = distance;
    }
  }
  return nearest;
}

/** Set the divider position the drill's slider shows: the nearest key's pose with everything else on it (id, time, angle) untouched, or the static `compare.value` on a keyless comparison. */
export function setCompareDividerValue(
  compare: SceneDocCompare,
  localMs: number,
  value: number,
): void {
  const key = nearestCompareKey(compare.track?.keys, localMs);
  if (!key) {
    compare.value = value;
    return;
  }
  key.pose = { ...key.pose, value };
}

/** Set the divider angle the drill's Angle field shows: the nearest key's `pose.angleDeg` (keys without one keep holding the static angle), or `mask.angleDeg` on a keyless comparison. */
export function setCompareDividerAngle(
  compare: SceneDocCompare,
  localMs: number,
  angleDeg: number,
): void {
  const key = nearestCompareKey(compare.track?.keys, localMs);
  if (!key) {
    compare.mask = { ...(compare.mask ?? { type: "linear" }), angleDeg };
    return;
  }
  key.pose = { ...key.pose, angleDeg };
}

/** The Manual motion choice: drop the divider keys so the static Divider slider drives the comparison again. Everything else stays, `animatedTrack` included: the comparison still exists and keeps its lane, which is what separates this from removing the comparison. */
export function clearCompareTrack(doc: SceneDoc): void {
  if (doc.compare) doc.compare.track = undefined;
}

/** Remove every comparison record targeting a deleted device. */
export function pruneCompareDeviceTargets(doc: SceneDoc, deviceId: string): void {
  const side = doc.compare?.b;
  if (!side) return;
  if (side.media) {
    delete side.media[deviceId];
    if (Object.keys(side.media).length === 0) delete side.media;
  }
  if (side.deviceAppearance) {
    delete side.deviceAppearance[deviceId];
    if (Object.keys(side.deviceAppearance).length === 0) delete side.deviceAppearance;
  }
}

/** Carry a device's comparison-specific media and appearance when the base device is duplicated. */
export function duplicateCompareDeviceTargets(
  doc: SceneDoc,
  sourceDeviceId: string,
  targetDeviceId: string,
): void {
  const side = doc.compare?.b;
  if (!side) return;
  const media = side.media?.[sourceDeviceId];
  if (media) {
    side.media ??= {};
    side.media[targetDeviceId] = structuredClone(media);
  }
  const appearance = side.deviceAppearance?.[sourceDeviceId];
  if (appearance) {
    side.deviceAppearance ??= {};
    side.deviceAppearance[targetDeviceId] = structuredClone(appearance);
  }
}
