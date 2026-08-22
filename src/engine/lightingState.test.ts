import { Object3D, PerspectiveCamera, RectAreaLight, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import type { CameraPose } from "./cameraTrack";
import { applyRelativeLights, registerRelativeLight, relativeLightCount } from "./lightingState";

const pose = (
  position: [number, number, number],
  lookAt: [number, number, number],
): CameraPose => ({
  position,
  lookAt,
  fov: 45,
});

function cameraAt(p: CameraPose): PerspectiveCamera {
  const camera = new PerspectiveCamera(p.fov, 16 / 9);
  camera.position.set(...p.position);
  camera.lookAt(...p.lookAt);
  camera.updateMatrixWorld();
  return camera;
}

describe("applyRelativeLights", () => {
  it("is a hard no-op with nothing registered", () => {
    const camera = cameraAt(pose([0, 0, 5], [0, 0, 0]));
    expect(relativeLightCount()).toBe(0);
    expect(() => applyRelativeLights(camera, null)).not.toThrow();
  });

  it("camera space rides the camera rigidly", () => {
    const light = new Object3D();
    const unregister = registerRelativeLight("t1", {
      object: light,
      targetObject: null,
      aimSelf: false,
      spec: {
        space: "camera",
        placement: { mode: "point", position: [1, 0, 0] },
        target: [0, 0, 0],
      },
    });
    try {
      // Camera at origin looking down -Z: camera x == world x.
      applyRelativeLights(cameraAt(pose([0, 0, 0], [0, 0, -1])), null);
      expect(light.position.x).toBeCloseTo(1, 6);
      expect(light.position.z).toBeCloseTo(0, 6);
      // Camera rotated 90°, now looking down -X: camera x maps to world -Z.
      applyRelativeLights(cameraAt(pose([0, 0, 0], [-1, 0, 0])), null);
      expect(light.position.x).toBeCloseTo(0, 6);
      expect(light.position.z).toBeCloseTo(-1, 6);
    } finally {
      unregister();
    }
  });

  it("THE TRANSITION TRAP: two different cameras in sequence resolve two different transforms", () => {
    const light = new Object3D();
    const target = new Object3D();
    const unregister = registerRelativeLight("t2", {
      object: light,
      targetObject: target,
      aimSelf: false,
      spec: {
        space: "camera",
        placement: { mode: "point", position: [0, 0, -2] },
        target: [0, 0, -5],
      },
    });
    try {
      const a = pose([0, 0, 5], [0, 0, 0]);
      const b = pose([10, 0, 0], [0, 0, 0]);
      applyRelativeLights(cameraAt(a), a);
      const posA = light.position.clone();
      const aimA = target.position.clone();
      applyRelativeLights(cameraAt(b), b);
      const posB = light.position.clone();
      // A: 2 units in front of a camera at z=5 -> world [0, 0, 3].
      expect(posA.toArray().map((v) => +v.toFixed(5) + 0)).toEqual([0, 0, 3]);
      expect(aimA.toArray().map((v) => +v.toFixed(5) + 0)).toEqual([0, 0, 0]);
      // B: 2 units in front of a camera at x=10 looking at the origin -> world [8, 0, 0].
      expect(posB.toArray().map((v) => +v.toFixed(5) + 0)).toEqual([8, 0, 0]);
      // Re-applying A must reproduce A exactly (nothing accumulates).
      applyRelativeLights(cameraAt(a), a);
      expect(light.position.toArray().map((v) => +v.toFixed(5) + 0)).toEqual([0, 0, 3]);
    } finally {
      unregister();
    }
  });

  it("samples light and fixture placement for the matching transition target", () => {
    const light = new Object3D();
    const fixture = new Object3D();
    const cleanups = [
      registerRelativeLight("sample-light", {
        object: light,
        targetObject: null,
        aimSelf: false,
        spec: {
          space: "camera",
          placement: { mode: "point", position: [0, 0, -1] },
        },
        target: { sceneIndex: 2, kind: "light", id: "rim" },
      }),
      registerRelativeLight("sample-fixture", {
        object: fixture,
        targetObject: null,
        aimSelf: false,
        orient: true,
        spec: {
          space: "camera",
          placement: { mode: "point", position: [0, 0, -2] },
        },
        target: { sceneIndex: 2, kind: "fixture", id: "tube" },
      }),
    ];
    try {
      const cameraPose = pose([0, 0, 5], [0, 0, 0]);
      const camera = cameraAt(cameraPose);
      applyRelativeLights(camera, cameraPose, {
        index: 2,
        pose: {
          lights: { rim: { placement: { mode: "point", position: [1, 0, -3] } } },
          fixtures: { tube: { placement: { mode: "point", position: [-1, 2, -4] } } },
        },
      });
      expect(light.position.toArray().map((v) => +v.toFixed(5) + 0)).toEqual([1, 0, 2]);
      expect(fixture.position.toArray().map((v) => +v.toFixed(5) + 0)).toEqual([-1, 2, 1]);

      applyRelativeLights(camera, cameraPose, { index: 1, pose: {} });
      expect(light.position.toArray().map((v) => +v.toFixed(5) + 0)).toEqual([0, 0, 4]);
      expect(fixture.position.toArray().map((v) => +v.toFixed(5) + 0)).toEqual([0, 0, 3]);
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
  });

  it("subject space: azimuth 0 points from the subject toward the camera", () => {
    const light = new Object3D();
    const unregister = registerRelativeLight("t3", {
      object: light,
      targetObject: null,
      aimSelf: false,
      spec: {
        space: "subject",
        placement: { mode: "orbit", azimuthDeg: 0, elevationDeg: 0, distance: 3 },
        target: [0, 0, 0],
      },
    });
    try {
      // Camera due +X of the subject at [1, 0, 0]: the frontal key sits between them.
      const p = pose([5, 0, 0], [1, 0, 0]);
      applyRelativeLights(cameraAt(p), p);
      expect(light.position.toArray().map((v) => +v.toFixed(5) + 0)).toEqual([4, 0, 0]);
      // The camera swings to -Z of the subject; the light follows around.
      const q = pose([1, 0, -6], [1, 0, 0]);
      applyRelativeLights(cameraAt(q), q);
      expect(light.position.toArray().map((v) => +v.toFixed(5) + 0)).toEqual([1, 0, -3]);
    } finally {
      unregister();
    }
  });

  it("subject space falls back to the world origin without a pose (the legacy path)", () => {
    const light = new Object3D();
    const unregister = registerRelativeLight("t4", {
      object: light,
      targetObject: null,
      aimSelf: false,
      spec: {
        space: "subject",
        placement: { mode: "orbit", azimuthDeg: 0, elevationDeg: 0, distance: 2 },
        target: [0, 0, 0],
      },
    });
    try {
      applyRelativeLights(cameraAt(pose([0, 0, 5], [0, 0, 0])), null);
      expect(light.position.toArray().map((v) => +v.toFixed(5) + 0)).toEqual([0, 0, 2]);
    } finally {
      unregister();
    }
  });

  it("THE DEAD RIM TRAP: a camera-space light with no target aims at the subject, not the lens", () => {
    // A rectAreaLight, not a bare Object3D: three's lookAt points -Z at the target for lights and
    // +Z for everything else, so a plain object would assert the opposite convention.
    const light = new RectAreaLight(0xffffff, 1, 1, 3);
    const unregister = registerRelativeLight("t6", {
      object: light,
      targetObject: null,
      aimSelf: true,
      spec: {
        space: "camera",
        placement: { mode: "point", position: [2, 0, -1] },
      },
    });
    try {
      const p = pose([0, 0, 6], [0, 0, 0]);
      applyRelativeLights(cameraAt(p), p);
      // Right of a camera at z=6 and 1 unit in front of it.
      expect(light.position.toArray().map((v) => +v.toFixed(5) + 0)).toEqual([2, 0, 5]);
      const forward = new Vector3(0, 0, -1).applyQuaternion(light.quaternion);
      const toSubject = new Vector3(0, 0, 0).sub(light.position).normalize();
      expect(forward.dot(toSubject)).toBeCloseTo(1, 5);
    } finally {
      unregister();
    }
  });

  it("an explicit camera-space target still reads in the camera's own frame", () => {
    const light = new Object3D();
    const target = new Object3D();
    const unregister = registerRelativeLight("t7", {
      object: light,
      targetObject: target,
      aimSelf: false,
      spec: {
        space: "camera",
        placement: { mode: "point", position: [0, 0, -1] },
        target: [0, 0, -4],
      },
    });
    try {
      const p = pose([0, 0, 6], [0, 0, 0]);
      applyRelativeLights(cameraAt(p), p);
      // 4 in front of a camera at z=6, NOT the subject at the origin.
      expect(target.position.toArray().map((v) => +v.toFixed(5) + 0)).toEqual([0, 0, 2]);
    } finally {
      unregister();
    }
  });

  it("a defaulted aim falls back to the world origin without a pose", () => {
    const light = new Object3D();
    const target = new Object3D();
    const unregister = registerRelativeLight("t8", {
      object: light,
      targetObject: target,
      aimSelf: false,
      spec: {
        space: "camera",
        placement: { mode: "point", position: [2, 1, -1] },
      },
    });
    try {
      applyRelativeLights(cameraAt(pose([0, 0, 6], [0, 0, 0])), null);
      expect(target.position.toArray().map((v) => +v.toFixed(5) + 0)).toEqual([0, 0, 0]);
    } finally {
      unregister();
    }
  });

  it("unregister empties the registry", () => {
    const unregister = registerRelativeLight("t5", {
      object: new Object3D(),
      targetObject: null,
      aimSelf: false,
      spec: {
        space: "camera",
        placement: { mode: "point", position: [0, 0, 0] },
        target: [0, 0, 0],
      },
    });
    expect(relativeLightCount()).toBe(1);
    unregister();
    expect(relativeLightCount()).toBe(0);
  });
});
