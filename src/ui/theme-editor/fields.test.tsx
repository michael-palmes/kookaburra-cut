import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IconSelect } from "./fields";

describe("IconSelect", () => {
  it("renders headed option groups after any ungrouped options", () => {
    const html = renderToStaticMarkup(
      <IconSelect
        icon="cube"
        label="3D background look"
        value="orb-field"
        onChange={vi.fn()}
        options={[{ id: "", label: "None" }]}
        groups={[
          { label: "Grids and fields", options: [{ id: "grid-plain", label: "Grid plain" }] },
          { label: "Abstract forms", options: [{ id: "orb-field", label: "Orb field" }] },
        ]}
      />,
    );
    expect(html).toContain(
      '<option value="">None</option><optgroup label="Grids and fields"><option value="grid-plain">Grid plain</option></optgroup><optgroup label="Abstract forms"><option value="orb-field" selected="">Orb field</option></optgroup>',
    );
  });
});
