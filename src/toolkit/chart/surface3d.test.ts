import { MeshPhysicalMaterial, ShaderLib } from "three";
import { describe, expect, it } from "vitest";
import { CHART_STYLE_PRESETS } from "./stylePresets";
import { isPhysicalFinish, makeChartMaterial } from "./surface3d";
import type { ChartStyleSurface3D } from "./types";

const finishOf = (id: string): ChartStyleSurface3D => CHART_STYLE_PRESETS[id].surface.threed;

/** The shader three hands `onBeforeCompile`, with the standard material's own source: the anchors these patches splice into are an upstream contract. */
const compile = (material: {
  onBeforeCompile: (shader: never, renderer: never) => void;
}): { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> } => {
  const shader = {
    uniforms: {} as Record<string, unknown>,
    vertexShader: ShaderLib.physical.vertexShader,
    fragmentShader: ShaderLib.physical.fragmentShader,
  };
  material.onBeforeCompile(shader as never, undefined as never);
  return shader;
};

describe("chart mark materials", () => {
  it("stays a standard material until a preset asks for gloss or glass", () => {
    const boardroom = finishOf("boardroom");
    expect(isPhysicalFinish(boardroom)).toBe(false);
    const material = makeChartMaterial(boardroom, { cacheKey: "test" });
    expect(material).not.toBeInstanceOf(MeshPhysicalMaterial);
    expect(material.roughness).toBe(boardroom.roughness);
    expect(material.metalness).toBe(boardroom.metalness);
    material.dispose();
  });

  it("builds a physical dielectric for a glass preset", () => {
    const glass = finishOf("glass");
    expect(isPhysicalFinish(glass)).toBe(true);
    const material = makeChartMaterial(glass, { cacheKey: "test" }) as MeshPhysicalMaterial;
    expect(material).toBeInstanceOf(MeshPhysicalMaterial);
    expect(material.transmission).toBe(glass.transmission);
    expect(material.thickness).toBe(glass.thickness);
    expect(material.ior).toBe(glass.ior);
    expect(material.clearcoat).toBe(glass.clearcoat);
    expect(material.metalness).toBe(0);
    material.dispose();
  });

  it("goes physical for a clearcoat preset that never refracts", () => {
    const studio = finishOf("studio");
    const material = makeChartMaterial(studio, { cacheKey: "test" }) as MeshPhysicalMaterial;
    expect(material).toBeInstanceOf(MeshPhysicalMaterial);
    expect(material.clearcoat).toBe(studio.clearcoat);
    expect(material.transmission).toBe(0);
    material.dispose();
  });

  it("adds the edge rim only for a glowing preset, and composes the caller's own patch under it", () => {
    const neon = makeChartMaterial(finishOf("neonLedger"), {
      cacheKey: "test",
      patch: (shader) => {
        shader.vertexShader = `// caller\n${shader.vertexShader}`;
      },
    });
    const glow = compile(neon);
    expect(glow.vertexShader).toContain("// caller");
    expect(glow.fragmentShader).toContain("uniform float uChartEdge;");
    expect(glow.fragmentShader).toContain("totalEmissiveRadiance += diffuseColor.rgb * uChartEdge");
    expect(glow.uniforms.uChartEdge).toBeDefined();
    neon.dispose();

    const plain = makeChartMaterial(finishOf("boardroom"), { cacheKey: "test" });
    expect(compile(plain).fragmentShader).not.toContain("uChartEdge");
    plain.dispose();
  });

  it("keys glowing and glassy programs apart from the plain one", () => {
    const plain = makeChartMaterial(finishOf("boardroom"), { cacheKey: "bars" });
    const glass = makeChartMaterial(finishOf("glass"), { cacheKey: "bars" });
    const neon = makeChartMaterial(finishOf("neonLedger"), { cacheKey: "bars" });
    const keys = [plain, glass, neon].map((m) => m.customProgramCacheKey());
    expect(new Set(keys).size).toBe(3);
    for (const material of [plain, glass, neon]) material.dispose();
  });
});
