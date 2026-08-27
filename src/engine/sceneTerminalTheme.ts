/** Terminal colour schemes: a preset id resolves to the full surface + ANSI palette the renderer, raster baker and DOM overlay all read. `match-theme` derives from the scene theme's tokens so a themed deck restyles its terminals; the fixed classics carry their own ANSI 16. Unknown ids resolve as `match-theme` (degrade, never crash). Pure colour maths, deterministic integer rounding. */

import type { Theme } from "../theme/tokens";
import type { SceneTerminalColour } from "./sceneTerminal";

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

/** The preset catalogue the inspector's Theme picker offers, `match-theme` first. */
export const TERMINAL_THEME_PRESETS: readonly { id: string; name: string }[] = [
  { id: "match-theme", name: "Match theme" },
  { id: "graphite", name: "Graphite" },
  { id: "abyss", name: "Abyss" },
  { id: "phosphor", name: "Phosphor" },
  { id: "amber", name: "Amber" },
  { id: "paper", name: "Paper" },
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

/** A fixed preset: the shared surfaces derive from screen + foreground so every entry stays four hand-picked values plus its ramp. */
function fixed(
  screen: string,
  foreground: string,
  cursor: string,
  ansi: readonly string[],
): SceneTerminalColours {
  return {
    screen,
    bezel: mixHex(screen, foreground, 0.09),
    foreground,
    cursor,
    titleText: mixHex(foreground, screen, 0.35),
    stroke: foreground,
    ansi,
  };
}

/** The classic xterm ANSI 16, the `match-theme` ramp. */
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

const FIXED_PRESETS: Record<string, SceneTerminalColours> = {
  graphite: fixed("#0d0d0d", "#c7c7c7", "#c7c7c7", [
    "#000000",
    "#c23621",
    "#25bc24",
    "#adad27",
    "#4c66e8",
    "#d338d3",
    "#33bbc8",
    "#cbcccd",
    "#818383",
    "#fc391f",
    "#31e722",
    "#eaec23",
    "#7189ff",
    "#f935f8",
    "#14f0f0",
    "#e9ebeb",
  ]),
  abyss: fixed("#0a1020", "#d7e2f7", "#6f93a8", [
    "#10192e",
    "#ff6b81",
    "#3ddc97",
    "#ffd479",
    "#5ea2ff",
    "#c792ea",
    "#4dd0e1",
    "#c9d4ea",
    "#31405f",
    "#ff8fa3",
    "#63e6ae",
    "#ffe19b",
    "#82b8ff",
    "#dcb0f2",
    "#76dbe8",
    "#f0f4fc",
  ]),
  phosphor: fixed("#051405", "#33ff66", "#33ff66", [
    "#0c2912",
    "#1d7a3c",
    "#2fae54",
    "#43c968",
    "#1a5c31",
    "#27904a",
    "#38bd5e",
    "#7ee2a0",
    "#164423",
    "#2f9e52",
    "#3fd171",
    "#57e685",
    "#22703d",
    "#33ab58",
    "#4cd979",
    "#b4f5c9",
  ]),
  amber: fixed("#140d02", "#ffb000", "#ffb000", [
    "#33240a",
    "#a85e00",
    "#c47c00",
    "#dd9500",
    "#8a4f05",
    "#b06c00",
    "#d18a00",
    "#ffcf66",
    "#4d3812",
    "#c47607",
    "#e09400",
    "#ffae1a",
    "#a3610a",
    "#cc8400",
    "#f0a500",
    "#ffe2a3",
  ]),
  paper: fixed("#f6f5ef", "#23272e", "#4569d4", [
    "#000000",
    "#c0392b",
    "#1e8449",
    "#b7950b",
    "#2456c4",
    "#8e44ad",
    "#148f9c",
    "#5f6368",
    "#8a8f98",
    "#e74c3c",
    "#27ae60",
    "#d4ac0d",
    "#3b6fe0",
    "#a569bd",
    "#17a2b0",
    "#1f2328",
  ]),
};

/** Resolve a preset id against the scene theme. `match-theme` (and any unknown id) recesses the theme background for the screen (deep on dark themes, a touch on light ones) so the terminal reads as its own surface. */
export function resolveTerminalColours(presetId: string, theme: Theme): SceneTerminalColours {
  const preset = FIXED_PRESETS[presetId];
  if (preset) return preset;
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

/** xterm's 256-colour ramp above the ANSI 16: the 6x6x6 cube then the 24-step greys. */
export function ansi256(index: number, colours: SceneTerminalColours): string {
  const i = Math.round(index);
  if (i < 16) return colours.ansi[Math.max(0, i)];
  if (i < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const n = i - 16;
    return toHex(steps[Math.floor(n / 36) % 6], steps[Math.floor(n / 6) % 6], steps[n % 6]);
  }
  const g = 8 + 10 * (Math.min(i, 255) - 232);
  return toHex(g, g, g);
}

/** A run colour to paint: palette indices resolve through the preset (then the 256 ramp), hexes pass through, and null/absent means the default for its side, the foreground for `fg` and transparent (null) for `bg`. */
export function terminalRunColour(
  value: SceneTerminalColour | null | undefined,
  colours: SceneTerminalColours,
  side: "fg" | "bg",
): string | null {
  if (value === null || value === undefined) {
    return side === "fg" ? colours.foreground : null;
  }
  if (typeof value === "number") return ansi256(value, colours);
  return value;
}
