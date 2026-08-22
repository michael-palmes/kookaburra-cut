import { describe, expect, it } from "vitest";
import type { Theme } from "../theme/tokens";
import { COMPARE_MASK_CATALOG } from "./compareCatalog";
import {
  COMPARE_MASK_ID,
  type CompareSpec,
  compareCoverageAt,
  compareSampleAt,
  compareSpecOf,
  compareValueAt,
  deriveCompareBDoc,
  hexToSrgb,
  resolveCompareFrame,
} from "./sceneCompare";
import type { SceneDoc } from "./sceneDocSchema";
import type { Resolved } from "./sceneTimeline";

const docWith = (parts: Partial<SceneDoc>): SceneDoc => ({ version: 1, ...parts }) as SceneDoc;

const fakeTheme = {
  colors: { background: "#101010", text: "#eeeeee", accent: "#ff5a36", muted: "#808080" },
} as Theme;

const compareDoc = (compare: SceneDoc["compare"]): SceneDoc =>
  docWith({
    themeId: "base-theme",
    devices: [
      {
        id: "d1",
        model: "iphone-17-pro",
        colour: "silver",
        shadow: "soft",
        media: { src: "assets/before.mp4", kind: "video" },
      },
      {
        id: "d2",
        model: "iphone-17-pro",
        colour: "graphite",
        shadow: "long",
        media: { src: "assets/before.mp4", kind: "video" },
      },
    ] as SceneDoc["devices"],
    compare,
  });

const specWith = (parts: Partial<CompareSpec>): CompareSpec => ({
  maskType: "linear",
  angleDeg: 90,
  softness: 0,
  center: [0.5, 0.5],
  value: 0.5,
  keys: [],
  segments: [],
  chrome: {
    lineWidth: 0,
    lineColor: "#ffffff",
    lineSoftness: 0,
    gripSize: 0,
    chips: false,
    tintA: null,
    tintB: null,
    tintAmount: 0,
  },
  ...parts,
});

/** A spec key at the static angle unless the case pins its own. */
const specKey = (tMs: number, value: number, angleDeg = 90) => ({ tMs, value, angleDeg });

const specSegment = (
  from: ReturnType<typeof specKey>,
  to: ReturnType<typeof specKey>,
  ease = "linear",
) => ({
  fromTMs: from.tMs,
  fromValue: from.value,
  fromAngleDeg: from.angleDeg,
  toTMs: to.tMs,
  toValue: to.value,
  toAngleDeg: to.angleDeg,
  ease,
});

describe("compareSpecOf", () => {
  it("null for docs without a compare block", () => {
    expect(compareSpecOf(undefined)).toBeNull();
    expect(compareSpecOf(docWith({}))).toBeNull();
  });

  it("bakes defaults: a hard vertical linear divider at half, chrome off", () => {
    const spec = compareSpecOf(compareDoc({}));
    expect(spec?.maskType).toBe("linear");
    expect(spec?.angleDeg).toBe(90);
    expect(spec?.softness).toBe(0);
    expect(spec?.center).toEqual([0.5, 0.5]);
    expect(spec?.value).toBe(0.5);
    expect(spec?.keys).toEqual([]);
    expect(spec?.segments).toEqual([]);
    expect(spec?.chrome).toEqual({
      lineWidth: 0,
      lineColor: "#6f93a8",
      lineSoftness: 0,
      gripSize: 0,
      chips: false,
      tintA: null,
      tintB: null,
      tintAmount: 0,
    });
  });

  it("clamps values and sorts keys by time", () => {
    const spec = compareSpecOf(
      compareDoc({
        value: 1.7,
        track: {
          keys: [
            { id: "k2", tMs: 900, pose: { value: -0.5 } },
            { id: "k1", tMs: 100, pose: { value: 0.25 } },
          ],
          segments: [{ from: "k1", to: "k2", ease: "linear" }],
        },
      }),
    );
    expect(spec?.value).toBe(1);
    expect(spec?.keys).toEqual([specKey(100, 0.25), specKey(900, 0)]);
    expect(spec?.segments).toEqual([specSegment(specKey(100, 0.25), specKey(900, 0))]);
  });

  it("resolves each key's EFFECTIVE angle: its own, else the mask's, else 90", () => {
    const track = {
      keys: [
        { id: "k1", tMs: 0, pose: { value: 1 } },
        { id: "k2", tMs: 800, pose: { value: 0, angleDeg: 135 } },
      ],
      segments: [{ from: "k1", to: "k2", ease: "linear" }],
    };
    const plain = compareSpecOf(compareDoc({ track }));
    expect(plain?.angleDeg).toBe(90);
    expect(plain?.keys.map((k) => k.angleDeg)).toEqual([90, 135]);
    expect(plain?.segments[0].fromAngleDeg).toBe(90);
    expect(plain?.segments[0].toAngleDeg).toBe(135);

    const angled = compareSpecOf(compareDoc({ mask: { type: "linear", angleDeg: 20 }, track }));
    expect(angled?.keys.map((k) => k.angleDeg)).toEqual([20, 135]);
    expect(angled?.segments[0].fromAngleDeg).toBe(20);
  });

  it("resolves chrome tokens against the theme, falling back to the accent", () => {
    const spec = compareSpecOf(
      compareDoc({
        chrome: {
          line: { colour: "muted" },
          grip: true,
          chips: true,
          tint: { a: "accent", b: "nonsense" },
        },
      }),
      fakeTheme,
    );
    expect(spec?.chrome.lineWidth).toBe(4);
    expect(spec?.chrome.lineColor).toBe("#808080");
    expect(spec?.chrome.gripSize).toBe(1);
    expect(spec?.chrome.chips).toBe(true);
    expect(spec?.chrome.tintA).toBe("#ff5a36");
    expect(spec?.chrome.tintB).toBe("#ff5a36");
    expect(spec?.chrome.tintAmount).toBeCloseTo(0.08, 10);
  });
});

describe("compareValueAt", () => {
  const spec = specWith({
    keys: [specKey(200, 0.2), specKey(1200, 0.7)],
    segments: [specSegment(specKey(200, 0.2), specKey(1200, 0.7))],
  });

  it("holds the boundary keys outside the segment span", () => {
    expect(compareValueAt(spec, 0)).toBe(0.2);
    expect(compareValueAt(spec, 5000)).toBe(0.7);
  });

  it("interpolates through the segment's ease", () => {
    expect(compareValueAt(spec, 700)).toBeCloseTo(0.45, 10);
    const eased = specWith({
      keys: spec.keys,
      segments: [{ ...spec.segments[0], ease: "inOutQuad" }],
    });
    expect(compareValueAt(eased, 700)).toBeCloseTo(0.45, 10);
    expect(compareValueAt(eased, 450)).toBeCloseTo(0.2 + 0.5 * 2 * 0.25 * 0.25, 10);
  });

  it("keys without a segment HOLD the latest key (no interpolation)", () => {
    const holdy = specWith({ keys: spec.keys });
    expect(compareValueAt(holdy, 700)).toBe(0.2);
    expect(compareValueAt(holdy, 1300)).toBe(0.7);
  });

  it("keyless specs hold the static value", () => {
    expect(compareValueAt(specWith({}), 700)).toBe(0.5);
  });
});

describe("compareSampleAt (the angle rides the same keys)", () => {
  const angled = specWith({
    angleDeg: 90,
    keys: [specKey(200, 0.2, 40), specKey(1200, 0.7, 140)],
    segments: [specSegment(specKey(200, 0.2, 40), specKey(1200, 0.7, 140))],
  });

  it("eases the angle with the value, off the SAME segment", () => {
    const mid = compareSampleAt(angled, 700);
    expect(mid.value).toBeCloseTo(0.45, 10);
    expect(mid.angleDeg).toBeCloseTo(90, 10);
    const eased = specWith({
      keys: angled.keys,
      segments: [{ ...angled.segments[0], ease: "inOutQuad" }],
    });
    const at450 = compareSampleAt(eased, 450);
    const e = 2 * 0.25 * 0.25;
    expect(at450.value).toBeCloseTo(0.2 + 0.5 * e, 10);
    expect(at450.angleDeg).toBeCloseTo(40 + 100 * e, 10);
  });

  it("holds the latest key's angle outside the segments, both ends", () => {
    expect(compareSampleAt(angled, 0).angleDeg).toBe(40);
    expect(compareSampleAt(angled, 5000).angleDeg).toBe(140);
    const holdy = specWith({ keys: angled.keys });
    expect(compareSampleAt(holdy, 700).angleDeg).toBe(40);
    expect(compareSampleAt(holdy, 1300).angleDeg).toBe(140);
  });

  it("keyless specs hold the static angle", () => {
    expect(compareSampleAt(specWith({ angleDeg: 33 }), 700)).toEqual({ value: 0.5, angleDeg: 33 });
  });

  it("interpolates numerically, never the shortest way round", () => {
    const wrap = specWith({
      keys: [specKey(0, 0, 350), specKey(1000, 1, 10)],
      segments: [specSegment(specKey(0, 0, 350), specKey(1000, 1, 10))],
    });
    expect(compareSampleAt(wrap, 500).angleDeg).toBeCloseTo(180, 10);
  });

  it("THE NULL PROOF: keys without an angle sample exactly the static angle", () => {
    const doc = compareDoc({
      mask: { type: "linear", angleDeg: 37.5 },
      track: {
        keys: [
          { id: "k1", tMs: 0, pose: { value: 1 } },
          { id: "k2", tMs: 900, pose: { value: 0 } },
        ],
        segments: [{ from: "k1", to: "k2", ease: "inOutCubic" }],
      },
    });
    const spec = compareSpecOf(doc);
    if (!spec) throw new Error("expected a spec");
    for (const t of [-100, 0, 1, 123, 450, 899, 900, 5000]) {
      const sample = compareSampleAt(spec, t);
      expect(sample.angleDeg).toBe(37.5);
      expect(sample.value).toBe(compareValueAt(spec, t));
    }
  });
});

describe("compareCoverageAt (the chips' fade)", () => {
  it("a vertical divider at half: full A on the left, full B on the right", () => {
    const spec = specWith({});
    expect(compareCoverageAt(spec, 0.5, 90, [0.2, 0.5], 16 / 9, "a")).toBe(1);
    expect(compareCoverageAt(spec, 0.5, 90, [0.2, 0.5], 16 / 9, "b")).toBe(0);
    expect(compareCoverageAt(spec, 0.5, 90, [0.8, 0.5], 16 / 9, "a")).toBe(0);
    expect(compareCoverageAt(spec, 0.5, 90, [0.8, 0.5], 16 / 9, "b")).toBe(1);
  });

  it("takes the SAMPLED angle, not the spec's static one", () => {
    const spec = specWith({});
    // Rotated a quarter turn the sweep runs downwards, so A takes the top half instead of the left.
    expect(compareCoverageAt(spec, 0.5, 0, [0.5, 0.8], 16 / 9, "a")).toBe(1);
    expect(compareCoverageAt(spec, 0.5, 0, [0.5, 0.2], 16 / 9, "a")).toBe(0);
    expect(compareCoverageAt(spec, 0.5, 0, [0.2, 0.5], 16 / 9, "a")).toBeCloseTo(0.5, 10);
  });

  it("a circle window: B inside the centre, A far outside", () => {
    const spec = specWith({ maskType: "circle" });
    expect(compareCoverageAt(spec, 0.4, 90, [0.5, 0.5], 16 / 9, "b")).toBe(1);
    expect(compareCoverageAt(spec, 0.4, 90, [0.02, 0.02], 16 / 9, "a")).toBe(1);
  });

  it("blend coverage is the divider value itself", () => {
    const spec = specWith({ maskType: "blend" });
    expect(compareCoverageAt(spec, 0.3, 90, [0.5, 0.5], 16 / 9, "a")).toBeCloseTo(0.7, 10);
    expect(compareCoverageAt(spec, 0.3, 90, [0.5, 0.5], 16 / 9, "b")).toBeCloseTo(0.3, 10);
  });
});

describe("hexToSrgb", () => {
  it("parses hex to display components; malformed falls back to grey", () => {
    expect(hexToSrgb("#ff0080")).toEqual([1, 0, 128 / 255]);
    expect(hexToSrgb("nonsense")).toEqual([0.5, 0.5, 0.5]);
  });
});

describe("deriveCompareBDoc", () => {
  it("null without a compare block; side B keeps the block (host chrome reads it)", () => {
    expect(deriveCompareBDoc(docWith({}))).toBeNull();
    const b = deriveCompareBDoc(compareDoc({}));
    expect(b).not.toBeNull();
    expect(b?.compare).toBeDefined();
  });

  it("applies side B's theme, staging, lighting, media and narrow device appearance", () => {
    const b = deriveCompareBDoc(
      compareDoc({
        b: {
          themeId: "after-theme",
          background: { type: "color", color: "#123456" } as NonNullable<SceneDoc["background"]>,
          backdrop: { type: "floor", color: "#654321" },
          lighting: { exposure: 1.2 } as NonNullable<SceneDoc["lighting"]>,
          media: { d2: { src: "assets/after.mp4", kind: "video" } },
          deviceAppearance: {
            d1: { colour: "blue", shadow: "none" },
            missing: { colour: "ignored" },
          },
        },
      }),
    );
    expect(b?.themeId).toBe("after-theme");
    expect(b?.background).toEqual({ type: "color", color: "#123456" });
    expect(b?.backdrop).toEqual({ type: "floor", color: "#654321" });
    expect(b?.lighting).toEqual({ exposure: 1.2 });
    expect(b?.devices?.[0].media?.src).toBe("assets/before.mp4");
    expect(b?.devices?.[1].media?.src).toBe("assets/after.mp4");
    expect(b?.devices?.[0]).toMatchObject({ colour: "blue", shadow: "none" });
    expect(b?.devices?.[1]).toMatchObject({ colour: "graphite", shadow: "long" });
  });

  it("leaves the base doc untouched (a fresh clone)", () => {
    const base = compareDoc({ b: { media: { d1: { src: "assets/x.mp4", kind: "video" } } } });
    const before = structuredClone(base);
    deriveCompareBDoc(base);
    expect(base).toEqual(before);
  });

  it("inherits scene images without aliasing them or adding side-specific overrides", () => {
    const base = compareDoc({});
    base.images = [
      {
        id: "hero",
        src: "assets/hero.png",
        host: "stage",
        stage: { position: [0, 0, 0], size: 1.5, rotationDeg: [0, 12, 0] },
        overlay: {
          position: [0.5, -0.5],
          size: 0.2,
          rotationDeg: 4,
          shape: "none",
          layer: "above",
        },
      },
    ];

    const b = deriveCompareBDoc(base);

    expect(b?.images).toEqual(base.images);
    expect(b?.images).not.toBe(base.images);
    expect(b?.images?.[0]).not.toBe(base.images[0]);
  });

  it("inherits managed project-image icons without aliasing the managed block", () => {
    const base = compareDoc({});
    base.managedText = {
      items: [{ key: "mark", type: "icon", icon: "assets/managed-mark.png" }],
    };

    const b = deriveCompareBDoc(base);

    expect(b?.managedText).toEqual(base.managedText);
    expect(b?.managedText).not.toBe(base.managedText);
    expect(b?.managedText?.items[0]).not.toBe(base.managedText.items[0]);
    expect(b?.managedText?.items[0]?.icon).toBe("assets/managed-mark.png");
  });
});

describe("resolveCompareFrame", () => {
  const spec = specWith({ angleDeg: 60, softness: 0.02 });
  const stateA = { background: { isColor: true } } as never;
  const stateB = { background: { isColor: true } } as never;

  it("resolves the active scene's spec with its side states", () => {
    const resolved: Resolved = { active: [{ index: 1, localMs: 500 }] };
    const frames = resolveCompareFrame([null, spec], [stateA, stateA], [null, stateB], resolved);
    expect(frames).toEqual([{ index: 1, value: 0.5, angleDeg: 60, spec, stateA, stateB }]);
  });

  it("empty for plain scenes; transition frames resolve each comparing side at its own local time", () => {
    const solo: Resolved = { active: [{ index: 0, localMs: 0 }] };
    expect(resolveCompareFrame([null, spec], null, null, solo)).toEqual([]);
    const transition: Resolved = {
      active: [
        { index: 0, localMs: 900 },
        { index: 1, localMs: 100 },
      ],
    };
    const frames = resolveCompareFrame([null, spec], null, null, transition);
    expect(frames).toHaveLength(1);
    expect(frames[0].index).toBe(1);
    expect(frames[0].value).toBe(0.5);
    const both = resolveCompareFrame([spec, spec], null, null, transition);
    expect(both.map((f) => f.index)).toEqual([0, 1]);
  });

  it("carries the sampled angle to the compositor, not the spec's static one", () => {
    const keyed = specWith({
      angleDeg: 90,
      keys: [specKey(0, 1, 0), specKey(1000, 0, 180)],
      segments: [specSegment(specKey(0, 1, 0), specKey(1000, 0, 180))],
    });
    const resolved: Resolved = { active: [{ index: 0, localMs: 250 }] };
    const [frame] = resolveCompareFrame([keyed], null, null, resolved);
    expect(frame.angleDeg).toBeCloseTo(45, 10);
    expect(frame.value).toBeCloseTo(0.75, 10);
  });
});

describe("compare mask catalogue (structure pin)", () => {
  it("one entry per mask type, ids matching the shader dispatch", () => {
    expect(COMPARE_MASK_CATALOG.map((e) => e.id)).toEqual(Object.keys(COMPARE_MASK_ID));
    for (const entry of COMPARE_MASK_CATALOG) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.hint.length).toBeGreaterThan(0);
    }
  });

  it("only the slider takes an angle and a grip; windows take a centre", () => {
    const byId = new Map(COMPARE_MASK_CATALOG.map((e) => [e.id, e]));
    expect(byId.get("linear")?.needsAngle).toBe(true);
    expect(byId.get("linear")?.hasGrip).toBe(true);
    expect(byId.get("circle")?.needsCenter).toBe(true);
    expect(byId.get("radial")?.needsCenter).toBe(true);
    expect(byId.get("blend")?.needsAngle).toBe(false);
    expect(byId.get("blend")?.hasLine).toBe(false);
  });
});
