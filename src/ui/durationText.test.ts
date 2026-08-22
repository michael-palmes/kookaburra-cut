import { describe, expect, it } from "vitest";
import {
  formatSceneLength,
  formatSceneLengthMs,
  MIN_SCENE_LENGTH_MS,
  parseSceneLength,
  parseSceneLengthMs,
} from "./durationText";

describe("formatSceneLength", () => {
  it("spells seconds as m:ss.cs", () => {
    expect(formatSceneLength(8.5)).toBe("0:08.50");
    expect(formatSceneLength(105)).toBe("1:45.00");
    expect(formatSceneLength(0.1)).toBe("0:00.10");
    expect(formatSceneLength(0)).toBe("0:00.00");
  });

  it("carries the minute when the centiseconds round up", () => {
    expect(formatSceneLength(59.999)).toBe("1:00.00");
  });

  it("rounds to the nearest centisecond, matching toFixed(2)", () => {
    expect(formatSceneLength(8.505)).toBe("0:08.51");
    expect(formatSceneLength(8.504)).toBe("0:08.50");
  });

  it("leaves minutes unpadded", () => {
    expect(formatSceneLength(6000)).toBe("100:00.00");
  });

  it("renders negatives and non-finite values as zero", () => {
    expect(formatSceneLength(-5)).toBe("0:00.00");
    expect(formatSceneLength(Number.NaN)).toBe("0:00.00");
    expect(formatSceneLength(Number.POSITIVE_INFINITY)).toBe("0:00.00");
  });
});

describe("formatSceneLengthMs", () => {
  it("spells milliseconds as m:ss.cs", () => {
    expect(formatSceneLengthMs(8_500)).toBe("0:08.50");
    expect(formatSceneLengthMs(105_000)).toBe("1:45.00");
    expect(formatSceneLengthMs(8_505)).toBe("0:08.51");
  });
});

describe("parseSceneLength", () => {
  it("takes m:ss", () => {
    expect(parseSceneLength("1:45")).toBe(105);
    expect(parseSceneLength("1:5")).toBe(65);
    expect(parseSceneLength("100:00")).toBe(6000);
  });

  it("takes fractional seconds in m:ss form", () => {
    expect(parseSceneLength("1:45.5")).toBe(105.5);
    expect(parseSceneLength("0:08.50")).toBe(8.5);
  });

  it("takes a leading colon as seconds only", () => {
    expect(parseSceneLength(":30")).toBe(30);
  });

  it("takes plain seconds", () => {
    expect(parseSceneLength("105")).toBe(105);
    expect(parseSceneLength("8.5")).toBe(8.5);
    expect(parseSceneLength(".5")).toBe(0.5);
    expect(parseSceneLength("8.")).toBe(8);
  });

  it("trims surrounding whitespace", () => {
    expect(parseSceneLength(" 1:45 ")).toBe(105);
  });

  it("rejects a half-typed m:ss", () => {
    expect(parseSceneLength("1:")).toBeNull();
  });

  it("rejects 60 and over in the seconds field rather than normalising it", () => {
    expect(parseSceneLength("1:75")).toBeNull();
    expect(parseSceneLength("1:60")).toBeNull();
  });

  it("rejects negatives", () => {
    expect(parseSceneLength("-5")).toBeNull();
    expect(parseSceneLength("-1:30")).toBeNull();
  });

  it("rejects empty and whitespace-only text", () => {
    expect(parseSceneLength("")).toBeNull();
    expect(parseSceneLength("   ")).toBeNull();
  });

  it("rejects junk", () => {
    for (const text of ["abc", "1:45:30", "1.2:30", ":", ".", "12:345"]) {
      expect(parseSceneLength(text)).toBeNull();
    }
  });

  it("rejects the number forms Number() would have taken", () => {
    for (const text of ["+8", "1e3", "0x10", "Infinity"]) {
      expect(parseSceneLength(text)).toBeNull();
    }
  });

  it("round trips the formatter's own output", () => {
    for (const ms of [100, 8_500, 105_000, 3_600_000]) {
      const seconds = parseSceneLength(formatSceneLengthMs(ms));
      expect(seconds).not.toBeNull();
      expect(Math.round((seconds as number) * 1000)).toBe(ms);
    }
  });

  it("re-commits a sub-centisecond duration at the displayed value, as toFixed(2) did", () => {
    expect(parseSceneLengthMs(formatSceneLengthMs(8_505))).toBe(8_510);
  });
});

describe("parseSceneLengthMs", () => {
  it("returns whole milliseconds", () => {
    expect(parseSceneLengthMs("1:45")).toBe(105_000);
    expect(parseSceneLengthMs("8.5")).toBe(8_500);
    expect(parseSceneLengthMs("0:08.50")).toBe(8_500);
  });

  it("accepts exactly the floor and drops anything under it", () => {
    expect(parseSceneLengthMs("0.1")).toBe(100);
    expect(parseSceneLengthMs("0.099")).toBeNull();
    expect(parseSceneLengthMs("0.05")).toBeNull();
    expect(parseSceneLengthMs("0")).toBeNull();
  });

  it("drops junk", () => {
    expect(parseSceneLengthMs("abc")).toBeNull();
  });

  it("pins the floor", () => {
    expect(MIN_SCENE_LENGTH_MS).toBe(100);
  });
});
