import { describe, expect, it } from "vitest";
import { isExporting, setExporting, subscribeExporting, withExporting } from "./exportState";

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

  it("holds before synchronous preamble work and through frame zero", async () => {
    const phases: Array<[string, boolean]> = [];

    await withExporting(async () => {
      phases.push(["selection clear", isExporting()]);
      await Promise.resolve();
      phases.push(["frame zero", isExporting()]);
    });

    expect(phases).toEqual([
      ["selection clear", true],
      ["frame zero", true],
    ]);
    expect(isExporting()).toBe(false);
  });

  it("releases the lifecycle hold when preparation fails", async () => {
    await expect(
      withExporting(async () => {
        expect(isExporting()).toBe(true);
        throw new Error("preload failed");
      }),
    ).rejects.toThrow("preload failed");
    expect(isExporting()).toBe(false);
  });

  it("notifies subscribers only when the nested lifecycle enters or leaves export", () => {
    const states: boolean[] = [];
    const unsubscribe = subscribeExporting(() => states.push(isExporting()));

    setExporting(true);
    setExporting(true);
    setExporting(false);
    setExporting(false);
    unsubscribe();

    expect(states).toEqual([true, false]);
  });
});
