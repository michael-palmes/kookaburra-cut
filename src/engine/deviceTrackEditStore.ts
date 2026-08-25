import { create } from "zustand";
import type { KeyedTrack } from "./keyedTrack";
import type { SceneDocDevicePose } from "./sceneDocSchema";

/** Device-lane UI state: the selected key/segment, following the chartTrackEditStore pattern (the staged device's gizmo state lives in `deviceEditStore.ts`). UI-only, the export path never reads it, and it holds no live draft: devices render straight from the scene document, so lane edits show once the commit patches the doc. */

/** One key's poses, by device id: the whole scene moves on one timeline. */
export type DeviceTrackDoc = KeyedTrack<Record<string, SceneDocDevicePose>>;

interface DeviceTrackEditState {
  /** The inspector's Keyframes toggle: reveals the lane so the first animation can be added. A scene that already carries a track shows its lane regardless. */
  open: boolean;
  selectedKeyId: string | null;
  /** Doc index of the selected segment (opens the easing popover). */
  selectedSegment: number | null;
  writeError: string | null;
  select: (keyId: string | null, segment: number | null) => void;
  setOpen: (open: boolean) => void;
  setWriteError: (err: string | null) => void;
}

export const useDeviceTrackEditStore = create<DeviceTrackEditState>((set) => ({
  open: false,
  selectedKeyId: null,
  selectedSegment: null,
  writeError: null,
  select: (selectedKeyId, selectedSegment) => set({ selectedKeyId, selectedSegment }),
  setOpen: (open) => set(open ? { open } : { open, selectedKeyId: null, selectedSegment: null }),
  setWriteError: (writeError) => set({ writeError }),
}));
