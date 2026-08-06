import { create } from "zustand";

/** The chart data modal's open state, its own tiny store so anything can raise it (the Chart drill's Edit data row, the palette's "Edit chart data" command, a double-click on a data keyframe) without threading callbacks through the inspector. Chrome-only, like uiStore: the export path never reads it. `keyId` picks which data keyframe the grid edits; null edits the block's static values. */
interface ChartDataModalState {
  open: boolean;
  keyId: string | null;
  openChartDataModal: (keyId?: string) => void;
  closeChartDataModal: () => void;
}

export const useChartDataModalStore = create<ChartDataModalState>((set) => ({
  open: false,
  keyId: null,
  openChartDataModal: (keyId) => set({ open: true, keyId: keyId ?? null }),
  closeChartDataModal: () => set({ open: false, keyId: null }),
}));

/** Open the data modal, optionally on one data keyframe. */
export function openChartDataModal(keyId?: string): void {
  useChartDataModalStore.getState().openChartDataModal(keyId);
}

export function closeChartDataModal(): void {
  useChartDataModalStore.getState().closeChartDataModal();
}
