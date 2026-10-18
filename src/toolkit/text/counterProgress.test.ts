import { describe, expect, it } from "vitest";
import { ease } from "../../engine/ease";
import { counterProgress } from "./counterProgress";

describe("counterProgress", () => {
  it("runs the legacy linear expression when no timing option is set", () => {
    for (const t of [-100, 0, 250, 999, 1000, 4000]) {
      expect(counterProgress({ durationMs: 1000 }, t)).toBe(Math.min(1, Math.max(0, t / 1000)));
    }
    expect(counterProgress({ durationMs: 0 }, -5)).toBe(1);
  });

  it("starts at startMs", () => {
    expect(counterProgress({ durationMs: 1000, startMs: 500 }, 400)).toBe(0);
    expect(counterProgress({ durationMs: 1000, startMs: 500 }, 1000)).toBe(0.5);
    expect(counterProgress({ durationMs: 1000, startMs: 500 }, 1500)).toBe(1);
  });

  it("shapes the count with an ease", () => {
    expect(counterProgress({ durationMs: 1000, ease: "outCubic" }, 300)).toBe(
      ease("outCubic", 0.3),
    );
  });

  it("counts in equal jumps with steps, landing on the end", () => {
    const at = (t: number) => counterProgress({ durationMs: 1000, steps: 4 }, t);
    expect([0, 240, 250, 499, 500, 999, 1000].map(at)).toEqual([0, 0, 0.25, 0.25, 0.5, 0.75, 1]);
  });
});
