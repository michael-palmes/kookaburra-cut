import { ShaderLib } from "three";
import { describe, expect, it } from "vitest";
import { applyFlatCaps } from "./bars3d";

/** The flat-seam patch splices into three's own vertex chunks: a version bump that renamed an anchor would silently leave every stack rounded, so the injections are asserted here rather than discovered on a stage. */
describe("flat stack seams", () => {
  const patch = (vertical: boolean) => {
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: ShaderLib.physical.vertexShader,
      fragmentShader: ShaderLib.physical.fragmentShader,
    };
    applyFlatCaps(shader as never, [1, 2, 0.5], 0.1, vertical);
    return shader;
  };

  it("squares the ends its neighbours meet, from the per-instance flag", () => {
    const shader = patch(true);
    expect(shader.vertexShader).toContain("attribute vec2 instanceCap;");
    expect(shader.vertexShader).toContain("vec3 chartCore = clamp(transformed,");
    expect(shader.vertexShader).toContain("if (chartCapAt(chartAxial) > 0.5)");
    expect(shader.vertexShader).toContain("objectNormal = length(chartNormalLat)");
  });

  it("carries the baked box and the value axis as uniforms", () => {
    const column = patch(true);
    expect(column.uniforms.uChartCapR).toEqual({ value: 0.1 });
    expect(column.uniforms.uChartAxis).toMatchObject({ value: { x: 0, y: 1, z: 0 } });
    expect(column.uniforms.uChartHalf).toMatchObject({ value: { x: 1, y: 2, z: 0.5 } });
    expect(patch(false).uniforms.uChartAxis).toMatchObject({ value: { x: 1, y: 0, z: 0 } });
  });
});
