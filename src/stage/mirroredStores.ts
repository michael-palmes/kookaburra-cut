import type { StoreApi } from "zustand";
import { useCameraEditStore } from "../engine/cameraEditStore";
import { useChartEditStore } from "../engine/chartEditStore";
import { useCompareEditStore } from "../engine/compareEditStore";
import { useDeviceEditStore } from "../engine/deviceEditStore";
import { useEffectsStore } from "../engine/effectsStore";
import { useImageEditStore } from "../engine/imageEditStore";
import { useLayeredScreenshotEditStore } from "../engine/layeredScreenshotEditStore";
import { useLightEditStore } from "../engine/lightEditStore";
import { useLightingEditStore } from "../engine/lightingEditStore";
import { useObjectEditStore } from "../engine/objectEditStore";
import type { MirroredStore } from "../engine/stageProtocol";
import { usePresentStore } from "../present/presentStore";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";

/** The stores the canvas tree reads (or writes) that the window owns; both realms import this list so the mirror pairs the same stores. Present's deck store joins only in the Present window. */
export function mirroredStores(): Partial<
  Record<MirroredStore, StoreApi<Record<string, unknown>>>
> {
  const as = (store: unknown) => store as StoreApi<Record<string, unknown>>;
  return {
    editor: as(useEditorStore),
    ui: as(useUiStore),
    effects: as(useEffectsStore),
    cameraEdit: as(useCameraEditStore),
    compareEdit: as(useCompareEditStore),
    lightingEdit: as(useLightingEditStore),
    lightEdit: as(useLightEditStore),
    deviceEdit: as(useDeviceEditStore),
    objectEdit: as(useObjectEditStore),
    chartEdit: as(useChartEditStore),
    imageEdit: as(useImageEditStore),
    layeredScreenshotEdit: as(useLayeredScreenshotEditStore),
    presentDeck: as(usePresentStore),
  };
}

/** What a canvas click, gizmo drag or Present's driver writes back. Nothing here picks a project, drives the chrome or holds Present's focus. */
const WORKER_WRITABLE: Partial<Record<MirroredStore, readonly string[]>> = {
  deviceEdit: ["selected", "pendingCommit", "acknowledgements"],
  objectEdit: ["selected", "pendingCommit"],
  chartEdit: ["selected", "pendingCommit"],
  imageEdit: ["selected", "previewPlacement", "pendingCommit"],
  presentDeck: ["deck", "anchors", "endFade", "scenesCommitted"],
};

/** The worker's own reports: the clock it drives and the registries the canvas fills. */
const WORKER_OWNED: ReadonlySet<MirroredStore> = new Set([
  "clock",
  "sceneText",
  "textKey",
  "stage",
  "depthStage",
]);

/** A gizmo commits only to the item the inspector has selected. */
function commitsToSelection(commit: unknown, selected: unknown): boolean {
  if (commit === null) return true;
  if (typeof commit !== "object" || typeof selected !== "object" || selected === null) return false;
  const target = commit as Record<string, unknown>;
  return Object.entries(selected).every(([key, value]) => Object.is(target[key], value));
}

/** The window's side of the stage mirror: a worker patch keeps only the fields the worker may write. */
export function acceptFromWorker(
  name: MirroredStore,
  patch: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  if (WORKER_OWNED.has(name)) return patch;
  const writable = WORKER_WRITABLE[name] ?? [];
  const selected = "selected" in patch ? patch.selected : current.selected;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (!writable.includes(key)) continue;
    if (key === "pendingCommit" && !commitsToSelection(patch[key], selected)) continue;
    out[key] = patch[key];
  }
  return out;
}
