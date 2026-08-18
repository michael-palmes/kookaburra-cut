import { describe, expect, it } from "vitest";
import type { InspectorState } from "../../store/uiStore";
import { chartSeriesInspectorRoute } from "../inspectorTitles";
import { inspectorRouteSignature, textInspectorEditorOwnsEscape } from "./InspectorNavigationShell";

function state(drillStack: string[]): InspectorState {
  return {
    tab: "scene",
    drillStack,
    drillIn: drillStack.at(-1) ?? null,
    overviewSelection: null,
  };
}

function editorElement({
  tagName,
  type,
  inside = true,
  disabled = false,
  readOnly = false,
  contentEditable = false,
}: {
  tagName: string;
  type?: string;
  inside?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  contentEditable?: boolean;
}): Element {
  return {
    tagName,
    closest: () => (inside ? ({} as Element) : null),
    hasAttribute: (name: string) =>
      (name === "disabled" && disabled) || (name === "readonly" && readOnly),
    getAttribute: (name: string) => {
      if (name === "type") return type ?? null;
      if (name === "contenteditable") return contentEditable ? "true" : null;
      return null;
    },
  } as unknown as Element;
}

describe("inspectorRouteSignature", () => {
  it("uses the canonical tab and route path", () => {
    expect(inspectorRouteSignature(state(["lighting", "lighting.light"]))).toBe(
      "scene|lighting/lighting.light",
    );
  });

  it("uses the stable chart child route rather than its visible authored title", () => {
    const route = chartSeriesInspectorRoute("revenue/APAC");
    const inspector = state(["chart.edit", route]);

    expect(inspectorRouteSignature(inspector)).toBe(`scene|chart.edit/${route}`);
    expect(inspectorRouteSignature(inspector)).toBe(inspectorRouteSignature({ ...inspector }));
  });
});

describe("textInspectorEditorOwnsEscape", () => {
  it("gives focused text entry fields the first Escape", () => {
    expect(textInspectorEditorOwnsEscape(editorElement({ tagName: "TEXTAREA" }))).toBe(true);
    expect(textInspectorEditorOwnsEscape(editorElement({ tagName: "INPUT" }))).toBe(true);
    expect(textInspectorEditorOwnsEscape(editorElement({ tagName: "INPUT", type: "number" }))).toBe(
      true,
    );
    expect(
      textInspectorEditorOwnsEscape(editorElement({ tagName: "DIV", contentEditable: true })),
    ).toBe(true);
  });

  it("leaves navigation Escape active for other controls and inspectors", () => {
    expect(textInspectorEditorOwnsEscape(editorElement({ tagName: "INPUT", type: "range" }))).toBe(
      false,
    );
    expect(textInspectorEditorOwnsEscape(editorElement({ tagName: "INPUT", inside: false }))).toBe(
      false,
    );
    expect(
      textInspectorEditorOwnsEscape(editorElement({ tagName: "TEXTAREA", readOnly: true })),
    ).toBe(false);
  });
});
