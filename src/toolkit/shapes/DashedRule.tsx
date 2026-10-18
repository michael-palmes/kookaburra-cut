import { useTheme } from "../../theme";
import type { V3 } from "../types";
import { type DashPiece, dashPolyline } from "./dashes";
import { RoundedRect } from "./RoundedRect";

interface DashStyleProps {
  /** Line weight in world units (default 0.02). */
  thickness?: number;
  /** Dash length in world units (default 0.12); each run starts and ends on a dash, so dashes stretch slightly to fit. */
  dash?: number;
  /** Gap between dashes in world units (default 0.08). */
  gap?: number;
  /** A theme token hex (default the theme muted colour). */
  color?: string;
  opacity?: number;
  /** Draw-on, 0..1 (default 1, fully drawn). */
  progress?: number;
  /** Round dash ends. */
  round?: boolean;
  position?: V3;
  /** Radians. */
  rotation?: V3;
  renderOrder?: number;
}

export interface DashedRuleProps extends DashStyleProps {
  /** Start point in the group's plane (world units); the draw-on starts here. */
  from: [number, number];
  to: [number, number];
}

export type DashedBracketSide = "top" | "bottom" | "left" | "right";

export interface DashedBracketProps extends DashStyleProps {
  /** Length of the bracket's long run in world units, centred on the group origin. */
  span: number;
  /** End tick length in world units (default 0.18). */
  depth?: number;
  /** Where the bracket sits against what it marks: `top` (ticks point down, the default), `bottom` (up), `left` (right) or `right` (left). */
  side?: DashedBracketSide;
}

function Dashes({
  pieces,
  thickness,
  color,
  opacity,
  round,
  position,
  rotation,
  renderOrder,
}: {
  pieces: DashPiece[];
  thickness: number;
  color: string;
  opacity: number;
  round: boolean;
  position?: V3;
  rotation?: V3;
  renderOrder: number;
}) {
  return (
    <group position={position} rotation={rotation}>
      {pieces.map((piece, i) => (
        <RoundedRect
          // biome-ignore lint/suspicious/noArrayIndexKey: dash slots are fixed for a given path, so the index is the identity
          key={i}
          width={piece.length}
          height={thickness}
          radius={round ? thickness / 2 : 0}
          color={color}
          opacity={opacity}
          position={[piece.x, piece.y, 0]}
          rotation={[0, 0, piece.angle]}
          renderOrder={renderOrder}
        />
      ))}
    </group>
  );
}

/** A dashed straight rule from `from` to `to`, one flat colour-exact mesh per dash, with an optional draw-on. */
export function DashedRule(props: DashedRuleProps) {
  const theme = useTheme();
  const { from, to, thickness = 0.02, dash = 0.12, gap = 0.08, progress = 1 } = props;
  const pieces = dashPolyline([from, to], dash, gap, [0, progress]);
  return (
    <Dashes
      pieces={pieces}
      thickness={thickness}
      color={props.color ?? theme.colors.muted}
      opacity={props.opacity ?? 1}
      round={props.round ?? false}
      position={props.position}
      rotation={props.rotation}
      renderOrder={props.renderOrder ?? 0}
    />
  );
}

/** The bracket's path, end tick to end tick, centred on the origin. */
export function bracketPoints(
  span: number,
  depth: number,
  side: DashedBracketSide,
): [number, number][] {
  const h = span / 2;
  switch (side) {
    case "bottom":
      return [
        [-h, depth],
        [-h, 0],
        [h, 0],
        [h, depth],
      ];
    case "left":
      return [
        [depth, h],
        [0, h],
        [0, -h],
        [depth, -h],
      ];
    case "right":
      return [
        [-depth, h],
        [0, h],
        [0, -h],
        [-depth, -h],
      ];
    default:
      return [
        [-h, -depth],
        [-h, 0],
        [h, 0],
        [h, -depth],
      ];
  }
}

/** A dashed bracket marking a span: a long run with an end tick at each side. The draw-on grows out from the middle to both ticks. */
export function DashedBracket(props: DashedBracketProps) {
  const theme = useTheme();
  const {
    span,
    depth = 0.18,
    side = "top",
    thickness = 0.02,
    dash = 0.12,
    gap = 0.08,
    progress = 1,
  } = props;
  const p = Math.max(0, Math.min(1, progress));
  const pieces = dashPolyline(bracketPoints(span, depth, side), dash, gap, [
    0.5 - p / 2,
    0.5 + p / 2,
  ]);
  return (
    <Dashes
      pieces={pieces}
      thickness={thickness}
      color={props.color ?? theme.colors.muted}
      opacity={props.opacity ?? 1}
      round={props.round ?? false}
      position={props.position}
      rotation={props.rotation}
      renderOrder={props.renderOrder ?? 0}
    />
  );
}
