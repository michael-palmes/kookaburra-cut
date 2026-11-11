import { MeshStandardMaterial, Object3D, ShaderLib } from "three";
import { describe, expect, it } from "vitest";
import { applyDeviceFinish, DEVICE_FINISHES } from "./finish";
import { GSAA_FRAGMENT } from "./gsaa";
import { gsaaChunk, SPECULAR_AA_FRAGMENT, SPECULAR_AA_GRAIN } from "./specularAA";

function compiled(material: MeshStandardMaterial | null): string {
  if (!material) throw new Error("no finish");
  const shader = {
    uniforms: {},
    vertexShader: ShaderLib.physical.vertexShader,
    fragmentShader: ShaderLib.physical.fragmentShader,
  };
  material.onBeforeCompile(shader as never, undefined as never);
  return shader.fragmentShader;
}

function frame(specularAA: boolean): MeshStandardMaterial {
  const source = new MeshStandardMaterial();
  source.name = "TITANIUM Brushed";
  return applyDeviceFinish(
    source,
    source.name,
    "iphone-15-pro",
    DEVICE_FINISHES.studio,
    new Object3D(),
    specularAA,
  ) as MeshStandardMaterial;
}

describe("specular AA", () => {
  it("keeps the legacy filter and program keys unless asked", () => {
    expect(gsaaChunk(false)).toEqual({ fragment: GSAA_FRAGMENT, key: "" });
    expect(gsaaChunk(true)).toEqual({ fragment: SPECULAR_AA_FRAGMENT, key: "-saa" });
    expect(frame(false).customProgramCacheKey()).toBe("kookaburra-device-finish-frame-v1");
    expect(frame(true).customProgramCacheKey()).toBe("kookaburra-device-finish-frame-v1-saa");
  });

  it("filters in GGX alpha space and refreshes the anisotropic alpha", () => {
    expect(SPECULAR_AA_FRAGMENT).toContain("sqrt( sqrt( saaAlpha * saaAlpha + saaKernel ) )");
    expect(SPECULAR_AA_FRAGMENT).toContain("material.alphaT =");
  });

  it("swaps both the roughness filter and the grain fade on the finish frame", () => {
    const legacy = compiled(frame(false));
    const saa = compiled(frame(true));
    expect(legacy).toContain("gsaaVariance");
    expect(legacy).not.toContain("0.3183099");
    expect(saa).toContain("0.3183099");
    expect(saa).not.toContain("gsaaVariance");
    expect(saa).toContain(SPECULAR_AA_GRAIN.trim());
    expect(legacy).toContain("clamp( 2.0 - kbFw * 3.0, 0.0, 1.0 )");
  });
});
