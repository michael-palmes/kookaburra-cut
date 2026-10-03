import { Euler, Matrix4, Vector3 } from "three";
import { createSeededRandom } from "../../../../../engine/rng";
import { loopSeconds } from "../../kit/clock";
import { smoothstep } from "../../kit/math";

/** Tessera dome layout: a shallow saucer (a sphere cap springing from y 4) tiled in concentric courses round an apex medallion, split by eight ribs. */
export const TESSERA = {
  springY: 4,
  seed: 0x7e55e7a,
  /** Grout gap as a fraction of the tile size (0.12 at the sketch's 0.8). */
  gap: 0.15,
  ribs: 8,
  /** The glint lights sit this far below the horizon (direction y over unit xz). */
  lightDrop: 1.2,
  /** First light's azimuth at t 0, radians: its mirror band is crossing the front vault. */
  lightPhase: 0.94,
} as const;

/** The dome sphere: radius, centre height and the polar angle of the springing line. */
export interface TesseraShape {
  radius: number;
  centreY: number;
  phiMax: number;
}

/** The sphere cap through the rim circle (radius `rimRadius` at y 4) whose apex rises `rise` above it. */
export function tesseraShape(rimRadius: number, rise: number): TesseraShape {
  const radius = (rimRadius * rimRadius + rise * rise) / (2 * rise);
  const centreY = TESSERA.springY + rise - radius;
  return { radius, centreY, phiMax: Math.acos((TESSERA.springY - centreY) / radius) };
}

/** One tile: position, XYZ Euler rotation (basis facing the dome centre, then the seeded tilt), width and height, a tone in [0, 1) and its kind (0 gold field, 1 dark ring or rib, 2 medallion or cornice band). */
export interface TesseraTile {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  sx: number;
  sy: number;
  tone: number;
  kind: 0 | 1 | 2;
}

export interface TesseraParams {
  rimRadius: number;
  rise: number;
  tileSize: number;
  tilt: number;
}

/** Tiles per course, apex first: the course count fits the arc from apex to springing line, each course fits its circumference. */
export function tesseraCourses(p: Omit<TesseraParams, "tilt">): number[] {
  const { radius, phiMax } = tesseraShape(p.rimRadius, p.rise);
  const courses = Math.floor((phiMax * radius) / p.tileSize);
  const out: number[] = [];
  for (let i = 0; i < courses; i++) {
    const phi = ((i + 0.5) * p.tileSize) / radius;
    out.push(Math.max(6, Math.floor((2 * Math.PI * radius * Math.sin(phi)) / p.tileSize)));
  }
  return out;
}

/** Tile count without building the layout (instance capacity). */
export function tesseraTileCount(p: Omit<TesseraParams, "tilt">): number {
  return tesseraCourses(p).reduce((a, b) => a + b, 0);
}

function tileKind(course: number, fromRim: number, ribDist: number, tile: number): 0 | 1 | 2 {
  if (course < 5) return 2;
  if (course === 6 || course === 7) return 1;
  if (ribDist < 0.75 * tile && course > 7) return 1;
  if (fromRim === 6 || fromRim === 8) return 1;
  if (fromRim === 7) return 2;
  return 0;
}

/** The whole mosaic from one seeded stream, course by course (the order is export contract): seeded course offset and irregular widths normalised to close each course, then per tile a tilt, width jitter, height jitter and tone. */
export function tesseraTiles(p: TesseraParams): TesseraTile[] {
  const { radius, centreY } = tesseraShape(p.rimRadius, p.rise);
  const S = p.tileSize;
  const gap = TESSERA.gap * S;
  const tilt = (p.tilt * Math.PI) / 180;
  const rand = createSeededRandom(TESSERA.seed);
  const counts = tesseraCourses(p);
  const basis = new Matrix4();
  const twist = new Matrix4();
  const euler = new Euler();
  const ex = new Vector3();
  const ey = new Vector3();
  const ez = new Vector3();
  const out: TesseraTile[] = [];
  counts.forEach((n, i) => {
    const phi = ((i + 0.5) * S) / radius;
    const ring = 2 * Math.PI * radius * Math.sin(phi);
    const off = rand();
    const widths = Array.from({ length: n }, () => 0.75 + rand() * 0.5);
    const sum = widths.reduce((a, b) => a + b, 0);
    const fromRim = counts.length - 1 - i;
    let acc = off;
    for (let j = 0; j < n; j++) {
      const w = (widths[j] / sum) * n;
      const th = ((acc + w * 0.5) / n) * Math.PI * 2;
      acc += w;
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);
      ez.set(-sp * Math.cos(th), -cp, -sp * Math.sin(th));
      ex.set(-Math.sin(th), 0, Math.cos(th));
      ey.crossVectors(ez, ex);
      basis.makeBasis(ex, ey, ez);
      euler.set((rand() * 2 - 1) * tilt, (rand() * 2 - 1) * tilt, (rand() * 2 - 1) * 0.1);
      basis.multiply(twist.makeRotationFromEuler(euler));
      euler.setFromRotationMatrix(basis);
      const jitter = 0.9 + rand() * 0.12;
      const sy = (S - gap) * (0.92 + rand() * 0.1);
      const sector = (th / (Math.PI * 2)) * TESSERA.ribs;
      const ribDist =
        Math.abs(sector - Math.round(sector)) * ((Math.PI * 2) / TESSERA.ribs) * radius * sp;
      out.push({
        x: sp * Math.cos(th) * radius,
        y: centreY + cp * radius,
        z: sp * Math.sin(th) * radius,
        rx: euler.x,
        ry: euler.y,
        rz: euler.z,
        sx: ((ring * w) / n - gap) * jitter,
        sy,
        tone: rand(),
        kind: tileKind(i, fromRim, ribDist, S),
      });
    }
  });
  return out;
}

/** Instance capacity for the densest slider values (widest, tallest, smallest tiles) with a little headroom. */
export const TESSERA_CAPACITY = Math.ceil(
  tesseraTileCount({ rimRadius: 45, rise: 35, tileSize: 0.6 }) * 1.02,
);

/** Drum-window lights: the glint lights sit evenly round the azimuth (Hagia Sophia's ring of windows), so a band is always crossing some part of the vault; the weights let the bands read apart. */
export const TESSERA_LIGHT_WEIGHTS = [1, 0.75, 0.55] as const;

/** Writes the glint light directions (toward each light) at look time `t`: they circle once per `period` seconds below the horizon, so their mirror bands cross the lower vault. */
export function tesseraLights(t: number, period: number, out: readonly Vector3[]): void {
  const a = (2 * Math.PI * loopSeconds(t, period)) / period + TESSERA.lightPhase;
  const n = TESSERA_LIGHT_WEIGHTS.length;
  for (let k = 0; k < n; k++) {
    const ak = a + (2 * Math.PI * k) / n;
    out[k]?.set(Math.cos(ak), -TESSERA.lightDrop, Math.sin(ak)).normalize();
  }
}

/** Springing-line fade band (start y, width): `rimFade` wide in landscape, lifted above a raised portrait headline and widened there. */
export function tesseraSpring(rimFade: number, aspect: number): [number, number] {
  const portrait = 1 - smoothstep(0.6, 1.2, aspect);
  return [TESSERA.springY + 0.3 + 0.5 * portrait * rimFade, rimFade * (1 + 0.3 * portrait)];
}
