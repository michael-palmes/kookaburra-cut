import { BoxGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { createSeededRandom } from "../../../../engine/rng";
import {
  createInstanceScratch,
  hexLattice,
  type InstancePose,
  LOOK_GLSL_INSTANCE_ANCHOR,
  seededPlacements,
  writeInstanceColors,
  writeInstanceMatrices,
  writeStaticInstances,
} from "./instanced";
import { lookMaterialProblem } from "./material";

const mesh = (capacity: number) =>
  new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), capacity);

describe("seededPlacements", () => {
  it("draws from one seeded stream in index order", () => {
    const rand = createSeededRandom(0x5eed);
    const expected = Array.from({ length: 5 }, (_, i) => ({ i, a: rand(), b: rand() }));
    const got = seededPlacements(0x5eed, 5, (r, i) => ({ i, a: r(), b: r() }));
    expect(got).toEqual(expected);
    expect(seededPlacements(0x5eed, 5, (r, i) => ({ i, a: r(), b: r() }))).toEqual(got);
  });

  it("treats negative and fractional counts safely", () => {
    expect(seededPlacements(1, -3, (r) => r())).toEqual([]);
    expect(seededPlacements(1, 2.7, (r) => r())).toHaveLength(2);
  });
});

describe("writeInstanceMatrices", () => {
  it("composes each pose, caps at capacity and flags the upload", () => {
    const m = mesh(3);
    const items = [0, 1, 2, 3, 4];
    const version = m.instanceMatrix.version;
    writeInstanceMatrices(
      m,
      items,
      (item, _i, out) => {
        out.position.set(item, 2 * item, 0);
        if (item === 1) out.rotation.set(0, Math.PI / 2, 0);
        if (item === 2) out.scale.setScalar(0.5);
      },
      createInstanceScratch(),
    );
    expect(m.count).toBe(3);
    expect(m.instanceMatrix.version).toBeGreaterThan(version);
    const got = new Matrix4();
    const pos = new Vector3();
    const quat = new Quaternion();
    const scale = new Vector3();
    m.getMatrixAt(2, got);
    got.decompose(pos, quat, scale);
    expect(pos.toArray()).toEqual([2, 4, 0]);
    expect(quat.equals(new Quaternion())).toBe(true);
    expect(scale.x).toBeCloseTo(0.5, 12);
    m.getMatrixAt(1, got);
    got.decompose(pos, quat, scale);
    expect(quat.y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(scale.toArray()).toEqual([1, 1, 1]);
  });

  it("reuses one scratch pose for every instance and frame", () => {
    const m = mesh(4);
    const scratch = createInstanceScratch();
    const seen = new Set<InstancePose>();
    for (let frame = 0; frame < 3; frame++) {
      writeInstanceMatrices(m, [0, 1, 2, 3], (_item, _i, out) => seen.add(out), scratch);
    }
    expect(seen.size).toBe(1);
  });
});

describe("writeInstanceColors", () => {
  it("writes linear instance colours defaulting to white", () => {
    const m = mesh(2);
    writeInstanceColors(
      m,
      ["#3b5c7d", null],
      (hex, _i, out) => {
        if (hex) out.set(hex);
      },
      createInstanceScratch(),
    );
    expect(m.instanceColor).not.toBeNull();
    const c = m.instanceColor?.array;
    expect(c?.[3]).toBe(1);
    expect(c?.[0]).toBeLessThan(59 / 255);
  });
});

describe("hexLattice", () => {
  it("packs a disc at the hex density, every point inside the radius", () => {
    const spacing = 1.2;
    const radius = 30;
    const points = hexLattice(spacing, radius);
    const expected = (Math.PI * radius * radius) / ((spacing * spacing * Math.sqrt(3)) / 2);
    expect(points.length / expected).toBeGreaterThan(0.98);
    expect(points.length / expected).toBeLessThan(1.02);
    for (const p of points) expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(radius);
  });

  it("keeps every nearest neighbour exactly one spacing away", () => {
    const spacing = 1.5;
    const points = hexLattice(spacing, 6);
    const centre = points.find((p) => p.x === 0 && p.z === 0);
    expect(centre).toBeDefined();
    const ring = points.filter((p) => {
      const d = Math.hypot(p.x, p.z);
      return d > 0 && d < spacing * 1.01;
    });
    expect(ring).toHaveLength(6);
    for (const p of ring) expect(Math.hypot(p.x, p.z)).toBeCloseTo(spacing, 12);
  });

  it("emits rows from -z to +z, offsetting odd rows by half a pitch", () => {
    const points = hexLattice(1, 4);
    for (let i = 1; i < points.length; i++) {
      expect(points[i].z).toBeGreaterThanOrEqual(points[i - 1].z);
    }
    const odd = points.filter((p) => Math.abs(p.z - Math.sqrt(3) / 2) < 1e-9);
    expect(odd.every((p) => Math.abs(p.x - Math.round(p.x)) === 0.5)).toBe(true);
    expect(hexLattice(1, 4)).toEqual(points);
  });

  it("returns nothing for degenerate inputs", () => {
    expect(hexLattice(0, 10)).toEqual([]);
    expect(hexLattice(-1, 10)).toEqual([]);
    expect(hexLattice(1, -1)).toEqual([]);
    expect(hexLattice(1, 0)).toEqual([{ x: 0, z: 0 }]);
  });
});

describe("writeStaticInstances", () => {
  const anchor = (p: { x: number; z: number }, _i: number, out: InstancePose) => {
    out.position.set(p.x, 0, p.z);
  };

  it("writes companion meshes once per items identity, never per frame", () => {
    const drops = mesh(8);
    const threads = mesh(8);
    const scratch = createInstanceScratch();
    const written = new WeakMap();
    const items = hexLattice(1, 1);
    const writeAll = () =>
      [drops, threads, null].filter((m) => writeStaticInstances(m, items, anchor, scratch, written))
        .length;
    expect(writeAll()).toBe(2);
    const versions = [drops.instanceMatrix.version, threads.instanceMatrix.version];
    for (let frame = 0; frame < 3; frame++) expect(writeAll()).toBe(0);
    expect([drops.instanceMatrix.version, threads.instanceMatrix.version]).toEqual(versions);
    expect(drops.count).toBe(items.length);
    const got = new Matrix4();
    for (const m of [drops, threads]) {
      m.getMatrixAt(items.length - 1, got);
      const pos = new Vector3().setFromMatrixPosition(got);
      expect(pos.x).toBeCloseTo(items.at(-1)?.x ?? Number.NaN, 6);
      expect(pos.z).toBeCloseTo(items.at(-1)?.z ?? Number.NaN, 6);
    }
  });

  it("rewrites on a new layout and writes a remounted mesh on its own", () => {
    const a = mesh(16);
    const scratch = createInstanceScratch();
    const written = new WeakMap();
    writeStaticInstances(a, hexLattice(1, 1), anchor, scratch, written);
    const wider = hexLattice(1, 2);
    expect(writeStaticInstances(a, wider, anchor, scratch, written)).toBe(true);
    expect(a.count).toBe(Math.min(wider.length, 16));
    const remounted = mesh(16);
    expect(writeStaticInstances(a, wider, anchor, scratch, written)).toBe(false);
    expect(writeStaticInstances(remounted, wider, anchor, scratch, written)).toBe(true);
  });
});

describe("LOOK_GLSL_INSTANCE_ANCHOR", () => {
  it("reads the instance translation behind an include guard, vertex-safe", () => {
    expect(LOOK_GLSL_INSTANCE_ANCHOR).toContain("#ifndef KK_LOOK_INSTANCE_ANCHOR");
    expect(LOOK_GLSL_INSTANCE_ANCHOR).toContain("instanceMatrix[3].xyz");
    expect(/\b(fwidth|dFdx|dFdy)\s*\(/.test(LOOK_GLSL_INSTANCE_ANCHOR)).toBe(false);
    const vertexShader = `${LOOK_GLSL_INSTANCE_ANCHOR}\nvoid main() { gl_Position = vec4(lookInstanceAnchor(), 1.0); }`;
    const fragmentShader =
      "void main() { gl_FragColor = vec4(1.0);\n#include <colorspace_fragment>\n}";
    expect(lookMaterialProblem({ key: "kit/anchor", vertexShader, fragmentShader })).toBeNull();
  });
});
