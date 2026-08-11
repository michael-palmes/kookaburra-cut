import { describe, expect, it } from "vitest";
import { isSceneImageSource, type SceneDoc } from "./sceneDocSchema";
import { createSceneImage, sceneImagesForHost, switchSceneImageHost } from "./sceneImage";

describe("scene images", () => {
  it("accepts supported project image paths and rejects unsafe paths and GIFs", () => {
    expect(isSceneImageSource("assets/brand/hero.PNG")).toBe(true);
    expect(isSceneImageSource("assets/Kākāpō @2 (final).WebP")).toBe(true);
    expect(isSceneImageSource("assets/photo.jpeg")).toBe(true);
    expect(isSceneImageSource("assets/../outside.png")).toBe(false);
    expect(isSceneImageSource("assets/animated.gif")).toBe(false);
    expect(isSceneImageSource("/tmp/hero.png")).toBe(false);
  });

  it("creates an image with independent explicit placements", () => {
    const image = createSceneImage("img1", "assets/hero.png", "stage");

    expect(image).toEqual({
      id: "img1",
      src: "assets/hero.png",
      host: "stage",
      stage: { position: [0, 0, 0], size: 1, rotationDeg: [0, 0, 0] },
      overlay: {
        position: [0, 0],
        size: 0.25,
        rotationDeg: 0,
        shape: "none",
        layer: "above",
      },
    });
  });

  it("switches only the active host and retains both authored placements", () => {
    const image = createSceneImage("img1", "assets/hero.png", "stage");
    image.stage.position = [1, 2, 3];
    image.overlay.position = [-0.5, 0.75];

    const switched = switchSceneImageHost(image, "overlay");

    expect(switched.host).toBe("overlay");
    expect(switched.stage.position).toEqual([1, 2, 3]);
    expect(switched.overlay.position).toEqual([-0.5, 0.75]);
    expect(image.host).toBe("stage");
    expect(switchSceneImageHost(switched, "overlay")).toBe(switched);
  });

  it("filters the ordered image list by host without changing its order", () => {
    const doc: SceneDoc = {
      version: 1,
      images: [
        createSceneImage("img1", "assets/one.png", "overlay"),
        createSceneImage("img2", "assets/two.png", "stage"),
        createSceneImage("img3", "assets/three.png", "overlay"),
      ],
    };

    expect(sceneImagesForHost(doc, "overlay").map((image) => image.id)).toEqual(["img1", "img3"]);
    expect(sceneImagesForHost(doc, "stage").map((image) => image.id)).toEqual(["img2"]);
    expect(sceneImagesForHost(undefined, "stage")).toEqual([]);
  });
});
