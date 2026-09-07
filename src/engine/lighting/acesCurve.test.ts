import { describe, expect, it } from "vitest";
import { acesForwardCpu, acesInverseCpu } from "./acesCurve";

describe("acesCurve", () => {
  // Golden values pin the fit to three's ACESFilmicToneMapping (exposure 1); if these move, the GLSL constants drifted and mid-fade pacing would no longer match the composer, so don't update casually.
  it("matches three's ACES filmic on pinned inputs", () => {
    const [r, g, b] = acesForwardCpu([0.18, 0.5, 2.0]);
    expect(r).toBeCloseTo(0.37924201698, 9);
    expect(g).toBeCloseTo(0.56496595064, 9);
    expect(b).toBeCloseTo(0.89303219212, 9);
  });

  it("round-trips inverse(forward(x)) across the invertible HDR range", () => {
    // Invertible only away from the saturate() bounds (toe clamps negative below ~0.002, shoulder saturates at 1); the compositor clamps its encoded mix to <= 0.999 before inverting for this reason.
    const values = [0.01, 0.05, 0.18, 0.5, 1.0, 2.0, 4.0, 8.0];
    let checked = 0;
    for (const r of values) {
      for (const g of values) {
        for (const b of values) {
          const fwd = acesForwardCpu([r, g, b]);
          if (fwd.some((c) => c <= 0.002 || c >= 0.999)) continue; // clamped, not invertible
          const back = acesInverseCpu(fwd);
          expect(back[0]).toBeCloseTo(r, 4);
          expect(back[1]).toBeCloseTo(g, 4);
          expect(back[2]).toBeCloseTo(b, 4);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(200); // the skip must not hollow the test out
  });

  it("is monotone above the fit's black toe", () => {
    const lo = acesForwardCpu([0.01, 0.01, 0.01]);
    const hi = acesForwardCpu([0.02, 0.02, 0.02]);
    expect(lo[0]).toBeGreaterThan(0);
    expect(hi[0]).toBeGreaterThan(lo[0]);
  });
});
