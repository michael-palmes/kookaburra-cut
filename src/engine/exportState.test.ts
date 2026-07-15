import { describe, expect, it } from "vitest";
import { isExporting, setExporting } from "./exportState";

describe("exportState", () => {
  it("raises and releases a single hold", () => {
    expect(isExporting()).toBe(false);
    setExporting(true);
    expect(isExporting()).toBe(true);
    setExporting(false);
    expect(isExporting()).toBe(false);
  });

  it("keeps the flag up across an inner release while an outer hold nests over it", () => {
    // The verifyDeterminism shape: a whole-run hold over each pass's own raise/lower; the flag must not drop between pass A and pass B.
    setExporting(true); // verify's whole-run hold
    setExporting(true); // pass A
    setExporting(false); // pass A ends
    expect(isExporting()).toBe(true);
    setExporting(true); // pass B
    setExporting(false); // pass B ends
    expect(isExporting()).toBe(true);
    setExporting(false); // verify ends
    expect(isExporting()).toBe(false);
  });

  it("clamps an unbalanced release instead of going negative", () => {
    setExporting(false);
    expect(isExporting()).toBe(false);
    setExporting(true);
    expect(isExporting()).toBe(true);
    setExporting(false);
  });
});
