import { describe, expect, it } from "vitest";
import { BLOCKING_MODAL_SELECTOR, hasBlockingModalOverlay } from "./modalOverlayPresence";

describe("hasBlockingModalOverlay", () => {
  it("uses the editor's shared blocking-overlay contract", () => {
    let selector = "";
    const present = hasBlockingModalOverlay({
      querySelector: (value) => {
        selector = value;
        return {};
      },
    });
    expect(present).toBe(true);
    expect(selector).toBe(BLOCKING_MODAL_SELECTOR);
  });

  it("reports an editor with no blocking overlay", () => {
    expect(hasBlockingModalOverlay({ querySelector: () => null })).toBe(false);
  });
});
