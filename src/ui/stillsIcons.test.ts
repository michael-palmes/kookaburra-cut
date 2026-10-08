import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STILLS_ICON_IDS, StillsIcon } from "./stillsIcons";

describe("StillsIcon", () => {
  it("draws every glyph at the scene-menu geometry", () => {
    expect(STILLS_ICON_IDS).toEqual([
      "stills",
      "stills-off",
      "still-auto",
      "still-key",
      "still-time",
      "still-add",
      "still-remove",
      "jump",
    ]);
    for (const id of STILLS_ICON_IDS) {
      const html = renderToStaticMarkup(createElement(StillsIcon, { id }));
      expect(html).toContain('viewBox="0 0 20 20"');
      expect(html).toContain('width="17"');
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('stroke-width="1.5"');
      expect(html).toContain('fill="none"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toMatch(/<(path|rect)/);
    }
  });
});
