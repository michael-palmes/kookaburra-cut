import { describe, expect, it } from "vitest";
import {
  presentTimingsPendingCount,
  registerPresentTiming,
  reportPresentTimingPending,
  snapshotPresentTimings,
} from "./presentTimingRegistry";

describe("present timing pending reports", () => {
  it("counts per scene and in total, each clear idempotent", () => {
    const a = reportPresentTimingPending(40);
    const b = reportPresentTimingPending(40);
    const c = reportPresentTimingPending(41);
    expect(presentTimingsPendingCount(40)).toBe(2);
    expect(presentTimingsPendingCount()).toBe(3);
    a();
    a();
    expect(presentTimingsPendingCount(40)).toBe(1);
    b();
    c();
    expect(presentTimingsPendingCount()).toBe(0);
  });

  it("never touches the registered entries", () => {
    const clear = reportPresentTimingPending(42);
    const unregister = registerPresentTiming(42, { kind: "counter", toMs: 1200 });
    clear();
    expect(snapshotPresentTimings(42)).toEqual([{ kind: "counter", toMs: 1200 }]);
    unregister();
    expect(snapshotPresentTimings(42)).toEqual([]);
  });
});
