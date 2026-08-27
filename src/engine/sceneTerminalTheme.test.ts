import { describe, expect, it } from "vitest";
import type { Theme } from "../theme/tokens";
import { isWideCodePoint } from "./sceneTerminalRaster";
import {
  ansi256,
  mixHex,
  resolveTerminalColours,
  TERMINAL_THEME_PRESETS,
  terminalRunColour,
} from "./sceneTerminalTheme";

const dark = {
  colors: { background: "#0b0e14", text: "#f0efeb", accent: "#6f93a8", muted: "#8a8f98" },
} as Theme;
const light = {
  colors: { background: "#f5f4ef", text: "#1f2328", accent: "#4569d4", muted: "#5f6368" },
} as Theme;

const HEX = /^#[0-9a-f]{6}$/;

describe("terminal theme presets", () => {
  it("every preset resolves complete and valid", () => {
    for (const preset of TERMINAL_THEME_PRESETS) {
      const colours = resolveTerminalColours(preset.id, dark);
      expect(colours.ansi).toHaveLength(16);
      for (const value of [
        colours.screen,
        colours.bezel,
        colours.foreground,
        colours.cursor,
        colours.titleText,
        colours.stroke,
        ...colours.ansi,
      ]) {
        expect(value).toMatch(HEX);
      }
    }
  });

  it("match-theme derives from tokens, dark recessing deeper than light", () => {
    const onDark = resolveTerminalColours("match-theme", dark);
    expect(onDark.foreground).toBe(dark.colors.text);
    expect(onDark.cursor).toBe(dark.colors.accent);
    expect(onDark.screen).toBe(mixHex(dark.colors.background, "#000000", 0.4));
    const onLight = resolveTerminalColours("match-theme", light);
    expect(onLight.screen).toBe(mixHex(light.colors.background, "#000000", 0.05));
  });

  it("unknown ids degrade to match-theme, fixed ids ignore the theme", () => {
    expect(resolveTerminalColours("no-such-preset", dark)).toEqual(
      resolveTerminalColours("match-theme", dark),
    );
    expect(resolveTerminalColours("graphite", dark)).toEqual(
      resolveTerminalColours("graphite", light),
    );
  });
});

describe("ansi256", () => {
  it("maps the 16 through the preset and the cube + greys by formula", () => {
    const colours = resolveTerminalColours("graphite", dark);
    expect(ansi256(1, colours)).toBe(colours.ansi[1]);
    expect(ansi256(16, colours)).toBe("#000000");
    expect(ansi256(196, colours)).toBe("#ff0000");
    expect(ansi256(231, colours)).toBe("#ffffff");
    expect(ansi256(232, colours)).toBe("#080808");
    expect(ansi256(255, colours)).toBe("#eeeeee");
  });
});

describe("terminalRunColour", () => {
  it("defaults fg to the foreground, bg to transparent, and passes hexes through", () => {
    const colours = resolveTerminalColours("abyss", dark);
    expect(terminalRunColour(null, colours, "fg")).toBe(colours.foreground);
    expect(terminalRunColour(null, colours, "bg")).toBeNull();
    expect(terminalRunColour(3, colours, "fg")).toBe(colours.ansi[3]);
    expect(terminalRunColour("#123456", colours, "bg")).toBe("#123456");
  });
});

describe("isWideCodePoint", () => {
  it("advances CJK and emoji by two cells and ASCII by one", () => {
    expect(isWideCodePoint("A".codePointAt(0) ?? 0)).toBe(false);
    expect(isWideCodePoint("終".codePointAt(0) ?? 0)).toBe(true);
    expect(isWideCodePoint("🚀".codePointAt(0) ?? 0)).toBe(true);
  });
});
