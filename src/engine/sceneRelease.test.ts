import { Group, SpotLight, WebGLRenderTarget } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSceneHost, unregisterSceneHost } from "./sceneHostRegistry";
import {
  registerSceneRelease,
  releaseScene,
  scenesPassed,
  setSceneReleaseEnabled,
} from "./sceneRelease";
import type { SceneSlot } from "./sceneTimeline";

const slot = (index: number, startMs: number, endMs: number): SceneSlot => ({
  index,
  id: `s${index}`,
  startMs,
  endMs,
  durationMs: endMs - startMs,
});

describe("scenesPassed", () => {
  const slots = [slot(0, 0, 1000), slot(1, 800, 2000), slot(2, 2000, 3000)];

  it("keeps a scene through its last frame and a transition's overlap", () => {
    expect(scenesPassed(slots, 0)).toEqual([]);
    expect(scenesPassed(slots, 999)).toEqual([]);
    expect(scenesPassed(slots, 1000)).toEqual([0]);
    expect(scenesPassed(slots, 1999)).toEqual([0]);
    expect(scenesPassed(slots, 2000)).toEqual([0, 1]);
  });

  it("never releases the last scene, which holds the end frame", () => {
    expect(scenesPassed(slots, 3000)).toEqual([0, 1]);
    expect(scenesPassed(slots, 99_999)).toEqual([0, 1]);
    expect(scenesPassed([slot(0, 0, 1000)], 5000)).toEqual([]);
  });
});

describe("releaseScene", () => {
  afterEach(() => setSceneReleaseEnabled(true));

  it("calls only the scene's own owners, on both comparison sides", () => {
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    const offs = [
      registerSceneRelease(3, a),
      registerSceneRelease(3, b),
      registerSceneRelease(4, other),
    ];
    releaseScene(3);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    for (const off of offs) off();
  });

  it("forgets an owner that unmounted", () => {
    const a = vi.fn();
    registerSceneRelease(5, a)();
    releaseScene(5);
    expect(a).not.toHaveBeenCalled();
  });

  it("does nothing under the probe's off lever", () => {
    const a = vi.fn();
    const off = registerSceneRelease(6, a);
    setSceneReleaseEnabled(false);
    releaseScene(6);
    expect(a).not.toHaveBeenCalled();
    off();
  });

  it("lets the scene's own shadow maps go, never another scene's", () => {
    const lit = (index: number) => {
      const group = new Group();
      const light = new SpotLight();
      light.shadow.map = new WebGLRenderTarget(4, 4);
      group.add(light);
      registerSceneHost(`host-${index}`, {
        index,
        id: `s${index}`,
        startMs: 0,
        durationMs: 1,
        group,
      });
      return vi.spyOn(light.shadow, "dispose");
    };
    const mine = lit(7);
    const theirs = lit(8);
    releaseScene(7);
    expect(mine).toHaveBeenCalledOnce();
    expect(theirs).not.toHaveBeenCalled();
    unregisterSceneHost("host-7");
    unregisterSceneHost("host-8");
  });
});
