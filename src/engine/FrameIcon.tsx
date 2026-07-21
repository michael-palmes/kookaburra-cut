import { isAssetReference } from "../toolkit/frame/icon";
import { ImageCard } from "../toolkit/media/ImageCard";
import { AnimatedHeadline } from "../toolkit/text/AnimatedHeadline";
import type { V3 } from "../toolkit/types";

/** One frame icon: the panel's top icon, or a chip's inline mark. An emoji or glyph draws through the text pipeline (so emoji route to colour quads); a project asset path draws through `ImageCard` (Suspense-settled in the export preamble). `position` anchors the icon's TOP-LEFT so it stacks with sibling text; images fit a square `size` box. All motion is a timeline window, never the wall clock. See docs/overlays.md. */
export function FrameIcon({
  icon,
  position,
  size,
  from,
  to,
  color,
}: {
  icon: string;
  /** Top-left anchor, world (y-up). */
  position: V3;
  /** Icon box edge, world units. */
  size: number;
  from?: number;
  to?: number;
  /** Fill for a glyph mark (e.g. a chip tick); ignored for emoji (own colour) and images. */
  color?: "text" | "muted" | "accent" | (string & {});
}) {
  if (isAssetReference(icon)) {
    // ImageCard centres its plane on `position`; drop to the box centre so a square icon top-aligns with sibling text.
    const centre: V3 = [position[0] + size / 2, position[1] - size / 2, position[2]];
    return <ImageCard src={icon} position={centre} width={size} from={from} to={to} />;
  }
  return (
    <AnimatedHeadline
      text={icon}
      position={position}
      fontSize={size}
      anchorX="left"
      anchorY="top"
      {...(from !== undefined ? { from } : {})}
      {...(to !== undefined ? { to } : {})}
      {...(color !== undefined ? { color } : {})}
    />
  );
}
