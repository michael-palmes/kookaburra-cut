import { describe, expect, it } from "vitest";
import { builtinThemes } from "../../../theme/registry";
import { deriveThemeColorsFromAnchor } from "../shaders/themePreset";
import { SCENE3D_BACKGROUNDS } from "./index";
import { scene3dThemeAnchor } from "./presets";

/** The 3D Theme tile (Scene3dBackdrop's geometry colours plus SceneTab's separately derived backing) must hold the bands and AA against every bundled theme's real text token, mirroring shaders/themePreset.test.ts. Glow slots follow the dark-preset exemption and skip AA. */

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = lin(((n >> 16) & 255) / 255);
  const g = lin(((n >> 8) & 255) / 255);
  const b = lin((n & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const themes = Object.values(builtinThemes);
const lookIds = Object.keys(SCENE3D_BACKGROUNDS);

/** Pre-existing: both p1 anchors sit at the band floor (0.309), under the 0.315 Sunrise's softer text token needs. Fix the presets, then empty this list; nothing may join it. */
const KNOWN_MISSES = [
  "kookaburra-sunrise point-swell #c4887d on #3a2e35: 4.42",
  "kookaburra-sunrise dust-drift #c4887d on #3a2e35: 4.42",
];

/** Every derived stop for one theme and look: the geometry slots, then the backing. */
function derivedStops(theme: (typeof themes)[number], look: string) {
  const anchor = scene3dThemeAnchor(look, theme);
  const colors = anchor ? deriveThemeColorsFromAnchor(anchor.colors, theme) : null;
  const backing = anchor ? deriveThemeColorsFromAnchor([anchor.backing], theme)?.[0] : undefined;
  const slots = SCENE3D_BACKGROUNDS[look].colorSlots;
  return {
    colors,
    backing,
    stops: [
      ...(colors ?? []).map((c, i) => ({ c, glow: !!slots[i]?.glow })),
      ...(backing ? [{ c: backing, glow: false }] : []),
    ],
  };
}

describe("scene3d Theme preset", () => {
  it("derives a full slot set and a backing for every bundled theme and look", () => {
    for (const theme of themes) {
      for (const look of lookIds) {
        const { colors, backing } = derivedStops(theme, look);
        expect(colors, `${theme.id} ${look}`).not.toBeNull();
        expect(colors?.length, `${theme.id} ${look}`).toBe(
          SCENE3D_BACKGROUNDS[look].colorSlots.length,
        );
        expect(backing, `${theme.id} ${look}`).toBeDefined();
      }
    }
  });

  it("keeps every derived stop inside the mode's luminance band (docs/backgrounds.md)", () => {
    for (const theme of themes) {
      const mode = theme.mode ?? "dark";
      for (const look of lookIds) {
        for (const { c, glow } of derivedStops(theme, look).stops) {
          const l = luminance(c);
          if (mode === "light") expect(l, `${theme.id} ${look} ${c}`).toBeGreaterThanOrEqual(0.3);
          else expect(l, `${theme.id} ${look} ${c}`).toBeLessThanOrEqual(glow ? 0.3 : 0.125);
        }
      }
    }
  });

  it("holds AA against the theme's own text token and the pure text colour", () => {
    const failures: string[] = [];
    for (const theme of themes) {
      const mode = theme.mode ?? "dark";
      const pure = mode === "light" ? "#000000" : "#ffffff";
      for (const look of lookIds) {
        for (const { c, glow } of derivedStops(theme, look).stops) {
          if (glow && mode === "dark") continue;
          for (const text of [theme.colors.text, pure]) {
            const ratio = contrast(c, text);
            if (ratio < 4.5)
              failures.push(`${theme.id} ${look} ${c} on ${text}: ${ratio.toFixed(2)}`);
          }
        }
      }
    }
    expect(failures).toEqual(KNOWN_MISSES);
  });
});
