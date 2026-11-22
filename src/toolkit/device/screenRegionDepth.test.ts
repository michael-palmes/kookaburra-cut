import { Layers, Mesh, PerspectiveCamera, PlaneGeometry, Vector2 } from "three";
import { describe, expect, it } from "vitest";
import { LENS_DEPTH_LAYER } from "../../engine/lensDepth";
import { asRegionDepthMesh, holdsFocusNow, regionDepthMaterial } from "./screenRegionDepth";

describe("regionDepthMaterial", () => {
  const card = { uSize: { value: new Vector2(1, 0.5) }, uRadius: { value: 0.1 } };

  it("writes depth and no colour", () => {
    const m = regionDepthMaterial(card);
    expect(m.colorWrite).toBe(false);
    expect(m.depthWrite).toBe(true);
    expect(m.depthTest).toBe(true);
    expect(m.transparent).toBe(true);
  });

  it("shares the card's shape uniforms", () => {
    const m = regionDepthMaterial(card);
    expect(m.uniforms.uSize).toBe(card.uSize);
    expect(m.uniforms.uRadius).toBe(card.uRadius);
  });
});

describe("holdsFocusNow", () => {
  it("mounts the depth copy only for a shape that shows", () => {
    expect(holdsFocusNow(1, 0.5, 1)).toBe(true);
    expect(holdsFocusNow(1, 0.5, 0.01)).toBe(true);
    expect(holdsFocusNow(1, 0.5, 0)).toBe(false);
    expect(holdsFocusNow(0, 0.5, 1)).toBe(false);
    expect(holdsFocusNow(1, 0, 1)).toBe(false);
  });
});

describe("asRegionDepthMesh", () => {
  it("leaves the mesh on the lens depth layer alone", () => {
    const mesh = new Mesh(new PlaneGeometry());
    asRegionDepthMesh(mesh);
    const lensOnly = new Layers();
    lensOnly.set(LENS_DEPTH_LAYER);
    expect(mesh.layers.mask).toBe(lensOnly.mask);
    expect(mesh.layers.test(new PerspectiveCamera().layers)).toBe(false);
  });
});
