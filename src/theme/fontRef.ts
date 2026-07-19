import type { FontRef } from "./tokens";

/** Sidecar font strings: "Family" or "Family@weight"; kept troika-free so the doc schema can parse without pulling the font pipeline. */

/** Parse a sidecar font string; a bad weight falls back to the whole string at 400. */
export function parseFontString(value: string): FontRef {
  const at = value.lastIndexOf("@");
  if (at > 0) {
    const weight = Number(value.slice(at + 1));
    if (Number.isFinite(weight) && weight >= 1 && weight <= 1000) {
      return { family: value.slice(0, at), weight };
    }
  }
  return { family: value, weight: 400 };
}

export function formatFontString(ref: FontRef): string {
  return ref.weight === 400 ? ref.family : `${ref.family}@${ref.weight}`;
}
