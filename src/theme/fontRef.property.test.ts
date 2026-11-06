import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatFontString, parseFontString } from "./fontRef";

describe("font reference strings", () => {
  it("round-trips a reference unless the family itself ends in a weight", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 1000 }),
        (family, weight) => {
          // "Foo@600" at the default weight formats as "Foo@600", which reads as Foo at 600.
          fc.pre(weight !== 400 || parseFontString(family).family === family);
          expect(parseFontString(formatFontString({ family, weight }))).toEqual({ family, weight });
        },
      ),
    );
  });

  it("keeps every parsed weight in 1..1000 and reads its own output back unchanged", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const ref = parseFontString(text);
        expect(ref.weight).toBeGreaterThanOrEqual(1);
        expect(ref.weight).toBeLessThanOrEqual(1000);
        expect(parseFontString(formatFontString(ref))).toEqual(ref);
      }),
    );
  });
});
