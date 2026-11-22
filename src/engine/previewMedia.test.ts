import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function fresh() {
  vi.resetModules();
  return await import("./previewMedia");
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the preview's scrub state", () => {
  it("keeps a lone step exact and calls a run of moves a scrub until the playhead rests", async () => {
    const media = await fresh();
    const changes = vi.fn();
    media.subscribePreviewScrub(changes);
    media.notePreviewClockMove(1000);
    expect(media.previewScrubActive()).toBe(false);
    media.notePreviewClockMove(1016);
    expect(media.previewScrubActive()).toBe(true);
    vi.advanceTimersByTime(179);
    media.notePreviewClockMove(1195);
    vi.advanceTimersByTime(179);
    expect(media.previewScrubActive()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(media.previewScrubActive()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("ends the scrub the moment an export or capture begins", async () => {
    const media = await fresh();
    const { setExporting } = await import("./exportState");
    media.notePreviewClockMove(1000);
    media.notePreviewClockMove(1016);
    setExporting(true);
    try {
      expect(media.previewScrubActive()).toBe(false);
    } finally {
      setExporting(false);
    }
  });

  it("treats steps a beat apart as steps", async () => {
    const media = await fresh();
    media.notePreviewClockMove(1000);
    media.notePreviewClockMove(1400);
    expect(media.previewScrubActive()).toBe(false);
  });

  it("never calls playback a scrub", async () => {
    const media = await fresh();
    media.setPreviewPlaybackActive(true);
    media.notePreviewClockMove(1000);
    media.notePreviewClockMove(1016);
    expect(media.previewScrubActive()).toBe(false);
  });
});
