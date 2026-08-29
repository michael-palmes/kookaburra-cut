import { describe, expect, it, vi } from "vitest";

vi.mock("./modelUrl", () => ({
  androidModelUrl: "/android.glb",
  phoneModelUrl: "/placeholder-phone.glb",
  iphone17ProModelUrl: "/placeholder-phone.glb",
  macbookPro16ModelUrl: "/placeholder-phone.glb",
  ipadPro13ModelUrl: "/placeholder-phone.glb",
  iphone15ProModelAvailable: false,
  iphone17ProModelAvailable: false,
  macbookPro16ModelAvailable: false,
  ipadPro13ModelAvailable: false,
}));

import {
  AVAILABLE_DEVICE_IDS,
  DEFAULT_DEVICE_ID,
  DEVICE_AVAILABILITY,
  FALLBACK_DEVICE_ID,
  isDeviceAvailable,
  resolveAvailableDeviceId,
  resolveAvailableDeviceSpec,
} from "./catalog";

describe("device availability in a clean clone", () => {
  it("offers only the bundled Android and uses it by default", () => {
    expect(DEVICE_AVAILABILITY.android).toBe(true);
    expect(AVAILABLE_DEVICE_IDS).toEqual(["android"]);
    expect(DEFAULT_DEVICE_ID).toBe("android");
  });

  it("resolves unavailable and unknown models to the complete Android spec", () => {
    expect(FALLBACK_DEVICE_ID).toBe("android");
    expect(isDeviceAvailable("iphone-17-pro")).toBe(false);
    expect(resolveAvailableDeviceId("iphone-17-pro")).toBe("android");
    expect(resolveAvailableDeviceId("ipad-pro-13")).toBe("android");
    expect(resolveAvailableDeviceId("missing-device")).toBe("android");
    expect(resolveAvailableDeviceId("__proto__")).toBe("android");
    expect(resolveAvailableDeviceId("constructor")).toBe("android");
    expect(resolveAvailableDeviceId("toString")).toBe("android");
    expect(resolveAvailableDeviceSpec("macbook-pro-16")).toMatchObject({
      id: "android",
      glbUrl: "/android.glb",
      screen: { material: "screen" },
      defaultColour: "graphite",
    });
  });
});
