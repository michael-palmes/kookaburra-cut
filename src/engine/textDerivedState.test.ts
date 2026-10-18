import { describe, expect, it } from "vitest";
import { reportTextDerivedPending, textDerivedPendingCount } from "./textDerivedState";

describe("text-derived pending state", () => {
  it("counts reports and clears each exactly once", () => {
    const base = textDerivedPendingCount();
    const a = reportTextDerivedPending();
    const b = reportTextDerivedPending();
    expect(textDerivedPendingCount()).toBe(base + 2);
    a();
    a();
    expect(textDerivedPendingCount()).toBe(base + 1);
    b();
    expect(textDerivedPendingCount()).toBe(base);
  });
});
