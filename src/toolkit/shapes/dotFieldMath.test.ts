import { describe, expect, it } from "vitest";
import {
  DOT_FIELD_MAX,
  DOT_ORDERS,
  type DotFieldInput,
  dotFieldFrame,
  dotGrid,
  dotRanks,
  funnelTarget,
  revealScale,
  waveScale,
  windowScale,
} from "./dotFieldMath";

const base: DotFieldInput = { columns: 4, rows: 3, pitchX: 0.5, pitchY: 0.5, size: 0.8 };
const dot = (frame: { dots: Float32Array }, i: number) =>
  Array.from(frame.dots.slice(i * 4, i * 4 + 4));
const tint = (frame: { tints: Float32Array }, i: number) =>
  Array.from(frame.tints.slice(i * 4, i * 4 + 4));

describe("dotGrid", () => {
  it("keeps whole, positive dimensions within the cap", () => {
    expect(dotGrid(10.7, 3.2)).toEqual({ columns: 10, rows: 3 });
    expect(dotGrid(0, -4)).toEqual({ columns: 1, rows: 1 });
    expect(dotGrid(Number.NaN, 5)).toEqual({ columns: 1, rows: 5 });
    const big = dotGrid(500, 500);
    expect(big.columns * big.rows).toBeLessThanOrEqual(DOT_FIELD_MAX);
  });
});

describe("dotRanks", () => {
  const isPermutation = (ranks: Uint32Array) =>
    [...ranks].sort((a, b) => a - b).every((v, i) => v === i);

  it("ranks every order as a permutation", () => {
    for (const order of DOT_ORDERS)
      expect(isPermutation(dotRanks(5, 4, order, 3)), order).toBe(true);
  });

  it("reads left to right from the top, or fills a waffle from the bottom", () => {
    expect([...dotRanks(3, 2, "reading")]).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...dotRanks(3, 2, "rows-up")]).toEqual([3, 4, 5, 0, 1, 2]);
    expect([...dotRanks(3, 2, "columns")]).toEqual([0, 2, 4, 1, 3, 5]);
  });

  it("starts in the middle and breaks ties in reading order", () => {
    const ranks = dotRanks(3, 3, "centre");
    expect(ranks[4]).toBe(0);
    expect([ranks[1], ranks[3], ranks[5], ranks[7]]).toEqual([1, 2, 3, 4]);
  });

  it("shuffles by seed, the same every run", () => {
    const a = dotRanks(4, 4, "random", 7);
    expect([...a]).toEqual([...dotRanks(4, 4, "random", 7)]);
    expect([...a]).not.toEqual([...dotRanks(4, 4, "random", 8)]);
    expect([...dotRanks(3, 1, "random", 1)]).toEqual([1, 2, 0]);
  });
});

describe("waveScale", () => {
  it("is untouched at amount 0 and full on a crest", () => {
    expect(waveScale({ amount: 0 }, 3, 2)).toBe(1);
    expect(waveScale({ wavelength: 4 }, 0, 0)).toBeCloseTo(1);
  });

  it("drops to the trough size half a wavelength along its direction", () => {
    expect(waveScale({ angleDeg: 0, wavelength: 4, min: 0.2 }, 2, 0)).toBeCloseTo(0.2);
    expect(waveScale({ angleDeg: 90, wavelength: 4, min: 0.2 }, 0, 2)).toBeCloseTo(0.2);
    expect(waveScale({ angleDeg: 0, wavelength: 4, min: 0.2 }, 0, 2)).toBeCloseTo(1);
  });

  it("travels along its angle as the phase advances", () => {
    const wave = { angleDeg: 0, wavelength: 8 };
    expect(waveScale({ ...wave, phase: 0.25 }, 2, 0)).toBeCloseTo(1);
    expect(waveScale({ ...wave, phase: 0.25 }, 0, 0)).toBeLessThan(1);
  });
});

describe("windowScale", () => {
  it("leaves a closed window alone", () => {
    expect(windowScale({ open: 0 }, 0, 0)).toBe(1);
  });

  it("clears the middle and keeps the dots past the fall-off", () => {
    const win = { open: 1, radius: 1, softness: 1 };
    expect(windowScale(win, 0, 0)).toBe(0);
    expect(windowScale(win, 0.5, 0)).toBe(0);
    expect(windowScale(win, 1.5, 0)).toBeCloseTo(0.5);
    expect(windowScale(win, 2, 0)).toBe(1);
    expect(windowScale(win, 3, 3)).toBe(1);
  });

  it("opens from the centre outward", () => {
    const win = { open: 0.4, radius: 2, softness: 1, ripple: 1 };
    expect(windowScale(win, 0, 0)).toBeLessThan(windowScale(win, 1, 0));
  });

  it("moves with its centre and squares off with roundness", () => {
    expect(windowScale({ open: 1, radius: 1, softness: 0, centre: [2, 1] }, 2, 1)).toBe(0);
    expect(windowScale({ open: 1, radius: 1, softness: 0, centre: [2, 1] }, 0, 0)).toBe(1);
    const corner = { open: 1, radius: 1, softness: 0 };
    expect(windowScale({ ...corner, roundness: 2 }, 0.9, 0.9)).toBe(1);
    expect(windowScale({ ...corner, roundness: 12 }, 0.9, 0.9)).toBe(0);
  });
});

describe("revealScale", () => {
  it("hides every dot before the reveal and shows them all after", () => {
    expect(revealScale({ progress: 0 }, 0, 10)).toBe(0);
    expect(revealScale({ progress: 1 }, 9, 10)).toBe(1);
  });

  it("pops the first ranks first, with an overshoot", () => {
    const reveal = { progress: 0.2, span: 0.3 };
    expect(revealScale(reveal, 0, 10)).toBeGreaterThan(1);
    expect(revealScale(reveal, 9, 10)).toBe(0);
    expect(revealScale({ ...reveal, overshoot: 0 }, 0, 10)).toBeLessThanOrEqual(1);
  });
});

describe("funnelTarget", () => {
  it("stays put at the start and narrows to one slot in the last column", () => {
    expect(funnelTarget({ progress: 0 }, 3, 0, 4, 6, 0.5).t).toBe(0);
    const last = funnelTarget({ progress: 1 }, 3, 0, 4, 6, 0.5);
    expect(last.t).toBe(1);
    expect(last.y).toBe(0);
    expect(funnelTarget({ progress: 1 }, 3, 5, 4, 6, 0.5).y).toBe(0);
  });

  it("keeps every slot in the first column and stacks the rest onto fewer", () => {
    expect(funnelTarget({ progress: 1 }, 0, 0, 4, 6, 0.5).y).toBeCloseTo(1.25);
    const slots = new Set(
      Array.from({ length: 6 }, (_, row) => funnelTarget({ progress: 1 }, 2, row, 4, 6, 0.5).y),
    );
    expect(slots.size).toBe(3);
  });

  it("moves later columns later", () => {
    const funnel = { progress: 0.4, stagger: 0.5 };
    expect(funnelTarget(funnel, 0, 0, 4, 6, 0.5).t).toBeGreaterThan(
      funnelTarget(funnel, 3, 0, 4, 6, 0.5).t,
    );
  });
});

describe("dotFieldFrame", () => {
  it("centres the grid with the top row first", () => {
    const frame = dotFieldFrame(base);
    expect(frame.count).toBe(12);
    expect(dot(frame, 0)).toEqual([-0.75, 0.5, Math.fround(0.2), 1]);
    expect(dot(frame, 11)).toEqual([0.75, -0.5, Math.fround(0.2), 1]);
    expect(tint(frame, 0)[3]).toBe(0);
  });

  it("recolours a count in order, blending the dot it ends inside", () => {
    const frame = dotFieldFrame({ ...base, counts: [{ value: 2.5, rgb: [1, 0, 0] }] });
    expect(tint(frame, 0)).toEqual([1, 0, 0, 1]);
    expect(tint(frame, 1)[3]).toBe(1);
    expect(tint(frame, 2)[3]).toBe(0.5);
    expect(tint(frame, 3)[3]).toBe(0);
  });

  it("stacks runs one after another in the count order", () => {
    const frame = dotFieldFrame({
      ...base,
      countOrder: "rows-up",
      counts: [
        { value: 1, rgb: [1, 0, 0] },
        { value: 1, rgb: [0, 0, 1] },
      ],
    });
    expect(tint(frame, 8)).toEqual([1, 0, 0, 1]);
    expect(tint(frame, 9)).toEqual([0, 0, 1, 1]);
    expect(tint(frame, 0)[3]).toBe(0);
  });

  it("gathers every dot into one, leaving one dot to carry it", () => {
    const frame = dotFieldFrame({ ...base, gather: { progress: 1, to: [0.2, 0], size: 1 } });
    const alphas = Array.from({ length: 12 }, (_, i) => dot(frame, i)[3]);
    expect(alphas.filter((a) => a === 1)).toHaveLength(1);
    expect(alphas.filter((a) => a === 0)).toHaveLength(11);
    for (let i = 0; i < 12; i++) {
      expect(dot(frame, i)[0]).toBeCloseTo(0.2);
      expect(dot(frame, i)[2]).toBeCloseTo(0.5);
    }
  });

  it("sends displaced dots home as they merge", () => {
    const moved = { ...base, dot: () => ({ offset: [1, 1] as const }) };
    expect(dot(dotFieldFrame(moved), 0)[0]).toBeCloseTo(0.25);
    expect(dot(dotFieldFrame({ ...moved, merge: 0.5 }), 0)[0]).toBeCloseTo(-0.75);
  });

  it("applies the per-dot callback after the fields", () => {
    const frame = dotFieldFrame({
      ...base,
      dot: (d) => (d.index === 1 ? { scale: 2, alpha: 0.5 } : undefined),
    });
    expect(dot(frame, 1)[2]).toBeCloseTo(0.4);
    expect(dot(frame, 1)[3]).toBe(0.5);
    expect(dot(frame, 0)[2]).toBeCloseTo(0.2);
  });

  it("is a pure function of its input and reuses its buffers", () => {
    const input: DotFieldInput = {
      ...base,
      reveal: { progress: 0.6, order: "random", seed: 4 },
      wave: { phase: 0.3 },
      window: { open: 0.7 },
      funnel: { progress: 0.5 },
    };
    const a = dotFieldFrame(input);
    const again = Array.from(a.dots);
    const b = dotFieldFrame(input, a);
    expect(b).toBe(a);
    expect(Array.from(b.dots)).toEqual(again);
    expect(Array.from(dotFieldFrame(input).dots)).toEqual(again);
  });
});
