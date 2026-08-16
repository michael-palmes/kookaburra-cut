import type { RigDoc } from "../../engine/sceneCameraEdit";
import type {
  DeviceLayoutPreset,
  SceneDoc,
  SceneDocDeviceLayout,
  SceneDocDeviceSpec,
} from "../../engine/sceneDocSchema";
import { bakeRigBinding } from "../../engine/sceneRigConvert";
import {
  customColourHex,
  DEVICE_CATALOG,
  type DeviceId,
  isDeviceId,
} from "../../toolkit/device/catalog";
import type { V3 } from "../../toolkit/types";
import { nextNumberedContentId } from "./contentIds";

const DEVICE_STEP_X = 1.4;
const LAPTOP_STEP_X = 3.6;

export function compatibleDeviceColour(model: DeviceId, colour: string | undefined): string {
  const spec = DEVICE_CATALOG[model];
  if (colour && (customColourHex(colour) || spec.colours.some((finish) => finish.id === colour))) {
    return colour;
  }
  return spec.defaultColour;
}

export function changeDeviceModel(device: SceneDocDeviceSpec, model: DeviceId): SceneDocDeviceSpec {
  return {
    ...device,
    model,
    colour: compatibleDeviceColour(model, device.colour),
  };
}

export function changeSceneDeviceModel(
  doc: SceneDoc,
  deviceId: string,
  model: DeviceId,
  applyAll = false,
): boolean {
  if (!doc.devices?.some((device) => device.id === deviceId)) return false;
  let changed = false;
  doc.devices = doc.devices?.map((device) => {
    if (!applyAll && device.id !== deviceId) return device;
    const next = changeDeviceModel(device, model);
    const colourUnchanged =
      device.colour === next.colour ||
      (device.colour === undefined && next.colour === DEVICE_CATALOG[model].defaultColour);
    if (device.model === next.model && colourUnchanged) return device;
    changed = true;
    return next;
  });
  return changed;
}

export function duplicateDevice(doc: SceneDoc, deviceId: string): string | null {
  const current = doc.devices?.find((device) => device.id === deviceId);
  if (!current) return null;
  const id = nextNumberedContentId(
    "d",
    (doc.devices ?? []).map((device) => device.id),
  );
  const copy = structuredClone(current);
  copy.id = id;
  const laptop = isDeviceId(current.model) && DEVICE_CATALOG[current.model].lid !== undefined;
  const step = (laptop ? LAPTOP_STEP_X : DEVICE_STEP_X) * (current.placement?.scale ?? 1);
  const [px = 0, py = -0.3, pz = 0] = current.placement?.position ?? [];
  const [rx = 0, ry = 0, rz = 0] = current.placement?.rotationDeg ?? [];
  copy.placement = {
    ...copy.placement,
    position: [px === 0 ? step : -px, py, pz],
    rotationDeg: [rx, -ry, rz],
  };
  doc.devices = [...(doc.devices ?? []), copy];
  const layoutDelta = doc.deviceLayout?.devices?.[deviceId];
  if (layoutDelta && doc.deviceLayout) {
    doc.deviceLayout.devices = {
      ...doc.deviceLayout.devices,
      [id]: structuredClone(layoutDelta),
    };
  }
  const comparisonMedia = doc.compare?.b?.media?.[deviceId];
  if (comparisonMedia && doc.compare?.b) {
    doc.compare.b.media = {
      ...doc.compare.b.media,
      [id]: structuredClone(comparisonMedia),
    };
  }
  return id;
}

export function setDeviceRotationPose(doc: SceneDoc, deviceId: string, rotationDeg: V3): boolean {
  const device = doc.devices?.find((candidate) => candidate.id === deviceId);
  if (!device) return false;
  if (doc.deviceLayout) {
    const devices = { ...(doc.deviceLayout.devices ?? {}) };
    devices[deviceId] = { ...(devices[deviceId] ?? {}), rotationDeg: [...rotationDeg] };
    doc.deviceLayout = { ...doc.deviceLayout, devices };
  } else {
    device.placement = { ...device.placement, rotationDeg: [...rotationDeg] };
  }
  return true;
}

export interface DeviceEditorSelection {
  sceneIndex: number;
  deviceId: string;
}

export function deviceSelectionFallback(
  selected: DeviceEditorSelection | null,
  sceneIndex: number,
  renderedDeviceIds: readonly string[],
  repairStale: boolean,
): string | null {
  const fallback = renderedDeviceIds[0];
  if (!fallback) return null;
  if (!selected || selected.sceneIndex !== sceneIndex) return fallback;
  if (repairStale && !renderedDeviceIds.includes(selected.deviceId)) return fallback;
  return null;
}

export function deviceSelectionOwnsAction(
  selected: DeviceEditorSelection | null,
  sceneIndex: number,
  deviceId: string,
): boolean {
  return selected?.sceneIndex === sceneIndex && selected.deviceId === deviceId;
}

function deviceHasFollowVideo(doc: SceneDoc, deviceId: string): boolean {
  const device = doc.devices?.find((candidate) => candidate.id === deviceId);
  return device?.media?.kind === "video" || doc.compare?.b?.media?.[deviceId]?.kind === "video";
}

/** Replace one screen source while keeping duration ownership coherent before the caller re-syncs. */
export function replaceDeviceMedia(
  doc: SceneDoc,
  deviceId: string,
  media: Pick<NonNullable<SceneDocDeviceSpec["media"]>, "src" | "kind">,
): boolean {
  const device = doc.devices?.find((candidate) => candidate.id === deviceId);
  if (!device) return false;
  const replacedDrivingVideo = device.media?.kind === "video" && media.kind !== "video";
  device.media = { ...device.media, ...media };

  const duration = doc.duration;
  if (media.kind === "video" && duration?.mode !== "manual") {
    doc.duration = { mode: "follow-media", sourceDeviceId: device.id };
    return true;
  }
  if (
    !replacedDrivingVideo ||
    duration?.mode !== "follow-media" ||
    duration.source === "videoWindow"
  ) {
    return true;
  }
  const pinned = doc.devices?.find((candidate) => candidate.id === duration.sourceDeviceId);
  const targetedByDuration = pinned ? pinned.id === device.id : true;
  if (targetedByDuration && !deviceHasFollowVideo(doc, device.id)) {
    doc.duration = { mode: "manual" };
  }
  return true;
}

function preserveDurationAfterRemovingDevice(doc: SceneDoc, deviceId: string): void {
  const duration = doc.duration;
  if (duration?.mode !== "follow-media" || duration.source === "videoWindow") return;
  const pinned = doc.devices?.find((device) => device.id === duration.sourceDeviceId);
  if (pinned ? pinned.id === deviceId : deviceHasFollowVideo(doc, deviceId)) {
    doc.duration = { mode: "manual" };
  }
}

export function removeDevice(doc: SceneDoc, deviceId: string): string | null {
  const currentIndex = doc.devices?.findIndex((device) => device.id === deviceId) ?? -1;
  if (currentIndex < 0) return null;
  preserveDurationAfterRemovingDevice(doc, deviceId);
  const devices = (doc.devices ?? []).filter((device) => device.id !== deviceId);
  doc.devices = devices;
  if (doc.deviceLayout?.devices?.[deviceId]) {
    delete doc.deviceLayout.devices[deviceId];
    if (Object.keys(doc.deviceLayout.devices).length === 0) delete doc.deviceLayout.devices;
  }
  if (doc.compare?.b?.media?.[deviceId]) {
    delete doc.compare.b.media[deviceId];
    if (Object.keys(doc.compare.b.media).length === 0) delete doc.compare.b.media;
  }
  if (doc.cameraRig) doc.cameraRig = bakeRigBinding(doc.cameraRig as RigDoc, deviceId);
  return devices[currentIndex]?.id ?? devices[currentIndex - 1]?.id ?? null;
}

export function replaceDeviceLayoutPreset(
  layout: SceneDocDeviceLayout | undefined,
  preset: DeviceLayoutPreset,
): SceneDocDeviceLayout {
  return { ...layout, preset };
}

export function resetDeviceLayoutDelta(
  layout: SceneDocDeviceLayout,
  deviceId: string,
): SceneDocDeviceLayout {
  if (!layout.devices?.[deviceId]) return layout;
  const devices = { ...layout.devices };
  delete devices[deviceId];
  const next = { ...layout };
  if (Object.keys(devices).length > 0) next.devices = devices;
  else delete next.devices;
  return next;
}

export function resetAllDeviceLayoutDeltas(layout: SceneDocDeviceLayout): SceneDocDeviceLayout {
  if (!layout.devices) return layout;
  const next = { ...layout };
  delete next.devices;
  return next;
}
