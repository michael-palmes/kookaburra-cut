import { createHash } from "node:crypto";
import { ShaderLib, UniformsUtils } from "three";
import { describe, expect, it } from "vitest";
import { createStaggerTextMaterial, type StaggerMaterialFeatures } from "./staggerMaterial";

/** The derived GLSL a mount compiles, through the same onBeforeCompile chain three runs. */
function programOf(features: StaggerMaterialFeatures): { vertex: string; fragment: string } {
  const mat = createStaggerTextMaterial(features);
  const info = {
    vertexShader: ShaderLib.basic.vertexShader,
    fragmentShader: ShaderLib.basic.fragmentShader,
    uniforms: UniformsUtils.clone(ShaderLib.basic.uniforms),
  };
  (
    mat.material as unknown as { onBeforeCompile: (s: typeof info, r: unknown) => void }
  ).onBeforeCompile(info, {});
  mat.dispose();
  return { vertex: info.vertexShader, fragment: info.fragmentShader };
}

const hashOf = (features: StaggerMaterialFeatures) => {
  const { vertex, fragment } = programOf(features);
  return createHash("sha1").update(`${vertex}\n----\n${fragment}`).digest("hex").slice(0, 12);
};

// Pinned before the emphasis and typewriter features landed: gated features must leave these programs byte-identical.
const LEGACY_PROGRAMS: Array<[string, StaggerMaterialFeatures, string]> = [
  ["none", {}, "0f6e94970693"],
  ["shine", { shine: true }, "0b90e81db50b"],
  ["axisY", { axis: "-y" }, "61ac696a9aa4"],
  ["twist", { twist: true }, "977823465359"],
  ["scatter", { scatter: true }, "285792aad6d1"],
  ["pack", { pack: true }, "1694fe8afc8d"],
  ["echo +1", { echo: 1 }, "724aea594f79"],
  ["echo -1", { echo: -1 }, "db8f0d2eb5ed"],
  ["glint", { shineTint: true, pack: true, shine: true }, "8d902b34f17e"],
  ["gradient", { gradient: true }, "256df5900bd4"],
  ["arc", { arc: true }, "0b298d76250a"],
  ["exactText", { exactText: true }, "0f6e94970693"],
  ["shine + pack", { shine: true, pack: true }, "2413634d9dee"],
  ["pack + gradient", { pack: true, gradient: true }, "0ead0928dd01"],
  ["twist + shine", { twist: true, shine: true }, "1524159302b9"],
];

describe("stagger material programs", () => {
  it.each(LEGACY_PROGRAMS)("%s compiles its legacy source", (_name, features, hash) => {
    expect(hashOf(features)).toBe(hash);
    expect(hashOf({ ...features, emphasis: false, typeMask: false })).toBe(hash);
  });

  it("emphasis rewrites troika's edge offset per glyph on both chains", () => {
    for (const features of [{ emphasis: true }, { emphasis: true, pack: true }]) {
      const { vertex, fragment } = programOf(features);
      expect(vertex.indexOf("float ganEmphG;")).toBeGreaterThan(-1);
      expect(vertex.indexOf("float ganEmphG;")).toBeLessThan(
        vertex.indexOf("void troikaVertexTransform"),
      );
      expect(vertex).toContain("bounds.xy - (uTroikaEdgeOffset + ganEmphG) - uTroikaBlurRadius");
      expect(vertex).toContain("bounds.zw + (uTroikaEdgeOffset + ganEmphG) + uTroikaBlurRadius");
      expect(fragment).toContain("troikaGetEdgeAlpha(fragDistance, uTroikaEdgeOffset + vGanEmphW,");
      expect(fragment).toContain("gl_FragColor.rgb = uGanEmphColor;");
    }
    const pack = programOf({ emphasis: true, pack: true });
    expect(pack.fragment).toContain("uTroikaEdgeOffset + vGanMixWS.y + vGanEmphW");
    expect(pack.fragment).not.toMatch(/if \(edgeAlpha == 0\.0\) \{\s*discard;\s*\}/);
  });

  it("the typewriter mask gates fragments on the head", () => {
    for (const features of [{ typeMask: true }, { typeMask: true, pack: true }]) {
      const { vertex, fragment } = programOf(features);
      expect(vertex).toContain("vGanType = (ganTypeC.y > uGanType.z");
      expect(fragment).toContain("if (vGanType < 0.5) discard;");
    }
  });
});
