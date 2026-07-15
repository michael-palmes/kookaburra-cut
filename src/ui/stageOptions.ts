import type { Theme, ThemeBackground } from "../theme/tokens";

/** Pure option builders for the unified Background editor and the scene wizards, split out of EditBar so the written sidecar shapes are structure-pinned in unit tests: every value emitted here must round-trip the theme/sidecar parsers, or a chip could silently write a shape that degrades to "no override". Staging is edited through the same Background drill-in (colour/gradient write through to `doc.backdrop`), so the old standalone backdrop chip builders are gone. */

/** The Drift toggle's parallax: one tasteful value; finer control is a sidecar/Claude affair. */
export const DRIFT_PARALLAX = 0.05;

/** Fixed-background options: the camera-locked frame-filling layer; `undefined` is theme default, Colour seeds the theme background (refined by the popover's inline swatch), Gradient names the theme's `backdrop` gradient else its first, and Image… is a separate chip needing an asset pick. */
export function backgroundOptions(
  theme: Theme | undefined,
): { label: string; value: ThemeBackground | undefined }[] {
  const options: { label: string; value: ThemeBackground | undefined }[] = [
    { label: "Theme default", value: undefined },
    { label: "None", value: { type: "none" } },
    { label: "Colour", value: { type: "color", color: theme?.colors.background ?? "#101418" } },
  ];
  const gradients = Object.keys(theme?.gradients ?? {});
  const gradient = gradients.includes("backdrop") ? "backdrop" : gradients[0];
  if (gradient) options.push({ label: "Gradient", value: { type: "gradient", gradient } });
  return options;
}

/** Chip selection for the background group; same type-match rule as backdrops. */
export function backgroundMatches(
  current: ThemeBackground | undefined,
  option: ThemeBackground | undefined,
): boolean {
  if (!current || !option) return current === option;
  return current.type === option.type;
}

/** Stamp or strip the Drift parallax on a background override (`none` passes through). */
export function toggleDrift(spec: ThemeBackground, on: boolean): ThemeBackground {
  if (spec.type === "none") return spec;
  const next = { ...spec };
  if (on) next.parallax = DRIFT_PARALLAX;
  else delete next.parallax;
  return next;
}
