import { BUNDLED_FONT_COVERAGE } from "../../theme/fontCoverage.generated";
import { SYMBOLS_CODEPOINTS } from "../../theme/symbolsCodepoints.generated";

const RGI_EMOJI = /^\p{RGI_Emoji}$/v;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Characters in `text` no available face can draw: not in any of the scene's bundled
 * font families, not a symbol the fallback face covers, and not an emoji (those go to
 * the colour-quad path; raster failures surface separately). Any family with unknown
 * coverage (a workspace-pinned system font) disables the check entirely, since a false
 * warning is worse than none. Editor-only; the export path never calls this.
 */
export function findUnrenderableChars(text: string, families: readonly string[]): string[] {
  const sets = families.map((family) => BUNDLED_FONT_COVERAGE[family]);
  if (sets.length === 0 || sets.some((s) => s === undefined)) return [];
  const out = new Set<string>();
  for (const { segment } of segmenter.segment(text)) {
    if (RGI_EMOJI.test(segment)) continue;
    for (const ch of segment) {
      const cp = ch.codePointAt(0);
      if (cp === undefined || /\s/.test(ch)) continue;
      if (cp === 0xfe0e || cp === 0xfe0f) continue;
      if (SYMBOLS_CODEPOINTS.has(cp) || sets.some((s) => s?.has(cp))) continue;
      out.add(segment);
    }
  }
  return [...out];
}
