import { useLayoutEffect, useMemo } from "react";
import { MeshBasicMaterial, Shape, ShapeGeometry } from "three";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import { ramp } from "../motion/math";
import { sampleKeys } from "../motion/sampleKeys";
import type { V3 } from "../types";
import { TapRing } from "./TapRing";

/** The arrow, tip at the origin, one unit tall, counter-clockwise. */
const ARROW: [number, number][] = [
  [0, 0],
  [0, -0.8],
  [0.19, -0.62],
  [0.33, -0.93],
  [0.44, -0.88],
  [0.3, -0.58],
  [0.56, -0.58],
];
const OUTLINE = 0.07;
const PRESS_DOWN_MS = 80;
const PRESS_UP_MS = 160;
const PRESS_SCALE = 0.86;
/** The ring sits just behind the cursor. */
const RING_BEHIND = 0.002;

/** Grows a counter-clockwise polygon by `d` along its edge normals, mitres capped at `limit * d`. */
export function offsetPolygon(
  points: [number, number][],
  d: number,
  limit = 2,
): [number, number][] {
  const n = points.length;
  const normal = (a: [number, number], b: [number, number]): [number, number] => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
  };
  return points.map((p, i) => {
    const n1 = normal(points[(i - 1 + n) % n], p);
    const n2 = normal(p, points[(i + 1) % n]);
    const k = 1 + n1[0] * n2[0] + n1[1] * n2[1];
    let mx = (d * (n1[0] + n2[0])) / (k || 1);
    let my = (d * (n1[1] + n2[1])) / (k || 1);
    const len = Math.hypot(mx, my);
    if (len > limit * d) {
      mx *= (limit * d) / len;
      my *= (limit * d) / len;
    }
    return [p[0] + mx, p[1] + my];
  });
}

function shapeOf(points: [number, number][]): Shape {
  const shape = new Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) shape.lineTo(x, y);
  shape.closePath();
  return shape;
}

/** The press dip at `ms` since a press: down to 0.86 over 80 ms, back over 160 ms. */
export function pressScale(ms: number): number {
  if (!(ms >= 0) || ms >= PRESS_DOWN_MS + PRESS_UP_MS) return 1;
  if (ms < PRESS_DOWN_MS) return 1 - (1 - PRESS_SCALE) * ramp(ms, 0, PRESS_DOWN_MS, "outCubic");
  return (
    PRESS_SCALE +
    (1 - PRESS_SCALE) * ramp(ms, PRESS_DOWN_MS, PRESS_DOWN_MS + PRESS_UP_MS, "inOutSine")
  );
}

export interface CursorKey {
  /** Scene-local ms. */
  tMs: number;
  /** Where the tip is, world units; use the same length in every key. */
  position: [number, number] | V3;
  /** Ease of the move arriving at this key (default `inOutCubic`). */
  ease?: string;
}

export interface CursorProps {
  /** The path: the tip holds the first key before it and the last after it. */
  keys: CursorKey[];
  /** Scene-local ms of each click: a small press scale, and a `TapRing` unless `ring` is false. */
  presses?: number[];
  ring?: boolean;
  /** Arrow height, world units (default 0.16). */
  size?: number;
  /** Fill, a theme token hex (default the text colour). */
  colour?: string;
  /** Edge, a theme token hex (default the background colour). */
  outline?: string;
  /** Press ring colour (default the accent). */
  ringColour?: string;
  opacity?: number;
  renderOrder?: number;
}

const toV3 = (p: readonly number[]): V3 => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];

/** A pointer that travels a keyed path (`sampleKeys`) and presses with a small scale at each `presses` time, firing a tap ring there. */
export function Cursor({
  keys,
  presses = [],
  ring = true,
  size = 0.16,
  colour,
  outline,
  ringColour,
  opacity = 1,
  renderOrder = 0,
}: CursorProps) {
  const { localMs } = useTimeline();
  const theme = useTheme();
  const geometry = useMemo(
    () => ({
      fill: new ShapeGeometry(shapeOf(ARROW)),
      edge: new ShapeGeometry(shapeOf(offsetPolygon(ARROW, OUTLINE))),
    }),
    [],
  );
  const materials = useMemo(() => {
    const make = () => {
      const m = new MeshBasicMaterial({ transparent: true, depthWrite: false });
      m.toneMapped = false;
      return m;
    };
    return { fill: make(), edge: make() };
  }, []);
  useLayoutEffect(
    () => () => {
      geometry.fill.dispose();
      geometry.edge.dispose();
      materials.fill.dispose();
      materials.edge.dispose();
    },
    [geometry, materials],
  );
  materials.fill.color.set(colour ?? theme.colors.text);
  materials.edge.color.set(outline ?? theme.colors.background);
  materials.fill.opacity = opacity;
  materials.edge.opacity = opacity;
  const path = keys.map((key) => ({ ...key, ease: key.ease ?? "inOutCubic" }));
  const at = (ms: number): V3 =>
    path.length > 0 ? toV3(sampleKeys(path, ms).position as number[]) : [0, 0, 0];
  const tip = at(localMs);
  const press = presses.reduce((s, p) => Math.min(s, pressScale(localMs - p)), 1);
  return (
    <>
      {ring &&
        presses.map((p, i) => {
          const [x, y, z] = at(p);
          return (
            <TapRing
              // biome-ignore lint/suspicious/noArrayIndexKey: presses are positional, with no ids
              key={i}
              at={p}
              position={[x, y, z - RING_BEHIND]}
              radius={size * 0.75}
              colour={ringColour}
              renderOrder={renderOrder}
            />
          );
        })}
      <group position={tip} scale={size * press} visible={keys.length > 0 && opacity > 0}>
        <mesh geometry={geometry.edge} material={materials.edge} renderOrder={renderOrder} />
        <mesh
          geometry={geometry.fill}
          material={materials.fill}
          position={[0, 0, 0.001]}
          renderOrder={renderOrder}
        />
      </group>
    </>
  );
}
