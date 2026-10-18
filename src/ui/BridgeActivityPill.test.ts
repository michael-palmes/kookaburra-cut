import { describe, expect, it } from "vitest";
import { activityLabel } from "./BridgeActivityPill";

describe("the bridge activity pill", () => {
  it("names the work and what is queued behind it", () => {
    expect(activityLabel({ kind: "capture", queued: 0 })).toBe("Claude capturing");
    expect(activityLabel({ kind: "capture", queued: 3 })).toBe("Claude capturing · 3 queued");
    expect(activityLabel({ kind: "check", queued: 1 })).toBe("Claude checking · 1 queued");
  });
});
