import { isCompareChipGroupKey } from "../../engine/compareChipText";
import type { ImageReconciliationOrigin } from "../../engine/imageReconciliationStore";
import type { RigDoc } from "../../engine/sceneCameraEdit";
import type { SceneDoc, SceneDocObjectSpec } from "../../engine/sceneDocSchema";
import { followsSceneMedia, resolveSceneDocMedia } from "../../engine/sceneMedia";
import { LAYERED_SCREENSHOT_AIM_ID } from "../../engine/sceneRig";
import { bakeRigBinding } from "../../engine/sceneRigConvert";
import type { FrameDecorationSpec } from "../../toolkit/frame/types";
import type {
  SceneOverviewContentType,
  SceneOverviewRowModel,
  SceneOverviewSelectionTarget,
} from "../inspectorOptions";
import { nextNumberedContentId } from "./contentIds";
import { duplicateDevice } from "./deviceEditorModel";
import {
  deleteLegacyMedia,
  duplicateLegacyMedia,
  duplicateSceneMedia,
  mediaRowId,
  removeSceneMedia,
  replaceSceneDoc,
} from "./mediaEditorModel";

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
  "terminal",
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
    kind === "media" ||
    kind === "legacyImage" ||
    kind === "object"
  ) {
    actions.push("duplicate");
  }
  if (
    kind === "text" ||
    kind === "device" ||
    kind === "media" ||
    kind === "legacyImage" ||
    kind === "object" ||
    kind === "chart" ||
    kind === "screenshotStack" ||
    kind === "comparison" ||
    kind === "terminal"
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

  if (target?.kind === "media") {
    if (!resolveSceneDocMedia(context.doc).some((entry) => entry.id === target.id)) return null;
    const plan: ContentDocActionPlan = {
      history: "duplicate media",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        const id = duplicateSceneMedia(next, target.id);
        if (!id) return false;
        plan.nextRowId = mediaRowId(id);
        plan.nextSelection = { kind: "media", id };
      },
    };
    return plan;
  }

  if (target?.kind === "legacyImage") {
    const decorations = context.resolvedDecorations ?? [];
    if (!duplicateLegacyMedia(context.doc, decorations, target.id)) return null;
    const fallbackDecorations = structuredClone([...decorations]);
    const plan: ContentDocActionPlan = {
      history: "duplicate media",
      nextRowId: null,
      nextSelection: null,
      imageOrigins: [],
      apply: (next) => {
        plan.nextRowId = null;
        plan.nextSelection = null;
        plan.imageOrigins = [];
        const result = duplicateLegacyMedia(next, fallbackDecorations, target.id);
        if (!result) return false;
        replaceSceneDoc(next, result.doc);
        plan.nextRowId = mediaRowId(result.duplicateId);
        plan.nextSelection = { kind: "media", id: result.duplicateId };
        plan.imageOrigins = [
          {
            kind: "legacy-promotion",
            decorationId: target.id,
            imageId: result.mediaId,
          },
          {
            kind: "duplicate",
            imageId: result.duplicateId,
            sourceImageId: result.mediaId,
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
  if (duration?.mode !== "follow-media" || followsSceneMedia(duration)) return;
  const pinned = next.devices?.find((device) => device.id === duration.sourceDeviceId);
  if (pinned ? pinned.id === id : deviceHasFollowVideo(next, id)) {
    next.duration = { mode: "manual" };
  }
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

  if (target.kind === "media") {
    if (!resolveSceneDocMedia(context.doc).some((entry) => entry.id === target.id)) return null;
    return {
      history: "delete media",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        if (!resolveSceneDocMedia(next).some((entry) => entry.id === target.id)) return false;
        // The removal owns the bindings that named the entry: the length it drove and any rig aim.
        removeSceneMedia(next, target.id);
      },
    };
  }

  if (target.kind === "legacyImage") {
    const decorations = context.resolvedDecorations ?? [];
    if (!deleteLegacyMedia(context.doc, decorations, target.id)) return null;
    const fallbackDecorations = structuredClone([...decorations]);
    return {
      history: "delete media",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        const result = deleteLegacyMedia(next, fallbackDecorations, target.id);
        if (!result) return false;
        replaceSceneDoc(next, result);
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

  // A live session survives the block (harmless: keyed by scene stem, it reattaches if the terminal is re-added, and dies with the app otherwise).
  if (target.kind === "terminal" && context.doc.terminal) {
    return {
      history: "delete terminal",
      nextRowId: null,
      nextSelection: null,
      apply: (next) => {
        delete next.terminal;
      },
    };
  }

  return null;
}
