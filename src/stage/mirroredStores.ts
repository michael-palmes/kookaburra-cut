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
