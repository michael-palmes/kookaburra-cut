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

  it("is null for a face that has not been parsed", () => {
    expect(measureText("Hi", { font: "Lora", fontSize: 1 })).toBeNull();
  });
});
