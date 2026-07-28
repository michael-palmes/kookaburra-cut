import type { Theme } from "../../../theme/tokens";

/** Bundled looks for each 3D background: 9 per look (p1-p5 light, p6-p9 dark), applied wholesale by the inspector's preset tiles like the shader packs (docs/backgrounds.md; the same luminance bands and AA rules apply to every geometry colour AND the backing). `backing` is the camera-locked fill stamped behind the geometry on apply; the schema accepts any 2D background there, presets keep it a flat colour. */

export interface Scene3dBackgroundPreset {
  /** Look-scoped id (p1..p9); pair with the look id, never unique alone. */
  id: string;
  name: string;
  /** Light presets carry black text at AA; dark presets carry white. */
  mode: "light" | "dark";
  /** AA-checked text colour over every stop (card metadata / contrast hints). */
  textColor: string;
  /** One hex per geometry colour slot, in slot order. */
  colors: string[];
  /** Flat backing colour stamped as `backing: { type: "color" }` on apply. */
  backing: string;
  speed?: number;
  params?: Record<string, number>;
}

export const SCENE3D_BACKGROUND_PRESETS: Record<string, Scene3dBackgroundPreset[]> = {
  "grid-plain": [
    {
      id: "p1",
      name: "Lord Howe",
      mode: "light",
      textColor: "#000000",
      colors: ["#7ccae3"],
      backing: "#e2f3fb",
      speed: 0.4,
      params: { spacing: 1.2, height: -2, clearRadius: 4, fadeRadius: 44, drift: 1, opacity: 0.8 },
    },
    {
      id: "p2",
      name: "Currumbin",
      mode: "light",
      textColor: "#000000",
      colors: ["#d6bd74"],
      backing: "#f5f0dc",
      speed: 0.35,
      params: {
        spacing: 1.6,
        height: -2.2,
        clearRadius: 5,
        fadeRadius: 50,
        drift: 0.6,
        opacity: 0.7,
      },
    },
    {
      id: "p3",
      name: "Daylesford",
      mode: "light",
      textColor: "#000000",
      colors: ["#73d383"],
      backing: "#ddf6e4",
      speed: 0.45,
      params: {
        spacing: 0.9,
        height: -1.8,
        clearRadius: 3.5,
        fadeRadius: 38,
        drift: 1.4,
        opacity: 0.75,
      },
    },
    {
      id: "p4",
      name: "Pemberton",
      mode: "light",
      textColor: "#000000",
      colors: ["#82d272"],
      backing: "#e3f5dd",
      speed: 0.3,
      params: {
        spacing: 2.2,
        height: -2.5,
        clearRadius: 6,
        fadeRadius: 60,
        drift: 0.8,
        opacity: 0.85,
      },
    },
    {
      id: "p5",
      name: "Ceduna",
      mode: "light",
      textColor: "#000000",
      colors: ["#ffaa8e"],
      backing: "#feede4",
      speed: 0.5,
      params: {
        spacing: 1.3,
        height: -2,
        clearRadius: 4.5,
        fadeRadius: 46,
        drift: 1.1,
        opacity: 0.7,
      },
    },
    {
      id: "p6",
      name: "Gulf Night",
      mode: "dark",
      textColor: "#ffffff",
      colors: ["#3b5c7d"],
      backing: "#0d1218",
      speed: 0.4,
      params: { spacing: 1.2, height: -2, clearRadius: 4, fadeRadius: 44, drift: 1, opacity: 0.8 },
    },
    {
      id: "p7",
      name: "Tanami",
      mode: "dark",
      textColor: "#ffffff",
      colors: ["#765137"],
      backing: "#17110d",
      speed: 0.35,
      params: {
        spacing: 1.8,
        height: -2.4,
        clearRadius: 5.5,
        fadeRadius: 55,
        drift: 0.7,
        opacity: 0.9,
      },
    },
    {
      id: "p8",
      name: "Oodnadatta",
      mode: "dark",
      textColor: "#ffffff",
      colors: ["#8b424f"],
      backing: "#1a0f10",
      speed: 0.45,
      params: {
        spacing: 1,
        height: -1.8,
        clearRadius: 3.5,
        fadeRadius: 40,
        drift: 1.3,
        opacity: 0.75,
      },
    },
    {
      id: "p9",
      name: "Silverton",
      mode: "dark",
      textColor: "#ffffff",
      colors: ["#694997"],
      backing: "#14101c",
      speed: 0.3,
      params: {
        spacing: 1.4,
        height: -2.1,
        clearRadius: 4.5,
        fadeRadius: 48,
        drift: 0.9,
        opacity: 0.85,
      },
    },
  ],
};

/** The anchor preset backing a 3D look's Theme tile and live-derived colours: `p1` for light themes, `p6` for dark (the shader-pack convention). */
export function scene3dThemeAnchor(
  look: string,
  theme: Theme,
): Scene3dBackgroundPreset | undefined {
  const mode = theme.mode ?? "dark";
  return SCENE3D_BACKGROUND_PRESETS[look]?.find((p) => p.id === (mode === "light" ? "p1" : "p6"));
}
