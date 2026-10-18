import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as editor from "../editor/tapAnimation";
import { TAP_ANIMATION_DURATION_MS, tapDotFrame, tapProgress, tapPulseAt } from "./tapCurve";

// Recorded from the editor's own implementation before the curve moved here: the editor's outputs must not change.
const GOLDEN_FRAMES: [number, { opacity: number; scale: number }][] = [
  [0, { opacity: 0, scale: 0.4 }],
  [0.05, { opacity: 0.6333333333333334, scale: 0.8222222222222222 }],
  [0.1, { opacity: 0.8666666666666667, scale: 0.9777777777777779 }],
  [0.15, { opacity: 0.9, scale: 1 }],
  [0.3, { opacity: 0.81, scale: 1.072 }],
  [0.4, { opacity: 0.75, scale: 1.12 }],
  [0.5, { opacity: 0.69, scale: 1.072 }],
  [0.65, { opacity: 0.6, scale: 1 }],
  [0.8, { opacity: 0.3428571428571428, scale: 0.9657142857142857 }],
  [1, { opacity: 0, scale: 0.92 }],
];

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("tapCurve", () => {
  it("keeps the editor's recorded curve exactly", () => {
    for (const [p, frame] of GOLDEN_FRAMES) expect(tapDotFrame(p)).toEqual(frame);
    expect([-1, 0, 275, 550, 551].map(tapProgress)).toEqual([null, 0, 0.5, 1, null]);
  });

  it("is the curve the editor imports", () => {
    expect(editor.tapDotFrame).toBe(tapDotFrame);
    expect(editor.tapProgress).toBe(tapProgress);
    expect(editor.TAP_ANIMATION_DURATION_MS).toBe(TAP_ANIMATION_DURATION_MS);
  });

  it("samples a pulse from the elapsed time", () => {
    expect(tapPulseAt(-1)).toBeNull();
    expect(tapPulseAt(220)).toEqual(tapDotFrame(0.4));
    expect(tapPulseAt(TAP_ANIMATION_DURATION_MS + 1)).toBeNull();
  });

  it("matches the hand mirrors in the dot generator and edit.rs", () => {
    const generator = read("../../scripts/generate-tap-dot.mjs");
    expect(generator).toContain(`const TAP_ANIMATION_DURATION_MS = ${TAP_ANIMATION_DURATION_MS};`);
    for (const line of [
      "return { opacity: lerp(0, 0.9, t), scale: lerp(0.4, 1, t) };",
      "return { opacity: lerp(0.9, 0.75, t), scale: lerp(1, 1.12, t) };",
      "return { opacity: lerp(0.75, 0.6, t), scale: lerp(1.12, 1, t) };",
      "return { opacity: lerp(0.6, 0, t), scale: lerp(1, 0.92, t) };",
    ]) {
      expect(generator).toContain(line);
    }
    expect(read("../../src-tauri/src/edit.rs")).toContain(
      `const TAP_ANIMATION_DURATION_MS: f64 = ${TAP_ANIMATION_DURATION_MS}.0;`,
    );
  });
});
