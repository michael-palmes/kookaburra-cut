import { describe, expect, it } from "vitest";
import {
  DEVICE_SHADOW_MODES,
  deviceShadowSlabs,
  type ShadowPose,
  shadowLightDirection,
  shadowPenumbra,
  shadowPlane,
  shadowQuad,
  shadowSweepDirection,
  slabSilhouetteHalf,
} from "./shadowProjector";

// Catalog literals rather than DEVICE_CATALOG: the catalog drags three and the glb asset imports
// into a node test env, and the projector only ever reads these four fields.
const PHONE = {
  layoutWidth: 1.25,
  fittedHeight: 2.6,
  shadow: { thickness: 0.184, radius: 0.204 },
};
const LAPTOP = {
  layoutWidth: 3.4,
  fittedHeight: 2.3047930262049396,
  shadow: {
    thickness: 0.162,
    radius: 0.076,
    base: { depth: 2.309, y: -1.071, z: 0.458 },
    lid: { length: 2.424, thickness: 0.051, hingeY: -1.113, hingeZ: -0.697 },
  },
  lid: { node: "DISPLAY001", openDeg: 110, defaultDeg: 90 },
};

const REST: ShadowPose = {
  scale: 1,
  rotation: [0, 0, 0],
  offset: [0, 0, 0],
  introScale: 1,
  lidDeg: 90,
};

describe("deviceShadowSlabs", () => {
  it("gives a handset one upright slab of its own footprint", () => {
    const [slab, ...rest] = deviceShadowSlabs(PHONE, REST);
    expect(rest).toEqual([]);
    expect(slab.half).toEqual([1.25 / 2, 2.6 / 2]);
    expect(slab.u).toEqual([1, 0, 0]);
    expect(slab.v).toEqual([0, 1, 0]);
    expect(slab.thickness).toBeCloseTo(0.184, 12);
  });

  it("scales the silhouette with the placement and intro scale", () => {
    const [slab] = deviceShadowSlabs(PHONE, { ...REST, scale: 2, introScale: 0.5 });
    expect(slab.half).toEqual([1.25 / 2, 2.6 / 2]);
    const [big] = deviceShadowSlabs(PHONE, { ...REST, scale: 2 });
    expect(big.half).toEqual([1.25, 2.6]);
    expect(big.radius).toBeCloseTo(0.408, 12);
  });

  it("never rounds a slab past its own half extent", () => {
    const stubby = { ...PHONE, shadow: { thickness: 0.1, radius: 99 } };
    const [slab] = deviceShadowSlabs(stubby, REST);
    expect(slab.radius).toBeCloseTo(1.25 / 2, 12);
  });

  it("yaws the silhouette with the device, so a spun phone casts a narrower shadow", () => {
    const [slab] = deviceShadowSlabs(PHONE, { ...REST, rotation: [0, Math.PI / 2, 0] });
    expect(slab.u[0]).toBeCloseTo(0, 12);
    expect(slab.u[2]).toBeCloseTo(-1, 12);
    expect(slab.n[0]).toBeCloseTo(1, 12);
  });

  it("lifts the silhouette by the float offset", () => {
    const [slab] = deviceShadowSlabs(PHONE, { ...REST, offset: [0, 0.4, 0] });
    expect(slab.center).toEqual([0, 0.4, 0]);
  });

  it("gives a laptop a flat base plus its hinged lid", () => {
    const slabs = deviceShadowSlabs(LAPTOP, REST);
    expect(slabs).toHaveLength(2);
    const [base] = slabs;
    // Flat on the floor: its normal is vertical and its +v runs along the desk.
    expect(Math.abs(base.n[1])).toBeCloseTo(1, 12);
    expect(base.v[1]).toBeCloseTo(0, 12);
    expect(base.half).toEqual([1.7, 2.309 / 2]);
  });

  it("swings the lid from closed through upright to the authored lean", () => {
    const closed = deviceShadowSlabs(LAPTOP, { ...REST, lidDeg: 0 })[1];
    const upright = deviceShadowSlabs(LAPTOP, { ...REST, lidDeg: 90 })[1];
    const leaning = deviceShadowSlabs(LAPTOP, { ...REST, lidDeg: 110 })[1];
    // Closed lies flat over the base, forward of the hinge.
    expect(closed.center[1]).toBeCloseTo(-1.113, 12);
    expect(closed.center[2]).toBeGreaterThan(-0.697);
    // Upright stands the lid over the hinge.
    expect(upright.center[1]).toBeCloseTo(-1.113 + 2.424 / 2, 12);
    expect(upright.center[2]).toBeCloseTo(-0.697, 12);
    // The authored 110 leans it back past the hinge.
    expect(leaning.center[2]).toBeLessThan(-0.697);
    expect(leaning.center[1]).toBeLessThan(upright.center[1]);
  });

  it("clamps the lid angle to the model's authored range", () => {
    const past = deviceShadowSlabs(LAPTOP, { ...REST, lidDeg: 400 })[1];
    const authored = deviceShadowSlabs(LAPTOP, { ...REST, lidDeg: 110 })[1];
    expect(past.center).toEqual(authored.center);
  });
});

describe("slabSilhouetteHalf", () => {
  it("leaves the outline alone when the light is dead on the slab's face", () => {
    const [slab] = deviceShadowSlabs(PHONE, REST);
    expect(slabSilhouetteHalf(slab, [0, 0, 1])).toEqual([1.25 / 2, 2.6 / 2]);
  });

  it("grows the outline by the thickness as the light rakes across it", () => {
    const [slab] = deviceShadowSlabs(PHONE, REST);
    const raking = slabSilhouetteHalf(slab, [Math.SQRT1_2, 0, Math.SQRT1_2]);
    expect(raking[0]).toBeCloseTo(1.25 / 2 + 0.184 / 2, 12);
    expect(raking[1]).toBeCloseTo(2.6 / 2, 12);
  });
});

describe("shadowSweepDirection", () => {
  it("runs away from the key light on the floor", () => {
    const mode = DEVICE_SHADOW_MODES.soft;
    const plane = shadowPlane(mode, -1.3, 1);
    const sweep = shadowSweepDirection(plane, shadowLightDirection(mode));
    // The key sits front-right, so the cast falls back-left: -x in the plane, +y (which is world -z).
    expect(sweep[0]).toBeLessThan(0);
    expect(sweep[1]).toBeGreaterThan(0);
    expect(Math.hypot(...sweep)).toBeCloseTo(1, 12);
  });

  it("keeps the sun sweep pointing down-right on the plane behind", () => {
    const mode = DEVICE_SHADOW_MODES.sun;
    const plane = shadowPlane(mode, -1.3, 1);
    const sweep = shadowSweepDirection(plane, shadowLightDirection(mode));
    expect(sweep[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(sweep[1]).toBeCloseTo(-Math.SQRT1_2, 6);
  });
});

describe("shadowQuad", () => {
  const quadFor = (
    spec: typeof PHONE | typeof LAPTOP,
    mode: keyof typeof DEVICE_SHADOW_MODES,
    pose: ShadowPose = REST,
  ) => {
    const modeSpec = DEVICE_SHADOW_MODES[mode];
    const slabs = deviceShadowSlabs(spec, pose);
    const plane = shadowPlane(modeSpec, -spec.fittedHeight / 2, pose.scale);
    const light = shadowLightDirection(modeSpec);
    const quad = shadowQuad(slabs, plane, light, modeSpec, pose.scale * pose.introScale);
    if (!quad) throw new Error("no quad");
    return quad;
  };

  it("sizes the quad from the device, not a fixed footprint", () => {
    // The regression this whole projector exists for: the two devices' casts have genuinely
    // different proportions, a laptop's wide and shallow, a phone's narrow and long.
    const phone = quadFor(PHONE, "soft");
    const laptop = quadFor(LAPTOP, "soft");
    expect(laptop.size[0]).toBeGreaterThan(phone.size[0] * 1.5);
    // The laptop's base occupies real floor depth; an upright phone's footprint is a sliver.
    expect(laptop.size[1]).toBeGreaterThan(phone.size[1] * 1.5);
  });

  it("narrows a phone's cast when it spins side-on", () => {
    const flat = quadFor(PHONE, "soft");
    const edge = quadFor(PHONE, "soft", { ...REST, rotation: [0, Math.PI / 2, 0] });
    expect(edge.size[0]).toBeLessThan(flat.size[0]);
  });

  it("slides the cast away from the light as the device floats", () => {
    // Parallel rays translate the outline rigidly, so a lift shows up as a shift here
    // and as a wider penumbra in the shader (see shadowPenumbra).
    const grounded = quadFor(PHONE, "soft");
    const lifted = quadFor(PHONE, "soft", { ...REST, offset: [0, 0.5, 0] });
    expect(lifted.centre[0]).toBeLessThan(grounded.centre[0]);
    expect(lifted.centre[1]).toBeGreaterThan(grounded.centre[1]);
  });

  it("throws the long mode much further than the soft one", () => {
    const soft = quadFor(PHONE, "soft");
    const long = quadFor(PHONE, "long");
    expect(long.size[1]).toBeGreaterThan(soft.size[1] * 2);
  });

  it("pads the quad by the penumbra a high float reaches", () => {
    const grounded = quadFor(PHONE, "soft");
    const high = quadFor(PHONE, "soft", { ...REST, offset: [0, 3, 0] });
    expect(high.size[0]).toBeGreaterThan(grounded.size[0]);
  });

  it("scales with the placement scale", () => {
    const one = quadFor(PHONE, "soft");
    const two = quadFor(PHONE, "soft", { ...REST, scale: 2 });
    expect(two.size[0]).toBeGreaterThan(one.size[0] * 1.5);
  });
});

describe("shadowPenumbra", () => {
  it("widens with the gap between occluder and receiver", () => {
    const mode = DEVICE_SHADOW_MODES.soft;
    expect(shadowPenumbra(mode, 0, 1)).toBeCloseTo(mode.blurNear, 12);
    expect(shadowPenumbra(mode, 2, 1)).toBeGreaterThan(shadowPenumbra(mode, 0, 1));
    expect(shadowPenumbra(mode, 4, 1)).toBeCloseTo(mode.blurNear + mode.softness * 4, 12);
  });

  it("scales the contact blur with the device but not the light's apparent size", () => {
    const mode = DEVICE_SHADOW_MODES.soft;
    expect(shadowPenumbra(mode, 2, 2)).toBeCloseTo(mode.blurNear * 2 + mode.softness * 2, 12);
  });

  it("never goes negative behind the receiver", () => {
    expect(shadowPenumbra(DEVICE_SHADOW_MODES.soft, -5, 1)).toBeCloseTo(
      DEVICE_SHADOW_MODES.soft.blurNear,
      12,
    );
  });
});
