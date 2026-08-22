import { describe, expect, it } from "vitest";
import { computeFormat, FORMATS } from "../../engine/format";
import type { SceneDocDeviceSpec } from "../../engine/sceneDocSchema";
import { resolveAvailableDeviceSpec } from "./catalog";
import { resolveDeviceLayout } from "./layout";
import { deviceFittedHeight, resolveDeviceWorldAnchor } from "./worldAnchor";

describe("resolveDeviceWorldAnchor", () => {
  it("grounds a phone on the default or a custom floor", () => {
    const phone: SceneDocDeviceSpec = {
      id: "phone",
      model: "iphone-17-pro",
      placement: { position: [1, 8, 3], ground: true },
    };

    const defaultFloor = resolveDeviceWorldAnchor(phone, phone.placement, -1.5);
    const customFloor = resolveDeviceWorldAnchor(phone, phone.placement, 0.75);
    expect(defaultFloor?.[0]).toBe(1);
    expect(defaultFloor?.[1]).toBeCloseTo(-0.2, 12);
    expect(defaultFloor?.[2]).toBe(3);
    expect(customFloor?.[0]).toBe(1);
    expect(customFloor?.[1]).toBeCloseTo(2.05, 12);
    expect(customFloor?.[2]).toBe(3);
  });

  it("uses each model's fitted height and the resolved placement scale", () => {
    const laptop: SceneDocDeviceSpec = {
      id: "laptop",
      model: "macbook-pro-16",
      placement: { position: [-1, 4, 0.5], scale: 1.5, ground: true },
    };
    const anchor = resolveDeviceWorldAnchor(laptop, laptop.placement, -1.5);

    // A build without the licensed laptop renders, and so grounds, the Android fallback.
    const laptopHeight = resolveAvailableDeviceSpec("macbook-pro-16").fittedHeight;
    expect(deviceFittedHeight("iphone-15-pro")).toBe(
      resolveAvailableDeviceSpec("iphone-15-pro").fittedHeight,
    );
    expect(deviceFittedHeight("macbook-pro-16")).toBeCloseTo(laptopHeight, 12);
    expect(anchor?.[0]).toBe(-1);
    expect(anchor?.[1]).toBeCloseTo(-1.5 + (laptopHeight * 1.5) / 2, 12);
    expect(anchor?.[2]).toBe(0.5);
  });

  it("grounds an arranged portrait device at its compressed rendered pose", () => {
    const devices: SceneDocDeviceSpec[] = [
      { id: "left", model: "iphone-17-pro", placement: { ground: true } },
      { id: "right", model: "iphone-17-pro", placement: { ground: true } },
    ];
    const placement = resolveDeviceLayout(
      devices,
      { preset: "row", gap: 0.6, devices: { right: { offset: [0.2, 0.1, -0.3] } } },
      computeFormat(FORMATS["9:16"]),
    )[1];
    const anchor = resolveDeviceWorldAnchor(devices[1], placement, -1.5);

    expect(placement.scale).toBeLessThan(0.92);
    expect(anchor?.[0]).toBe(placement.position?.[0]);
    expect(anchor?.[1]).toBeCloseTo(-1.5 + (2.6 * (placement.scale ?? 1)) / 2, 12);
    expect(anchor?.[2]).toBe(placement.position?.[2]);
  });

  it("uses authored Y with a known absent floor and preserves a baked aim when floor state is unknown", () => {
    const device: SceneDocDeviceSpec = {
      id: "phone",
      model: "iphone-17-pro",
      placement: { position: [1, 2, 3], ground: true },
    };

    expect(resolveDeviceWorldAnchor(device, device.placement, null)).toEqual([1, 2, 3]);
    expect(resolveDeviceWorldAnchor(device, device.placement, undefined)).toBeUndefined();
  });
});
