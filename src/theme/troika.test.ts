import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  type Material,
  MeshBasicMaterial,
  ShaderLib,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from "three";
import { createTextDerivedMaterial } from "troika-three-text";
import { createFontResolver } from "troika-three-text/src/FontResolver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStaggerTextMaterial } from "../toolkit/text/staggerMaterial";

const require = createRequire(import.meta.url);
const packageDir = (name: string, from = require) =>
  realpathSync(dirname(from.resolve(`${name}/package.json`)));

describe("troika is one pinned copy", () => {
  it("drei and the app resolve the same troika-three-text, and it the same utils", () => {
    const text = packageDir("troika-three-text");
    const drei = createRequire(join(packageDir("@react-three/drei"), "package.json"));
    expect(packageDir("troika-three-text", drei)).toBe(text);
    const fromText = createRequire(join(text, "package.json"));
    expect(packageDir("troika-three-utils", fromText)).toBe(packageDir("troika-three-utils"));
  });

  it("is 0.52.5, with the wedge patch in the builds the app and tests load", () => {
    const text = packageDir("troika-three-text");
    expect(JSON.parse(readFileSync(join(text, "package.json"), "utf8")).version).toBe("0.52.5");
    for (const build of ["troika-three-text.esm.js", "troika-three-text.umd.js"]) {
      const src = readFileSync(join(text, "dist", build), "utf8");
      expect(src).toContain("failedFonts.add(fontUrl)");
      expect(src).toContain("fallback font resolution failed; continuing without fallback fonts");
    }
  });
});

/** Runs a derived material's shader upgrade the way three does at compile time. */
function upgradedSource(material: Material): string {
  const shader = {
    vertexShader: ShaderLib.basic.vertexShader,
    fragmentShader: ShaderLib.basic.fragmentShader,
    uniforms: {},
  } as unknown as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as WebGLRenderer);
  return `${shader.vertexShader}\n${shader.fragmentShader}`;
}

describe("troika shaders compile on ANGLE Metal (macOS 27)", () => {
  it("no troika build the app or tests load carries an inout qualifier", () => {
    for (const name of ["troika-three-utils", "troika-three-text"]) {
      for (const flavour of ["esm", "umd"]) {
        const src = readFileSync(join(packageDir(name), "dist", `${name}.${flavour}.js`), "utf8");
        expect(src).not.toMatch(/\binout\b/);
      }
    }
  });

  it("no troika-derived shader declares an inout parameter", () => {
    const variants = [
      createTextDerivedMaterial(new MeshBasicMaterial()),
      createStaggerTextMaterial().material,
      createStaggerTextMaterial({ shine: true, axis: "-y" }).material,
      createStaggerTextMaterial({ pack: true, shineTint: true, gradient: true }).material,
      createStaggerTextMaterial({ echo: 1, arc: true }).material,
    ];
    for (const material of variants) {
      const src = upgradedSource(material);
      expect(src).toContain("troikaVertexTransform");
      expect(src).not.toMatch(/\binout\b/);
    }
  });
});

describe("the wedge patch: a failed fallback never strands a typeset", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const unusedParser = () => {
    throw new Error("no font should parse here");
  };
  const resolveWithin = (
    client: Parameters<typeof createFontResolver>[1],
    text: string,
  ): Promise<{ chars: Uint8Array; fonts: unknown[] }> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the resolver never called back")), 1000);
      createFontResolver(unusedParser, client)(
        text,
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        { unicodeFontsURL: "/__no-unicode-font-resolver__" },
      );
    });

  it("calls back when the fallback lookup rejects (CSP or offline)", async () => {
    const result = await resolveWithin(
      { getFontsForString: () => Promise.reject(new Error("blocked by CSP")) },
      "★",
    );
    expect(result.chars).toHaveLength(1);
    expect(result.fonts).toEqual([]);
  });

  it("calls back when a fallback font file cannot load", async () => {
    const result = await resolveWithin(
      {
        getFontsForString: () =>
          Promise.resolve({ fontUrls: ["/missing.woff"], chars: new Uint8Array([0]) }),
      },
      "★",
    );
    expect(result.fonts).toEqual([null]);
  });
});
