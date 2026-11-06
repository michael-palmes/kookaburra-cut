import { Euler, PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { type DeviceScreenPose, deviceScreenLocal } from "../toolkit/device/screenAnchor";
import { applyCameraPose } from "./cameraTrack";
import {
  type ContentBounds,
  frameContentDistance,
  frameContentPose,
  frameCoverDistance,
  screenFillPose,
  stagedContentBounds,
} from "./rigFraming";
import type { SceneDocMediaSpec, SceneDocRigPose } from "./sceneDocSchema";

const box = (w: number, h: number, d = 0): ContentBounds => ({
  min: [-w / 2, -h / 2, -d / 2],
  max: [w / 2, h / 2, d / 2],
});

const pose = (over: Partial<SceneDocRigPose> = {}): SceneDocRigPose => ({
  position: [0, 0, 5],
  aim: { mode: "point", at: [0, 0, 0] },
  ...over,
});

describe("frameContentDistance", () => {
  it("pins the distance a known box needs at a known lens", () => {
    // A 4-unit-tall box at fov 45 fits when half its height subtends 22.5 degrees.
    const bare = 2 / Math.tan((22.5 * Math.PI) / 180);
    expect(frameContentDistance(box(1, 4), 45, 16 / 9, 0)).toBeCloseTo(bare, 10);
  });

  it("fits on WIDTH when the box is wider than the frame's aspect", () => {
    const wide = frameContentDistance(box(20, 1), 45, 16 / 9, 0) ?? 0;
    const tall = frameContentDistance(box(1, 20), 45, 16 / 9, 0) ?? 0;
    expect(wide).toBeLessThan(tall); // the frame is wider than it is tall
    expect(wide).toBeGreaterThan(0);
  });

  it("leaves breathing room, and a narrower lens needs more distance", () => {
    const padded = frameContentDistance(box(1, 4), 45, 16 / 9) ?? 0;
    const bare = frameContentDistance(box(1, 4), 45, 16 / 9, 0) ?? 0;
    expect(padded).toBeGreaterThan(bare);
    expect(frameContentDistance(box(1, 4), 20, 16 / 9) ?? 0).toBeGreaterThan(padded);
  });

  it("measures from the box's front face, not its centre", () => {
    const flat = frameContentDistance(box(1, 4), 45, 16 / 9, 0) ?? 0;
    const deep = frameContentDistance(box(1, 4, 6), 45, 16 / 9, 0) ?? 0;
    expect(deep - flat).toBeCloseTo(3, 10);
  });

  it("has no answer for an empty box", () => {
    expect(frameContentDistance(box(0, 0), 45, 16 / 9)).toBeNull();
  });
});

describe("stagedContentBounds", () => {
  const frame = { width: 10, height: 5 };
  it("follows screenshot placement on top of the existing pose pan", () => {
    const bounds = stagedContentBounds(
      { layeredScreenshot: { pose: { pan: [0.5, -0.25] }, placement: { position: [0.4, 0.6] } } },
      frame,
    );
    expect((bounds.min[0] + bounds.max[0]) / 2).toBeCloseTo(2.5);
    expect((bounds.min[1] + bounds.max[1]) / 2).toBeCloseTo(1.25);
  });

  const windowed = (position: [number, number]): SceneDocMediaSpec[] => [
    {
      id: "vid1",
      kind: "video",
      src: "assets/clip.mp4",
      host: "overlay",
      stage: { position: [0, 0, 0], size: 5.3, rotationDeg: [0, 0, 0] },
      overlay: { position, size: 0.72, rotationDeg: 0, shape: "none", layer: "below" },
      window: { radius: "macos" },
    },
  ];

  it("follows a video's placement, resolved from frame fractions on the Overlay host", () => {
    const centred = stagedContentBounds({ media: windowed([0, 0]) }, frame);
    const moved = stagedContentBounds({ media: windowed([0.5, -0.4]) }, frame);
    expect((moved.min[0] + moved.max[0]) / 2 - (centred.min[0] + centred.max[0]) / 2).toBeCloseTo(
      2.5,
    );
    expect((moved.min[1] + moved.max[1]) / 2 - (centred.min[1] + centred.max[1]) / 2).toBeCloseTo(
      -1,
    );
  });

  it("reads a legacy videoWindow through the derived media view", () => {
    const legacy = stagedContentBounds(
      {
        videoWindow: {
          media: { src: "assets/clip.mp4" },
          radius: "macos",
          offset: [0.25, -0.2],
        },
      },
      frame,
    );
    expect(legacy).toEqual(stagedContentBounds({ media: windowed([0.5, -0.4]) }, frame));
  });

  it("ignores stills, which a reframe never chased", () => {
    const still = stagedContentBounds(
      {
        media: [
          {
            id: "img1",
            kind: "image",
            src: "assets/hero.png",
            host: "stage",
            stage: { position: [4, 4, 0], size: 1, rotationDeg: [0, 0, 0] },
            overlay: {
              position: [0, 0],
              size: 0.25,
              rotationDeg: 0,
              shape: "none",
              layer: "above",
            },
          },
        ],
      },
      frame,
    );
    expect(still).toEqual(stagedContentBounds(undefined, frame));
  });
});

describe("frameContentPose", () => {
  it("keeps the current view direction and centres the box", () => {
    const angled = pose({ position: [3, 3, 3], aim: { mode: "point", at: [0, 0, 0] } });
    const framed = frameContentPose(box(2, 2), angled, 45, 16 / 9);
    expect(framed).not.toBeNull();
    if (!framed) return;
    expect(framed.aim.at).toEqual([0, 0, 0]);
    // Same direction: the position stays on the ray it was already on.
    const ratio = framed.position[0] / 3;
    expect(framed.position[1] / 3).toBeCloseTo(ratio, 10);
    expect(framed.position[2] / 3).toBeCloseTo(ratio, 10);
  });

  it("frames an off-centre box by moving to it, not by re-angling", () => {
    const framed = frameContentPose({ min: [4, 1, -1], max: [6, 3, 1] }, pose(), 45, 16 / 9);
    expect(framed?.aim.at).toEqual([5, 2, 0]);
  });

  it("falls back to looking down -z when the current pose has no direction", () => {
    const degenerate = pose({ position: [1, 1, 1], aim: { mode: "point", at: [1, 1, 1] } });
    const framed = frameContentPose(box(2, 2), degenerate, 45, 16 / 9);
    expect(framed?.position[2]).toBeGreaterThan(0);
    expect(framed?.position[0]).toBeCloseTo(0, 10);
  });
});

describe("frameCoverDistance", () => {
  it("binds on the axis that runs out first, so the rect covers the frame", () => {
    const half = Math.tan((22.5 * Math.PI) / 180);
    // A portrait 1 x 2 rect at 16:9: the width runs out first.
    expect(frameCoverDistance(1, 2, 45, 16 / 9)).toBeCloseTo(0.5 / (half * (16 / 9)), 12);
    // A very wide rect: the height does.
    expect(frameCoverDistance(10, 1, 45, 16 / 9)).toBeCloseTo(0.5 / half, 12);
  });

  it("pushes in by the overscan and refuses a degenerate rect", () => {
    expect(frameCoverDistance(1, 2, 45, 16 / 9, 1.25)).toBeCloseTo(
      (frameCoverDistance(1, 2, 45, 16 / 9) ?? 0) / 1.25,
      12,
    );
    expect(frameCoverDistance(0, 2, 45, 16 / 9)).toBeNull();
  });
});

describe("screenFillPose", () => {
  /** The display's corners in normalised device coordinates, through a camera posed the way the export applies a rig pose. */
  function corners(
    model: string,
    device: DeviceScreenPose,
    fill: SceneDocRigPose,
    aspect = 16 / 9,
  ) {
    const camera = new PerspectiveCamera(45, aspect, 0.01, 100);
    applyCameraPose(camera, {
      position: fill.position,
      lookAt: fill.aim.at,
      fov: fill.fov ?? 45,
      rollDeg: fill.rollDeg,
    });
    camera.updateMatrixWorld();
    const [rx, ry, rz] = device.rotationDeg ?? [0, 0, 0];
    const turn = new Euler((rx * Math.PI) / 180, (ry * Math.PI) / 180, (rz * Math.PI) / 180);
    return (
      [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
        [0.5, 0.5],
      ] as const
    ).map(([u, v]) => {
      const p = new Vector3(...deviceScreenLocal(model, u, v, 0, device))
        .multiplyScalar(device.scale ?? 1)
        .applyEuler(turn)
        .add(new Vector3(...device.position))
        .project(camera);
      return { u, v, x: p.x, y: p.y };
    });
  }

  const cases: [string, DeviceScreenPose][] = [
    ["iphone-17-pro", { position: [0, -0.3, 0], scale: 0.92 }],
    ["android", { position: [1.2, 0.4, -0.5], rotationDeg: [-6, 14, 0] }],
    ["android", { position: [0, 0, 0], rotationDeg: [0, 0, 90], scale: 1.3 }],
    ["android", { position: [-0.4, 0.2, 0.3], rotationDeg: [12, -30, 8], scale: 0.8 }],
    ["macbook-pro-16", { position: [0, -0.6, 0], rotationDeg: [0, 18, 0], lidDeg: 110 }],
    ["ipad-pro-13", { position: [0.5, 0, 0], rotationDeg: [-10, 0, 0] }],
    ["iphone-duo", { position: [0, 0, 0], display: "cover", foldDeg: 0 }],
  ];

  for (const [model, device] of cases) {
    it(`fills the frame edge to edge with ${model} at ${JSON.stringify(device)}`, () => {
      const fill = screenFillPose(model, device, { fovDeg: 30 });
      expect(fill).not.toBeNull();
      if (!fill) return;
      const projected = corners(model, device, fill);
      const centre = projected[4];
      expect(centre.x).toBeCloseTo(0, 9);
      expect(centre.y).toBeCloseTo(0, 9);
      // Square on and level with the display: its edges run along the frame's axes.
      const [tl, tr, bl, br] = projected;
      expect(tl.y).toBeCloseTo(tr.y, 9);
      expect(bl.y).toBeCloseTo(br.y, 9);
      expect(tl.x).toBeCloseTo(bl.x, 9);
      expect(tr.x).toBeCloseTo(br.x, 9);
      expect(tl.x).toBeLessThan(tr.x);
      expect(tl.y).toBeGreaterThan(bl.y);
      // Covering: one axis lands on the frame edge exactly, the other overflows.
      const halfW = (tr.x - tl.x) / 2;
      const halfH = (tl.y - bl.y) / 2;
      expect(Math.min(halfW, halfH)).toBeCloseTo(1, 9);
      expect(Math.max(halfW, halfH)).toBeGreaterThanOrEqual(1 - 1e-9);
    });
  }

  it("writes its lens, stays level when it can, and pushes past the edges by the overscan", () => {
    const device: DeviceScreenPose = { position: [0, 0, 0] };
    const fill = screenFillPose("android", device, { overscan: 1.1 });
    expect(fill?.fov).toBe(45);
    expect(fill?.rollDeg).toBeUndefined();
    const projected = corners("android", device, fill as SceneDocRigPose);
    expect((projected[1].x - projected[0].x) / 2).toBeCloseTo(1.1, 9);
  });
});
