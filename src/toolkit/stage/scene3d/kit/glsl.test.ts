import { describe, expect, it } from "vitest";
import { pcgHash01 } from "../../shaders/utils";
import * as glsl from "./glsl";
import { STAGE_FADE_WINDOW } from "./stage";

const chunks = Object.entries(glsl).filter(
  (entry): entry is [string, string] => typeof entry[1] === "string",
);
const FRAGMENT_ONLY = /\b(fwidth|dFdx|dFdy)\s*\(/;
const declares = (source: string, fn: string) => new RegExp(`\\b${fn}\\s*\\(`).test(source);

describe("look GLSL chunks", () => {
  it("never hash with fract(sin())", () => {
    expect(chunks.length).toBeGreaterThan(8);
    for (const [name, source] of chunks) expect(/fract\s*\(\s*sin/.test(source), name).toBe(false);
  });

  it("keep derivatives out of everything a vertex shader receives", () => {
    expect(FRAGMENT_ONLY.test(glsl.LOOK_GLSL_VERTEX)).toBe(false);
    expect(FRAGMENT_ONLY.test(glsl.LOOK_VERTEX_SHADER)).toBe(false);
    expect(FRAGMENT_ONLY.test(glsl.LOOK_GLSL_AA)).toBe(true);
  });

  it("keep attributes and projectionMatrix out of the fragment kit", () => {
    for (const token of [
      "instanceMatrix",
      "instanceColor",
      "projectionMatrix",
      "lookWorldPosition",
    ]) {
      expect(glsl.LOOK_GLSL_FRAGMENT.includes(token), token).toBe(false);
    }
  });

  it("mix exactly like the house PCG hash", () => {
    const mixLine = "uint h = v.x * 374761393u ^ v.y * 668265263u ^ v.z * 2246822519u;";
    expect(pcgHash01).toContain(mixLine);
    expect(glsl.LOOK_GLSL_HASH).toContain(mixLine);
    expect(glsl.LOOK_GLSL_HASH).toContain("return float(h & 0x00FFFFFFu) / 16777216.0;");
  });

  it("pin the public helper names", () => {
    const vertexSafe = [
      "hash11",
      "hash21",
      "hash31",
      "hash22",
      "vnoise",
      "vnoise3",
      "fbm",
      "fbm3",
      "stageFade",
      "stageFadeInLine",
    ];
    for (const fn of vertexSafe) {
      expect(declares(glsl.LOOK_GLSL_VERTEX, fn), fn).toBe(true);
      expect(declares(glsl.LOOK_GLSL_FRAGMENT, fn), fn).toBe(true);
    }
    for (const fn of ["aaStep", "aaBand", "pitchGuard", "aaLine", "stageCut"]) {
      expect(declares(glsl.LOOK_GLSL_FRAGMENT, fn), fn).toBe(true);
    }
    for (const fn of [
      "lookWorldPosition",
      "lookWorldNormal",
      "lookInstanceColor",
      "exportPxPerUnit",
    ]) {
      expect(declares(glsl.LOOK_GLSL_VERTEX, fn), fn).toBe(true);
    }
  });

  it("guard every chunk and balance its preprocessor blocks", () => {
    for (const [name, source] of chunks) {
      if (!name.startsWith("LOOK_GLSL_")) continue;
      const opens = (source.match(/^#if(n?def)?\b/gm) ?? []).length;
      const closes = (source.match(/^#endif\b/gm) ?? []).length;
      expect(opens, name).toBe(closes);
      expect(source.includes("#ifndef KK_LOOK_"), name).toBe(true);
    }
  });

  it("bake the stage defaults into the one-argument overloads", () => {
    const fade = `stageFade(wp, ${glsl.glslFloat(STAGE_FADE_WINDOW.near)}, ${glsl.glslFloat(STAGE_FADE_WINDOW.far)})`;
    expect(glsl.LOOK_GLSL_STAGE).toContain(fade);
    expect(glsl.LOOK_GLSL_AA).toContain(fade.replace("stageFade", "stageCut"));
    expect(STAGE_FADE_WINDOW.near).toBeLessThan(STAGE_FADE_WINDOW.far);
  });

  it("formats GLSL float literals", () => {
    expect(glsl.glslFloat(4)).toBe("4.0");
    expect(glsl.glslFloat(-2)).toBe("-2.0");
    expect(glsl.glslFloat(0.75)).toBe("0.75");
  });
});
