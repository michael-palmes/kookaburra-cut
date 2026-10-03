export const PROSCENIUM_FLOOR_Y = -2;
/** Depth of one rib: its soffit runs this far back to the next, smaller rib. */
export const RIB_DEPTH = 1.2;
/** How far each rib steps out and up past the one behind it, at the reference depth. */
export const RIB_STEP = 0.35;
export const RIB_SEGMENTS = 96;
/** Superellipse exponent: 3 squares the arch into a deco shoulder. */
export const ARCH_EXPONENT = 3;
const CAMERA_Z = 5;
/** Camera distance the inner opening is authored at: the sketch's innermost rib (z -16.2) seen from z 5. */
const REFERENCE_DISTANCE = 21.2;
/** `innerWidth` is the opening's half-width this far from the camera. */
const WIDTH_DISTANCE = 21;

/** Crown scale in a 9:16 frame, easing back to 1 at square, so the crown bands sit just above a stacked headline. */
export const PORTRAIT_CROWN = 0.83;

/** The crown height a frame of `aspect` (width / height) builds with. */
export function aspectCrown(crown: number, aspect: number): number {
  const k = Math.min(1, Math.max(0, (aspect - 9 / 16) / (1 - 9 / 16)));
  return crown * (PORTRAIT_CROWN + (1 - PORTRAIT_CROWN) * k);
}

export interface ProsceniumParams {
  ribs: number;
  setBack: number;
  innerWidth: number;
  crown: number;
}

/** One rib: its stage-facing front at `z` (negative, behind the stage), the arch half-width and its height above the floor. */
export interface ProsceniumRib {
  z: number;
  halfWidth: number;
  height: number;
}

/** Rib 0 is innermost and farthest. The inner opening scales with its distance from the default camera, so its screen size (half-width `innerWidth / 21`, crown at `crown / 21.2` of the distance) holds whatever the rib count and set back. */
export function prosceniumRibs({
  ribs,
  setBack,
  innerWidth,
  crown,
}: ProsceniumParams): ProsceniumRib[] {
  const n = Math.max(1, Math.round(ribs));
  const innerZ = -(setBack + (n - 1) * RIB_DEPTH);
  const distance = CAMERA_Z - innerZ;
  const halfWidth = (innerWidth * distance) / WIDTH_DISTANCE;
  const scale = distance / REFERENCE_DISTANCE;
  const height = crown * scale - PROSCENIUM_FLOOR_Y;
  const out: ProsceniumRib[] = [];
  for (let k = 0; k < n; k++) {
    out.push({
      z: innerZ + k * RIB_DEPTH,
      halfWidth: halfWidth + k * RIB_STEP * scale,
      height: height + k * RIB_STEP * scale,
    });
  }
  return out;
}

/** A point on a rib's squared arch at `phi` (0 right leg, pi/2 crown, pi left leg), standing on the floor. */
export function archPoint(rib: ProsceniumRib, phi: number): [number, number] {
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const e = 2 / ARCH_EXPONENT;
  return [
    Math.sign(c) * Math.abs(c) ** e * rib.halfWidth,
    PROSCENIUM_FLOOR_Y + Math.abs(s) ** e * rib.height,
  ];
}

export interface ProsceniumArrays {
  position: Float32Array;
  /** Per vertex: rib index, part (0 soffit, 1 riser), across (0 to 1: soffit back to front, riser inner to outer edge). */
  rib: Float32Array;
  index: Uint16Array;
}

/** One merged mesh: per rib a soffit (inward band back to the next rib) and a stage-facing riser (out to the next, larger rib), then the same nest mirrored past the far side for reverse cameras. Winding faces every band toward the stage axis, so near legs cull. */
export function prosceniumArrays(ribs: ProsceniumRib[], segments = RIB_SEGMENTS): ProsceniumArrays {
  const strip = (segments + 1) * 2;
  const vertices = 2 * ribs.length * 2 * strip;
  const position = new Float32Array(vertices * 3);
  const rib = new Float32Array(vertices * 3);
  const index = new Uint16Array(2 * ribs.length * 2 * segments * 6);
  let v = 0;
  let ix = 0;
  const push = (x: number, y: number, z: number, k: number, part: number, across: number) => {
    position.set([x, y, z], v * 3);
    rib.set([k, part, across], v * 3);
    v++;
  };
  const quads = (base: number, mirrored: boolean) => {
    for (let i = 0; i < segments; i++) {
      const a = base + i * 2;
      if (mirrored) index.set([a, a + 3, a + 1, a, a + 2, a + 3], ix);
      else index.set([a, a + 1, a + 3, a, a + 3, a + 2], ix);
      ix += 6;
    }
  };
  const step = ribs.length > 1 ? ribs[1].halfWidth - ribs[0].halfWidth : RIB_STEP;
  for (const side of [1, -1]) {
    for (let k = 0; k < ribs.length; k++) {
      const r = ribs[k];
      const outer = ribs[k + 1] ?? {
        ...r,
        halfWidth: r.halfWidth + step,
        height: r.height + step,
      };
      const front = r.z * side;
      const back = (r.z - RIB_DEPTH) * side;
      let base = v;
      for (let i = 0; i <= segments; i++) {
        const [x, y] = archPoint(r, (i / segments) * Math.PI);
        push(x, y, back, k, 0, 0);
        push(x, y, front, k, 0, 1);
      }
      quads(base, side < 0);
      base = v;
      for (let i = 0; i <= segments; i++) {
        const phi = (i / segments) * Math.PI;
        const [x0, y0] = archPoint(r, phi);
        const [x1, y1] = archPoint(outer, phi);
        push(x0, y0, front, k, 1, 0);
        push(x1, y1, front, k, 1, 1);
      }
      quads(base, side < 0);
    }
  }
  return { position, rib, index };
}

/** Cove pulse phase (0 to 1) of rib `k` (`riser` 1 for its riser) at loop phase `phase`: the pulse reaches the innermost rib first and rises outward. Mirrors the GLSL. */
export function covePhase(phase: number, k: number, riser: number, ribs: number): number {
  const p = phase - ((k + riser) / (ribs + 1)) * 0.6;
  return p - Math.floor(p);
}
