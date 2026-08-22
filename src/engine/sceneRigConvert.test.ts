import { describe, expect, it } from "vitest";
import { resolveDeviceLayout } from "../toolkit/device/layout";
import { resolveDeviceWorldAnchor } from "../toolkit/device/worldAnchor";
import { computeFormat, FORMATS } from "./format";
import { orbitToView } from "./orbit";
import type { CameraDoc, RigDoc } from "./sceneCameraEdit";
import type { SceneDoc } from "./sceneDocSchema";
import {
  bakeRigBinding,
  brokenRigBindings,
  canRigConvertToOrbit,
  orbitToRig,
  rebakeRigBindings,
  rigToOrbit,
} from "./sceneRigConvert";

const orbit: CameraDoc = {
  keys: [
    {
      id: "k1",
      tMs: 0,
      pose: { target: [0, 0, 0], azimuthDeg: -12, elevationDeg: 4, distance: 5.8 },
    },
    {
      id: "k2",
      tMs: 900,
      pose: { target: [1, -0.5, 0.2], azimuthDeg: 30, elevationDeg: -8, distance: 4 },
    },
  ],
  segments: [{ from: "k1", to: "k2", ease: "inOutQuad" }],
};

describe("orbitToRig", () => {
  it("keeps every key's applied pose exactly", () => {
    const rig = orbitToRig(orbit);
    rig.keys.forEach((key, i) => {
      const view = orbitToView(orbit.keys[i].pose);
      expect(key.pose.position).toEqual(view.position);
      expect(key.pose.aim).toEqual({ mode: "point", at: view.lookAt });
      expect(key.tMs).toBe(orbit.keys[i].tMs);
    });
  });

  it("pins converted segments straight, because orbit paths never curved", () => {
    expect(orbitToRig(orbit).segments[0].smooth).toBe(false);
    expect(orbitToRig(orbit).segments[0].ease).toBe("inOutQuad");
  });
});

describe("rigToOrbit", () => {
  it("round-trips: orbit -> rig -> orbit lands on the same pose", () => {
    const back = rigToOrbit(orbitToRig(orbit));
    expect(back).not.toBeNull();
    back?.keys.forEach((key, i) => {
      const want = orbit.keys[i].pose;
      expect(key.pose.azimuthDeg).toBeCloseTo(want.azimuthDeg, 10);
      expect(key.pose.elevationDeg).toBeCloseTo(want.elevationDeg, 10);
      expect(key.pose.distance).toBeCloseTo(want.distance, 10);
      expect(key.pose.target[0]).toBeCloseTo(want.target[0], 10);
      expect(key.pose.target[1]).toBeCloseTo(want.target[1], 10);
      expect(key.pose.target[2]).toBeCloseTo(want.target[2], 10);
    });
  });

  it("refuses a rig with a tangent aim, which has no target to orbit", () => {
    const rig: RigDoc = {
      keys: [
        {
          id: "k1",
          tMs: 0,
          pose: { position: [0, 0, 5], aim: { mode: "tangent", at: [0, 0, 0] } },
        },
      ],
      segments: [],
    };
    expect(canRigConvertToOrbit(rig)).toBe(false);
    expect(rigToOrbit(rig)).toBeNull();
  });

  it("accepts an object aim, orbiting its baked point", () => {
    const rig: RigDoc = {
      keys: [
        {
          id: "k1",
          tMs: 0,
          pose: { position: [0, 0, 5], aim: { mode: "object", id: "d", at: [0, 0, 0] } },
        },
      ],
      segments: [],
    };
    expect(canRigConvertToOrbit(rig)).toBe(true);
    expect(rigToOrbit(rig)?.keys[0].pose.distance).toBeCloseTo(5, 10);
  });
});

describe("object bindings", () => {
  const bound: RigDoc = {
    keys: [
      {
        id: "k1",
        tMs: 0,
        pose: { position: [0, 0, 5], aim: { mode: "object", id: "phone", at: [0, 0, 0] } },
      },
      { id: "k2", tMs: 900, pose: { position: [2, 0, 5], aim: { mode: "point", at: [0, 0, 0] } } },
    ],
    segments: [],
  };
  const doc = (position: [number, number, number]): SceneDoc => ({
    version: 1,
    devices: [{ id: "phone", model: "iphone-15-pro", placement: { position } }],
  });

  it("rebakes a bound key when the object moves, leaving other keys alone", () => {
    const next = rebakeRigBindings(bound, doc([1, 2, 3]));
    expect(next.keys[0].pose.aim.at).toEqual([1, 2, 3]);
    expect(next.keys[1]).toBe(bound.keys[1]);
  });

  it("returns the SAME object when nothing moved, so no spurious write happens", () => {
    expect(rebakeRigBindings(bound, doc([0, 0, 0]))).toBe(bound);
  });

  it("rebakes an arranged device to its rendered placement for the active aspect", () => {
    const arranged: SceneDoc = {
      version: 1,
      devices: [
        { id: "other", model: "iphone-15-pro" },
        { id: "phone", model: "iphone-15-pro" },
      ],
      deviceLayout: {
        preset: "row",
        gap: 0.6,
        devices: { phone: { offset: [0.25, 0.1, -0.2] } },
      },
    };
    const format = computeFormat(FORMATS["9:16"]);
    const layout = arranged.deviceLayout;
    if (!layout) throw new Error("device layout expected");
    const expected = resolveDeviceLayout(arranged.devices ?? [], layout, format)[1].position;
    expect(rebakeRigBindings(bound, arranged, format).keys[0].pose.aim.at).toEqual(expected);
  });

  it("bakes a deleted binding to its last known point, keeping the shot", () => {
    const moved = rebakeRigBindings(bound, doc([1, 2, 3]));
    const baked = bakeRigBinding(moved, "phone");
    expect(baked.keys[0].pose.aim).toEqual({ mode: "point", at: [1, 2, 3] });
  });

  it("rebakes and deletes a grounded binding at the exact mounted-floor anchor", () => {
    const grounded: SceneDoc = {
      version: 1,
      devices: [
        {
          id: "phone",
          model: "iphone-17-pro",
          placement: { position: [1, 8, 3], scale: 1.2, ground: true },
        },
      ],
    };
    const expected = resolveDeviceWorldAnchor(
      grounded.devices?.[0] ?? { model: "" },
      grounded.devices?.[0]?.placement,
      -0.8,
    );
    const resolved = rebakeRigBindings(bound, grounded, undefined, -0.8);

    expect(bakeRigBinding(resolved, "phone").keys[0].pose.aim).toEqual({
      mode: "point",
      at: expected,
    });
  });

  it("reports bindings the doc can no longer resolve", () => {
    expect(brokenRigBindings(bound, doc([0, 0, 0]))).toEqual([]);
    expect(brokenRigBindings(bound, { version: 1 })).toEqual(["phone"]);
    expect(brokenRigBindings(bound, undefined)).toEqual(["phone"]);
    expect(
      brokenRigBindings(bound, {
        version: 1,
        devices: [{ id: "phone", model: "iphone-17-pro", placement: { ground: true } }],
        deviceLayout: { preset: "row" },
      }),
    ).toEqual([]);
  });
});
