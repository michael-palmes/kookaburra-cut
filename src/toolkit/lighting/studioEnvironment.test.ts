import { Scene, Texture } from "three";
import { describe, expect, it } from "vitest";
import { holdStudioEnvironment } from "./studioEnvironment";

describe("holdStudioEnvironment", () => {
  it("applies the studio environment while any holder remains, then restores the previous values", () => {
    const scene = new Scene();
    const previous = new Texture();
    scene.environment = previous;
    scene.environmentIntensity = 0.4;
    scene.environmentRotation.set(0, 1.2, 0);
    const studio = new Texture();

    const releaseA = holdStudioEnvironment(scene, studio);
    const releaseB = holdStudioEnvironment(scene, studio);
    expect(scene.environment).toBe(studio);
    expect(scene.environmentIntensity).toBe(1);
    expect(scene.environmentRotation.y).toBe(0);

    releaseA();
    expect(scene.environment).toBe(studio);

    releaseB();
    expect(scene.environment).toBe(previous);
    expect(scene.environmentIntensity).toBe(0.4);
    expect(scene.environmentRotation.y).toBe(1.2);
  });

  it("restores the same values whichever holder lets go last", () => {
    const scene = new Scene();
    const studio = new Texture();
    const releaseA = holdStudioEnvironment(scene, studio);
    const releaseB = holdStudioEnvironment(scene, studio);
    releaseB();
    releaseA();
    expect(scene.environment).toBeNull();

    const releaseC = holdStudioEnvironment(scene, studio);
    expect(scene.environment).toBe(studio);
    releaseC();
    expect(scene.environment).toBeNull();
  });
});
