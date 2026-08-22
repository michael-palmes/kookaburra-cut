import { bytesToHex, hexToBytes } from "../../theme/oklch";

/** Editor-only hex helpers; strict validation lives here, never in engine parsing. */

/** #rgb/#rrggbb (leading # optional) to lowercase #rrggbb, else null. */
export function normaliseHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(raw)) {
    return `#${raw.replace(/./g, "$&$&")}`;
  }
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`;
  return null;
}

export function hexToRgbString(hex: string): string {
  const [r, g, b] = hexToBytes(hex);
  return `rgb(${r}, ${g}, ${b})`;
}

export function hexToHslString(hex: string): string {
  const [rb, gb, bb] = hexToBytes(hex);
  const r = rb / 255;
  const g = gb / 255;
  const b = bb / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

/** Hue in degrees [0, 360), saturation and value in [0, 1]. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

/** Achromatic hexes collapse to `h: 0, s: 0`, so hue cannot be recovered from black or white. */
export function hexToHsv(hex: string): Hsv {
  const [rb, gb, bb] = hexToBytes(hex);
  const r = rb / 255;
  const g = gb / 255;
  const b = bb / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** Wraps hue and clamps s/v before the sector maths, so out-of-range input still yields a valid hex. */
export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(1, Math.max(0, s));
  const val = Math.min(1, Math.max(0, v));
  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;
  const sector = Math.floor(hue / 60);
  let rgb: [number, number, number] = [c, x, 0];
  if (sector === 1) rgb = [x, c, 0];
  else if (sector === 2) rgb = [0, c, x];
  else if (sector === 3) rgb = [0, x, c];
  else if (sector === 4) rgb = [x, 0, c];
  else if (sector === 5) rgb = [c, 0, x];
  return bytesToHex([
    Math.round((rgb[0] + m) * 255),
    Math.round((rgb[1] + m) * 255),
    Math.round((rgb[2] + m) * 255),
  ]);
}
