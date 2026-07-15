import { describe, expect, it } from "vitest";
import { DEFAULT_AUDIO_FADE_OUT_MS, withAudioDefaults } from "./project";

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
