import { Color } from "three";
import { describe, expect, it } from "vitest";
import { EDGE_SENTINEL, GLINT_INTENSITY, type StaggerUnits, type TextUnitSample } from "./presets";
import {
  createStaggerTextMaterial,
  writeArcUniforms,
  writeGlintUniforms,
  writeGradientUniforms,
  writeHeldShineUniforms,
  writeStaggerUniforms,
} from "./staggerMaterial";

const neutralSample = (over: Partial<TextUnitSample> = {}): TextUnitSample => ({
  alpha: 1,
  dxEm: 0,
  dyEm: 0,
  scale: 1,
  blurEm: 0,
  sweep: [0, 1],
  rotYRad: 0,
  shineU: -1,
  rotZRad: 0,
  dzEm: 0,
  rotXRad: 0,
  scaleX: 1,
  scaleY: 1,
  clipFinal: false,
  colorMix: 0,
  weightEm: 0,
  softEm: 0,
  chromaEm: 0,
  highlight: [0, 0],
  ...over,
});

const S = Math.fround(1e30);

const twoUnits = (): StaggerUnits => ({
  count: 2,
  startX: new Float32Array([0, 2]),
  endX: new Float32Array([1.5, 3]),
  edgeKey: new Float32Array([1.75, EDGE_SENTINEL]),
  centerY: new Float32Array([0.1, -0.2]),
  axis: "x",
});

describe("createStaggerTextMaterial pack variants", () => {
  it("legacy mounts carry no pack uniforms", () => {
    const mat = createStaggerTextMaterial({ shine: true, twist: true });
    expect(mat.material.uniforms.uGanUnitD).toBeUndefined();
    expect(mat.material.uniforms.uGanAccent).toBeUndefined();
    expect(mat.material.uniforms.uGanShineTint).toBeUndefined();
    expect(mat.features.pack).toBe(false);
    mat.dispose();
  });

  it("pack mounts the sandwich with twist + scatter and the three new arrays", () => {
    const mat = createStaggerTextMaterial({ pack: true });
    expect(mat.features).toMatchObject({ pack: true, twist: true, scatter: true });
    expect(mat.material.uniforms.uGanUnitC.value).toHaveLength(32 * 4);
    expect(mat.material.uniforms.uGanUnitD.value[1]).toBe(1);
    expect(mat.material.uniforms.uGanUnitF.value[2]).toBe(S);
    expect(mat.material.uniforms.uGanAccent.value).toBeInstanceOf(Color);
    mat.dispose();
  });

  it("echo implies pack; shineTint implies shine", () => {
    const echo = createStaggerTextMaterial({ echo: -1 });
    expect(echo.features.pack).toBe(true);
    expect(echo.features.echo).toBe(-1);
    echo.dispose();
    const glint = createStaggerTextMaterial({ shineTint: true, pack: true });
    expect(glint.features.shine).toBe(true);
    expect(glint.material.uniforms.uGanShineTint.value).toBeInstanceOf(Color);
    glint.dispose();
  });
});

describe("writeStaggerUniforms pack routing", () => {
  it("neutral samples upload neutral pack arrays and route scale to D", () => {
    const mat = createStaggerTextMaterial({ pack: true });
    const units = twoUnits();
    writeStaggerUniforms(mat, units, [neutralSample(), neutralSample()], 0.5, {
      accent: new Color(1, 0, 0),
    });
    const a: Float32Array = mat.material.uniforms.uGanUnitA.value;
    const d: Float32Array = mat.material.uniforms.uGanUnitD.value;
    const e: Float32Array = mat.material.uniforms.uGanUnitE.value;
    const f: Float32Array = mat.material.uniforms.uGanUnitF.value;
    for (const i of [0, 1]) {
      expect(a[i * 4 + 3]).toBe(1);
      expect(Array.from(d.slice(i * 4, i * 4 + 4))).toEqual([0, 1, 1, 0]);
      expect(Array.from(e.slice(i * 4, i * 4 + 3))).toEqual([0, 0, 0]);
      expect(Array.from(f.slice(i * 4, i * 4 + 4))).toEqual([-S, -S, S, S]);
    }
    expect(e[3]).toBeCloseTo(0.1);
    expect(e[7]).toBeCloseTo(-0.2);
    mat.dispose();
  });

  it("composes scale into D, pre-multiplies em fields and uploads clip rects", () => {
    const mat = createStaggerTextMaterial({ pack: true });
    const units = twoUnits();
    const samples = [
      neutralSample({ scale: 2, scaleX: 1.5, scaleY: 0.5, colorMix: 0.25 }),
      neutralSample({ weightEm: -0.04, softEm: 0.3, chromaEm: 0.12, clipFinal: true }),
    ];
    const clipRects = new Float32Array([0, 0, 0, 0, 1.8, -0.4, 3.2, 0.4]);
    writeStaggerUniforms(mat, units, samples, 0.5, { accent: new Color("#ff8800"), clipRects });
    const a: Float32Array = mat.material.uniforms.uGanUnitA.value;
    const d: Float32Array = mat.material.uniforms.uGanUnitD.value;
    const e: Float32Array = mat.material.uniforms.uGanUnitE.value;
    const f: Float32Array = mat.material.uniforms.uGanUnitF.value;
    expect(a[3]).toBe(1);
    expect(d[1]).toBeCloseTo(3);
    expect(d[2]).toBeCloseTo(1);
    expect(d[3]).toBeCloseTo(0.25);
    expect(e[4]).toBeCloseTo(-0.02);
    expect(e[5]).toBeCloseTo(0.15);
    expect(e[6]).toBeCloseTo(0.06);
    expect(Array.from(f.slice(0, 4))).toEqual([-S, -S, S, S]);
    const expected = [1.8, -0.4, 3.2, 0.4];
    for (let i = 0; i < 4; i++) expect(f[4 + i]).toBeCloseTo(expected[i]);
    mat.dispose();
  });

  it("legacy mounts stay on the legacy write path", () => {
    const mat = createStaggerTextMaterial({ twist: true });
    writeStaggerUniforms(mat, twoUnits(), [neutralSample({ scale: 2 }), neutralSample()], 0.5);
    const a: Float32Array = mat.material.uniforms.uGanUnitA.value;
    expect(a[3]).toBe(2);
    mat.dispose();
  });
});

describe("look extension variants", () => {
  it("legacy and pack mounts carry no look uniforms", () => {
    for (const features of [{}, { pack: true }, { shine: true, twist: true }]) {
      const mat = createStaggerTextMaterial(features);
      expect(mat.material.uniforms.uGanGrad).toBeUndefined();
      expect(mat.material.uniforms.uGanArc).toBeUndefined();
      expect(mat.features.gradient).toBe(false);
      expect(mat.features.arc).toBe(false);
      mat.dispose();
    }
  });

  it("gradient mounts its uniforms with the neutral-guard defaults", () => {
    const mat = createStaggerTextMaterial({ gradient: true });
    expect(mat.features.gradient).toBe(true);
    expect(mat.material.uniforms.uGanGrad.value.w).toBe(0);
    expect(mat.material.uniforms.uGanGradA.value).toBeInstanceOf(Color);
    expect(mat.material.uniforms.uGanGradB.value).toBeInstanceOf(Color);
    mat.dispose();
  });

  it("arc mounts its uniform at the exact identity and composes with pack", () => {
    const mat = createStaggerTextMaterial({ arc: true, pack: true });
    expect(mat.features.arc).toBe(true);
    expect(mat.features.pack).toBe(true);
    expect(mat.material.uniforms.uGanArc.value.x).toBe(0);
    mat.dispose();
  });
});

describe("writeGradientUniforms / writeArcUniforms", () => {
  it("writes the span and colours, and parks invRange when unmeasured", () => {
    const mat = createStaggerTextMaterial({ gradient: true });
    const a = new Color("#ff0055");
    const b = new Color("#220011");
    writeGradientUniforms(mat, { ax: 0, ay: 1, sHi: 0.5, invRange: 2 }, a, b);
    const grad = mat.material.uniforms.uGanGrad.value;
    expect([grad.x, grad.y, grad.z, grad.w]).toEqual([0, 1, 0.5, 2]);
    expect(mat.material.uniforms.uGanGradA.value.getHex()).toBe(a.getHex());
    expect(mat.material.uniforms.uGanGradB.value.getHex()).toBe(b.getHex());
    writeGradientUniforms(mat, null, a, b);
    expect(mat.material.uniforms.uGanGrad.value.w).toBe(0);
    mat.dispose();
  });

  it("writes the arc spec and parks the identity on null", () => {
    const mat = createStaggerTextMaterial({ arc: true });
    writeArcUniforms(mat, { invRadius: 0.25, centerX: 1.5 });
    const arc = mat.material.uniforms.uGanArc.value;
    expect([arc.x, arc.y]).toEqual([0.25, 1.5]);
    writeArcUniforms(mat, null);
    expect(mat.material.uniforms.uGanArc.value.x).toBe(0);
    mat.dispose();
  });

  it("no-ops on mounts without the look", () => {
    const mat = createStaggerTextMaterial({ pack: true });
    expect(() => {
      writeGradientUniforms(mat, null, new Color("#fff"), new Color("#000"));
      writeArcUniforms(mat, { invRadius: 1, centerX: 0 });
    }).not.toThrow();
    mat.dispose();
  });
});

describe("writeHeldShineUniforms", () => {
  it("holds a band at the given u with the given intensity and tint", () => {
    const mat = createStaggerTextMaterial({ shineTint: true });
    const tint = new Color("#cfe4ff");
    writeHeldShineUniforms(mat, [-1, -0.5, 1, 0.5], 0.5, 0.13, tint);
    const shine = mat.material.uniforms.uGanShine.value;
    expect(shine.w).toBe(1);
    expect(shine.z).toBeCloseTo(0.13);
    expect(mat.material.uniforms.uGanShineTint.value.getHex()).toBe(tint.getHex());
    mat.dispose();
  });

  it("parks the band when unmeasured or at zero intensity, and no-ops without the feature", () => {
    const mat = createStaggerTextMaterial({ shineTint: true });
    writeHeldShineUniforms(mat, null, 0.5, 0.13);
    expect(mat.material.uniforms.uGanShine.value.w).toBe(0);
    writeHeldShineUniforms(mat, [-1, -0.5, 1, 0.5], 0.5, 0);
    expect(mat.material.uniforms.uGanShine.value.w).toBe(0);
    mat.dispose();
    const bare = createStaggerTextMaterial({});
    expect(() => writeHeldShineUniforms(bare, [-1, -0.5, 1, 0.5], 0.5, 0.13)).not.toThrow();
    bare.dispose();
  });
});

describe("writeGlintUniforms", () => {
  it("writes the tinted band with the glint intensity", () => {
    const mat = createStaggerTextMaterial({ pack: true, shineTint: true });
    const tint = new Color("#22ccff");
    writeGlintUniforms(mat, [-1, -0.5, 1, 0.5], 0.5, tint);
    const shine = mat.material.uniforms.uGanShine.value;
    expect(shine.w).toBe(1);
    expect(shine.z).toBe(GLINT_INTENSITY);
    expect(mat.material.uniforms.uGanShineTint.value.getHex()).toBe(tint.getHex());
    mat.dispose();
  });

  it("parks the band off when shine is off or unmeasured", () => {
    const mat = createStaggerTextMaterial({ pack: true, shineTint: true });
    writeGlintUniforms(mat, null, 0.5, new Color("#fff"));
    expect(mat.material.uniforms.uGanShine.value.w).toBe(0);
    writeGlintUniforms(mat, [-1, -0.5, 1, 0.5], -1, new Color("#fff"));
    expect(mat.material.uniforms.uGanShine.value.w).toBe(0);
    mat.dispose();
  });

  it("no-ops on mounts without the tinted band", () => {
    const mat = createStaggerTextMaterial({ shine: true });
    expect(() => writeGlintUniforms(mat, [-1, -0.5, 1, 0.5], 0.5, new Color("#fff"))).not.toThrow();
    mat.dispose();
  });
});
