import { describe, expect, it } from "vitest";
import {
  DEVICE_SHADOW_CHOICES,
  DEVICE_SHADOW_MODES,
  deviceShadowSlabs,
  lightDirection,
  SHADOW_FRAG,
  SHADOW_VERT,
  type ShadowPose,
  shadowLightDirection,
  shadowPenumbra,
  shadowPlane,
  shadowQuad,
  shadowSweepDirection,
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

describe("the quad at grazing angles", () => {
  it("stays bounded when the device turns side-on to the light", () => {
    // The regression Michael's side-on screenshot caught: the old mid-plane silhouette divided
    // by dot(light, normal) and exploded into a harsh-edged blob near 90 degrees of yaw.
    const mode = DEVICE_SHADOW_MODES.soft;
    const plane = shadowPlane(mode, -1.3, 1);
    const light = shadowLightDirection(mode);
    const flat = shadowQuad(deviceShadowSlabs(PHONE, REST), plane, light, mode, 1);
    const sideOn = shadowQuad(
      deviceShadowSlabs(PHONE, { ...REST, rotation: [0, Math.PI / 2 - 0.02, 0] }),
      plane,
      light,
      mode,
      1,
    );
    if (!flat || !sideOn) throw new Error("no quad");
    // A thin phone edge-on stays the same order of size, never a blow-up (the old maths grew past 5x here).
    expect(sideOn.size[0]).toBeLessThan(flat.size[0] * 2);
    expect(sideOn.size[1]).toBeLessThan(flat.size[1] * 2);
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

  it("keeps the sun sweep falling down-right ON SCREEN, at any yaw or tilt", () => {
    const mode = DEVICE_SHADOW_MODES.sun;
    for (const rotation of [
      [0, 0, 0],
      [0, Math.PI / 4, 0],
      [0, (78 * Math.PI) / 180, 0],
      [-0.4, 0.6, 0.1],
    ] as [number, number, number][]) {
      const pose = { ...REST, rotation };
      const slabs = deviceShadowSlabs(PHONE, pose);
      const plane = shadowPlane(mode, -1.3, 1, pose, slabs);
      const sweep = shadowSweepDirection(plane, shadowLightDirection(mode, plane));
      // Map the in-plane sweep back to world: it must track the screen's down-right diagonal.
      const world = [
        plane.e1[0] * sweep[0] + plane.e2[0] * sweep[1],
        plane.e1[1] * sweep[0] + plane.e2[1] * sweep[1],
      ];
      const len = Math.hypot(world[0], world[1]);
      // The 2x2 solve pins the screen projection to the diagonal at any pose.
      expect((world[0] * Math.SQRT1_2 - world[1] * Math.SQRT1_2) / len).toBeGreaterThan(0.999);
    }
  });

  it("hugs the behind plane to the device's backmost point", () => {
    const mode = DEVICE_SHADOW_MODES.sun;
    const slabs = deviceShadowSlabs(PHONE, REST);
    const plane = shadowPlane(mode, -1.3, 1, REST, slabs);
    // Just behind the back face: half thickness plus the clearance, not a distant backdrop.
    expect(plane.origin[2]).toBeCloseTo(-(0.184 / 2) - 0.05, 6);
    expect(plane.normal[2]).toBeCloseTo(1, 12);
    // A yawed device turns its plane with it, so the plane never slices the body.
    const yawed = { ...REST, rotation: [0, Math.PI / 3, 0] as [number, number, number] };
    const yawedPlane = shadowPlane(mode, -1.3, 1, yawed, deviceShadowSlabs(PHONE, yawed));
    expect(yawedPlane.normal[0]).toBeCloseTo(Math.sin(Math.PI / 3), 6);
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

// The words GLSL ES reserves for future use. ANGLE's Metal backend enforces them, and a
// rejected shader here fails SILENTLY (three logs, the quad just never draws), which is
// exactly how `float cast` shipped a device with no shadow at all on 2026-08-25. The
// troika `inout` patch is the same lesson (docs/determinism.md, "macOS 27").
const GLSL_RESERVED = [
  "asm",
  "cast",
  "class",
  "double",
  "enum",
  "extern",
  "external",
  "filter",
  "fixed",
  "flat",
  "goto",
  "half",
  "inline",
  "input",
  "interface",
  "long",
  "namespace",
  "noinline",
  "output",
  "packed",
  "partition",
  "public",
  "resource",
  "row_major",
  "sampler3DRect",
  "short",
  "sizeof",
  "static",
  "superp",
  "template",
  "this",
  "typedef",
  "union",
  "unsigned",
  "using",
  "volatile",
];

describe("the shader source", () => {
  it("never declares an identifier GLSL reserves", () => {
    for (const source of [SHADOW_VERT, SHADOW_FRAG]) {
      for (const word of GLSL_RESERVED) {
        expect(source).not.toMatch(
          new RegExp(`\\b(float|vec[234]|int|bool|mat[234])\\s+${word}\\b`),
        );
      }
    }
  });

  it("keeps every uniform the projector writes declared in the fragment stage", () => {
    for (const uniform of [
      "uPlaneOrigin",
      "uPlaneE1",
      "uPlaneE2",
      "uLight",
      "uPlaneNormal",
      "uSweep",
      "uSweepLen",
      "uSweepBlur",
      "uBlurNear",
      "uSoftness",
      "uOpacity",
      "uFadeLength",
      "uFalloff",
      "uAmbient",
      "uSlabOn1",
    ]) {
      expect(SHADOW_FRAG).toContain(`uniform`);
      expect(SHADOW_FRAG).toMatch(new RegExp(`uniform\\s+\\w+\\s+${uniform};`));
    }
  });
});

describe("the mode catalogue", () => {
  it("keeps the picker list and the parameter table in lockstep", () => {
    const choices = DEVICE_SHADOW_CHOICES.map((choice) => choice.id).filter((id) => id !== "none");
    expect(choices.sort()).toEqual(Object.keys(DEVICE_SHADOW_MODES).sort());
  });

  it("puts Overhead nearly straight above, for the symmetric tabletop pool", () => {
    const light = shadowLightDirection(DEVICE_SHADOW_MODES.overhead);
    expect(light[1]).toBeGreaterThan(0.98);
  });

  it("throws Backlight and Wet floor forward, toward the camera", () => {
    for (const mode of [DEVICE_SHADOW_MODES.backlight, DEVICE_SHADOW_MODES.wetfloor]) {
      const plane = shadowPlane(mode, -1.3, 1);
      const sweep = shadowSweepDirection(plane, shadowLightDirection(mode));
      // The floor plane's +y is world -z, so a forward cast is negative there.
      expect(sweep[1]).toBeLessThan(-0.9);
    }
    // Wet floor is the short sharp one of the pair.
    expect(DEVICE_SHADOW_MODES.wetfloor.fadeLength).toBeLessThan(
      DEVICE_SHADOW_MODES.backlight.fadeLength,
    );
    expect(DEVICE_SHADOW_MODES.wetfloor.blurNear).toBeLessThan(
      DEVICE_SHADOW_MODES.backlight.blurNear,
    );
  });

  it("gives Feather no directional cast at all", () => {
    expect(DEVICE_SHADOW_MODES.feather.opacity).toBe(0);
    expect(DEVICE_SHADOW_MODES.feather.ambientOpacity).toBeGreaterThan(0);
  });

  it("offsets Card drop down-right on the plane behind, with no smear", () => {
    const mode = DEVICE_SHADOW_MODES.drop;
    expect(mode.receiver).toBe("behind");
    expect(mode.sweepLength).toBe(0);
    const slabs = deviceShadowSlabs(PHONE, REST);
    const plane = shadowPlane(mode, -1.3, 1, REST, slabs);
    const light = shadowLightDirection(mode, plane);
    // The silhouette slides opposite the light: light up-left means the cast lands down-right.
    const quad = shadowQuad(slabs, plane, light, mode, 1);
    expect(quad?.centre[0]).toBeGreaterThan(0);
    expect(quad?.centre[1]).toBeLessThan(0);
  });

  it("gives Twin studio two opposed casts with the key darker than the fill", () => {
    const mode = DEVICE_SHADOW_MODES.studio;
    expect(mode.fill).toBeDefined();
    expect(Math.sign(mode.fill?.azimuthDeg ?? 0)).toBe(-Math.sign(mode.azimuthDeg));
    expect(mode.fill?.opacity ?? 1).toBeLessThan(mode.opacity);
  });

  it("grows Twin studio's quad to hold both casts", () => {
    const mode = DEVICE_SHADOW_MODES.studio;
    const single = { ...mode, fill: undefined };
    const slabs = deviceShadowSlabs(PHONE, REST);
    const plane = shadowPlane(mode, -1.3, 1);
    const light = shadowLightDirection(mode);
    const both = shadowQuad(slabs, plane, light, mode, 1);
    const one = shadowQuad(slabs, plane, light, single, 1);
    expect(both && one && both.size[0]).toBeGreaterThan(
      (one as { size: [number, number] }).size[0],
    );
  });

  it("keeps Window light wider and lighter than Long & smooth", () => {
    expect(DEVICE_SHADOW_MODES.window.softness).toBeGreaterThan(DEVICE_SHADOW_MODES.long.softness);
    expect(DEVICE_SHADOW_MODES.window.opacity).toBeLessThan(DEVICE_SHADOW_MODES.long.opacity);
  });

  it("declares the fill uniforms the studio mode writes", () => {
    expect(SHADOW_FRAG).toMatch(/uniform\s+vec3\s+uFillLight;/);
    expect(SHADOW_FRAG).toMatch(/uniform\s+float\s+uFillOpacity;/);
  });

  it("packs each slab as a vec4 (halves, half thickness, corner radius)", () => {
    expect(SHADOW_FRAG).toMatch(/uniform\s+vec4\s+uSlabH0;/);
    expect(SHADOW_FRAG).toMatch(/uniform\s+vec4\s+uSlabH1;/);
  });

  it("keeps every loop bound constant, the ANGLE translation rule", () => {
    for (const loop of SHADOW_FRAG.matchAll(/for\s*\(int i = 0; i < (\d+); i\+\+\)/g)) {
      expect(Number(loop[1])).toBeGreaterThan(0);
    }
    expect([...SHADOW_FRAG.matchAll(/for\s*\(/g)].length).toBe(2);
  });

  it("floors the pool's footprint for the pool-led modes, so upright phones still seat", () => {
    for (const mode of [DEVICE_SHADOW_MODES.overhead, DEVICE_SHADOW_MODES.feather]) {
      // Wider than any handset's thickness-only sliver (grown or not).
      expect(mode.ambientMinHalf ?? 0).toBeGreaterThan(0.184);
    }
    // The casts keep the true silhouette: no floor on the directional modes.
    expect(DEVICE_SHADOW_MODES.soft.ambientMinHalf).toBeUndefined();
    expect(DEVICE_SHADOW_MODES.long.ambientMinHalf).toBeUndefined();
  });

  it("pads the quad out to the floored pool", () => {
    const mode = DEVICE_SHADOW_MODES.feather;
    const slabs = deviceShadowSlabs(PHONE, REST);
    const plane = shadowPlane(mode, -1.3, 1);
    const light = shadowLightDirection(mode);
    const floored = shadowQuad(slabs, plane, light, mode, 1);
    const bare = shadowQuad(slabs, plane, light, { ...mode, ambientMinHalf: undefined }, 1);
    expect(floored && bare && floored.size[1]).toBeGreaterThan(
      (bare as { size: [number, number] }).size[1],
    );
  });

  it("aims lightDirection correctly at the compass points", () => {
    expect(lightDirection(0, 0)).toEqual([0, 0, 1]);
    const overhead = lightDirection(0, 90);
    expect(overhead[1]).toBeCloseTo(1, 12);
    const east = lightDirection(90, 0);
    expect(east[0]).toBeCloseTo(1, 12);
  });
});
