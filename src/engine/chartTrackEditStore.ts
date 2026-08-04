import { create } from "zustand";
import type { ChartValuesPose } from "../toolkit/chart/types";
import type { KeyedTrack } from "./keyedTrack";

/** Chart data-lane UI state: lane open plus the selected key/segment, the compareEditStore pattern (the staged chart's gizmo state lives in `chartEditStore.ts`). UI-only, the export path never reads it, and unlike the camera and divider stores it holds no live draft: the chart renders straight from the scene document, so lane edits show once the commit patches the doc (a draft merge would have to sit on the shared render path the export loop also walks). */

export type ChartTrackDoc = KeyedTrack<ChartValuesPose>;

interface ChartTrackEditState {
  /** The data lane is expanded (set while the lane is mounted). */
  open: boolean;
  selectedKeyId: string | null;
  /** Doc index of the selected segment (opens the easing popover). */
  selectedSegment: number | null;
  writeError: string | null;
  setOpen: (open: boolean) => void;
  select: (keyId: string | null, segment: number | null) => void;
  setWriteError: (err: string | null) => void;
}

export const useChartTrackEditStore = create<ChartTrackEditState>((set) => ({
  open: false,
  selectedKeyId: null,
  selectedSegment: null,
  writeError: null,
  setOpen: (open) => set({ open }),
  select: (selectedKeyId, selectedSegment) => set({ selectedKeyId, selectedSegment }),
  setWriteError: (writeError) => set({ writeError }),
}));
