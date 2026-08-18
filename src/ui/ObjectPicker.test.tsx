import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ResolvedObjectAsset } from "../toolkit/objects/registry";
import { ObjectPicker, objectPickerFocusTarget } from "./ObjectPicker";

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

describe("ObjectPicker", () => {
  it("renders as an inspector body without a modal overlay when embedded", () => {
    const html = renderToStaticMarkup(
      <ObjectPicker embedded onPick={() => undefined} onCancel={() => undefined} />,
    );

    expect(html).toContain("inspector-object-picker-body");
    expect(html).toContain("inspector-drill-actions");
    expect(html).not.toContain("modal-overlay");
    expect(html).not.toContain('aria-modal="true"');
  });
});
