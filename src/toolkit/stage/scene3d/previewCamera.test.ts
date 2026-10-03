import { describe, expect, it } from "vitest";
import { SCENE3D_BACKGROUNDS } from "./index";
import {
  SCENE3D_PREVIEW_POSES,
  SCENE3D_PREVIEW_SWEEP,
  scene3dPreviewCamera,
  scene3dPreviewCameraTrack,
} from "./previewCamera";

const PRESET_IDS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];

// Every generated preview-lab sidecar, keyed by path.
const labDocs = import.meta.glob<{ camera?: unknown }>(
  "../../../../fixtures/preview-lab-bg-*/scenes/*.json",
  { eager: true, import: "default" },
);

describe("scene3d preview cameras", () => {
  it("defaults grids to static and every other family to sweep, an explicit kind winning", () => {
    expect(scene3dPreviewCamera({ family: "grids" })).toBe("static");
    expect(scene3dPreviewCamera({ family: "kinetic" })).toBe("sweep");
    expect(scene3dPreviewCamera({ family: "grids", previewCamera: "sweep" })).toBe("sweep");
    expect(scene3dPreviewCamera({ family: "kinetic", previewCamera: "ceiling" })).toBe("ceiling");
  });

  it("holds one key for stills and static clips, and sweeps the orbiting kinds' clips", () => {
    expect(scene3dPreviewCameraTrack("static", true)).toEqual({
      keys: [{ id: "k1", tMs: 0, pose: SCENE3D_PREVIEW_POSES.static }],
      segments: [],
    });
    for (const kind of ["sweep", "ceiling"] as const) {
      const pose = SCENE3D_PREVIEW_POSES[kind];
      expect(scene3dPreviewCameraTrack(kind, false).keys).toEqual([{ id: "k1", tMs: 0, pose }]);
      const clip = scene3dPreviewCameraTrack(kind, true);
      expect(clip.keys.map((k) => k.pose)).toEqual(
        SCENE3D_PREVIEW_SWEEP.map((azimuthDeg) => ({ ...pose, azimuthDeg })),
      );
      expect(clip.segments).toEqual([{ from: "k1", to: "k2", ease: "inOutCubic" }]);
    }
  });

  it("frames ceiling looks from below a raised target, at the sweep's distance", () => {
    const { ceiling, sweep } = SCENE3D_PREVIEW_POSES;
    expect(ceiling.elevationDeg).toBeLessThan(0);
    expect(ceiling.target[1]).toBeGreaterThan(sweep.target[1]);
    expect(ceiling.distance).toBe(sweep.distance);
    expect(ceiling.azimuthDeg).toBe(sweep.azimuthDeg);
  });

  it("every look's preview-lab fixtures carry its kind's camera (rerun the generator after a change)", () => {
    let checked = 0;
    for (const [look, def] of Object.entries(SCENE3D_BACKGROUNDS)) {
      const kind = scene3dPreviewCamera(def);
      const dir = `../../../../fixtures/preview-lab-bg-${look}/scenes`;
      const stems: [string, boolean][] = [
        [`bg-${look}`, true],
        [`bg-${look}-light`, true],
        ...PRESET_IDS.map((id): [string, boolean] => [`bgp-${look}-${id}`, false]),
      ];
      for (const [stem, clip] of stems) {
        const doc = labDocs[`${dir}/${stem}.json`];
        expect(doc, stem).toBeDefined();
        expect(doc?.camera, stem).toEqual(scene3dPreviewCameraTrack(kind, clip));
        checked++;
      }
    }
    expect(checked).toBe(Object.keys(SCENE3D_BACKGROUNDS).length * 11);
  });
});
