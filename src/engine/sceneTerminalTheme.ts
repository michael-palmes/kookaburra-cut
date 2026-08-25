/** Terminal colour schemes: a preset id resolves to the full surface + ANSI palette the renderer, raster baker and DOM overlay all read. `match-theme` derives from the scene theme's tokens so a themed deck restyles its terminals; the catalogue of fixed classics lands with the capture work. Unknown ids resolve as `match-theme` (degrade, never crash). Pure colour maths, deterministic integer rounding. */

import type { Theme } from "../theme/tokens";

export interface SceneTerminalColours {
  /** The grid area's background. */
  screen: string;
  /** Title bar and the bezel margin around the screen. */
  bezel: string;
  foreground: string;
  cursor: string;
  titleText: string;
  /** Window edge stroke colour; the renderer owns its alpha. */
  stroke: string;
  /** ANSI 0-15. */
  ansi: readonly string[];
}

/** The classic xterm ANSI 16, the fallback ramp until preset palettes land. */
const ANSI_XTERM: readonly string[] = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];

function channels(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1, 7), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** `a` moved toward `b` by `t` (0..1), per channel. */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/** Rec. 709 luma on the raw sRGB bytes, enough to pick a light or dark treatment. */
function luma(hex: string): number {
  const [r, g, b] = channels(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Resolve a preset id against the scene theme. Recesses the theme background for the screen (deep on dark themes, a touch on light ones) so the terminal reads as its own surface. */
export function resolveTerminalColours(presetId: string, theme: Theme): SceneTerminalColours {
  void presetId;
  const { background, text, accent, muted } = theme.colors;
  const light = luma(background) > 0.5;
  const screen = mixHex(background, "#000000", light ? 0.05 : 0.4);
  return {
    screen,
    bezel: mixHex(background, text, light ? 0.1 : 0.08),
    foreground: text,
    cursor: accent,
    titleText: muted,
    stroke: text,
    ansi: ANSI_XTERM,
  };
}
