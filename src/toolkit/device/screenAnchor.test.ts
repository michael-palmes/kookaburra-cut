import { describe, expect, it, vi } from "vitest";

// Every model available, so the laptop and foldable maths run on their own specs in any checkout.
vi.mock("./modelUrl", () => ({
  androidModelUrl: "/android.glb",
  phoneModelUrl: "/phone.glb",
  iphone17ProModelUrl: "/iphone-17-pro.glb",
  macbookPro16ModelUrl: "/macbook-pro-16.glb",
  ipadPro13ModelUrl: "/ipad-pro-13.glb",
  iphoneDuoModelUrl: "/iphone-duo.glb",
  iphone15ProModelAvailable: true,
  iphone17ProModelAvailable: true,
  macbookPro16ModelAvailable: true,
  ipadPro13ModelAvailable: true,
  iphoneDuoModelAvailable: true,
}));

import { DEVICE_CATALOG } from "./catalog";
import { foldCentreOffset } from "./foldPose";
import {
  deviceScreenFrame,
  deviceScreenLocal,
  deviceScreenPoint,
  deviceScreenRect,
  mediaPixelToScreenUv,
  SCREEN_LIFT,
  screenUvToMediaPixel,
} from "./screenAnchor";

const close = (actual: number[], expected: number[], digits = 9) => {
  for (const [i, n] of actual.entries()) expect(n).toBeCloseTo(expected[i], digits);
};

describe("deviceScreenRect", () => {
  it("answers with the screen the model renders", () => {
    expect(deviceScreenRect("iphone-17-pro")).toBe(DEVICE_CATALOG["iphone-17-pro"].screen.rect);
    expect(deviceScreenRect("no-such-device")).toBe(DEVICE_CATALOG.android.screen.rect);
    expect(deviceScreenRect("iphone-duo", "cover")).toBe(
      DEVICE_CATALOG["iphone-duo"].coverScreen?.rect,
    );
    // A single-screen device shows a foldable's cover media on its one screen.
    expect(deviceScreenRect("android", "cover")).toBe(DEVICE_CATALOG.android.screen.rect);
  });
});

describe("deviceScreenLocal", () => {
  it("maps UV to the rect with u right and v down, lifted off the glass", () => {
    const { width, height, centre, z } = DEVICE_CATALOG.android.screen.rect;
    close(deviceScreenLocal("android", 0, 0, 0), [
      centre[0] - width / 2,
      centre[1] + height / 2,
      z,
    ]);
    close(deviceScreenLocal("android", 1, 1, 0), [
      centre[0] + width / 2,
      centre[1] - height / 2,
      z,
    ]);
    close(deviceScreenLocal("android", 0.5, 0.5), [centre[0], centre[1], z + SCREEN_LIFT]);
  });

  it("turns a laptop's screen points about the hinge with the lid", () => {
    const lid = DEVICE_CATALOG["macbook-pro-16"].lid;
    const pivot = lid?.pivot ?? [0, 0, 0];
    const rect = DEVICE_CATALOG["macbook-pro-16"].screen.rect;
    expect(rect.frame?.lidDeg).toBe(lid?.defaultDeg);
    const atFrame = deviceScreenFrame("macbook-pro-16", 0.5, 0, 0);
    expect(atFrame.tiltX).toBeCloseTo(0, 12);
    close(atFrame.position, deviceScreenLocal("macbook-pro-16", 0.5, 0, 0, { lidDeg: 90 }));
    const open = deviceScreenFrame("macbook-pro-16", 0.5, 0, 0, { lidDeg: 110 });
    expect(open.tiltX).toBeCloseTo((-20 * Math.PI) / 180, 12);
    // The top edge leans back, at the same distance from the hinge.
    expect(open.position[2]).toBeLessThan(atFrame.position[2]);
    const reach = (p: number[]) => Math.hypot(p[1] - pivot[1], p[2] - pivot[2]);
    expect(reach(open.position)).toBeCloseTo(reach(atFrame.position), 12);
    expect(open.position[0]).toBe(atFrame.position[0]);
    // Clamped to the hinge's travel, as Device clamps it.
    close(
      deviceScreenLocal("macbook-pro-16", 0.5, 0, 0, { lidDeg: 200 }),
      deviceScreenLocal("macbook-pro-16", 0.5, 0, 0, { lidDeg: 110 }),
    );
    expect(deviceScreenFrame("macbook-pro-16", 0.5, 0, 0, { lidDeg: 0 }).tiltX).toBeCloseTo(
      Math.PI / 2,
      12,
    );
  });

  it("carries a foldable's auto-centre on the static half and the cover", () => {
    const fold = DEVICE_CATALOG["iphone-duo"].fold;
    if (!fold) throw new Error("the Duo folds");
    const open = deviceScreenLocal("iphone-duo", 0.75, 0.5, 0, { foldDeg: 180 });
    const closed = deviceScreenLocal("iphone-duo", 0.75, 0.5, 0, { foldDeg: 0 });
    expect(closed[0] - open[0]).toBeCloseTo(foldCentreOffset(fold, 0), 9);
    close(closed.slice(1), open.slice(1));
    const cover = DEVICE_CATALOG["iphone-duo"].coverScreen?.rect;
    close(deviceScreenLocal("iphone-duo", 0.5, 0.5, 0, { display: "cover", foldDeg: 0 }), [
      cover?.centre[0] ?? Number.NaN,
      cover?.centre[1] ?? Number.NaN,
      cover?.z ?? Number.NaN,
    ]);
  });
});

describe("deviceScreenPoint", () => {
  it("applies the device's position, rotation and scale like its pose group", () => {
    const [x, y, z] = deviceScreenLocal("android", 0.2, 0.3);
    close(deviceScreenPoint("android", 0.2, 0.3, { position: [1, 2, 3] }), [x + 1, y + 2, z + 3]);
    close(
      deviceScreenPoint("android", 0.2, 0.3, { position: [0, 0, 0], rotationDeg: [0, 90, 0] }),
      [z, y, -x],
    );
    close(deviceScreenPoint("android", 0.2, 0.3, { position: [0, 0, 0], scale: 2 }), [
      2 * x,
      2 * y,
      2 * z,
    ]);
  });
});

describe("media pixels and screen UV", () => {
  it("normalises matching media and crops wider media's sides", () => {
    const aspect = DEVICE_CATALOG.android.screen.aspect;
    const tall = { width: 1000, height: 1000 / aspect };
    close(mediaPixelToScreenUv("android", [250, tall.height / 4], tall), [0.25, 0.25]);
    const wide = { width: 1920, height: 1080 };
    const shown = 1080 * aspect;
    close(mediaPixelToScreenUv("android", [960, 540], wide), [0.5, 0.5]);
    close(mediaPixelToScreenUv("android", [960 - shown / 2, 0], wide), [0, 0]);
    close(mediaPixelToScreenUv("android", [960 + shown / 2, 1080], wide), [1, 1]);
  });

  it("round-trips through its inverse", () => {
    const media = { width: 1206, height: 2400 };
    for (const pixel of [
      [0, 0],
      [603, 1200],
      [1100, 2350],
    ] as Array<[number, number]>) {
      const uv = mediaPixelToScreenUv("iphone-17-pro", pixel, media);
      close(screenUvToMediaPixel("iphone-17-pro", uv, media), pixel);
    }
  });
});
