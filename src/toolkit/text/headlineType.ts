import type { SceneDoc } from "../../engine/sceneDocSchema";
import { parseFontString } from "../../theme/fontRef";
import { fontUrl } from "../../theme/fonts";
import type { FontRef, Theme } from "../../theme/tokens";

/** The headline props that decide its type, before the sidecar's `textStyle.<key>*` overrides. */
export interface HeadlineTypeInput {
  textKey?: string;
  styleKey?: string;
  face?: "headline" | "body";
  fontRef?: FontRef;
  fontSize?: number;
  lineHeight?: number;
}

export interface HeadlineType {
  fontRef: FontRef;
  /** The face URL troika typesets with. */
  font: string;
  fontSize: number;
  /** Absent keeps the face's own "normal" line height. */
  lineHeight?: number;
}

/** AnimatedHeadline's font, size and line-height resolution (sidecar `<key>Font`, `<key>Size` and `<key>LineHeight` over the props over the theme face), shared so a measurement and the rendered headline can never disagree. */
export function resolveHeadlineType(
  theme: Theme,
  doc: SceneDoc | null | undefined,
  input: HeadlineTypeInput,
): HeadlineType {
  const styleKey = input.styleKey ?? input.textKey;
  const styleOf = (suffix: string) =>
    styleKey ? doc?.textStyle?.[`${styleKey}${suffix}`] : undefined;
  const fontValue = styleOf("Font");
  const sizeMul = styleOf("Size");
  const lineHeight = styleOf("LineHeight");
  const fontRef =
    typeof fontValue === "string"
      ? parseFontString(fontValue)
      : (input.fontRef ?? theme.typography[input.face ?? "headline"]);
  const baseSize = input.fontSize ?? 0.6;
  return {
    fontRef,
    font: fontUrl(fontRef),
    fontSize: typeof sizeMul === "number" ? baseSize * sizeMul : baseSize,
    ...(typeof lineHeight === "number"
      ? { lineHeight }
      : input.lineHeight !== undefined
        ? { lineHeight: input.lineHeight }
        : {}),
  };
}
