import type { SceneDoc, SceneDocCompareDeviceAppearance } from "../../engine/sceneDocSchema";

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
