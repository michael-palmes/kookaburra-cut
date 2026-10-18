import { describe, expect, it } from "vitest";
import {
  applyConformProgress,
  CONFORM_CANCELLED,
  type ConformJob,
  type ConformProgress,
  conformPercent,
  conformWasCancelled,
  type OriginalFile,
  originalOfClip,
  removableOriginals,
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

  it("keeps the queue in start order as jobs report", () => {
    let jobs: ConformJob[] = [];
    for (const stem of ["a", "b", "c"]) {
      const rel = `assets/${stem}.mp4`;
      jobs = applyConformProgress(
        jobs,
        event({ rel, stage: "queued" }),
        `assets/.originals/${stem}.mov`,
      );
    }
    jobs = applyConformProgress(jobs, event({ rel: "assets/a.mp4", frame: 30, total: 60 }));
    jobs = applyConformProgress(jobs, event({ rel: "assets/b.mp4", frame: 30, total: 90 }));
    expect(jobs.map((job) => job.rel)).toEqual(["assets/a.mp4", "assets/b.mp4", "assets/c.mp4"]);
    expect(jobs[0].original).toBe("assets/.originals/a.mov");
    expect(jobs[1]).toMatchObject({ frame: 30, total: 90 });
  });

  it("tells a stop from a failure", () => {
    expect(conformWasCancelled(event({ stage: "failed", error: CONFORM_CANCELLED }))).toBe(true);
    expect(conformWasCancelled(event({ stage: "failed", error: "boom" }))).toBe(false);
    expect(conformWasCancelled(event({ stage: "done", error: CONFORM_CANCELLED }))).toBe(false);
  });

  it("totals only the originals nothing holds, and finds a clip's own", () => {
    const originals: OriginalFile[] = [
      { rel: "assets/.originals/rec.mov", bytes: 10, clip: "assets/rec.mp4", busy: null },
      { rel: "assets/.originals/demo.mp4", bytes: 20, clip: "assets/demo.mp4", busy: "x" },
      { rel: "assets/.originals/orphan.mov", bytes: 30, clip: null, busy: null },
    ];
    expect(removableOriginals(originals)).toEqual({ count: 2, bytes: 40 });
    expect(removableOriginals([])).toEqual({ count: 0, bytes: 0 });
    expect(originalOfClip(originals, "assets/rec.mp4")?.rel).toBe("assets/.originals/rec.mov");
    expect(originalOfClip(originals, "assets/orphan.mov")).toBeNull();
  });

  it("reads progress as a whole percentage, zero while waiting", () => {
    expect(conformPercent({ frame: 0, total: 0 })).toBe(0);
    expect(conformPercent({ frame: 119, total: 240 })).toBe(49);
    expect(conformPercent({ frame: 240, total: 240 })).toBe(100);
    expect(conformPercent({ frame: 300, total: 240 })).toBe(100);
  });
});
