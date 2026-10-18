import { describe, expect, it } from "vitest";
import {
  applyConformProgress,
  type ConformJob,
  type ConformProgress,
  conformPercent,
} from "./media";

const event = (patch: Partial<ConformProgress>): ConformProgress => ({
  slug: "product-tour",
  rel: "assets/rec.mp4",
  stage: "conforming",
  frame: 0,
  total: 0,
  error: null,
  ...patch,
});

describe("conform job progress", () => {
  it("adds a queued job, follows its frames and drops it when it lands or fails", () => {
    let jobs: ConformJob[] = [];
    jobs = applyConformProgress(jobs, event({ stage: "queued" }), "assets/.originals/rec.mov");
    expect(jobs).toEqual([
      {
        slug: "product-tour",
        rel: "assets/rec.mp4",
        original: "assets/.originals/rec.mov",
        frame: 0,
        total: 0,
      },
    ]);
    jobs = applyConformProgress(jobs, event({ frame: 30, total: 240 }));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ frame: 30, total: 240, original: "assets/.originals/rec.mov" });
    expect(applyConformProgress(jobs, event({ stage: "done", frame: 240, total: 240 }))).toEqual(
      [],
    );
    expect(applyConformProgress(jobs, event({ stage: "failed", error: "boom" }))).toEqual([]);
  });

  it("keeps other projects' and other files' jobs untouched", () => {
    const other: ConformJob = {
      slug: "highlights",
      rel: "assets/rec.mp4",
      original: "",
      frame: 1,
      total: 2,
    };
    const next = applyConformProgress([other], event({ stage: "done" }));
    expect(next).toEqual([other]);
  });

  it("reads progress as a whole percentage, zero while waiting", () => {
    expect(conformPercent({ frame: 0, total: 0 })).toBe(0);
    expect(conformPercent({ frame: 119, total: 240 })).toBe(49);
    expect(conformPercent({ frame: 240, total: 240 })).toBe(100);
    expect(conformPercent({ frame: 300, total: 240 })).toBe(100);
  });
});
