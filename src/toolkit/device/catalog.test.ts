import { describe, expect, it } from "vitest";
import { customColourHex, DEVICE_CATALOG, deviceColour } from "./catalog";

describe("customColourHex", () => {
  it("extracts the hex from custom ids and rejects everything else", () => {
    expect(customColourHex("custom:#AaBbCc")).toBe("#aabbcc");
    expect(customColourHex("custom:#12345")).toBeUndefined();
    expect(customColourHex("custom:red")).toBeUndefined();
    expect(customColourHex("deep-blue")).toBeUndefined();
    expect(customColourHex(undefined)).toBeUndefined();
  });
});

describe("deviceColour custom tints", () => {
  it("derives a full override set from the model's reference finish, deterministically", () => {
    const spec = DEVICE_CATALOG["iphone-15-pro"];
    const a = deviceColour(spec, "custom:#8a2be2");
    const b = deviceColour(spec, "custom:#8a2be2");
    expect(a).toEqual(b);
    expect(a.swatch).toBe("#8a2be2");
    expect(a.name).toBe("Custom");
    // Same material slots as the reference finish (the first with overrides).
    const ref = spec.colours.find((c) => Object.keys(c.overrides).length > 0);
    expect(Object.keys(a.overrides).sort()).toEqual(Object.keys(ref?.overrides ?? {}).sort());
    for (const o of Object.values(a.overrides)) {
      expect(o.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps the finish structure: polished stays lighter than antennas", () => {
    const spec = DEVICE_CATALOG["iphone-15-pro"];
    const custom = deviceColour(spec, "custom:#406080");
    const lum = (hex: string) => Number.parseInt(hex.slice(1), 16);
    const polished = custom.overrides["GL_BACK Polished"]?.color ?? "#000000";
    const antennas = custom.overrides.PL_ANTENNAS?.color ?? "#ffffff";
    expect(lum(polished)).toBeGreaterThan(lum(antennas));
  });

  it("still resolves catalogue ids and degrades unknown ids to the default", () => {
    const spec = DEVICE_CATALOG["iphone-15-pro"];
    expect(deviceColour(spec, "blue-titanium").id).toBe("blue-titanium");
    expect(deviceColour(spec, "no-such").id).toBe(spec.defaultColour);
    expect(deviceColour(spec, "custom:notahex").id).toBe(spec.defaultColour);
  });
});
