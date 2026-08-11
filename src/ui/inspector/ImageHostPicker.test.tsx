import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImageHostPicker } from "./ImageHostPicker";

describe("ImageHostPicker", () => {
  it("keeps Stage available and exposes an accessible Overlay explanation", () => {
    const html = renderToStaticMarkup(
      <ImageHostPicker
        stageIcon={<span>stage icon</span>}
        overlayIcon={<span>overlay icon</span>}
        overlayAvailable={false}
        onPick={() => undefined}
      />,
    );

    expect(html).toContain("<strong>Stage</strong>");
    expect(html).toContain('aria-disabled="true" aria-describedby="image-host-overlay-reason"');
    expect(html).toContain('id="image-host-overlay-reason"');
    expect(html).toContain("Add an Overlay to this scene");
    expect(html).not.toContain(' disabled=""');
  });

  it("enables Overlay without an obsolete description", () => {
    const html = renderToStaticMarkup(
      <ImageHostPicker
        stageIcon={<span>stage icon</span>}
        overlayIcon={<span>overlay icon</span>}
        overlayAvailable
        onPick={() => undefined}
      />,
    );

    expect(html).toContain('aria-disabled="false"');
    expect(html).not.toContain("image-host-overlay-reason");
  });
});
