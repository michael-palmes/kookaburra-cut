import { describe, expect, it } from "vitest";
import type { SceneDocObjectSpec } from "../../engine/sceneDocSchema";
import { besideDevicePlacement, floorCentrePlacement, frontOfDevicePlacement } from "./presets";

type Device = Parameters<typeof besideDevicePlacement>[0];

const phone = { id: "d1", model: "iphone-15-pro" } as Device;

describe("besideDevicePlacement", () => {
  it("offsets past the device's half-width, level and grounded", () => {
    const right = besideDevicePlacement(phone, "right");
    const left = besideDevicePlacement(phone, "left");
    expect(right.ground).toBe(true);
    expect(right.position?.[0]).toBeGreaterThan(0.5);
    expect(left.position?.[0]).toBeCloseTo(-(right.position?.[0] ?? 0), 10);
    expect(right.position?.[1]).toBe(0);
  });

  it("follows the device's own position and scale", () => {
    const moved = {
      ...phone,
      placement: { position: [2, -0.3, 1] as [number, number, number], scale: 2 },
    } as Device;
    const base = besideDevicePlacement(phone, "right");
    const offset = besideDevicePlacement(moved, "right");
    expect(offset.position?.[1]).toBe(-0.3);
    expect(offset.position?.[2]).toBe(1);
    expect((offset.position?.[0] ?? 0) - 2).toBeGreaterThan(base.position?.[0] ?? 0);
  });

  it("width-fit devices (laptops) read wider than phones", () => {
    const laptop = { id: "d1", model: "macbook-pro-16" } as Device;
    const besidePhone = besideDevicePlacement(phone, "right");
    const besideLaptop = besideDevicePlacement(laptop, "right");
    expect(besideLaptop.position?.[0]).toBeGreaterThan(besidePhone.position?.[0] ?? 0);
  });

  it("an unknown model still yields a finite grounded placement", () => {
    const unknown = { id: "d1", model: "not-a-device" } as SceneDocObjectSpec & Device;
    const p = besideDevicePlacement(unknown, "right");
    expect(Number.isFinite(p.position?.[0])).toBe(true);
    expect(p.ground).toBe(true);
  });
});

describe("other starting placements", () => {
  it("front pulls toward the camera from the device", () => {
    expect(frontOfDevicePlacement(phone).position?.[2]).toBeCloseTo(1.2, 5);
  });

  it("floor centre grounds at the origin", () => {
    expect(floorCentrePlacement()).toEqual({
      position: [0, 0, 0],
      rotationDeg: [0, 0, 0],
      ground: true,
    });
  });
});
