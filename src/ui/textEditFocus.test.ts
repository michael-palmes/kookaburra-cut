import { describe, expect, it } from "vitest";
import { isEditableTextTarget } from "./textEditFocus";

describe("isEditableTextTarget", () => {
  it("accepts text-entry controls", () => {
    expect(isEditableTextTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isEditableTextTarget({ tagName: "INPUT", type: "number" })).toBe(true);
    expect(isEditableTextTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTextTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTextTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("rejects controls with no text undo of their own", () => {
    expect(isEditableTextTarget({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(isEditableTextTarget({ tagName: "INPUT", type: "color" })).toBe(false);
    expect(isEditableTextTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isEditableTextTarget({ tagName: "SELECT" })).toBe(false);
    expect(isEditableTextTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTextTarget({ tagName: "DIV" })).toBe(false);
    expect(isEditableTextTarget(null)).toBe(false);
  });
});
