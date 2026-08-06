import { describe, expect, it } from "vitest";
import { AUDIO_MARKERS_VERSION, DEFAULT_AUDIO_FADE_OUT_MS, withAudioDefaults } from "./project";

describe("withAudioDefaults", () => {
  it("fills the house fade-out when the block omits it", () => {
    expect(withAudioDefaults({ file: "assets/song.mp3" }).fadeOutMs).toBe(
      DEFAULT_AUDIO_FADE_OUT_MS,
    );
  });

  it("respects an explicit 0 as a full opt-out", () => {
    expect(withAudioDefaults({ file: "assets/song.mp3", fadeOutMs: 0 }).fadeOutMs).toBe(0);
  });

  it("never overrides an authored value", () => {
    expect(withAudioDefaults({ file: "assets/song.mp3", fadeOutMs: 2500 }).fadeOutMs).toBe(2500);
  });

  it("leaves fade-in undefaulted (cold starts are intended)", () => {
    expect(withAudioDefaults({ file: "assets/song.mp3" }).fadeInMs).toBeUndefined();
  });
});

describe("audio.markers sanitising", () => {
  it("rounds, dedupes and sorts valid markers", () => {
    const out = withAudioDefaults({
      file: "assets/song.mp3",
      markers: { version: AUDIO_MARKERS_VERSION, keyMoments: [2000.4, 500, 500, 1000] },
    });
    expect(out.markers).toEqual({ version: AUDIO_MARKERS_VERSION, keyMoments: [500, 1000, 2000] });
  });

  it("drops a wrong version, bad entries and junk shapes", () => {
    expect(
      withAudioDefaults({ file: "a.mp3", markers: { version: 99, keyMoments: [] } }).markers,
    ).toBeUndefined();
    expect(
      withAudioDefaults({ file: "a.mp3", markers: { version: 1, keyMoments: [-5] } }).markers,
    ).toBeUndefined();
    expect(
      withAudioDefaults({
        file: "a.mp3",
        markers: { version: 1, keyMoments: "x" } as unknown as { version: 1; keyMoments: [] },
      }).markers,
    ).toBeUndefined();
  });

  it("keeps an absent block absent", () => {
    expect(withAudioDefaults({ file: "a.mp3" }).markers).toBeUndefined();
  });
});
