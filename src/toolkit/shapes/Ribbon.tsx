import { useEffect, useLayoutEffect, useMemo } from "react";
import { CatmullRomCurve3, TubeGeometry, Vector3 } from "three";
import { createSeededRandom } from "../../engine/rng";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import { LightRig } from "../lighting/LightRig";
import { useSceneStaged } from "../stage/context";
import type { V3 } from "../types";

export interface RibbonProps {
  /** RNG seed for the control curve; same seed, same sweep, every run. */
  seed?: number;
  /** Control-point count along the sweep (left → right). */
  points?: number;
  /** Half-extents of the control-point scatter, in world units. */
  bounds?: V3;
  /** Tube radius, in world units. */
  radius?: number;
  /** Grow start, in ms (local scene time). */
  from?: number;
  /** Grow end, in ms (local scene time). */
  to?: number;
  /** Theme colour token. */
  tone?: "text" | "accent" | "muted";
  /** Bundle the standard light rig (see `LightRig`); turn off when the scene lights itself. */
  lit?: boolean;
  position?: V3;
  rotation?: V3;
}

const TUBULAR_SEGMENTS = 256;
const RADIAL_SEGMENTS = 8;

/** A tube swept along a seeded control curve, growing along the clock: control points are drawn from `createSeededRandom(seed)` (never `Math.random`) with x ordered left to right so the sweep reads as a stroke, and the RNG call order is part of the determinism contract; geometry is built once, growth only animates `drawRange` (no per-frame reallocation) as a pure function of `useTimeline()`, written during commit. */
export function Ribbon(props: RibbonProps) {
  const {
    seed = 1,
    points = 6,
    bounds = [5, 2.5, 1.5],
    radius = 0.05,
    from = 0,
    to = 1500,
    tone = "accent",
    lit,
    position = [0, 0, 0],
    rotation = [0, 0, 0],
  } = props;

  // Staged scenes light themselves; the bundled rig stands down by default.
  const staged = useSceneStaged();
  const isLit = lit ?? !staged;

  const { localMs } = useTimeline();
  const theme = useTheme();
  const [bx, by, bz] = bounds;

  const geometry = useMemo(() => {
    const rand = createSeededRandom(seed);
    const n = Math.max(2, points);
    const controls = Array.from({ length: n }, (_, i) => {
      const spanX = (2 * bx) / (n - 1);
      const jitterX = (rand() * 2 - 1) * spanX * 0.25;
      return new Vector3(-bx + i * spanX + jitterX, (rand() * 2 - 1) * by, (rand() * 2 - 1) * bz);
    });
    const curve = new CatmullRomCurve3(controls, false, "centripetal");
    return new TubeGeometry(curve, TUBULAR_SEGMENTS, radius, RADIAL_SEGMENTS, false);
  }, [seed, points, bx, by, bz, radius]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Growth = drawRange over the indexed tube, eased like the text reveal. Pure clock fn.
  useLayoutEffect(() => {
    const reveal = to <= from ? 1 : Math.min(1, Math.max(0, (localMs - from) / (to - from)));
    const eased = 1 - (1 - reveal) ** 3;
    const total = geometry.index?.count ?? 0;
    geometry.setDrawRange(0, Math.floor((total * eased) / 3) * 3);
  }, [localMs, geometry, from, to]);

  return (
    <group position={position} rotation={rotation}>
      {isLit && <LightRig />}
      {/* drawRange growth would fight a curve-fit bounding sphere; never cull the sweep. */}
      <mesh geometry={geometry} frustumCulled={false}>
        <meshStandardMaterial color={theme.colors[tone]} roughness={0.3} metalness={0.35} />
      </mesh>
    </group>
  );
}
