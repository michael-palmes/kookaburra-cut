import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DrillBack,
  DrillHeaderAction,
  InspectorSliderRow,
  SegmentedRow,
  segmentedKeyTarget,
} from "./rows";

describe("DrillBack", () => {
  it("renders the return destination and current screen in one labelled button", () => {
    const html = renderToStaticMarkup(
      <DrillBack label="Lighting" title="Shadows" onClick={() => undefined} />,
    );

    expect(html).toContain('aria-label="Back to Lighting from Shadows"');
    expect(html).toContain('class="inspector-drill-destination">Lighting</span>');
    expect(html).toContain('class="inspector-drill-current">Shadows</span>');
    expect(html).toMatch(
      /<button[^>]*class="inspector-drill-back"[^>]*>[\s\S]*class="inspector-drill-current">Shadows<\/span>[\s\S]*<\/button>/,
    );
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("seats labelled content actions beside the current screen", () => {
    const html = renderToStaticMarkup(
      <DrillBack
        label="Scene"
        title="Device"
        onClick={() => undefined}
        actions={
          <>
            <DrillHeaderAction
              kind="duplicate"
              label="Duplicate device"
              onClick={() => undefined}
            />
            <DrillHeaderAction kind="remove" label="Remove device" onClick={() => undefined} />
          </>
        }
      />,
    );

    expect(html).toContain('class="inspector-drill-header-actions"');
    expect(html).toContain('aria-label="Duplicate device"');
    expect(html).toContain('class="inspector-drill-header-action danger"');
    expect(html).toContain('aria-label="Remove device"');
    expect(html.match(/<button/g)).toHaveLength(3);
  });
});

describe("DrillHeaderAction", () => {
  it("draws the reset and apply-all glyphs, with an optional tooltip beside the label", () => {
    const reset = renderToStaticMarkup(
      <DrillHeaderAction
        kind="reset"
        label="Reset to theme default"
        onClick={() => undefined}
        disabled
      />,
    );
    expect(reset).toContain('class="inspector-drill-header-action"');
    expect(reset).toContain('aria-label="Reset to theme default" title="Reset to theme default"');
    expect(reset).toContain('disabled=""');
    expect(reset).toContain('d="M13.2 8.4a5.2 5.2 0 1 1-1.7-3.9"');
    expect(reset).toContain('d="M13.4 2.2v3h-3"');

    const applyAll = renderToStaticMarkup(
      <DrillHeaderAction
        kind="apply-all"
        label="Apply to all slides"
        title="Copy this background to every scene"
        onClick={() => undefined}
      />,
    );
    expect(applyAll).toContain(
      'aria-label="Apply to all slides" title="Copy this background to every scene"',
    );
    expect(applyAll.match(/<rect /g)).toHaveLength(2);
    expect(applyAll).toContain('x="5.4" y="5.4" width="8.2" height="8.2" rx="1.4"');
    expect(applyAll).not.toContain("confirming");
  });

  it("swaps the glyph for its confirm question in place while armed", () => {
    const html = renderToStaticMarkup(
      <DrillHeaderAction
        kind="apply-all"
        label="Apply to all slides"
        confirmLabel="Apply to 5 other scenes?"
        onClick={() => undefined}
        onDisarm={() => undefined}
      />,
    );

    expect(html).toContain('class="inspector-drill-header-action confirming"');
    expect(html).toContain(
      'aria-label="Apply to 5 other scenes?" title="Apply to 5 other scenes?"',
    );
    expect(html).toMatch(/>Apply to 5 other scenes\?<\/button>$/);
    expect(html).not.toContain("<svg");
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

  it("pins the thumb at a soft end while the value keeps the typed number", () => {
    const softRow = (value: number) => (
      <InspectorSliderRow
        icon={<span>x</span>}
        label="Left-right"
        value={value}
        min={-3}
        max={3}
        step={0.01}
        overflowMin
        overflowMax
        onCommit={() => undefined}
      />
    );

    const over = renderToStaticMarkup(softRow(9));
    expect(over).toContain('value="3"');
    expect(over).toContain("9.00");

    const under = renderToStaticMarkup(softRow(-9));
    expect(under).toContain('value="-3"');
    expect(under).toContain("-9.00");
  });
});

describe("SegmentedRow", () => {
  const options = [
    { value: "left", label: "Left" },
    { value: "center", label: "Centre" },
    { value: "right", label: "Right" },
  ];

  it("renders an accessible labelled radio setting", () => {
    const html = renderToStaticMarkup(
      <SegmentedRow
        ariaLabel="Alignment"
        options={options}
        value="center"
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('role="radiogroup" aria-label="Alignment"');
    expect(html).toContain('role="radio" aria-checked="true" tabindex="0"');
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
  });

  it("supports arrow, Home and End navigation", () => {
    expect(segmentedKeyTarget(options, "center", "ArrowRight")).toBe("right");
    expect(segmentedKeyTarget(options, "right", "ArrowRight")).toBe("left");
    expect(segmentedKeyTarget(options, "left", "ArrowLeft")).toBe("right");
    expect(segmentedKeyTarget(options, "center", "Home")).toBe("left");
    expect(segmentedKeyTarget(options, "center", "End")).toBe("right");
    expect(segmentedKeyTarget(options, "center", "Enter")).toBeNull();
  });

  it("removes disabled settings from the tab order", () => {
    const html = renderToStaticMarkup(
      <SegmentedRow
        ariaLabel="Alignment"
        options={options}
        value="center"
        disabled
        onChange={() => undefined}
      />,
    );

    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(3);
    expect(html).not.toContain('tabindex="0"');
  });

  it("keeps the first enabled option tabbable when the value is unmatched", () => {
    const html = renderToStaticMarkup(
      <SegmentedRow<string>
        ariaLabel="Alignment"
        options={[{ ...options[0], disabled: true }, options[1], options[2]]}
        value="justify"
        onChange={() => undefined}
      />,
    );

    expect(html).not.toContain('aria-checked="true"');
    expect(html).toContain(
      'role="radio" aria-checked="false" tabindex="-1" class="inspector-subtab" disabled=""',
    );
    expect(html).toContain('role="radio" aria-checked="false" tabindex="0"');
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });
});
