/** Blackbody Kelvin -> sRGB. Tanner Helland's fit, pinned by golden values in kelvin.test.ts. EXPORT CONTRACT: swapping this function for a library rebases every project using a kelvin light. Vendored (a dozen lines) rather than depended on; the `color-temperature` and `kelvin-to-rgb` packages implement the same fit. */

const clamp255 = (v: number): number => Math.min(255, Math.max(0, v));

/** Valid authoring range; the parser clamps to this before calling. */
export const KELVIN_MIN = 1000;
export const KELVIN_MAX = 20000;

/** sRGB triple in 0..1. Input clamps to KELVIN_MIN..KELVIN_MAX. */
export function kelvinToSrgb(kelvin: number): [number, number, number] {
  const t = Math.min(KELVIN_MAX, Math.max(KELVIN_MIN, kelvin)) / 100;
  const red = t <= 66 ? 255 : clamp255(329.698727446 * (t - 60) ** -0.1332047592);
  const green =
    t <= 66
      ? clamp255(99.4708025861 * Math.log(t) - 161.1195681661)
      : clamp255(288.1221695283 * (t - 60) ** -0.0755148492);
  const blue =
    t >= 66 ? 255 : t <= 19 ? 0 : clamp255(138.5177312231 * Math.log(t - 10) - 305.0447927307);
  return [red / 255, green / 255, blue / 255];
}

/** The same fit as a `#rrggbb` hex, feeding the `new Color(hex)` path every existing colour token takes. */
export function kelvinToHex(kelvin: number): string {
  const [r, g, b] = kelvinToSrgb(kelvin);
  const byte = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}
