import {
  DoubleSide,
  type InstancedBufferAttribute,
  LinearMipmapLinearFilter,
  NoColorSpace,
} from "three";
import { describe, expect, it } from "vitest";
import { FPS } from "../../../../engine/format";
import { createLookMaterial, lookMaterialProblem } from "./material";
import {
  BRUSH_ATLAS,
  BRUSH_SHAPES,
  type BrushMaskLevel,
  brushMaskMips,
  brushMaskPixels,
  brushMaskTexture,
  brushMaskUniforms,
  createStrokeSplatGeometry,
  orderSplatsFarToNear,
  packStrokeSplats,
  STROKE_SPLAT_GLSL_FRAGMENT,
  STROKE_SPLAT_GLSL_VERTEX,
  STROKE_SPLAT_MATERIAL,
  type StrokeSplat,
  splatBoilStep,
} from "./strokeSplats";

const fnv = (bytes: Uint8Array) => {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
};

const cellCoverage = (level: BrushMaskLevel, shape: number) => {
  const cw = level.width / BRUSH_ATLAS.cols;
  const ch = level.height / BRUSH_ATLAS.rows;
  const ox = (shape % BRUSH_ATLAS.cols) * cw;
  const oy = Math.floor(shape / BRUSH_ATLAS.cols) * ch;
  let sum = 0;
  let minX = cw;
  let maxX = -1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const a = level.data[((oy + y) * level.width + ox + x) * 4 + 3];
      sum += a;
      if (a > 0) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
  }
  return { sum, minX, maxX };
};

const splat = (over: Partial<StrokeSplat>): StrokeSplat => ({
  id: 0,
  x: 0,
  y: -2,
  z: 0,
  yaw: 0,
  tilt: 0.2,
  length: 1,
  width: 0.4,
  shape: BRUSH_SHAPES.flat,
  tone: 0,
  rank: 0.5,
  ...over,
});

describe("brushMaskPixels", () => {
  const level = brushMaskPixels();

  it("is a pure function of its seed", () => {
    expect(level.width).toBe(BRUSH_ATLAS.width);
    expect(level.height).toBe(BRUSH_ATLAS.height);
    expect(level.data).toHaveLength(BRUSH_ATLAS.width * BRUSH_ATLAS.height * 4);
    expect(brushMaskPixels().data).toEqual(level.data);
    expect(fnv(brushMaskPixels(7).data)).not.toBe(fnv(level.data));
  });

  it("paints every cell inside clear margins, the short stroke narrower", () => {
    const cells = Object.values(BRUSH_SHAPES).map((s) => cellCoverage(level, s));
    for (const c of cells) {
      expect(c.sum).toBeGreaterThan(0);
      expect(c.minX).toBeGreaterThanOrEqual(8);
      expect(c.maxX).toBeLessThanOrEqual(BRUSH_ATLAS.width / BRUSH_ATLAS.cols - 8);
    }
    const short = cells[BRUSH_SHAPES.short];
    const flat = cells[BRUSH_SHAPES.flat];
    expect(short.maxX - short.minX).toBeLessThan(flat.maxX - flat.minX);
    expect(cells[BRUSH_SHAPES.tapered].sum).toBeLessThan(flat.sum);
  });

  it("leaves uncovered texels black and transparent", () => {
    for (let p = 0; p < level.data.length; p += 4) {
      if (level.data[p + 3] === 0) expect(level.data[p]).toBe(0);
    }
  });
});

describe("brushMaskMips", () => {
  it("halves down to 1x1", () => {
    const mips = brushMaskMips(brushMaskPixels());
    expect(mips.map((m) => [m.width, m.height])).toEqual([
      [256, 128],
      [128, 64],
      [64, 32],
      [32, 16],
      [16, 8],
      [8, 4],
      [4, 2],
      [2, 1],
      [1, 1],
    ]);
    for (const m of mips) expect(m.data).toHaveLength(m.width * m.height * 4);
  });

  it("averages coverage and weights paint by it", () => {
    const data = new Uint8Array([200, 200, 200, 255, 0, 0, 0, 0, 100, 100, 100, 255, 0, 0, 0, 0]);
    const [, half] = brushMaskMips({ width: 2, height: 2, data });
    expect(Array.from(half.data)).toEqual([150, 150, 150, 128]);
  });
});

describe("brushMaskTexture", () => {
  it("is one lazy shared texture with a JS mip chain", () => {
    const tex = brushMaskTexture();
    expect(brushMaskTexture()).toBe(tex);
    expect(brushMaskUniforms().uBrushMask.value).toBe(tex);
    expect(tex.mipmaps).toHaveLength(9);
    expect(tex.generateMipmaps).toBe(false);
    expect(tex.minFilter).toBe(LinearMipmapLinearFilter);
    expect(tex.colorSpace).toBe(NoColorSpace);
    expect(tex.flipY).toBe(false);
  });
});

describe("orderSplatsFarToNear", () => {
  it("draws far to near with an id tie-break, leaving the input alone", () => {
    const input = [
      splat({ id: 0, x: 1 }),
      splat({ id: 1, x: 0, z: -3 }),
      splat({ id: 2, x: 3 }),
      splat({ id: 3, z: 2 }),
    ];
    const ordered = orderSplatsFarToNear(input);
    expect(ordered.map((s) => s.id)).toEqual([1, 2, 3, 0]);
    expect(input.map((s) => s.id)).toEqual([0, 1, 2, 3]);
  });
});

describe("packStrokeSplats and createStrokeSplatGeometry", () => {
  const splats = [
    splat({ id: 7, x: 4, z: -1, yaw: 0.3, tilt: -0.25, shape: 3, tone: 1, rank: 0.2 }),
    splat({ id: 2, x: -10, z: 2, length: 2 }),
  ];

  it("packs root, size and seed vec4s in draw order", () => {
    const { root, size, seed } = packStrokeSplats(splats);
    expect(Array.from(root.slice(0, 4))).toEqual([4, -2, -1, Math.fround(0.3)]);
    expect(Array.from(size.slice(0, 4))).toEqual([1, Math.fround(0.4), Math.fround(-0.25), 3]);
    expect(Array.from(seed.slice(0, 4))).toEqual([1, Math.fround(0.2), 7, 0]);
    expect(seed[6]).toBe(2);
  });

  it("instances a unit quad with a stage-centred bounding sphere", () => {
    const geo = createStrokeSplatGeometry(splats);
    expect(geo.instanceCount).toBe(2);
    expect(geo.getIndex()?.count).toBe(6);
    expect((geo.getAttribute("aSplatRoot") as InstancedBufferAttribute).meshPerAttribute).toBe(1);
    expect(geo.boundingSphere?.center.toArray()).toEqual([0, 0, 0]);
    expect(geo.boundingSphere?.radius).toBeGreaterThan(Math.hypot(-10, -2, 2));
  });
});

describe("splatBoilStep", () => {
  it("is off at rate 0 and an integer step of the frame index otherwise", () => {
    expect(splatBoilStep(12_345, 0)).toBe(0);
    for (let frame = 0; frame <= 600; frame++) {
      const ms = (frame * 1000) / FPS;
      expect(splatBoilStep(ms, 6)).toBe(Math.floor((frame * 6) / FPS));
      expect(splatBoilStep(ms, 2.4)).toBe(Math.floor((frame * 2) / FPS));
    }
  });

  it("changes exactly on step frames", () => {
    const at = (frame: number) => splatBoilStep((frame * 1000) / FPS, 4);
    expect(at(14)).toBe(0);
    expect(at(15)).toBe(1);
    expect(at(29)).toBe(1);
    expect(at(30)).toBe(2);
  });
});

describe("stroke splat GLSL", () => {
  it("is include-guarded and hash-safe", () => {
    expect(STROKE_SPLAT_GLSL_VERTEX).toContain("#ifndef KK_STROKE_SPLAT_VERTEX");
    expect(STROKE_SPLAT_GLSL_FRAGMENT).toContain("#ifndef KK_STROKE_SPLAT_FRAGMENT");
    expect(/\b(fwidth|dFdx|dFdy)\s*\(/.test(STROKE_SPLAT_GLSL_VERTEX)).toBe(false);
    expect(/fract\s*\(\s*sin/.test(STROKE_SPLAT_GLSL_VERTEX + STROKE_SPLAT_GLSL_FRAGMENT)).toBe(
      false,
    );
  });

  it("builds a valid look material", () => {
    const spec = {
      key: "test-look/daubs",
      ...STROKE_SPLAT_MATERIAL,
      uniforms: brushMaskUniforms(),
      vertexShader: `${STROKE_SPLAT_GLSL_VERTEX}
varying vec2 vAtlasUv;
void main() {
  if (splatHidden(0.5)) { gl_Position = splatCulled(); return; }
  vec3 p = aSplatRoot.xyz + splatYaw(splatLocalCorner(position.xy, aSplatSize.x, aSplatSize.y), aSplatRoot.w);
  vAtlasUv = splatAtlasUv(uv);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(p, 1.0);
}`,
      fragmentShader: `${STROKE_SPLAT_GLSL_FRAGMENT}
varying vec2 vAtlasUv;
void main() {
  vec2 m = splatMask(vAtlasUv);
  gl_FragColor = vec4(vec3(m.x), m.y);
  #include <colorspace_fragment>
}`,
    };
    expect(lookMaterialProblem(spec)).toBeNull();
    const m = createLookMaterial(spec);
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.side).toBe(DoubleSide);
  });
});
