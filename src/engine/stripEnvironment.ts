import {
  BackSide,
  BufferAttribute,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Scene,
  SphereGeometry,
} from "three";
import type { EnvStripSpec } from "../theme/tokens";
import { inlineStripsFromKey } from "./stripSpec";

/** Product-studio environments built from emissive strips (research prototype): reflection-only light that never shows in frame and costs nothing per frame past the IBL lookup every lit material already pays. Directions use the light rig's convention (azimuth from +Z toward +X, elevation up). Baked once per renderer into a PMREM by environments.ts, like the softbox. */

export type EnvStrip = EnvStripSpec;

export interface StripEnvironmentSpec {
  strips: EnvStrip[];
  /** Uniform floor of the whole sphere, linear (keeps black glass from reading as a hole). */
  ambient?: number;
  /** PMREM cube size (256 matches the roughness floor; 512 tightens polished lines a little). */
  size?: number;
}

const RADIUS = 50;
const DEG = Math.PI / 180;

/** A strip in one line: direction, angular size, roll, colour, radiance and end falloff. */
function strip(
  azimuthDeg: number,
  elevationDeg: number,
  lengthDeg: number,
  widthDeg: number,
  rollDeg: number,
  color: string,
  intensity: number,
  falloff: number,
  feather = 0,
): EnvStrip {
  return {
    azimuthDeg,
    elevationDeg,
    lengthDeg,
    widthDeg,
    rollDeg,
    color,
    intensity,
    falloff,
    feather,
  };
}

const WARM = "#ffc888";
const AMBER = "#ffb066";
const COOL = "#7fbdf4";

/** Presets designed by reflecting each target shot's view ray about the band, chamfer and glass normals (where must the light sit for a highlight there). */
export const STRIP_ENVIRONMENTS: Record<string, StripEnvironmentSpec> = {
  "kookaburra:strip-probe": {
    ambient: 0.01,
    strips: [
      strip(90, 0, 60, 8, 0, "#ff2020", 4, 0),
      strip(-90, 0, 60, 8, 0, "#20ff20", 4, 0),
      strip(180, 0, 60, 8, 0, "#2040ff", 4, 0),
      strip(0, 45, 20, 20, 0, "#ffffff", 4, 0),
      strip(45, -30, 12, 12, 0, "#ffff20", 4, 0),
    ],
  },
  "kookaburra:strips-hero": {
    ambient: 0.003,
    size: 512,
    strips: [
      strip(-102, 18, 120, 30, 0, WARM, 8, 0.6, 0.8),
      strip(-55, 20, 120, 3, 0, "#ffd29a", 30, 0.5, 0.5),
      strip(-174, 2, 120, 3, 0, COOL, 10, 0.5, 0.5),
      strip(93, 9, 50, 30, 0, "#ffe6c8", 0.5, 0.8, 0.9),
      strip(0, 72, 100, 4, 90, "#fff0dc", 3, 0.5, 0.5),
    ],
  },
  "kookaburra:strips-edge": {
    ambient: 0.002,
    size: 512,
    strips: [
      strip(-40, 45, 100, 40, 90, "#ffc27a", 6, 0.6, 0.8),
      strip(-25, -20, 80, 30, 90, AMBER, 5, 0.6, 0.8),
      strip(-160, 11, 100, 10, 90, "#ffbf7a", 0.4, 0.8, 0.9),
      strip(140, 5, 100, 2.5, 90, COOL, 4, 0.5, 0.5),
    ],
  },
  "kookaburra:strips-glass": {
    ambient: 0.002,
    size: 512,
    strips: [
      strip(-176, 12, 150, 14, 70, "#ffbf7a", 1.2, 0.8, 0.9),
      strip(-6, -24, 80, 30, 90, AMBER, 4, 0.6, 0.7),
      strip(-17, 60, 120, 40, 90, "#ffc27a", 5, 0.5, 0.7),
      strip(120, 4, 100, 2.5, 0, COOL, 3, 0.5, 0.4),
    ],
  },
  "kookaburra:strips-camera": {
    ambient: 0.002,
    size: 512,
    strips: [
      strip(-60, 40, 80, 6, 0, WARM, 14, 0.5, 0.5),
      strip(120, 20, 100, 3, 0, COOL, 8, 0.5, 0.4),
      strip(3, -45, 50, 40, 90, AMBER, 0.6, 0.7, 0.8),
    ],
  },
  "kookaburra:strips-card": {
    ambient: 0.002,
    size: 512,
    strips: [
      strip(-175, -6, 100, 30, 0, AMBER, 6, 0.6, 0.8),
      strip(-160, 50, 100, 3, 90, WARM, 24, 0.5, 0.5),
      strip(99, 34, 40, 30, 0, "#ffe6c8", 0.5, 0.8, 0.9),
      strip(40, -15, 120, 3, 90, COOL, 6, 0.5, 0.5),
    ],
  },
};

export function stripEnvironmentSpec(source: string): StripEnvironmentSpec | undefined {
  const preset = STRIP_ENVIRONMENTS[source];
  if (preset) return preset;
  const inline = inlineStripsFromKey(source);
  return inline ? { ...inline, size: 512 } : undefined;
}

/** 1 across the plateau, easing to exactly 0 at the edge over the outer `fade` of the half-extent, so no hard step survives magnification. */
function edgeFade(x: number, fade: number): number {
  if (fade <= 0) return 1;
  const t = Math.min(1, Math.max(0, (x - (1 - fade)) / fade));
  return 1 - t * t * (3 - 2 * t);
}

/** One strip as a plane on the sphere, facing the origin, its length along local Y with a per-vertex falloff toward both ends. */
function stripMesh(s: EnvStrip): Mesh {
  const length = 2 * RADIUS * Math.tan(Math.min(s.lengthDeg, 170) * 0.5 * DEG);
  const width = 2 * RADIUS * Math.tan(Math.min(s.widthDeg, 170) * 0.5 * DEG);
  const geometry = new PlaneGeometry(width, length, 16, 48);
  const base = new Color(s.color).multiplyScalar(s.intensity);
  const falloff = Math.min(1, Math.max(0, s.falloff ?? 0));
  const feather = Math.min(1, Math.max(0, s.feather ?? 0));
  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const t = Math.abs(position.getY(i) / (length / 2));
    const u = Math.abs(position.getX(i) / (width / 2));
    const k = edgeFade(t, falloff) * edgeFade(u, feather);
    colors[i * 3] = base.r * k;
    colors[i * 3 + 1] = base.g * k;
    colors[i * 3 + 2] = base.b * k;
  }
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  const mesh = new Mesh(
    geometry,
    new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, toneMapped: false }),
  );
  const az = s.azimuthDeg * DEG;
  const el = s.elevationDeg * DEG;
  mesh.position.set(
    RADIUS * Math.cos(el) * Math.sin(az),
    RADIUS * Math.sin(el),
    RADIUS * Math.cos(el) * Math.cos(az),
  );
  mesh.lookAt(0, 0, 0);
  mesh.rotateZ((s.rollDeg ?? 0) * DEG);
  return mesh;
}

/** The bake scene: black (or a faint ambient) sphere plus the strips. Caller disposes via disposeStripScene. */
export function buildStripScene(spec: StripEnvironmentSpec): Scene {
  const scene = new Scene();
  scene.background = new Color(0, 0, 0);
  if (spec.ambient && spec.ambient > 0) {
    const sky = new Mesh(
      new SphereGeometry(RADIUS * 1.5, 32, 16),
      new MeshBasicMaterial({
        color: new Color(spec.ambient, spec.ambient, spec.ambient),
        side: BackSide,
        toneMapped: false,
      }),
    );
    scene.add(sky);
  }
  for (const s of spec.strips) scene.add(stripMesh(s));
  return scene;
}

export function disposeStripScene(scene: Scene): void {
  scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    (mesh.material as MeshBasicMaterial).dispose();
  });
}
