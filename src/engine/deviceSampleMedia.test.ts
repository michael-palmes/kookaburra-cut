import { describe, expect, it } from "vitest";
import {
  isSampleDeviceVideo,
  SAMPLE_LAPTOP_VIDEO,
  SAMPLE_PHONE_VIDEO,
  sampleVideoForDevice,
} from "./deviceSampleMedia";

describe("sampleVideoForDevice", () => {
  it("uses the laptop recording only for the laptop model", () => {
    expect(sampleVideoForDevice("macbook-pro-16")).toBe(SAMPLE_LAPTOP_VIDEO);
    expect(sampleVideoForDevice("iphone-17-pro")).toBe(SAMPLE_PHONE_VIDEO);
    expect(sampleVideoForDevice("android")).toBe(SAMPLE_PHONE_VIDEO);
  });

  it("recognises only bundled device samples", () => {
    expect(isSampleDeviceVideo(SAMPLE_PHONE_VIDEO)).toBe(true);
    expect(isSampleDeviceVideo(SAMPLE_LAPTOP_VIDEO)).toBe(true);
    expect(isSampleDeviceVideo("assets/my-recording.mp4")).toBe(false);
  });
});
