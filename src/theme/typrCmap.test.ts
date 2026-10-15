import typrFactory, { type TyprFont } from "troika-three-text/libs/typr.factory.js";
import { beforeAll, describe, expect, it } from "vitest";

type Typr = ReturnType<typeof typrFactory>;
let typr: Typr;

beforeAll(() => {
  // Typr's factory aliases `window` to `self`, which node lacks.
  (globalThis as { self?: unknown }).self ??= globalThis;
  typr = typrFactory();
});

const fmt0 = (map: number[]) => ({ format: 0, map });
/** One format 4 segment mapping [start, end] to start + delta, plus the 0xFFFF terminator. */
const fmt4 = (start: number, end: number, delta: number) => ({
  format: 4,
  startCount: [start, 0xffff],
  endCount: [end, 0xffff],
  idDelta: [delta, 1],
  idRangeOffset: [0, 0],
  glyphIdArray: [],
});
const fmt6 = (firstCode: number, glyphIdArray: number[]) => ({
  format: 6,
  firstCode,
  glyphIdArray,
});
const fmt12 = (groups: [number, number, number][]) => ({ format: 12, groups });

function font(subtables: Record<string, unknown>): TyprFont {
  const tables: unknown[] = [];
  const cmap: Record<string, unknown> = {};
  for (const [key, table] of Object.entries(subtables)) {
    cmap[key] = tables.length;
    tables.push(table);
  }
  return { cmap: { ...cmap, tables } };
}

const glyph = (f: TyprFont, code: number) => typr.U.codeToGlyph(f, code);

describe("Typr.U.codeToGlyph subtable selection (troika patch)", () => {
  it("keeps the first present of p0e4, p3e1, p1e0, p0e3 when it is readable", () => {
    const f = font({ p0e3: fmt4(0x41, 0x5a, 100), p3e1: fmt4(0x41, 0x5a, 200) });
    expect(glyph(f, 0x41)).toBe(0x41 + 200);
    const mac = font({ p1e0: fmt0([0, 7, 8]), p0e3: fmt4(0, 2, 50) });
    expect(glyph(mac, 1)).toBe(7);
    const full = font({ p0e4: fmt12([[0x41, 0x5a, 3]]), p3e1: fmt4(0x41, 0x5a, 9) });
    expect(glyph(full, 0x42)).toBe(4);
  });

  it("falls through a format 6 Mac Roman table to the next readable Unicode table", () => {
    const menlo = font({ p0e3: fmt4(0x20, 0x7e, -29), p1e0: fmt6(0x20, [90, 91, 92]) });
    expect(glyph(menlo, 0x41)).toBe(0x41 - 29);
    expect(glyph(menlo, 0x20)).toBe(3);
  });

  it("falls through an unparsed subtable instead of throwing", () => {
    const f = { cmap: { p3e1: 0, p0e3: 1, tables: [undefined, fmt4(0x41, 0x41, 1)] } };
    expect(glyph(f, 0x41)).toBe(0x42);
  });

  it("reads format 6 when no format 0, 4 or 12 table exists, Unicode before Mac Roman", () => {
    const f = font({ p1e0: fmt6(0x41, [9]), p3e1: fmt6(0x41, [7, 8]) });
    expect(glyph(f, 0x41)).toBe(7);
    expect(glyph(f, 0x42)).toBe(8);
    expect(glyph(f, 0x43)).toBe(0);
    expect(glyph(f, 0x40)).toBe(0);
  });

  it("reads the extra Unicode encodings after the original four", () => {
    const f = font({ p0e1: fmt4(0x41, 0x5a, 5) });
    expect(glyph(f, 0x41)).toBe(0x46);
  });

  it("still throws when nothing is readable", () => {
    expect(() => glyph(font({ p3e0: fmt4(0, 1, 0) }), 0x41)).toThrow(
      "no familiar platform and encoding!",
    );
    expect(() => glyph(font({ p1e0: { format: 2 } }), 0x41)).toThrow("unknown cmap table format 2");
  });
});
