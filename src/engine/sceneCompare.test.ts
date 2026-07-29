import { describe, expect, it } from "vitest";
import {
  compareSpecOf,
  compareValueAt,
  deriveCompareBDoc,
  resolveCompareFrame,
} from "./sceneCompare";
import type { SceneDoc } from "./sceneDocSchema";
import type { Resolved } from "./sceneTimeline";

const docWith = (parts: Partial<SceneDoc>): SceneDoc => ({ version: 1, ...parts }) as SceneDoc;

const compareDoc = (compare: SceneDoc["compare"]): SceneDoc =>
  docWith({
    themeId: "base-theme",
    devices: [
      { id: "d1", model: "iphone-17-pro", media: { src: "assets/before.mp4", kind: "video" } },
      { id: "d2", model: "iphone-17-pro", media: { src: "assets/before.mp4", kind: "video" } },
    ] as SceneDoc["devices"],
    compare,
  });

describe("compareSpecOf", () => {
  it("null for docs without a compare block", () => {
    expect(compareSpecOf(undefined)).toBeNull();
    expect(compareSpecOf(docWith({}))).toBeNull();
  });

  it("bakes defaults: vertical divider, hard edge, half-half", () => {
    const spec = compareSpecOf(compareDoc({}));
    expect(spec).toEqual({ angleDeg: 90, softness: 0, value: 0.5, keys: [] });
  });

  it("clamps values and sorts keys by time", () => {
    const spec = compareSpecOf(
      compareDoc({
        value: 1.7,
        track: {
          keys: [
            { id: "k2", atMs: 900, value: -0.5 },
            { id: "k1", atMs: 100, value: 0.25 },
          ],
        },
      }),
    );
    expect(spec?.value).toBe(1);
    expect(spec?.keys).toEqual([
      { atMs: 100, value: 0.25 },
      { atMs: 900, value: 0 },
    ]);
  });
});

describe("compareValueAt", () => {
  const spec = {
    angleDeg: 90,
    softness: 0,
    value: 0.5,
    keys: [
      { atMs: 200, value: 0.2 },
      { atMs: 1200, value: 0.7 },
    ],
  };

  it("clamps before the first and after the last key", () => {
    expect(compareValueAt(spec, 0)).toBe(0.2);
    expect(compareValueAt(spec, 5000)).toBe(0.7);
  });

  it("interpolates linearly between keys", () => {
    expect(compareValueAt(spec, 700)).toBeCloseTo(0.45, 10);
  });

  it("keyless specs hold the static value", () => {
    expect(compareValueAt({ ...spec, keys: [] }, 700)).toBe(0.5);
  });
});

describe("deriveCompareBDoc", () => {
  it("null without a compare block; strips the block from side B", () => {
    expect(deriveCompareBDoc(docWith({}))).toBeNull();
    const b = deriveCompareBDoc(compareDoc({}));
    expect(b).not.toBeNull();
    expect(b?.compare).toBeUndefined();
  });

  it("applies side B's theme, background, lighting and per-device media", () => {
    const b = deriveCompareBDoc(
      compareDoc({
        b: {
          themeId: "after-theme",
          background: { type: "color", color: "#123456" } as NonNullable<SceneDoc["background"]>,
          lighting: { exposure: 1.2 } as NonNullable<SceneDoc["lighting"]>,
          media: { d2: { src: "assets/after.mp4", kind: "video" } },
        },
      }),
    );
    expect(b?.themeId).toBe("after-theme");
    expect(b?.background).toEqual({ type: "color", color: "#123456" });
    expect(b?.lighting).toEqual({ exposure: 1.2 });
    expect(b?.devices?.[0].media?.src).toBe("assets/before.mp4");
    expect(b?.devices?.[1].media?.src).toBe("assets/after.mp4");
  });

  it("leaves the base doc untouched (a fresh clone)", () => {
    const base = compareDoc({ b: { media: { d1: { src: "assets/x.mp4", kind: "video" } } } });
    const before = structuredClone(base);
    deriveCompareBDoc(base);
    expect(base).toEqual(before);
  });
});

describe("resolveCompareFrame", () => {
  const spec = { angleDeg: 60, softness: 0.02, value: 0.5, keys: [] };
  const stateA = { background: { isColor: true } } as never;
  const stateB = { background: { isColor: true } } as never;

  it("resolves the active scene's spec with its side states", () => {
    const resolved: Resolved = { active: [{ index: 1, localMs: 500 }] };
    const frame = resolveCompareFrame([null, spec], [stateA, stateA], [null, stateB], resolved);
    expect(frame).toEqual({
      index: 1,
      value: 0.5,
      angleDeg: 60,
      softness: 0.02,
      stateA,
      stateB,
    });
  });

  it("null for plain scenes and for transition frames (two active scenes)", () => {
    const solo: Resolved = { active: [{ index: 0, localMs: 0 }] };
    expect(resolveCompareFrame([null, spec], null, null, solo)).toBeNull();
    const transition: Resolved = {
      active: [
        { index: 0, localMs: 900 },
        { index: 1, localMs: 100 },
      ],
    };
    expect(resolveCompareFrame([null, spec], null, null, transition)).toBeNull();
  });
});
