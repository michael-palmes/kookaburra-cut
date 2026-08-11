import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DrillBack, InspectorSliderRow } from "./rows";

describe("DrillBack", () => {
  it("renders the return destination and current screen in one labelled button", () => {
    const html = renderToStaticMarkup(
      <DrillBack label="Lighting" title="Shadows" onClick={() => undefined} />,
    );

    expect(html).toContain('aria-label="Back to Lighting from Shadows"');
    expect(html).toContain('class="inspector-drill-destination">Lighting</span>');
    expect(html).toContain('class="inspector-drill-current">Shadows</span>');
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});

describe("InspectorSliderRow", () => {
  it("adds a semantic leading icon without changing the range and value controls", () => {
    const html = renderToStaticMarkup(
      <InspectorSliderRow
        icon={<span data-testid="axis-icon">x</span>}
        label="Left-right"
        value={0.25}
        min={-3}
        max={3}
        step={0.01}
        onCommit={() => undefined}
      />,
    );

    expect(html).toContain('class="popover-inline slider-row-label"');
    expect(html).toContain('class="inspector-slider-row-icon"');
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-label="Left-right"');
    expect(html).toContain('class="range-value"');
    expect(html).toContain("0.25");
    expect(html.match(/type="range"/g)).toHaveLength(1);
  });
});
