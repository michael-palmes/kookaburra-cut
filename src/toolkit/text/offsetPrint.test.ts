import { describe, expect, it } from "vitest";
import type { Theme } from "../../theme/tokens";
import { offsetPrintOffset } from "./lookStyle";
import { DEFAULT_LOOK_OFFSET_DIR_DEG, resolveTextLook } from "./looks";

const theme = {
  colors: { background: "#000", text: "#fff", accent: "#08f", muted: "#888" },
} as unknown as Theme;

describe("offset-print direction and opacity", () => {
  it("leaves both absent unless authored, so the legacy expression stays", () => {
    const look = resolveTextLook({ look: "offset-print" }, theme);
    expect(look).not.toHaveProperty("offsetDir");
    expect(look).not.toHaveProperty("offsetOpacity");
    if (!look) throw new Error("look");
    expect(offsetPrintOffset(look, 0.5)).toEqual([0.06 * 0.5, -(0.06 * 0.5)]);
  });

  it("normalises the direction and clamps the opacity", () => {
    const look = resolveTextLook(
      { look: "offset-print", offsetDir: -90, offsetOpacity: 1.4 },
      theme,
    );
    expect(look?.offsetDir).toBe(270);
    expect(look?.offsetOpacity).toBe(1);
    expect(resolveTextLook({ offsetOpacity: 0.4 }, theme)).not.toBeNull();
  });

  it("turns the default diagonal distance to the direction, clockwise from up", () => {
    const base = resolveTextLook({ look: "offset-print" }, theme);
    if (!base) throw new Error("look");
    const legacy = offsetPrintOffset(base, 1);
    const turned = offsetPrintOffset({ ...base, offsetDir: DEFAULT_LOOK_OFFSET_DIR_DEG }, 1);
    expect(turned[0]).toBeCloseTo(legacy[0], 12);
    expect(turned[1]).toBeCloseTo(legacy[1], 12);
    const up = offsetPrintOffset({ ...base, offsetDir: 0 }, 1);
    expect(up[0]).toBeCloseTo(0, 12);
    expect(up[1]).toBeCloseTo(0.06 * Math.SQRT2, 12);
  });
});
