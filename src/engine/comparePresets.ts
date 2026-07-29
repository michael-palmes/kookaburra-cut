import type { CompareTrackDoc } from "./compareEditStore";

/** Divider motion presets: each writes REAL keys and segments through the doc funnel (one history entry) so the result is hand-tunable in the lane, the camera-preset rule. Times scale to the scene duration and round to whole ms. Value semantics: the divider's position along the sweep axis with side A (before) on the origin side, so revealing the after travels 1 to 0; a mirrored story is the reciprocal keys or the mask angle plus 180. */

export interface ComparePreset {
  id: "reveal" | "sweep-settle" | "peek" | "hold";
  label: string;
  hint: string;
  build: (durationMs: number) => CompareTrackDoc;
}

const key = (id: string, tMs: number, value: number) => ({
  id,
  tMs: Math.round(tMs),
  pose: { value },
});

export const COMPARE_PRESETS: readonly ComparePreset[] = [
  {
    id: "reveal",
    label: "Reveal the after",
    hint: "The before wipes away across the scene",
    build: (d) => ({
      keys: [key("k1", 0, 1), key("k2", d * 0.85, 0)],
      segments: [{ from: "k1", to: "k2", ease: "inOutCubic" }],
    }),
  },
  {
    id: "sweep-settle",
    label: "Sweep and settle",
    hint: "Sweeps past centre, settles at half",
    build: (d) => ({
      keys: [key("k1", 0, 1), key("k2", d * 0.55, 0.35), key("k3", d * 0.8, 0.5)],
      segments: [
        { from: "k1", to: "k2", ease: "inOutCubic" },
        { from: "k2", to: "k3", ease: "inOutQuad" },
      ],
    }),
  },
  {
    id: "peek",
    label: "Peek then commit",
    hint: "The after peeks, retreats, then takes over",
    build: (d) => ({
      keys: [
        key("k1", 0, 1),
        key("k2", d * 0.22, 0.7),
        key("k3", d * 0.4, 1),
        key("k4", d * 0.85, 0),
      ],
      segments: [
        { from: "k1", to: "k2", ease: "outCubic" },
        { from: "k2", to: "k3", ease: "inOutQuad" },
        { from: "k3", to: "k4", ease: "inOutCubic" },
      ],
    }),
  },
  {
    id: "hold",
    label: "Hold at half",
    hint: "A still 50:50 split",
    build: () => ({ keys: [key("k1", 0, 0.5)], segments: [] }),
  },
];
