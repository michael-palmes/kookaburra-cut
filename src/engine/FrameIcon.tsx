import { isAssetReference, isUnloadableAssetPath } from "../toolkit/frame/icon";
import { ImageCard } from "../toolkit/media/ImageCard";
import { AnimatedHeadline } from "../toolkit/text/AnimatedHeadline";
import type { V3 } from "../toolkit/types";

/** Asset images draw at this multiple of the nominal glyph size, grown around the nominal box's centre so header stacking budgets still hold: an emoji's ink under-fills its em box while an image fills its box, and a header image should read a touch larger than an emoji mark (tuned by eye). */
const ASSET_ICON_SCALE = 1.3;

/** One frame icon: the panel's top icon, or a chip's inline mark. An emoji or glyph draws through the text pipeline (so emoji route to colour quads); a project asset path draws through `ImageCard` (Suspense-settled in the export preamble). `position` anchors the icon's TOP-LEFT so it stacks with sibling text; images fit a square `size` box. All motion is a timeline window, never the wall clock. See docs/overlays.md. */
export function FrameIcon({
  icon,
  position,
  size,
  from,
  to,
  color,
  anchorX = "left",
}: {
  icon: string;
  /** The anchor point, world (y-up); `anchorX` picks which horizontal edge it pins, `anchorY` is always top. */
  position: V3;
  /** Icon box edge, world units. */
  size: number;
  from?: number;
  to?: number;
  /** Fill for a glyph mark (e.g. a chip tick); ignored for emoji (own colour) and images. */
  color?: "text" | "muted" | "accent" | (string & {});
  /** Which horizontal edge `position[0]` pins; default "left". */
  anchorX?: "left" | "center" | "right";
}) {
  if (isAssetReference(icon)) {
    // ImageCard centres its plane on `position`; offset by the anchor so the square box pins the chosen edge.
    const f = anchorX === "left" ? 1 : anchorX === "center" ? 0 : -1;
    const centre: V3 = [position[0] + (size / 2) * f, position[1] - size / 2, position[2]];
    return (
      <ImageCard src={icon} position={centre} width={size * ASSET_ICON_SCALE} from={from} to={to} />
    );
  }
  if (isUnloadableAssetPath(icon)) return null;
  return (
    <AnimatedHeadline
      text={icon}
      position={position}
      fontSize={size}
      anchorX={anchorX}
      anchorY="top"
      {...(from !== undefined ? { from } : {})}
      {...(to !== undefined ? { to } : {})}
      {...(color !== undefined ? { color } : {})}
    />
  );
}
