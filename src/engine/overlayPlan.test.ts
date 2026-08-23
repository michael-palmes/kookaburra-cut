import { describe, expect, it } from "vitest";
import type { GradientSpec, Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import { overlayPanelImageSources, resolveOverlays } from "./overlayPlan";
import type { SceneDoc } from "./sceneDocSchema";

const theme = {
  colors: { background: "#ffffff", text: "#000000", accent: "#ff0000", muted: "#808080" },
} as Theme;

const frame = { cutout: { shape: "rounded-rect" } } as const;

const panelFrame = (background: FrameSpec["background"]): FrameSpec => ({
  cutout: frame.cutout,
  background,
});

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

  it("proxies the default from the theme's colour background, not the flat token", () => {
    const themed = {
      colors: { background: "#ffffff", text: "#000000", accent: "#ff0000", muted: "#808080" },
      background: { type: "color", color: "#0000ff" },
    } as Theme;
    const [r, g, b] = resolveOverlays([frame], [themed])?.[0]?.panelColor ?? [0, 0, 0];
    // Blue lifted slightly toward black: blue stays dominant, so the panel tracks the backdrop.
    expect(b).toBeGreaterThan(0.5);
    expect(r).toBeLessThan(0.01);
    expect(g).toBeLessThan(0.01);
  });

  it("proxies a gradient as the mean of its stops", () => {
    const themed = {
      colors: { background: "#ffffff", text: "#000000", accent: "#ff0000", muted: "#808080" },
      background: {
        type: "gradient",
        spec: {
          type: "linear",
          angleDeg: 0,
          stops: [
            ["#000000", 0],
            ["#ffffff", 1],
          ],
        },
      },
    } as Theme;
    const [r, g, b] = resolveOverlays([frame], [themed])?.[0]?.panelColor ?? [0, 0, 0];
    // Mid-grey lifted toward black: all channels equal, well inside (0, 1).
    expect(g).toBeCloseTo(r, 10);
    expect(b).toBeCloseTo(r, 10);
    expect(r).toBeGreaterThan(0.05);
    expect(r).toBeLessThan(0.6);
  });

  it("falls back to the flat token for procedural fills, preserving today's default", () => {
    const themed = {
      colors: { background: "#000000", text: "#ffffff", accent: "#ff0000", muted: "#808080" },
      background: { type: "shader", shader: "smoke" },
    } as Theme;
    const withShader = resolveOverlays([frame], [themed])?.[0]?.panelColor;
    const plain = {
      colors: { background: "#000000", text: "#ffffff", accent: "#ff0000", muted: "#808080" },
    } as Theme;
    expect(withShader).toEqual(resolveOverlays([frame], [plain])?.[0]?.panelColor);
  });

  it("a plain string, an unset background and an explicit colour all take the flat fill", () => {
    const out = resolveOverlays(
      [frame, panelFrame("text"), panelFrame({ type: "color", color: "#ffffff" })],
      [theme, theme, theme],
    );
    expect(out?.map((o) => o?.panel.kind)).toEqual(["colour", "colour", "colour"]);
    expect(out?.[2]?.panelColor).toEqual([1, 1, 1]);
  });

  it("bakes an inline gradient and keys it by the fields the raster reads", () => {
    const spec: GradientSpec = {
      type: "linear",
      angleDeg: 90,
      stops: [
        ["#000000", 0],
        ["#ffffff", 1],
      ],
    };
    const panel = resolveOverlays([panelFrame({ type: "gradient", spec })], [theme])?.[0]?.panel;
    expect(panel).toMatchObject({ kind: "gradient", spec });
    expect(panel?.kind === "gradient" && panel.key).toBe(
      JSON.stringify(["linear", 90, "srgb", spec.stops]),
    );
  });

  it("resolves a named gradient through the theme, degrading to the flat fill when it's missing", () => {
    const spec: GradientSpec = {
      type: "radial",
      angleDeg: 0,
      stops: [
        ["#000000", 0],
        ["#ffffff", 1],
      ],
    };
    const themed = { ...theme, gradients: { backdrop: spec } } as Theme;
    const named = panelFrame({ type: "gradient", gradient: "backdrop" });
    expect(resolveOverlays([named], [themed])?.[0]?.panel).toMatchObject({
      kind: "gradient",
      spec,
    });
    expect(resolveOverlays([named], [theme])?.[0]?.panel.kind).toBe("colour");
  });

  it("carries an image fill with its project, and falls back to the flat fill with no project", () => {
    const image = panelFrame({ type: "image", src: "assets/panel.png" });
    expect(resolveOverlays([image], [theme], [], "ws:deck")?.[0]?.panel).toEqual({
      kind: "image",
      projectId: "ws:deck",
      src: "assets/panel.png",
    });
    expect(resolveOverlays([image], [theme])?.[0]?.panel.kind).toBe("colour");
  });

  it("a transparent panel fills with the backdrop itself, not the lifted surface", () => {
    const themed = {
      colors: { background: "#ffffff", text: "#000000", accent: "#ff0000", muted: "#808080" },
      background: { type: "color", color: "#0000ff" },
    } as Theme;
    const out = resolveOverlays([panelFrame({ type: "transparent" })], [themed]);
    expect(out?.[0]?.panel.kind).toBe("transparent");
    // The backdrop verbatim, so the panel region reads as the backdrop continuing behind the cutout.
    expect(out?.[0]?.panelColor).toEqual(
      resolveOverlays([panelFrame("#0000ff")], [themed])?.[0]?.panelColor,
    );
    // And distinctly not the neutral surface an unset panel takes on the same theme.
    expect(out?.[0]?.panelColor).not.toEqual(resolveOverlays([frame], [themed])?.[0]?.panelColor);
  });

  it("lists every panel image source once, for the preload barrier", () => {
    expect(
      overlayPanelImageSources([
        panelFrame({ type: "image", src: "assets/a.png" }),
        panelFrame({ type: "image", src: "assets/a.png" }),
        panelFrame({ type: "image", src: "assets/b.png" }),
        panelFrame("accent"),
        undefined,
      ]),
    ).toEqual(["assets/a.png", "assets/b.png"]);
  });

  it("a scene doc's own background override wins over the theme's", () => {
    const themed = {
      colors: { background: "#ffffff", text: "#000000", accent: "#ff0000", muted: "#808080" },
      background: { type: "color", color: "#ff0000" },
    } as Theme;
    const doc = { version: 1, background: { type: "color", color: "#0000ff" } } as SceneDoc;
    const [r, , b] = resolveOverlays([frame], [themed], [doc])?.[0]?.panelColor ?? [0, 0, 0];
    expect(b).toBeGreaterThan(r);
  });
});
