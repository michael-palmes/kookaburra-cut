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

  it("defaults the panel to the theme background (white -> linear 1,1,1)", () => {
    const out = resolveOverlays([frame], [theme]);
    expect(out?.[0]?.panelColor).toEqual([1, 1, 1]);
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
