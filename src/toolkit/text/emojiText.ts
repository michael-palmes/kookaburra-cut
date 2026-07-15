import { EMOJI_PUA_COUNT, EMOJI_PUA_START } from "../../theme/symbolsCodepoints.generated";

export interface EmojiCluster {
  /** Code-unit index of the placeholder in the substituted text (aligns with caretPositions). */
  codeUnitIndex: number;
  /** The original grapheme cluster, e.g. a full ZWJ sequence. */
  cluster: string;
  /** Content-addressed raster cache key: hex codepoints, dash-joined. */
  key: string;
}

export interface PreparedEmojiText {
  /** The string troika typesets: emoji swapped for placeholders, stray selectors stripped. */
  text: string;
  /** One entry per emoji occurrence, in order. Empty for text with no emoji. */
  clusters: EmojiCluster[];
}

const RGI_EMOJI = /^\p{RGI_Emoji}$/v;
const TRAILING_VS = /[\uFE0E\uFE0F]$/;
const TRAILING_VS16 = /\uFE0F$/;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The colour-path form of a cluster, or null for text. Handles the RGI set's quirks:
 * a redundant VS16 on an emoji-default base (a star pasted from the web, U+2B50 U+FE0F)
 * is NOT RGI, so it canonicalises to the bare form; a bare astral pictograph (houses,
 * U+1F3D8 alone) is NOT RGI either, but macOS renders it colour everywhere, so it
 * qualifies as-is when its FE0F form is RGI. BMP text-default symbols (hearts, warning,
 * checks) stay on the mono path unless explicitly VS16-ed, matching CoreText; VS15 is
 * an explicit text request and never routes to colour.
 */
function emojiForm(cluster: string): string | null {
  if (RGI_EMOJI.test(cluster)) return cluster;
  if (TRAILING_VS16.test(cluster)) {
    const stripped = cluster.replace(TRAILING_VS16, "");
    if (RGI_EMOJI.test(stripped)) return stripped;
    return null;
  }
  const first = cluster.codePointAt(0);
  if (first !== undefined && first > 0xffff && RGI_EMOJI.test(`${cluster}\uFE0F`)) return cluster;
  return null;
}

// Lowest code unit that can appear in an RGI cluster or a variation selector; anything below needs no work.
const FAST_PATH_BELOW = 0x231a;

let warnedCap = false;

export function emojiClusterKey(cluster: string): string {
  const parts: string[] = [];
  for (const ch of cluster) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) parts.push(cp.toString(16));
  }
  return parts.join("-");
}

/**
 * Swaps every RGI emoji cluster for a private-use placeholder (a single code unit whose
 * layout advance comes from the bundled fallback face) so troika never typesets emoji;
 * colour quads render at the recorded indices instead. A variation selector on a
 * non-emoji cluster is stripped so it cannot tofu beside an otherwise-covered symbol.
 * Pure and deterministic: placeholders assign in first-encounter order per string.
 */
export function prepareEmojiText(raw: string): PreparedEmojiText {
  let needsWork = false;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) >= FAST_PATH_BELOW) {
      needsWork = true;
      break;
    }
  }
  if (!needsWork) return { text: raw, clusters: [] };

  const assigned = new Map<string, number>();
  const clusters: EmojiCluster[] = [];
  let out = "";
  for (const { segment } of segmenter.segment(raw)) {
    const emoji = emojiForm(segment);
    if (emoji !== null) {
      let pua = assigned.get(emoji);
      if (pua === undefined) {
        if (assigned.size >= EMOJI_PUA_COUNT) {
          if (!warnedCap) {
            warnedCap = true;
            console.warn(
              `[emoji] more than ${EMOJI_PUA_COUNT} distinct emoji in one string; extras degrade to tofu`,
            );
          }
          out += segment;
          continue;
        }
        pua = EMOJI_PUA_START + assigned.size;
        assigned.set(emoji, pua);
      }
      // The canonical (RGI-or-qualified) form is both the raster input and the cache key, so ⭐ and ⭐️ share one entry.
      clusters.push({ codeUnitIndex: out.length, cluster: emoji, key: emojiClusterKey(emoji) });
      out += String.fromCodePoint(pua);
    } else if (TRAILING_VS.test(segment)) {
      out += segment.replace(TRAILING_VS, "");
    } else {
      out += segment;
    }
  }
  return { text: out, clusters };
}
