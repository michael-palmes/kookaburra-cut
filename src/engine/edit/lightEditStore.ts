import { create } from "zustand";

/** Lighting-edit UI state (v9 · PR 5): which light/fixture the inspector has selected, so the preview helpers can highlight it. UI-only, modelled on cameraEditStore: the export path never reads it, and the helpers it drives are double-guarded out of exports (mount-gated on the open Lighting section AND drawn on HELPER_LAYER, which the exporter disables on the camera). */

/** The camera layer every helper object lives on: the exporter disables it per run, the preview driver enables it per frame. Belt and braces on top of mount gating, because a helper leaking into an export is a silent visual corruption Verify would happily certify as deterministic. */
export const HELPER_LAYER = 2;

interface LightEditState {
  selectedLightId: string | null;
  selectedFixtureId: string | null;
  select: (kind: "light" | "fixture" | null, id?: string) => void;
}

export const useLightEditStore = create<LightEditState>((set) => ({
  selectedLightId: null,
  selectedFixtureId: null,
  select: (kind, id) =>
    set({
      selectedLightId: kind === "light" ? (id ?? null) : null,
      selectedFixtureId: kind === "fixture" ? (id ?? null) : null,
    }),
}));
