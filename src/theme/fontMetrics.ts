/** Synchronous text metrics from the faces troika typesets with: `preloadAppFonts` parses every face it preloads into this cache, so a scene can size a pill or an underline to a headline without capturing a frame. Single line or explicit `\n` breaks (no wrapping in v1). The maths mirrors troika 0.52.5's typesetter (its font runs, `forEachGlyph` advances, trailing whitespace dropped, "normal" line height from the face's ascender, descender and line gap); fontMetrics.test.ts holds it to troika's own typesetter on the bundled faces. */

import fontParser, { type TroikaParsedFont } from "troika-three-text/src/FontParser.js";
import kookaburraFallbackUrl from "../assets/fonts/KookaburraFallback.otf?url";
import { prepareEmojiText } from "../toolkit/text/emojiText";
import { parseFontString } from "./fontRef";
import { fontUrl } from "./fonts";
import type { FontRef } from "./tokens";

export interface MeasureTextOptions {
  /** A theme `FontRef` or a font string ("Family" or "Family@weight"), resolved like every text primitive's face. */
  font: FontRef | string;
  fontSize: number;
  /** Extra advance after each glyph, in em (troika's `letterSpacing`). */
  letterSpacing?: number;
  /** Line advance as a multiple of the font size; absent is the face's own "normal". */
  lineHeight?: number;
}

/** A typeset block in world units: `ascent` runs from the block top to the first baseline and `descent` from the last baseline to the block bottom, so one line has `ascent + descent === height`. */
export interface TextMetrics {
  width: number;
  height: number;
  ascent: number;
  descent: number;
  lines: number;
}

const faces = new Map<string, TroikaParsedFont>();
const inflight = new Map<string, Promise<void>>();
const failed = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function landed(): void {
  version++;
  for (const cb of listeners) cb();
}

/** Fetches and parses one face into the cache (idempotent); a face that fails is remembered and measures null. */
export function requestFontMetrics(url: string): Promise<void> {
  if (faces.has(url) || failed.has(url)) return Promise.resolve();
  const pending = inflight.get(url);
  if (pending) return pending;
  const job = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      faces.set(url, await fontParser.onMainThread(await response.arrayBuffer()));
    } catch (e) {
      failed.add(url);
      console.warn(`[fontMetrics] could not parse ${url}:`, e);
    } finally {
      inflight.delete(url);
      landed();
    }
  })();
  inflight.set(url, job);
  return job;
}

/** Parses each face plus the fallback face troika resolves missing code points (symbols, emoji placeholders) against. */
export async function preloadFontMetrics(urls: Iterable<string>): Promise<void> {
  await Promise.all([...new Set([...urls, kookaburraFallbackUrl])].map(requestFontMetrics));
}

/** Seeds the cache with an already parsed face (tests, and callers that parsed it themselves). */
export function registerParsedFont(url: string, font: TroikaParsedFont): void {
  faces.set(url, font);
  failed.delete(url);
  landed();
}

export function fontMetricsFailed(url: string): boolean {
  return failed.has(url);
}

export function subscribeFontMetrics(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function fontMetricsVersion(): number {
  return version;
}

/** The face URL `measureText` reads for a font option: the same resolution and substitution every primitive renders through. */
export function metricsFontUrl(font: FontRef | string): string {
  return fontUrl(typeof font === "string" ? parseFontString(font) : font);
}

const LINE_BREAKING_SPACE = /[^\S ]/;
const ANY_SPACE = /\s/;

/** Per code unit, the face troika's resolver picks: the text's face, else the fallback face, else (uncovered) troika's second resolved face; whitespace keeps the previous character's face. */
function resolveFaces(
  text: string,
  primary: TroikaParsedFont,
  fallback: TroikaParsedFont | null,
): TroikaParsedFont[] {
  const order = [primary, ...(fallback ? [fallback] : [])];
  const resolved: TroikaParsedFont[] = [];
  const index = new Int32Array(text.length);
  let prevResolved = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i) ?? 0;
    if (
      (prevResolved && resolved[index[i - 1]].supportsCodePoint(code)) ||
      (i > 0 && ANY_SPACE.test(text[i]))
    ) {
      index[i] = index[i - 1];
    } else {
      const face = order.find((f) => f.supportsCodePoint(code));
      if (face) {
        let at = resolved.indexOf(face);
        if (at < 0) at = resolved.push(face) - 1;
        index[i] = at;
        prevResolved = true;
      } else {
        index[i] = order.length - 1;
        prevResolved = false;
      }
    }
    if (code > 0xffff && i + 1 < text.length) {
      index[i + 1] = index[i];
      i++;
    }
  }
  return Array.from(index, (at) => resolved[at] ?? primary);
}

interface FaceLine {
  lineHeight: number;
  baseline: number;
}

interface Line {
  width: number;
  lineHeight: number;
  baseline: number;
  glyphs: { x: number; width: number; space: boolean; face: FaceLine }[];
}

/** Metrics for one string; null until its face has been parsed. */
export function measureText(text: string, opts: MeasureTextOptions): TextMetrics | null {
  const primary = faces.get(metricsFontUrl(opts.font));
  if (!primary) return null;
  const fallback = faces.get(kookaburraFallbackUrl) ?? null;
  const str = prepareEmojiText(text).text.replace(/\r\n?/g, "\n");
  const { fontSize } = opts;
  const letterSpacing = opts.letterSpacing ?? 0;
  const perChar = resolveFaces(str, primary, fallback);
  const faceData = new Map<TroikaParsedFont, FaceLine>();
  const dataFor = (face: TroikaParsedFont): FaceLine => {
    let data = faceData.get(face);
    if (!data) {
      const mult = fontSize / face.unitsPerEm;
      const span = (face.ascender - face.descender) * mult;
      const lineHeight =
        opts.lineHeight === undefined
          ? (face.ascender - face.descender + face.lineGap) * mult
          : opts.lineHeight * fontSize;
      data = { lineHeight, baseline: -(lineHeight - span) / 2 - face.ascender * mult };
      faceData.set(face, data);
    }
    return data;
  };
  const newLine = (): Line => ({ width: 0, lineHeight: 0, baseline: 0, glyphs: [] });
  let line = newLine();
  const lines = [line];
  let lineX = 0;
  let runEndX = 0;
  for (let start = 0; start < str.length; ) {
    const face = perChar[start];
    let end = start + 1;
    while (end < str.length && perChar[end] === face) end++;
    const data = dataFor(face);
    const mult = fontSize / face.unitsPerEm;
    let lastX = 0;
    let lastAdvance = 0;
    face.forEachGlyph(str.slice(start, end), fontSize, letterSpacing, (glyph, gx, _gy, ci) => {
      const glyphX = gx + runEndX;
      const char = str.charAt(ci + start);
      const width = glyph.advanceWidth * mult;
      lastX = glyphX;
      lastAdvance = glyph.advanceWidth;
      line.glyphs.push({
        x: glyphX + lineX,
        width,
        space: !!char && LINE_BREAKING_SPACE.test(char),
        face: data,
      });
      if (char === "\n") {
        line = newLine();
        lines.push(line);
        lineX = -(glyphX + width + letterSpacing * fontSize);
      }
    });
    runEndX = lastX + lastAdvance * mult + letterSpacing * fontSize;
    start = end;
  }
  let width = 0;
  let height = 0;
  for (const l of lines) {
    let trailing = true;
    for (let i = l.glyphs.length; i--; ) {
      const g = l.glyphs[i];
      if (trailing && !g.space) {
        l.width = g.x + g.width;
        if (l.width > width) width = l.width;
        trailing = false;
      }
      if (g.face.lineHeight > l.lineHeight) l.lineHeight = g.face.lineHeight;
      const drop = g.face.baseline - l.baseline;
      if (drop < 0) l.baseline += drop;
    }
    l.baseline -= height;
    height += l.lineHeight;
  }
  return {
    width,
    height,
    ascent: 0 - lines[0].baseline,
    descent: height + lines[lines.length - 1].baseline,
    lines: lines.length,
  };
}
