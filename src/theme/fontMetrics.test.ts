import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fontParser, { type TroikaParsedFont } from "troika-three-text/src/FontParser.js";
import { createFontResolver } from "troika-three-text/src/FontResolver.js";
import { createTypesetter } from "troika-three-text/src/Typesetter.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import kookaburraFallbackUrl from "../assets/fonts/KookaburraFallback.otf?url";
import { prepareEmojiText } from "../toolkit/text/emojiText";
import {
  type MeasureTextOptions,
  measureText,
  metricsFontUrl,
  registerParsedFont,
} from "./fontMetrics";
import type { FontRef } from "./tokens";

/** Parity: `measureText` against troika 0.52.5's own font resolver and typesetter, run on the same parsed faces (metrics only, so no SDF or bidi work). */

const FACES: { ref: FontRef; file: string }[] = [
  { ref: { family: "Inter", weight: 400 }, file: "Inter-Regular.woff" },
  { ref: { family: "Inter", weight: 600 }, file: "Inter-SemiBold.woff" },
  { ref: { family: "Playfair Display", weight: 600 }, file: "PlayfairDisplay-SemiBold.woff" },
  { ref: { family: "JetBrains Mono", weight: 400 }, file: "JetBrainsMono-Regular.woff" },
  { ref: { family: "Cormorant Garamond", weight: 600 }, file: "CormorantGaramond-SemiBold.woff" },
];

const TEXTS = [
  "Ship faster",
  "AV Wa To. Yo",
  "office fluff",
  "Line one\nA longer second line",
  "trailing   ",
  "   leading",
  "Arrows → ticks ✓ stars ★",
  "Launch \u{1F680} day",
  "a\n\nb",
  "a\n",
  "",
  "$1,234.50 (+12%)",
  "Café naïve",
];

/** Tolerance in world units; the maths runs the same operations as troika's. */
const DIGITS = 9;

const parsed = new Map<string, TroikaParsedFont>();
const RealXhr = globalThis.XMLHttpRequest;

const bytes = (name: string): ArrayBuffer => {
  const buf = readFileSync(fileURLToPath(new URL(`../assets/fonts/${name}`, import.meta.url)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

/** troika's resolver loads faces over XHR; serve the URL itself and parse it from the map. */
class UrlXhr {
  status = 0;
  response: unknown = null;
  responseType = "";
  onload: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private url = "";
  open(_method: string, url: string) {
    this.url = url;
  }
  send() {
    this.status = 200;
    this.response = this.url;
    this.onload?.();
  }
}

const resolver = createFontResolver((url) => parsed.get(url as unknown as string), {
  getFontsForString: () => Promise.reject(new Error("no unicode resolver in tests")),
});
const typesetter = createTypesetter(resolver, null);
/** Every text here is left to right, so a level-0 bidi stands in for bidi-js. */
const ltrBidi = {
  getEmbeddingLevels: (text: string) => ({
    levels: new Uint8Array(text.length),
    paragraphs: [{ start: 0, end: text.length - 1, level: 0 }],
  }),
  getReorderSegments: () => [],
  getMirroredCharacter: () => null,
};
const layoutTypesetter = createTypesetter(resolver, ltrBidi);

function troikaMeasure(
  text: string,
  opts: MeasureTextOptions,
): Promise<{ width: number; height: number; ascent: number }> {
  return new Promise((resolve) => {
    typesetter.typeset(
      {
        text: prepareEmojiText(text).text,
        font: [
          { label: "default", src: kookaburraFallbackUrl },
          { label: "user", src: metricsFontUrl(opts.font) },
        ],
        fontSize: opts.fontSize,
        letterSpacing: opts.letterSpacing ?? 0,
        lineHeight: opts.lineHeight ?? "normal",
        unicodeFontsURL: "/__no-unicode-font-resolver__",
        metricsOnly: true,
      },
      (result) => {
        const [x0, y0, x1, y1] = result.blockBounds;
        resolve({ width: x1 - x0, height: y1 - y0, ascent: -result.topBaseline });
      },
    );
  });
}

type Anchors = Pick<MeasureTextOptions, "anchorX" | "anchorY" | "textAlign">;

/** troika's own glyph layout for the same text: caret edges per character, and each drawn glyph's outline bounds in order. */
function troikaGlyphs(
  text: string,
  opts: MeasureTextOptions & Required<Anchors>,
): Promise<{ carets: Float32Array; ink: number[][] }> {
  return new Promise((resolve) => {
    layoutTypesetter.typeset(
      {
        text: prepareEmojiText(text).text,
        font: [
          { label: "default", src: kookaburraFallbackUrl },
          { label: "user", src: metricsFontUrl(opts.font) },
        ],
        fontSize: opts.fontSize,
        letterSpacing: opts.letterSpacing ?? 0,
        lineHeight: opts.lineHeight ?? "normal",
        unicodeFontsURL: "/__no-unicode-font-resolver__",
        anchorX: opts.anchorX,
        anchorY: opts.anchorY,
        textAlign: opts.textAlign,
        includeCaretPositions: true,
      },
      (result) => {
        const ink: number[][] = [];
        for (let i = 0; i < result.glyphIds.length; i++) {
          const font = result.fontData[result.glyphFontIndices[i]];
          const bounds = result.glyphData[font.src][result.glyphIds[i]].pathBounds;
          const mult = result.fontSize / font.unitsPerEm;
          const x = result.glyphPositions[i * 2];
          const y = result.glyphPositions[i * 2 + 1];
          ink.push([
            x + bounds[0] * mult,
            y + bounds[1] * mult,
            x + bounds[2] * mult,
            y + bounds[3] * mult,
          ]);
        }
        resolve({ carets: result.caretPositions, ink });
      },
    );
  });
}

beforeAll(async () => {
  // Typr's factory aliases `window` to `self`, which node lacks.
  (globalThis as { self?: unknown }).self ??= globalThis;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = UrlXhr;
  const all = [...FACES, { ref: null, file: "KookaburraFallback.otf" }];
  for (const { ref, file } of all) {
    const url = ref ? metricsFontUrl(ref) : kookaburraFallbackUrl;
    const font = await fontParser.onMainThread(bytes(file));
    parsed.set(url, font);
    registerParsedFont(url, font);
  }
});

afterAll(() => {
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = RealXhr;
});

describe("measureText", () => {
  it("matches troika's typesetter across faces, sizes, spacing and line heights", async () => {
    let compared = 0;
    for (const { ref } of FACES) {
      for (const fontSize of [0.6, 1, 0.37]) {
        for (const letterSpacing of [0, 0.05, -0.02]) {
          for (const lineHeight of [undefined, 1.2]) {
            for (const text of TEXTS) {
              const opts = { font: ref, fontSize, letterSpacing, lineHeight };
              const ours = measureText(text, opts);
              const theirs = await troikaMeasure(text, opts);
              const label = `${ref.family}@${ref.weight} ${fontSize} ${letterSpacing} ${lineHeight} ${JSON.stringify(text)}`;
              expect(ours, label).not.toBeNull();
              expect(ours?.width, label).toBeCloseTo(theirs.width, DIGITS);
              expect(ours?.height, label).toBeCloseTo(theirs.height, DIGITS);
              expect(ours?.ascent, label).toBeCloseTo(theirs.ascent, DIGITS);
              compared++;
            }
          }
        }
      }
    }
    expect(compared).toBe(FACES.length * 3 * 3 * 2 * TEXTS.length);
  });

  it("splits a single line into ascent and descent, and counts lines", () => {
    const one = measureText("Ship faster", { font: "Inter@600", fontSize: 0.6 });
    expect(one).not.toBeNull();
    if (!one) return;
    expect(one.lines).toBe(1);
    expect(one.ascent + one.descent).toBeCloseTo(one.height, 12);
    expect(one.width).toBeGreaterThan(0);
    const two = measureText("Ship\nfaster", { font: "Inter@600", fontSize: 0.6 });
    expect(two?.lines).toBe(2);
    expect(two?.height).toBeCloseTo(one.height * 2, 12);
  });

  it("scales linearly with the font size", () => {
    const a = measureText("Highlights", { font: { family: "Inter", weight: 400 }, fontSize: 1 });
    const b = measureText("Highlights", { font: { family: "Inter", weight: 400 }, fontSize: 0.5 });
    expect(b?.width).toBeCloseTo((a?.width ?? 0) / 2, 9);
    expect(b?.height).toBeCloseTo((a?.height ?? 0) / 2, 9);
  });

  it("places every glyph where troika draws it, under every anchor and alignment", async () => {
    const placements: Required<Anchors>[] = [
      { anchorX: "center", anchorY: "middle", textAlign: "left" },
      { anchorX: "left", anchorY: "top", textAlign: "center" },
      { anchorX: "right", anchorY: "bottom", textAlign: "right" },
    ];
    let glyphs = 0;
    for (const { ref } of FACES) {
      for (const letterSpacing of [0, 0.05]) {
        for (const placement of placements) {
          for (const text of TEXTS) {
            const opts = { font: ref, fontSize: 0.6, letterSpacing, ...placement };
            const ours = measureText(text, opts);
            const theirs = await troikaGlyphs(text, opts);
            const label = `${ref.family}@${ref.weight} ${letterSpacing} ${placement.anchorX}/${placement.anchorY}/${placement.textAlign} ${JSON.stringify(text)}`;
            const boxes = ours?.glyphs ?? [];
            for (const g of boxes) {
              // troika splits a ligature's carets across its characters; the box spans them all.
              const last = g.index + g.text.length - 1;
              expect(g.x, `${label} x ${g.index}`).toBeCloseTo(theirs.carets[g.index * 4], 5);
              expect(g.x + g.width, `${label} right ${g.index}`).toBeCloseTo(
                theirs.carets[last * 4 + 1],
                5,
              );
            }
            const inked = boxes.filter((g) => g.ink !== null);
            expect(inked.length, label).toBe(theirs.ink.length);
            inked.forEach((g, i) => {
              for (let k = 0; k < 4; k++) {
                expect(g.ink?.[k], `${label} ink ${g.index}`).toBeCloseTo(theirs.ink[i][k], 5);
              }
            });
            glyphs += boxes.length;
          }
        }
      }
    }
    expect(glyphs).toBeGreaterThan(1000);
  });

  it("keeps a glyph's text, index and line, and leaves line breaks out", () => {
    const box = measureText("Hi\nyou", { font: "Inter@600", fontSize: 1 });
    expect(box?.glyphs.map((g) => [g.text, g.index, g.line])).toEqual([
      ["H", 0, 0],
      ["i", 1, 0],
      ["y", 3, 1],
      ["o", 4, 1],
      ["u", 5, 1],
    ]);
    const centred = box?.glyphs[0];
    // Middle-anchored: the first baseline sits half the block above the centre, less the ascent.
    expect(centred?.baseline).toBeCloseTo((box?.height ?? 0) / 2 - (box?.ascent ?? 0), 12);
    expect(centred?.capHeight).toBeGreaterThan(0);
  });

  it("gives whitespace a cell but no ink, so spaces can hold a slot", () => {
    const box = measureText("A  B", { font: "Inter@400", fontSize: 1, anchorX: "left" });
    const gap = box?.glyphs.filter((g) => g.text === " ") ?? [];
    expect(gap).toHaveLength(2);
    expect(gap.every((g) => g.ink === null && g.width > 0)).toBe(true);
    expect(gap[1].x).toBeCloseTo(gap[0].x + gap[0].width, 9);
  });

  it("is null for a face that has not been parsed", () => {
    expect(measureText("Hi", { font: "Lora", fontSize: 1 })).toBeNull();
  });
});
