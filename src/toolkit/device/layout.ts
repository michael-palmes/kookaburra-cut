import type {
  DeviceLayoutPreset,
  SceneDocDeviceLayout,
  SceneDocDeviceLayoutDelta,
} from "../../engine/sceneDocSchema";
import type { FormatInfo } from "../types";
import { resolveAvailableDeviceSpec } from "./catalog";
import type { DevicePlacement } from "./Device";

/** Resolves a scene's deviceLayout block to per-device placements: a pure function of (devices, block, format) so preview and export cannot drift. Widths come from the model this build can render, including the Android fallback. Preset bases compute at natural size against the aspect's safe width, the whole arrangement compresses uniformly when it overflows (positions and scales together, the portrait behaviour), then per-device deltas apply: offset and rotation add, scale multiplies. Deltas deliberately never re-slot neighbours. */

const DEFAULT_GAP = 0.35;
const GAP_MIN = -0.5;
const GAP_MAX = 2;
/** Breathing-room multiplier every laid-out device starts from (the DevicesFallback landscape convention). */
const BASE_SCALE = 0.92;
/** Resting y for laid-out devices (the device-kind scaffold convention; `ground` overrides y inside Device). */
const BASE_Y = -0.3;
const TOE_DEG = 10;
const ARC_DEG = 14;
const ARC_DEPTH = 0.6;
const CASCADE_OVERLAP = 0.62;
const CASCADE_STEP_Z = 0.45;
const CASCADE_DEG = 16;
const HERO_FRONT_Z = 0.3;
const HERO_BACK_Z = 0.55;
const HERO_WING_SCALE = 0.8;
const HERO_TOE_DEG = 12;
const DEPTH_PAIR_TOE_DEG = 8;
const DEPTH_PAIR_FRONT_Z = 0.25;
const DEPTH_PAIR_BACK_Z = 0.5;
interface LayoutDeviceLike {
  id: string;
  model: string;
  placement?: DevicePlacement;
}

interface BasePlacement {
  x: number;
  z: number;
  yawDeg: number;
  scale: number;
}

const widthOf = (model: string): number => resolveAvailableDeviceSpec(model).layoutWidth;

/** Yaw turning a device's screen toward the frame's centre line, scaled by how far out it sits. */
const toeToward = (x: number, halfSpan: number, deg: number): number =>
  halfSpan > 1e-6 ? -Math.sign(x) * deg * (Math.abs(x) / halfSpan) : 0;

/** Centred row x positions from cumulative widths + gap; every multi-device preset starts here. */
function rowPositions(widths: number[], gap: number): number[] {
  const total = widths.reduce((a, w) => a + w, 0) + gap * (widths.length - 1);
  const xs: number[] = [];
  let edge = -total / 2;
  for (const w of widths) {
    xs.push(edge + w / 2);
    edge += w + gap;
  }
  return xs;
}

function presetBases(preset: DeviceLayoutPreset, widths: number[], gap: number): BasePlacement[] {
  const n = widths.length;
  switch (preset) {
    case "row": {
      return rowPositions(widths, gap).map((x) => ({ x, z: 0, yawDeg: 0, scale: 1 }));
    }
    case "toe-in": {
      const xs = rowPositions(widths, gap);
      const halfSpan = Math.max(...xs.map(Math.abs), 1e-6);
      return xs.map((x) => ({ x, z: 0, yawDeg: toeToward(x, halfSpan, TOE_DEG), scale: 1 }));
    }
    case "arc": {
      // A parabolic recede reads as a shallow arc without radius edge cases.
      const xs = rowPositions(widths, gap);
      const halfSpan = Math.max(...xs.map(Math.abs), 1e-6);
      return xs.map((x) => ({
        x,
        z: -ARC_DEPTH * (x / halfSpan) ** 2,
        yawDeg: toeToward(x, halfSpan, ARC_DEG),
        scale: 1,
      }));
    }
    case "cascade": {
      // Fanned cards: each device steps across by an overlap fraction and back by a constant, all yawed the same way.
      const xs: number[] = [0];
      for (let i = 1; i < n; i++) {
        xs.push(xs[i - 1] + ((widths[i - 1] + widths[i]) / 2) * CASCADE_OVERLAP + gap * 0.25);
      }
      const mid = (xs[0] + xs[n - 1]) / 2;
      return xs.map((x, i) => ({
        x: x - mid,
        z: -CASCADE_STEP_Z * i,
        yawDeg: -CASCADE_DEG,
        scale: 1,
      }));
    }
    case "hero": {
      // Device 1 forward and centred; the rest flank behind at reduced scale, alternating right then left.
      const bases: BasePlacement[] = [{ x: 0, z: HERO_FRONT_Z, yawDeg: 0, scale: 1 }];
      let right = widths[0] / 2;
      let left = -widths[0] / 2;
      for (let i = 1; i < n; i++) {
        const w = widths[i] * HERO_WING_SCALE;
        const side = i % 2 === 1 ? 1 : -1;
        const x = side === 1 ? right + gap + w / 2 : left - gap - w / 2;
        if (side === 1) right = x + w / 2;
        else left = x - w / 2;
        bases.push({
          x,
          z: -HERO_BACK_Z,
          yawDeg: -Math.sign(x) * HERO_TOE_DEG,
          scale: HERO_WING_SCALE,
        });
      }
      return bases;
    }
    case "depth-pair": {
      // Devices step from forward-left to back-right, with the original pair as the endpoints.
      const xs = rowPositions(widths, gap).map((x) => x * 0.8);
      if (n === 1) return [{ x: xs[0], z: 0, yawDeg: 0, scale: 1 }];
      return xs.map((x, i) => {
        const progress = i / (n - 1);
        return {
          x,
          z: DEPTH_PAIR_FRONT_Z - (DEPTH_PAIR_FRONT_Z + DEPTH_PAIR_BACK_Z) * progress,
          yawDeg: DEPTH_PAIR_TOE_DEG * (1 - 2 * progress),
          scale: 1,
        };
      });
    }
  }
}

export function resolveDeviceLayout(
  devices: ReadonlyArray<LayoutDeviceLike>,
  layout: SceneDocDeviceLayout,
  format: FormatInfo,
): DevicePlacement[] {
  if (devices.length === 0) return [];
  const gap = Math.min(GAP_MAX, Math.max(GAP_MIN, layout.gap ?? DEFAULT_GAP));
  const widths = devices.map((d) => widthOf(d.model) * BASE_SCALE);
  const bases = presetBases(layout.preset, widths, gap);
  // Uniform fit against the safe width: positions and scales compress together so the arrangement keeps its proportions in narrow aspects.
  const avail = Math.max(format.frame.width - format.safe.left - format.safe.right, 0.5);
  const span =
    2 * Math.max(...bases.map((b, i) => Math.abs(b.x) + (widths[i] * b.scale) / 2), 1e-6);
  const f = Math.min(1, avail / span);
  return devices.map((d, i) => {
    const base = bases[i];
    const delta: SceneDocDeviceLayoutDelta = layout.devices?.[d.id] ?? {};
    const [dx, dy, dz] = delta.offset ?? [0, 0, 0];
    const [rx, ry, rz] = delta.rotationDeg ?? [0, 0, 0];
    const position: [number, number, number] = [base.x * f + dx, BASE_Y + dy, base.z * f + dz];
    const rotationDeg: [number, number, number] = [rx, base.yawDeg + ry, rz];
    const scale = base.scale * BASE_SCALE * f * (delta.scale ?? 1);
    return {
      position,
      rotationDeg,
      scale,
      ground: d.placement?.ground,
      // The stamp survives consumer spreads, so frozen template post-processing can't drift the layout.
      resolvedLayout: { position, rotationDeg, scale },
    };
  });
}
