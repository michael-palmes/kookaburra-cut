import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Theme } from "../../theme/tokens";
import {
  bucketSize,
  captureDensity,
  captureSize,
  gaussianWeights,
  groupSigmas,
  movedRect,
  OPTICAL_MAX_LEVELS,
  OPTICAL_MAX_SIGMA_TEXELS,
  OPTICAL_MAX_SUPERSAMPLE,
  OPTICAL_MAX_TARGET,
  OPTICAL_PAD_SIGMAS,
  OPTICAL_ROLL_REACH_EM,
  OPTICAL_SIGMA_PER_SOFT,
  OPTICAL_SOFT_EPS_EM,
  type OpticalBlurPlan,
  planOpticalBlur,
  type Rect,
  screenDensity,
  tapRadius,
  unitRestRects,
} from "./opticalBlur";
import {
  resolveTextAnimation,
  type StaggerUnits,
  sampleTextUnit,
  type TextUnitSample,
  TRACK_SOFT_EM,
} from "./presets";

const theme: Theme = {
  id: "test",
  name: "Test",
  colors: { background: "#000", text: "#fff", accent: "#08f", muted: "#888" },
  typography: {
    headline: { family: "Inter", weight: 600 },
    body: { family: "Inter", weight: 400 },
    scale: 1.25,
  },
  motion: {
    durations: { fast: 200, base: 500, slow: 900 },
    easings: { standard: "outQuad", emphasized: "outExpo" },
  },
};

const FS = 0.5;

/** Five 0.3-wide character units on one line, centred on 0. */
function fiveUnits(): StaggerUnits {
  const startX = new Float32Array([-0.75, -0.45, -0.15, 0.15, 0.45]);
  const endX = startX.map((x) => x + 0.3);
  return {
    count: 5,
    startX,
    endX,
    edgeKey: endX.slice(),
    centerY: new Float32Array(5),
    axis: "x",
  };
}

const BOUNDS: Rect = [-0.75, -0.3, 0.75, 0.3];

function samplesAt(preset: string, localMs: number, staggerMs = 0): TextUnitSample[] {
  const anim = resolveTextAnimation({ preset, staggerMs }, theme);
  if (!anim) throw new Error("no animation");
  const units = fiveUnits();
  return Array.from({ length: units.count }, (_, i) =>
    sampleTextUnit({ anim, from: 0, to: 900 }, i, localMs, {
      count: units.count,
      unitCenterEm: [(units.startX[i] + units.endX[i]) / 2 / FS, 0],
    }),
  );
}

function plan(samples: TextUnitSample[]): OpticalBlurPlan {
  const units = fiveUnits();
  const p = planOpticalBlur(samples, units, unitRestRects(units, null, BOUNDS, FS), FS);
  if (!p) throw new Error("no plan");
  return p;
}

describe("gaussianWeights", () => {
  it("sums to one over the full kernel and reaches 3σ", () => {
    for (const sigma of [0.4, 1, 2.5, 6, 7.2]) {
      const w = gaussianWeights(sigma);
      const total = w[0] + 2 * w.slice(1).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1, 12);
      expect(w.length - 1).toBe(Math.ceil(3 * sigma));
      for (let i = 1; i < w.length; i++) expect(w[i]).toBeLessThan(w[i - 1]);
    }
  });

  it("is the identity at zero σ", () => {
    expect(gaussianWeights(0)).toEqual([1]);
    expect(tapRadius(0)).toBe(0);
  });

  it("stays inside the shader's loop bound at the quantised σ ceiling", () => {
    expect(tapRadius(OPTICAL_MAX_SIGMA_TEXELS * 2 ** 0.25)).toBeLessThanOrEqual(32);
  });
});

describe("groupSigmas", () => {
  it("keeps one level for equal σ", () => {
    expect(groupSigmas([0.1, 0.1, 0.1])).toEqual([[0, 2]]);
  });

  it("splits beyond the ratio and caps the level count", () => {
    const sorted = Array.from({ length: 12 }, (_, i) => 0.01 * 1.5 ** i);
    const runs = groupSigmas(sorted);
    expect(runs.length).toBe(OPTICAL_MAX_LEVELS);
    expect(runs[0][0]).toBe(0);
    expect(runs[runs.length - 1][1]).toBe(11);
    for (let k = 1; k < runs.length; k++) expect(runs[k][0]).toBe(runs[k - 1][1] + 1);
  });
});

describe("planOpticalBlur", () => {
  it("puts a whole-block tracking entry in one level at the preset's σ", () => {
    const samples = samplesAt("tracking", 60);
    const p = plan(samples);
    expect(p.levels.length).toBe(1);
    const level = p.levels[0];
    expect(level.units).toEqual([0, 1, 2, 3, 4]);
    expect(level.sigma).toBeCloseTo(samples[0].softEm * FS * OPTICAL_SIGMA_PER_SOFT, 12);
    expect(samples[0].softEm).toBeLessThan(TRACK_SOFT_EM);
    for (const s of p.main) expect(s.alpha).toBe(0);
    for (const s of p.captures[0]) expect(s.softEm).toBe(0);
    expect(p.captures[0].map((s) => s.alpha)).toEqual(samples.map((s) => s.alpha));
  });

  it("pads the capture past every moved unit by 3.5σ", () => {
    const samples = samplesAt("tracking", 120);
    const p = plan(samples);
    const units = fiveUnits();
    const rests = unitRestRects(units, null, BOUNDS, FS) ?? [];
    const [x0, y0, x1, y1] = p.levels[0].rect;
    const pad = OPTICAL_PAD_SIGMAS * p.levels[0].sigma;
    for (let i = 0; i < 5; i++) {
      const r = movedRect(rests[i], [(units.startX[i] + units.endX[i]) / 2, 0], samples[i], FS);
      expect(r[0] - x0).toBeGreaterThanOrEqual(pad - 1e-9);
      expect(r[1] - y0).toBeGreaterThanOrEqual(pad - 1e-9);
      expect(x1 - r[2]).toBeGreaterThanOrEqual(pad - 1e-9);
      expect(y1 - r[3]).toBeGreaterThanOrEqual(pad - 1e-9);
    }
  });

  it("leaves settled text to the main pass untouched", () => {
    const samples = samplesAt("tracking", 2000);
    const p = plan(samples);
    expect(p.levels).toEqual([]);
    expect(p.main).toEqual(samples);
  });

  it("splits a staggered entry by σ and hides each blurred unit from the main pass", () => {
    const samples = samplesAt("tracking", 300, 120);
    const p = plan(samples);
    expect(p.levels.length).toBeGreaterThan(1);
    const seen = p.levels.flatMap((l) => l.units).sort();
    for (const u of seen) expect(p.main[u].alpha).toBe(0);
    p.levels.forEach((level, i) => {
      for (let u = 0; u < 5; u++) {
        if (!level.units.includes(u)) expect(p.captures[i][u].alpha).toBe(0);
      }
    });
  });

  it("keeps the SDF soften for units with depth (the capture is flat)", () => {
    const samples = samplesAt("dolly", 100);
    const p = plan(samples);
    expect(p.levels).toEqual([]);
    expect(p.main.map((s) => s.softEm)).toEqual(samples.map((s) => s.softEm));
  });

  it("snaps a sub-threshold soften crisp", () => {
    const samples = samplesAt("tracking", 2000).map((s) => ({
      ...s,
      softEm: OPTICAL_SOFT_EPS_EM / 2,
    }));
    const p = plan(samples);
    expect(p.levels).toEqual([]);
    for (const s of p.main) expect(s.softEm).toBe(0);
  });

  it("waits for measured units", () => {
    expect(planOpticalBlur(samplesAt("tracking", 0), null, null, FS)).toBeNull();
  });
});

/** The order captures were planned with before: offset, then scale. */
function offsetThenScale(
  rest: Rect,
  centre: readonly [number, number],
  s: TextUnitSample,
  fontSize: number,
): Rect {
  const grow =
    (s.rotZRad !== 0 ? OPTICAL_ROLL_REACH_EM * fontSize : 0) +
    (Math.max(0, s.weightEm) + Math.abs(s.chromaEm)) * fontSize;
  const dx = s.dxEm * fontSize;
  const dy = s.dyEm * fontSize;
  const sx = Math.abs(s.scale * s.scaleX);
  const sy = Math.abs(s.scale * s.scaleY);
  const x0 = centre[0] + (rest[0] - grow + dx - centre[0]) * sx;
  const x1 = centre[0] + (rest[2] + grow + dx - centre[0]) * sx;
  const y0 = centre[1] + (rest[1] - grow + dy - centre[1]) * sy;
  const y1 = centre[1] + (rest[3] + grow + dy - centre[1]) * sy;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

describe("movedRect", () => {
  it("scales about the unit centre, then offsets, as the vertex shader does", () => {
    const rest: Rect = [-1, -1, 1, 1];
    const s = { ...samplesAt("tracking", 2000)[0], dxEm: 1, scale: 2 };
    expect(movedRect(rest, [0, 0], s, 0.5)).toEqual([-1.5, -2, 2.5, 2]);
  });

  it("keeps an unscaled or unmoved rect exactly as it was planned before", () => {
    const n = fc.double({ min: -8, max: 8, noNaN: true });
    const unit = fc.record({
      rest: fc.tuple(n, n, n, n),
      centre: fc.tuple(n, n),
      d: fc.tuple(n, n),
      s: fc.tuple(n, n, n),
      grow: fc.tuple(fc.double({ min: 0, max: 0.2, noNaN: true }), fc.boolean()),
      fontSize: fc.double({ min: 0.05, max: 2, noNaN: true }),
    });
    const base = samplesAt("tracking", 2000)[0];
    const plain = (r: Rect) => r.map((v) => v + 0);
    fc.assert(
      fc.property(unit, ({ rest, centre, d, s, grow, fontSize }) => {
        const extra = { weightEm: grow[0], chromaEm: grow[0] / 2, rotZRad: grow[1] ? 0.1 : 0 };
        const unscaled = { ...base, ...extra, dxEm: d[0], dyEm: d[1] };
        const unmoved = { ...base, ...extra, scale: s[0], scaleX: s[1], scaleY: s[2] };
        for (const sample of [unscaled, unmoved]) {
          expect(plain(movedRect(rest, centre, sample, fontSize))).toEqual(
            plain(offsetThenScale(rest, centre, sample, fontSize)),
          );
        }
      }),
    );
  });

  it("reaches the chromatic echoes", () => {
    const rest: Rect = [-1, -1, 1, 1];
    const s = { ...samplesAt("tracking", 2000)[0], chromaEm: 0.2 };
    expect(movedRect(rest, [0, 0], s, 0.5)).toEqual([-1.1, -1.1, 1.1, 1.1]);
  });
});

describe("capture density", () => {
  const rect: Rect = [-2, -1, 2, 1];

  it("is screen pixels per layout unit", () => {
    expect(screenDensity(5, true, 10, 1, 1080)).toBeCloseTo(270, 9);
    expect(screenDensity(0.5, false, 99, 2, 1000)).toBeCloseTo(500, 9);
  });

  it("drops resolution so σ never spans more than a few texels", () => {
    const d = captureDensity(0.2, 500, rect);
    expect(0.2 * d).toBeLessThanOrEqual(OPTICAL_MAX_SIGMA_TEXELS * 2 ** 0.25 + 1e-9);
    expect(0.2 * d).toBeGreaterThanOrEqual(OPTICAL_MAX_SIGMA_TEXELS);
  });

  it("supersamples while σ is small", () => {
    const d = captureDensity(1e-4, 500, rect);
    expect(d).toBeGreaterThanOrEqual(500 * OPTICAL_MAX_SUPERSAMPLE);
    expect(d).toBeLessThanOrEqual(500 * OPTICAL_MAX_SUPERSAMPLE * 2 ** 0.25);
  });

  it("quantises nearby densities to one size and caps the target", () => {
    expect(captureDensity(0.05, 400, rect)).toBe(captureDensity(0.05, 401, rect));
    const huge = captureDensity(1e-4, 1e6, rect);
    expect(captureSize(rect, huge)[0]).toBeLessThanOrEqual(OPTICAL_MAX_TARGET);
  });

  it("buckets target sizes", () => {
    expect(bucketSize(1)).toBe(64);
    expect(bucketSize(64)).toBe(64);
    expect(bucketSize(65)).toBe(128);
  });
});
