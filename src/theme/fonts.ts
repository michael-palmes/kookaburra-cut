import { configureTextBuilder, preloadFont } from "troika-three-text";
import barlowCondensedSemiBoldUrl from "../assets/fonts/BarlowCondensed-SemiBold.woff?url";
import cormorantGaramondSemiBoldUrl from "../assets/fonts/CormorantGaramond-SemiBold.woff?url";
import frauncesSemiBoldUrl from "../assets/fonts/Fraunces-SemiBold.woff?url";
import ibmPlexSansRegularUrl from "../assets/fonts/IBMPlexSans-Regular.woff?url";
import ibmPlexSansSemiBoldUrl from "../assets/fonts/IBMPlexSans-SemiBold.woff?url";
import instrumentSerifRegularUrl from "../assets/fonts/InstrumentSerif-Regular.woff?url";
import interRegularUrl from "../assets/fonts/Inter-Regular.woff?url";
import interSemiBoldUrl from "../assets/fonts/Inter-SemiBold.woff?url";
import jetbrainsMonoRegularUrl from "../assets/fonts/JetBrainsMono-Regular.woff?url";
import jostMediumUrl from "../assets/fonts/Jost-Medium.woff?url";
import jostRegularUrl from "../assets/fonts/Jost-Regular.woff?url";
import kookaburraFallbackUrl from "../assets/fonts/KookaburraFallback.otf?url";
import libreFranklinSemiBoldUrl from "../assets/fonts/LibreFranklin-SemiBold.woff?url";
import loraRegularUrl from "../assets/fonts/Lora-Regular.woff?url";
import nunitoSemiBoldUrl from "../assets/fonts/Nunito-SemiBold.woff?url";
import openSansRegularUrl from "../assets/fonts/OpenSans-Regular.woff?url";
import openSansSemiBoldUrl from "../assets/fonts/OpenSans-SemiBold.woff?url";
import playfairSemiBoldUrl from "../assets/fonts/PlayfairDisplay-SemiBold.woff?url";
import spaceGroteskRegularUrl from "../assets/fonts/SpaceGrotesk-Regular.woff?url";
import spaceGroteskSemiBoldUrl from "../assets/fonts/SpaceGrotesk-SemiBold.woff?url";
import { preloadFontMetrics } from "./fontMetrics";
import { vetFontUrl } from "./fontVet";
import { FALLBACK_PRELOAD_CHARACTERS } from "./symbolsCodepoints.generated";
import type { FontRef, Theme } from "./tokens";

/** troika's SDF cell size, passed explicitly to the builder, every preload and every `Text` site so the whole app shares ONE glyph atlas. EXPORT CONTRACT: changing it re-rasterises every glyph and rebases every project. */
export const SDF_GLYPH_SIZE = 64;

// Typeset on the MAIN thread: troika's worker dies in the packaged app (WKWebView blocks blob workers over tauri://); this also keeps the deterministic export path scheduling-free.
// unicodeFontsURL is a dead same-origin path: the CDN fallback must never fetch remote fonts (patched troika degrades uncovered codepoints to .notdef instead of wedging).
// defaultFontURL is troika's global fallback slot, tried only for codepoints the per-Text font lacks: text-default symbols plus the empty emoji placeholder glyphs.
configureTextBuilder({
  useWorker: false,
  sdfGlyphSize: SDF_GLYPH_SIZE,
  unicodeFontsURL: "/__no-unicode-font-resolver__",
  defaultFontURL: kookaburraFallbackUrl,
});

/** Bundled OFL faces: family → weight → URL; troika parses ttf/otf/woff only (never woff2 or variable axes). `fontUrl` keeps every primitive off troika's CDN fallback (Roboto) for offline + deterministic export. Keep in sync with scripts/prepare-text3d-font.mjs and TYPEFACE_DATA. */
export const BUNDLED_FONTS: Record<string, Record<number, string>> = {
  Inter: { 400: interRegularUrl, 600: interSemiBoldUrl },
  "Space Grotesk": { 400: spaceGroteskRegularUrl, 600: spaceGroteskSemiBoldUrl },
  "Open Sans": { 400: openSansRegularUrl, 600: openSansSemiBoldUrl },
  "JetBrains Mono": { 400: jetbrainsMonoRegularUrl },
  // The editorial faces for the Paper theme.
  "Playfair Display": { 600: playfairSemiBoldUrl },
  Lora: { 400: loraRegularUrl },
  "Barlow Condensed": { 600: barlowCondensedSemiBoldUrl },
  Nunito: { 600: nunitoSemiBoldUrl },
  "Cormorant Garamond": { 600: cormorantGaramondSemiBoldUrl },
  "Libre Franklin": { 600: libreFranklinSemiBoldUrl },
  "Instrument Serif": { 400: instrumentSerifRegularUrl },
  Jost: { 400: jostRegularUrl, 500: jostMediumUrl },
  "IBM Plex Sans": { 400: ibmPlexSansRegularUrl, 600: ibmPlexSansSemiBoldUrl },
  Fraunces: { 600: frauncesSemiBoldUrl },
};

/** Faces added after the boot preload set froze: they typeset only when a project references them, so their atlas cells never shift an older project's glyphs (docs/determinism.md "Fonts"). Append every new bundled face here. */
export const LAZY_BUNDLED_FAMILIES: ReadonlySet<string> = new Set([
  "Instrument Serif",
  "Jost",
  "IBM Plex Sans",
  "Fraunces",
]);

/** Workspace-pinned system fonts: family → weight → asset-protocol URL under `~/Kookaburra Cut/fonts/`, registered by `engine/systemFonts.ts`; pinning copies exact bytes so exports stay reproducible across macOS updates. */
const workspaceFonts = new Map<string, Map<number, string>>();

export function registerWorkspaceFont(family: string, weight: number, url: string): void {
  let weights = workspaceFonts.get(family);
  if (!weights) {
    weights = new Map();
    workspaceFonts.set(family, weights);
  }
  weights.set(weight, url);
}

/** Warn once per unresolved family; a per-frame render path must not spam. */
const warnedFamilies = new Set<string>();

/** Nearest available weight (ties resolve to the LIGHTER face, deterministic). */
function nearestWeight(available: number[], target: number): number {
  let best = available[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const w of [...available].sort((a, b) => a - b)) {
    const dist = Math.abs(w - target);
    if (dist < bestDist) {
      best = w;
      bestDist = dist;
    }
  }
  return best;
}

const asRef = (ref: FontRef | string): FontRef =>
  typeof ref === "string" ? { family: ref, weight: 400 } : ref;

/** Bundled families never touch the native side. */
export function isBundledFamily(family: string): boolean {
  return family in BUNDLED_FONTS;
}

/** True when this EXACT weight is pinned; the auto-pin loop is weight-precise (a theme referencing both 400 and 600 of a family pins both faces). */
export function hasPinnedWeight(family: string, weight: number): boolean {
  return workspaceFonts.get(family)?.has(weight) ?? false;
}

/** The face a ref names before any substitution: bundled, else the nearest pinned weight, else null. */
export function resolvedFontUrl(ref: FontRef | string): string | null {
  const { family, weight } = asRef(ref);
  const bundled = BUNDLED_FONTS[family];
  if (bundled) {
    return bundled[nearestWeight(Object.keys(bundled).map(Number), weight)];
  }
  const pinned = workspaceFonts.get(family);
  if (pinned && pinned.size > 0) {
    const w = nearestWeight([...pinned.keys()], weight);
    const url = pinned.get(w);
    if (url) return url;
  }
  return null;
}

/** Faces that failed vetting (theme/fontVet.ts), by URL, mapped to the face rendered instead; troika never sees a key. */
const fontSubstitutes = new Map<string, { ref: FontRef; url: string }>();

/** Stand `substitute` in for the face at `url` (null restores it); the stand-in must itself be safe. */
export function setFontSubstitute(url: string, substitute: FontRef | null): void {
  const target = substitute ? fontUrl(substitute) : null;
  if (!substitute || !target || target === url) fontSubstitutes.delete(url);
  else fontSubstitutes.set(url, { ref: substitute, url: target });
}

export function fontSubstituteRef(url: string): FontRef | undefined {
  return fontSubstitutes.get(url)?.ref;
}

const BUNDLED_FONT_URLS = new Set<string>([
  ...Object.values(BUNDLED_FONTS).flatMap((weights) => Object.values(weights)),
  kookaburraFallbackUrl,
]);

export function isBundledFontUrl(url: string): boolean {
  return BUNDLED_FONT_URLS.has(url);
}

/** Inter at its nearest bundled weight: the face that stands in when nothing better can. */
export function interFallbackRef(weight: number): FontRef {
  return {
    family: "Inter",
    weight: nearestWeight(Object.keys(BUNDLED_FONTS.Inter).map(Number), weight),
  };
}

export function fontUrl(ref: FontRef | string): string {
  const { family } = asRef(ref);
  const url = resolvedFontUrl(ref);
  if (url) return fontSubstitutes.get(url)?.url ?? url;
  if (!warnedFamilies.has(family)) {
    warnedFamilies.add(family);
    console.warn(`[fonts] "${family}" is neither bundled nor pinned — using Inter`);
  }
  return interRegularUrl;
}

/** The distinct font refs a set of themes uses (headline + body of each, plus the project's chart face where one is set). */
export function collectThemeFontRefs(themes: readonly (Theme | undefined)[]): FontRef[] {
  const seen = new Map<string, FontRef>();
  for (const theme of themes) {
    if (!theme) continue;
    for (const ref of [theme.typography.headline, theme.typography.body, theme.typography.chart]) {
      if (ref) seen.set(`${ref.family}:${ref.weight}`, ref);
    }
  }
  return [...seen.values()];
}

// Glyphs pre-generated before the first frame: Latin text plus the punctuation primitives emit (counters, separators); extend as scenes need it.
const PRELOAD_CHARACTERS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;!?'\"()[]{}%-+/&@#";

/** Preloads SDF glyphs before frame 0 (bundled, plus `refs` for a project's actual fonts); awaited at boot, project load and the export preamble. Must run SEQUENTIALLY, never parallel: troika's shared SDF atlas assigns glyph cells in fetch-completion order, so racing preloads would shift atlas layout (and pixels) per boot; order is pinned to Inter Regular first, then declaration order. See docs/determinism.md ("Fonts"). */
export async function preloadAppFonts(refs?: readonly (FontRef | string)[]): Promise<void> {
  const urls = new Set<string>([interRegularUrl]);
  if (refs) {
    await substituteUnsafeFaces(refs);
    for (const ref of refs) urls.add(fontUrl(ref));
  } else {
    for (const [family, weights] of Object.entries(BUNDLED_FONTS)) {
      if (LAZY_BUNDLED_FAMILIES.has(family)) continue;
      for (const url of Object.values(weights)) urls.add(url);
    }
  }
  for (const font of urls) {
    await new Promise<void>((resolve) => {
      preloadFont({ font, characters: PRELOAD_CHARACTERS, sdfGlyphSize: SDF_GLYPH_SIZE }, resolve);
    });
  }
  // The fallback face always loads LAST so its atlas cells append after every existing glyph (docs/determinism.md "Fonts").
  await new Promise<void>((resolve) => {
    preloadFont(
      {
        font: kookaburraFallbackUrl,
        characters: FALLBACK_PRELOAD_CHARACTERS,
        sdfGlyphSize: SDF_GLYPH_SIZE,
      },
      resolve,
    );
  });
  // Our own parse of the same faces, for measureText; troika's atlas never sees it.
  await preloadFontMetrics(urls);
}

/** Vets every non-bundled face before troika sees it: a face troika's parser throws on would wedge every pending preload (and with it the load or export), so it is swapped for Inter unless a load already chose a better stand-in. */
async function substituteUnsafeFaces(refs: readonly (FontRef | string)[]): Promise<void> {
  const pending = refs
    .map((ref) => ({ ref: asRef(ref), url: resolvedFontUrl(ref) }))
    .filter(
      (face): face is { ref: FontRef; url: string } =>
        face.url !== null && !isBundledFontUrl(face.url) && !fontSubstitutes.has(face.url),
    );
  if (pending.length === 0) return;
  for (const { ref, url } of pending) {
    const verdict = await vetFontUrl(url);
    if (verdict.ok || fontSubstitutes.has(url)) continue;
    // A read failure says nothing about the face, so fail loudly (retryable) rather than render a stand-in.
    if (verdict.transient) {
      throw new Error(`The font "${ref.family}" (${ref.weight}) ${verdict.error}; try again`);
    }
    console.warn(
      `[fonts] "${ref.family}" (${ref.weight}) can't be typeset (${verdict.error}); using Inter`,
    );
    setFontSubstitute(url, interFallbackRef(ref.weight));
  }
}
