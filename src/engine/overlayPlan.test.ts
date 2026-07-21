import { describe, expect, it } from "vitest";
import type { Theme } from "../theme/tokens";
import { resolveOverlays } from "./overlayPlan";

const theme = {
  colors: { background: "#ffffff", text: "#000000", accent: "#ff0000", muted: "#808080" },
} as Theme;

const frame = { cutout: { shape: "rounded-rect" } } as const;

describe("resolveOverlays", () => {
  it("returns null when no scene has a frame, keeping the byte-identical path", () => {
    expect(resolveOverlays([undefined, undefined], [theme, theme])).toBeNull();
  });

  it("resolves only the scenes that have a frame", () => {
    const out = resolveOverlays([frame, undefined], [theme, theme]);
    expect(out).not.toBeNull();
    expect(out?.[0]?.frame).toBe(frame);
    expect(out?.[1]).toBeNull();
  });

  it("defaults the panel to a neutral surface lifted off the background toward the text", () => {
    const dark = {
      colors: { background: "#000000", text: "#ffffff", accent: "#ff0000", muted: "#808080" },
    } as Theme;
    const [r, g, b] = resolveOverlays([frame], [dark])?.[0]?.panelColor ?? [0, 0, 0];
    // Black lifted 10% toward white: a dark grey, equal on all channels, strictly between.
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
    expect(g).toBeCloseTo(r, 10);
    expect(b).toBeCloseTo(r, 10);
  });

  it("resolves a token to its theme colour in linear space", () => {
    const out = resolveOverlays([{ cutout: frame.cutout, background: "text" }], [theme]);
    expect(out?.[0]?.panelColor).toEqual([0, 0, 0]);
  });

  it("takes a hex override straight, converted to linear", () => {
    const out = resolveOverlays([{ cutout: frame.cutout, background: "#ffffff" }], [theme]);
    expect(out?.[0]?.panelColor).toEqual([1, 1, 1]);
  });

  it("skips a scene whose theme failed to resolve", () => {
    const out = resolveOverlays([frame], [undefined as unknown as Theme]);
    expect(out?.[0]).toBeNull();
  });
});
