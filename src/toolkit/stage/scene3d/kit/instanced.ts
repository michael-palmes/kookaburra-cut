import { Color, Euler, type InstancedMesh, Matrix4, Quaternion, Vector3 } from "three";
import { createSeededRandom, type SeededRandom } from "../../../../engine/rng";

/** Seeded placements (F12): ONE generator from `seed`, `place` called in index order, so the draw order is part of the export contract (changing it re-scatters every look that uses it). */
export function seededPlacements<T>(
  seed: number,
  count: number,
  place: (rand: SeededRandom, index: number) => T,
): T[] {
  const rand = createSeededRandom(seed);
  const out: T[] = [];
  for (let i = 0; i < Math.max(0, Math.floor(count)); i++) out.push(place(rand, i));
  return out;
}

/** One instance's transform, reset to identity before each `pose` call. */
export interface InstancePose {
  position: Vector3;
  rotation: Euler;
  scale: Vector3;
}

/** Reused per-mesh scratch so per-frame writes allocate nothing. */
export interface InstanceScratch {
  pose: InstancePose;
  quaternion: Quaternion;
  matrix: Matrix4;
  color: Color;
}

export function createInstanceScratch(): InstanceScratch {
  return {
    pose: { position: new Vector3(), rotation: new Euler(), scale: new Vector3(1, 1, 1) },
    quaternion: new Quaternion(),
    matrix: new Matrix4(),
    color: new Color(),
  };
}

/** Writes one instance matrix per item (capped at the mesh capacity), sets `mesh.count` and flags the upload. Call it from the commit phase with the look clock in scope. */
export function writeInstanceMatrices<T>(
  mesh: InstancedMesh,
  items: readonly T[],
  pose: (item: T, index: number, out: InstancePose) => void,
  scratch: InstanceScratch,
): void {
  const n = Math.min(items.length, mesh.instanceMatrix.count);
  const { position, rotation, scale } = scratch.pose;
  for (let i = 0; i < n; i++) {
    position.set(0, 0, 0);
    rotation.set(0, 0, 0);
    scale.set(1, 1, 1);
    pose(items[i], i, scratch.pose);
    scratch.quaternion.setFromEuler(rotation);
    scratch.matrix.compose(position, scratch.quaternion, scale);
    mesh.setMatrixAt(i, scratch.matrix);
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
}

/** One point of a ground-plane lattice. */
export interface LatticePoint {
  x: number;
  z: number;
}

/** Hex-packed ground points inside a disc: rows `spacing * sqrt(3) / 2` apart along z, odd rows offset half a pitch, emitted row by row from -z to +z (the order is export contract, like seeded placements). No randomness, so it needs no seed. */
export function hexLattice(spacing: number, radius: number): LatticePoint[] {
  if (!(spacing > 0) || !(radius >= 0)) return [];
  const rowPitch = (spacing * Math.sqrt(3)) / 2;
  const rows = Math.ceil(radius / rowPitch);
  const cols = Math.ceil(radius / spacing) + 1;
  const out: LatticePoint[] = [];
  for (let j = 0 - rows; j <= rows; j++) {
    const offset = j % 2 === 0 ? 0 : 0.5;
    for (let i = 0 - cols; i <= cols; i++) {
      const x = (i + offset) * spacing;
      const z = j * rowPitch;
      if (Math.hypot(x, z) <= radius) out.push({ x, z });
    }
  }
  return out;
}

/** Writes a STATIC layout (placements the CPU never moves; motion lives in the vertex shader, which reads each anchor with `lookInstanceAnchor()`) into a mesh once per mesh and items identity, so companion meshes (drops and their threads) share one layout and a remounted mesh is caught. `written` remembers what each mesh holds; returns whether it wrote. */
export function writeStaticInstances<T>(
  mesh: InstancedMesh | null | undefined,
  items: readonly T[],
  pose: (item: T, index: number, out: InstancePose) => void,
  scratch: InstanceScratch,
  written: WeakMap<InstancedMesh, readonly unknown[]>,
): boolean {
  if (!mesh || written.get(mesh) === items) return false;
  writeInstanceMatrices(mesh, items, pose, scratch);
  written.set(mesh, items);
  return true;
}

/** VERTEX-ONLY GLSL, include-guarded: `lookInstanceAnchor()` is the instance's translation (the static anchor a shader-driven layout animates from), or the origin without instancing. Paste it above the vertex `main()`. */
// language=GLSL
export const LOOK_GLSL_INSTANCE_ANCHOR: string = /* glsl */ `
#ifndef KK_LOOK_INSTANCE_ANCHOR
#define KK_LOOK_INSTANCE_ANCHOR
vec3 lookInstanceAnchor() {
#ifdef USE_INSTANCING
  return instanceMatrix[3].xyz;
#else
  return vec3(0.0);
#endif
}
#endif
`;

/** Writes one LINEAR instance colour per item (read in shaders via `lookInstanceColor()`). Colours are usually static: call it when the palette or placements change, not every frame. */
export function writeInstanceColors<T>(
  mesh: InstancedMesh,
  items: readonly T[],
  colorOf: (item: T, index: number, out: Color) => void,
  scratch: InstanceScratch,
): void {
  const n = Math.min(items.length, mesh.instanceMatrix.count);
  for (let i = 0; i < n; i++) {
    scratch.color.setRGB(1, 1, 1);
    colorOf(items[i], i, scratch.color);
    mesh.setColorAt(i, scratch.color);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}
