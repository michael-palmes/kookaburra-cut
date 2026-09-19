import type { DeviceMediaSpec } from "../toolkit/device/Device";
import type { SceneDoc, SceneDocDeviceSpec } from "./sceneDocSchema";

/** A device's displays: `main` is every device's screen (a foldable's inside one) and keeps the original `media` field; `cover` is a foldable's outside one. */
export type DeviceScreenSlot = "main" | "cover";

export const DEVICE_SCREEN_SLOTS: readonly DeviceScreenSlot[] = ["main", "cover"];

const FIELD = { main: "media", cover: "coverMedia" } as const;

export function deviceSlotMedia(
  device: Pick<SceneDocDeviceSpec, "media" | "coverMedia"> | undefined,
  slot: DeviceScreenSlot,
): DeviceMediaSpec | undefined {
  return device?.[FIELD[slot]];
}

export function setDeviceSlotMedia(
  device: SceneDocDeviceSpec,
  slot: DeviceScreenSlot,
  media: DeviceMediaSpec | undefined,
): void {
  if (media) device[FIELD[slot]] = media;
  else delete device[FIELD[slot]];
}

/** Side B's own override for one display, never the inherited Before media. */
export function compareSlotMedia(
  doc: SceneDoc | null | undefined,
  deviceId: string,
  slot: DeviceScreenSlot,
): DeviceMediaSpec | undefined {
  return doc?.compare?.b?.[FIELD[slot]]?.[deviceId];
}

/** Writes or clears side B's override IN PLACE (callers hold references to `compare.b`), dropping the map once it empties. No-op without a compare block. */
export function setCompareSlotMedia(
  doc: SceneDoc,
  deviceId: string,
  slot: DeviceScreenSlot,
  media: DeviceMediaSpec | undefined,
): void {
  if (!doc.compare) return;
  const field = FIELD[slot];
  if (media) {
    doc.compare.b ??= {};
    doc.compare.b[field] ??= {};
    doc.compare.b[field][deviceId] = media;
    return;
  }
  const map = doc.compare.b?.[field];
  if (!map) return;
  delete map[deviceId];
  if (Object.keys(map).length === 0) delete doc.compare.b?.[field];
}

/** Every video one device plays, on either display and either comparison side (both sides render, so none may cut short). */
export function deviceVideoSources(
  doc: SceneDoc | null | undefined,
  device: SceneDocDeviceSpec,
): string[] {
  return DEVICE_SCREEN_SLOTS.flatMap((slot) =>
    [deviceSlotMedia(device, slot), compareSlotMedia(doc, device.id, slot)].flatMap((media) =>
      media?.kind === "video" ? [media.src] : [],
    ),
  );
}

export function deviceHasFollowVideo(doc: SceneDoc, deviceId: string): boolean {
  const device = doc.devices?.find((candidate) => candidate.id === deviceId);
  return DEVICE_SCREEN_SLOTS.some(
    (slot) =>
      deviceSlotMedia(device, slot)?.kind === "video" ||
      compareSlotMedia(doc, deviceId, slot)?.kind === "video",
  );
}
