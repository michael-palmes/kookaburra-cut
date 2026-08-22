import { parseFontString } from "../theme/fontRef";
import type { FontRef, Theme } from "../theme/tokens";
import type { SceneDoc, SceneManagedTextItem } from "./sceneDocSchema";

/** The comparison's label chips as real text content: two doc-derived chrome keys that surface in the Content list and the standard text drill, yet never enter `managedText.items` (the safe-area stack must not render them; `CompareChips` does, inside each side's subtree). Every default here mirrors the renderer exactly, so an unstyled chip keeps drawing today's pixels. */

export const COMPARE_CHIP_TEXT_KEYS = ["beforeLabel", "afterLabel"] as const;

export type CompareChipTextKey = (typeof COMPARE_CHIP_TEXT_KEYS)[number];

/** Content-group key prefix: chrome text rides its own single-item group so the list can label it. */
export const COMPARE_CHIP_GROUP_PREFIX = "compare-chip:";

interface CompareChipTextDef {
  fallback: string;
  colour: "muted" | "accent";
  rowLabel: string;
}

const COMPARE_CHIP_TEXT: Record<CompareChipTextKey, CompareChipTextDef> = {
  beforeLabel: { fallback: "Before", colour: "muted", rowLabel: "Before label" },
  afterLabel: { fallback: "After", colour: "accent", rowLabel: "After label" },
};

export function isCompareChipTextKey(key: string): key is CompareChipTextKey {
  return key === "beforeLabel" || key === "afterLabel";
}

export function isCompareChipGroupKey(key: string): boolean {
  return (
    key.startsWith(COMPARE_CHIP_GROUP_PREFIX) &&
    isCompareChipTextKey(key.slice(COMPARE_CHIP_GROUP_PREFIX.length))
  );
}

export function compareChipGroupKey(key: CompareChipTextKey): string {
  return `${COMPARE_CHIP_GROUP_PREFIX}${key}`;
}

export function compareChipTextKeyForSide(side: "a" | "b"): CompareChipTextKey {
  return side === "a" ? "beforeLabel" : "afterLabel";
}

export function compareChipFallbackText(key: CompareChipTextKey): string {
  return COMPARE_CHIP_TEXT[key].fallback;
}

/** The chip's design default fill token, and the drill's swatch default. */
export function compareChipDefaultColour(key: CompareChipTextKey): "muted" | "accent" {
  return COMPARE_CHIP_TEXT[key].colour;
}

export function compareChipRowLabel(key: CompareChipTextKey): string {
  return COMPARE_CHIP_TEXT[key].rowLabel;
}

/** True only while the comparison actually draws chips; the rows follow the renderer. */
export function compareChipsEnabled(doc: SceneDoc | null | undefined): boolean {
  return doc?.compare?.chrome?.chips === true;
}

export function compareChipText(doc: SceneDoc | null | undefined, key: CompareChipTextKey): string {
  return doc?.text?.[key] ?? compareChipFallbackText(key);
}

/** The chrome items a comparison contributes to the managed text model; empty with chips off. */
export function compareChipTextItems(doc: SceneDoc | null | undefined): SceneManagedTextItem[] {
  if (!compareChipsEnabled(doc)) return [];
  return COMPARE_CHIP_TEXT_KEYS.map((key) => ({
    key,
    type: "subtitle" as const,
    text: compareChipText(doc, key),
  }));
}

export interface CompareChipTextStyleInput {
  doc: SceneDoc | null | undefined;
  key: CompareChipTextKey;
  theme: Theme;
  /** The chip's coded size before any `<key>Size` multiplier. */
  baseFontSize: number;
  /** The chip's coded position before any `<key>OffsetX/Y`. */
  x: number;
  y: number;
}

/** Resolved chip typography. Absent overrides return the coded values untouched, and `lineHeight`/`rotationRad` stay undefined so the renderer can leave the props off entirely (the null-for-legacy contract). */
export interface CompareChipTextStyle {
  fontRef: FontRef;
  fontSize: number;
  colour: string;
  position: [number, number, number];
  lineHeight?: number;
  rotationRad?: number;
}

function styleValue(
  doc: SceneDoc | null | undefined,
  key: string,
  suffix: string,
): string | number | undefined {
  return doc?.textStyle?.[`${key}${suffix}`];
}

/** Token lookup stays byte-identical with AnimatedHeadline's; anything else is a raw fill. */
function resolveFill(theme: Theme, colour: string): string {
  if (colour === "text" || colour === "muted" || colour === "accent") return theme.colors[colour];
  return colour;
}

/** Applies the sidecar `textStyle` overrides to one chip, by the managed-text renderer's rules. */
export function compareChipTextStyle({
  doc,
  key,
  theme,
  baseFontSize,
  x,
  y,
}: CompareChipTextStyleInput): CompareChipTextStyle {
  const colour = styleValue(doc, key, "Color");
  const font = styleValue(doc, key, "Font");
  const size = styleValue(doc, key, "Size");
  const offsetX = styleValue(doc, key, "OffsetX");
  const offsetY = styleValue(doc, key, "OffsetY");
  const lineHeight = styleValue(doc, key, "LineHeight");
  const rotationDeg = styleValue(doc, key, "RotationDeg");
  return {
    fontRef: typeof font === "string" ? parseFontString(font) : theme.typography.body,
    fontSize: typeof size === "number" ? baseFontSize * size : baseFontSize,
    colour: resolveFill(theme, typeof colour === "string" ? colour : compareChipDefaultColour(key)),
    position:
      typeof offsetX === "number" || typeof offsetY === "number"
        ? [
            x + (typeof offsetX === "number" ? offsetX : 0),
            y + (typeof offsetY === "number" ? offsetY : 0),
            0,
          ]
        : [x, y, 0],
    ...(typeof lineHeight === "number" ? { lineHeight } : {}),
    ...(typeof rotationDeg === "number" && rotationDeg !== 0
      ? { rotationRad: (-rotationDeg * Math.PI) / 180 }
      : {}),
  };
}
