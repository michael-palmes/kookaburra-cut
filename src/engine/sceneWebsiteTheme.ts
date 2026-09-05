import type { Theme } from "../theme/tokens";
import { mixHex } from "./sceneTerminalTheme";
import type { ResolvedSceneWebsite } from "./sceneWebsite";

export interface WebsiteColours {
  toolbar: string;
  page: string;
  originBar: string;
  text: string;
  muted: string;
  stroke: string;
}

function luma(hex: string): number {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return (
    (0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255)) / 255
  );
}

export function resolveWebsiteColours(website: ResolvedSceneWebsite, theme: Theme): WebsiteColours {
  const mode =
    website.frame.appearance === "match-theme"
      ? (theme.mode ?? (luma(theme.colors.background) > 0.5 ? "light" : "dark"))
      : website.frame.appearance;
  if (mode === "light") {
    return {
      toolbar: "#e8e8eb",
      page: "#ffffff",
      originBar: "#f7f7f9",
      text: "#202124",
      muted: "#6d7178",
      stroke: "#202124",
    };
  }
  if (website.frame.appearance === "dark") {
    return {
      toolbar: "#222326",
      page: "#111214",
      originBar: "#303136",
      text: "#f2f3f5",
      muted: "#a4a8b0",
      stroke: "#ffffff",
    };
  }
  const { background, text, muted } = theme.colors;
  return {
    toolbar: mixHex(background, text, 0.1),
    page: mixHex(background, text, 0.025),
    originBar: mixHex(background, text, 0.16),
    text,
    muted,
    stroke: text,
  };
}
