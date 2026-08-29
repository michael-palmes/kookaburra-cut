import { ACCENT_LAYER_Z_EM } from "./HighlightQuads";

/** Underline rule metrics, em. */
export const UNDERLINE_THICKNESS_EM = 0.06;
export const UNDERLINE_GAP_EM = 0.12;

/** The rule quad for a draw fraction over the measured block bounds: left-anchored, sat under the block's bottom edge. Null when nothing draws. */
export function underlineQuad(
  bounds: readonly [number, number, number, number],
  draw: number,
  fontSize: number,
): { x: number; y: number; w: number; h: number } | null {
  if (draw <= 0) return null;
  const [minX, minY, maxX] = bounds;
  const w = (maxX - minX) * Math.min(1, draw);
  if (w <= 0) return null;
  return {
    x: minX + w / 2,
    y: minY - (UNDERLINE_GAP_EM + UNDERLINE_THICKNESS_EM / 2) * fontSize,
    w,
    h: UNDERLINE_THICKNESS_EM * fontSize,
  };
}

/** underline-draw's companion rule: one accent quad driven by `underlineProgress`, riding the same parent transforms as the text (the EmojiQuads mount pattern). */
export function UnderlineRule(props: {
  bounds: readonly [number, number, number, number];
  draw: number;
  fontSize: number;
  color: string;
  opacity?: number;
}) {
  const quad = underlineQuad(props.bounds, props.draw, props.fontSize);
  const opacity = props.opacity ?? 1;
  if (!quad || opacity <= 0) return null;
  return (
    <mesh
      position={[quad.x, quad.y, ACCENT_LAYER_Z_EM * props.fontSize]}
      scale={[quad.w, quad.h, 1]}
    >
      <planeGeometry />
      <meshBasicMaterial color={props.color} transparent opacity={opacity} depthWrite={false} />
    </mesh>
  );
}
