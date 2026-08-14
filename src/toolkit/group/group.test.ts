import { describe, expect, it } from "vitest";
import type { Theme } from "../../theme/tokens";
import { SHINE_AXIS, SHINE_HALF_W, shineBand } from "../text/presets";
import { foldBandToChild, type GroupAnimationState, groupImageEffects } from "./context";
import {
  DEFAULT_GROUP_EM,
  DEFAULT_GROUP_EXTENT,
  groupShineBand,
  resolveGroupAnimation,
} from "./groupAnimation";

const baseTheme: Theme = {
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

describe("resolveGroupAnimation", () => {
  it("returns null when nothing is configured (a plain positioned group)", () => {
    expect(resolveGroupAnimation({}, baseTheme)).toBeNull();
  });

  it("forces granularity null even when the theme configures stagger", () => {
    const themed: Theme = {
      ...baseTheme,
      textAnimation: { in: "fade-up", out: "fade", staggerMs: 60, stagger: "word" },
    };
    const anim = resolveGroupAnimation({}, themed);
    expect(anim?.preset).toBe("fade-up");
    expect(anim?.granularity).toBeNull();
  });

  it("forces granularity null for delivery spellings and scatter-scale's char default", () => {
    expect(
      resolveGroupAnimation({ preset: "twist-scale", delivery: "by-paragraph" }, baseTheme)
        ?.granularity,
    ).toBeNull();
    expect(resolveGroupAnimation({ preset: "scatter-scale" }, baseTheme)?.granularity).toBeNull();
  });

  it("keeps the shared resolution semantics (params, sidecar spec)", () => {
    const anim = resolveGroupAnimation({ shine: true }, baseTheme, {
      textAnimation: { in: "fade-scale", out: "none", staggerMs: 0, startScale: 1.15 },
    });
    expect(anim?.preset).toBe("fade-scale");
    expect(anim?.params.startScale).toBe(1.15);
    expect(anim?.params.shine).toBe(true);
  });

  it("honours the sidecar force flag — TSX animation props are ignored (v11 · M6)", () => {
    const doc = {
      textAnimation: { in: "fade-up" as const, out: "none", staggerMs: 0 },
      textAnimationForce: true,
    };
    const anim = resolveGroupAnimation({ preset: "twist-scale", shine: true }, baseTheme, doc);
    expect(anim?.preset).toBe("fade-up");
    expect(anim?.params.shine).toBe(false);
  });

  it("can preserve a coded group reveal independently of scene motion", () => {
    const props = { preset: "fade-scale" as const, startScale: 0.9, shine: true };
    const doc = {
      textAnimation: {
        in: "slide" as const,
        out: "fade" as const,
        staggerMs: 0,
        durationMs: 1450,
      },
    };

    expect(resolveGroupAnimation(props, baseTheme, doc)?.durationMs).toBe(1450);
    expect(resolveGroupAnimation(props, baseTheme, doc, undefined, true)).toEqual(
      resolveGroupAnimation(props, baseTheme),
    );
  });
});

describe("groupShineBand", () => {
  it("is the M3 band over the extent rect centred on the origin", () => {
    expect(groupShineBand(DEFAULT_GROUP_EXTENT, 0.5)).toEqual(
      shineBand([-2, -1.125, 2, 1.125], 0.5),
    );
  });

  it("parks off (null) while shineU is the off-sentinel", () => {
    expect(groupShineBand(DEFAULT_GROUP_EXTENT, -1)).toBeNull();
  });

  it("sits at the extent's projected centre at u = 0.5 (symmetric rect → 0)", () => {
    const band = groupShineBand([4, 2.25], 0.5);
    expect(band).not.toBeNull();
    expect(band?.centerS).toBeCloseTo(0, 12);
  });

  it("pins the band width to the projected extent (SHINE_HALF_W is contract)", () => {
    const [w, h] = DEFAULT_GROUP_EXTENT;
    // Projected span of the rect on the 45° axis: (w + h) / √2.
    const span = (w + h) * Math.SQRT1_2;
    const band = groupShineBand(DEFAULT_GROUP_EXTENT, 0.5);
    expect(band?.invHalfWidthS).toBeCloseTo(1 / (SHINE_HALF_W * span), 12);
  });
});

describe("foldBandToChild", () => {
  const state: GroupAnimationState = {
    alpha: 0.5,
    band: { centerS: 1.25, invHalfWidthS: 2 },
    shineCapable: true,
  };

  it("returns null outside groups and when the band is parked", () => {
    expect(foldBandToChild(null, [1, 2, 3])).toBeNull();
    expect(foldBandToChild({ ...state, band: null }, [1, 2, 3])).toBeNull();
  });

  it("shifts the centre by the child's offset projected on the sweep axis", () => {
    const folded = foldBandToChild(state, [1, -0.5, 0]);
    expect(folded?.centerS).toBeCloseTo(1.25 - (1 * SHINE_AXIS[0] + -0.5 * SHINE_AXIS[1]), 12);
    expect(folded?.invHalfWidthS).toBe(2);
  });

  it("ignores z and leaves a centred child's band untouched", () => {
    expect(foldBandToChild(state, [0, 0, 5])).toEqual(state.band);
  });
});

describe("groupImageEffects", () => {
  it("keeps ordinary groups on the stock material", () => {
    expect(groupImageEffects(null, 1, 1)).toBeNull();
    expect(groupImageEffects({ alpha: 1, band: null, shineCapable: false }, 1, 1)).toBeNull();
  });

  it("maps blur and a partial mask to deterministic texture-space uniforms", () => {
    expect(
      groupImageEffects(
        {
          alpha: 1,
          band: null,
          shineCapable: false,
          imageEffectsCapable: true,
          imageBlurWorld: 0.1,
          imageSweep: [0, 0.5],
        },
        2,
        1,
      ),
    ).toEqual({
      blur: [0.05, 0.1, 1, 0],
      mask: [0, 0.5, 1 / 512, 1],
    });
  });

  it("disables the mask branch for a full reveal", () => {
    expect(
      groupImageEffects(
        {
          alpha: 1,
          band: null,
          shineCapable: false,
          imageEffectsCapable: true,
          imageSweep: [0, 1],
        },
        1,
        1,
      )?.mask[3],
    ).toBe(0);
  });
});

describe("group defaults", () => {
  it("pins the em and extent defaults (export contract once M5 gates)", () => {
    expect(DEFAULT_GROUP_EM).toBe(0.6);
    expect(DEFAULT_GROUP_EXTENT).toEqual([4, 2.25]);
  });
});
