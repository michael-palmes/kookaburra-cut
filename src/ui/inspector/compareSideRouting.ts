import type { SceneDoc } from "../../engine/sceneDocSchema";
import type { DeviceMediaSpec, DeviceShadowMode } from "../../toolkit/device/Device";

/** Which half of a comparison the inspectors edit: "a" is the scene itself, "b" its `compare.b` overrides. ONE value per scene drives the Device, Theme, Background and Lighting surfaces, so the side a person picked in one is the side the next one opens on. */
export type CompareSide = "a" | "b";

/** Whether the side selector shows at all: only a scene that HAS a comparison has two sides to edit. */
export function hasComparison(doc: SceneDoc | null | undefined): boolean {
  return doc?.compare !== undefined;
}

/** The side an edit actually lands on. After resolves to Before wherever the comparison has gone (a removed comparison, another scene's doc), which is the guard behind the data-correctness rule: a stale After pick can never repoint Before. */
export function activeCompareSide(
  doc: SceneDoc | null | undefined,
  side: CompareSide,
): CompareSide {
  return side === "b" && hasComparison(doc) ? "b" : "a";
}

/** The background and lighting drills' existing write target, named from the active side. */
export function compareEditTarget(
  doc: SceneDoc | null | undefined,
  side: CompareSide,
): "scene" | "compareB" {
  return activeCompareSide(doc, side) === "b" ? "compareB" : "scene";
}

/** The theme the Theme drill shows for a side; "" is the follow choice (the project theme for Before, Before itself for After). */
export function compareThemeIdForSide(doc: SceneDoc | null | undefined, side: CompareSide): string {
  if (activeCompareSide(doc, side) === "b") return doc?.compare?.b?.themeId ?? "";
  return doc?.themeId ?? "";
}

/** Apply a theme choice to one side. After writes `compare.b.themeId` and never touches the scene's own theme; "" clears the override back to inheritance. */
export function setThemeForSide(doc: SceneDoc, side: CompareSide, themeId: string): void {
  if (activeCompareSide(doc, side) === "b" && doc.compare) {
    doc.compare.b ??= {};
    doc.compare.b.themeId = themeId || undefined;
    return;
  }
  doc.themeId = themeId || undefined;
}

/** What one device shows and writes on one side. After reads through to Before for anything it has not overridden, and its media actions target `compare.b.media` even while inheriting, so editing an inherited video creates the override instead of re-pointing Before. */
export interface DeviceSideRouting {
  media: DeviceMediaSpec | undefined;
  /** After is showing Before's media because it holds no override of its own. */
  inheritsMedia: boolean;
  colour: string | undefined;
  shadow: DeviceShadowMode | undefined;
  /** After holds a colour or shadow override for this device. */
  overridesAppearance: boolean;
  /** Where Change screen media writes. */
  mediaTarget: "device" | "compareDevice";
  /** Where Edit opens (a still joins the editor as a freeze-frame); null when this side resolves to no media. */
  editVideoTarget: "device" | "compareDevice" | null;
}

export function deviceSideRouting(
  doc: SceneDoc | null | undefined,
  deviceId: string,
  side: CompareSide,
): DeviceSideRouting {
  const after = activeCompareSide(doc, side) === "b";
  const device = doc?.devices?.find((candidate) => candidate.id === deviceId);
  const mediaOverride = after ? doc?.compare?.b?.media?.[deviceId] : undefined;
  const appearance = after ? doc?.compare?.b?.deviceAppearance?.[deviceId] : undefined;
  const media = mediaOverride ?? device?.media;
  const target = after ? "compareDevice" : "device";
  return {
    media,
    inheritsMedia: after && mediaOverride === undefined,
    colour: appearance?.colour ?? device?.colour,
    shadow: appearance?.shadow ?? device?.shadow,
    overridesAppearance: appearance?.colour !== undefined || appearance?.shadow !== undefined,
    mediaTarget: target,
    editVideoTarget: media ? target : null,
  };
}
