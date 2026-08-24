import type { ImageReconciliationOrigin } from "../../engine/imageReconciliationStore";
import type { RigDoc } from "../../engine/sceneCameraEdit";
import {
  isSceneImageSource,
  type SceneDoc,
  type SceneDocMediaSpec,
  type SceneMediaHost,
  type SceneMediaKind,
} from "../../engine/sceneDocSchema";
import {
  createSceneMedia,
  editSceneDocMedia,
  followsSceneMedia,
  nextSceneMediaId,
  pinnedFollowMediaEntry,
  resolveSceneDocMedia,
  videoWindowMediaEntry,
} from "../../engine/sceneMedia";
import { VIDEO_WINDOW_AIM_ID } from "../../engine/sceneRig";
import { bakeRigBinding } from "../../engine/sceneRigConvert";
import type { FrameDecorationSpec } from "../../toolkit/frame/types";

/** The editor model behind the one Media drill: structural writes go through `editSceneDocMedia`, so the first edit of a legacy doc promotes it to an authored `media` array, and the selection reconciler follows an entry across undo/redo of a legacy-decoration takeover or a duplicate. */

/** The canonical media drill route; the legacy image and video-window ids still resolve to it. */
export const MEDIA_DRILL_ROUTE = "media.edit";

const MEDIA_DRILL_ROUTES = new Set([MEDIA_DRILL_ROUTE, "image.edit", "videoWindow.edit"]);

export function isMediaDrillRoute(route: string | null): boolean {
  return route !== null && MEDIA_DRILL_ROUTES.has(route);
}

export const LEGACY_MEDIA_DRILL_ROUTE = "legacyImage.edit";

export function mediaRowId(mediaId: string): string {
  return `media:${mediaId}`;
}

export function legacyMediaRowId(decorationId: string): string {
  return `media:legacy:${decorationId}`;
}

/** Replaces a doc's contents with another's, in place: enumerable keys only, so a legacy document's non-enumerable derived media never travels as an authored field. */
export function replaceSceneDoc(target: SceneDoc, replacement: SceneDoc): void {
  const record = target as unknown as Record<string, unknown>;
  const kept = new Set(Object.keys(replacement));
  for (const key of Object.keys(record)) {
    if (!kept.has(key)) delete record[key];
  }
  Object.assign(target, replacement);
}

export interface LegacyMediaPromotionResult {
  doc: SceneDoc;
  mediaId: string;
}

export interface LegacyMediaDuplicateResult extends LegacyMediaPromotionResult {
  duplicateId: string;
}

export interface MediaEditorReconciliationInput {
  drillIn: string | null;
  overviewRowId: string | null;
  selectedMediaId: string | null;
  selectedDecorationId: string | null;
  mediaIds: readonly string[];
  imageDecorationIds: readonly string[];
  origins: readonly ImageReconciliationOrigin[];
}

/** Where a freshly added entry lands: a still prefers the Overlay when the scene has one, a video always floats in the scene's world as a window (which needs no overlay to render). */
export function defaultSceneMediaHost(
  kind: SceneMediaKind,
  overlayAvailable: boolean,
): SceneMediaHost {
  if (kind === "video") return "window";
  return overlayAvailable ? "overlay" : "stage";
}

export type MediaEditorReconciliation =
  | { kind: "none" }
  | {
      kind: "switch-to-legacy";
      mediaId: string;
      decorationId: string;
      overviewRowId: string;
      replaceDrill: boolean;
    }
  | {
      kind: "switch-to-media";
      mediaId: string;
      decorationId: string;
      overviewRowId: string;
      replaceDrill: boolean;
    }
  | {
      kind: "select-media";
      mediaId: string;
      overviewRowId: string;
    }
  | { kind: "close-stale-editor"; editor: "media" | "legacyImage" };

function findNewestOrigin(
  origins: readonly ImageReconciliationOrigin[],
  matches: (origin: ImageReconciliationOrigin) => boolean,
): ImageReconciliationOrigin | undefined {
  for (let index = origins.length - 1; index >= 0; index -= 1) {
    const origin = origins[index];
    if (origin && matches(origin)) return origin;
  }
  return undefined;
}

export function reconcileMediaEditor({
  drillIn,
  overviewRowId,
  selectedMediaId,
  selectedDecorationId,
  mediaIds,
  imageDecorationIds,
  origins,
}: MediaEditorReconciliationInput): MediaEditorReconciliation {
  const currentMediaIds = new Set(mediaIds);
  const currentDecorationIds = new Set(imageDecorationIds);

  const switchToLegacy = (
    origin: Extract<ImageReconciliationOrigin, { kind: "legacy-promotion" }>,
    replaceDrill: boolean,
  ): MediaEditorReconciliation => ({
    kind: "switch-to-legacy",
    mediaId: origin.imageId,
    decorationId: origin.decorationId,
    overviewRowId: legacyMediaRowId(origin.decorationId),
    replaceDrill,
  });
  const switchToMedia = (
    origin: Extract<ImageReconciliationOrigin, { kind: "legacy-promotion" }>,
    replaceDrill: boolean,
    mediaId = origin.imageId,
  ): MediaEditorReconciliation => ({
    kind: "switch-to-media",
    mediaId,
    decorationId: origin.decorationId,
    overviewRowId: mediaRowId(mediaId),
    replaceDrill,
  });
  const newestExistingDuplicate = (sourceMediaId: string): string => {
    const reachable = new Set([sourceMediaId]);
    let newest = sourceMediaId;
    for (const origin of origins) {
      if (
        origin.kind === "duplicate" &&
        reachable.has(origin.sourceImageId) &&
        currentMediaIds.has(origin.imageId)
      ) {
        reachable.add(origin.imageId);
        newest = origin.imageId;
      }
    }
    return newest;
  };
  const reconcileMissingMedia = (
    mediaId: string,
    replaceDrill: boolean,
    visited = new Set<string>(),
  ): MediaEditorReconciliation | null => {
    if (visited.has(mediaId)) return null;
    visited.add(mediaId);
    const origin = findNewestOrigin(origins, (candidate) => {
      if (candidate.imageId !== mediaId) return false;
      return candidate.kind === "legacy-promotion"
        ? currentDecorationIds.has(candidate.decorationId)
        : true;
    });
    if (!origin) return null;
    if (origin.kind === "legacy-promotion") return switchToLegacy(origin, replaceDrill);
    if (!currentMediaIds.has(origin.sourceImageId)) {
      return reconcileMissingMedia(origin.sourceImageId, replaceDrill, visited);
    }
    return {
      kind: "select-media",
      mediaId: origin.sourceImageId,
      overviewRowId: mediaRowId(origin.sourceImageId),
    };
  };

  if (isMediaDrillRoute(drillIn)) {
    if (selectedMediaId) {
      if (!currentMediaIds.has(selectedMediaId)) {
        return (
          reconcileMissingMedia(selectedMediaId, true) ?? {
            kind: "close-stale-editor",
            editor: "media",
          }
        );
      }
      return { kind: "none" };
    }
    return currentMediaIds.size > 0
      ? { kind: "none" }
      : { kind: "close-stale-editor", editor: "media" };
  }

  if (drillIn === LEGACY_MEDIA_DRILL_ROUTE) {
    if (selectedDecorationId) {
      const origin = findNewestOrigin(
        origins,
        (candidate) =>
          candidate.kind === "legacy-promotion" &&
          candidate.decorationId === selectedDecorationId &&
          currentMediaIds.has(candidate.imageId),
      );
      if (!currentDecorationIds.has(selectedDecorationId) && origin?.kind === "legacy-promotion") {
        return switchToMedia(origin, true, newestExistingDuplicate(origin.imageId));
      }
      if (!currentDecorationIds.has(selectedDecorationId)) {
        return { kind: "close-stale-editor", editor: "legacyImage" };
      }
      return { kind: "none" };
    }
    return currentDecorationIds.size > 0
      ? { kind: "none" }
      : { kind: "close-stale-editor", editor: "legacyImage" };
  }

  if (drillIn !== null || !overviewRowId) return { kind: "none" };

  const missingMediaOrigin = findNewestOrigin(
    origins,
    (candidate) =>
      overviewRowId === mediaRowId(candidate.imageId) && !currentMediaIds.has(candidate.imageId),
  );
  if (missingMediaOrigin) {
    const reconciliation = reconcileMissingMedia(missingMediaOrigin.imageId, false);
    if (reconciliation) return reconciliation;
  }

  const legacyOrigin = findNewestOrigin(
    origins,
    (candidate) =>
      candidate.kind === "legacy-promotion" &&
      overviewRowId === legacyMediaRowId(candidate.decorationId) &&
      !currentDecorationIds.has(candidate.decorationId) &&
      currentMediaIds.has(candidate.imageId),
  );
  return legacyOrigin?.kind === "legacy-promotion"
    ? switchToMedia(legacyOrigin, false, newestExistingDuplicate(legacyOrigin.imageId))
    : { kind: "none" };
}

export function duplicateSceneMedia(next: SceneDoc, mediaId: string): string | null {
  const media = resolveSceneDocMedia(next);
  const current = media.find((candidate) => candidate.id === mediaId);
  if (!current) return null;
  const id = nextSceneMediaId(
    current.kind,
    media.map((entry) => entry.id),
  );
  const copy = structuredClone(current);
  copy.id = id;
  delete copy.overlay.stackOrder;
  if (current.host === "stage") {
    const [x, y, z] = current.stage.position;
    copy.stage = { ...copy.stage, position: [x + 0.25, y, z] };
  } else {
    const [x, y] = current.overlay.position;
    copy.overlay = { ...copy.overlay, position: [x + 0.05, y - 0.05] };
  }
  editSceneDocMedia(next, (entries) => [...entries, copy]);
  return id;
}

function deviceHasFollowVideo(next: SceneDoc, deviceId: string): boolean {
  const device = next.devices?.find((candidate) => candidate.id === deviceId);
  return device?.media?.kind === "video" || next.compare?.b?.media?.[deviceId]?.kind === "video";
}

/** Does removing this entry pull the scene's length out from under it? A pinned entry always does; an unpinned scene falls back to its media only when no device video qualifies and no other video entry is left to follow. */
export function mediaDrivesDuration(next: SceneDoc, mediaId: string): boolean {
  const duration = next.duration;
  if (duration?.mode !== "follow-media") return false;
  const media = resolveSceneDocMedia(next);
  if (followsSceneMedia(duration)) return pinnedFollowMediaEntry(duration, media)?.id === mediaId;
  if (media.find((entry) => entry.id === mediaId)?.kind !== "video") return false;
  const devices = next.devices ?? [];
  const pinned = devices.find((device) => device.id === duration.sourceDeviceId);
  if (
    pinned
      ? deviceHasFollowVideo(next, pinned.id)
      : devices.some((device) => deviceHasFollowVideo(next, device.id))
  ) {
    return false;
  }
  return !media.some((entry) => entry.id !== mediaId && entry.kind === "video");
}

/** Removes one entry, keeps every binding that named it coherent (the length it drove falls back to manual, rig keys aimed at it bake to their last point) and names the entry to select next (the one that slid into its place, else the one before it). */
export function removeSceneMedia(next: SceneDoc, mediaId: string): string | null {
  const current = resolveSceneDocMedia(next);
  const currentIndex = current.findIndex((entry) => entry.id === mediaId);
  if (currentIndex < 0) return null;
  if (mediaDrivesDuration(next, mediaId)) next.duration = { mode: "manual" };
  const servedTheWindow = videoWindowMediaEntry(current)?.id === mediaId;
  const remaining = current.filter((entry) => entry.id !== mediaId);
  editSceneDocMedia(next, () => remaining);
  if (next.cameraRig) {
    next.cameraRig = bakeRigBinding(next.cameraRig as RigDoc, mediaId);
    // The rig's legacy window aim is an id, not an entry: bake it too once nothing serves the window any more.
    if (servedTheWindow && !videoWindowMediaEntry(remaining)) {
      next.cameraRig = bakeRigBinding(next.cameraRig as RigDoc, VIDEO_WINDOW_AIM_ID);
    }
  }
  return remaining[currentIndex]?.id ?? remaining[currentIndex - 1]?.id ?? null;
}

/** Takes an inherited overlay decoration over as a first-class media entry, materialising every remaining decoration so the sidecar owns the whole list. Returns a fresh doc (or null when the decoration is gone, is text, or the final source is unsupported). */
export function promoteLegacyMedia(
  doc: SceneDoc,
  resolvedDecorations: readonly FrameDecorationSpec[],
  decorationId: string,
  mutate: (entry: SceneDocMediaSpec) => void,
): LegacyMediaPromotionResult | null {
  const next = structuredClone(doc);
  const decorations = (next.frame?.decorations ?? structuredClone([...resolvedDecorations])).map(
    (decoration, index) => ({
      ...decoration,
      stackOrder: decoration.stackOrder ?? index,
    }),
  );
  const selectedIndex = decorations.findIndex((decoration) => decoration.id === decorationId);
  const selected = decorations[selectedIndex];
  if (!selected?.src || selected.text !== undefined) return null;

  const media = resolveSceneDocMedia(next);
  const id = nextSceneMediaId(
    "image",
    media.map((entry) => entry.id),
  );
  const promoted = createSceneMedia(id, selected.src, "image", "overlay");
  promoted.overlay = {
    position: [...selected.position],
    size: selected.size,
    rotationDeg: selected.rotationDeg ?? 0,
    shape: selected.shape ?? "none",
    layer: selected.layer ?? "above",
    stackOrder: selected.stackOrder,
  };
  mutate(promoted);
  if (!isSceneImageSource(promoted.src)) return null;

  editSceneDocMedia(next, (entries) => [...entries, promoted]);
  next.frame = {
    ...(next.frame ?? {}),
    decorations: decorations.filter((_, index) => index !== selectedIndex),
  };
  return { doc: next, mediaId: id };
}

export function duplicateLegacyMedia(
  doc: SceneDoc,
  resolvedDecorations: readonly FrameDecorationSpec[],
  decorationId: string,
): LegacyMediaDuplicateResult | null {
  const promotion = promoteLegacyMedia(doc, resolvedDecorations, decorationId, () => {});
  if (!promotion) return null;
  const duplicateId = duplicateSceneMedia(promotion.doc, promotion.mediaId);
  return duplicateId ? { ...promotion, duplicateId } : null;
}

export function deleteLegacyMedia(
  doc: SceneDoc,
  resolvedDecorations: readonly FrameDecorationSpec[],
  decorationId: string,
): SceneDoc | null {
  const next = structuredClone(doc);
  const decorations = (next.frame?.decorations ?? structuredClone([...resolvedDecorations])).map(
    (decoration, index) => ({
      ...decoration,
      stackOrder: decoration.stackOrder ?? index,
    }),
  );
  const selectedIndex = decorations.findIndex(
    (decoration) =>
      decoration.id === decorationId &&
      decoration.src !== undefined &&
      decoration.text === undefined,
  );
  if (selectedIndex < 0) return null;
  next.frame = {
    ...(next.frame ?? {}),
    decorations: decorations.filter((_, index) => index !== selectedIndex),
  };
  return next;
}
