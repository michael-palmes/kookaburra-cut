import { describe, expect, it } from "vitest";
import { parseCubeLut } from "./lutCube";

/** A minimal valid 2³ identity cube (red fastest, per the .cube spec). */
const IDENTITY_2 = `TITLE "identity"
# a comment
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

describe("parseCubeLut — pure .cube → RGBA table", () => {
  it("parses size, skips TITLE/comments/blank lines, and fills alpha with 1", () => {
    const lut = parseCubeLut(IDENTITY_2);
    expect(lut.size).toBe(2);
    expect(lut.data.length).toBe(2 * 2 * 2 * 4);
    for (let i = 0; i < 8; i++) expect(lut.data[i * 4 + 3]).toBe(1);
  });

  it("keeps the .cube red-fastest data order (Data3DTexture x-fastest layout)", () => {
    const lut = parseCubeLut(IDENTITY_2);
    // Entry index i encodes (r = i % 2, g = (i >> 1) % 2, b = i >> 2); the identity cube's value at each entry equals those coordinates.
    for (let i = 0; i < 8; i++) {
      expect(lut.data[i * 4]).toBe(i % 2);
      expect(lut.data[i * 4 + 1]).toBe((i >> 1) % 2);
      expect(lut.data[i * 4 + 2]).toBe(i >> 2);
    }
  });

  it("is a pure function of the text (identical output for identical input)", () => {
    const a = parseCubeLut(IDENTITY_2);
    const b = parseCubeLut(IDENTITY_2);
    expect(a.size).toBe(b.size);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it("rejects 1D LUTs", () => {
    expect(() => parseCubeLut("LUT_1D_SIZE 2\n0\n1\n")).toThrow(/1D/);
  });

  it("rejects a missing LUT_3D_SIZE", () => {
    expect(() => parseCubeLut('TITLE "x"\n')).toThrow(/LUT_3D_SIZE/);
    expect(() => parseCubeLut("0 0 0\n")).toThrow(/before LUT_3D_SIZE/);
  });

  it("rejects invalid sizes", () => {
    expect(() => parseCubeLut("LUT_3D_SIZE 1\n0 0 0\n")).toThrow(/LUT_3D_SIZE/);
    expect(() => parseCubeLut("LUT_3D_SIZE 999\n")).toThrow(/LUT_3D_SIZE/);
  });

  it("rejects custom domains (only [0,1] is supported)", () => {
    const text = IDENTITY_2.replace("DOMAIN_MAX 1 1 1", "DOMAIN_MAX 2 2 2");
    expect(() => parseCubeLut(text)).toThrow(/domain/i);
  });

  it("rejects truncated and overlong data", () => {
    const lines = IDENTITY_2.trim().split("\n");
    expect(() => parseCubeLut(lines.slice(0, -1).join("\n"))).toThrow(/Truncated/);
    expect(() => parseCubeLut(`${IDENTITY_2}0.5 0.5 0.5\n`)).toThrow(/Too many/);
  });

  it("rejects malformed rows", () => {
    expect(() => parseCubeLut("LUT_3D_SIZE 2\n0 0\n")).toThrow(/Malformed/);
    expect(() => parseCubeLut("LUT_3D_SIZE 2\n0 0 x\n")).toThrow(/non-numeric/);
  });
});
