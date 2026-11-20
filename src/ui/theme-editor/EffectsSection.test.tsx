import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GRAIN_HOLD_MAX } from "../../engine/effectParams";
import { EffectsSection } from "./EffectsSection";
import type { ThemeDoc } from "./themeDraft";

describe("EffectsSection", () => {
  it("lets grain hold reach the engine's limit", () => {
    const doc = { effects: { grain: { intensity: 0.2, hold: 24 } } } as unknown as ThemeDoc;
    const html = renderToStaticMarkup(<EffectsSection doc={doc} onPatch={() => {}} />);
    const hold = html.match(/<input[^>]*aria-label="Grain hold"[^>]*>/)?.[0] ?? "";
    expect(hold).toContain('value="24"');
    expect(hold).toContain(`max="${GRAIN_HOLD_MAX}"`);
  });
});
