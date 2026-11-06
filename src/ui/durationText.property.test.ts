import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatSceneLengthMs, MIN_SCENE_LENGTH_MS, parseSceneLengthMs } from "./durationText";

describe("scene length text", () => {
  it("round-trips every length on the centisecond grid", () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN_SCENE_LENGTH_MS / 10, max: 100 * 60 * 100 }), (cs) => {
        const ms = cs * 10;
        expect(parseSceneLengthMs(formatSceneLengthMs(ms))).toBe(ms);
      }),
    );
  });

  it("never throws on junk and only ever yields a whole length at or over the floor", () => {
    const text = fc.oneof(
      fc.string(),
      fc.string({ unit: "binary" }),
      fc.stringMatching(/^[\d:.\s+-]{0,24}$/),
      fc.stringMatching(/^\d{1,400}$/),
      fc.stringMatching(/^\d{300,400}$/),
    );
    fc.assert(
      fc.property(text, (text) => {
        const ms = parseSceneLengthMs(text);
        if (ms === null) return;
        expect(Number.isInteger(ms)).toBe(true);
        expect(ms).toBeGreaterThanOrEqual(MIN_SCENE_LENGTH_MS);
      }),
      // 310 digits overflow Number, which once read as an infinite scene length.
      { examples: [["9".repeat(400)]] },
    );
  });
});
