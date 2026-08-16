import type { ImageReconciliationOrigin } from "../../engine/imageReconciliationStore";
import {
  isSceneImageSource,
  type SceneDoc,
  type SceneDocImageSpec,
  type SceneImageHost,
} from "../../engine/sceneDocSchema";
import { createSceneImage } from "../../engine/sceneImage";
import type { FrameDecorationSpec } from "../../toolkit/frame/types";
import { nextNumberedContentId } from "./contentIds";

export interface LegacyImagePromotionResult {
  doc: SceneDoc;
  imageId: string;
}

export interface LegacyImageDuplicateResult extends LegacyImagePromotionResult {
  duplicateId: string;
}

export interface ImageEditorReconciliationInput {
  drillIn: string | null;
  overviewRowId: string | null;
  selectedImageId: string | null;
  selectedDecorationId: string | null;
  imageIds: readonly string[];
  imageDecorationIds: readonly string[];
  origins: readonly ImageReconciliationOrigin[];
}

export function defaultSceneImageHost(overlayAvailable: boolean): SceneImageHost {
  return overlayAvailable ? "overlay" : "stage";
}

export type ImageEditorReconciliation =
  | { kind: "none" }
  | {
      kind: "switch-to-legacy";
      imageId: string;
      decorationId: string;
      overviewRowId: string;
      replaceDrill: boolean;
    }
  | {
      kind: "switch-to-image";
      imageId: string;
      decorationId: string;
      overviewRowId: string;
      replaceDrill: boolean;
    }
  | {
      kind: "select-image";
      imageId: string;
      overviewRowId: string;
    }
  | { kind: "close-stale-editor"; editor: "image" | "legacyImage" };

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

export function reconcileImageEditor({
  drillIn,
  overviewRowId,
  selectedImageId,
  selectedDecorationId,
  imageIds,
  imageDecorationIds,
  origins,
}: ImageEditorReconciliationInput): ImageEditorReconciliation {
  const currentImageIds = new Set(imageIds);
  const currentDecorationIds = new Set(imageDecorationIds);

  const switchToLegacy = (
    origin: Extract<ImageReconciliationOrigin, { kind: "legacy-promotion" }>,
    replaceDrill: boolean,
  ): ImageEditorReconciliation => ({
    kind: "switch-to-legacy",
    imageId: origin.imageId,
    decorationId: origin.decorationId,
    overviewRowId: `image:legacy:${origin.decorationId}`,
    replaceDrill,
  });
  const switchToImage = (
    origin: Extract<ImageReconciliationOrigin, { kind: "legacy-promotion" }>,
    replaceDrill: boolean,
    imageId = origin.imageId,
  ): ImageEditorReconciliation => ({
    kind: "switch-to-image",
    imageId,
    decorationId: origin.decorationId,
    overviewRowId: `image:${imageId}`,
    replaceDrill,
  });
  const newestExistingDuplicate = (sourceImageId: string): string => {
    const reachable = new Set([sourceImageId]);
    let newest = sourceImageId;
    for (const origin of origins) {
      if (
        origin.kind === "duplicate" &&
        reachable.has(origin.sourceImageId) &&
        currentImageIds.has(origin.imageId)
      ) {
        reachable.add(origin.imageId);
        newest = origin.imageId;
      }
    }
    return newest;
  };
  const reconcileMissingImage = (
    imageId: string,
    replaceDrill: boolean,
    visited = new Set<string>(),
  ): ImageEditorReconciliation | null => {
    if (visited.has(imageId)) return null;
    visited.add(imageId);
    const origin = findNewestOrigin(origins, (candidate) => {
      if (candidate.imageId !== imageId) return false;
      return candidate.kind === "legacy-promotion"
        ? currentDecorationIds.has(candidate.decorationId)
        : true;
    });
    if (!origin) return null;
    if (origin.kind === "legacy-promotion") return switchToLegacy(origin, replaceDrill);
    if (!currentImageIds.has(origin.sourceImageId)) {
      return reconcileMissingImage(origin.sourceImageId, replaceDrill, visited);
    }
    return {
      kind: "select-image",
      imageId: origin.sourceImageId,
      overviewRowId: `image:${origin.sourceImageId}`,
    };
  };

  if (drillIn === "image.edit") {
    if (selectedImageId) {
      if (!currentImageIds.has(selectedImageId)) {
        return (
          reconcileMissingImage(selectedImageId, true) ?? {
            kind: "close-stale-editor",
            editor: "image",
          }
        );
      }
      return { kind: "none" };
    }
    return currentImageIds.size > 0
      ? { kind: "none" }
      : { kind: "close-stale-editor", editor: "image" };
  }

  if (drillIn === "legacyImage.edit") {
    if (selectedDecorationId) {
      const origin = findNewestOrigin(
        origins,
        (candidate) =>
          candidate.kind === "legacy-promotion" &&
          candidate.decorationId === selectedDecorationId &&
          currentImageIds.has(candidate.imageId),
      );
      if (!currentDecorationIds.has(selectedDecorationId) && origin?.kind === "legacy-promotion") {
        return switchToImage(origin, true, newestExistingDuplicate(origin.imageId));
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

  const missingImageOrigin = findNewestOrigin(
    origins,
    (candidate) =>
      overviewRowId === `image:${candidate.imageId}` && !currentImageIds.has(candidate.imageId),
  );
  if (missingImageOrigin) {
    const reconciliation = reconcileMissingImage(missingImageOrigin.imageId, false);
    if (reconciliation) return reconciliation;
  }

  const legacyOrigin = findNewestOrigin(
    origins,
    (candidate) =>
      candidate.kind === "legacy-promotion" &&
      overviewRowId === `image:legacy:${candidate.decorationId}` &&
      !currentDecorationIds.has(candidate.decorationId) &&
      currentImageIds.has(candidate.imageId),
  );
  return legacyOrigin?.kind === "legacy-promotion"
    ? switchToImage(legacyOrigin, false, newestExistingDuplicate(legacyOrigin.imageId))
    : { kind: "none" };
}

export function duplicateImage(next: SceneDoc, imageId: string): string | null {
  const current = next.images?.find((candidate) => candidate.id === imageId);
  if (!current) return null;
  const id = nextNumberedContentId(
    "img",
    (next.images ?? []).map((image) => image.id),
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
  next.images = [...(next.images ?? []), copy];
  return id;
}

export function removeImage(next: SceneDoc, imageId: string): string | null {
  const currentIndex = next.images?.findIndex((image) => image.id === imageId) ?? -1;
  if (currentIndex < 0) return null;
  const images = (next.images ?? []).filter((image) => image.id !== imageId);
  if (images.length > 0) next.images = images;
  else delete next.images;
  return images[currentIndex]?.id ?? images[currentIndex - 1]?.id ?? null;
}

export function promoteLegacyImage(
  doc: SceneDoc,
  resolvedDecorations: readonly FrameDecorationSpec[],
  decorationId: string,
  mutate: (image: SceneDocImageSpec) => void,
): LegacyImagePromotionResult | null {
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

  const id = nextNumberedContentId(
    "img",
    (next.images ?? []).map((image) => image.id),
  );
  const promoted = createSceneImage(id, selected.src, "overlay");
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

  next.images = [...(next.images ?? []), promoted];
  next.frame = {
    ...(next.frame ?? {}),
    decorations: decorations.filter((_, index) => index !== selectedIndex),
  };
  return { doc: next, imageId: id };
}

export function duplicateLegacyImage(
  doc: SceneDoc,
  resolvedDecorations: readonly FrameDecorationSpec[],
  decorationId: string,
): LegacyImageDuplicateResult | null {
  const promotion = promoteLegacyImage(doc, resolvedDecorations, decorationId, () => {});
  if (!promotion) return null;
  const duplicateId = duplicateImage(promotion.doc, promotion.imageId);
  return duplicateId ? { ...promotion, duplicateId } : null;
}

export function deleteLegacyImage(
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
