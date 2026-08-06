import { describe, expect, it } from "vitest";
import { needsFreeCameraWarning, resolveFreeCameraWarning } from "./freeCameraGate";

describe("free camera warning gate", () => {
  it("warns every time until the flag is dismissed", () => {
    expect(needsFreeCameraWarning(false)).toBe(true);
    expect(needsFreeCameraWarning(true)).toBe(false);
  });

  it("runs the held intent only on confirm", () => {
    expect(resolveFreeCameraWarning("confirm", false).runIntent).toBe(true);
    expect(resolveFreeCameraWarning("cancel", false).runIntent).toBe(false);
    expect(resolveFreeCameraWarning("cancel", true).runIntent).toBe(false);
  });

  it("persists the dismissal only when a ticked box is confirmed", () => {
    expect(resolveFreeCameraWarning("confirm", true).persistDismissal).toBe(true);
    expect(resolveFreeCameraWarning("confirm", false).persistDismissal).toBe(false);
    expect(resolveFreeCameraWarning("cancel", true).persistDismissal).toBe(false);
  });
});
