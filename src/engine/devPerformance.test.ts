import { describe, expect, it } from "vitest";
import { installDevPerformanceDrain } from "./devPerformance";

describe("dev performance drain", () => {
  it("clears marks and measures as they land", async () => {
    installDevPerformanceDrain();
    installDevPerformanceDrain();
    performance.mark("render-start");
    performance.measure("render", "render-start");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(performance.getEntriesByType("mark")).toHaveLength(0);
    expect(performance.getEntriesByType("measure")).toHaveLength(0);
  });
});
