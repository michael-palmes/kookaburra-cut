import { describe, expect, it } from "vitest";
import { parseTextAnimationSpec } from "../theme/schema";
import type { Theme } from "../theme/tokens";
import { resolveTextAnimation, TEXT_PRESET_NAMES } from "../toolkit/text/presets";
import {
  DELIVERY_DEFAULT_MS,
  DELIVERY_OPTIONS,
  defaultDraft,
  describeSpec,
  draftToSpec,
  specToDraft,
  TEXT_PRESET_CATALOG,
} from "./textAnimationOptions";

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

describe("TEXT_PRESET_CATALOG (the vocabulary pin)", () => {
  it("covers TEXT_PRESET_NAMES exactly, in order", () => {
    expect(TEXT_PRESET_CATALOG.map((m) => m.preset)).toEqual([...TEXT_PRESET_NAMES]);
  });

  it("pins the param capabilities", () => {
    const byName = Object.fromEntries(TEXT_PRESET_CATALOG.map((m) => [m.preset, m]));
    expect(byName["fade-scale"].hasScaleParams).toBe(true);
    expect(byName["twist-scale"].hasDirection).toBe(true);
    expect(byName["scatter-scale"].perCharacter).toBe(true);
  });
});

describe("draftToSpec (the written sidecar shapes)", () => {
  it("every preset × delivery round-trips the shared parser IDENTICALLY", () => {
    for (const meta of TEXT_PRESET_CATALOG) {
      for (const d of DELIVERY_OPTIONS) {
        const spec = draftToSpec({ ...defaultDraft(meta.preset), delivery: d.id });
        expect(parseTextAnimationSpec(spec, "pin")).toEqual(spec);
      }
    }
  });

  it("params round-trip the parser (startScale, shine, direction, explicit ms)", () => {
    const spec = draftToSpec({
      ...defaultDraft("fade-scale"),
      delivery: "word",
      staggerMs: 120,
      startScale: 1.15,
      shine: true,
    });
    expect(spec).toEqual({
      in: "fade-scale",
      out: "none",
      staggerMs: 120,
      stagger: "word",
      startScale: 1.15,
      shine: true,
    });
    expect(parseTextAnimationSpec(spec, "pin")).toEqual(spec);
    const twist = draftToSpec({ ...defaultDraft("twist-scale"), direction: "from-right" });
    expect(twist.direction).toBe("from-right");
    expect(parseTextAnimationSpec(twist, "pin")).toEqual(twist);
  });

  it("word/char deliveries always write a NON-ZERO staggerMs (stagger needs it at resolve)", () => {
    for (const id of ["word", "char"] as const) {
      const spec = draftToSpec({ ...defaultDraft("fade"), delivery: id });
      expect(spec.staggerMs).toBe(DELIVERY_DEFAULT_MS[id]);
      expect(spec.staggerMs).toBeGreaterThan(0);
      const anim = resolveTextAnimation({}, theme, spec);
      expect(anim?.granularity).toBe(id);
    }
  });

  it("paragraph deliveries resolve to their granularities; all-at-once forces block", () => {
    const para = draftToSpec({ ...defaultDraft("fade"), delivery: "by-paragraph" });
    expect(resolveTextAnimation({}, theme, para)?.granularity).toBe("paragraph");
    const block = draftToSpec({ ...defaultDraft("scatter-scale"), delivery: "all-at-once" });
    expect(resolveTextAnimation({}, theme, block)?.granularity).toBeNull();
  });
});

describe("specToDraft (seeding)", () => {
  it("round-trips every preset × delivery draft", () => {
    for (const meta of TEXT_PRESET_CATALOG) {
      for (const d of DELIVERY_OPTIONS) {
        const draft = { ...defaultDraft(meta.preset), delivery: d.id };
        expect(specToDraft(draftToSpec(draft))).toEqual(draft);
      }
    }
  });

  it("keeps a custom ms and coerces unknown presets like the resolver", () => {
    const draft = specToDraft({ in: "wobble", out: "none", staggerMs: 42, stagger: "word" });
    expect(draft.preset).toBe("fade");
    expect(draft.staggerMs).toBe(42);
    expect(draft.delivery).toBe("word");
  });
});

describe("describeSpec", () => {
  it("names the theme default for the chip hint", () => {
    expect(describeSpec(undefined)).toBe("No preset motion");
    expect(describeSpec({ in: "fade-up", out: "none", staggerMs: 60, stagger: "word" })).toBe(
      "Fade up · By word",
    );
    expect(describeSpec({ in: "fade", out: "none", staggerMs: 0, delivery: "all-at-once" })).toBe(
      "Fade",
    );
  });
});
