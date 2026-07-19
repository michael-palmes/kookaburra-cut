import { useFormat } from "../../engine/format";
import { AnimatedGroup } from "../group/AnimatedGroup";
import { ImageCard } from "../media/ImageCard";
import type { V3 } from "../types";
import { AnimatedHeadline } from "./AnimatedHeadline";
import { lockupLayout } from "./brandLockupLayout";

/** Title label size, world units. */
const TITLE_SIZE = 0.36;
/** Hero subtitle size, world units. */
const SUBTITLE_SIZE = 0.82;

export interface BrandLockupProps {
  /** Small muted label above the hero line (usually the app name). */
  title: string;
  /** The hero line (usually the version number). */
  subtitle: string;
  /** Project-relative icon path; every project ships `assets/app-icon.png`. */
  icon?: string;
  /** Group reveal window (scene-local ms). */
  from?: number;
  to?: number;
  /** Offset added after the built-in centring (world units). */
  position?: V3;
  /** Icon width in world units; height follows the image's aspect. */
  iconWidth?: number;
  /** Title fill token or raw hex (default "muted"); beats the sidecar's `textStyle.titleColor`. */
  titleColor?: "text" | "muted" | "accent" | (string & {});
  /** Subtitle fill token or raw hex; beats the sidecar's `textStyle.subtitleColor`. */
  subtitleColor?: "text" | "muted" | "accent" | (string & {});
}

/** Horizontal brand lockup: app icon left, small muted title over a large hero subtitle to its right, revealed as ONE unit (fade-scale + a single shine sweep). Text lives in the sidecar under `title`/`subtitle`; centring and overflow shrink come from character-count estimates so layout never waits on font measurement. */
export function BrandLockup(props: BrandLockupProps) {
  const {
    title,
    subtitle,
    icon = "assets/app-icon.png",
    from = 200,
    to = 1100,
    position = [0, 0, 0],
    iconWidth = 1.4,
  } = props;
  const format = useFormat();

  // A horizontal lockup is widest in 16:9; shrink it to fit square and portrait frames.
  const scale = format.aspect >= 1.4 ? 1 : format.aspect >= 0.9 ? 0.7 : 0.48;
  const usableWidth = (format.frame.width - format.safe.left - format.safe.right) / scale;
  const layout = lockupLayout({
    title,
    subtitle,
    iconWidth,
    titleSize: TITLE_SIZE,
    subtitleSize: SUBTITLE_SIZE,
    usableWidth,
  });

  return (
    <group scale={scale * layout.fit} position={position}>
      <AnimatedGroup
        from={from}
        to={to}
        preset="fade-scale"
        startScale={0.9}
        shine
        extent={[layout.width, 2]}
        position={[layout.centreOffset, 0, 0]}
      >
        <ImageCard src={icon} position={[layout.iconX, 0, 0]} width={iconWidth} />
        <AnimatedHeadline
          text={title}
          textKey="title"
          preset="none"
          from={0}
          to={1}
          position={[0, 0.46, 0]}
          fontSize={TITLE_SIZE}
          anchorX="left"
          textAlign="left"
          color={props.titleColor}
          defaultColor="muted"
        />
        <AnimatedHeadline
          text={subtitle}
          textKey="subtitle"
          preset="none"
          from={0}
          to={1}
          position={[0, -0.28, 0]}
          fontSize={SUBTITLE_SIZE}
          anchorX="left"
          textAlign="left"
          color={props.subtitleColor}
        />
      </AnimatedGroup>
    </group>
  );
}
