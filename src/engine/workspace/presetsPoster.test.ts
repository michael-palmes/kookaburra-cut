import { describe, expect, it, vi } from "vitest";
import {
  bundledPresetPreview,
  isPresetPreviewStale,
  listAllPresets,
  subscribePresets,
  updateBundledPresetPoster,
} from "./presets";

describe("saved bundled preset posters", () => {
  it("refreshes both gallery subscribers with one shared catalogue and image URL", () => {
    const before = listAllPresets();
    const preset = before.find((entry) => entry.source === "bundled");
    expect(preset).toBeDefined();
    if (!preset) return;
    const snapshots: ReturnType<typeof listAllPresets>[] = [];
    const unsubscribe = [
      subscribePresets(() => snapshots.push(listAllPresets())),
      subscribePresets(() => snapshots.push(listAllPresets())),
    ];
    try {
      updateBundledPresetPoster(`preset:${preset.id}`, 1234);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]).toBe(snapshots[1]);
      expect(snapshots[0]).not.toBe(before);
      expect(snapshots[0].find((entry) => entry.id === preset.id)?.previewUrl).toBe(
        `/presets/${preset.id}/poster.png?v=1234`,
      );
      expect(bundledPresetPreview(preset.id)).toBe(`/presets/${preset.id}/poster.png?v=1234`);
      expect(isPresetPreviewStale(preset.id)).toBe(false);
    } finally {
      for (const stop of unsubscribe) stop();
    }
  });

  it("ignores workspace and template snapshots", () => {
    const changed = vi.fn();
    const stop = subscribePresets(changed);
    const before = listAllPresets();
    try {
      for (const id of ["ws:hero", "ws-preset:hero", "template:hero", "hero"]) {
        updateBundledPresetPoster(id, 4567);
      }
      expect(changed).not.toHaveBeenCalled();
      expect(listAllPresets()).toBe(before);
    } finally {
      stop();
    }
  });
});
