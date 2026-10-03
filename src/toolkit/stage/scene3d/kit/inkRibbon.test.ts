import type { Camera, Scene, Vector4, WebGLRenderer } from "three";
import { describe, expect, it } from "vitest";
import {
  INK_MIN_PX,
  INK_RIBBON_FRAGMENT,
  inkLoop,
  inkPolyline,
  inkRasterSync,
  inkRibbonGeometry,
  inkRibbonMaterial,
  inkRibbonSegments,
  inkRibbonVertexShader,
  inkStrands,
  showInkStrands,
} from "./inkRibbon";
import { createLookMaterial, lookMaterialProblem } from "./material";

const vec = (arr: Float32Array, i: number) => Array.from(arr.subarray(i * 4, i * 4 + 4));

const FRAGMENT = /* glsl */ `
uniform vec3 uInk;
void main() {
  gl_FragColor = vec4(uInk, inkCoverage());
  #include <colorspace_fragment>
}
`;

describe("inkRibbonSegments", () => {
  it("gives an open strand n - 1 segments with clamped neighbours and flags", () => {
    const s = inkRibbonSegments([inkPolyline([[0], [1], [2]], [7, 8])]);
    expect(s.strandEnds).toEqual([2]);
    expect([vec(s.prev, 0), vec(s.a, 0), vec(s.b, 0), vec(s.next, 0)]).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [1, 0, 0, 0],
      [2, 0, 0, 0],
    ]);
    expect(vec(s.seg, 0)).toEqual([0, 0.5, 0, 1]);
    expect([vec(s.prev, 1), vec(s.a, 1), vec(s.b, 1), vec(s.next, 1)]).toEqual([
      [0, 0, 0, 0],
      [1, 0, 0, 0],
      [2, 0, 0, 0],
      [2, 0, 0, 0],
    ]);
    expect(vec(s.seg, 1)).toEqual([0.5, 1, 1, 0]);
    expect(vec(s.strand, 1)).toEqual([7, 8, 0, 0]);
  });

  it("wraps a closed loop so every join has both neighbours", () => {
    const s = inkRibbonSegments([inkLoop([[0], [1], [2], [3]])]);
    expect(s.strandEnds).toEqual([4]);
    expect(vec(s.a, 3)[0]).toBe(3);
    expect(vec(s.b, 3)[0]).toBe(0);
    expect(vec(s.next, 3)[0]).toBe(1);
    expect(vec(s.prev, 0)[0]).toBe(3);
    for (let i = 0; i < 4; i++) expect(vec(s.seg, i).slice(2)).toEqual([1, 1]);
    expect(vec(s.seg, 3).slice(0, 2)).toEqual([0.75, 1]);
  });

  it("shares each join: a segment's next point is the following segment's B", () => {
    const s = inkRibbonSegments([inkLoop([[0], [1], [2], [3], [4]])]);
    for (let i = 0; i < 5; i++) {
      const j = (i + 1) % 5;
      expect(vec(s.b, i)).toEqual(vec(s.a, j));
      expect(vec(s.next, i)).toEqual(vec(s.b, j));
      expect(vec(s.prev, j)).toEqual(vec(s.a, i));
    }
  });

  it("skips strands too short to draw and keeps cumulative ends", () => {
    const s = inkRibbonSegments([inkPolyline([[0]]), inkLoop([[0], [1]]), inkPolyline([[0], [1]])]);
    expect(s.strandEnds).toEqual([0, 1, 2]);
  });
});

describe("inkStrands", () => {
  it("builds same-shaped strands from param and data functions, in order", () => {
    const strands = inkStrands(3, 4, (s, i) => [s, i], { closed: true, data: (s) => [s * 10] });
    expect(strands).toHaveLength(3);
    expect(strands.every((s) => s.closed)).toBe(true);
    expect(Array.from(strands[2].points.subarray(4, 8))).toEqual([2, 1, 0, 0]);
    expect(strands[1].data).toEqual([10]);
  });
});

describe("inkRibbonGeometry", () => {
  it("instances a quad per segment and shows the first strands on demand", () => {
    const g = inkRibbonGeometry(inkStrands(3, 8, (s, i) => [i, s], { closed: true }));
    expect(g.instanceCount).toBe(24);
    expect(g.getAttribute("inkA").count).toBe(24);
    expect(g.index?.count).toBe(6);
    showInkStrands(g, 2);
    expect(g.instanceCount).toBe(16);
    showInkStrands(g, 0);
    expect(g.instanceCount).toBe(0);
    showInkStrands(g, 99);
    expect(g.instanceCount).toBe(24);
  });
});

describe("inkRibbonMaterial", () => {
  it("passes the look material rules and seeds its uniforms", () => {
    const spec = inkRibbonMaterial({
      key: "test-look/ink",
      fragmentShader: FRAGMENT,
      uniforms: { uInk: { value: 1 } },
      lineWidth: { px: 2.2 },
      fade: [40, 80],
      lift: 0.003,
    });
    expect(lookMaterialProblem(spec)).toBeNull();
    const m = createLookMaterial(spec);
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.uniforms.uInkWidth.value.toArray()).toEqual([0, 2.2, INK_MIN_PX]);
    expect(m.uniforms.uInkFade.value.toArray()).toEqual([40, 80]);
    expect(m.uniforms.uInkLift.value).toBe(0.003);
    expect(m.fragmentShader).toContain(INK_RIBBON_FRAGMENT);
  });

  it("defaults to static points and uniform widths, and takes the look's hooks", () => {
    const plain = inkRibbonVertexShader({});
    expect(plain).toContain("vec3 inkPath(vec4 p) { return p.xyz; }");
    expect(plain).toContain("return uInkWidth.xy;");
    const custom = inkRibbonVertexShader({
      path: "vec3 inkPath(vec4 p) { return vec3(p.x, 0.0, 0.0); }",
      vertex: "void inkVertex(vec4 p, vec3 world) { vTone = p.y; }",
    });
    expect(custom).not.toContain("return p.xyz;");
    expect(custom).toContain("vTone = p.y;");
    expect(custom.indexOf("inkPath(vec4 p)")).toBeLessThan(custom.indexOf("void main()"));
  });
});

describe("inkRasterSync", () => {
  it("hands the ink the size of the target it draws into", () => {
    const m = createLookMaterial(
      inkRibbonMaterial({ key: "test-look/ink", fragmentShader: FRAGMENT }),
    );
    expect(m.uniforms.uInkRaster.value.toArray()).toEqual([0, 0]);
    const renderer = {
      getCurrentViewport: (v: Vector4) => v.set(0, 0, 640, 360),
    } as unknown as WebGLRenderer;
    inkRasterSync(renderer, {} as Scene, {} as Camera, null, m);
    expect(m.uniforms.uInkRaster.value.toArray()).toEqual([640, 360]);
  });
});
