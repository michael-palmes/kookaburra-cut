import { describe, expect, it } from "vitest";
import type { ResolvedObjectAsset } from "../toolkit/objects/registry";
import { objectPickerFocusTarget } from "./ObjectPicker";

describe("objectPickerFocusTarget", () => {
  const object = {} as ResolvedObjectAsset;

  it("waits for the library, then prefers the first object", () => {
    expect(objectPickerFocusTarget(null, null)).toBeNull();
    expect(objectPickerFocusTarget([object], null)).toBe("object");
  });

  it("uses Import only for an empty library or an error", () => {
    expect(objectPickerFocusTarget([], null)).toBe("import");
    expect(objectPickerFocusTarget(null, "Library unavailable")).toBe("import");
    expect(objectPickerFocusTarget([object], "Library unavailable")).toBe("import");
  });
});
