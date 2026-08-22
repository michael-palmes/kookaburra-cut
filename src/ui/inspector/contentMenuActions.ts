import { isCompareChipGroupKey } from "../../engine/compareChipText";
import type { ImageReconciliationOrigin } from "../../engine/imageReconciliationStore";
import type { RigDoc } from "../../engine/sceneCameraEdit";
import type { SceneDoc, SceneDocObjectSpec } from "../../engine/sceneDocSchema";
import { LAYERED_SCREENSHOT_AIM_ID, VIDEO_WINDOW_AIM_ID } from "../../engine/sceneRig";
import { bakeRigBinding } from "../../engine/sceneRigConvert";
import type { FrameDecorationSpec } from "../../toolkit/frame/types";
import type {
  SceneOverviewContentType,
  SceneOverviewRowModel,
  SceneOverviewSelectionTarget,
} from "../inspectorOptions";
import { nextNumberedContentId } from "./contentIds";
import { duplicateDevice } from "./deviceEditorModel";
import { deleteLegacyImage, duplicateImage, duplicateLegacyImage } from "./imageEditorModel";

export type ContentMenuAction = "edit" | "duplicate" | "delete";

export interface ContentActionContext {
  doc: SceneDoc;
  resolvedDecorations?: readonly FrameDecorationSpec[];
}

export interface ContentDocActionPlan {
  history: string;
  nextRowId: string | null;
  nextSelection: SceneOverviewSelectionTarget | null;
  imageOrigins?: ImageReconciliationOrigin[];
  apply: (next: SceneDoc) => unknown;
}

const CONTENT_TYPES = new Set<SceneOverviewContentType>([
  "text",
  "device",
  "image",
  "video",
  "object",
  "chart",
  "screenshotStack",
  "comparison",
]);

export const OBJECT_DUPLICATE_NUDGE_X = 0.25;
const TEXT_STYLE_SUFFIXES = [
  "Color",
  "Font",
  "Size",
  "OffsetX",
  "OffsetY",
  "LineHeight",
  "RotationDeg",
] as const;

export function contentMenuActions(row: SceneOverviewRowModel): ContentMenuAction[] {
  if (!CONTENT_TYPES.has(row.type as SceneOverviewContentType)) return [];
  const actions: ContentMenuAction[] = ["edit"];
  const kind = row.selectionTarget?.kind;
  // Chip rows are chrome: the comparison's own toggle adds and removes them.
  if (kind === "text" && isCompareChipGroupKey(row.selectionTarget?.id ?? "")) return actions;
  if (
    kind === "text" ||
    kind === "device" ||
    kind === "image" ||
    kind === "legacyImage" ||
    kind === "object"
  ) {
    actions.push("duplicate");
  }
  if (
    kind === "text" ||
    kind === "device" ||
    kind === "image" ||
    kind === "legacyImage" ||
    kind === "videoWindow" ||
    kind === "object" ||
    kind === "chart" ||
    kind === "screenshotStack" ||
    kind === "comparison"
  ) {
    actions.push("delete");
  }
  return actions;
}

function bakeBinding(next: SceneDoc, id: string): void {
  if (next.cameraRig) next.cameraRig = bakeRigBinding(next.cameraRig as RigDoc, id);
}

export function planContentDuplicate(
  row: SceneOverviewRowModel,
  context: ContentActionContext,
): ContentDocActionPlan | null {
  if (!contentMenuActions(row).includes("duplicate")) return null;
  const target = row.selectionTarget;
  if (target?.kind === "device") {
    const source = context.doc.devices?.find((device) => device.id === target.id);
    if (!source) return null;
    const plan: ContentDocActionPlan = {
      history: "duplicate device",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        const id = duplicateDevice(next, target.id);
        if (!id) return false;
        plan.nextRowId = `device:${id}`;
        plan.nextSelection = { kind: "device", id };
      },
    };
    return plan;
  }

  if (target?.kind === "image") {
    const source = context.doc.images?.find((image) => image.id === target.id);
    if (!source) return null;
    const plan: ContentDocActionPlan = {
      history: "duplicate image",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        const id = duplicateImage(next, target.id);
        if (!id) return false;
        plan.nextRowId = `image:${id}`;
        plan.nextSelection = { kind: "image", id };
      },
    };
    return plan;
  }

  if (target?.kind === "legacyImage") {
    const decorations = context.resolvedDecorations ?? [];
    if (!duplicateLegacyImage(context.doc, decorations, target.id)) return null;
    const fallbackDecorations = structuredClone([...decorations]);
    const plan: ContentDocActionPlan = {
      history: "duplicate image",
      nextRowId: null,
      nextSelection: null,
      imageOrigins: [],
      apply: (next) => {
        plan.nextRowId = null;
        plan.nextSelection = null;
        plan.imageOrigins = [];
        const result = duplicateLegacyImage(next, fallbackDecorations, target.id);
        if (!result) return false;
        Object.assign(next, result.doc);
        plan.nextRowId = `image:${result.duplicateId}`;
        plan.nextSelection = { kind: "image", id: result.duplicateId };
        plan.imageOrigins = [
          {
            kind: "legacy-promotion",
            decorationId: target.id,
            imageId: result.imageId,
          },
          {
            kind: "duplicate",
            imageId: result.duplicateId,
            sourceImageId: result.imageId,
          },
        ];
      },
    };
    return plan;
  }

  if (target?.kind === "object") {
    const source = context.doc.objects?.find((object) => object.id === target.id);
    if (!source) return null;
    const plan: ContentDocActionPlan = {
      history: "duplicate object",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        const current = next.objects?.find((object) => object.id === target.id);
        if (!current) return;
        const id = nextNumberedContentId(
          "o",
          (next.objects ?? []).map((object) => object.id),
        );
        const copy: SceneDocObjectSpec = structuredClone(current);
        const [x = 0, y = 0, z = 0] = current.placement?.position ?? [];
        copy.id = id;
        copy.placement = {
          ...copy.placement,
          position: [x + OBJECT_DUPLICATE_NUDGE_X, y, z],
        };
        next.objects = [...(next.objects ?? []), copy];
        plan.nextRowId = `object:${id}`;
        plan.nextSelection = { kind: "object", id };
      },
    };
    return plan;
  }

  return null;
}

function removeDeviceReferences(next: SceneDoc, id: string): void {
  if (next.deviceLayout?.devices?.[id]) {
    delete next.deviceLayout.devices[id];
    if (Object.keys(next.deviceLayout.devices).length === 0) delete next.deviceLayout.devices;
  }
  if (next.compare?.b?.media?.[id]) {
    delete next.compare.b.media[id];
    if (Object.keys(next.compare.b.media).length === 0) delete next.compare.b.media;
  }
  bakeBinding(next, id);
}

function deviceHasFollowVideo(next: SceneDoc, id: string): boolean {
  const device = next.devices?.find((candidate) => candidate.id === id);
  return device?.media?.kind === "video" || next.compare?.b?.media?.[id]?.kind === "video";
}

function preserveDurationAfterRemovingDevice(next: SceneDoc, id: string): void {
  const duration = next.duration;
  if (duration?.mode !== "follow-media" || duration.source === "videoWindow") return;
  const pinned = next.devices?.find((device) => device.id === duration.sourceDeviceId);
  if (pinned ? pinned.id === id : deviceHasFollowVideo(next, id)) {
    next.duration = { mode: "manual" };
  }
}

function videoWindowDrivesDuration(next: SceneDoc): boolean {
  const duration = next.duration;
  if (duration?.mode !== "follow-media" || !next.videoWindow?.media.src) return false;
  if (duration.source === "videoWindow") return true;
  const devices = next.devices ?? [];
  const pinned = devices.find((device) => device.id === duration.sourceDeviceId);
  return !(pinned
    ? deviceHasFollowVideo(next, pinned.id)
    : devices.some((device) => deviceHasFollowVideo(next, device.id)));
}

function removeLayeredScreenshotText(next: SceneDoc): void {
  const textKeys = new Set(
    (next.layeredScreenshot?.layers ?? []).flatMap((layer) =>
      layer.items.filter((item) => item.kind === "text").map((item) => `ls-${item.id}`),
    ),
  );
  if (textKeys.size === 0) return;

  for (const key of textKeys) delete next.text?.[key];
  if (next.text && Object.keys(next.text).length === 0) delete next.text;

  for (const key of textKeys) {
    for (const suffix of TEXT_STYLE_SUFFIXES) delete next.textStyle?.[`${key}${suffix}`];
  }
  if (next.textStyle && Object.keys(next.textStyle).length === 0) delete next.textStyle;
}

export function planContentDelete(
  row: SceneOverviewRowModel,
  context: ContentActionContext,
): ContentDocActionPlan | null {
  if (!contentMenuActions(row).includes("delete")) return null;
  const target = row.selectionTarget;
  if (!target) return null;

  if (target.kind === "device") {
    if (!context.doc.devices?.some((device) => device.id === target.id)) return null;
    return {
      history: "delete device",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        preserveDurationAfterRemovingDevice(next, target.id);
        next.devices = (next.devices ?? []).filter((device) => device.id !== target.id);
        removeDeviceReferences(next, target.id);
      },
    };
  }

  if (target.kind === "image") {
    if (!context.doc.images?.some((image) => image.id === target.id)) return null;
    return {
      history: "delete image",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        const remaining = (next.images ?? []).filter((image) => image.id !== target.id);
        if (remaining.length > 0) next.images = remaining;
        else delete next.images;
      },
    };
  }

  if (target.kind === "legacyImage") {
    const decorations = context.resolvedDecorations ?? [];
    if (!deleteLegacyImage(context.doc, decorations, target.id)) return null;
    const fallbackDecorations = structuredClone([...decorations]);
    return {
      history: "delete image",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        const result = deleteLegacyImage(next, fallbackDecorations, target.id);
        if (!result) return false;
        Object.assign(next, result);
      },
    };
  }

  if (target.kind === "object") {
    if (!context.doc.objects?.some((object) => object.id === target.id)) return null;
    return {
      history: "delete object",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        next.objects = (next.objects ?? []).filter((object) => object.id !== target.id);
      },
    };
  }

  if (target.kind === "videoWindow" && context.doc.videoWindow) {
    return {
      history: "delete video window",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        if (videoWindowDrivesDuration(next)) next.duration = { mode: "manual" };
        delete next.videoWindow;
        bakeBinding(next, VIDEO_WINDOW_AIM_ID);
      },
    };
  }

  if (target.kind === "chart" && context.doc.chart) {
    return {
      history: "delete chart",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        delete next.chart;
        if (next.animatedTrack === "chart") delete next.animatedTrack;
      },
    };
  }

  if (target.kind === "screenshotStack" && context.doc.layeredScreenshot) {
    return {
      history: "delete screenshot stack",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        removeLayeredScreenshotText(next);
        delete next.layeredScreenshot;
        if (next.animatedTrack === "layeredScreenshot") delete next.animatedTrack;
        bakeBinding(next, LAYERED_SCREENSHOT_AIM_ID);
      },
    };
  }

  if (target.kind === "comparison" && context.doc.compare) {
    return {
      history: "delete comparison",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        delete next.compare;
        if (next.animatedTrack === "compare") delete next.animatedTrack;
      },
    };
  }

  return null;
}
