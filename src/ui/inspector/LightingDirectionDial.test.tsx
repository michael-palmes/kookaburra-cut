import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LightingDirectionDial, lightingDirectionFromPoint } from "./LightingDirectionDial";

describe("LightingDirectionDial", () => {
  it("maps top, right, bottom and left points to compass angles", () => {
    const rect = { left: 10, top: 20, width: 100, height: 100 };
    expect(lightingDirectionFromPoint(rect, 60, 20)).toBe(0);
    expect(lightingDirectionFromPoint(rect, 110, 70)).toBe(90);
    expect(lightingDirectionFromPoint(rect, 60, 120)).toBe(180);
    expect(lightingDirectionFromPoint(rect, 10, 70)).toBe(-90);
  });

  it("exposes keyboard-operable slider semantics", () => {
    const markup = renderToStaticMarkup(
      <LightingDirectionDial value={35} onInput={() => undefined} onCommit={() => undefined} />,
    );
    expect(markup).toContain('role="slider"');
    expect(markup).toContain('aria-label="Sun direction"');
    expect(markup).toContain('aria-valuenow="35"');
    expect(markup).toContain('tabindex="0"');
  });
});
