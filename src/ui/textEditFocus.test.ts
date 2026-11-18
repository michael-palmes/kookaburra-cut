import { describe, expect, it } from "vitest";
import { isEditableTextTarget, spaceMeansPlayback, spacePressesControl } from "./textEditFocus";

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

describe("spaceMeansPlayback", () => {
  it("hands Space to the transport where a literal space means nothing", () => {
    expect(spaceMeansPlayback({ tagName: "INPUT", inputMode: "decimal" })).toBe(true);
    expect(spaceMeansPlayback({ tagName: "INPUT", inputMode: "numeric" })).toBe(true);
    expect(spaceMeansPlayback({ tagName: "INPUT", type: "range" })).toBe(true);
    expect(spaceMeansPlayback({ tagName: "INPUT", type: "number" })).toBe(true);
    expect(spaceMeansPlayback({ tagName: "INPUT", dataset: { spacePlays: "" } })).toBe(true);
  });

  it("leaves Space alone in text, name, search and managed-text fields", () => {
    expect(spaceMeansPlayback({ tagName: "INPUT" })).toBe(false);
    expect(spaceMeansPlayback({ tagName: "INPUT", type: "text" })).toBe(false);
    expect(spaceMeansPlayback({ tagName: "INPUT", type: "search" })).toBe(false);
    expect(spaceMeansPlayback({ tagName: "TEXTAREA" })).toBe(false);
    expect(spaceMeansPlayback({ tagName: "TEXTAREA", inputMode: "decimal" })).toBe(false);
    expect(spaceMeansPlayback({ tagName: "SELECT" })).toBe(false);
    expect(spaceMeansPlayback({ tagName: "BUTTON" })).toBe(false);
    expect(spaceMeansPlayback({ tagName: "DIV" })).toBe(false);
    expect(spaceMeansPlayback(null)).toBe(false);
  });

  it("never fires from a control with no value to type", () => {
    expect(spaceMeansPlayback({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(spaceMeansPlayback({ tagName: "INPUT", type: "radio" })).toBe(false);
    expect(spaceMeansPlayback({ tagName: "INPUT", type: "file" })).toBe(false);
    expect(spaceMeansPlayback({ tagName: "INPUT", type: "color" })).toBe(false);
  });

  it("keeps a number field's own text undo while handing it Space", () => {
    const field = { tagName: "INPUT", type: "number" };
    expect(isEditableTextTarget(field)).toBe(true);
    expect(spaceMeansPlayback(field)).toBe(true);
  });
});

describe("spacePressesControl (2.1.1)", () => {
  const el = (tagName: string, attrs: Record<string, string> = {}) => ({
    tagName,
    getAttribute: (name: string) => attrs[name] ?? null,
  });

  it("leaves Space to a focused button, tab, option or card", () => {
    expect(spacePressesControl(el("BUTTON"))).toBe(true);
    expect(spacePressesControl(el("DIV", { role: "button" }))).toBe(true);
    expect(spacePressesControl(el("BUTTON", { role: "tab" }))).toBe(true);
    expect(spacePressesControl(el("DIV", { role: "option" }))).toBe(true);
    expect(spacePressesControl(el("BUTTON", { role: "radio" }))).toBe(true);
    expect(spacePressesControl(el("A", { href: "#" }))).toBe(true);
  });

  it("keeps Space for playback on a card a click focused", () => {
    const clicked = { ...el("DIV", { role: "button" }), matches: () => false };
    const keyed = { ...el("DIV", { role: "button" }), matches: () => true };
    expect(spacePressesControl(clicked)).toBe(false);
    expect(spacePressesControl(keyed)).toBe(true);
  });

  it("keeps Space for the transport everywhere else", () => {
    expect(spacePressesControl(null)).toBe(false);
    expect(spacePressesControl(el("BODY"))).toBe(false);
    expect(spacePressesControl(el("DIV"))).toBe(false);
    expect(spacePressesControl(el("DIV", { role: "slider" }))).toBe(false);
    expect(spacePressesControl(el("A"))).toBe(false);
  });
});
