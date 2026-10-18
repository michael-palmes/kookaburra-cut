import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Box3,
  type Interpolant,
  type KeyframeTrack,
  type Mesh,
  type Object3D,
  Vector3,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { describe, expect, it } from "vitest";
import type { V3 } from "../types";
import {
  AVAILABLE_DEVICE_IDS,
  DEVICE_CATALOG,
  DEVICE_IDS,
  type DeviceId,
  type DeviceScreenRect,
  type DeviceSpec,
} from "./catalog";
import { foldCentreOffset } from "./foldPose";
import { measureFoldHome } from "./foldScreenShader";
import { HIDDEN_NODES } from "./models";
import { type DeviceScreenDisplay, deviceScreenLocal } from "./screenAnchor";
import { DEVICE_SCREEN_GEOMETRY, type DeviceScreenGeometry } from "./screenGeometry";

/** `KB_WRITE_SCREENS=1` (pnpm assets:device-screens) rewrites screenGeometry.ts from every glb this checkout has; absent licensed glbs keep their committed entries. */
const WRITE = process.env.KB_WRITE_SCREENS === "1";
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = fileURLToPath(new URL("./screenGeometry.ts", import.meta.url));
/** Device.tsx's TARGET_WORLD_HEIGHT. */
const TARGET_WORLD_HEIGHT = 2.6;
const DEG2RAD = Math.PI / 180;
const round = (n: number): number => Math.round(n * 1e4) / 1e4 || 0;

/** The glb with every texture dropped: node has no image decoder, and geometry is all this reads. */
function stripTextures(glb: Buffer): ArrayBuffer {
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8"));
  const strip = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key.endsWith("Texture")) delete record[key];
      else strip(record[key]);
    }
  };
  strip(json.materials);
  delete json.textures;
  delete json.images;
  delete json.samplers;
  const keep = (list?: string[]) => list?.filter((name) => name !== "EXT_texture_webp");
  json.extensionsUsed = keep(json.extensionsUsed);
  if (json.extensionsRequired) json.extensionsRequired = keep(json.extensionsRequired);
  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += " ";
  const chunk = Buffer.from(text, "utf8");
  const rest = glb.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + chunk.length + rest.length, 8);
  header.writeUInt32LE(chunk.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const out = Buffer.concat([header, chunk, rest]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

/** The glb a catalogue entry renders here, or null when this checkout lacks it. */
function glbPath(spec: DeviceSpec): string | null {
  if (!AVAILABLE_DEVICE_IDS.includes(spec.id)) return null;
  const path = REPO + spec.glbUrl.replace(/^\//, "").replace(/\?.*$/, "");
  return existsSync(path) ? path : null;
}

/** One display's rect in the fitted frame, off the rig as it is posed now. */
function rectOf(
  root: Object3D,
  meshes: Mesh[],
  center: Vector3,
  fit: number,
  shiftX: number,
): DeviceScreenRect {
  expect(meshes.length).toBeGreaterThan(0);
  const home = measureFoldHome(root, meshes);
  const { x, y, z: width, w: height } = home.rect;
  // The shared UV convention: u runs right and v down across the display.
  expect(width).toBeGreaterThan(0);
  expect(height).toBeLessThan(0);
  const cx = (x + width / 2 - center.x) * fit + shiftX;
  const cy = (y + height / 2 - center.y) * fit;
  const planeZ = (home.z - center.z) * fit;
  const a = (width * fit) / 2;
  const b = (-height * fit) / 2;
  const toRoot = root.matrixWorld.clone().invert();
  const at = new Vector3();
  const reach = [-Infinity, -Infinity, -Infinity, -Infinity];
  const corners = [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];
  let flat = 0;
  for (const mesh of meshes) {
    const count = mesh.geometry.getAttribute("position").count;
    for (let i = 0; i < count; i++) {
      mesh.getVertexPosition(i, at).applyMatrix4(mesh.matrixWorld).applyMatrix4(toRoot);
      at.sub(center).multiplyScalar(fit);
      flat = Math.max(flat, Math.abs(at.z - planeZ));
      corners.forEach(([sx, sy], k) => {
        const along = ((at.x + shiftX - cx) * sx + (at.y - cy) * sy) / Math.SQRT2;
        reach[k] = Math.max(reach[k], along);
      });
    }
  }
  // A display is a flat panel facing +Z at its measured pose.
  expect(flat).toBeLessThan(0.002);
  // A rounded rect's support along a diagonal falls short of the sharp corner's by r (sqrt 2 - 1).
  const radii = reach.map((h) => ((a + b) / Math.SQRT2 - h) / (Math.SQRT2 - 1));
  return {
    width: round(width * fit),
    height: round(-height * fit),
    centre: [round(cx), round(cy)],
    z: round(planeZ),
    cornerRadius: round(Math.max(0, ...radii)),
  };
}

/** A device clone prepared exactly as Device.tsx prepares it, with its hinge (fold or lid, in degrees) poseable. */
interface Rig {
  spec: DeviceSpec;
  root: Object3D;
  screens: Mesh[];
  covers: Mesh[];
  center: Vector3;
  fit: number;
  pose: (deg: number) => void;
  hinge: Object3D | null;
}

/** Replays Device.tsx's clone, hidden-node removal, recentre and fit. */
async function prepare(spec: DeviceSpec, path: string): Promise<Rig> {
  const gltf = await new GLTFLoader().parseAsync(stripTextures(readFileSync(path)), "");
  const clone = spec.fold ? cloneSkinned(gltf.scene) : gltf.scene.clone(true);
  const screens: Mesh[] = [];
  const covers: Mesh[] = [];
  const hide: Object3D[] = [];
  let lidNode: Object3D | null = null;
  clone.traverse((obj: Object3D) => {
    if (HIDDEN_NODES.has(obj.name)) {
      hide.push(obj);
      return;
    }
    if (spec.lid && obj.name === spec.lid.node) lidNode = obj;
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    const name = Array.isArray(mesh.material) ? mesh.material[0]?.name : mesh.material.name;
    if (name === spec.screen.material) screens.push(mesh);
    else if (spec.coverScreen && name === spec.coverScreen.material) covers.push(mesh);
  });
  for (const obj of hide) obj.removeFromParent();
  clone.updateMatrixWorld(true);
  const box = new Box3().setFromObject(clone);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  clone.position.sub(center);
  const fitAxis = spec.fit?.axis ?? "height";
  const fitTarget = spec.fit?.target ?? TARGET_WORLD_HEIGHT;
  const fit = fitAxis === "width" ? fitTarget / size.x : fitTarget / size.y;

  const hinge = lidNode as Object3D | null;
  let pose = (_deg: number) => {};
  const fold = spec.fold;
  const lid = spec.lid;
  if (fold) {
    const channels: Array<{ node: Object3D; path: string; evaluate: (t: number) => number[] }> = [];
    for (const track of gltf.animations.find((clip) => clip.name === fold.clip)?.tracks ?? []) {
      const split = track.name.lastIndexOf(".");
      const node = clone.getObjectByName(track.name.slice(0, split));
      const channel = track.name.slice(split + 1);
      if (!node || !["position", "quaternion", "scale"].includes(channel)) continue;
      const interpolant = (
        track as KeyframeTrack & { createInterpolant(): Interpolant }
      ).createInterpolant();
      channels.push({
        node,
        path: channel,
        evaluate: (t) => interpolant.evaluate(t) as unknown as number[],
      });
    }
    pose = (deg) => {
      for (const { node, path, evaluate } of channels) {
        (node[path as "position"] as Vector3).fromArray(evaluate(deg / fold.degPerSecond));
      }
    };
  } else if (lid && hinge) {
    // The anchor maths turns the lid about fitted X by minus its travel, so the hinge must open geometrically about X.
    const lidBaseX = hinge.rotation.x;
    expect(lidBaseX).toBeCloseTo(-lid.openDeg * DEG2RAD, 5);
    pose = (deg) => {
      hinge.rotation.x = lidBaseX * (deg / lid.openDeg);
    };
  }
  return { spec, root: clone, screens, covers, center, fit, pose, hinge };
}

/** Each display's rect at its frame pose (a foldable's inside open flat and cover closed; a laptop at its default lid). */
function measure(rig: Rig): DeviceScreenGeometry {
  const { spec, root, screens, covers, center, fit, pose, hinge } = rig;
  const fold = spec.fold;
  if (fold) {
    pose(fold.openDeg);
    const screen = rectOf(root, screens, center, fit, foldCentreOffset(fold, fold.openDeg));
    pose(0);
    const coverScreen = rectOf(root, covers, center, fit, foldCentreOffset(fold, 0));
    return {
      screen: { ...screen, frame: { foldDeg: fold.openDeg } },
      coverScreen: { ...coverScreen, frame: { foldDeg: 0 } },
    };
  }
  const lid = spec.lid;
  if (lid && hinge) {
    pose(lid.defaultDeg);
    root.updateMatrixWorld(true);
    const axis = new Vector3(1, 0, 0).transformDirection(hinge.matrixWorld);
    expect(Math.abs(axis.x)).toBeCloseTo(1, 6);
    const pivot = new Vector3()
      .setFromMatrixPosition(hinge.matrixWorld)
      .applyMatrix4(root.matrixWorld.clone().invert())
      .sub(center)
      .multiplyScalar(fit);
    const screen = rectOf(root, screens, center, fit, 0);
    return {
      screen: { ...screen, frame: { lidDeg: lid.defaultDeg } },
      lidPivot: pivot.toArray().map(round) as V3,
    };
  }
  return { screen: rectOf(root, screens, center, fit, 0) };
}

/** The furthest any display vertex sits from where `deviceScreenLocal` puts its UV, at one hinge pose. */
function anchorError(
  rig: Rig,
  display: DeviceScreenDisplay,
  hinge: { lidDeg?: number; foldDeg?: number },
  keep: (u: number) => boolean = () => true,
): number {
  const { spec, root, center, fit } = rig;
  const deg = hinge.foldDeg ?? hinge.lidDeg;
  if (deg !== undefined) rig.pose(deg);
  root.updateMatrixWorld(true);
  const shiftX =
    spec.fold && hinge.foldDeg !== undefined ? foldCentreOffset(spec.fold, deg ?? 0) : 0;
  const toRoot = root.matrixWorld.clone().invert();
  const at = new Vector3();
  let worst = 0;
  for (const mesh of display === "cover" ? rig.covers : rig.screens) {
    const uv = mesh.geometry.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      if (!keep(u)) continue;
      mesh.getVertexPosition(i, at).applyMatrix4(mesh.matrixWorld).applyMatrix4(toRoot);
      at.sub(center).multiplyScalar(fit);
      at.x += shiftX;
      const want = deviceScreenLocal(spec.id, u, uv.getY(i), 0, { display, ...hinge });
      worst = Math.max(worst, at.distanceTo(new Vector3(...want)));
    }
  }
  return worst;
}

function literal(value: unknown, indent: string): string {
  if (Array.isArray(value)) return `[${value.map((v) => literal(v, indent)).join(", ")}]`;
  if (value && typeof value === "object") {
    const inner = `${indent}  `;
    const fields = Object.entries(value).map(([key, v]) => {
      const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
      return `${inner}${name}: ${literal(v, inner)},`;
    });
    return `{\n${fields.join("\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function render(geometry: Record<DeviceId, DeviceScreenGeometry>): string {
  const ordered = Object.fromEntries(DEVICE_IDS.map((id) => [id, geometry[id]]));
  return `// Generated by \`pnpm assets:device-screens\` (screenGeometry.test.ts) from each glb present; never hand-edit.
import type { V3 } from "../types";
import type { DeviceId, DeviceScreenRect } from "./catalog";

export interface DeviceScreenGeometry {
  screen: DeviceScreenRect;
  coverScreen?: DeviceScreenRect;
  lidPivot?: V3;
}

export const DEVICE_SCREEN_GEOMETRY = ${literal(ordered, "")} satisfies Record<DeviceId, DeviceScreenGeometry>;
`;
}

function expectSame(committed: unknown, fresh: unknown, at: string): void {
  if (typeof fresh === "number") {
    expect(typeof committed, at).toBe("number");
    expect(Math.abs((committed as number) - fresh), at).toBeLessThanOrEqual(1e-4);
    return;
  }
  if (fresh && typeof fresh === "object") {
    expect(Object.keys(committed ?? {}).sort(), at).toEqual(Object.keys(fresh).sort());
    for (const [key, value] of Object.entries(fresh)) {
      expectSame((committed as Record<string, unknown>)[key], value, `${at}.${key}`);
    }
    return;
  }
  expect(committed, at).toEqual(fresh);
}

async function rigs(): Promise<Rig[]> {
  const out: Rig[] = [];
  for (const id of DEVICE_IDS) {
    const path = glbPath(DEVICE_CATALOG[id]);
    if (path) out.push(await prepare(DEVICE_CATALOG[id], path));
  }
  return out;
}

describe("device screen geometry", () => {
  it("matches a fresh measurement of every glb present (pnpm assets:device-screens rewrites it)", async () => {
    const fresh: Partial<Record<DeviceId, DeviceScreenGeometry>> = {};
    for (const rig of await rigs()) fresh[rig.spec.id] = measure(rig);
    // The committed Android is the one glb every checkout, CI included, re-measures.
    expect(fresh.android).toBeDefined();
    if (WRITE) {
      writeFileSync(OUT, render({ ...DEVICE_SCREEN_GEOMETRY, ...fresh }));
      return;
    }
    for (const [id, geometry] of Object.entries(fresh)) {
      expectSame(DEVICE_SCREEN_GEOMETRY[id as DeviceId], geometry, id);
    }
  }, 120_000);

  it("feeds every catalogue display its committed rect", () => {
    // Within 1% of the display's pixel aspect (the Duo's inside panel runs 0.6% wider than its pixels).
    const near = (rect: DeviceScreenRect, aspect: number) =>
      expect(Math.abs(rect.width / rect.height / aspect - 1)).toBeLessThan(0.01);
    for (const id of DEVICE_IDS) {
      const spec = DEVICE_CATALOG[id];
      expect(spec.screen.rect).toBe(DEVICE_SCREEN_GEOMETRY[id].screen);
      near(spec.screen.rect, spec.screen.aspect);
      if (spec.coverScreen) near(spec.coverScreen.rect, spec.coverScreen.aspect);
    }
    expect(DEVICE_CATALOG["macbook-pro-16"].lid?.pivot).toEqual(
      DEVICE_SCREEN_GEOMETRY["macbook-pro-16"].lidPivot,
    );
  });

  it("puts every display vertex where deviceScreenLocal puts its UV, at every supported hinge pose", async () => {
    const errors: Record<string, number> = {};
    for (const rig of await rigs()) {
      const { id, fold, lid } = rig.spec;
      if (fold) {
        // The static half is the anchor side's, clear of the bend strip at the hinge.
        const staticHalf = (u: number) => (fold.anchorSide > 0 ? u > 0.56 : u < 0.44);
        errors[`${id} open`] = anchorError(rig, "main", { foldDeg: fold.openDeg });
        errors[`${id} 90`] = anchorError(rig, "main", { foldDeg: 90 }, staticHalf);
        errors[`${id} closed`] = anchorError(rig, "main", { foldDeg: 0 }, staticHalf);
        errors[`${id} cover`] = anchorError(rig, "cover", { foldDeg: 0 });
      } else if (lid) {
        for (const lidDeg of [40, lid.defaultDeg, lid.openDeg]) {
          errors[`${id} ${lidDeg}`] = anchorError(rig, "main", { lidDeg });
        }
      } else {
        errors[id] = anchorError(rig, "main", {});
      }
    }
    expect(Object.keys(errors).length).toBeGreaterThan(0);
    for (const [at, error] of Object.entries(errors)) expect(error, at).toBeLessThan(3e-4);
  }, 120_000);
});
