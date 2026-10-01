import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { lookMaterialProblem } from "./material";
import {
  createRingBandsGeometry,
  createRingBandUniforms,
  LOOK_GLSL_RING_BANDS,
  LOOK_GLSL_RING_EDGE,
  LOOK_GLSL_RING_VERTEX,
  RING_BANDS_MAX,
  RING_BANDS_VERTEX_SHADER,
  type RingBandShape,
  ringBandAngle,
  ringBandDrawOrder,
} from "./ringBands";

const BANDS: RingBandShape[] = [
  { radius: 15, bottom: -2, top: 1 },
  { radius: 120, bottom: -2, top: 100 },
  { radius: 40, bottom: -2, top: 9 },
  { radius: 21, bottom: -2, top: 3 },
];
const FLOOR = { radius: 40, y: -2 };
const deg = (rad: number) => (rad * 180) / Math.PI;

describe("ringBandDrawOrder", () => {
  it("draws far to near, keeping input order on ties", () => {
    expect(ringBandDrawOrder(BANDS)).toEqual([1, 2, 3, 0]);
    expect(ringBandDrawOrder([{ radius: 5, bottom: 0, top: 1 }, BANDS[0], BANDS[0]])).toEqual([
      1, 2, 0,
    ]);
  });

  it("slots the floor after every band that reaches its radius", () => {
    expect(ringBandDrawOrder(BANDS, FLOOR)).toEqual([1, 2, 4, 3, 0]);
    expect(ringBandDrawOrder(BANDS, { radius: 200, y: 0 })).toEqual([4, 1, 2, 3, 0]);
    expect(ringBandDrawOrder(BANDS, { radius: 1, y: 0 })).toEqual([1, 2, 3, 0, 4]);
  });
});

describe("createRingBandsGeometry", () => {
  const segments = 16;
  const geometry = createRingBandsGeometry(BANDS, { segments, floor: FLOOR });
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const band = geometry.getAttribute("aRingBand");
  const index = geometry.getIndex();
  const vertex = (i: number) => new Vector3().fromBufferAttribute(position, i);

  it("groups every band and the floor in draw order, covering the index buffer once", () => {
    expect(geometry.groups.map((g) => g.materialIndex)).toEqual(ringBandDrawOrder(BANDS, FLOOR));
    let next = 0;
    for (const g of geometry.groups) {
      expect(g.start).toBe(next);
      next += g.count;
    }
    expect(next).toBe(index?.count);
  });

  it("tags vertices with their input band, the floor with -1", () => {
    for (const g of geometry.groups) {
      const want = g.materialIndex === BANDS.length ? -1 : g.materialIndex;
      for (let k = g.start; k < g.start + g.count; k++) {
        expect(band.getX(index?.getX(k) ?? 0)).toBe(want);
      }
    }
  });

  it("winds bands inward and the floor upward, matching the normals", () => {
    for (const g of geometry.groups) {
      for (let k = g.start; k < g.start + g.count; k += 3) {
        const [a, b, c] = [0, 1, 2].map((o) => index?.getX(k + o) ?? 0);
        const face = new Vector3()
          .subVectors(vertex(b), vertex(a))
          .cross(new Vector3().subVectors(vertex(c), vertex(a)))
          .normalize();
        const n = new Vector3().fromBufferAttribute(normal, a);
        expect(face.dot(n)).toBeGreaterThan(0.95);
        if (g.materialIndex !== BANDS.length) {
          const p = vertex(a);
          expect(n.dot(new Vector3(p.x, 0, p.z).normalize())).toBeLessThan(-0.99);
        } else {
          expect(n.y).toBe(1);
        }
      }
    }
  });

  it("closes each band on itself at the seam and keeps its radius and height", () => {
    for (const [i, shape] of BANDS.entries()) {
      const verts: Vector3[] = [];
      for (let v = 0; v < position.count; v++) if (band.getX(v) === i) verts.push(vertex(v));
      expect(verts).toHaveLength((segments + 1) * 2);
      expect(verts[0].distanceTo(verts[verts.length - 2])).toBeLessThan(1e-4);
      for (const p of verts) {
        expect(Math.hypot(p.x, p.z)).toBeCloseTo(shape.radius, 4);
        expect([shape.bottom, shape.top]).toContain(p.y);
      }
    }
  });

  it("caps the stack at the uniform array length", () => {
    const many = Array.from({ length: RING_BANDS_MAX + 1 }, () => BANDS[0]);
    expect(() => createRingBandsGeometry(many)).toThrow(/at most/);
  });
});

describe("ringBandAngle", () => {
  it("turns at whole revolutions per period, looping exactly", () => {
    const period = 3600;
    expect(deg(ringBandAngle(1, 8, period) - ringBandAngle(0, 8, period))).toBeCloseTo(0.8, 9);
    expect(deg(ringBandAngle(11, 2, period) - ringBandAngle(10, 2, period))).toBeCloseTo(0.2, 9);
    for (const turns of [8, -6, 4, -2, 1]) {
      for (const t of [0, 37.5, 1799.25]) {
        expect(ringBandAngle(t + period, turns, period)).toBeCloseTo(
          ringBandAngle(t, turns, period),
          6,
        );
      }
    }
  });

  it("stays wrapped and continuous for signed and fractional turns", () => {
    for (const [t, turns] of [
      [1e7, 8],
      [5, -6],
      [123.4, 1.37],
    ]) {
      const a = ringBandAngle(t, turns, 3600);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(Math.PI * 2);
    }
    expect(ringBandAngle(1, -2, 3600)).toBeCloseTo(Math.PI * 2 - (2 * Math.PI * 2) / 3600, 9);
    expect(ringBandAngle(5, 1, 0)).toBe(0);
  });
});

describe("ring band GLSL", () => {
  it("guards every chunk and keeps derivatives out of the vertex stage", () => {
    for (const chunk of [LOOK_GLSL_RING_BANDS, LOOK_GLSL_RING_EDGE, LOOK_GLSL_RING_VERTEX]) {
      expect(chunk).toMatch(/#ifndef KK_LOOK_RING_/);
      expect(/fract\s*\(\s*sin/.test(chunk)).toBe(false);
    }
    expect(/\bfwidth\s*\(/.test(RING_BANDS_VERTEX_SHADER)).toBe(false);
    expect(LOOK_GLSL_RING_EDGE).toMatch(/\bfwidth\s*\(/);
    expect(LOOK_GLSL_RING_BANDS).toContain(`#define RING_BANDS_MAX ${RING_BANDS_MAX}`);
  });

  it("passes the look material rules as a vertex shader", () => {
    const spec = {
      key: "ring-test/bands",
      vertexShader: RING_BANDS_VERTEX_SHADER,
      fragmentShader: `${LOOK_GLSL_RING_BANDS}\n${LOOK_GLSL_RING_EDGE}\nvarying vec3 vRing;\nvoid main() {\n  float d = ringCrest(normalize(vRing.xz), 0.0, 1.0, 2.0, 1.0) - vRing.y;\n  gl_FragColor = vec4(vec3(ringEdge(d, 0.5, 0.0, 0.05)), 1.0);\n  #include <colorspace_fragment>\n}\n`,
      uniforms: createRingBandUniforms(),
    };
    expect(lookMaterialProblem(spec)).toBeNull();
  });

  it("starts every band unspun and at full strength", () => {
    const u = createRingBandUniforms();
    expect([...u.uRingAngle.value]).toEqual(Array(RING_BANDS_MAX).fill(0));
    expect([...u.uRingFade.value]).toEqual(Array(RING_BANDS_MAX).fill(1));
  });
});
