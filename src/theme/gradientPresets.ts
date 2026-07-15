import type { GradientSpec } from "./tokens";

/** Bundled gradient presets: the five hex stops per preset are the GROUND TRUTH (the source oklch annotations were approximate); the raster interpolates between them perceptually (`space: "oklch"`). Data-only, editable without touching code. `angleDeg: 180` = start colour at the top. */

export interface GradientPreset {
  name: string;
  mode: "light" | "dark";
  /** AA-checked text colour over the full ramp (card metadata / future contrast hints). */
  textColor: string;
  spec: GradientSpec;
}

function preset(
  name: string,
  mode: "light" | "dark",
  textColor: string,
  hexes: string[],
): GradientPreset {
  return {
    name,
    mode,
    textColor,
    spec: {
      type: "linear",
      angleDeg: 180,
      space: "oklch",
      stops: hexes.map((hex, i) => [hex, i / (hexes.length - 1)] as [string, number]),
    },
  };
}

export const GRADIENT_PRESETS: GradientPreset[] = [
  preset("Teal Drift", "light", "#000000", ["#CFEDE6", "#C7E9E7", "#BFE4E8", "#B7DFE8", "#AFD9E8"]),
  preset("Slate Bloom", "light", "#000000", [
    "#DCE3EC",
    "#D5DDE8",
    "#CFD8E5",
    "#CAD5E3",
    "#C6D2E2",
  ]),
  preset("Dawn Quartz", "light", "#000000", [
    "#F3E1E4",
    "#F1DEE2",
    "#EFDBE0",
    "#EDD9DF",
    "#EBD7DE",
  ]),
  preset("Sage Whisper", "light", "#000000", [
    "#DDE7D6",
    "#D7E2CE",
    "#D2DDC7",
    "#CDD8C2",
    "#C9D8BE",
  ]),
  preset("Sand Clay", "light", "#000000", ["#EDE0CF", "#EAD9C5", "#E7D3BD", "#E5CEB8", "#E3C9B4"]),
  preset("Pale Ocean", "light", "#000000", ["#D3EAEA", "#CBE5E7", "#C4E0E5", "#BDDCE3", "#B7DCE1"]),
  preset("Lilac Haze", "light", "#000000", ["#E5DEF0", "#E0D8ED", "#DBD2EB", "#D6CDE9", "#D2C9E8"]),
  preset("Frost Linen", "light", "#000000", [
    "#ECEAE4",
    "#E8E7E3",
    "#E3E3E1",
    "#DEDFE0",
    "#DADCE0",
  ]),
  preset("Jade Frost", "light", "#000000", ["#D4EADD", "#CEE7DB", "#C9E4DA", "#C4E2D9", "#BFE0D8"]),
  preset("Powder Sky", "light", "#000000", ["#DCE9F5", "#E1E5EA", "#E9E2E1", "#EDE0DA", "#F1DED4"]),
  preset("Mint Coral", "light", "#000000", ["#CDEBDD", "#D6E7DA", "#E5E1D6", "#EEDDD2", "#F4D9CE"]),
  preset("Amber Mist", "light", "#000000", ["#F0E8CE", "#EDE3C6", "#EBDFBE", "#E9DCB7", "#E7D9B0"]),
  preset("Rose Slate", "light", "#000000", ["#EDDCE1", "#E4DADF", "#DCD8DE", "#D6D8DE", "#D2D8DE"]),
  preset("Stone Fog", "light", "#000000", ["#E4E2DD", "#DEDCD7", "#D9D7D2", "#D4D2CD", "#CFCEC9"]),
  preset("Cyber Glow", "dark", "#FFFFFF", ["#041A26", "#051E2B", "#05222F", "#062733", "#062733"]),
  preset("Onchain Emerald", "dark", "#FFFFFF", [
    "#063D2E",
    "#064030",
    "#064233",
    "#064436",
    "#06463A",
  ]),
  preset("Midnight Ink", "dark", "#FFFFFF", [
    "#0B1220",
    "#0E1523",
    "#101827",
    "#12192A",
    "#141C2E",
  ]),
  preset("Neon Bloom", "dark", "#FFFFFF", ["#2A0A24", "#250A28", "#1F0A2B", "#180A2E", "#120A30"]),
  preset("Aurora Vault", "dark", "#FFFFFF", [
    "#0A1030",
    "#091A33",
    "#082334",
    "#072B32",
    "#06322F",
  ]),
  preset("Gilded Dusk", "dark", "#FFFFFF", ["#2E1F05", "#322306", "#352507", "#382807", "#3A2A08"]),
  preset("Obsidian Plum", "dark", "#FFFFFF", [
    "#1A1020",
    "#1D1325",
    "#201429",
    "#22162C",
    "#251830",
  ]),
  preset("Forest Ink", "dark", "#FFFFFF", ["#0C1E15", "#0E2217", "#102419", "#11271B", "#12291D"]),
  preset("Graphite Steel", "dark", "#FFFFFF", [
    "#16181C",
    "#191C21",
    "#1C2025",
    "#1F2329",
    "#22262C",
  ]),
  preset("Teal Abyss", "dark", "#FFFFFF", ["#08262B", "#092A2F", "#092D32", "#0A2F34", "#0A3236"]),
];

/** CSS preview string for picker cards (previews only; pixels come from the raster). */
export function gradientCss(spec: GradientSpec): string {
  const stops = spec.stops.map(([hex, pos]) => `${hex} ${Math.round(pos * 100)}%`).join(", ");
  if (spec.type === "radial") return `radial-gradient(circle at center, ${stops})`;
  return `linear-gradient(${spec.angleDeg}deg, ${stops})`;
}
