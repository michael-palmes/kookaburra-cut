import type { SceneDoc } from "../../engine/sceneDocSchema";

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
