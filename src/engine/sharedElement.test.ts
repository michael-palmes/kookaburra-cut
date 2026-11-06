import { Euler, Group, Object3D, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { resolveAvailableDeviceSpec } from "../toolkit/device/catalog";
import { deviceScreenFrame, SCREEN_LIFT } from "../toolkit/device/screenAnchor";
import { devicePoseFloorShift } from "../toolkit/device/shadowProjector";
import { resolveDeviceWorldAnchor } from "../toolkit/device/worldAnchor";
import type { V3 } from "../toolkit/types";
import { deviceTrackPoseAt, resolveDeviceTrack } from "./sceneDeviceTrack";
import type { SceneDoc } from "./sceneDocSchema";
import {
  deviceScreenPointAt,
  type SharedKeyframe,
  sampleSharedTransform,
  type TrackedDevice,
} from "./sharedElement";

describe("sampleSharedTransform — pure morph-transform sampling", () => {
  const track: SharedKeyframe[] = [
    { tMs: 0, position: [-1, 0, 0], scale: 0.5, opacity: 0 },
    { tMs: 1000, position: [1, 0, 0], scale: 1, opacity: 1 },
  ];

  it("returns the identity base for an empty track", () => {
    expect(sampleSharedTransform([], 500)).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: 1,
      opacity: 1,
    });
  });

  it("lerps every keyed property between surrounding keys", () => {
    const mid = sampleSharedTransform(track, 500);
    expect(mid.position).toEqual([0, 0, 0]);
    expect(mid.scale).toBe(0.75);
    expect(mid.opacity).toBe(0.5);
  });

  it("clamps outside the keyed range", () => {
    expect(sampleSharedTransform(track, -50).position).toEqual([-1, 0, 0]);
    expect(sampleSharedTransform(track, 9999).opacity).toBe(1);
  });

  it("interpolates properties independently (a key omitting one is transparent to it)", () => {
    const t: SharedKeyframe[] = [
      { tMs: 0, opacity: 0, rotation: [0, 0, 0] },
      { tMs: 500, position: [5, 0, 0] }, // no opacity/rotation, must not reset them
      { tMs: 1000, opacity: 1, rotation: [0, Math.PI, 0] },
    ];
    const mid = sampleSharedTransform(t, 500);
    expect(mid.opacity).toBe(0.5);
    expect(mid.rotation).toEqual([0, Math.PI / 2, 0]);
    expect(mid.position).toEqual([5, 0, 0]);
  });

  it("falls back to the base for properties no key defines", () => {
    const posOnly: SharedKeyframe[] = [{ tMs: 0, position: [2, 2, 2] }];
    const out = sampleSharedTransform(posOnly, 100);
    expect(out.scale).toBe(1);
    expect(out.opacity).toBe(1);
    expect(out.rotation).toEqual([0, 0, 0]);
  });

  it("is pure and does not mutate the track", () => {
    const unsorted: SharedKeyframe[] = [
      { tMs: 1000, scale: 2 },
      { tMs: 0, scale: 1 },
    ];
    expect(sampleSharedTransform(unsorted, 500).scale).toBe(1.5);
    expect(unsorted[0].tMs).toBe(1000);
    expect(sampleSharedTransform(track, 250)).toEqual(sampleSharedTransform(track, 250));
  });
});

describe("deviceScreenPointAt", () => {
  const DEG = Math.PI / 180;
  const moving: SceneDoc = {
    version: 1,
    deviceTrack: {
      keys: [
        {
          id: "k1",
          tMs: 0,
          pose: { hero: { offset: [0, -1.2, -0.6], rotationDeg: [0, 90, 0], scale: 0.7 } },
        },
        {
          id: "k2",
          tMs: 900,
          pose: { hero: { offset: [0, 0, 0], rotationDeg: [-6, -14, 4], scale: 1 } },
        },
      ],
      segments: [{ from: "k1", to: "k2", ease: "outCubic" }],
    },
  };
  const laptop: SceneDoc = {
    version: 1,
    deviceTrack: {
      keys: [
        { id: "k1", tMs: 0, pose: { mac: { lidDeg: 20 } } },
        { id: "k2", tMs: 1000, pose: { mac: { lidDeg: 110 } } },
      ],
      segments: [{ from: "k1", to: "k2", ease: "inOutCubic" }],
    },
  };

  /** The point through a scene graph nested the way `Device` renders it: the grounded group, the keyed offset and turn, the scale, then the screen anchor. */
  function rendered(
    device: TrackedDevice,
    doc: SceneDoc,
    localMs: number,
    u: number,
    v: number,
    floorY?: number | null,
  ) {
    const spec = resolveAvailableDeviceSpec(device.model);
    const placement = device.placement ?? {};
    const position = placement.position ?? [0, 0, 0];
    const rotationDeg = placement.rotationDeg ?? [0, 0, 0];
    const scale = placement.scale ?? 1;
    const lid = device.lidDeg ?? spec.lid?.defaultDeg;
    const keyed = deviceTrackPoseAt(
      resolveDeviceTrack(doc),
      device.id ?? "",
      localMs,
      lid,
      undefined,
    );
    const rotation: V3 = [0, 1, 2].map((i) => (rotationDeg[i] + keyed.rotationDeg[i]) * DEG) as V3;
    const shift = placement.ground
      ? devicePoseFloorShift(spec, {
          scale: scale * keyed.scale,
          rotation,
          offset: [0, 0, 0],
          introScale: 1,
          lidDeg: keyed.lidDeg ?? 0,
          foldDeg: 0,
        })
      : 0;
    const anchor =
      resolveDeviceWorldAnchor(
        { model: spec.id },
        { position, rotationDeg, scale: scale * keyed.scale, ground: placement.ground },
        floorY,
        shift,
      ) ?? position;
    const outer = new Group();
    outer.position.set(...anchor);
    const inner = new Group();
    inner.position.set(...keyed.offset);
    inner.rotation.set(...rotation);
    const sized = new Group();
    sized.scale.setScalar(scale * keyed.scale);
    const frame = deviceScreenFrame(spec.id, u, v, SCREEN_LIFT, { lidDeg: keyed.lidDeg ?? lid });
    const pin = new Object3D();
    pin.position.set(...frame.position);
    pin.rotation.set(frame.tiltX, 0, 0);
    outer.add(inner);
    inner.add(sized);
    sized.add(pin);
    outer.updateMatrixWorld(true);
    return {
      position: pin.getWorldPosition(new Vector3()),
      facing: pin.getWorldQuaternion(new Quaternion()),
    };
  }

  const cases: [string, TrackedDevice, SceneDoc, number, number | null | undefined][] = [
    [
      "a static phone",
      {
        id: "hero",
        model: "android",
        placement: { position: [1, 0.2, -0.4], rotationDeg: [-6, 14, 0], scale: 0.92 },
      },
      { version: 1 },
      0,
      undefined,
    ],
    [
      "a phone mid deal",
      { id: "hero", model: "iphone-17-pro", placement: { position: [0, -0.3, 0], scale: 0.92 } },
      moving,
      420,
      undefined,
    ],
    [
      "a grounded phone on a floor",
      {
        id: "hero",
        model: "android",
        placement: { position: [0, 2, 0], rotationDeg: [8, 0, 0], ground: true },
      },
      moving,
      300,
      -1.3,
    ],
    [
      "a laptop opening",
      { id: "mac", model: "macbook-pro-16", placement: { position: [0, -0.8, 0], scale: 0.8 } },
      laptop,
      500,
      null,
    ],
  ];

  for (const [label, device, doc, localMs, floorY] of cases) {
    it(`lands where the device renders: ${label}`, () => {
      const track = resolveDeviceTrack(doc);
      for (const [u, v] of [
        [0.5, 0.12],
        [0.1, 0.9],
        [0.5, 0.5],
      ]) {
        const sample = deviceScreenPointAt(device, track, localMs, u, v, { floorY });
        const truth = rendered(device, doc, localMs, u, v, floorY);
        expect(sample.position[0]).toBeCloseTo(truth.position.x, 9);
        expect(sample.position[1]).toBeCloseTo(truth.position.y, 9);
        expect(sample.position[2]).toBeCloseTo(truth.position.z, 9);
        const facing = new Quaternion().setFromEuler(new Euler(...sample.rotation));
        expect(Math.abs(facing.dot(truth.facing))).toBeCloseTo(1, 9);
      }
    });
  }

  it("follows the track through a move and reports the scale the display renders at", () => {
    const device: TrackedDevice = {
      id: "hero",
      model: "android",
      placement: { position: [0, 0, 0] },
    };
    const track = resolveDeviceTrack(moving);
    const start = deviceScreenPointAt(device, track, 0, 0.5, 0.5);
    const end = deviceScreenPointAt(device, track, 900, 0.5, 0.5);
    expect(start.scale).toBeCloseTo(0.7, 12);
    expect(end.scale).toBeCloseTo(1, 12);
    expect(start.position[1]).toBeLessThan(end.position[1]);
  });
});
