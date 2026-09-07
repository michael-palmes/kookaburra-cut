import { create } from "zustand";

interface WebsiteEditState {
  selected: { sceneIndex: number } | null;
  select: (selected: WebsiteEditState["selected"]) => void;
}

export const useWebsiteEditStore = create<WebsiteEditState>((set) => ({
  selected: null,
  select: (selected) => set({ selected }),
}));
